//! Where the guest desktop and the optional laptop-mode touchpad sit inside the Android window,
//! and how window pixels map to guest coordinates.

use smithay::utils::{Logical, Physical, Point, Rectangle, Scale, Size};

/// Lowest accepted `display.render_scale`.
pub const MIN_RENDER_SCALE: f32 = 0.5;

/// Share of the touchpad height, at its bottom, that works as left/right click zones.
const CLICK_ZONE_FRACTION: f64 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickZone {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    /// Size of the Android window (the EGL surface) in physical pixels.
    pub window: Size<i32, Physical>,
    /// Part of the window showing the guest desktop.
    pub guest_area: Rectangle<i32, Physical>,
    /// Laptop mode: the part of the window drawn as a touchpad.
    pub touchpad_area: Option<Rectangle<i32, Physical>>,
    /// Size the guest renders at: `guest_area` times the render scale.
    pub guest_size: Size<i32, Logical>,
}

fn scaled_length(length: i32, render_scale: f64) -> i32 {
    if render_scale >= 0.999 {
        // Not scaling: keep the exact size so the guest is drawn 1:1 instead of resampled.
        return length.max(1);
    }
    // Even sizes keep wlroots/Xwayland happy and halve cleanly.
    (((length as f64 * render_scale).round() as i32) & !1).max(2)
}

impl Layout {
    /// `split` places the guest in the top half (above the hinge, assumed at mid-height) and a
    /// touchpad in the bottom half.
    pub fn compute(window: Size<i32, Physical>, render_scale: f32, split: bool) -> Self {
        let window = Size::from((window.w.max(1), window.h.max(1)));
        let render_scale = render_scale.clamp(MIN_RENDER_SCALE, 1.0) as f64;

        let (guest_area, touchpad_area) = if split && window.h >= 2 {
            let hinge = window.h / 2;
            (
                Rectangle::new((0, 0).into(), (window.w, hinge).into()),
                Some(Rectangle::new(
                    (0, hinge).into(),
                    (window.w, window.h - hinge).into(),
                )),
            )
        } else {
            (Rectangle::from_size(window), None)
        };

        let guest_size = Size::from((
            scaled_length(guest_area.size.w, render_scale),
            scaled_length(guest_area.size.h, render_scale),
        ));

        Layout {
            window,
            guest_area,
            touchpad_area,
            guest_size,
        }
    }

    /// Factor from guest pixels to window pixels, per axis.
    pub fn scale(&self) -> Scale<f64> {
        let axis = |area: i32, guest: i32| {
            let ratio = area as f64 / guest as f64;
            if (ratio - 1.0).abs() < 1e-3 {
                1.0
            } else {
                ratio
            }
        };
        Scale::from((
            axis(self.guest_area.size.w, self.guest_size.w),
            axis(self.guest_area.size.h, self.guest_size.h),
        ))
    }

    /// Map a window position to guest coordinates, clamped to the guest output.
    pub fn window_to_guest(&self, position: Point<f64, Physical>) -> Point<f64, Logical> {
        let scale = self.scale();
        let x = (position.x - self.guest_area.loc.x as f64) / scale.x;
        let y = (position.y - self.guest_area.loc.y as f64) / scale.y;
        self.clamp_to_guest(Point::from((x, y)))
    }

    /// Map a window-space movement to guest-space movement.
    pub fn window_delta_to_guest(&self, delta: (f64, f64)) -> (f64, f64) {
        let scale = self.scale();
        (delta.0 / scale.x, delta.1 / scale.y)
    }

    pub fn clamp_to_guest(&self, position: Point<f64, Logical>) -> Point<f64, Logical> {
        // Stay strictly inside so the position is still on the output.
        let max_x = (self.guest_size.w as f64 - 0.01).max(0.0);
        let max_y = (self.guest_size.h as f64 - 0.01).max(0.0);
        Point::from((position.x.clamp(0.0, max_x), position.y.clamp(0.0, max_y)))
    }

    /// Where the guest pointer is drawn, in window pixels.
    pub fn guest_to_window(&self, position: Point<f64, Logical>) -> Point<f64, Physical> {
        let scale = self.scale();
        Point::from((
            self.guest_area.loc.x as f64 + position.x * scale.x,
            self.guest_area.loc.y as f64 + position.y * scale.y,
        ))
    }

    pub fn in_touchpad(&self, position: Point<f64, Physical>) -> bool {
        self.touchpad_area
            .map(|area| area.to_f64().contains(position))
            .unwrap_or(false)
    }

    /// The click zone under `position`, if it is inside the touchpad's bottom strip.
    pub fn click_zone(&self, position: Point<f64, Physical>) -> Option<ClickZone> {
        let area = self.touchpad_area?.to_f64();
        if !area.contains(position) {
            return None;
        }
        let zone_top = area.loc.y + area.size.h * (1.0 - CLICK_ZONE_FRACTION);
        if position.y < zone_top {
            return None;
        }
        if position.x < area.loc.x + area.size.w / 2.0 {
            Some(ClickZone::Left)
        } else {
            Some(ClickZone::Right)
        }
    }
}
