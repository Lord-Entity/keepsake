//! Desktop video editor: crop, trim and mute through ffmpeg (desktop only).
//!
//! JS contract:
//!   invoke<{ width, height, duration, hasAudio, rotation, size }>("editor_probe", { path })
//!     size: file size in bytes.
//!     width/height are display-oriented (swapped for a 90/270 rotation); duration in
//!     seconds (0 when unknown); rotation is 0, 90, 180 or 270.
//!   invoke<void>("edit_video", { jobId, input, output, crop, trimStart, trimEnd, audio, onEvent })
//!     crop: { x, y, w, h } | null, in display-oriented pixels; trimStart/trimEnd seconds | null.
//!     onEvent messages: { progress: number } (0..1), then { done: true } on success.
//!     Rejects with "editor:cancelled" after cancel_edit, "editor:no_encoder: ..." when the
//!     edit needs a re-encode (crop, or a codec that cannot be copied into .mp4) and no
//!     usable video encoder exists, "editor:failed: ..." when ffmpeg fails,
//!     "editor:invalid: ..." for bad arguments, "editor:unsupported: ..." on Android.
//!   invoke<void>("cancel_edit", { jobId })
//!   invoke<{ copyOnly, canReencode, encoder }>("editor_capabilities")
//!     canReencode: crop is possible; encoder is the ffmpeg encoder name (e.g. "libx264").
//!     copyOnly: only trim and mute work, by stream copy; trims snap to keyframes, so a
//!     cut can start up to one keyframe interval earlier than asked. Both false when
//!     no ffmpeg exists at all.
//!
//! ffprobe is not bundled, so probing runs `ffmpeg -i <file>` and parses stderr.
//! ffmpeg writes to `<output stem>.<jobId>.part.mp4` next to the output and the
//! file is renamed onto `output` only on success, so a failed or cancelled run
//! never touches an existing file at `output`.
//!
//! Two video modes:
//! - Copy (`-c:v copy`): used when nothing is cropped, the codec fits in .mp4, and
//!   either no trim is asked or no encoder exists. Works with the bundled minimal LGPL
//!   ffmpeg, which has the mov demuxer and mp4 muxer but no video encoder and no
//!   H.264 decoder. See docs/EDITOR_DESKTOP_ENCODER.md.
//! - Encode: crop, frame-accurate trim, or a codec that cannot be copied. Uses the
//!   best encoder of any ffmpeg found (bundled first, then user-installed), in the
//!   order of `Encoder::ALL`; hardware encoders are listed by full builds even
//!   without the hardware, so they must pass a tiny test encode first.
#![cfg_attr(mobile, allow(dead_code, unused))]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const UNSUPPORTED: &str = "editor:unsupported: video editing is only available on desktop";
const NO_ENCODER_CROP: &str = "editor:no_encoder: cropping needs a video encoder and none was found. The bundled ffmpeg can only trim and mute; install a full ffmpeg build (with libx264 or a hardware H.264 encoder) on PATH to crop.";
/// Seconds a hardware encoder test may take before it counts as unusable.
const TEST_ENCODE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a "no encoder" detection result is reused before detecting again.
const REDETECT_AFTER: Duration = Duration::from_secs(30);

/// Longest accepted media time in seconds (about 115 days); anything above is a bad value.
const MAX_SECONDS: f64 = 1.0e7;
/// Largest accepted pixel coordinate.
const MAX_PIXELS: f64 = 100_000.0;
/// Shortest trimmed clip in seconds.
const MIN_CLIP: f64 = 0.1;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOut {
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub has_audio: bool,
    pub rotation: u32,
    /// Lowercase codec name of the video stream, e.g. "h264" (not sent to JS).
    #[serde(skip)]
    pub video_codec: String,
    /// Lowercase codec name of the first audio stream (not sent to JS).
    #[serde(skip)]
    pub audio_codec: Option<String>,
}

/// Result of `editor_capabilities`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCaps {
    pub copy_only: bool,
    pub can_reencode: bool,
    pub encoder: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct CropArg {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Serialized as `{ "progress": 0.42 }` or `{ "done": true }`.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum EditEvent {
    Progress { progress: f64 },
    Done { done: bool },
}

struct EditJob {
    pid: u32,
    part: PathBuf,
    cancelled: Arc<AtomicBool>,
}

fn jobs() -> &'static Mutex<HashMap<String, EditJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, EditJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_job_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("editor:invalid: jobId must be 1-80 characters of A-Z a-z 0-9 - _".into())
    }
}

/// Absolute with no `..` parts. An absolute path never starts with `-`, so it
/// cannot be read by ffmpeg as an option.
fn clean_absolute(p: &str) -> Option<PathBuf> {
    let pb = PathBuf::from(p);
    let ok = !p.starts_with('-')
        && !p.contains(['\n', '\r', '\0'])
        && pb.is_absolute()
        && !pb
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir));
    ok.then_some(pb)
}

fn validate_input(p: &str) -> Result<PathBuf, String> {
    let pb = clean_absolute(p).ok_or("editor:invalid: input must be an absolute path")?;
    if !pb.is_file() {
        return Err("editor:invalid: input file does not exist".into());
    }
    Ok(pb)
}

fn validate_output(p: &str, input: &Path) -> Result<PathBuf, String> {
    let pb = clean_absolute(p).ok_or("editor:invalid: output must be an absolute path")?;
    let is_mp4 = pb
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    if !is_mp4 {
        return Err("editor:invalid: output must end in .mp4".into());
    }
    if !pb.parent().is_some_and(Path::is_dir) {
        return Err("editor:invalid: output folder does not exist".into());
    }
    if pb.is_dir() {
        return Err("editor:invalid: output is a folder".into());
    }
    let same = pb == input
        || match (std::fs::canonicalize(&pb), std::fs::canonicalize(input)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
    if same {
        return Err("editor:invalid: output must differ from input".into());
    }
    Ok(pb)
}

/// Temporary file next to the output: `<stem>.<jobId>.part.mp4`.
fn part_path(output: &Path, job_id: &str) -> PathBuf {
    let stem = output
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "edit".to_string());
    output.with_file_name(format!("{stem}.{job_id}.part.mp4"))
}

// ---------------------------------------------------------------------------
// Probe (stderr of `ffmpeg -i`)
// ---------------------------------------------------------------------------

/// `HH:MM:SS.ss` -> seconds. `N/A` and garbage -> None.
fn parse_hms(s: &str) -> Option<f64> {
    let mut parts = s.trim().split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let sec: f64 = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let v = h * 3600.0 + m * 60.0 + sec;
    (v.is_finite() && v >= 0.0).then_some(v)
}

/// First `<w>x<h>` token with both sides > 0 (skips hex tags like `0x31637661`).
fn parse_size(s: &str) -> Option<(u32, u32)> {
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .filter_map(|tok| tok.split_once('x'))
        .filter_map(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)))
        .find(|&(w, h)| w > 0 && h > 0)
}

/// Clockwise degrees snapped to 0/90/180/270.
fn snap_rotation(deg: f64) -> u32 {
    if !deg.is_finite() {
        return 0;
    }
    let r = (deg.round() as i64).rem_euclid(360);
    (((r + 45) / 90 * 90) % 360) as u32
}

/// Parse the stderr of `ffmpeg -hide_banner -i <file>`.
/// Rotation comes from `displaymatrix: rotation of -90.00 degrees` (FFmpeg 5+,
/// counter-clockwise, so negated) or the legacy `rotate : 90` stream tag.
fn parse_probe(text: &str) -> Result<ProbeOut, String> {
    let mut duration: Option<f64> = None;
    let mut size: Option<(u32, u32)> = None;
    let mut rotation: Option<u32> = None;
    let mut has_audio = false;
    let mut in_video = false;
    let mut video_codec = String::new();
    let mut audio_codec: Option<String> = None;

    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Duration:") {
            if duration.is_none() {
                duration = parse_hms(rest.split(',').next().unwrap_or(""));
            }
            continue;
        }
        if t.starts_with("Stream #") {
            in_video = false;
            if let Some(i) = t.find(": Audio:") {
                if audio_codec.is_none() {
                    audio_codec = Some(codec_token(&t[i + ": Audio:".len()..]));
                }
                has_audio = true;
            } else if let Some(i) = t.find(": Video:") {
                if size.is_none() && !t.contains("(attached pic)") {
                    let rest = &t[i + ": Video:".len()..];
                    if let Some(wh) = parse_size(rest) {
                        size = Some(wh);
                        video_codec = codec_token(rest);
                        in_video = true;
                    }
                }
            }
            continue;
        }
        if in_video && rotation.is_none() {
            if let Some(i) = t.find("rotation of ") {
                let num = t[i + "rotation of ".len()..]
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse::<f64>().ok());
                if let Some(v) = num {
                    rotation = Some(snap_rotation(-v));
                }
            } else if let Some(rest) = t.strip_prefix("rotate") {
                if let Some(v) = rest.trim_start().strip_prefix(':') {
                    if let Ok(v) = v.trim().parse::<f64>() {
                        rotation = Some(snap_rotation(v));
                    }
                }
            }
        }
    }

    let (w, h) = size.ok_or_else(|| {
        let last = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("At least one output"))
            .next_back()
            .unwrap_or("no output");
        format!("editor:no_video: no video stream found ({last})")
    })?;
    let rotation = rotation.unwrap_or(0);
    let (width, height) = if rotation == 90 || rotation == 270 {
        (h, w)
    } else {
        (w, h)
    };
    Ok(ProbeOut {
        width,
        height,
        duration: duration.unwrap_or(0.0),
        has_audio,
        rotation,
        video_codec,
        audio_codec,
    })
}

/// First word of a stream description, e.g. `h264 (High) (avc1 / ...)` -> "h264".
fn codec_token(s: &str) -> String {
    s.trim_start()
        .split(|c: char| c.is_whitespace() || c == ',')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// Edit plan and ffmpeg arguments (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
struct EditPlan {
    /// Seek before `-i`; 0 means no `-ss`.
    start: f64,
    /// `-t` value when the end is trimmed.
    length: Option<f64>,
    /// Even-pixel crop (w, h, x, y) in display-oriented coordinates, applied when
    /// re-encoding. Also set for an odd-sized frame, since yuv420p needs even sizes.
    crop: Option<(u32, u32, u32, u32)>,
    /// The user asked for a crop smaller than the frame (forces a re-encode).
    user_crop: bool,
    /// Output (w, h) when re-encoding.
    size: (u32, u32),
    audio: bool,
    /// Output length in seconds for progress (0 when unknown).
    total: f64,
}

fn finite_in(v: f64, lo: f64, hi: f64, name: &str) -> Result<f64, String> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(v)
    } else {
        Err(format!("editor:invalid: {name} is out of range"))
    }
}

fn even_floor(v: u32) -> u32 {
    v & !1
}

fn plan_edit(
    probe: &ProbeOut,
    crop: Option<CropArg>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    audio: bool,
) -> Result<EditPlan, String> {
    let dur = probe.duration;
    let start = match trim_start {
        Some(s) => finite_in(s, 0.0, MAX_SECONDS, "trimStart")?,
        None => 0.0,
    };
    if dur > 0.0 && start >= dur {
        return Err("editor:invalid: trimStart is past the end of the video".into());
    }
    let end = match trim_end {
        Some(e) => {
            let e = finite_in(e, 0.0, MAX_SECONDS, "trimEnd")?;
            Some(if dur > 0.0 { e.min(dur) } else { e })
        }
        None => None,
    };
    if let Some(e) = end {
        if e - start < MIN_CLIP {
            return Err("editor:invalid: trimEnd must be after trimStart".into());
        }
    }
    // `-t` only when the end actually cuts something off.
    let length = match end {
        Some(e) if dur <= 0.0 || e < dur - 0.001 => Some(e - start),
        _ => None,
    };
    let total = match length {
        Some(l) => l,
        None if dur > 0.0 => dur - start,
        None => 0.0,
    };

    let (fw, fh) = (probe.width, probe.height);
    // yuv420p needs even dimensions.
    let full = (even_floor(fw), even_floor(fh), 0, 0);
    let crop_px = match crop {
        Some(c) => {
            let x = finite_in(c.x, 0.0, MAX_PIXELS, "crop.x")?.round() as u32;
            let y = finite_in(c.y, 0.0, MAX_PIXELS, "crop.y")?.round() as u32;
            let w = finite_in(c.w, 1.0, MAX_PIXELS, "crop.w")?.round() as u32;
            let h = finite_in(c.h, 1.0, MAX_PIXELS, "crop.h")?.round() as u32;
            let (x, y) = (even_floor(x), even_floor(y));
            if x >= fw || y >= fh {
                return Err("editor:invalid: crop starts outside the frame".into());
            }
            let w = even_floor(w.min(fw - x));
            let h = even_floor(h.min(fh - y));
            if w < 2 || h < 2 {
                return Err("editor:invalid: crop is too small".into());
            }
            (w, h, x, y)
        }
        None => full,
    };
    let user_crop = crop_px != full;
    let crop = if crop_px == (fw, fh, 0, 0) {
        None
    } else if crop_px.0 < 2 || crop_px.1 < 2 {
        return Err("editor:invalid: video is too small".into());
    } else {
        Some(crop_px)
    };

    Ok(EditPlan {
        start,
        length,
        crop,
        user_crop,
        size: (crop_px.0, crop_px.1),
        audio: audio && probe.has_audio,
        total,
    })
}

/// Video encoders in order of preference. All write H.264 except `Mpeg4`
/// (MPEG-4 Part 2, tagged `mp4v`), the last resort that every full build has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoder {
    Libx264,
    Nvenc,
    Qsv,
    Amf,
    MediaFoundation,
    VideoToolbox,
    OpenH264,
    Mpeg4,
}

impl Encoder {
    const ALL: [Encoder; 8] = [
        Encoder::Libx264,
        Encoder::Nvenc,
        Encoder::Qsv,
        Encoder::Amf,
        Encoder::MediaFoundation,
        Encoder::VideoToolbox,
        Encoder::OpenH264,
        Encoder::Mpeg4,
    ];

    fn name(self) -> &'static str {
        match self {
            Encoder::Libx264 => "libx264",
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Qsv => "h264_qsv",
            Encoder::Amf => "h264_amf",
            Encoder::MediaFoundation => "h264_mf",
            Encoder::VideoToolbox => "h264_videotoolbox",
            Encoder::OpenH264 => "libopenh264",
            Encoder::Mpeg4 => "mpeg4",
        }
    }

    /// Software encoders work whenever they are listed; the rest depend on a
    /// GPU, driver or OS component and must pass `test_encode`.
    fn needs_test(self) -> bool {
        !matches!(self, Encoder::Libx264 | Encoder::OpenH264 | Encoder::Mpeg4)
    }

    /// `-c:v ...` and quality settings for a `w` x `h` output.
    fn args(self, w: u32, h: u32) -> Vec<String> {
        // Bitrate for encoders without a usable constant-quality mode:
        // about 4 bits per pixel per second, 8.3 Mb/s at 1080p.
        let rate = format!(
            "{}k",
            (u64::from(w) * u64::from(h) * 4).clamp(1_000_000, 40_000_000) / 1000
        );
        let v: Vec<&str> = match self {
            Encoder::Libx264 => vec![
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            ],
            Encoder::Nvenc => vec![
                "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0",
                "-pix_fmt", "yuv420p",
            ],
            Encoder::Qsv => vec![
                "-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "22", "-pix_fmt",
                "nv12",
            ],
            Encoder::Amf => vec![
                "-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p",
                "22", "-qp_b", "24", "-pix_fmt", "yuv420p",
            ],
            Encoder::MediaFoundation => {
                vec!["-c:v", "h264_mf", "-b:v", rate.as_str(), "-pix_fmt", "nv12"]
            }
            Encoder::VideoToolbox => vec![
                "-c:v", "h264_videotoolbox", "-b:v", rate.as_str(), "-allow_sw", "1", "-pix_fmt",
                "yuv420p",
            ],
            Encoder::OpenH264 => vec!["-c:v", "libopenh264", "-b:v", rate.as_str(), "-pix_fmt", "yuv420p"],
            Encoder::Mpeg4 => vec![
                "-c:v", "mpeg4", "-q:v", "3", "-tag:v", "mp4v", "-pix_fmt", "yuv420p",
            ],
        };
        v.into_iter().map(String::from).collect()
    }
}

/// How the video stream is written.
#[derive(Debug, Clone, Copy, PartialEq)]
enum VideoMode {
    /// `-c:v copy`: no decode or encode; cuts snap to keyframes.
    Copy,
    /// Decode and re-encode with this encoder.
    Encode(Encoder),
}

/// Video codecs that can be stream-copied into .mp4.
fn copy_video_ok(codec: &str) -> bool {
    matches!(codec, "h264" | "hevc" | "av1" | "vp9" | "mpeg4")
}

/// Audio codecs that can be stream-copied into .mp4; others are re-encoded to AAC.
fn copy_audio_ok(codec: &str) -> bool {
    matches!(codec, "aac" | "mp3" | "alac" | "opus" | "flac" | "ac3" | "eac3")
}

/// Copy when nothing is cropped and the codec fits in .mp4, unless a trim is asked
/// and an encoder exists (re-encoding makes the cut frame-accurate).
fn choose_mode(
    plan: &EditPlan,
    probe: &ProbeOut,
    encoder: Option<Encoder>,
) -> Result<VideoMode, String> {
    let copy_ok = !plan.user_crop && copy_video_ok(&probe.video_codec);
    let trimmed = plan.start > 0.0 || plan.length.is_some();
    match encoder {
        Some(e) if !copy_ok || trimmed => Ok(VideoMode::Encode(e)),
        _ if copy_ok => Ok(VideoMode::Copy),
        _ if plan.user_crop => Err(NO_ENCODER_CROP.into()),
        _ => Err(format!(
            "editor:no_encoder: this video's codec ({}) cannot be copied into .mp4 and no video encoder was found. Install a full ffmpeg build on PATH.",
            if probe.video_codec.is_empty() {
                "unknown"
            } else {
                probe.video_codec.as_str()
            }
        )),
    }
}

/// Full ffmpeg argument list (program not included). `input` and `output` are
/// validated absolute paths, so neither can start with `-`.
fn build_args(
    input: &str,
    output: &str,
    plan: &EditPlan,
    mode: VideoMode,
    probe: &ProbeOut,
) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-y",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if plan.start > 0.0 {
        a.push("-ss".into());
        a.push(format!("{:.3}", plan.start));
    }
    a.push("-i".into());
    a.push(input.to_string());
    if let Some(l) = plan.length {
        a.push("-t".into());
        a.push(format!("{l:.3}"));
    }
    // `V` (capital) skips attached cover pictures.
    a.push("-map".into());
    a.push("0:V:0".into());
    if plan.audio {
        a.push("-map".into());
        a.push("0:a:0?".into());
    }
    let audio_copy = match mode {
        VideoMode::Encode(enc) => {
            // ffmpeg autorotates before user filters, so the crop is in display coordinates.
            if let Some((w, h, x, y)) = plan.crop {
                a.push("-vf".into());
                a.push(format!("crop={w}:{h}:{x}:{y}"));
            }
            a.extend(enc.args(plan.size.0, plan.size.1));
            false
        }
        VideoMode::Copy => {
            // The rotation side data is copied with the stream.
            for s in ["-c:v", "copy"] {
                a.push(s.into());
            }
            if probe.video_codec == "hevc" {
                // Apple players need the hvc1 tag.
                for s in ["-tag:v", "hvc1"] {
                    a.push(s.into());
                }
            }
            probe.audio_codec.as_deref().is_some_and(copy_audio_ok)
        }
    };
    if !plan.audio {
        a.push("-an".into());
    } else if audio_copy {
        for s in ["-c:a", "copy"] {
            a.push(s.into());
        }
    } else {
        for s in ["-c:a", "aac", "-b:a", "160k"] {
            a.push(s.into());
        }
    }
    if mode == VideoMode::Copy {
        // Shift the kept keyframe-aligned packets to start at 0.
        for s in ["-avoid_negative_ts", "make_zero"] {
            a.push(s.into());
        }
    }
    for s in ["-sn", "-dn", "-movflags", "+faststart", "-f", "mp4"] {
        a.push(s.into());
    }
    a.push(output.to_string());
    a
}

/// `out_time_us=123456` (or the misnamed `out_time_ms`, also microseconds) -> seconds.
fn parse_progress_line(line: &str) -> Option<f64> {
    let (k, v) = line.trim().split_once('=')?;
    if k != "out_time_us" && k != "out_time_ms" {
        return None;
    }
    let us: i64 = v.trim().parse().ok()?;
    (us >= 0).then(|| us as f64 / 1_000_000.0)
}

// ---------------------------------------------------------------------------
// ffmpeg lookup and process helpers
// ---------------------------------------------------------------------------

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Bundled sidecar, resolved like ytdlp.rs (next to the app binary).
fn bundled_ffmpeg() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join(exe_name("keepsake-ffmpeg"));
    p.is_file().then_some(p)
}

/// User-installed ffmpeg binaries (absolute paths only).
fn system_ffmpegs() -> Vec<PathBuf> {
    let name = exe_name("ffmpeg");
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            out.push(dir.join(&name));
        }
    }
    #[cfg(windows)]
    {
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            out.push(
                PathBuf::from(la)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join(&name),
            );
        }
    }
    #[cfg(unix)]
    {
        out.push(PathBuf::from("/usr/local/bin/ffmpeg"));
        out.push(PathBuf::from("/usr/bin/ffmpeg"));
    }
    out.retain(|p| p.is_absolute() && p.is_file());
    out
}

fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// True when `ffmpeg -encoders` output lists `name` as a video encoder.
fn lists_video_encoder(encoders: &str, name: &str) -> bool {
    encoders.lines().any(|l| {
        let mut t = l.split_whitespace();
        matches!((t.next(), t.next()), (Some(flags), Some(n)) if n == name && flags.starts_with('V'))
    })
}

fn list_encoders(p: &Path) -> String {
    quiet_command(p)
        .args(["-hide_banner", "-encoders"])
        .stderr(std::process::Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Encode a few synthetic frames to the null muxer; false on error or timeout.
/// Needs the lavfi device, which full builds have and the bundled sidecar lacks.
fn test_encode(ffmpeg: &Path, enc: Encoder) -> bool {
    use std::process::Stdio;
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=30:d=0.5",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.extend(enc.args(320, 240));
    args.extend(["-frames:v", "5", "-an", "-f", "null", "-"].map(String::from));
    let Ok(mut child) = quiet_command(ffmpeg)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + TEST_ENCODE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Best working encoder of one ffmpeg, considering only encoders ranked before `limit`.
fn best_encoder(ffmpeg: &Path, limit: usize) -> Option<Encoder> {
    let listed = list_encoders(ffmpeg);
    Encoder::ALL[..limit]
        .iter()
        .copied()
        .filter(|e| lists_video_encoder(&listed, e.name()))
        .find(|&e| !e.needs_test() || test_encode(ffmpeg, e))
}

#[derive(Debug, Clone)]
struct Tools {
    /// ffmpeg for stream copy and probing (bundled sidecar first).
    copy: Option<PathBuf>,
    /// ffmpeg and encoder for re-encoding.
    encode: Option<(PathBuf, Encoder)>,
}

impl Tools {
    fn still_present(&self) -> bool {
        self.copy.as_deref().is_none_or(Path::is_file)
            && self.encode.as_ref().is_none_or(|(p, _)| p.is_file())
    }

    /// ffmpeg used to probe and to stream-copy: a full build reads more containers.
    fn reader(&self) -> Option<PathBuf> {
        self.encode
            .as_ref()
            .map(|(p, _)| p.clone())
            .or_else(|| self.copy.clone())
    }
}

fn detect_tools() -> Tools {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for p in bundled_ffmpeg().into_iter().chain(system_ffmpegs()) {
        if !candidates.contains(&p) {
            candidates.push(p);
        }
    }
    let mut encode: Option<(PathBuf, Encoder)> = None;
    for p in &candidates {
        let limit = encode
            .as_ref()
            .and_then(|(_, e)| Encoder::ALL.iter().position(|x| x == e))
            .unwrap_or(Encoder::ALL.len());
        if limit == 0 {
            break;
        }
        if let Some(e) = best_encoder(p, limit) {
            encode = Some((p.clone(), e));
        }
    }
    Tools {
        copy: candidates.into_iter().next(),
        encode,
    }
}

/// Detected tools, cached while the files exist. A result without an encoder is
/// re-detected after `REDETECT_AFTER`, so installing ffmpeg needs no restart.
fn tools() -> Tools {
    static CACHE: OnceLock<Mutex<Option<(Tools, Instant)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((t, at)) = guard.as_ref() {
        let fresh = t.encode.is_some() || at.elapsed() < REDETECT_AFTER;
        if fresh && t.still_present() {
            return t.clone();
        }
    }
    let t = detect_tools();
    *guard = Some((t.clone(), Instant::now()));
    t
}

fn no_ffmpeg() -> String {
    "editor:no_ffmpeg: ffmpeg was not found".to_string()
}

fn probe_with(ffmpeg: &Path, input: &Path) -> Result<ProbeOut, String> {
    let out = quiet_command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(input)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("editor:failed: could not start ffmpeg: {e}"))?;
    // Exit code is 1 ("At least one output file must be specified"); only stderr matters.
    parse_probe(&String::from_utf8_lossy(&out.stderr))
}

/// Kill ffmpeg and any children.
fn kill_tree(pid: u32) {
    use std::process::Stdio;
    #[cfg(windows)]
    let mut cmd = {
        let mut c = quiet_command("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    };
    #[cfg(unix)]
    let mut cmd = {
        // The child was started in its own process group (pgid == pid).
        let mut c = quiet_command("kill");
        c.args(["-KILL", "--", &format!("-{pid}")]);
        c
    };
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn run_edit(
    job_id: String,
    input: PathBuf,
    output: PathBuf,
    input_s: String,
    crop: Option<CropArg>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    audio: bool,
    on_event: Channel<EditEvent>,
) -> Result<(), String> {
    use std::io::BufRead;
    use std::process::Stdio;

    let tools = tools();
    let reader = tools.reader().ok_or_else(no_ffmpeg)?;
    let probe = probe_with(&reader, &input)?;
    let plan = plan_edit(&probe, crop, trim_start, trim_end, audio)?;
    let mode = choose_mode(&plan, &probe, tools.encode.as_ref().map(|(_, e)| *e))?;
    let ffmpeg = match (&mode, &tools.encode) {
        (VideoMode::Encode(_), Some((p, _))) => p.clone(),
        _ => reader,
    };
    let part = part_path(&output, &job_id);
    let part_s = part
        .to_str()
        .ok_or("editor:invalid: output path is not valid text")?
        .to_string();
    let args = build_args(&input_s, &part_s, &plan, mode, &probe);

    let mut cmd = quiet_command(&ffmpeg);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let mut child = {
        let mut map = jobs().lock().map_err(|_| "job table poisoned")?;
        if map.contains_key(&job_id) {
            return Err(format!("editor:invalid: job {job_id} is already running"));
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("editor:failed: could not start ffmpeg: {e}"))?;
        map.insert(
            job_id.clone(),
            EditJob {
                pid: child.id(),
                part: part.clone(),
                cancelled: cancelled.clone(),
            },
        );
        child
    };

    // Keep the last stderr lines for the error message.
    let stderr = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut tail: VecDeque<String> = VecDeque::new();
        if let Some(s) = stderr {
            for line in std::io::BufReader::new(s).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                if tail.len() == 8 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        }
        Vec::from(tail).join(" | ")
    });

    let _ = on_event.send(EditEvent::Progress { progress: 0.0 });
    if let Some(s) = child.stdout.take() {
        let mut last = 0.0_f64;
        for line in std::io::BufReader::new(s).lines().map_while(Result::ok) {
            if plan.total <= 0.0 {
                continue;
            }
            if let Some(t) = parse_progress_line(&line) {
                let p = (t / plan.total).clamp(0.0, 1.0);
                if p - last >= 0.002 {
                    last = p;
                    let _ = on_event.send(EditEvent::Progress { progress: p });
                }
            }
        }
    }
    let err_tail = err_thread.join().unwrap_or_default();
    let status = child.wait();
    if let Ok(mut map) = jobs().lock() {
        map.remove(&job_id);
    }

    if cancelled.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&part);
        return Err("editor:cancelled".into());
    }
    match status {
        Ok(s) if s.success() => {
            if let Err(e) = std::fs::rename(&part, &output) {
                let _ = std::fs::remove_file(&part);
                return Err(format!("editor:failed: could not save the output: {e}"));
            }
            let _ = on_event.send(EditEvent::Progress { progress: 1.0 });
            let _ = on_event.send(EditEvent::Done { done: true });
            Ok(())
        }
        Ok(s) => {
            let _ = std::fs::remove_file(&part);
            let code = s
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into());
            Err(format!("editor:failed: ffmpeg exited with {code}: {err_tail}"))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(format!("editor:failed: {e}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `editor_probe` reply: the probe plus the file size in bytes (`size`), which the
/// in-app encoder uses to skip files too large to read into memory.
#[derive(Debug, Clone, Serialize)]
pub struct ProbeReply {
    #[serde(flatten)]
    pub probe: ProbeOut,
    pub size: u64,
}

/// Size (display-oriented), duration, audio presence and rotation of a video file.
#[tauri::command]
pub async fn editor_probe(path: String) -> Result<ProbeReply, String> {
    if cfg!(mobile) {
        return Err(UNSUPPORTED.into());
    }
    let input = validate_input(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = tools().reader().ok_or_else(no_ffmpeg)?;
        let probe = probe_with(&ffmpeg, &input)?;
        let size = std::fs::metadata(&input).map(|m| m.len()).unwrap_or(0);
        Ok::<_, String>(ProbeReply { probe, size })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What this machine can do: crop needs `canReencode`; with `copyOnly` only
/// trim (keyframe-snapped) and mute work. The first call can take a few seconds
/// while hardware encoders are tested.
#[tauri::command]
pub async fn editor_capabilities() -> Result<EditorCaps, String> {
    if cfg!(mobile) {
        return Err(UNSUPPORTED.into());
    }
    let t = tauri::async_runtime::spawn_blocking(tools)
        .await
        .map_err(|e| e.to_string())?;
    Ok(EditorCaps {
        copy_only: t.encode.is_none() && t.copy.is_some(),
        can_reencode: t.encode.is_some(),
        encoder: t.encode.map(|(_, e)| e.name().to_string()),
    })
}

/// Crop / trim / mute `input` into the `.mp4` at `output`, streaming progress.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_video(
    job_id: String,
    input: String,
    output: String,
    crop: Option<CropArg>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    audio: bool,
    on_event: Channel<EditEvent>,
) -> Result<(), String> {
    if cfg!(mobile) {
        return Err(UNSUPPORTED.into());
    }
    validate_job_id(&job_id)?;
    let input_p = validate_input(&input)?;
    let output_p = validate_output(&output, &input_p)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_edit(
            job_id, input_p, output_p, input, crop, trim_start, trim_end, audio, on_event,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Kill a running edit. No-op if the job is unknown; the pending `edit_video`
/// call then rejects with "editor:cancelled".
#[tauri::command]
pub async fn cancel_edit(job_id: String) -> Result<(), String> {
    let pid = jobs()
        .lock()
        .map_err(|_| "job table poisoned")?
        .get(&job_id)
        .map(|j| {
            j.cancelled.store(true, Ordering::SeqCst);
            j.pid
        });
    if let Some(pid) = pid {
        tauri::async_runtime::spawn_blocking(move || kill_tree(pid))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called on app exit: kill every running ffmpeg edit and drop its part file.
pub fn kill_all() {
    let running: Vec<(u32, PathBuf)> = match jobs().lock() {
        Ok(map) => map.values().map(|j| (j.pid, j.part.clone())).collect(),
        Err(_) => return,
    };
    for (pid, _) in &running {
        kill_tree(*pid);
    }
    for (_, part) in &running {
        let _ = std::fs::remove_file(part);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANDSCAPE: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:01:28.83, start: 0.000000, bitrate: 8788 kb/s
  Stream #0:0[0x1](und): Video: h264 (avc1 / 0x31637661), none(progressive), 1920x1080, 8787 kb/s, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 15360 tbn (default)
      Metadata:
        handler_name    : VideoHandler
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
At least one output file must be specified
";

    const PORTRAIT_PHONE: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'b.mp4':
  Duration: 00:00:10.50, start: 0.000000, bitrate: 17000 kb/s
  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 16900 kb/s, 29.97 fps (default)
      Metadata:
        creation_time   : 2024-01-01T00:00:00.000000Z
      Side data:
        displaymatrix: rotation of -90.00 degrees
At least one output file must be specified
";

    const LEGACY_ROTATE: &str = "  Duration: 00:00:05.00, start: 0.000000, bitrate: 1 kb/s
  Stream #0:0(und): Video: h264 (avc1 / 0x31637661), yuv420p, 640x480, 1 kb/s, 30 fps
    Metadata:
      rotate          : 270
";

    const COVER_ART: &str = "  Duration: N/A, bitrate: N/A
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)
";

    fn probe(w: u32, h: u32, d: f64, a: bool) -> ProbeOut {
        ProbeOut {
            width: w,
            height: h,
            duration: d,
            has_audio: a,
            rotation: 0,
            video_codec: "h264".into(),
            audio_codec: a.then(|| "aac".to_string()),
        }
    }

    const X264: VideoMode = VideoMode::Encode(Encoder::Libx264);

    /// True when `flag` is directly followed by `value`.
    fn has_pair(a: &[String], flag: &str, value: &str) -> bool {
        a.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    #[test]
    fn probe_landscape() {
        let p = parse_probe(LANDSCAPE).unwrap();
        assert_eq!((p.width, p.height, p.rotation), (1920, 1080, 0));
        assert!((p.duration - 88.83).abs() < 1e-6);
        assert!(p.has_audio);
        assert_eq!(p.video_codec, "h264");
        assert_eq!(p.audio_codec.as_deref(), Some("aac"));
    }

    #[test]
    fn probe_rotated_swaps_size() {
        let p = parse_probe(PORTRAIT_PHONE).unwrap();
        assert_eq!((p.width, p.height, p.rotation), (1080, 1920, 90));
        assert!(!p.has_audio);
        let p = parse_probe(LEGACY_ROTATE).unwrap();
        assert_eq!((p.width, p.height, p.rotation), (480, 640, 270));
        assert!((p.duration - 5.0).abs() < 1e-9);
    }

    #[test]
    fn probe_rejects_cover_art_only_and_garbage() {
        assert!(parse_probe(COVER_ART).is_err());
        let e = parse_probe("x.mp4: Invalid data found when processing input\n").unwrap_err();
        assert!(e.starts_with("editor:no_video"));
    }

    #[test]
    fn helpers() {
        assert_eq!(parse_hms("01:02:03.5"), Some(3723.5));
        assert_eq!(parse_hms("N/A"), None);
        assert_eq!(parse_size(" h264 (avc1 / 0x31637661), 1280x720,"), Some((1280, 720)));
        assert_eq!(snap_rotation(-90.0), 270);
        assert_eq!(snap_rotation(90.0), 90);
        assert_eq!(snap_rotation(-180.0), 180);
        assert_eq!(snap_rotation(359.0), 0);
        assert_eq!(parse_progress_line("out_time_us=1500000"), Some(1.5));
        assert_eq!(parse_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_progress_line("out_time_us=-5"), None);
        assert_eq!(parse_progress_line("progress=end"), None);
        let listed = " V....D libx264              libx264 H.264 / AVC (codec h264)\n \
                      V....D h264_mf              H264 via MediaFoundation (codec h264)\n \
                      A....D aac                  AAC\n";
        assert!(lists_video_encoder(listed, "libx264"));
        assert!(lists_video_encoder(listed, "h264_mf"));
        assert!(!lists_video_encoder(listed, "aac"), "audio encoders do not count");
        assert!(!lists_video_encoder(listed, "h264_nvenc"));
        assert!(!lists_video_encoder(" VFS... mjpeg\n VF...D png\n", "mpeg4"));
        assert_eq!(codec_token(" hevc (Main), yuv420p"), "hevc");
        assert_eq!(codec_token(" AAC,"), "aac");
    }

    #[test]
    fn args_full_edit() {
        let plan = plan_edit(
            &probe(1920, 1080, 60.0, true),
            Some(CropArg { x: 11.0, y: 9.6, w: 641.0, h: 361.0 }),
            Some(5.0),
            Some(15.5),
            true,
        )
        .unwrap();
        assert_eq!(plan.crop, Some((640, 360, 10, 10)));
        assert!(plan.user_crop);
        assert_eq!(plan.size, (640, 360));
        assert!((plan.total - 10.5).abs() < 1e-9);
        let a = build_args("/in/a.mp4", "/out/b.part.mp4", &plan, X264, &probe(1920, 1080, 60.0, true));
        let joined = a.join(" ");
        assert!(joined.contains("-ss 5.000 -i /in/a.mp4 -t 10.500"));
        assert!(joined.contains("-vf crop=640:360:10:10"));
        assert!(joined.contains("-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p"));
        assert!(joined.contains("-map 0:a:0? "));
        assert!(joined.contains("-c:a aac -b:a 160k"));
        assert!(joined.contains("-movflags +faststart"));
        assert!(a.contains(&"-y".to_string()));
        assert!(!joined.contains("avoid_negative_ts"));
        assert_eq!(a.last().map(String::as_str), Some("/out/b.part.mp4"));
        // `-ss` comes before `-i`.
        let ss = a.iter().position(|x| x == "-ss").unwrap();
        let i = a.iter().position(|x| x == "-i").unwrap();
        assert!(ss < i);
    }

    #[test]
    fn args_no_edit_no_audio() {
        let v = probe(1280, 720, 30.0, true);
        let plan = plan_edit(&v, None, None, None, false).unwrap();
        assert_eq!(plan.crop, None);
        assert!(!plan.user_crop);
        assert_eq!(plan.length, None);
        assert_eq!(plan.start, 0.0);
        let a = build_args("/in/a.mp4", "/out/b.mp4", &plan, X264, &v);
        assert!(a.contains(&"-an".to_string()));
        assert!(!a.contains(&"-ss".to_string()));
        assert!(!a.contains(&"-t".to_string()));
        assert!(!a.contains(&"-vf".to_string()));
        assert!(!a.contains(&"aac".to_string()));
        assert!(!a.contains(&"-c:a".to_string()));
    }

    #[test]
    fn args_copy_trim() {
        let v = probe(1920, 1080, 60.0, true);
        let plan = plan_edit(&v, None, Some(5.0), Some(15.5), true).unwrap();
        let a = build_args("/in/a.mp4", "/out/b.part.mp4", &plan, VideoMode::Copy, &v);
        let joined = a.join(" ");
        assert!(joined.contains("-ss 5.000 -i /in/a.mp4 -t 10.500"));
        assert!(has_pair(&a, "-c:v", "copy"));
        assert!(has_pair(&a, "-c:a", "copy"));
        assert!(has_pair(&a, "-avoid_negative_ts", "make_zero"));
        assert!(has_pair(&a, "-f", "mp4"));
        assert!(!a.contains(&"-vf".to_string()));
        assert!(!a.contains(&"-pix_fmt".to_string()));
        assert!(!a.contains(&"-tag:v".to_string()));
        assert_eq!(a.last().map(String::as_str), Some("/out/b.part.mp4"));
    }

    #[test]
    fn args_copy_mute() {
        let v = probe(1280, 720, 30.0, true);
        let plan = plan_edit(&v, None, None, None, false).unwrap();
        let a = build_args("/in/a.mp4", "/out/b.mp4", &plan, VideoMode::Copy, &v);
        assert!(has_pair(&a, "-c:v", "copy"));
        assert!(a.contains(&"-an".to_string()));
        assert!(!a.contains(&"-c:a".to_string()));
        assert!(!a.contains(&"0:a:0?".to_string()));
    }

    #[test]
    fn args_copy_hevc_and_foreign_audio() {
        let mut v = probe(3840, 2160, 30.0, true);
        v.video_codec = "hevc".into();
        v.audio_codec = Some("vorbis".into());
        let plan = plan_edit(&v, None, None, Some(10.0), true).unwrap();
        let a = build_args("/in/a.mkv", "/out/b.mp4", &plan, VideoMode::Copy, &v);
        assert!(has_pair(&a, "-tag:v", "hvc1"));
        assert!(has_pair(&a, "-c:a", "aac"), "vorbis does not fit in mp4");
        assert!(has_pair(&a, "-b:a", "160k"));
    }

    #[test]
    fn args_each_encoder() {
        let v = probe(1920, 1080, 10.0, true);
        let plan = plan_edit(
            &v,
            Some(CropArg { x: 0.0, y: 0.0, w: 1280.0, h: 720.0 }),
            None,
            None,
            true,
        )
        .unwrap();
        for e in Encoder::ALL {
            let a = build_args("/in/a.mp4", "/out/b.mp4", &plan, VideoMode::Encode(e), &v);
            assert!(has_pair(&a, "-c:v", e.name()), "{}", e.name());
            assert!(a.contains(&"-pix_fmt".to_string()), "{}", e.name());
            assert!(has_pair(&a, "-vf", "crop=1280:720:0:0"), "{}", e.name());
            assert!(has_pair(&a, "-c:a", "aac"), "{}", e.name());
            assert!(!a.contains(&"-avoid_negative_ts".to_string()), "{}", e.name());
            // Every value-taking flag has a value.
            assert!(!a.iter().any(String::is_empty), "{}", e.name());
        }
        let rate = |e: Encoder| {
            let a = e.args(1280, 720);
            a.windows(2)
                .find(|w| w[0] == "-b:v")
                .map(|w| w[1].clone())
        };
        // 1280 * 720 * 4 bits = 3686.4 kb/s.
        assert_eq!(rate(Encoder::MediaFoundation).as_deref(), Some("3686k"));
        assert_eq!(rate(Encoder::OpenH264).as_deref(), Some("3686k"));
        assert_eq!(rate(Encoder::VideoToolbox).as_deref(), Some("3686k"));
        // Clamped at both ends.
        let small = Encoder::OpenH264.args(16, 16);
        assert!(has_pair(&small, "-b:v", "1000k"));
        let huge = Encoder::OpenH264.args(8192, 8192);
        assert!(has_pair(&huge, "-b:v", "40000k"));
        assert!(has_pair(&Encoder::Mpeg4.args(2, 2), "-tag:v", "mp4v"));
        assert!(!Encoder::Libx264.needs_test());
        assert!(Encoder::Nvenc.needs_test());
        assert!(Encoder::MediaFoundation.needs_test());
    }

    #[test]
    fn mode_choice() {
        let v = probe(1920, 1080, 60.0, true);
        let crop = Some(CropArg { x: 0.0, y: 0.0, w: 640.0, h: 360.0 });
        let none = plan_edit(&v, None, None, None, false).unwrap();
        let trim = plan_edit(&v, None, Some(1.0), None, true).unwrap();
        let cropped = plan_edit(&v, crop, None, None, true).unwrap();
        let enc = Some(Encoder::Nvenc);
        let nv = VideoMode::Encode(Encoder::Nvenc);
        // No encoder: copy for trim and mute, crop is refused.
        assert_eq!(choose_mode(&none, &v, None), Ok(VideoMode::Copy));
        assert_eq!(choose_mode(&trim, &v, None), Ok(VideoMode::Copy));
        let e = choose_mode(&cropped, &v, None).unwrap_err();
        assert!(e.starts_with("editor:no_encoder:") && e.contains("crop"));
        // With an encoder: copy only when nothing is cut or cropped.
        assert_eq!(choose_mode(&none, &v, enc), Ok(VideoMode::Copy));
        assert_eq!(choose_mode(&trim, &v, enc), Ok(nv));
        assert_eq!(choose_mode(&cropped, &v, enc), Ok(nv));
        // A full-frame crop is no crop.
        let full = plan_edit(
            &v,
            Some(CropArg { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }),
            None,
            None,
            true,
        )
        .unwrap();
        assert!(!full.user_crop);
        assert_eq!(choose_mode(&full, &v, None), Ok(VideoMode::Copy));
        // A codec that cannot go into mp4 needs an encoder.
        let mut vp8 = v.clone();
        vp8.video_codec = "vp8".into();
        let e = choose_mode(&none, &vp8, None).unwrap_err();
        assert!(e.starts_with("editor:no_encoder:") && e.contains("vp8"));
        assert_eq!(choose_mode(&none, &vp8, enc), Ok(nv));
    }

    #[test]
    fn plan_edge_cases() {
        // Odd source size is cropped to even.
        let p = plan_edit(&probe(1281, 721, 10.0, false), None, None, None, true).unwrap();
        assert_eq!(p.crop, Some((1280, 720, 0, 0)));
        assert!(!p.user_crop, "even-size fix alone allows stream copy");
        assert!(!p.audio, "no audio stream means -an");
        // Crop larger than the frame is clamped.
        let p = plan_edit(
            &probe(1920, 1080, 10.0, false),
            Some(CropArg { x: 100.0, y: 0.0, w: 5000.0, h: 5000.0 }),
            None,
            None,
            false,
        )
        .unwrap();
        assert_eq!(p.crop, Some((1820, 1080, 100, 0)));
        // trimEnd at/after the end needs no -t.
        let p = plan_edit(&probe(1920, 1080, 10.0, false), None, Some(2.0), Some(99.0), false)
            .unwrap();
        assert_eq!(p.length, None);
        assert!((p.total - 8.0).abs() < 1e-9);
        // Bad values.
        let v = probe(1920, 1080, 10.0, true);
        assert!(plan_edit(&v, None, Some(f64::NAN), None, true).is_err());
        assert!(plan_edit(&v, None, Some(-1.0), None, true).is_err());
        assert!(plan_edit(&v, None, Some(10.0), None, true).is_err());
        assert!(plan_edit(&v, None, Some(5.0), Some(5.0), true).is_err());
        assert!(plan_edit(&v, None, None, Some(f64::INFINITY), true).is_err());
        let bad = |c: CropArg| plan_edit(&v, Some(c), None, None, true).is_err();
        assert!(bad(CropArg { x: -2.0, y: 0.0, w: 10.0, h: 10.0 }));
        assert!(bad(CropArg { x: 1920.0, y: 0.0, w: 10.0, h: 10.0 }));
        assert!(bad(CropArg { x: 0.0, y: 0.0, w: f64::NAN, h: 10.0 }));
        assert!(bad(CropArg { x: 0.0, y: 0.0, w: 0.0, h: 10.0 }));
    }

    #[test]
    fn path_rules() {
        assert!(validate_job_id("edit-1_a").is_ok());
        assert!(validate_job_id("../x").is_err());
        assert!(validate_job_id("").is_err());
        assert!(clean_absolute("-i").is_none());
        assert!(clean_absolute("relative/a.mp4").is_none());
        let base = if cfg!(windows) { r"C:\v" } else { "/v" };
        let sep = std::path::MAIN_SEPARATOR;
        assert!(clean_absolute(&format!("{base}{sep}a.mp4")).is_some());
        assert!(clean_absolute(&format!("{base}{sep}..{sep}a.mp4")).is_none());
        let part = part_path(Path::new(&format!("{base}{sep}clip.mp4")), "job1");
        assert_eq!(part, PathBuf::from(format!("{base}{sep}clip.job1.part.mp4")));
    }
}
