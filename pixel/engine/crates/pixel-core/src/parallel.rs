pub fn row_bands<R: Send>(
    dst: &mut [u8],
    dst_stride: usize,
    rows: usize,
    row_pixels: usize,
    min_pixels: usize,
    work: impl Fn(&mut [u8], usize, usize) -> R + Sync,
    reduce: impl Fn(R, R) -> R,
) -> Option<R> {
    if rows == 0 {
        return None;
    }
    debug_assert!(dst.len() >= rows * dst_stride);
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get().min(MAX_WORKERS));
    if rows * row_pixels < min_pixels || workers < 2 {
        return Some(work(dst, 0, rows));
    }
    let band = rows.div_ceil(workers);
    let results = std::sync::Mutex::new(Vec::new());
    rayon::in_place_scope(|scope| {
        let mut rest = dst;
        let mut first = 0;
        while first < rows {
            let band_rows = band.min(rows - first);
            let take = (band_rows * dst_stride).min(rest.len());
            let (chunk, tail) = rest.split_at_mut(take);
            rest = tail;
            let work = &work;
            let results = &results;
            scope.spawn(move |_| {
                let result = work(chunk, first, band_rows);
                results.lock().unwrap_or_else(|e| e.into_inner()).push(result);
            });
            first += band_rows;
        }
    });
    results
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .into_iter()
        .reduce(reduce)
}

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
            stride / 4,
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
    fn a_thin_tall_region_in_a_wide_buffer_stays_on_one_thread_and_still_reduces() {
        let stride = 8000;
        let rows = 900;
        let mut dst = vec![0u8; rows * stride];
        let threads = std::sync::Mutex::new(std::collections::HashSet::new());
        let sum = row_bands(&mut dst, stride, rows, 10, 1 << 20, |_, _, count| { threads.lock().unwrap().insert(std::thread::current().id()); count }, |a, b| a + b);
        assert_eq!(threads.lock().unwrap().len(), 1, "9000 pixels of work is not worth a hand-off");
        assert_eq!(sum, Some(rows));
    }
}
