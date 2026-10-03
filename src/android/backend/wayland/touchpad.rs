//! Laptop-touchpad gestures for touch input: relative pointer movement, tap to click, two-finger
//! tap for right click, two-finger drag to scroll, tap-and-drag, and optional click zones.
//!
//! The state machine is independent from Wayland and Android: it consumes finger events (window
//! pixels, millisecond timestamps) and emits [`PadAction`]s.

use super::layout::ClickZone;

const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;

/// A finger that lifts within this time (ms), without moving, is a tap.
const TAP_MAX_MS: u64 = 250;
/// After a tap the left button stays down this long (ms), waiting for a second touch that turns
/// it into a drag.
const TAP_DRAG_MS: u64 = 220;
/// A two-finger touch shorter than this (ms) and without scrolling is a right click.
const TWO_FINGER_TAP_MAX_MS: u64 = 350;

/// Pointer speed (window px per ms) that adds one extra unit of gain.
const ACCEL_SPEED: f64 = 1.5;
const BASE_GAIN: f64 = 1.3;
const MAX_EXTRA_GAIN: f64 = 2.2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PadAction {
    /// Relative pointer movement in window pixels, already accelerated.
    Move { dx: f64, dy: f64 },
    /// Linux button code pressed or released.
    Button { button: u32, pressed: bool },
    /// Scroll by a pixel delta (window pixels); the content follows the fingers.
    Scroll { dx: f64, dy: f64 },
}

#[derive(Debug, Clone, Copy)]
struct Finger {
    id: u64,
    start: (f64, f64),
    last: (f64, f64),
    last_time: u64,
    down_time: u64,
    travelled: f64,
    /// Set once the finger has moved past the touch slop: it can no longer be part of a tap.
    moved: bool,
    zone: Option<ClickZone>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Idle,
    /// One finger down, may still become a tap.
    Touching,
    /// A tap happened; the left button stays down until `release_at` unless a new touch starts.
    TapPending { release_at: u64 },
    /// Left button held by a tap-and-drag (second touch). `moved` once it left the slop.
    Dragging { down_time: u64, moved: bool },
    /// Two fingers down.
    TwoFinger { down_time: u64, scrolled: bool, clicked: bool },
    /// Gesture finished while fingers remain; ignore them until all lift.
    Settled,
}

pub struct Touchpad {
    fingers: Vec<Finger>,
    state: State,
    slop: f64,
    /// Click-zone buttons currently held (left, right).
    zone_held: [bool; 2],
}

impl Touchpad {
    pub fn new(touch_slop_px: f64) -> Self {
        Touchpad {
            fingers: Vec::new(),
            state: State::Idle,
            slop: touch_slop_px.max(4.0),
            zone_held: [false; 2],
        }
    }

    fn pointer_fingers(&self) -> usize {
        self.fingers.iter().filter(|finger| finger.zone.is_none()).count()
    }

    /// When the state machine next needs [`Touchpad::tick`] (clock milliseconds).
    pub fn next_deadline(&self) -> Option<u64> {
        match self.state {
            State::TapPending { release_at } => Some(release_at),
            _ => None,
        }
    }

    pub fn tick(&mut self, now: u64, out: &mut Vec<PadAction>) {
        if let State::TapPending { release_at } = self.state {
            if now >= release_at {
                out.push(PadAction::Button { button: BTN_LEFT, pressed: false });
                self.state = State::Idle;
            }
        }
    }

    pub fn touch_down(
        &mut self,
        id: u64,
        position: (f64, f64),
        time: u64,
        zone: Option<ClickZone>,
        out: &mut Vec<PadAction>,
    ) {
        self.fingers.push(Finger {
            id,
            start: position,
            last: position,
            last_time: time,
            down_time: time,
            travelled: 0.0,
            moved: false,
            zone,
        });

        if let Some(zone) = zone {
            let index = zone as usize;
            if !self.zone_held[index] {
                self.zone_held[index] = true;
                out.push(PadAction::Button { button: zone_button(zone), pressed: true });
            }
            return;
        }

        match (self.pointer_fingers(), self.state) {
            (1, State::TapPending { .. }) => {
                // Second touch within the tap window: the held button turns it into a drag.
                self.state = State::Dragging { down_time: time, moved: false };
            }
            (1, _) => self.state = State::Touching,
            (_, State::Dragging { .. } | State::TapPending { .. }) => {
                // A second finger ends the drag: let go of the button first.
                out.push(PadAction::Button { button: BTN_LEFT, pressed: false });
                self.state = State::TwoFinger { down_time: time, scrolled: false, clicked: false };
            }
            (_, State::Touching) => {
                self.state = State::TwoFinger { down_time: time, scrolled: false, clicked: false };
            }
            _ => self.state = State::Settled,
        }
    }

    pub fn touch_move(&mut self, id: u64, position: (f64, f64), time: u64, out: &mut Vec<PadAction>) {
        let slop = self.slop;
        let Some(index) = self.fingers.iter().position(|finger| finger.id == id) else {
            return;
        };
        let finger = &mut self.fingers[index];
        let delta = (position.0 - finger.last.0, position.1 - finger.last.1);
        let elapsed = time.saturating_sub(finger.last_time).max(1);
        finger.last = position;
        finger.last_time = time;
        finger.travelled = finger.travelled.max(distance(finger.start, position));
        let was_moved = finger.moved;
        if finger.travelled > slop {
            finger.moved = true;
        }
        let finger = *finger;
        if finger.zone.is_some() {
            return;
        }

        match self.state {
            State::Touching | State::Dragging { .. } if self.pointer_fingers() == 1 => {
                if let State::Dragging { down_time, .. } = self.state {
                    if finger.moved {
                        self.state = State::Dragging { down_time, moved: true };
                    }
                }
                if !finger.moved {
                    return;
                }
                // Movement held back by the slop is released together with the first move.
                let travelled = if was_moved {
                    delta
                } else {
                    (position.0 - finger.start.0, position.1 - finger.start.1)
                };
                let (dx, dy) = accelerate(travelled, if was_moved { elapsed } else { 16 });
                out.push(PadAction::Move { dx, dy });
            }
            State::TwoFinger { down_time, scrolled, clicked } => {
                let pointer_fingers: Vec<&Finger> =
                    self.fingers.iter().filter(|finger| finger.zone.is_none()).collect();
                if pointer_fingers.len() < 2 {
                    return;
                }
                // The centroid moves by the mean of the fingers' deltas; this call only knows
                // this finger's, so scale it by the finger count.
                let share = 1.0 / pointer_fingers.len() as f64;
                let travelled = pointer_fingers
                    .iter()
                    .map(|finger| finger.travelled)
                    .fold(0.0_f64, f64::max);
                if !scrolled && travelled <= slop {
                    return;
                }
                if !scrolled {
                    self.state = State::TwoFinger { down_time, scrolled: true, clicked };
                }
                out.push(PadAction::Scroll { dx: delta.0 * share, dy: delta.1 * share });
            }
            _ => {}
        }
    }

    pub fn touch_up(&mut self, id: u64, time: u64, out: &mut Vec<PadAction>) {
        let Some(index) = self.fingers.iter().position(|finger| finger.id == id) else {
            return;
        };
        let finger = self.fingers.remove(index);

        if let Some(zone) = finger.zone {
            let index = zone as usize;
            if self.zone_held[index] {
                self.zone_held[index] = false;
                out.push(PadAction::Button { button: zone_button(zone), pressed: false });
            }
            return;
        }

        let remaining = self.pointer_fingers();
        match self.state {
            State::Touching => {
                if !finger.moved && time.saturating_sub(finger.down_time) <= TAP_MAX_MS {
                    out.push(PadAction::Button { button: BTN_LEFT, pressed: true });
                    self.state = State::TapPending { release_at: time + TAP_DRAG_MS };
                } else {
                    self.state = State::Idle;
                }
            }
            State::Dragging { down_time, moved } => {
                out.push(PadAction::Button { button: BTN_LEFT, pressed: false });
                if !moved && time.saturating_sub(down_time) <= TAP_MAX_MS {
                    // Second tap of a double tap: the first click just completed, click again.
                    out.push(PadAction::Button { button: BTN_LEFT, pressed: true });
                    out.push(PadAction::Button { button: BTN_LEFT, pressed: false });
                }
                self.state = State::Idle;
            }
            State::TwoFinger { down_time, scrolled, clicked } => {
                if !scrolled && !clicked && time.saturating_sub(down_time) <= TWO_FINGER_TAP_MAX_MS {
                    out.push(PadAction::Button { button: BTN_RIGHT, pressed: true });
                    out.push(PadAction::Button { button: BTN_RIGHT, pressed: false });
                    self.state = State::TwoFinger { down_time, scrolled, clicked: true };
                }
                if remaining == 0 {
                    self.state = State::Idle;
                } else if remaining == 1 {
                    self.state = State::Settled;
                }
            }
            State::Settled | State::TapPending { .. } | State::Idle => {}
        }

        if remaining == 0 && !matches!(self.state, State::TapPending { .. }) {
            self.state = State::Idle;
        }
    }

    /// Drop every finger and release any button the gestures are holding.
    pub fn reset(&mut self, out: &mut Vec<PadAction>) {
        if matches!(self.state, State::TapPending { .. } | State::Dragging { .. }) {
            out.push(PadAction::Button { button: BTN_LEFT, pressed: false });
        }
        for zone in [ClickZone::Left, ClickZone::Right] {
            if std::mem::take(&mut self.zone_held[zone as usize]) {
                out.push(PadAction::Button { button: zone_button(zone), pressed: false });
            }
        }
        self.fingers.clear();
        self.state = State::Idle;
    }
}

fn zone_button(zone: ClickZone) -> u32 {
    match zone {
        ClickZone::Left => BTN_LEFT,
        ClickZone::Right => BTN_RIGHT,
    }
}

fn distance(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Pointer gain grows with finger speed, like a laptop touchpad.
fn accelerate(delta: (f64, f64), elapsed_ms: u64) -> (f64, f64) {
    let speed = (delta.0 * delta.0 + delta.1 * delta.1).sqrt() / elapsed_ms.max(1) as f64;
    let gain = BASE_GAIN * (1.0 + (speed / ACCEL_SPEED).min(MAX_EXTRA_GAIN));
    (delta.0 * gain, delta.1 * gain)
}
