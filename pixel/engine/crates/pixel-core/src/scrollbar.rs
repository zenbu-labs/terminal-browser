
use std::time::{Duration, Instant};

use crate::style::ScrollbarStyle;
use crate::tree::PxRect;

const HIDE_DELAY: Duration = Duration::from_millis(1000);

#[derive(Default)]
pub(crate) struct BarState {
    pub opacity: f32,
    pub expand: f32,
    pub last_move: Option<Instant>,
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollbarRects {
    pub zone: PxRect,
    pub track: PxRect,
    pub thumb: PxRect,
}

pub(crate) fn step(
    bar: &mut BarState,
    engaged: bool,
    scroll_max: f32,
    dt: f32,
    now: Instant,
) -> bool {
    if engaged {
        bar.last_move = Some(now);
    }
    let recent = bar
        .last_move
        .is_some_and(|at| now.duration_since(at) < HIDE_DELAY);
    let show = scroll_max > 0.0 && (recent || engaged);
    let opacity = step_toward(bar.opacity, show, dt / 0.10, dt / 0.30);
    let expand = step_toward(bar.expand, engaged, dt / 0.10, dt / 0.10);
    let changed = opacity != bar.opacity || expand != bar.expand;
    bar.opacity = opacity;
    bar.expand = expand;
    changed
}

pub(crate) fn animating(bar: &BarState, now: Instant) -> bool {
    bar.opacity > 0.0
        || bar
            .last_move
            .is_some_and(|at| now.duration_since(at) < HIDE_DELAY)
}

fn step_toward(value: f32, up: bool, up_rate: f32, down_rate: f32) -> f32 {
    if up {
        (value + up_rate).min(1.0)
    } else {
        (value - down_rate).max(0.0)
    }
}

pub(crate) fn rects(
    bar: &ScrollbarStyle,
    visible: PxRect,
    viewport_h: f32,
    scroll_max: f32,
    position: f32,
    expand: f32,
) -> Option<ScrollbarRects> {
    if visible.h <= bar.margin * 2.0 || visible.w <= 0.0 {
        return None;
    }
    let width = bar.width + (bar.hover_width - bar.width) * expand;
    let track = PxRect {
        x: visible.x + visible.w - width - bar.margin,
        y: visible.y + bar.margin,
        w: width,
        h: visible.h - 2.0 * bar.margin,
    };
    let content = scroll_max + viewport_h;
    let thumb_h = (track.h * viewport_h / content)
        .max(bar.min_thumb)
        .min(track.h);
    let range = track.h - thumb_h;
    let frac = (position / scroll_max).clamp(0.0, 1.0);
    let thumb = PxRect {
        x: track.x,
        y: track.y + frac * range,
        w: track.w,
        h: thumb_h,
    };
    let zone_w = bar.hover_width + 2.0 * bar.margin;
    let zone = PxRect {
        x: visible.x + visible.w - zone_w,
        y: visible.y,
        w: zone_w,
        h: visible.h,
    };
    Some(ScrollbarRects { zone, track, thumb })
}

pub(crate) fn pos_for_thumb(rects: &ScrollbarRects, scroll_max: f32, thumb_y: f32) -> f32 {
    let range = rects.track.h - rects.thumb.h;
    if range <= 0.0 {
        return 0.0;
    }
    let frac = ((thumb_y - rects.track.y) / range).clamp(0.0, 1.0);
    frac * scroll_max
}
