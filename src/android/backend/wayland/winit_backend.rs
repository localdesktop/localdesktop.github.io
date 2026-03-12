//! Implementation of backend traits for types provided by `winit`
//!
//! This module provides the appropriate implementations of the backend
//! interfaces for running a compositor as a Wayland or X11 client using [`winit`].
//!
//! ## Usage
//!
//! The backend is initialized using one of the [`init`], [`init_from_attributes`] or
//! [`init_from_attributes_with_gl_attr`] functions, depending on the amount of control
//! you want on the initialization of the backend. These functions will provide you
//! with two objects:
//!
//! - a [`WinitGraphicsBackend`], which can give you an implementation of a [`Renderer`]
//!   (or even [`GlesRenderer`]) through its `renderer` method in addition to further
//!   functionality to access and manage the created winit-window.
//! - a [`WinitEventLoop`], which dispatches some [`WinitEvent`] from the host graphics server.
//!
//! The other types in this module are the instances of the associated types of these
//! two traits for the winit backend.

use khronos_egl::DynamicInstance;
use smithay::{
    backend::{
        egl::{
            context::{GlAttributes, PixelFormatRequirements},
            display::EGLDisplay,
            native::EGLNativeSurface,
            EGLContext, EGLSurface, Error as EGLError,
        },
        renderer::{
            gles::{GlesError, GlesRenderer},
            Bind,
        },
        SwapBuffersError,
    },
    utils::{Physical, Rectangle, Size},
};
use std::ffi::c_void;
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
    let candidates = [
        ContextCandidate {
            label: "OpenGL ES 3.0 with 10-bit hardware-accelerated surface",
            attributes: GlAttributes {
                version: (3, 0),
                profile: None,
                debug: cfg!(debug_assertions),
                vsync: false,
            },
            pixel_format: PixelFormatRequirements::_10_bit(),
        },
        ContextCandidate {
            label: "OpenGL ES 3.0 with 8-bit hardware-accelerated surface",
            attributes: GlAttributes {
                version: (3, 0),
                profile: None,
                debug: cfg!(debug_assertions),
                vsync: false,
            },
            pixel_format: PixelFormatRequirements::_8_bit(),
        },
        ContextCandidate {
            label: "OpenGL ES 3.0 with 8-bit emulator-friendly surface",
            attributes: GlAttributes {
                version: (3, 0),
                profile: None,
                debug: cfg!(debug_assertions),
                vsync: false,
            },
            pixel_format: PixelFormatRequirements {
                hardware_accelerated: None,
                color_bits: Some(24),
                float_color_buffer: false,
                alpha_bits: Some(8),
                depth_bits: Some(24),
                stencil_bits: Some(8),
                multisampling: None,
            },
        },
        ContextCandidate {
            label: "OpenGL ES 2.0 with 8-bit emulator-friendly surface",
            attributes: GlAttributes {
                version: (2, 0),
                profile: None,
                debug: cfg!(debug_assertions),
                vsync: false,
            },
            pixel_format: PixelFormatRequirements {
                hardware_accelerated: None,
                color_bits: Some(24),
                float_color_buffer: false,
                alpha_bits: Some(8),
                depth_bits: Some(24),
                stencil_bits: Some(8),
                multisampling: None,
            },
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
        assert!(!surface.is_null());
        Ok(surface)
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
    .expect("Failed to create EGL display");

    Ok(egl_display)
}

/// Create a new [`WinitGraphicsBackend`], which implements the [`Renderer`]
/// trait, from a given [`WindowAttributes`] struct, as well as given
/// [`GlAttributes`] for further customization of the rendering pipeline and a
/// corresponding [`WinitEventLoop`].
pub fn bind(event_loop: &ActiveEventLoop) -> WinitGraphicsBackend<GlesRenderer> {
    #[allow(deprecated)]
    let window = Arc::new(
        event_loop
            .create_window(WindowAttributes::default())
            .expect("Failed to create window"),
    );

    let handle = window.window_handle().map(|handle| handle.as_raw());
    let (display, context, surface) = match handle {
        Ok(RawWindowHandle::AndroidNdk(handle)) => {
            let display = create_egl_display(handle);
            let display = match display {
                Ok(display) => display,
                Err(error) => {
                    panic!("Failed to create EGLDisplay: {:?}", error)
                }
            };

            let context =
                create_egl_context(&display).unwrap_or_else(|message| panic!("{}", message));

            let surface = unsafe {
                EGLSurface::new(
                    &display,
                    context.pixel_format().unwrap(),
                    context.config_id(),
                    AndroidNativeSurface { handle },
                )
                .expect("Failed to create EGLSurface")
            };

            let _ = context.unbind();
            (display, context, surface)
        }
        Ok(platform) => panic!("Unsupported platform: {:?}", platform),
        Err(error) => panic!("Failed to get window handle: {:?}", error),
    };

    let renderer = unsafe { GlesRenderer::new(context) }.expect("Failed to create GLES Renderer");
    let damage_tracking = display.supports_damage();

    event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);

    WinitGraphicsBackend {
        window: window.clone(),
        _display: display,
        egl_surface: surface,
        damage_tracking,
        bind_size: None,
        renderer,
    }
}

/// Errors thrown by the `winit` backends
#[derive(Debug)]
pub enum Error {
    /// Failed to initialize an event loop.
    EventLoopCreation(winit::error::EventLoopError),
    /// Failed to initialize a window.
    WindowCreation(winit::error::OsError),
    /// Surface creation error.
    Surface(Box<dyn std::error::Error>),
    /// Context creation is not supported on the current window system
    NotSupported,
    /// EGL error.
    Egl(EGLError),
    /// Renderer initialization failed.
    RendererCreationError(GlesError),
}

/// Window with an active EGL Context created by `winit`.
#[derive(Debug)]
pub struct WinitGraphicsBackend<R> {
    renderer: R,
    // The display isn't used past this point but must be kept alive.
    _display: EGLDisplay,
    egl_surface: EGLSurface,
    window: Arc<WinitWindow>,
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
    /// bound (see [`WinitGraphicsBackend::bind`]).
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
