#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(crate) use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::*;

fn swap_bgra_into(target: &mut [u8], source: &[u8]) {
    use rayon::prelude::*;
    target
        .par_chunks_mut(1 << 16)
        .zip(source.par_chunks(1 << 16))
        .for_each(|(target, source)| {
            for (t, s) in target.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                t[0] = s[2];
                t[1] = s[1];
                t[2] = s[0];
                t[3] = s[3];
            }
        });
}
