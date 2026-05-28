#!/usr/bin/env bash
# Builds libffmpeg.so: a minimal LGPL FFmpeg 7.1.1 *executable* for Android arm64-v8a (API 24), with LAME
# 3.100 and Opus 1.5.2 linked in statically. Keepsake's in-process yt-dlp runs it (fork/exec from
# nativeLibraryDir) to merge bestvideo+bestaudio, remux/fix up HLS/DASH and extract audio. It is a program,
# not a library: the .so name only makes Android extract it to nativeLibraryDir (see plan 11, section 3.1).
#
# The configure allow-lists mirror the LGPL recipe of ffmpeg-ytdl-minimal-build (build.sh, FFmpeg n7.1.1),
# the build desktop already ships, adapted to the NDK. Differences from that recipe:
#   - cross-compiled with NDK clang for aarch64-linux-android24, 16 KiB page-aligned LOAD segments;
#   - ffmpeg only, no ffprobe (yt-dlp falls back to `ffmpeg -i`, same as desktop);
#   - FFmpeg comes from the release tarball (sha256-pinned) instead of a git clone;
#   - zlib is the NDK's system libz.so (a stable public NDK library) instead of a static one.
# No --enable-gpl / --enable-nonfree; the script fails if the configured licence is not LGPL 2.1+.
#
#   bash scripts/build-android-ffmpeg.sh
#
# Environment:
#   ANDROID_NDK_HOME | ANDROID_NDK_ROOT | NDK_HOME   NDK root (first one set wins). Required. CI: r27c 27.2.12479018.
#   OUT_DIR                 where libffmpeg.so goes (default: android.jniLibsDir from the lock, i.e.
#                           src-tauri/plugins/keepsake-media/android/src/main/jniLibs/arm64-v8a)
#   KEEPSAKE_ANDROID_CACHE  cache dir (default: android.cacheDir from the lock). Gets libffmpeg.so,
#                           libffmpeg.so.sha256 and sources/ (the exact FFmpeg/LAME/Opus tarballs used plus a
#                           copy of this script: the LGPL "corresponding source" to attach to releases).
#   WORK_DIR                scratch dir, must not contain spaces (default: mktemp -d; deleted unless KEEP_WORK=1)
#   JOBS                    parallel make jobs (default: nproc)
# Needs: bash, curl, python3, sha256sum, tar with xz, make, pkg-config (host), the NDK. Linux x86_64 host only.
# Output check (fails the script on any miss): AArch64 PIE, interpreter /system/bin/linker64, every LOAD
# aligned >= 16 KiB, DT_NEEDED only bionic system libs, licence LGPL, libmp3lame/libopus encoders enabled.
set -euo pipefail

die() { echo "::error::build-android-ffmpeg: $*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
LOCK="$HERE/binaries.lock.json"
API=24
TARGET=aarch64-linux-android

# ---- tools -------------------------------------------------------------------------------------------
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${NDK_HOME:-}}}"
[ -n "$NDK" ] || die "set ANDROID_NDK_HOME (or ANDROID_NDK_ROOT / NDK_HOME) to the NDK root"
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
CC="$TC/bin/${TARGET}${API}-clang"
CXX="$TC/bin/${TARGET}${API}-clang++"
AR="$TC/bin/llvm-ar"
NM="$TC/bin/llvm-nm"
RANLIB="$TC/bin/llvm-ranlib"
STRIP="$TC/bin/llvm-strip"
READELF="$TC/bin/llvm-readelf"
for t in "$CC" "$AR" "$NM" "$RANLIB" "$STRIP" "$READELF"; do
  [ -x "$t" ] || die "NDK tool not found: $t"
done
for t in curl python3 sha256sum tar xz make pkg-config; do
  command -v "$t" >/dev/null 2>&1 || die "host tool not found: $t"
done
JOBS="${JOBS:-$(nproc)}"

# ---- pinned sources from the lock --------------------------------------------------------------------
# Lines: jniLibsDir<TAB>cacheDir, then name<TAB>version<TAB>url<TAB>sha256 for ffmpeg, lame, opus.
LOCKINFO="$(python3 - "$LOCK" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))["android"]
print("%s\t%s" % (a["jniLibsDir"], a["cacheDir"]))
for k in ("ffmpeg", "lame", "opus"):
    s = a["sources"][k]
    sha = s.get("sha256", "").strip().lower()
    if len(sha) != 64:
        sys.exit("binaries.lock.json android.sources.%s has no sha256; refusing to build from an unverified tarball" % k)
    print("\t".join([k, s["version"], s["url"], sha]))
PY
)" || die "cannot read the android section of $LOCK"

IFS=$'\t' read -r JNI_REL CACHE_REL <<< "$(printf '%s\n' "$LOCKINFO" | head -n1)"
OUT_DIR="${OUT_DIR:-$ROOT/$JNI_REL}"
CACHE="${KEEPSAKE_ANDROID_CACHE:-$ROOT/$CACHE_REL}"
SOURCES="$CACHE/sources"
mkdir -p "$OUT_DIR" "$SOURCES"

if [ -n "${WORK_DIR:-}" ]; then mkdir -p "$WORK_DIR"; else WORK_DIR="$(mktemp -d)"; fi
case "$WORK_DIR" in *" "*) die "WORK_DIR must not contain spaces (FFmpeg's configure breaks): $WORK_DIR" ;; esac
trap '[ "${KEEP_WORK:-0}" = 1 ] || rm -rf "$WORK_DIR"' EXIT
DEPS="$WORK_DIR/deps"
mkdir -p "$WORK_DIR/dl" "$DEPS"

# Download, verify, extract. Sets FFMPEG_SRC / LAME_SRC / OPUS_SRC.
while IFS=$'\t' read -r name version url sha; do
  file="$(basename "$url")"
  echo ">> $name $version: $url"
  # Re-download on a hash mismatch too (a mirror may serve an HTML page with 200 OK).
  got=""
  for attempt in 1 2 3; do
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o "$WORK_DIR/dl/$file" "$url" || die "download failed: $url"
    got="$(sha256sum "$WORK_DIR/dl/$file" | cut -d' ' -f1)"
    [ "$got" = "$sha" ] && break
    echo "   sha256 mismatch for $file (attempt $attempt): got $got" >&2
    sleep 5
  done
  [ "$got" = "$sha" ] || die "sha256 mismatch for $file: expected $sha, got $got"
  echo "   sha256 OK ($got)"
  cp -f "$WORK_DIR/dl/$file" "$SOURCES/$file"
  mkdir -p "$WORK_DIR/src/$name"
  case "$file" in
    *.tar.xz) tar -xJf "$WORK_DIR/dl/$file" -C "$WORK_DIR/src/$name" --strip-components=1 ;;
    *.tar.gz) tar -xzf "$WORK_DIR/dl/$file" -C "$WORK_DIR/src/$name" --strip-components=1 ;;
    *) die "unexpected archive type: $file" ;;
  esac
done < <(printf '%s\n' "$LOCKINFO" | tail -n +2)
FFMPEG_SRC="$WORK_DIR/src/ffmpeg"
LAME_SRC="$WORK_DIR/src/lame"
OPUS_SRC="$WORK_DIR/src/opus"
cp -f "$HERE/build-android-ffmpeg.sh" "$SOURCES/build-android-ffmpeg.sh"

# Autotools cross settings shared by LAME and Opus.
export CC CXX AR NM RANLIB STRIP
DEP_CFLAGS="-O2 -fPIC"
# LAME 3.100 ships 2017-era config.sub/config.guess; use Opus 1.5.2's newer copies (2024 autotools), which
# certainly know aarch64-linux-android.
OPUS_AUX="$(dirname "$(find "$OPUS_SRC" -maxdepth 2 -name config.sub -print | head -n1)")"
[ -f "$OPUS_AUX/config.sub" ] && [ -f "$OPUS_AUX/config.guess" ] || die "config.sub/config.guess not found in the Opus tarball"
BUILD_TRIPLE="$(sh "$OPUS_AUX/config.guess")" || die "config.guess failed"

# ---- 1. LAME 3.100 (static) --------------------------------------------------------------------------
echo ">> building static LAME"
cp -f "$OPUS_AUX/config.sub" "$OPUS_AUX/config.guess" "$LAME_SRC/"
# lame_init_old is listed in the export file but not built (same fix as the desktop recipe).
sed -i '/lame_init_old/d' "$LAME_SRC/include/libmp3lame.sym"
(
  cd "$LAME_SRC"
  ./configure --host="$TARGET" --build="$BUILD_TRIPLE" --prefix="$DEPS" \
    --disable-shared --enable-static --disable-frontend --disable-decoder --enable-nasm=no \
    CFLAGS="$DEP_CFLAGS"
  make -j"$JOBS"
  make install
) || die "LAME build failed"

# ---- 2. Opus 1.5.2 (static) --------------------------------------------------------------------------
echo ">> building static Opus"
(
  cd "$OPUS_SRC"
  ./configure --host="$TARGET" --build="$BUILD_TRIPLE" --prefix="$DEPS" \
    --disable-shared --enable-static --disable-doc --disable-extra-programs \
    CFLAGS="$DEP_CFLAGS"
  make -j"$JOBS"
  make install
) || die "Opus build failed"
[ -f "$DEPS/lib/libmp3lame.a" ] || die "libmp3lame.a missing after install"
[ -f "$DEPS/lib/pkgconfig/opus.pc" ] || die "opus.pc missing after install"

# ---- 3. FFmpeg 7.1.1 ---------------------------------------------------------------------------------
# Same allow-lists as ffmpeg-ytdl-minimal-build build.sh (see that file for the reason behind each entry).
DEMUXERS="mov,matroska,aac,mp3,ogg,flac,wav,mpegts,concat,ffmetadata,image2,image_png_pipe,image_jpeg_pipe,image_webp_pipe"
MUXERS="mp4,ipod,mov,matroska,webm,mp3,ogg,opus,flac,wav,adts,image2,null"
DECODERS="aac,mp3float,opus,vorbis,flac,pcm_s16le,pcm_s24le,pcm_f32le,png,mjpeg,webp,vp9"
ENCODERS="libmp3lame,aac,libopus,flac,pcm_s16le,png,mjpeg"
PARSERS="aac,h264,hevc,vp8,vp9,av1,opus,vorbis,mpegaudio,flac,png,mjpeg,webp"
BSFS="aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe,vp9_superframe_split,av1_frame_merge,av1_frame_split,extract_extradata,setts,mjpeg2jpeg,null"
FILTERS="aresample,aformat,anull,atrim,format,null,trim,scale,copy,acopy"

echo ">> configuring FFmpeg (minimal, LGPL, android arm64)"
cd "$FFMPEG_SRC"
# Only our static deps are visible to pkg-config, never host libraries.
unset PKG_CONFIG_PATH
export PKG_CONFIG_LIBDIR="$DEPS/lib/pkgconfig"
./configure \
  --disable-all \
  --enable-cross-compile \
  --target-os=android \
  --arch=aarch64 \
  --cpu=armv8-a \
  --cc="$CC" \
  --cxx="$CXX" \
  --ar="$AR" \
  --nm="$NM" \
  --ranlib="$RANLIB" \
  --strip="$STRIP" \
  --enable-pic \
  --extra-cflags="-I$DEPS/include -O2" \
  --extra-ldflags="-L$DEPS/lib -Wl,-z,max-page-size=16384" \
  --extra-libs="-lm" \
  --enable-ffmpeg \
  --enable-avcodec \
  --enable-avformat \
  --enable-avutil \
  --enable-avfilter \
  --enable-swresample \
  --enable-swscale \
  --enable-protocol=file,pipe \
  --enable-demuxer="$DEMUXERS" \
  --enable-muxer="$MUXERS" \
  --enable-decoder="$DECODERS" \
  --enable-encoder="$ENCODERS" \
  --enable-parser="$PARSERS" \
  --enable-bsf="$BSFS" \
  --enable-filter="$FILTERS" \
  --enable-libmp3lame \
  --enable-libopus \
  --enable-zlib \
  --disable-autodetect \
  --enable-small \
  --disable-doc \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-network \
  --disable-debug \
  --pkg-config=pkg-config \
  --pkg-config-flags=--static \
  || { tail -n 60 ffbuild/config.log >&2 || true; die "FFmpeg configure failed (config.log tail above)"; }

# Licence and feature gates: configure must not silently produce a GPL build or drop an encoder.
grep -q '^CONFIG_GPL=yes' ffbuild/config.mak && die "configured as GPL"
grep -q '^CONFIG_NONFREE=yes' ffbuild/config.mak && die "configured as nonfree"
grep -qF '"LGPL version 2.1 or later"' config.h || die "FFMPEG_LICENSE is not 'LGPL version 2.1 or later'"
for c in CONFIG_LIBMP3LAME_ENCODER CONFIG_LIBOPUS_ENCODER CONFIG_ZLIB CONFIG_MOV_DEMUXER CONFIG_MPEGTS_DEMUXER \
         CONFIG_MATROSKA_MUXER CONFIG_MP4_MUXER CONFIG_AAC_ADTSTOASC_BSF; do
  grep -q "^$c=yes" ffbuild/config.mak || die "$c is not enabled after configure"
done

echo ">> building FFmpeg"
make -j"$JOBS" ffmpeg || die "FFmpeg build failed"
[ -f ffmpeg ] || die "ffmpeg binary missing after make"

# ---- 4. install + verify -----------------------------------------------------------------------------
"$STRIP" -o "$WORK_DIR/libffmpeg.so" ffmpeg
SO="$WORK_DIR/libffmpeg.so"

HDR="$("$READELF" -hW "$SO")" || die "llvm-readelf -h failed"
printf '%s\n' "$HDR" | grep -E '^[[:space:]]*Machine:' | grep -q 'AArch64' || die "ELF machine is not AArch64"
printf '%s\n' "$HDR" | grep -E '^[[:space:]]*Type:' | grep -q 'DYN' || die "ELF type is not DYN (Android needs a PIE)"
PH="$("$READELF" -lW "$SO")" || die "llvm-readelf -l failed"
printf '%s\n' "$PH" | grep -qF '[Requesting program interpreter: /system/bin/linker64]' \
  || die "program interpreter is not /system/bin/linker64"
# The last field of each LOAD line is its alignment in hex; it must be >= 0x4000 (16 KiB pages).
LOADS="$(printf '%s\n' "$PH" | awk '$1=="LOAD" { print $NF }')"
[ -n "$LOADS" ] || die "no LOAD segments found"
for a in $LOADS; do
  [ "$(( a ))" -ge 16384 ] 2>/dev/null || die "LOAD segment aligned below 16 KiB (align $a)"
done
NEEDED="$("$READELF" -dW "$SO" | sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p' | sort -u | tr '\n' ' ')"
for lib in $NEEDED; do
  case "$lib" in
    libc.so|libm.so|libdl.so|libz.so|liblog.so) ;;
    *) die "unexpected DT_NEEDED $lib (only bionic system libraries are available to an exec'd binary)" ;;
  esac
done

cp -f "$SO" "$OUT_DIR/libffmpeg.so"
cp -f "$SO" "$CACHE/libffmpeg.so"
chmod 755 "$OUT_DIR/libffmpeg.so" "$CACHE/libffmpeg.so"
SHA="$(sha256sum "$SO" | cut -d' ' -f1)"
printf '%s  libffmpeg.so\n' "$SHA" > "$CACHE/libffmpeg.so.sha256"
SIZE="$(wc -c < "$SO" | tr -d ' ')"
(cd "$SOURCES" && find . -maxdepth 1 -type f ! -name 'SHA256SUMS.txt*' -printf '%f\n' | sort \
  | xargs sha256sum -- > SHA256SUMS.txt.tmp && mv -f SHA256SUMS.txt.tmp SHA256SUMS.txt)

echo ">> done: $OUT_DIR/libffmpeg.so ($SIZE bytes, sha256 $SHA)"
echo ">> DT_NEEDED: $NEEDED"
echo ">> corresponding source: $SOURCES"
ls -l "$SOURCES"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### libffmpeg.so (FFmpeg 7.1.1 minimal LGPL, android arm64, API $API)"
    echo ""
    echo "- bytes: $SIZE, sha256: \`$SHA\`"
    echo "- DT_NEEDED: $NEEDED"
    echo "- sources (attach to releases): $(cd "$SOURCES" && ls | tr '\n' ' ')"
  } >> "$GITHUB_STEP_SUMMARY"
fi
