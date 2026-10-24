//! Shm surfaces drawn from `AHardwareBuffer`s.
//!
//! `glTexSubImage2D` makes Adreno's driver re-tile the uploaded area on the CPU, which costs a
//! large share of a core when the guest redraws the whole screen. Copying the damaged rows into
//! linear gralloc memory that the GPU samples directly is a plain `memcpy`.

use libloading::Library;
use smithay::backend::egl::ffi::egl as ffi_egl;
use smithay::backend::renderer::element::texture::TextureRenderElement;
use smithay::backend::renderer::element::{Id, Kind};
use smithay::backend::renderer::gles::{ffi, GlesRenderer, GlesTexture};
use smithay::backend::renderer::utils::{CommitCounter, RendererSurfaceStateUserData};
use smithay::backend::renderer::{Renderer, Texture};
use smithay::reexports::rustix::event::{poll, PollFd, PollFlags};
use smithay::reexports::wayland_server::protocol::{wl_shm, wl_surface::WlSurface};
use smithay::utils::{Buffer as BufferCoord, Rectangle, Size, Transform};
use smithay::wayland::compositor::{get_children, with_states};
use smithay::wayland::shm::with_buffer_contents;
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr};
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::OnceLock;

#[repr(C)]
#[derive(Default)]
struct Desc {
    width: u32,
    height: u32,
    layers: u32,
    format: u32,
    usage: u64,
    stride: u32,
    rfu0: u32,
    rfu1: u64,
}

const FORMAT_R8G8B8A8_UNORM: u32 = 1;
const USAGE_CPU_WRITE_OFTEN: u64 = 0x30;
const USAGE_GPU_SAMPLED_IMAGE: u64 = 0x100;
const EGL_NATIVE_BUFFER_ANDROID: u32 = 0x3140;
const EGL_SYNC_FLUSH_COMMANDS_BIT_KHR: i32 = 0x0001;
const EGL_NONE: i32 = 0x3038;
const EGL_TRUE: i32 = 1;
/// How long to wait for the GPU to finish reading a buffer before overwriting it anyway.
const GPU_READ_TIMEOUT_NS: u64 = 100_000_000;

type Allocate = unsafe extern "C" fn(*const Desc, *mut *mut c_void) -> i32;
type Release = unsafe extern "C" fn(*mut c_void);
type Describe = unsafe extern "C" fn(*const c_void, *mut Desc);
type Lock = unsafe extern "C" fn(*mut c_void, u64, i32, *const c_void, *mut *mut c_void) -> i32;
type Unlock = unsafe extern "C" fn(*mut c_void, *mut i32) -> i32;
type ClientBuffer = unsafe extern "C" fn(*const c_void) -> ffi_egl::types::EGLClientBuffer;

struct Api {
    _lib: Library,
    allocate: Allocate,
    release: Release,
    describe: Describe,
    lock: Lock,
    unlock: Unlock,
    client_buffer: ClientBuffer,
}

/// `AHardwareBuffer` is API 26+, and binding one to a texture needs
/// `EGL_ANDROID_get_native_client_buffer`; without them surfaces keep the `glTexSubImage2D` path.
fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        let lib = Library::new("libandroid.so").ok()?;
        let allocate = *lib.get::<Allocate>(b"AHardwareBuffer_allocate\0").ok()?;
        let release = *lib.get::<Release>(b"AHardwareBuffer_release\0").ok()?;
        let describe = *lib.get::<Describe>(b"AHardwareBuffer_describe\0").ok()?;
        let lock = *lib.get::<Lock>(b"AHardwareBuffer_lock\0").ok()?;
        let unlock = *lib.get::<Unlock>(b"AHardwareBuffer_unlock\0").ok()?;
        let client_buffer = ffi_egl::GetProcAddress(c"eglGetNativeClientBufferANDROID".as_ptr());
        if client_buffer.is_null() {
            return None;
        }
        Some(Api {
            _lib: lib,
            allocate,
            release,
            describe,
            lock,
            unlock,
            client_buffer: std::mem::transmute::<_, ClientBuffer>(client_buffer),
        })
    })
    .as_ref()
}

/// One `AHardwareBuffer` bound to a texture, holding the surface contents as of `commit`.
struct Slot {
    buffer: *mut c_void,
    /// Row pitch in bytes.
    stride: usize,
    display: ffi_egl::types::EGLDisplay,
    image: ffi_egl::types::EGLImageKHR,
    texture: GlesTexture,
    opaque: bool,
    renderer_id: usize,
    commit: Option<CommitCounter>,
    /// Signals when the GPU is done with the last frame that sampled this slot.
    read_fence: ffi_egl::types::EGLSyncKHR,
}

impl Slot {
    fn new(
        api: &Api,
        renderer: &mut GlesRenderer,
        display: ffi_egl::types::EGLDisplay,
        size: Size<i32, BufferCoord>,
        opaque: bool,
    ) -> Option<Self> {
        // Swapping red and blue below needs texture swizzle, which is GLES 3.
        let gles3 = renderer
            .with_context(|gl| unsafe {
                let version = gl.GetString(ffi::VERSION);
                !version.is_null()
                    && CStr::from_ptr(version as *const c_char)
                        .to_bytes()
                        .strip_prefix(b"OpenGL ES ")
                        .is_some_and(|rest| rest.first().is_some_and(|major| *major >= b'3'))
            })
            .unwrap_or(false);
        if !gles3 {
            return None;
        }

        let desc = Desc {
            width: size.w as u32,
            height: size.h as u32,
            layers: 1,
            format: FORMAT_R8G8B8A8_UNORM,
            usage: USAGE_CPU_WRITE_OFTEN | USAGE_GPU_SAMPLED_IMAGE,
            ..Default::default()
        };
        let mut buffer = std::ptr::null_mut();
        if unsafe { (api.allocate)(&desc, &mut buffer) } != 0 || buffer.is_null() {
            return None;
        }
        let mut actual = Desc::default();
        unsafe { (api.describe)(buffer, &mut actual) };

        let attribs = [ffi_egl::IMAGE_PRESERVED_KHR as i32, EGL_TRUE, EGL_NONE];
        let image = unsafe {
            ffi_egl::CreateImageKHR(
                display,
                ffi_egl::NO_CONTEXT,
                EGL_NATIVE_BUFFER_ANDROID,
                (api.client_buffer)(buffer),
                attribs.as_ptr(),
            )
        };
        if image == ffi_egl::NO_IMAGE_KHR {
            unsafe { (api.release)(buffer) };
            return None;
        }

        let texture = renderer.with_context(|gl| unsafe {
            let mut tex = 0;
            gl.GenTextures(1, &mut tex);
            gl.BindTexture(ffi::TEXTURE_2D, tex);
            gl.EGLImageTargetTexture2DOES(ffi::TEXTURE_2D, image);
            // wl_shm's ARGB8888 is B, G, R, A in memory; the buffer is RGBA.
            gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_SWIZZLE_R, ffi::BLUE as i32);
            gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_SWIZZLE_B, ffi::RED as i32);
            gl.BindTexture(ffi::TEXTURE_2D, 0);
            tex
        });
        let Ok(tex) = texture else {
            unsafe {
                ffi_egl::DestroyImageKHR(display, image);
                (api.release)(buffer);
            }
            return None;
        };

        Some(Slot {
            buffer,
            stride: actual.stride as usize * 4,
            display,
            image,
            texture: unsafe {
                GlesTexture::from_raw(renderer, Some(ffi::RGBA8), opaque, tex, size)
            },
            opaque,
            renderer_id: renderer.id(),
            commit: None,
            read_fence: std::ptr::null(),
        })
    }

    fn wait_for_gpu(&mut self) {
        if self.read_fence.is_null() {
            return;
        }
        unsafe {
            ffi_egl::ClientWaitSyncKHR(
                self.display,
                self.read_fence,
                EGL_SYNC_FLUSH_COMMANDS_BIT_KHR,
                GPU_READ_TIMEOUT_NS,
            );
            ffi_egl::DestroySyncKHR(self.display, self.read_fence);
        }
        self.read_fence = std::ptr::null();
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        // The texture is deleted by its renderer; the image and buffer only need the display.
        unsafe {
            if !self.read_fence.is_null() {
                ffi_egl::DestroySyncKHR(self.display, self.read_fence);
            }
            ffi_egl::DestroyImageKHR(self.display, self.image);
            if let Some(api) = api() {
                (api.release)(self.buffer);
            }
        }
    }
}

/// Two slots per surface, so the CPU fills one while the GPU may still read the other.
#[derive(Default)]
struct Stream {
    slots: Vec<Slot>,
    /// The slot drawn last, which the GPU may still be reading.
    current: Option<usize>,
}

/// Draw `surface` from an `AHardwareBuffer` if it shows a plain shm buffer, copying only what
/// changed since the slot's last update. Returns `None` to fall back to Smithay's import.
pub fn render_element(
    renderer: &mut GlesRenderer,
    display: ffi_egl::types::EGLDisplay,
    surface: &WlSurface,
) -> Option<TextureRenderElement<GlesTexture>> {
    let api = api()?;
    // Only the surface itself is copied here; trees with subsurfaces keep Smithay's path.
    if !get_children(surface).is_empty() {
        return None;
    }
    with_states(surface, |states| {
        let state = states
            .data_map
            .get::<RendererSurfaceStateUserData>()?
            .lock()
            .ok()?;
        if state.buffer_scale() != 1 || state.buffer_transform() != Transform::Normal {
            return None;
        }
        let buffer = state.buffer()?;
        let commit = state.current_commit();
        states
            .data_map
            .insert_if_missing(|| RefCell::new(Stream::default()));
        let mut stream = states.data_map.get::<RefCell<Stream>>()?.borrow_mut();

        let texture = with_buffer_contents(buffer, |ptr, len, data| {
            let opaque = match data.format {
                wl_shm::Format::Argb8888 => false,
                wl_shm::Format::Xrgb8888 => true,
                _ => return None,
            };
            let size: Size<i32, BufferCoord> = (data.width, data.height).into();
            let end = data.offset as usize + data.stride as usize * data.height as usize;
            if data.width <= 0 || data.height <= 0 || end > len {
                return None;
            }

            // Already showing this commit (e.g. redrawn for a resize): nothing to copy.
            if let Some(index) = stream.current {
                let slot = &stream.slots[index];
                if slot.commit == Some(commit)
                    && slot.renderer_id == renderer.id()
                    && slot.texture.size() == size
                {
                    return Some(slot.texture.clone());
                }
            }

            let index = stream.current.map_or(0, |current| 1 - current);
            let stale = stream.slots.get(index).is_none_or(|slot| {
                slot.renderer_id != renderer.id()
                    || slot.texture.size() != size
                    || slot.opaque != opaque
            });
            if stale {
                let slot = Slot::new(api, renderer, display, size, opaque)?;
                if index < stream.slots.len() {
                    stream.slots[index] = slot;
                } else {
                    stream.slots.push(slot);
                }
            }

            let slot = &mut stream.slots[index];
            slot.wait_for_gpu();
            // Everything that changed since this slot was last filled (all of it for a new slot).
            let damage = state.damage_since(slot.commit);

            let mut dst = std::ptr::null_mut();
            if unsafe {
                (api.lock)(
                    slot.buffer,
                    USAGE_CPU_WRITE_OFTEN,
                    -1,
                    std::ptr::null(),
                    &mut dst,
                )
            } != 0
            {
                return None;
            }
            let src = unsafe { ptr.add(data.offset as usize) };
            for region in merge_overlapping(&damage, Rectangle::from_size(size)) {
                let row = region.size.w as usize * 4;
                for y in region.loc.y as usize..(region.loc.y + region.size.h) as usize {
                    let x = region.loc.x as usize * 4;
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            src.add(y * data.stride as usize + x),
                            (dst as *mut u8).add(y * slot.stride + x),
                            row,
                        );
                    }
                }
            }
            let mut fence = -1;
            unsafe { (api.unlock)(slot.buffer, &mut fence) };
            if fence >= 0 {
                // The copy becomes visible once this fence signals.
                let fence = unsafe { OwnedFd::from_raw_fd(fence) };
                let _ = poll(&mut [PollFd::new(&fence, PollFlags::IN)], 1000);
            }

            slot.commit = Some(commit);
            let texture = slot.texture.clone();
            stream.current = Some(index);
            Some(texture)
        })
        .ok()??;

        Some(TextureRenderElement::from_static_texture(
            Id::from_wayland_resource(surface),
            renderer.id(),
            (0.0, 0.0),
            texture,
            1,
            Transform::Normal,
            None,
            None,
            None,
            None,
            Kind::Unspecified,
        ))
    })
}

/// Damage accumulated over several commits repeats and overlaps (a client redrawing every frame
/// damages the whole buffer each time); merge it so no pixel is copied twice.
fn merge_overlapping(
    damage: &[Rectangle<i32, BufferCoord>],
    bounds: Rectangle<i32, BufferCoord>,
) -> Vec<Rectangle<i32, BufferCoord>> {
    let mut rects = damage
        .iter()
        .filter_map(|rect| rect.intersection(bounds))
        .collect::<Vec<_>>();
    let mut i = 0;
    while i < rects.len() {
        let mut grew = false;
        let mut j = i + 1;
        while j < rects.len() {
            if rects[i].overlaps(rects[j]) {
                rects[i] = rects[i].merge(rects[j]);
                rects.swap_remove(j);
                grew = true;
            } else {
                j += 1;
            }
        }
        // A grown rectangle may now overlap ones it was already checked against.
        if !grew {
            i += 1;
        }
    }
    rects
}

/// Fence the slot each surface just drew from, after the frame's draw calls were issued.
pub fn frame_submitted(display: ffi_egl::types::EGLDisplay, surfaces: &[WlSurface]) {
    for surface in surfaces {
        with_states(surface, |states| {
            let Some(stream) = states.data_map.get::<RefCell<Stream>>() else {
                return;
            };
            let mut stream = stream.borrow_mut();
            let Some(index) = stream.current else {
                return;
            };
            let slot = &mut stream.slots[index];
            if !slot.read_fence.is_null() {
                unsafe { ffi_egl::DestroySyncKHR(display, slot.read_fence) };
            }
            let attribs = [EGL_NONE];
            slot.read_fence = unsafe {
                ffi_egl::CreateSyncKHR(display, ffi_egl::SYNC_FENCE_KHR, attribs.as_ptr())
            };
        });
    }
}
