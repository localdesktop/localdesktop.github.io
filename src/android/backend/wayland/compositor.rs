use super::bind::bind_socket;
use crate::android::utils::application_context::get_application_context;
use smithay::{
    backend::{allocator::dmabuf::Dmabuf, renderer::utils::on_commit_buffer_handler},
    delegate_compositor, delegate_data_device, delegate_dmabuf, delegate_output,
    delegate_pointer_constraints, delegate_relative_pointer, delegate_seat, delegate_shm,
    delegate_xdg_shell,
    input::{
        self, keyboard::KeyboardHandle, pointer::CursorImageStatus, touch::TouchHandle, Seat,
        SeatHandler, SeatState,
    },
    output::Output,
    reexports::{
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{protocol::wl_seat, Display},
    },
    utils::{Logical, Point, Serial, Size},
    wayland::{
        buffer::BufferHandler,
        compositor::{
            with_surface_tree_downward, CompositorClientState, CompositorHandler, CompositorState,
            SurfaceAttributes, TraversalAction,
        },
        dmabuf::{DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        output::OutputHandler,
        pointer_constraints::{
            with_pointer_constraint, PointerConstraint, PointerConstraintsHandler,
            PointerConstraintsState,
        },
        relative_pointer::RelativePointerManagerState,
        selection::{
            data_device::{
                ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
            },
            SelectionHandler,
        },
        shell::xdg::{
            PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
        },
        shm::{ShmHandler, ShmState},
    },
};
use smithay::{
    input::pointer::PointerHandle,
    reexports::wayland_server::{
        backend::{ClientData, ClientId, DisconnectReason, GlobalId},
        protocol::{wl_buffer, wl_surface::WlSurface},
        Client, ListeningSocket,
    },
};
use std::{
    error::Error,
    os::unix::io::OwnedFd,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

/// Set when a Wayland client disconnects; its surfaces vanish without any commit, so the event loop
/// has to redraw once.
pub static CLIENT_DISCONNECTED: AtomicBool = AtomicBool::new(false);

pub struct Compositor {
    pub state: State,
    pub display: Display<State>,
    pub listener: ListeningSocket,
    pub clients: Vec<Client>,
    pub start_time: Instant,
    pub seat: Seat<State>,
    pub keyboard: KeyboardHandle<State>,
    pub touch: TouchHandle<State>,
    pub pointer: PointerHandle<State>,
    pub output: Option<Output>,
    pub output_global: Option<GlobalId>,
    /// Pointer position in guest coordinates.
    pub pointer_location: Point<f64, Logical>,
}

pub struct State {
    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub shm_state: ShmState,
    pub data_device_state: DataDeviceState,
    pub seat_state: SeatState<Self>,
    pub size: Size<i32, Logical>,
    /// Something visible changed since the last frame: a client committed, the cursor image
    /// changed, ... The render loop only draws while this (or an explicit request) is set.
    pub damaged: bool,
    /// What the guest asked the cursor to look like.
    pub cursor_image: CursorImageStatus,
    pub dmabuf_state: DmabufState,
    /// Only created when `gpu.enabled` (see `dmabuf.rs`).
    pub dmabuf_global: Option<DmabufGlobal>,
    /// Client dmabufs waiting for the renderer, which `State` does not own.
    pub pending_dmabuf_imports: Vec<(Dmabuf, ImportNotifier)>,
    // The protocol globals live as long as the state.
    _relative_pointer_state: RelativePointerManagerState,
    _pointer_constraints_state: PointerConstraintsState,
}

impl BufferHandler for State {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl XdgShellHandler for State {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        surface.with_pending_state(|state| {
            state.size.replace(self.size);
            state.states.set(xdg_toplevel::State::Activated);
        });
        surface.send_configure();
    }

    fn toplevel_destroyed(&mut self, _surface: ToplevelSurface) {
        self.damaged = true;
    }

    fn new_popup(&mut self, _surface: PopupSurface, _positioner: PositionerState) {
        // Handle popup creation here
    }

    fn grab(&mut self, _surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        // Handle popup grab here
    }

    fn reposition_request(
        &mut self,
        _surface: PopupSurface,
        _positioner: PositionerState,
        _token: u32,
    ) {
        // Handle popup reposition here
    }
}

impl SelectionHandler for State {
    type SelectionUserData = ();
}

impl DataDeviceHandler for State {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

impl ClientDndGrabHandler for State {}
impl ServerDndGrabHandler for State {
    fn send(&mut self, _mime_type: String, _fd: OwnedFd, _seat: Seat<Self>) {}
}

impl CompositorHandler for State {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().unwrap().compositor_state
    }

    fn commit(&mut self, surface: &WlSurface) {
        on_commit_buffer_handler::<Self>(surface);
        self.damaged = true;
    }
}

impl ShmHandler for State {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

impl SeatHandler for State {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        &mut self.seat_state
    }

    fn focus_changed(&mut self, _seat: &Seat<Self>, _focused: Option<&WlSurface>) {}
    fn cursor_image(&mut self, _seat: &Seat<Self>, image: input::pointer::CursorImageStatus) {
        self.cursor_image = image;
        self.damaged = true;
    }
}

impl PointerConstraintsHandler for State {
    fn new_constraint(&mut self, surface: &WlSurface, pointer: &PointerHandle<Self>) {
        // The guest compositor is the only client and always has the pointer, so there is no
        // policy to apply: grant locks and confinements right away.
        with_pointer_constraint(surface, pointer, |constraint| {
            if let Some(constraint) = constraint {
                if !constraint.is_active() {
                    constraint.activate();
                }
            }
        });
    }

    fn cursor_position_hint(
        &mut self,
        _surface: &WlSurface,
        _pointer: &PointerHandle<Self>,
        _location: Point<f64, Logical>,
    ) {
    }
}

impl DmabufHandler for State {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    fn dmabuf_imported(
        &mut self,
        _global: &DmabufGlobal,
        dmabuf: Dmabuf,
        notifier: ImportNotifier,
    ) {
        self.pending_dmabuf_imports.push((dmabuf, notifier));
    }
}

/// Whether the guest currently holds a pointer lock on the focused surface.
pub fn pointer_locked(state: &State, pointer: &PointerHandle<State>) -> bool {
    let Some(surface) = state
        .xdg_shell_state
        .toplevel_surfaces()
        .iter()
        .next()
        .map(|surface| surface.wl_surface().clone())
    else {
        return false;
    };
    with_pointer_constraint(&surface, pointer, |constraint| {
        constraint
            .map(|constraint| {
                constraint.is_active() && matches!(&*constraint, PointerConstraint::Locked(_))
            })
            .unwrap_or(false)
    })
}

pub fn send_frames_surface_tree(surface: &WlSurface, time: u32) {
    with_surface_tree_downward(
        surface,
        (),
        |_, _, &()| TraversalAction::DoChildren(()),
        |_surf, states, &()| {
            // the surface may not have any user_data if it is a subsurface and has not
            // yet been commited
            for callback in states
                .cached_state
                .get::<SurfaceAttributes>()
                .current()
                .frame_callbacks
                .drain(..)
            {
                callback.done(time);
            }
        },
        |_, _, &()| true,
    );
}

#[derive(Default)]
pub struct ClientState {
    compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}

    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {
        CLIENT_DISCONNECTED.store(true, Ordering::Release);
    }
}

impl OutputHandler for State {}

// Macros used to delegate protocol handling to types in the app state.
delegate_xdg_shell!(State);
delegate_compositor!(State);
delegate_shm!(State);
delegate_seat!(State);
delegate_data_device!(State);
delegate_output!(State);
delegate_relative_pointer!(State);
delegate_pointer_constraints!(State);
delegate_dmabuf!(State);

impl Compositor {
    pub fn build() -> Result<Compositor, Box<dyn Error>> {
        let display = Display::new()?;
        let dh = display.handle();

        let mut seat_state = SeatState::new();
        let mut seat = seat_state.new_wl_seat(&dh, "Local Desktop");

        let listener = bind_socket()?;
        let clients = Vec::new();

        let start_time = Instant::now();

        // `repeat_info`: delay before repeating starts (ms) and repeats per second.
        let input_config = get_application_context().local_config.input;
        let keyboard = seat
            .add_keyboard(
                Default::default(),
                input_config.key_repeat_delay_ms.max(0),
                input_config.key_repeat_rate.max(0),
            )
            .expect("Failed to add keyboard");
        let touch = seat.add_touch();
        let pointer = seat.add_pointer();

        let state = State {
            compositor_state: CompositorState::new::<State>(&dh),
            xdg_shell_state: XdgShellState::new::<State>(&dh),
            shm_state: ShmState::new::<State>(&dh, vec![]),
            data_device_state: DataDeviceState::new::<State>(&dh),
            seat_state,
            size: (1920, 1080).into(),
            damaged: true,
            cursor_image: CursorImageStatus::default_named(),
            dmabuf_state: DmabufState::new(),
            dmabuf_global: None,
            pending_dmabuf_imports: Vec::new(),
            _relative_pointer_state: RelativePointerManagerState::new::<State>(&dh),
            _pointer_constraints_state: PointerConstraintsState::new::<State>(&dh),
        };

        Ok(Compositor {
            state,
            listener,
            clients,
            start_time,
            display,
            seat,
            keyboard,
            touch,
            pointer,
            output: None,
            output_global: None,
            pointer_location: (0.0, 0.0).into(),
        })
    }
}
