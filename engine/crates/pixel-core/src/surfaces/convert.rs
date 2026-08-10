//! BGRA→RGBA conversion kernels for surface frames.
//!
//! All the pixel-format work and every line of `unsafe` in the surface path
//! lives here. Two region converters exist because the two source memories
//! behave differently:
//!
//! - [`region_cached`]: ordinary memory. Rows are compared against the
//!   previous contents so an identical frame reports `changed = false` and
//!   costs no repaint downstream.
//! - [`region_uncached`]: write-combined/uncached memory (a mapped dmabuf),
//!   where scattered loads run at single-digit MB/s. One fused pass per row:
//!   16-byte streaming loads, an in-register byte shuffle, plain stores into
//!   the cached destination. No comparing -- reading the destination back
//!   would be cheap, but re-reading the source is not, and the producer's
//!   damage rect already says what changed.
//!
//! Both fan out over row bands via [`crate::parallel::row_bands`].

use super::Rect;

pub(super) struct Converted {
    pub changed: bool,
    pub opaque: bool,
}

const PARALLEL_MIN_PIXELS: usize = 1 << 20;

pub(super) fn region_cached(
    dst: &mut [u8],
    dst_width: u32,
    src: &[u8],
    src_stride: usize,
    region: Rect,
) -> Converted {
    let dst_stride = dst_width as usize * 4;
    let start = region.x as usize * 4;
    let bytes = region.w as usize * 4;
    let rows = region.h as usize;
    let region_rows = &mut dst[region.y as usize * dst_stride..][..rows * dst_stride];
    let src_base = region.y as usize * src_stride;
    let (changed, alpha) = crate::parallel::row_bands(
        region_rows,
        dst_stride,
        rows,
        PARALLEL_MIN_PIXELS,
        |band, first, count| {
            let mut changed = false;
            let mut alpha = 0xFF;
            for r in 0..count {
                let source = &src[src_base + (first + r) * src_stride + start..][..bytes];
                let target = &mut band[r * dst_stride + start..][..bytes];
                if changed {
                    alpha &= row(source, target);
                } else {
                    let (row_changed, row_alpha) = row_checked(source, target);
                    changed = row_changed;
                    alpha &= row_alpha;
                }
            }
            (changed, alpha)
        },
        |(c1, a1), (c2, a2)| (c1 | c2, a1 & a2),
    )
    .unwrap_or((false, 0xFF));
    Converted {
        changed,
        opaque: alpha == 0xFF,
    }
}

/// Returns whether every converted pixel was opaque.
pub(super) fn region_uncached(
    dst: &mut [u8],
    dst_width: u32,
    src: &[u8],
    src_stride: usize,
    region: Rect,
) -> bool {
    let dst_stride = dst_width as usize * 4;
    let start = region.x as usize * 4;
    let bytes = region.w as usize * 4;
    let rows = region.h as usize;
    let region_rows = &mut dst[region.y as usize * dst_stride..][..rows * dst_stride];
    let src_base = region.y as usize * src_stride;
    let alpha = crate::parallel::row_bands(
        region_rows,
        dst_stride,
        rows,
        PARALLEL_MIN_PIXELS,
        |band, first, count| {
            let mut alpha = 0xFF;
            for r in 0..count {
                let source = &src[src_base + (first + r) * src_stride + start..][..bytes];
                let target = &mut band[r * dst_stride + start..][..bytes];
                alpha &= row_uncached(source, target);
            }
            alpha
        },
        |a, b| a & b,
    )
    .unwrap_or(0xFF);
    alpha == 0xFF
}

fn row(source: &[u8], target: &mut [u8]) -> u8 {
    let mut alpha = 0xFF;
    for (source, target) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
        target[0] = source[2];
        target[1] = source[1];
        target[2] = source[0];
        target[3] = source[3];
        alpha &= source[3];
    }
    alpha
}

fn row_checked(source: &[u8], target: &mut [u8]) -> (bool, u8) {
    let mut changed = false;
    let mut alpha = 0xFF;
    for (source, target) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
        let next = [source[2], source[1], source[0], source[3]];
        changed |= *target != next;
        target.copy_from_slice(&next);
        alpha &= source[3];
    }
    (changed, alpha)
}

fn row_uncached(source: &[u8], target: &mut [u8]) -> u8 {
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("sse4.1") {
        // SAFETY: sse4.1 presence was just checked.
        #[allow(unsafe_code)]
        return unsafe { row_uncached_sse41(source, target) };
    }
    // Without streaming loads, bulk-copy the row out of the slow mapping
    // first; a sequential copy is the only read it serves tolerably.
    let mut scratch = vec![0u8; source.len()];
    scratch.copy_from_slice(source);
    row(&scratch, target)
}

/// Streaming-load swizzle of one row. MOVNTDQA requires 16-byte-aligned
/// addresses; the head loop walks up to alignment and the tail loop finishes
/// the remainder. When the row is not even pixel-aligned to the mapping
/// (an odd damage x), the whole row falls back to unaligned vector loads.
/// Returns the AND of every alpha byte.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "sse4.1")]
#[allow(unsafe_code)]
unsafe fn row_uncached_sse41(source: &[u8], target: &mut [u8]) -> u8 {
    use std::arch::x86_64::{
        __m128i, _mm_and_si128, _mm_extract_epi8, _mm_loadu_si128, _mm_set1_epi8, _mm_setr_epi8,
        _mm_shuffle_epi8, _mm_storeu_si128, _mm_stream_load_si128,
    };
    let len = source.len();
    let sp = source.as_ptr();
    let dp = target.as_mut_ptr();
    // BGRA -> RGBA within each pixel; alpha stays in byte 3 of each lane.
    // SAFETY: register work plus in-bounds pointer arithmetic; every loop
    // below stays within `len`, and head/tail cover what the vectors skip.
    unsafe {
        let shuffle = _mm_setr_epi8(2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15);
        let alpha_lanes = |acc: __m128i| {
            (_mm_extract_epi8(acc, 3)
                & _mm_extract_epi8(acc, 7)
                & _mm_extract_epi8(acc, 11)
                & _mm_extract_epi8(acc, 15)) as u8
        };
        let mut alpha_acc = _mm_set1_epi8(-1);
        let mut alpha = 0xFFu8;
        let head = ((16usize.wrapping_sub(sp as usize & 15)) & 15).min(len);
        if head % 4 != 0 {
            let mut j = 0;
            while j + 16 <= len {
                let v = _mm_loadu_si128(sp.add(j).cast::<__m128i>());
                alpha_acc = _mm_and_si128(alpha_acc, v);
                _mm_storeu_si128(dp.add(j).cast::<__m128i>(), _mm_shuffle_epi8(v, shuffle));
                j += 16;
            }
            while j + 4 <= len {
                let px = sp.add(j);
                *dp.add(j) = *px.add(2);
                *dp.add(j + 1) = *px.add(1);
                *dp.add(j + 2) = *px.add(0);
                *dp.add(j + 3) = *px.add(3);
                alpha &= *px.add(3);
                j += 4;
            }
            return alpha & alpha_lanes(alpha_acc);
        }
        let mut i = 0;
        while i < head {
            let px = sp.add(i);
            *dp.add(i) = *px.add(2);
            *dp.add(i + 1) = *px.add(1);
            *dp.add(i + 2) = *px.add(0);
            *dp.add(i + 3) = *px.add(3);
            alpha &= *px.add(3);
            i += 4;
        }
        while i + 64 <= len {
            let a = _mm_stream_load_si128(sp.add(i).cast::<__m128i>());
            let b = _mm_stream_load_si128(sp.add(i + 16).cast::<__m128i>());
            let c = _mm_stream_load_si128(sp.add(i + 32).cast::<__m128i>());
            let d = _mm_stream_load_si128(sp.add(i + 48).cast::<__m128i>());
            alpha_acc =
                _mm_and_si128(alpha_acc, _mm_and_si128(_mm_and_si128(a, b), _mm_and_si128(c, d)));
            _mm_storeu_si128(dp.add(i).cast::<__m128i>(), _mm_shuffle_epi8(a, shuffle));
            _mm_storeu_si128(dp.add(i + 16).cast::<__m128i>(), _mm_shuffle_epi8(b, shuffle));
            _mm_storeu_si128(dp.add(i + 32).cast::<__m128i>(), _mm_shuffle_epi8(c, shuffle));
            _mm_storeu_si128(dp.add(i + 48).cast::<__m128i>(), _mm_shuffle_epi8(d, shuffle));
            i += 64;
        }
        while i + 16 <= len {
            let v = _mm_stream_load_si128(sp.add(i).cast::<__m128i>());
            alpha_acc = _mm_and_si128(alpha_acc, v);
            _mm_storeu_si128(dp.add(i).cast::<__m128i>(), _mm_shuffle_epi8(v, shuffle));
            i += 16;
        }
        while i + 4 <= len {
            let px = sp.add(i);
            *dp.add(i) = *px.add(2);
            *dp.add(i + 1) = *px.add(1);
            *dp.add(i + 2) = *px.add(0);
            *dp.add(i + 3) = *px.add(3);
            alpha &= *px.add(3);
            i += 4;
        }
        alpha & alpha_lanes(alpha_acc)
    }
}
