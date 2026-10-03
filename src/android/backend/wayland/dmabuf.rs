//! GPU prototype (`gpu.enabled`): advertise `zwp_linux_dmabuf_v1` so guest clients rendering on
//! the GPU can hand their buffers over without a copy through `wl_shm`.
//!
//! The global exposes the formats the `GlesRenderer` can import and is created only when the
//! option is on; otherwise the compositor offers `wl_shm` only, as before. Imports are queued by
//! the protocol handler (the compositor state does not own the renderer) and answered here.

use super::{State, WaylandBackend};
use smithay::backend::renderer::ImportDma;
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once the formats came back empty, so the check is not repeated on every client wake-up.
static NO_FORMATS: AtomicBool = AtomicBool::new(false);

/// Create the dmabuf global once a renderer exists and the GPU option is enabled.
pub fn ensure_global(backend: &mut WaylandBackend) {
    if !backend.config.gpu.enabled
        || backend.compositor.state.dmabuf_global.is_some()
        || NO_FORMATS.load(Ordering::Relaxed)
    {
        return;
    }
    let Some(winit) = backend.graphic_renderer.as_mut() else {
        return;
    };

    let formats: Vec<_> = winit.renderer().dmabuf_formats().iter().copied().collect();
    if formats.is_empty() {
        log::warn!("GPU option is on but the EGL display imports no dmabuf formats; dmabuf is not advertised");
        NO_FORMATS.store(true, Ordering::Relaxed);
        return;
    }

    log::info!("Advertising zwp_linux_dmabuf_v1 with {} format/modifier pairs", formats.len());
    let display_handle = backend.compositor.display.handle();
    let state = &mut backend.compositor.state;
    let global = state
        .dmabuf_state
        .create_global::<State>(&display_handle, formats);
    state.dmabuf_global = Some(global);
}

/// Import the dmabufs clients asked about and tell them whether the renderer accepted them.
pub fn process_pending_imports(backend: &mut WaylandBackend) {
    if backend.compositor.state.pending_dmabuf_imports.is_empty() {
        return;
    }
    let pending = std::mem::take(&mut backend.compositor.state.pending_dmabuf_imports);
    let mut renderer = backend
        .graphic_renderer
        .as_mut()
        .map(|winit| winit.renderer());

    for (dmabuf, notifier) in pending {
        let imported = match renderer.as_deref_mut() {
            Some(renderer) => renderer.import_dmabuf(&dmabuf, None).map(|_| ()),
            None => {
                notifier.failed();
                continue;
            }
        };
        match imported {
            Ok(()) => {
                if let Err(error) = notifier.successful::<State>() {
                    log::warn!("dmabuf client went away during import: {error}");
                }
            }
            Err(error) => {
                log::warn!("Importing a client dmabuf failed: {error}");
                notifier.failed();
            }
        }
    }
}
