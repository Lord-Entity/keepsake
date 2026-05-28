# Desktop editor: which ffmpeg encodes what

Status as of 2026-11-16. Code: `src-tauri/src/editor.rs`.

## The bundled sidecar

`keepsake-ffmpeg` is pinned in `scripts/binaries.lock.json` (FFmpeg 7.1.1 minimal LGPL
build, v1.1.0 of ffmpeg-ytdl-minimal-build). Checked on the Windows binary with
`-encoders/-decoders/-muxers/-demuxers/-filters/-bsfs`:

| Has | Lacks |
| --- | --- |
| mov/mp4, matroska/webm, mpegts demuxers; mp4, mov, matroska muxers | any video encoder except mjpeg and png |
| aac, flac, libmp3lame, libopus encoders | H.264 / HEVC / AV1 decoders (only vp8, vp9, mjpeg, png, webp) |
| aac, mp3, opus, vorbis, flac decoders | lavfi input device |
| crop, scale, transpose, trim filters | h264_metadata bitstream filter |

So it can stream-copy (remux) but cannot crop an H.264 video: crop needs a decode and
an encode, and it has neither.

## What the editor does now

- **Copy mode** (`-c:v copy`) for trim and mute when nothing is cropped and the video
  codec fits in .mp4 (h264, hevc, av1, vp9, mpeg4). Audio is copied when it fits
  (aac, mp3, alac, opus, flac, ac3, eac3), otherwise re-encoded to AAC; mute is `-an`.
  Seek is `-ss` before `-i` plus `-avoid_negative_ts make_zero`. Tested with the
  bundled binary: works, and **the cut snaps to the keyframe at or before trimStart**,
  so the clip can start up to one GOP early (often 1 to 2 s for phone video; a
  one-GOP clip keeps everything). The end is accurate to the packet.
- **Encode mode** for crop, for frame-accurate trims when an encoder exists, and for
  codecs that cannot be copied (e.g. vp8). Encoders tried in this order, across the
  bundled sidecar and every `ffmpeg` on PATH (plus WinGet Links on Windows,
  `/usr/local/bin`, `/usr/bin`): libx264, h264_nvenc, h264_qsv, h264_amf, h264_mf,
  h264_videotoolbox, libopenh264, mpeg4. Hardware encoders are listed by full builds
  even without the hardware, so each must pass a 5-frame test encode (lavfi, 15 s
  timeout) before it is used.
- h264_vaapi is left out: it needs a device path and a `format=nv12,hwupload` filter
  chain, and Linux users with a full ffmpeg nearly always have libx264 anyway.
- No ffmpeg encoder: `edit_video` rejects with the plain string `editor:no_encoder: ...`
  and the JS side crops **inside the app** (no install needed), in this order
  (`src/editor/engine-desktop.ts` `exportInApp`):
  1. **WebCodecs** (`engine-webcodecs.ts`): the bundled ffmpeg stream-copies the source
     (up to the trim end + 1 s) into a plain .mp4 in the app cache; the webview decodes it
     (VideoDecoder), crops/rotates on a canvas, encodes H.264 (VideoEncoder; Media
     Foundation on Windows), and `mp4-mux.ts` writes the .mp4. Audio packets are copied
     unchanged. Faster than real time. Limit: the part read into memory must be under
     768 MB (`MAX_IN_APP_BYTES`, from the `size` editor_probe now returns), because the
     pre-cut file is read whole with `readFile`. Since 2026-11-16 both capabilities grant
     `fs:allow-read`, `fs:allow-seek` and `fs:allow-fstat` (they act only on a handle that
     `open` returned, so the path scope is unchanged), so a streaming reader could lift
     this cap later; the code does not do that yet.
  2. **Real-time recording** (`engine-webcrop.ts`, MediaRecorder).
  3. Neither: a clear error listing each attempt; trim and sound off still work.
  Both outputs are moved into place by `edit_video` in copy mode (faststart).
  `editor_capabilities` + the webview check decide what the UI offers: crop is on when
  any path exists (note says fast vs real time).

## Should the sidecar be switched to a build with an encoder?

Not now. Reasons:

1. **No verifiable artifact.** The pins need an exact URL and a sha256 published by the
   release or computed from the exact file. Candidate LGPL builds that include
   `h264_mf`/nvenc/qsv/amf (for example the BtbN FFmpeg-Builds `win64-lgpl` variants)
   ship as .zip/.tar.xz archives, and their "latest" assets are rolling. That needs a
   dated release tag, a published checksum, and archive extraction added to both
   `scripts/fetch-binaries.ps1` and `.sh`. Not done without verifying the file.
2. **Size.** A full LGPL build is many times larger than the minimal one, and the same
   binary is the ffmpeg yt-dlp uses for every download.
3. **Patents, not copyright.** LGPL keeps the licence posture, but shipping an H.264
   decoder or encoder raises patent questions the minimal build avoids. OpenH264 is
   royalty-covered only as Cisco's own prebuilt binary downloaded on the user's
   machine, not when compiled into our ffmpeg. `h264_mf` (Windows) and
   `h264_videotoolbox` (macOS) use the OS codec, which is the lowest-risk option.
4. **Never GPL.** No libx264 build may go into the bundle (PolyForm Noncommercial app;
   GPL would change what we ship). libx264 is only used when the user installed it.

## Recommended next step (for the maintainer)

Pick one, decide on patents first:

- **Windows/macOS, smallest change:** extend the minimal build recipe with
  `--enable-mediafoundation` (Windows) / `--enable-videotoolbox` (macOS), plus the
  native h264 and hevc decoders and the `lavfi` device. Publish it as a single file
  per platform with a SHA256SUMS.txt, then update `binaries.lock.json` (url, sha256,
  version) only. No script change needed. `editor.rs` picks up `h264_mf` /
  `h264_videotoolbox` automatically after its test encode.
- **Or** pin a dated BtbN `lgpl` release and teach the fetch scripts to extract
  `bin/ffmpeg(.exe)` from the archive, verifying the archive's sha256 before
  extraction.

Until then crop runs through the in-app paths above; a user-installed ffmpeg is only
used when present (it is tried first).
