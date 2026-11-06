# 08 Download reliability changes

Engineer J (tests and docs). Other engineers' files are listed from the round's brief; confirm against the diffs.

## Tests (src/engine/__tests__)
- reliability.test.ts (new): runWithRetry (two network retries then success; no_space not retried), mapYtdlpError for no_space, permission, too_large, mux_failed, cancelled, empty; friendlyError rate-limit rule order (429 before login). Assumes runWithRetry is exported from ../download as `runWithRetry(fn, { delayMs })`.
- errors.test.ts, android-ytdlp.test.ts, ytdlp-args.test.ts, formats.test.ts: left unchanged. The code I could read still matched them (M4A -x rules, video embed off by default, 360p placeholder). If the new rule order, headlines, placeholders or MP3 note changed in code, these need a re-check.

## Docs
- README.md: Android troubleshooting now says TikTok/Instagram run on the phone via bundled yt-dlp, streams are combined without re-encoding, audio is M4A only, no MP3, about 30-45 MB; new "other TikTok and Instagram messages" entry in plain English.
- src/engine/CONTRACT.md: added ytdlp_cancel and ytdlp_mux, the downloadable muxed formatId, and the new error codes.
- plan-docs/08-download-reliability-changes.md: this file.

## Other files
Changes to errors.ts, types.ts, android-ytdlp.ts, formats.ts, download.ts, Kotlin/Rust plugin: owned by other engineers; not listed here.
