use super::{Rect, RowChange};

const PARALLEL_MIN_PIXELS: usize = 4 << 20;


pub(super) fn region(
    dst: &mut [u8],
    dst_width: u32,
    src: &[u8],
    src_stride: usize,
    region: Rect,
) {
    let dst_stride = dst_width as usize * 4;
    let start = region.x as usize * 4;
    let bytes = region.w as usize * 4;
    let rows = region.h as usize;
    let region_rows = &mut dst[region.y as usize * dst_stride..][..rows * dst_stride];
    let src_base = region.y as usize * src_stride;
    crate::parallel::row_bands(
        region_rows,
        dst_stride,
        rows,
        region.w as usize,
        PARALLEL_MIN_PIXELS,
        |band, first, count| {
            for r in 0..count {
                let source = &src[src_base + (first + r) * src_stride + start..][..bytes];
                let target = &mut band[r * dst_stride..][..dst_stride];
                target[start..start + bytes].copy_from_slice(source);
            }
        },
        |(), ()| (),
    );
}


pub(super) fn region_tight(
    dst: &mut [u8],
    dst_width: u32,
    src: &[u8],
    src_stride: usize,
    region: Rect,
) -> Vec<Rect> {
    let dst_stride = dst_width as usize * 4;
    let start = region.x as usize * 4;
    let bytes = region.w as usize * 4;
    let mut changes = Vec::new();
    for r in 0..region.h as usize {
        let y = region.y as usize + r;
        let src_row = &src[y * src_stride..][..dst_stride.min(src_stride)];
        let dst_row = &mut dst[y * dst_stride..][..dst_stride];
        if let Some((x0, x1)) = row_diff(&src_row[start..start + bytes], &mut dst_row[start..start + bytes]) {
            changes.push(RowChange {
                y: y as u32,
                x0: region.x + x0,
                x1: region.x + x1,
            });
        }
    }
    super::rects_from_rows(changes)
}

fn row_diff(source: &[u8], target: &mut [u8]) -> Option<(u32, u32)> {
    if source == target {
        return None;
    }
    let first = first_mismatch(source, target) / 4;
    let last = last_mismatch(source, target) / 4;
    target[first * 4..(last + 1) * 4].copy_from_slice(&source[first * 4..(last + 1) * 4]);
    Some((first as u32, last as u32 + 1))
}

const SCAN_BLOCK: usize = 64;

fn first_mismatch(a: &[u8], b: &[u8]) -> usize {
    let blocks = a.len() / SCAN_BLOCK;
    let block = (0..blocks)
    // compiles into a memcmp
        .find(|&i| a[i * SCAN_BLOCK..(i + 1) * SCAN_BLOCK] != b[i * SCAN_BLOCK..(i + 1) * SCAN_BLOCK])
        .unwrap_or(blocks);
    let start = block * SCAN_BLOCK;
    start + (start..a.len()).position(|i| a[i] != b[i]).expect("slices differ")
}

fn last_mismatch(a: &[u8], b: &[u8]) -> usize {
    let blocks = a.len() / SCAN_BLOCK;
    let tail = blocks * SCAN_BLOCK;
    if a[tail..] != b[tail..] {
        return (tail..a.len()).rev().find(|&i| a[i] != b[i]).expect("slices differ");
    }
    let block = (0..blocks)
        .rev()
        .find(|&i| a[i * SCAN_BLOCK..(i + 1) * SCAN_BLOCK] != b[i * SCAN_BLOCK..(i + 1) * SCAN_BLOCK])
        .expect("slices differ");
    (block * SCAN_BLOCK..(block + 1) * SCAN_BLOCK).rev().find(|&i| a[i] != b[i]).expect("slices differ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_diff_finds_the_exact_changed_span_wherever_it_sits() {
        for width in [3usize, 16, 63, 64, 65, 640, 2560] {
            for (from, to) in [(0usize, 1usize), (width - 1, width), (width / 2, width / 2 + 1), (5.min(width - 1), width), (0, width)] {
                let source: Vec<u8> = (0..width * 4).map(|i| (i % 251) as u8).collect();
                let mut target = source.clone();
                for px in from..to {
                    target[px * 4] ^= 0x80;
                }
                let mut copy = target.clone();
                assert_eq!(row_diff(&source, &mut copy), Some((from as u32, to as u32)), "width {width} span {from}..{to}");
                assert_eq!(copy, source, "the changed span was copied into place");
                let mut same = source.clone();
                assert_eq!(row_diff(&source, &mut same), None);
            }
        }
    }
}
