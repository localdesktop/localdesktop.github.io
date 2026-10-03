//! EGL/GLES rendering to the Android window created through `winit`.
//!
//! Adapted from smithay's `winit` backend: the EGL display, context and window surface are created
//! by hand on the `ANativeWindow` that `winit` exposes, and the result is wrapped in
//! [`WinitGraphicsBackend`], which gives access to the [`GlesRenderer`] and to buffer age /
//! damage-aware swapping.

use khronos_egl::DynamicInstance;
use smithay::{
    backend::{
        egl::{
            context::{GlAttributes, PixelFormatRequirements},
            display::EGLDisplay,
            native::EGLNativeSurface,
            EGLContext, EGLSurface,
        },
        renderer::{
            gles::GlesRenderer,
            Bind,
        },
        SwapBuffersError,
    },
    utils::{Physical, Rectangle, Size},
};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use winit::event_loop::ActiveEventLoop;
use winit::raw_window_handle::{AndroidNdkWindowHandle, HasWindowHandle, RawWindowHandle};
use winit::window::{Window as WinitWindow, WindowAttributes};

#[derive(Clone, Copy, Debug)]
struct ContextCandidate {
    label: &'static str,
    attributes: GlAttributes,
    pixel_format: PixelFormatRequirements,
}

fn create_egl_context(display: &EGLDisplay) -> Result<EGLContext, String> {
    // 8-bit RGBA, no depth or stencil: the compositor only blends textured quads, and a 10-bit or
    // depth/stencil window surface costs memory bandwidth for nothing. `vsync` selects configs
    // that support a swap interval of 1.
    let attributes = |version| GlAttributes {
        version,
        profile: None,
        debug: cfg!(debug_assertions),
        vsync: true,
    };
    let rgba8 = |hardware_accelerated| PixelFormatRequirements {
        hardware_accelerated,
        color_bits: Some(24),
        float_color_buffer: false,
        alpha_bits: Some(8),
        depth_bits: None,
        stencil_bits: None,
        multisampling: None,
    };
    let candidates = [
        ContextCandidate {
            label: "OpenGL ES 3.0 with 8-bit hardware-accelerated surface",
            attributes: attributes((3, 0)),
            pixel_format: rgba8(Some(true)),
        },
        ContextCandidate {
            label: "OpenGL ES 3.0 with 8-bit emulator-friendly surface",
            attributes: attributes((3, 0)),
            pixel_format: rgba8(None),
        },
        ContextCandidate {
            label: "OpenGL ES 2.0 with 8-bit emulator-friendly surface",
            attributes: attributes((2, 0)),
            pixel_format: rgba8(None),
        },
    ];
    let mut errors = Vec::with_capacity(candidates.len());

    for candidate in candidates {
        match EGLContext::new_with_config(display, candidate.attributes, candidate.pixel_format) {
            Ok(context) => {
                if !errors.is_empty() {
                    log::warn!(
                        "Using EGL fallback after {} failed attempt(s): {}",
                        errors.len(),
                        candidate.label
                    );
                }
                return Ok(context);
            }
            Err(error) => {
                log::warn!("Failed EGL candidate '{}': {}", candidate.label, error);
                errors.push(format!("{}: {}", candidate.label, error));
            }
        }
    }

    Err(format!(
        "Failed to create EGLContext. Tried: {}",
        errors.join(" | ")
    ))
}

pub struct AndroidNativeSurface {
    handle: AndroidNdkWindowHandle,
}

unsafe impl Send for AndroidNativeSurface {}

unsafe impl EGLNativeSurface for AndroidNativeSurface {
    unsafe fn create(
        &self,
        display: &Arc<smithay::backend::egl::display::EGLDisplayHandle>,
        config_id: smithay::backend::egl::ffi::egl::types::EGLConfig,
    ) -> Result<*const std::os::raw::c_void, smithay::backend::egl::EGLError> {
        let surface = smithay::backend::egl::ffi::egl::CreateWindowSurface(
            display.handle,
            config_id,
            self.handle.a_native_window.as_ptr(),
            std::ptr::null(),
        );
        if surface.is_null() {
            return Err(smithay::backend::egl::EGLError::BadSurface);
        }
        Ok(surface)
    }

    /// Android window surfaces have no resize call: the EGL implementation reads the size of the
    /// `ANativeWindow` (which the window manager changes on fold/unfold, rotation and DeX window
    /// resizes) when it dequeues the next buffer, and `eglQuerySurface` reports it after the next
    /// swap. Nothing to do here, and nothing to recreate.
    fn resize(&self, _width: i32, _height: i32, _dx: i32, _dy: i32) -> bool {
        true
    }
}

fn create_egl_display(
    _handle: AndroidNdkWindowHandle,
) -> Result<EGLDisplay, Box<dyn std::error::Error>> {
    // Load the EGL library
    let lib = unsafe { libloading::Library::new("libEGL.so") }?;
    let egl = unsafe { DynamicInstance::<khronos_egl::EGL1_4>::load_required_from(lib) }?;

    // Get the display
    let display = unsafe { egl.get_display(khronos_egl::DEFAULT_DISPLAY) }
        .expect("Failed to get EGL display");

    // Initialize the display
    let (_major, _minor) = egl.initialize(display)?;

    // Choose an EGL configuration
    let config_attribs = [khronos_egl::NONE];
    let config = egl
        .choose_first_config(display, &config_attribs)
        .expect("Failed to choose EGL config")
        .expect("No suitable EGL config found");

    // Create the EGLDisplay from raw pointers
    let egl_display = unsafe {
        EGLDisplay::from_raw(
            display.as_ptr() as *mut c_void,
            config.as_ptr() as *mut c_void,
        )
    }
    .expect("Failed to create EGLDisplay");

    Ok(egl_display)
}

/// Create a new [`WinitGraphicsBackend`] for the Android window: an EGL display, a GLES context
/// and a window surface, plus the [`GlesRenderer`] on top. The event loop keeps the control flow
/// it has; frames are drawn on demand.
pub fn bind(event_loop: &ActiveEventLoop) -> Result<WinitGraphicsBackend<GlesRenderer>, String> {
    #[allow(deprecated)]
    let window = Arc::new(
        event_loop
            .create_window(WindowAttributes::default())
            .map_err(|error| format!("Failed to create window: {error}"))?,
    );

    let handle = window
        .window_handle()
        .map(|handle| handle.as_raw())
        .map_err(|error| format!("Failed to get window handle: {error}"))?;
    let (native_window, display, context, surface) = match handle {
        RawWindowHandle::AndroidNdk(handle) => {
            let display = create_egl_display(handle)
                .map_err(|error| format!("Failed to create EGLDisplay: {error:?}"))?;

            let context = create_egl_context(&display)?;
            let pixel_format = context
                .pixel_format()
                .ok_or_else(|| "EGL context did not expose a pixel format".to_string())?;

            let surface = unsafe {
                EGLSurface::new(
                    &display,
                    pixel_format,
                    context.config_id(),
                    AndroidNativeSurface { handle },
                )
                .map_err(|error| format!("Failed to create EGLSurface: {error}"))?
            };

            let _ = context.unbind();
            (handle.a_native_window, display, context, surface)
        }
        platform => return Err(format!("Unsupported platform: {:?}", platform)),
    };

    let renderer = unsafe { GlesRenderer::new(context) }
        .map_err(|error| format!("Failed to create GLES Renderer: {error}"))?;
    let damage_tracking = display.supports_damage();

    Ok(WinitGraphicsBackend {
        window: window.clone(),
        native_window,
        _display: display,
        egl_surface: surface,
        damage_tracking,
        bind_size: None,
        renderer,
    })
}

/// Window with an active EGL Context created by `winit`.
#[derive(Debug)]
pub struct WinitGraphicsBackend<R> {
    renderer: R,
    // The display isn't used past this point but must be kept alive.
    _display: EGLDisplay,
    egl_surface: EGLSurface,
    window: Arc<WinitWindow>,
    native_window: NonNull<c_void>,
    damage_tracking: bool,
    bind_size: Option<Size<i32, Physical>>,
}

impl<R> WinitGraphicsBackend<R>
where
    R: Bind<EGLSurface>,
    SwapBuffersError: From<R::Error>,
{
    /// Window size of the underlying window
    pub fn window_size(&self) -> Size<i32, Physical> {
        let (w, h): (i32, i32) = self.window.inner_size().into();
        (w, h).into()
    }

    /// Scale factor of the underlying window.
    pub fn scale_factor(&self) -> f64 {
        self.window.scale_factor()
    }

    /// Reference to the underlying window
    pub fn window(&self) -> &WinitWindow {
        &self.window
    }

    /// The raw `ANativeWindow` this backend renders to; valid until the window is destroyed
    /// (`Suspended`).
    pub fn native_window(&self) -> *mut c_void {
        self.native_window.as_ptr()
    }

    /// Access the underlying renderer
    pub fn renderer(&mut self) -> &mut R {
        &mut self.renderer
    }

    /// Bind the underlying window to the underlying renderer.
    pub fn bind(&mut self) -> Result<(&mut R, R::Framebuffer<'_>), SwapBuffersError> {
        // NOTE: we must resize before making the current context current, otherwise the back
        // buffer will be latched. Some nvidia drivers may not like it, but a lot of wayland
        // software does the order that way due to mesa latching back buffer on each
        // `make_current`.
        // On Android the surface follows the `ANativeWindow` size by itself: the buffer queue
        // hands out buffers of the window's current size from the next dequeue on.
        let window_size = self.window_size();
        if Some(window_size) != self.bind_size {
            self.egl_surface.resize(window_size.w, window_size.h, 0, 0);
        }
        self.bind_size = Some(window_size);

        let fb = self.renderer.bind(&mut self.egl_surface)?;

        Ok((&mut self.renderer, fb))
    }

    /// Retrieve the underlying `EGLSurface` for advanced operations
    ///
    /// **Note:** Don't carelessly use this to manually bind the renderer to the surface,
    /// `WinitGraphicsBackend::bind` transparently handles window resizes for you.
    pub fn egl_surface(&self) -> &EGLSurface {
        &self.egl_surface
    }

    /// Retrieve the buffer age of the current backbuffer of the window.
    ///
    /// This will only return a meaningful value, if this `WinitGraphicsBackend`
    /// is currently bound (by previously calling [`WinitGraphicsBackend::bind`]).
    ///
    /// Otherwise and on error this function returns `None`.
    /// If you are using this value actively e.g. for damage-tracking you should
    /// likely interpret an error just as if "0" was returned.
    pub fn buffer_age(&self) -> Option<usize> {
        if self.damage_tracking {
            self.egl_surface.buffer_age().map(|x| x as usize)
        } else {
            Some(0)
        }
    }

    /// Submits the back buffer to the window by swapping, requires the window to be previously
    /// bound (see [`WinitGraphicsBackend::bind`]). The swap interval is 1, so this blocks once
    /// SurfaceFlinger's buffer queue is full, which is what paces the render loop to the display.
    pub fn submit(
        &mut self,
        damage: Option<&[Rectangle<i32, Physical>]>,
    ) -> Result<(), SwapBuffersError> {
        let mut damage = match damage {
            Some(damage) if self.damage_tracking && !damage.is_empty() => {
                let bind_size = self
                    .bind_size
                    .expect("submitting without ever binding the renderer.");
                let damage = damage
                    .iter()
                    .map(|rect| {
                        Rectangle::new(
                            (rect.loc.x, bind_size.h - rect.loc.y - rect.size.h).into(),
                            rect.size,
                        )
                    })
                    .collect::<Vec<_>>();
                Some(damage)
            }
            _ => None,
        };

        // Request frame callback.
        self.window.pre_present_notify();
        self.egl_surface.swap_buffers(damage.as_deref_mut())?;
        Ok(())
    }
}
