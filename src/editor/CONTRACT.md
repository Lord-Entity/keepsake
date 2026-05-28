# Editor contract

Status as of 2026-11-16. The source of truth for types is [`types.ts`](types.ts) (frozen: existing fields never change; new optional fields only). This file explains how the pieces fit and what is and is not tested.

## Scope

The Editor tab does five things to one local file at a time:

- **Crop** (free, or locked to Original, 1:1, 4:5, 9:16, 16:9, 4:3, 3:4), with zoom and pan in the preview.
- **Trim** (video): start and end points, minimum clip 0.1 s.
- **Mute** (video): drop the audio track.
- **Export**: photos to JPG (quality 1 to 100, default 92) or PNG; videos to MP4.
- **Save** next to the source or into the save folder (desktop), or by the Android save mode (Gallery, SAF folder or legacy folder).

Out of scope: filters, text, stickers, speed, rotation, multi-clip timelines, resizing to a set pixel size, audio editing beyond mute.

## Files

| File | Owner role | What it holds |
|---|---|---|
| `types.ts` | contract | `EditJob`, `MediaProbe`, `EditorEngine`, `EditorCapabilities`, `EditorError`, `validateJob` |
| `engine.ts` | engine | `editorEngine`: picks the platform module, caches probes, runs `validateJob` before every export, never-rejecting `capabilities` |
| `engine-photo.ts` | engine | Shared helpers (names, error mapping, probe parsing, progress gate, even crop, trim pruning) and the photo pipeline (`probePhoto`, `renderPhoto`) |
| `engine-desktop.ts` | engine | Windows/Linux: dialog picker, asset-protocol preview, Rust commands for video, plugin-fs for photos |
| `engine-android.ts` | engine | Android: media picker, Blob previews, `keepsake-media` plugin for video, save modes |
| `ui/crop-math.ts` | UI | Pure geometry: presets, clamp, even rounding, resize/move, screen/source mapping, zoom/pan, trim clamp |
| `ui/CropStage.tsx`, `ui/TrimBar.tsx`, `ui/EditorControls.tsx`, `../pages/Editor.tsx` | UI | The page |
| `../../src-tauri/src/editor.rs` | desktop native | ffmpeg probe, export, cancel, capability detection |
| `../../src-tauri/plugins/keepsake-media/android/src/main/java/KeepsakeEditor.kt` | Android native | Media3 Transformer export, MediaMetadataRetriever probe |

## Flow

1. `capabilities(kind)` tells the UI which controls to enable (and a `note` explaining any limit). It never rejects; a failed check returns the full set and lets the export report the real error.
2. `pickMedia()` returns an `EditorInput` (`path` on desktop, `content://` `uri` on Android) or `null` when the user cancels.
3. `probe(input)` returns `MediaProbe` with display-oriented `width`/`height` (rotation already applied), `duration` in seconds (0 for photos) and `hasAudio`. `engine.ts` caches the last 8 probes per file.
4. `previewUrl(input)` returns a URL for `<img>`/`<video>`: an `asset:` URL on desktop, a `blob:` URL on Android and web (the caller revokes it).
5. The UI keeps the crop in **source pixels** and maps it to the screen with `crop-math.ts` (`screen = source * scale + (tx, ty)`). Video crops are rounded to even values.
6. `exportEdit(job, onProgress, signal)`: `engine.ts` throws if the signal is already aborted, probes (cached), runs `validateJob` and rejects with `invalid_job` and its message, then calls the platform module. Progress is clamped to 0..1, never goes backwards, and ends at 1.

## Types (summary)

- `EditJob`: `input`, optional `crop` (`CropRect`, source pixels), optional `trimStart`/`trimEnd` (video, seconds), `audio`, `output` (`mp4` | `jpg` | `png`), optional `quality` (jpg).
- `validateJob` rules, in order: crop values finite; crop at least 2x2; crop inside the frame (0.5 px tolerance); video trim `0 <= start < end <= duration + 0.05`; a photo cannot export MP4; a video must export MP4.
- `EditResult`: `{ path, name }`. `path` is a file path (desktop, Android legacy mode), a `content://` URI (Gallery or SAF folder), or a download name (web preview).

## Engine interface per platform

Every platform module implements `PlatformEngine` (in `engine-photo.ts`): the `EditorEngine` methods, except that `exportEdit` also receives the probe.

### Desktop (Windows, Linux)

Rust commands in `src-tauri/src/editor.rs`:

| Command | Arguments | Result |
|---|---|---|
| `editor_probe` | `{ path }` | `{ width, height, duration, hasAudio, rotation }` (parsed from `ffmpeg -i` stderr; ffprobe is not bundled) |
| `edit_video` | `{ jobId, input, output, crop \| null, trimStart \| null, trimEnd \| null, audio, onEvent }` | resolves on success; `onEvent` is a Channel of `{ progress }` then `{ done: true }` |
| `cancel_edit` | `{ jobId }` | the running `edit_video` rejects with `editor:cancelled` |
| `editor_capabilities` | none | `{ copyOnly, canReencode, encoder }` |

- The bundled minimal LGPL ffmpeg has no H.264 encoder or decoder, so with it alone the editor runs in **copy mode**: trim and mute by stream copy, and the trim start snaps to the keyframe at or before it. **Cropping needs a full ffmpeg** (libx264 or a hardware H.264 encoder) on PATH; `editor.rs` finds it and test-encodes hardware encoders first. See [`docs/EDITOR_DESKTOP_ENCODER.md`](../../docs/EDITOR_DESKTOP_ENCODER.md).
- ffmpeg writes to `<stem>.<jobId>.part.mp4` and renames onto the output only on success.
- JS sends `crop: null` for no crop or a full-frame crop, and `trimStart`/`trimEnd: null` when they equal the file's own start/end. `audio` is `job.audio && probe.hasAudio`.
- Output: `<name>_edit.mp4` (or `_edit (n)`) in Settings > save folder when it is an absolute path, else next to the source. Photos are written by plugin-fs and fall back to Downloads when the source folder is outside the fs scope.
- Cancel: the abort listener sends `cancel_edit`, re-sent on the first event and after 500 ms (the job may not be registered yet). The partial output is removed.

### Android

`keepsake-media` plugin commands (`plugin:keepsake-media|...`):

| Command | Arguments | Result |
|---|---|---|
| `editor_probe` | `{ uri }` | `{ width, height, duration, hasAudio, rotation }` (MediaMetadataRetriever) |
| `editor_export_video` | `{ uri, outPath, crop?, trimStart?, trimEnd?, audio }` | `{ path }` |
| `editor_cancel` | `{}` | the running export rejects with `editor:cancelled` |

- Export runs on **AndroidX Media3 Transformer 1.8.1** (hardware codecs; H.264 video and AAC audio in MP4), one export at a time. Crop and trim are frame-accurate.
- Progress arrives as the plugin event `keepsake-editor-progress` `{ fraction }`.
- `outPath` must be an `.mp4` inside the app cache (checked in Kotlin), so every save mode exports into a staging folder there. Gallery and folder modes then publish it with `publishToGallery` or `saveToFolder`; legacy mode copies it in 8 MB chunks (plugin-fs `open` read/write) to `<name>_edit.mp4` in Settings saveDir or Downloads, and a failed or cancelled copy is removed.
- The staging folder is `$APPCACHE/gallery-editor-<base36 ms>-<rand>/` (built with `join(appCacheDir(), ...)` like download.ts `runStaged`). The `gallery-` prefix is required: the plugin's `gallery_publish` / `folder_save` refuse any source outside `cacheDir/gallery-<id>/` (KeepsakeMediaPlugin.kt `stagedSource`). The old `editor-<id>` name made every Gallery/folder save of an edit fail (folder mode showed "went missing before it could be saved").
- Cleanup order matches `runStaged`: the stage is removed after a successful save (or a cancel). After a failed save whose file is still staged, the stage is kept and exporting the same `EditJob` again (the error toast's Retry) re-saves that file without re-encoding; a different export, leaving the editor (`releaseEditorStage` in engine.ts) or the once-per-run sweep of `gallery-editor-*` folders older than 1 hour removes it.
- Save-step failures read "Your edit was made, but Keepsake couldn't save it to the Gallery / your folder. <reason> Tap Retry ... (Details: gallery|folder:<code>: <plugin text>)" and carry `stepOf(e) === "save"` (engine-photo.ts); a missing staged file after export is `stepOf(e) === "export"`.
- Picker URIs without a file name get the kind from the URI (`video/`, `image/`) or, for opaque photo-picker URIs, from a native probe (a duration means video). The name is then `VID_<stamp>.mp4` or `IMG_<stamp>.jpg`.
- Video previews are read into a Blob in 8 MB chunks; videos over 1 GB are not previewed (`unsupported`).

### Photos (all platforms)

Decoded in the webview with `createImageBitmap(..., { imageOrientation: "from-image" })` (EXIF applied, so `rotation` is 0), cropped on an `OffscreenCanvas` (or `<canvas>`), and encoded to JPEG (on white) or PNG. No native code.

### Web (dev preview)

`vite` dev only: photos work and download through an `<a download>`; video export rejects with `unsupported`.

## Error codes

Every rejection is an `EditorError` with one of these codes. Native rejections of the form `editor:<code>: <message>` (or a bare `editor:<code>`) are mapped by `mapNativeError`. Desktop `editor.rs` codes are translated: `invalid` -> `invalid_job`, `no_encoder` and `no_ffmpeg` -> `unsupported`, `no_video` -> `probe_failed`; `failed` and any other unknown code become the caller's fallback (`probe_failed` while probing, `export_failed` on export). Plain OS text is matched for cancel, no space and permission.

| Code | Meaning | Typical source |
|---|---|---|
| `unsupported` | The device or build cannot do it (missing plugin or command, undecodable picture, preview over 1 GB, `editor:unsupported`, desktop `editor:no_encoder` / `editor:no_ffmpeg`) | both |
| `cancelled` | The user aborted, or the native side reported `editor:cancelled` | both |
| `probe_failed` | The file could not be read, has no video stream (desktop `editor:no_video`), or the probe reply was malformed | both |
| `export_failed` | Anything else during export, including desktop `editor:failed` | both |
| `no_space` | Out of storage (`ENOSPC`, `os error 28/112`, `editor:no_space`, Gallery or folder `no_space`) | both |
| `permission` | Read or write refused (`EACCES`, `os error 5/13`, SAF revoked, Gallery permission, folder `not_found`) | both |
| `invalid_job` | `validateJob` failed, the input has no path/URI, or desktop `editor:invalid` | both |

## Limits

| Limit | Value | Where |
|---|---|---|
| Smallest crop | 16 px (less for tiny sources, never under 2) in the UI; 2x2 in `validateJob` | `crop-math.ts`, `types.ts` |
| Video crop alignment | even x, y, w, h | `crop-math.ts`, `engine-photo.ts` |
| Shortest trim | 0.1 s | `crop-math.ts`, `editor.rs`, `KeepsakeEditor.kt` |
| Zoom | 0.5x to 8x of the fit scale | `crop-math.ts` |
| JPEG quality | 1 to 100, default 92 | `engine-photo.ts` |
| Android video preview | 1 GB | `engine-android.ts` |
| Output file name | `<stem>_edit`, stem cut to 80 characters, unsafe characters replaced | `engine-photo.ts` |

## Tests

Unit tests live in `src/editor/__tests__/` and run with `bun test` (bun finds every `*.test.ts`; `tsconfig.json` excludes `__tests__`, so each file starts with `// @ts-nocheck`):

| File | Covers |
|---|---|
| `types.test.ts` | every `validateJob` branch and tolerance; `EditorError` |
| `crop-math.test.ts` | presets and ratios, clamping, even rounding, move/resize (free and locked), fit/zoom/pan, screen/source round trip, trim clamp, time format |
| `engine-photo.test.ts` | name helpers, `mapNativeError` (all codes and OS texts), `parseProbe`, `progressGate`, `videoCrop`, `videoTrim`, `probePhoto`/`renderPhoto` on a fake canvas |
| `engine-desktop.test.ts` | capabilities, picker, probe, preview URL, `edit_video` argument mapping, naming and save folder, progress, cancel, Rust error strings, photo save fallback |
| `engine-android.test.ts` | picker URI to kind/name, probe cache from picking, previews (chunked, 1 GB cap), `editor_export_video` arguments, progress events, legacy/Gallery/folder saving, cancel, error mapping |
| `engine.test.ts` | platform dispatch, probe cache, `validateJob` gating, never-rejecting capabilities |

Mocks follow `src/engine/__tests__`: `mock.module` for `@tauri-apps/*`, `../../state/settings` and `../../engine/platform`; `createImageBitmap`, `OffscreenCanvas` and `URL.createObjectURL` are swapped on `globalThis` and restored. `bun:test` `mock.module` is process-wide, so these mocks stay active for test files that run later; no other test file depends on the real plugin-fs, path or dialog modules today.

### Not tested

- The tests have not been run yet (they were written without running `bun test`). Run `bun test src/editor` before relying on them.
- React components (`Editor.tsx`, `CropStage.tsx`, `TrimBar.tsx`, `EditorControls.tsx`): no DOM test setup in this repo.
- Real decoding and encoding: canvas, `createImageBitmap` EXIF handling and Tauri channels are fakes.
- `editor.rs`: ffmpeg argument building, probe parsing and encoder detection are covered only by its own `#[cfg(test)]` Rust tests (run with `cargo test`), not here.
- `KeepsakeEditor.kt`: no Android instrumentation tests. Media3 behaviour (HDR input, odd codecs, low storage) needs a device.
- The web dev-preview engine in `engine.ts` (needs a DOM).
