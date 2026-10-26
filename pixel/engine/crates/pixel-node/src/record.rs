use std::fs;
use std::io::BufWriter;
use std::path::Path;

use mp4::{AvcConfig, MediaConfig, Mp4Config, Mp4Sample, Mp4Writer, TrackConfig, TrackType};
use openh264::OpenH264API;
use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, QpRange, UsageType,
};
use openh264::formats::YUVSource;
use pixel_core::{Canvas, PathCmd, build_path, fontdue, measure_text};
use serde::Deserialize;

struct Yuv420 {
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
    width: usize,
    height: usize,
}

impl Yuv420 {
    fn new(width: usize, height: usize) -> Self {
        Self {
            y: vec![16; width * height],
            u: vec![128; (width / 2) * (height / 2)],
            v: vec![128; (width / 2) * (height / 2)],
            width,
            height,
        }
    }

    fn read_rgba(&mut self, rgba: &[u8]) {
        let width = self.width;
        for (row, y_row) in rgba
            .chunks_exact(width * 4)
            .zip(self.y.chunks_exact_mut(width))
        {
            for (px, y) in row.chunks_exact(4).zip(y_row.iter_mut()) {
                let (r, g, b) = (u32::from(px[0]), u32::from(px[1]), u32::from(px[2]));
                *y = (((66 * r + 129 * g + 25 * b) >> 8) + 16) as u8;
            }
        }
        let half_width = width / 2;
        let mut rows = rgba.chunks_exact(width * 4 * 2);
        let u_rows = self.u.chunks_exact_mut(half_width);
        let v_rows = self.v.chunks_exact_mut(half_width);
        for ((pair, u_row), v_row) in (&mut rows).zip(u_rows).zip(v_rows) {
            let (top, bottom) = pair.split_at(width * 4);
            for (((p0, p1), u), v) in top
                .chunks_exact(8)
                .zip(bottom.chunks_exact(8))
                .zip(u_row.iter_mut())
                .zip(v_row.iter_mut())
            {
                let r = (i32::from(p0[0]) + i32::from(p0[4]) + i32::from(p1[0]) + i32::from(p1[4]) + 2) / 4;
                let g = (i32::from(p0[1]) + i32::from(p0[5]) + i32::from(p1[1]) + i32::from(p1[5]) + 2) / 4;
                let b = (i32::from(p0[2]) + i32::from(p0[6]) + i32::from(p1[2]) + i32::from(p1[6]) + 2) / 4;
                *u = (((-38 * r - 74 * g + 112 * b) >> 8) + 128) as u8;
                *v = (((112 * r - 94 * g - 18 * b) >> 8) + 128) as u8;
            }
        }
    }
}

impl YUVSource for Yuv420 {
    fn dimensions(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    fn strides(&self) -> (usize, usize, usize) {
        (self.width, self.width / 2, self.width / 2)
    }

    fn y(&self) -> &[u8] {
        &self.y
    }

    fn u(&self) -> &[u8] {
        &self.u
    }

    fn v(&self) -> &[u8] {
        &self.v
    }
}

const BITRATE_BPS_AT_30FPS: f32 = 2_500_000.0;
const CLICK_PULSE_MS: u64 = 450;
const CURSOR_LERP_MAX_MS: u64 = 200;
const LINK_HOLD_MS: u64 = 2500;
const TOAST_FADE_MS: u64 = 300;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    video_out: String,
    crops_dir: String,
    #[serde(default)]
    keyframes_dir: String,
    capture_dir: String,
    duration_ms: u64,
    font_file: String,
    markup: Vec<FrameMarkup>,
    crops: Vec<CropRef>,
    #[serde(default)]
    pointer: Vec<TimedPoint>,
    #[serde(default)]
    clicks: Vec<TimedPoint>,
    #[serde(default)]
    links: Vec<TimedLink>,
    #[serde(default)]
    shots: Vec<ShotRef>,
    #[serde(default)]
    region: Option<RectJson>,
    #[serde(default)]
    trim: Option<TrimJson>,
    #[serde(default)]
    stage: Option<String>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct TrimJson {
    start_ms: u64,
    end_ms: u64,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct TimedPoint {
    t_ms: u64,
    x: f32,
    y: f32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TimedLink {
    t_ms: u64,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShotRef {
    frame: usize,
    t_ms: u64,
    file: String,
    url: String,
    taken_at: String,
    #[serde(default)]
    crop: Option<RectJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameMarkup {
    at_ms: u64,
    until_ms: u64,
    objects: Vec<Markup>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Markup {
    Pen {
        points: Vec<Vec2>,
        color: String,
        width: f32,
    },
    Arrow {
        from: Vec2,
        to: Vec2,
        color: String,
        width: f32,
    },
    Oval {
        rect: RectJson,
        color: String,
        width: f32,
    },
    Text {
        text: String,
        pos: Vec2,
        #[serde(rename = "fontPx")]
        font_px: f32,
        color: String,
    },
}

#[derive(Deserialize, Clone, Copy)]
struct Vec2 {
    x: f32,
    y: f32,
}

#[derive(Deserialize, Clone, Copy)]
struct RectJson {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CropRef {
    frame: usize,
    t_ms: u64,
    file: String,
    rect: RectJson,
}

pub fn run(job_json: &str, progress: &(dyn Fn(f64) + Sync)) -> Result<(), String> {
    let job: Job = serde_json::from_str(job_json).map_err(|e| format!("bad job: {e}"))?;
    let mut source = FrameSource::open(&job)?;
    if source.times.is_empty() {
        return Err("no frames".into());
    }
    let font_bytes = fs::read(&job.font_file).map_err(|e| format!("font: {e}"))?;

    let font = pixel_core::fonts::Font::single(
        fontdue::Font::from_bytes(font_bytes, fontdue::FontSettings::default()).map_err(|e| format!("font: {e}"))?,
    );
    if job.stage.as_deref() != Some("video") {
        write_crops(&job, &mut source, &font)?;
        write_keyframes(&job, &mut source, &font)?;
    }
    if job.stage.as_deref() != Some("stills") {
        // now we do the video shmeet, interesting
        encode_video(&job, &mut source, &font, progress)?;
        progress(100.0);
    }
    Ok(())
}

struct FrameSource {
    segment: crate::capture::Segment,
    times: Vec<u64>,
    cache: Option<(usize, Vec<u8>, u32, u32)>,
}

impl FrameSource {
    fn open(job: &Job) -> Result<Self, String> {
        let segment = crate::capture::Segment::open(Path::new(&job.capture_dir))
            .map_err(|e| format!("{}: {e}", job.capture_dir))?;
        let times = segment
            .metas()
            .iter()
            .map(|meta| (meta.t_us + 500) / 1000)
            .collect();
        Ok(Self {
            segment,
            times,
            cache: None,
        })
    }

    fn display_frame(&mut self, job: &Job, index: usize) -> Result<(&[u8], u32, u32), String> {
        if self.cache.as_ref().map(|(at, ..)| *at) != Some(index) {
            let (bgra, width, height) = self
                .segment
                .frame(index)
                .map_err(|e| format!("frame {index}: {e}"))?;
            let mut rgba = self.cache.take().map(|(_, buffer, ..)| buffer).unwrap_or_default();
            rgba.resize(bgra.len(), 0);
            for (out, px) in rgba.chunks_exact_mut(4).zip(bgra.chunks_exact(4)) {
                out.copy_from_slice(&[px[2], px[1], px[0], 255]);
            }
            let decoded = match &job.region {
                Some(region) => crop_region(rgba, width, height, region),
                None => (rgba, width, height),
            };
            self.cache = Some((index, decoded.0, decoded.1, decoded.2));
        }
        let (_, rgba, width, height) = self.cache.as_ref().unwrap();
        Ok((rgba.as_slice(), *width, *height))
    }
}

fn build_samples(job: &Job, frame_times: &[u64]) -> Vec<(u64, usize)> {
    let step = 33u64;
    let mut times: std::collections::BTreeSet<u64> = frame_times.iter().copied().collect();
    times.insert(0);
    for pair in job.pointer.windows(2) {
        times.insert(pair[0].t_ms);
        let span = pair[1].t_ms.saturating_sub(pair[0].t_ms);
        if span <= CURSOR_LERP_MAX_MS {
            let mut t = pair[0].t_ms + step;
            while t < pair[1].t_ms {
                times.insert(t);
                t += step;
            }
        }
    }
    if let Some(last) = job.pointer.last() {
        times.insert(last.t_ms);
    }
    for click in &job.clicks {
        let mut t = click.t_ms;
        while t < click.t_ms + CLICK_PULSE_MS {
            times.insert(t);
            t += step;
        }
        times.insert(click.t_ms + CLICK_PULSE_MS);
    }
    for m in &job.markup {
        times.insert(m.at_ms);
        times.insert(m.until_ms);
    }
    for link in &job.links {
        times.insert(link.t_ms);
        let mut t = link.t_ms + LINK_HOLD_MS - TOAST_FADE_MS;
        while t < link.t_ms + LINK_HOLD_MS {
            times.insert(t);
            t += step;
        }
        times.insert(link.t_ms + LINK_HOLD_MS);
    }
    times
        .into_iter()
        .filter(|&t| t <= job.duration_ms)
        .map(|t| (t, frame_at(frame_times, t)))
        .collect()
}

fn trimmed_frames(times: &[u64], trim: Option<TrimJson>) -> (Vec<u64>, Vec<usize>) {
    let Some(trim) = trim else {
        return (times.to_vec(), (0..times.len()).collect());
    };
    let mut shifted = vec![0];
    let mut segment = vec![frame_at(times, trim.start_ms)];
    for (i, &t) in times.iter().enumerate() {
        if t > trim.start_ms && t <= trim.end_ms {
            shifted.push(t - trim.start_ms);
            segment.push(i);
        }
    }
    (shifted, segment)
}

enum Step {
    Fresh(Box<Yuv420>, u64, u32),
    Hold(u64, u32),
}

fn encode_video(
    job: &Job,
    source: &mut FrameSource,
    font: &pixel_core::fonts::Font,
    progress: &(dyn Fn(f64) + Sync),
) -> Result<(), String> {
    let (base_w, base_h) = {
        let (_, width, height) = source.display_frame(job, 0)?;
        (width, height)
    };
    let out_w = base_w + base_w % 2;
    let out_h = base_h + base_h % 2;
    let (frame_times, segment_index) = trimmed_frames(&source.times, job.trim);
    let samples = build_samples(job, &frame_times);
    let rate = typical_rate_hz(&samples);
    let bitrate = (BITRATE_BPS_AT_30FPS * (rate / 30.0).max(1.0)) as u32; // hm

    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate))
        .max_frame_rate(FrameRate::from_hz(rate.max(30.0)))
        .usage_type(UsageType::ScreenContentRealTime)
        .skip_frames(false)
        .qp(QpRange::new(0, 28))
        .intra_frame_period(IntraFramePeriod::from_num_frames(120));
    let mut encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
        .map_err(|e| format!("encoder: {e}"))?;

    let file = fs::File::create(&job.video_out).map_err(|e| format!("{}: {e}", job.video_out))?;
    let brand = |s: &str| s.parse::<mp4::FourCC>().unwrap();
    let mut writer = Mp4Writer::write_start(
        BufWriter::new(file),
        &Mp4Config {
            major_brand: brand("isom"),
            minor_version: 512,
            compatible_brands: vec![brand("isom"), brand("iso2"), brand("avc1"), brand("mp41")],
            timescale: 1000,
        },
    )
    .map_err(|e| format!("mp4: {e}"))?;

    let (step_tx, step_rx) = std::sync::mpsc::sync_channel::<Step>(2);
    let (pool_tx, pool_rx) = std::sync::mpsc::channel::<Box<Yuv420>>();
    for _ in 0..3 {
        let _ = pool_tx.send(Box::new(Yuv420::new(out_w as usize, out_h as usize)));
    }
    let total = samples.len().max(1);

    std::thread::scope(|scope| -> Result<(), String> {
        let encode_thread = scope.spawn(move || -> Result<(), String> {
            let mut current: Option<Box<Yuv420>> = None;
            let mut track_added = false;
            let mut annexb = Vec::new();
            let mut done = 0usize;
            let mut last_percent = 0.0;
            for step in step_rx {
                let (t_ms, duration) = match &step {
                    Step::Fresh(_, t_ms, duration) | Step::Hold(t_ms, duration) => (*t_ms, *duration),
                };
                if let Step::Fresh(fresh, ..) = step {
                    if let Some(spent) = current.replace(fresh) {
                        let _ = pool_tx.send(spent);
                    }
                }
                let yuv = current.as_deref().ok_or("first sample carried no pixels")?;
                let bitstream = encoder.encode(yuv).map_err(|e| format!("encode: {e}"))?;
                annexb.clear();
                bitstream.write_vec(&mut annexb);
                let nals = nal_units(&annexb);
                if !track_added {
                    let sps = nals
                        .iter()
                        .find(|n| nal_type(n) == 7)
                        .ok_or("encoder produced no SPS")?;
                    let pps = nals
                        .iter()
                        .find(|n| nal_type(n) == 8)
                        .ok_or("encoder produced no PPS")?;
                    writer
                        .add_track(&TrackConfig {
                            track_type: TrackType::Video,
                            timescale: 1000,
                            language: "und".into(),
                            media_conf: MediaConfig::AvcConfig(AvcConfig {
                                width: out_w as u16,
                                height: out_h as u16,
                                seq_param_set: sps.to_vec(),
                                pic_param_set: pps.to_vec(),
                            }),
                        })
                        .map_err(|e| format!("mp4 track: {e}"))?;
                    track_added = true;
                }
                writer
                    .write_sample(
                        1,
                        &Mp4Sample {
                            start_time: t_ms,
                            duration,
                            rendering_offset: 0,
                            is_sync: matches!(bitstream.frame_type(), FrameType::IDR | FrameType::I),
                            bytes: avcc_sample(&nals).into(),
                        },
                    )
                    .map_err(|e| format!("mp4 sample: {e}"))?;
                done += 1;
                let percent = (done as f64 / total as f64 * 97.0).floor();
                if percent > last_percent {
                    last_percent = percent;
                    progress(percent);
                }
            }
            writer.write_end().map_err(|e| format!("mp4: {e}"))?;
            Ok(())
        });

        let mut prepared: Option<(usize, Vec<usize>, Overlay)> = None;
        let mut scratch: Vec<u8> = Vec::new();
        let mut boxed: Option<Canvas> = None;
        let produced = (|| -> Result<(), String> {
            for (at, &(t_ms, frame)) in samples.iter().enumerate() {
                let index = segment_index[frame];
                let next_t = samples
                    .get(at + 1)
                    .map_or(job.duration_ms.max(t_ms), |&(t, _)| t);
                let duration = next_t.saturating_sub(t_ms).max(1) as u32;
                let overlay = overlay_at(job, t_ms);
                let active: Vec<usize> = job
                    .markup
                    .iter()
                    .enumerate()
                    .filter(|(_, m)| m.at_ms <= t_ms && t_ms < m.until_ms)
                    .map(|(i, _)| i)
                    .collect();
                let changed = prepared
                    .as_ref()
                    .is_none_or(|(i, a, o)| *i != index || *a != active || *o != overlay);
                let step = if changed {
                    let (rgba, frame_w, frame_h) = source.display_frame(job, index)?;
                    scratch.resize(rgba.len(), 0);
                    scratch.copy_from_slice(rgba);
                    let mut canvas = Canvas::from_rgba(std::mem::take(&mut scratch), frame_w, frame_h);
                    for at in &active {
                        composite(&mut canvas, &job.markup[*at].objects, font);
                    }
                    draw_overlay(&mut canvas, &overlay, job, font);
                    let Ok(mut yuv) = pool_rx.recv() else {
                        break; // the encode thread died; the join below carries the real error
                    };
                    if canvas.width == out_w && canvas.height == out_h {
                        yuv.read_rgba(&canvas.pixels);
                    } else {
                        let out = boxed.get_or_insert_with(|| {
                            let mut out = Canvas::new(out_w, out_h);
                            out.fill([0, 0, 0, 255]);
                            out
                        });
                        letterbox(&canvas, out);
                        yuv.read_rgba(&out.pixels);
                    }
                    scratch = canvas.pixels;
                    prepared = Some((index, active, overlay));
                    Step::Fresh(yuv, t_ms, duration)
                } else {
                    Step::Hold(t_ms, duration)
                };
                if step_tx.send(step).is_err() {
                    break;
                }
            }
            Ok(())
        })();
        drop(step_tx);
        let encoded = encode_thread
            .join()
            .map_err(|_| "encode thread panicked".to_string())?;
        produced.and(encoded)
    })
}

fn write_crops(job: &Job, source: &mut FrameSource, font: &pixel_core::fonts::Font) -> Result<(), String> {
    if job.crops.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&job.crops_dir).map_err(|e| format!("{}: {e}", job.crops_dir))?;
    for crop in &job.crops {
        let (rgba, width, height) = source.display_frame(job, crop.frame)?;
        let mut canvas = Canvas::from_rgba(rgba.to_vec(), width, height);
        for m in &job.markup {
            if m.at_ms <= crop.t_ms && crop.t_ms < m.until_ms {
                composite(&mut canvas, &m.objects, font);
            }
        }
        let (out, w, h) = crop_region(std::mem::take(&mut canvas.pixels), width, height, &crop.rect);
        write_png(Path::new(&crop.file), &out, w, h)?;
    }
    Ok(())
}

#[derive(Clone, PartialEq)]
struct Overlay {
    cursor: Option<(f32, f32)>,
    pulses: Vec<(f32, f32, f32)>,
    link: Option<(usize, f32)>,
}

fn overlay_at(job: &Job, t_ms: u64) -> Overlay {
    let first_live = job
        .clicks
        .partition_point(|c| c.t_ms + CLICK_PULSE_MS <= t_ms);
    let pulses = job.clicks[first_live..]
        .iter()
        .take_while(|c| c.t_ms <= t_ms)
        .map(|c| (c.x, c.y, (t_ms - c.t_ms) as f32 / CLICK_PULSE_MS as f32))
        .collect();
    let link_idx = job.links.partition_point(|l| l.t_ms <= t_ms);
    let link = match link_idx.checked_sub(1) {
        Some(i) if t_ms < job.links[i].t_ms + LINK_HOLD_MS => {
            let left = job.links[i].t_ms + LINK_HOLD_MS - t_ms;
            Some((i, (left as f32 / TOAST_FADE_MS as f32).min(1.0)))
        }
        _ => None,
    };
    Overlay {
        cursor: cursor_at(&job.pointer, t_ms),
        pulses,
        link,
    }
}

fn cursor_at(pointer: &[TimedPoint], t_ms: u64) -> Option<(f32, f32)> {
    let idx = pointer.partition_point(|p| p.t_ms <= t_ms);
    if idx == 0 {
        return None;
    }
    let prev = pointer[idx - 1];
    if let Some(next) = pointer.get(idx) {
        let span = next.t_ms - prev.t_ms;
        if span > 0 && span <= CURSOR_LERP_MAX_MS {
            let f = (t_ms - prev.t_ms) as f32 / span as f32;
            return Some((prev.x + (next.x - prev.x) * f, prev.y + (next.y - prev.y) * f));
        }
    }
    Some((prev.x, prev.y))
}

fn draw_overlay(canvas: &mut Canvas, overlay: &Overlay, job: &Job, font: &pixel_core::fonts::Font) {
    let size = (canvas.height as f32 * 0.024).max(14.0);
    for &(x, y, progress) in &overlay.pulses {
        let radius = size * (0.55 + 1.35 * progress);
        let alpha = ((1.0 - progress) * 130.0) as u8;
        canvas.fill_rounded_rect(
            x - radius,
            y - radius,
            radius * 2.0,
            radius * 2.0,
            [radius; 4],
            [245, 165, 36, alpha],
        );
    }
    if let Some((x, y)) = overlay.cursor {
        let k = size / 14.5;
        let pts = [(6.5f32, 4.5f32), (18.0, 11.8), (12.6, 13.2), (10.2, 19.0)];
        let mut cmds: Vec<PathCmd> = pts
            .iter()
            .enumerate()
            .map(|(i, (px, py))| {
                let cx = x + (px - 6.5) * k;
                let cy = y + (py - 4.5) * k;
                if i == 0 {
                    PathCmd::MoveTo(cx, cy)
                } else {
                    PathCmd::LineTo(cx, cy)
                }
            })
            .collect();
        cmds.push(PathCmd::Close);
        if let Some(path) = build_path(&cmds) {
            canvas.stroke_path(&path, [255, 255, 255, 235], round_stroke((size * 0.16).max(1.5)));
            canvas.fill_path(&path, [15, 16, 20, 255]);
        }
    }
    if let Some((link, fade)) = overlay.link {
        draw_link_toast(canvas, &job.links[link].url, fade, font);
    }
}

fn fit_px(font: &pixel_core::fonts::Font, text: &str, base_px: f32, max_w: f32) -> f32 {
    let width = measure_text(font, text, base_px);
    if width > max_w {
        (base_px * max_w / width).max(8.0)
    } else {
        base_px
    }
}

fn draw_link_toast(canvas: &mut Canvas, url: &str, fade: f32, font: &pixel_core::fonts::Font) {
    let (w, h) = (canvas.width as f32, canvas.height as f32);
    let title_px = (h * 0.02).clamp(12.0, 26.0);
    let title = "link opened";
    let url_px = fit_px(font, url, title_px * 1.15, w * 0.86);
    let (Some(tm), Some(um)) = (
        font.horizontal_line_metrics(title_px),
        font.horizontal_line_metrics(url_px),
    ) else {
        return;
    };
    let pad = title_px * 0.9;
    let card_w = measure_text(font, url, url_px).max(measure_text(font, title, title_px)) + pad * 2.0;
    let title_h = tm.ascent - tm.descent;
    let url_h = um.ascent - um.descent;
    let gap = title_px * 0.3;
    let card_h = pad * 0.9 + title_h + gap + url_h + pad * 0.9;
    let x = (w - card_w) / 2.0;
    let y = title_px * 1.2;
    let a = |v: f32| (v * fade) as u8;
    let radius = [title_px * 0.5; 4];
    canvas.fill_rounded_rect(x, y, card_w, card_h, radius, [16, 18, 24, a(225.0)]);
    canvas.stroke_rounded_rect(x, y, card_w, card_h, radius, 1.0, [110, 168, 254, a(140.0)]);
    let title_baseline = y + pad * 0.9 + tm.ascent;
    canvas.draw_text(
        font,
        title,
        (x + pad) as i32,
        title_baseline as i32,
        title_px,
        [150, 160, 175, a(255.0)],
    );
    let url_baseline = title_baseline - tm.descent + gap + um.ascent;
    canvas.draw_text(
        font,
        url,
        (x + pad) as i32,
        url_baseline as i32,
        url_px,
        [235, 238, 245, a(255.0)],
    );
}

fn write_keyframes(job: &Job, source: &mut FrameSource, font: &pixel_core::fonts::Font) -> Result<(), String> {
    if job.shots.is_empty() || job.keyframes_dir.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&job.keyframes_dir).map_err(|e| format!("{}: {e}", job.keyframes_dir))?;
    for shot in &job.shots {
        let (rgba, w, h) = source.display_frame(job, shot.frame)?;
        let mut canvas = Canvas::from_rgba(rgba.to_vec(), w, h);
        for m in &job.markup {
            if m.at_ms <= shot.t_ms && shot.t_ms < m.until_ms {
                composite(&mut canvas, &m.objects, font);
            }
        }
        draw_overlay(&mut canvas, &overlay_at(job, shot.t_ms), job, font);
        let (pixels, w, h) = match &shot.crop {
            Some(crop) => crop_region(std::mem::take(&mut canvas.pixels), w, h, crop),
            None => (std::mem::take(&mut canvas.pixels), w, h),
        };

        let px = (h as f32 * 0.016).clamp(13.0, 26.0);
        let header_h = (px * 3.6).round() as u32;
        let mut out = Canvas::new(w, h + header_h);
        out.fill([14, 16, 21, 255]);
        let margin = px;
        let url_px = fit_px(font, &shot.url, px * 1.2, w as f32 - margin * 2.0);
        if let Some(um) = font.horizontal_line_metrics(url_px) {
            out.draw_text(
                font,
                &shot.url,
                margin as i32,
                (px * 0.55 + um.ascent) as i32,
                url_px,
                [235, 238, 245, 255],
            );
        }
        let meta = format!("t={}  ·  {}", fmt_clock(shot.t_ms), shot.taken_at);
        if let Some(mm) = font.horizontal_line_metrics(px) {
            out.draw_text(
                font,
                &meta,
                margin as i32,
                (px * 2.1 + mm.ascent) as i32,
                px,
                [150, 156, 168, 255],
            );
        }
        out.blit_opaque_rgba(0.0, header_h as f32, &pixels, w, h);
        write_png(Path::new(&shot.file), &out.pixels, w, h + header_h)?;
    }
    Ok(())
}

fn fmt_clock(t_ms: u64) -> String {
    let tenths = (t_ms % 1000) / 100;
    let total = t_ms / 1000;
    format!("{}:{:02}.{}", total / 60, total % 60, tenths)
}

fn composite(canvas: &mut Canvas, objects: &[Markup], font: &pixel_core::fonts::Font) {
    for object in objects {
        match object {
            Markup::Pen {
                points,
                color,
                width,
            } => {
                if let Some(path) = build_path(&pen_cmds(points)) {
                    canvas.stroke_path(&path, parse_color(color), round_stroke(*width));
                }
            }
            Markup::Arrow {
                from,
                to,
                color,
                width,
            } => {
                if let Some(path) = build_path(&arrow_cmds(*from, *to, *width)) {
                    canvas.stroke_path(&path, parse_color(color), round_stroke(*width));
                }
            }
            Markup::Oval { rect, color, width } => {
                if let Some(path) = build_path(&oval_cmds(rect)) {
                    canvas.stroke_path(&path, parse_color(color), round_stroke(*width));
                }
            }
            Markup::Text {
                text,
                pos,
                font_px,
                color,
            } => {
                let Some(metrics) = font.horizontal_line_metrics(*font_px) else {
                    continue;
                };
                if !text.is_empty() {
                    draw_text_scrim(canvas, text, *pos, *font_px, &metrics, font);
                }
                let mut baseline = pos.y + metrics.ascent;
                for line in text.split('\n') {
                    canvas.draw_text(font, line, pos.x as i32, baseline as i32, *font_px, parse_color(color));
                    baseline += metrics.new_line_size;
                }
            }
        }
    }
}

fn draw_text_scrim(
    canvas: &mut Canvas,
    text: &str,
    pos: Vec2,
    font_px: f32,
    metrics: &fontdue::LineMetrics,
    font: &pixel_core::fonts::Font,
) {
    let lines: Vec<&str> = text.split('\n').collect();
    let width = lines
        .iter()
        .map(|line| measure_text(font, line, font_px))
        .fold(0.0f32, f32::max);
    let height = (metrics.ascent - metrics.descent)
        + (lines.len().saturating_sub(1)) as f32 * metrics.new_line_size;
    let pad_x = font_px * 0.35;
    let pad_y = font_px * 0.25;
    let radius = [font_px * 0.3; 4];
    let (x, y) = (pos.x - pad_x, pos.y - pad_y);
    let (w, h) = (width + pad_x * 2.0, height + pad_y * 2.0);
    canvas.fill_rounded_rect(x, y, w, h, radius, [15, 17, 22, 255]);
    canvas.stroke_rounded_rect(x, y, w, h, radius, 1.0, [96, 102, 114, 255]);
}

fn pen_cmds(points: &[Vec2]) -> Vec<PathCmd> {
    let Some(first) = points.first() else {
        return Vec::new();
    };
    let mut cmds = vec![PathCmd::MoveTo(first.x, first.y)];
    if points.len() < 3 {
        if let Some(second) = points.get(1) {
            cmds.push(PathCmd::LineTo(second.x, second.y));
        }
        return cmds;
    }
    for i in 1..points.len() - 1 {
        let control = points[i];
        let next = points[i + 1];
        cmds.push(PathCmd::QuadTo(
            control.x,
            control.y,
            (control.x + next.x) / 2.0,
            (control.y + next.y) / 2.0,
        ));
    }
    let last = points[points.len() - 1];
    cmds.push(PathCmd::LineTo(last.x, last.y));
    cmds
}

fn arrow_cmds(from: Vec2, to: Vec2, width: f32) -> Vec<PathCmd> {
    let angle = (to.y - from.y).atan2(to.x - from.x);
    let length = (width * 3.5).max(10.0);
    let spread = 0.48f32;
    let mut cmds = vec![
        PathCmd::MoveTo(from.x, from.y),
        PathCmd::LineTo(to.x, to.y),
    ];
    for side in [-spread, spread] {
        cmds.push(PathCmd::MoveTo(to.x, to.y));
        cmds.push(PathCmd::LineTo(
            to.x - length * (angle + side).cos(),
            to.y - length * (angle + side).sin(),
        ));
    }
    cmds
}

fn oval_cmds(rect: &RectJson) -> Vec<PathCmd> {
    let rx = rect.width / 2.0;
    let ry = rect.height / 2.0;
    let cx = rect.x + rx;
    let cy = rect.y + ry;
    let k = 0.5523;
    vec![
        PathCmd::MoveTo(cx + rx, cy),
        PathCmd::CubicTo(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
        PathCmd::CubicTo(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
        PathCmd::CubicTo(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
        PathCmd::CubicTo(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
        PathCmd::Close,
    ]
}

fn round_stroke(width: f32) -> tiny_skia::Stroke {
    tiny_skia::Stroke {
        width: width.max(0.1),
        line_cap: tiny_skia::LineCap::Round,
        line_join: tiny_skia::LineJoin::Round,
        ..tiny_skia::Stroke::default()
    }
}

fn parse_color(color: &str) -> [u8; 4] {
    let hex = color.strip_prefix('#').unwrap_or(color);
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    [channel(0), channel(2), channel(4), 255]
}

fn frame_at(times: &[u64], t_ms: u64) -> usize {
    times.partition_point(|&t| t <= t_ms).max(1) - 1
}

fn typical_rate_hz(samples: &[(u64, usize)]) -> f32 {
    let mut deltas: Vec<u64> = samples
        .windows(2)
        .map(|pair| pair[1].0 - pair[0].0)
        .filter(|&delta| delta > 0)
        .collect();
    if deltas.is_empty() {
        return 30.0;
    }
    deltas.sort_unstable();
    (1000.0 / deltas[deltas.len() / 2] as f32).clamp(30.0, 240.0)
}

fn crop_region(rgba: Vec<u8>, width: u32, height: u32, region: &RectJson) -> (Vec<u8>, u32, u32) {
    let x = (region.x.max(0.0) as u32).min(width.saturating_sub(1));
    let y = (region.y.max(0.0) as u32).min(height.saturating_sub(1));
    let w = (region.width as u32).clamp(1, width - x);
    let h = (region.height as u32).clamp(1, height - y);
    if x == 0 && y == 0 && w == width && h == height {
        return (rgba, width, height);
    }
    let mut out = vec![0u8; (w * h * 4) as usize];
    for row in 0..h {
        let src = ((y + row) * width + x) as usize * 4;
        let dst = (row * w) as usize * 4;
        out[dst..dst + (w * 4) as usize].copy_from_slice(&rgba[src..src + (w * 4) as usize]);
    }
    (out, w, h)
}

fn letterbox(frame: &Canvas, out: &mut Canvas) {
    let (out_w, out_h) = (out.width, out.height);
    let scale = (out_w as f32 / frame.width as f32).min(out_h as f32 / frame.height as f32);
    let w = (frame.width as f32 * scale).round();
    let h = (frame.height as f32 * scale).round();
    let x = (out_w as f32 - w) / 2.0;
    let y = (out_h as f32 - h) / 2.0;
    let (left, top) = (x.floor() as u32, y.floor() as u32);
    let (right, bottom) = ((x + w).ceil() as u32, (y + h).ceil() as u32);
    let black = [0, 0, 0, 255];
    out.fill_rect(0, 0, out_w, top, black);
    out.fill_rect(0, bottom, out_w, out_h.saturating_sub(bottom), black);
    out.fill_rect(0, top, left, bottom - top, black);
    out.fill_rect(right, top, out_w.saturating_sub(right), bottom - top, black);
    if frame.width == out_w || frame.height == out_h || scale >= 1.0 {
        out.blit_opaque_rgba(x, y, &frame.pixels, frame.width, frame.height);
    } else {
        out.blit_scaled_rgba(x, y, w, h, &frame.pixels, frame.width, frame.height);
    }
}

fn write_png(path: &Path, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    writer
        .write_image_data(rgba)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(())
}

fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map_or(0, |b| b & 0x1f)
}

fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut result = Vec::new();
    let mut current: Option<usize> = None;
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if let Some(start) = current {
                let mut end = i;
                if end > start && data[end - 1] == 0 {
                    end -= 1;
                }
                result.push(&data[start..end]);
            }
            current = Some(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    if let Some(start) = current {
        result.push(&data[start..]);
    }
    result
}

fn avcc_sample(nals: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for nal in nals {
        if matches!(nal_type(nal), 7 | 8 | 9) || nal.is_empty() {
            continue;
        }
        out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        out.extend_from_slice(nal);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pixel_core::surfaces::Rect;

    #[test]
    fn round_trips_a_capture_through_the_mp4_reader() {
        let dir = std::env::temp_dir().join(format!("record-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let frames_dir = dir.join("frames");
        let (width, height) = (320u32, 200u32);

        let mut recorder = crate::capture::Recorder::new(
            &frames_dir,
            crate::capture::Config::default(),
        )
        .unwrap();
        let stride = width as usize * 4;
        for i in 0..5u64 {
            let mut bgra = vec![0u8; stride * height as usize];
            for px in bgra.chunks_exact_mut(4) {
                px.copy_from_slice(&[200, 90, (40 * i) as u8, 255]);
            }
            recorder.capture(&bgra, stride, width, height, Some(Rect::sized(width, height)));
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        let segment = recorder.finish().unwrap();
        assert_eq!(segment.metas().len(), 5);
        let last_ms = segment.metas().last().unwrap().t_us / 1000;

        let font = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/JetBrainsMono-Regular.ttf"
        );
        let video = dir.join("video.mp4");
        let job = serde_json::json!({
            "videoOut": video.to_str().unwrap(),
            "cropsDir": dir.join("crops").to_str().unwrap(),
            "captureDir": frames_dir.to_str().unwrap(),
            "durationMs": last_ms + 100,
            "fontFile": font,
            "markup": [{
                "atMs": 200,
                "untilMs": 400,
                "objects": [
                    { "kind": "pen", "id": 1, "color": "#e5484d", "width": 4.0,
                      "points": [{"x": 10.0, "y": 10.0}, {"x": 60.0, "y": 40.0}, {"x": 120.0, "y": 20.0}] },
                    { "kind": "text", "id": 2, "color": "#f5a524", "text": "hi", "pos": {"x": 30.0, "y": 80.0}, "fontPx": 24.0 },
                    { "kind": "oval", "id": 3, "color": "#3b82f6", "width": 4.0,
                      "rect": {"x": 140.0, "y": 60.0, "width": 90.0, "height": 60.0} },
                ],
            }],
            "crops": [{ "frame": 1, "tMs": 200, "file": dir.join("crops/crop-200.png").to_str().unwrap(),
                        "rect": {"x": 4.0, "y": 4.0, "width": 100.0, "height": 60.0} }],
        });
        run(&job.to_string(), &|_| {}).unwrap();

        let bytes = fs::read(&video).unwrap();
        let size = bytes.len() as u64;
        let reader = mp4::Mp4Reader::read_header(std::io::Cursor::new(bytes), size).unwrap();
        let track = reader.tracks().values().next().unwrap();
        assert_eq!(track.width(), width as u16);
        assert_eq!(track.height(), height as u16);

        let parsed: Job = serde_json::from_str(&job.to_string()).unwrap();
        let source = FrameSource::open(&parsed).unwrap();
        let samples = build_samples(&parsed, &source.times);
        assert_eq!(track.sample_count() as usize, samples.len());
        let unique = source.times.iter().collect::<std::collections::BTreeSet<_>>().len();
        assert!(samples.len() >= unique, "every captured frame is a sample");
        assert!(fs::metadata(dir.join("crops/crop-200.png")).unwrap().len() > 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trims_the_export_to_the_requested_window() {
        let dir = std::env::temp_dir().join(format!("record-trim-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let frames_dir = dir.join("frames");
        let (width, height) = (320u32, 200u32);

        let mut recorder = crate::capture::Recorder::new(
            &frames_dir,
            crate::capture::Config::default(),
        )
        .unwrap();
        let stride = width as usize * 4;
        for i in 0..5u64 {
            let mut bgra = vec![0u8; stride * height as usize];
            for px in bgra.chunks_exact_mut(4) {
                px.copy_from_slice(&[200, 90, (40 * i) as u8, 255]);
            }
            recorder.capture(&bgra, stride, width, height, Some(Rect::sized(width, height)));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let segment = recorder.finish().unwrap();
        let times: Vec<u64> = segment.metas().iter().map(|m| (m.t_us + 500) / 1000).collect();
        let (start, end) = (times[1] + 1, times[3]);

        let font = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/JetBrainsMono-Regular.ttf"
        );
        let video = dir.join("video.mp4");
        let job = serde_json::json!({
            "videoOut": video.to_str().unwrap(),
            "cropsDir": dir.join("crops").to_str().unwrap(),
            "captureDir": frames_dir.to_str().unwrap(),
            "durationMs": end - start,
            "fontFile": font,
            "markup": [],
            "crops": [],
            "trim": { "startMs": start, "endMs": end },
        });
        run(&job.to_string(), &|_| {}).unwrap();

        let parsed: Job = serde_json::from_str(&job.to_string()).unwrap();
        let source = FrameSource::open(&parsed).unwrap();
        let (frame_times, segment_index) = trimmed_frames(&source.times, parsed.trim);
        assert_eq!(frame_times[0], 0, "the frame under the cut becomes the t=0 base");
        assert_eq!(segment_index[0], 1);
        assert!(frame_times.iter().all(|&t| t <= end - start));
        assert_eq!(frame_times.len(), 3, "base plus the two frames inside the window");

        let bytes = fs::read(&video).unwrap();
        let size = bytes.len() as u64;
        let reader = mp4::Mp4Reader::read_header(std::io::Cursor::new(bytes), size).unwrap();
        let track = reader.tracks().values().next().unwrap();
        let samples = build_samples(&parsed, &frame_times);
        assert_eq!(track.sample_count() as usize, samples.len());
        fs::remove_dir_all(&dir).unwrap();
    }
}
