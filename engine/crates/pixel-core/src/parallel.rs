//! Row-band parallelism for full-frame pixel passes.
//!
//! Every heavy pass in the pipeline (surface conversion, blits, compose)
//! walks rows of one destination buffer. Rows are independent, so a pass
//! splits into contiguous bands handed to a few threads. This is the only
//! place that splitting lives; callers describe one band and get the
//! fan-out, the small-work serial path, and the result reduction for free.

/// Runs `work` over `rows` rows of `dst`, split into at most [`MAX_WORKERS`]
/// bands when the area crosses `min_pixels`. `work` receives the band's rows
/// (a contiguous `&mut` slice of `dst`), the absolute index of its first row,
/// and its row count; per-band results are folded with `reduce`.
pub fn row_bands<R: Send>(
    dst: &mut [u8],
    dst_stride: usize,
    rows: usize,
    min_pixels: usize,
    work: impl Fn(&mut [u8], usize, usize) -> R + Sync,
    reduce: impl Fn(R, R) -> R,
) -> Option<R> {
    if rows == 0 {
        return None;
    }
    debug_assert!(dst.len() >= rows * dst_stride);
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get().min(MAX_WORKERS));
    if rows * dst_stride / 4 < min_pixels || workers < 2 {
        return Some(work(dst, 0, rows));
    }
    let band = rows.div_ceil(workers);
    let results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        let mut rest = dst;
        let mut first = 0;
        while first < rows {
            let band_rows = band.min(rows - first);
            let take = (band_rows * dst_stride).min(rest.len());
            let (chunk, tail) = rest.split_at_mut(take);
            rest = tail;
            let work = &work;
            handles.push(scope.spawn(move || work(chunk, first, band_rows)));
            first += band_rows;
        }
        handles
            .into_iter()
            .map(|h| h.join().expect("row band panicked"))
            .collect::<Vec<_>>()
    });
    results.into_iter().reduce(reduce)
}

/// Bands beyond this bring no return: full-frame passes are memory-bound and
/// a few streams already saturate the bus.
const MAX_WORKERS: usize = 6;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_cover_every_row_exactly_once() {
        let stride = 16;
        let rows = 1000;
        let mut dst = vec![0u8; rows * stride];
        row_bands(
            &mut dst,
            stride,
            rows,
            0,
            |band, first, count| {
                for r in 0..count {
                    band[r * stride..(r + 1) * stride].fill(1);
                    band[r * stride] = (first + r) as u8;
                }
                count
            },
            |a, b| a + b,
        );
        assert!(dst.iter().enumerate().all(|(i, &b)| {
            let row = i / stride;
            if i % stride == 0 { b == row as u8 } else { b == 1 }
        }));
    }

    #[test]
    fn small_work_stays_on_one_thread_and_reduces() {
        let stride = 4;
        let mut dst = vec![0u8; 4 * stride];
        let sum = row_bands(&mut dst, stride, 4, usize::MAX, |_, _, count| count, |a, b| a + b);
        assert_eq!(sum, Some(4));
    }
}
