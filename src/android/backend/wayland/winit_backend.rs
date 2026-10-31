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

use crate::android::external_display::ExternalSurface;
use khronos_egl::DynamicInstance;
use smithay::backend::egl::display::PixelFormat;
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
            Bind, Color32F, Frame, Renderer,
        },
        SwapBuffersError,
    },
    utils::{Physical, Rectangle, Size, Transform},
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
        if surface.is_null() {
            return Err(smithay::backend::egl::EGLError::BadSurface);
        }
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
    let (display, context, surface, pixel_format) = match handle {
        RawWindowHandle::AndroidNdk(handle) => {
            let display = create_egl_display(handle)
                .map_err(|error| format!("Failed to create EGLDisplay: {error:?}"))?;

            let context = create_egl_context(&display)?;
            let pixel_format = context
                .pixel_format()
                .ok_or_else(|| "EGL context did not expose a pixel format".to_string())?;

            let surface = create_window_surface(&display, pixel_format, &context, handle)?;

            let _ = context.unbind();
            (display, context, surface, pixel_format)
        }
        platform => return Err(format!("Unsupported platform: {:?}", platform)),
    };

    let renderer = unsafe { GlesRenderer::new(context) }
        .map_err(|error| format!("Failed to create GLES Renderer: {error}"))?;
    let damage_tracking = display.supports_damage();

    Ok(WinitGraphicsBackend {
        window: window.clone(),
        _display: display,
        egl_surface: Some(surface),
        damage_tracking,
        bind_size: None,
        pixel_format,
        external: None,
        renderer,
    })
}

fn create_window_surface(
    display: &EGLDisplay,
    pixel_format: PixelFormat,
    context: &EGLContext,
    handle: AndroidNdkWindowHandle,
) -> Result<EGLSurface, String> {
    unsafe {
        EGLSurface::new(
            display,
            pixel_format,
            context.config_id(),
            AndroidNativeSurface { handle },
        )
    }
    .map_err(|error| format!("Failed to create EGLSurface: {error}"))
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
    /// The phone's own window; gone while the app is in the background.
    egl_surface: Option<EGLSurface>,
    window: Arc<WinitWindow>,
    damage_tracking: bool,
    bind_size: Option<Size<i32, Physical>>,
    pixel_format: PixelFormat,
    /// Drawn to instead of `window` while an external monitor is connected.
    external: Option<ExternalTarget>,
}

#[derive(Debug)]
struct ExternalTarget {
    egl_surface: EGLSurface,
    bind_size: Option<Size<i32, Physical>>,
    // Declared last: the EGL surface must go before the native window it was created on.
    surface: Arc<ExternalSurface>,
}

impl WinitGraphicsBackend<GlesRenderer> {
    /// Draw to `surface` from now on, until `detach_external`.
    pub fn attach_external(&mut self, surface: Arc<ExternalSurface>) -> Result<(), String> {
        // A native window takes one EGL surface at a time.
        self.external = None;
        let handle = AndroidNdkWindowHandle::new(surface.native_window());
        let egl_surface = unsafe {
            EGLSurface::new(
                &self._display,
                self.pixel_format,
                self.renderer.egl_context().config_id(),
                AndroidNativeSurface { handle },
            )
        }
        .map_err(|error| {
            format!("Failed to create EGLSurface for the external display: {error}")
        })?;
        self.external = Some(ExternalTarget {
            egl_surface,
            bind_size: None,
            surface,
        });
        Ok(())
    }

    pub fn detach_external(&mut self) {
        self.external = None;
    }

    /// Let go of the phone's window as the app goes to the background, but keep drawing to the
    /// external monitor.
    pub fn suspend_window(&mut self) {
        self.egl_surface = None;
        self.bind_size = None;
    }

    pub fn window_visible(&self) -> bool {
        self.egl_surface.is_some()
    }

    /// Draw to the phone's window again once the app is back, if it had been let go.
    pub fn resume_window(&mut self) -> Result<(), String> {
        if self.egl_surface.is_some() {
            return Ok(());
        }
        let handle = match self.window.window_handle().map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::AndroidNdk(handle)) => handle,
            Ok(platform) => return Err(format!("Unsupported platform: {platform:?}")),
            Err(error) => return Err(format!("Failed to get window handle: {error}")),
        };
        let surface = create_window_surface(
            &self._display,
            self.pixel_format,
            self.renderer.egl_context(),
            handle,
        )?;
        self.egl_surface = Some(surface);
        Ok(())
    }

    /// Fill the phone's own window with one color, for when it serves as a trackpad.
    pub fn paint_window(&mut self, color: Color32F) -> Result<(), String> {
        let size = self.window_size();
        let Some(egl_surface) = self.egl_surface.as_mut() else {
            return Ok(());
        };
        if Some(size) != self.bind_size {
            egl_surface.resize(size.w, size.h, 0, 0);
            self.bind_size = Some(size);
        }
        {
            let mut framebuffer = self
                .renderer
                .bind(egl_surface)
                .map_err(|error| format!("Failed to bind the window: {error}"))?;
            let mut frame = self
                .renderer
                .render(&mut framebuffer, size, Transform::Normal)
                .map_err(|error| format!("Failed to render the window: {error:?}"))?;
            frame
                .clear(color, &[Rectangle::from_size(size)])
                .map_err(|error| format!("Failed to clear the window: {error:?}"))?;
            let _ = frame
                .finish()
                .map_err(|error| format!("Failed to finish the window: {error:?}"))?;
        }
        egl_surface
            .swap_buffers(None)
            .map_err(|error| format!("Failed to submit the window: {error}"))
    }
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

    /// The external monitor being drawn to, if any.
    pub fn external_surface(&self) -> Option<&Arc<ExternalSurface>> {
        self.external.as_ref().map(|target| &target.surface)
    }

    /// Size of what is drawn to: the external monitor if there is one, otherwise the window.
    pub fn output_size(&self) -> Size<i32, Physical> {
        match &self.external {
            Some(target) => (target.surface.width, target.surface.height).into(),
            None => self.window_size(),
        }
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

    /// Raw handle of the EGL display the renderer runs on.
    pub fn egl_display(&self) -> smithay::backend::egl::ffi::egl::types::EGLDisplay {
        self._display.get_display_handle().handle
    }

    /// Bind the underlying window to the underlying renderer.
    pub fn bind(&mut self) -> Result<(&mut R, R::Framebuffer<'_>), SwapBuffersError> {
        // NOTE: we must resize before making the current context current, otherwise the back
        // buffer will be latched. Some nvidia drivers may not like it, but a lot of wayland
        // software does the order that way due to mesa latching back buffer on each
        // `make_current`.
        let output_size = self.output_size();
        let (egl_surface, bind_size) = match (&mut self.external, &mut self.egl_surface) {
            (Some(target), _) => (&mut target.egl_surface, &mut target.bind_size),
            (None, Some(egl_surface)) => (egl_surface, &mut self.bind_size),
            (None, None) => {
                return Err(SwapBuffersError::TemporaryFailure(
                    "the app is in the background".into(),
                ))
            }
        };
        if Some(output_size) != *bind_size {
            egl_surface.resize(output_size.w, output_size.h, 0, 0);
        }
        *bind_size = Some(output_size);

        let fb = self.renderer.bind(egl_surface)?;

        Ok((&mut self.renderer, fb))
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
            let egl_surface = match &self.external {
                Some(target) => &target.egl_surface,
                None => self.egl_surface.as_ref()?,
            };
            egl_surface.buffer_age().map(|x| x as usize)
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
        let (egl_surface, bind_size) = match (&self.external, &self.egl_surface) {
            (Some(target), _) => (&target.egl_surface, target.bind_size),
            (None, Some(egl_surface)) => (egl_surface, self.bind_size),
            (None, None) => {
                return Err(SwapBuffersError::TemporaryFailure(
                    "the app is in the background".into(),
                ))
            }
        };
        let mut damage = match damage {
            Some(damage) if self.damage_tracking && !damage.is_empty() => {
                let bind_size = bind_size.expect("submitting without ever binding the renderer.");
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
        egl_surface.swap_buffers(damage.as_deref_mut())?;
        Ok(())
    }
}
