#!/usr/bin/env bash
# build-android-qjs.sh - FALLBACK build of QuickJS-NG `qjs` for Android arm64.
#
# Produces an executable named libqjs.so (so Android's package installer
# extracts it into nativeLibraryDir). Used only if the upstream static-musl
# `qjs-linux-aarch64` release asset fails on devices. Intended for GitHub
# Actions ubuntu-latest (cmake, ninja or make, python3, curl, sha256sum, NDK).
#
# Inputs
#   NDK dir (first one set wins): $ANDROID_NDK_HOME, $ANDROID_NDK_ROOT, $NDK_HOME
#   scripts/binaries.lock.json (read with python3):
#     .android.sources["quickjs-ng"] = {version,url,sha256,license}
#     .android.cacheDir = repo-relative cache dir
#       (default src-tauri/plugins/keepsake-media/android/.native-cache)
#   KEEPSAKE_ANDROID_CACHE   overrides the cache dir (absolute or repo-relative)
#   WORK_DIR                 scratch dir (default mktemp -d; no spaces allowed;
#                            removed on exit unless KEEP_WORK=1)
#   JOBS                     parallel jobs (default nproc)
#   ALLOW_UNPINNED_SOURCE=1  proceed when the lock sha256 is empty (otherwise
#                            the build fails closed)
#
# Outputs: $CACHE/libqjs.so, $CACHE/libqjs.so.sha256, $CACHE/sources/<tarball>.
# Does NOT write to jniLibs; scripts/fetch-android-binaries.sh copies from the
# cache when KEEPSAKE_ANDROID_USE_BUILT contains libqjs.so.
#
# CMake facts (https://raw.githubusercontent.com/quickjs-ng/quickjs/v0.18.0/CMakeLists.txt):
#   - the CLI target is `qjs_exe` with OUTPUT_NAME "qjs" (file: <build>/qjs);
#     it links the `qjs` library and `qjs-libc` static lib, and sets
#     ENABLE_EXPORTS (-rdynamic) on non-Windows.
#   - options (all default OFF unless noted): BUILD_SHARED_LIBS,
#     QJS_BUILD_EXAMPLES, QJS_BUILD_CLI_STATIC (-static; NOT wanted on bionic),
#     QJS_BUILD_CLI_WITH_MIMALLOC, QJS_BUILD_LIBC, QJS_BUILD_WERROR,
#     QJS_ENABLE_INSTALL (default ON).
#   - run-test262/api-test/lre-test are always defined, so we build only the
#     qjs_exe target instead of "all".
set -euo pipefail

die() { echo "::error::build-android-qjs: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
LOCK="$SCRIPT_DIR/binaries.lock.json"

# ---- NDK ----
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${NDK_HOME:-}}}"
[ -n "$NDK" ] || die "none of ANDROID_NDK_HOME, ANDROID_NDK_ROOT, NDK_HOME is set"
[ -d "$NDK" ] || die "NDK directory not found: $NDK"
TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake"
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
[ -f "$TOOLCHAIN_FILE" ] || die "missing $TOOLCHAIN_FILE"
[ -x "$BIN/llvm-strip" ] || die "missing $BIN/llvm-strip"
[ -x "$BIN/llvm-readelf" ] || die "missing $BIN/llvm-readelf"

for t in python3 curl sha256sum cmake tar; do
  command -v "$t" >/dev/null 2>&1 || die "required tool not found: $t"
done
[ -f "$LOCK" ] || die "missing lock file $LOCK"

# ---- lock file ----
lock_get() {
  # $1 = python expression over dict d; prints a string ('' when missing)
  python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
try:
    v = eval(sys.argv[2], {"__builtins__": {}}, {"d": d})
except Exception:
    v = ""
print("" if v is None else v)
' "$LOCK" "$1"
}
SRC_VERSION="$(lock_get 'd["android"]["sources"]["quickjs-ng"]["version"]')"
SRC_URL="$(lock_get 'd["android"]["sources"]["quickjs-ng"]["url"]')"
SRC_SHA="$(lock_get 'd["android"]["sources"]["quickjs-ng"]["sha256"]')"
LOCK_CACHE="$(lock_get 'd["android"]["cacheDir"]')"
[ -n "$SRC_URL" ] || die "lock file has no .android.sources[\"quickjs-ng\"].url"
[ -n "$SRC_VERSION" ] || SRC_VERSION="unknown"

CACHE="${KEEPSAKE_ANDROID_CACHE:-${LOCK_CACHE:-src-tauri/plugins/keepsake-media/android/.native-cache}}"
case "$CACHE" in
  /*) ;;
  *) CACHE="$REPO_ROOT/$CACHE" ;;
esac
mkdir -p "$CACHE/sources"

# ---- work dir ----
if [ -n "${WORK_DIR:-}" ]; then
  mkdir -p "$WORK_DIR"
else
  WORK_DIR="$(mktemp -d)"
fi
case "$WORK_DIR" in
  *" "*) die "WORK_DIR must not contain spaces: $WORK_DIR" ;;
esac
cleanup() {
  if [ "${KEEP_WORK:-0}" != "1" ]; then rm -rf "$WORK_DIR"; fi
}
trap cleanup EXIT
JOBS="${JOBS:-$(nproc)}"

# ---- 1. download + verify ----
mkdir -p "$WORK_DIR/dl"
TARBALL="$WORK_DIR/dl/quickjs-ng-$SRC_VERSION.tar.gz"
echo "Downloading $SRC_URL"
curl -fsSL --retry 3 -o "$TARBALL" "$SRC_URL" || die "download failed: $SRC_URL"
GOT_SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
if [ -n "$SRC_SHA" ]; then
  [ "$GOT_SHA" = "$SRC_SHA" ] || die "source sha256 mismatch: expected $SRC_SHA, got $GOT_SHA"
else
  echo "::warning::build-android-qjs: quickjs-ng source sha256 is not pinned. Computed $GOT_SHA; pin it in scripts/binaries.lock.json (.android.sources[\"quickjs-ng\"].sha256)."
  [ "${ALLOW_UNPINNED_SOURCE:-0}" = "1" ] || die "unpinned source and ALLOW_UNPINNED_SOURCE!=1 (failing closed)"
fi
cp "$TARBALL" "$CACHE/sources/quickjs-ng-$SRC_VERSION.tar.gz"

# ---- 2. extract ----
mkdir -p "$WORK_DIR/src"
tar -xzf "$TARBALL" -C "$WORK_DIR/src" --strip-components=1
[ -f "$WORK_DIR/src/CMakeLists.txt" ] || die "CMakeLists.txt not found after extraction"

# ---- 3. configure + build ----
if command -v ninja >/dev/null 2>&1; then GEN="Ninja"; else GEN="Unix Makefiles"; fi
cmake -S "$WORK_DIR/src" -B "$WORK_DIR/build" -G "$GEN" \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=24 \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DQJS_BUILD_EXAMPLES=OFF \
  -DQJS_BUILD_CLI_STATIC=OFF \
  -DQJS_BUILD_CLI_WITH_MIMALLOC=OFF \
  -DQJS_BUILD_LIBC=OFF \
  -DQJS_ENABLE_INSTALL=OFF \
  "-DCMAKE_EXE_LINKER_FLAGS=-Wl,-z,max-page-size=16384" \
  || die "cmake configure failed"
cmake --build "$WORK_DIR/build" --target qjs_exe -j "$JOBS" || die "cmake build failed"

OUT="$WORK_DIR/build/qjs"
[ -f "$OUT" ] || die "expected output not found: $OUT"

# ---- 4. strip + install to cache ----
cp "$OUT" "$WORK_DIR/libqjs.so"
"$BIN/llvm-strip" "$WORK_DIR/libqjs.so"
cp "$WORK_DIR/libqjs.so" "$CACHE/libqjs.so"
chmod 755 "$CACHE/libqjs.so"
BUILT_SHA="$(sha256sum "$CACHE/libqjs.so" | awk '{print $1}')"
printf '%s  libqjs.so\n' "$BUILT_SHA" > "$CACHE/libqjs.so.sha256"

# ---- 5. verify ELF ----
HDR="$("$BIN/llvm-readelf" -hW "$CACHE/libqjs.so")" || die "llvm-readelf -h failed"
echo "$HDR" | awk '/^[[:space:]]*Machine:/ && /AArch64/ {f=1} END {exit !f}' \
  || die "ELF machine is not AArch64"
echo "$HDR" | awk '/^[[:space:]]*Type:/ && /DYN/ {f=1} END {exit !f}' \
  || die "ELF type is not DYN (PIE required)"

PH="$("$BIN/llvm-readelf" -lW "$CACHE/libqjs.so")" || die "llvm-readelf -l failed"
echo "$PH" | grep -F -q "Requesting program interpreter: /system/bin/linker64" \
  || die "PT_INTERP is not /system/bin/linker64"

# Every LOAD line ends with its Align field; require >= 0x4000.
LOAD_COUNT="$(echo "$PH" | awk '$1=="LOAD"{n++} END{print n+0}')"
[ "$LOAD_COUNT" -gt 0 ] || die "no LOAD segments found"
BAD_ALIGN="$(printf '%s\n' "$PH" | python3 -I -c '
import sys
for line in sys.stdin:
    f = line.split()
    if f and f[0] == "LOAD":
        try:
            a = int(f[-1], 0)
        except ValueError:
            a = 0
        if a < 0x4000:
            print(line.strip())
')"
[ -z "$BAD_ALIGN" ] || die "LOAD segment alignment < 0x4000: $BAD_ALIGN"

# ---- 6. report ----
SIZE="$(wc -c < "$CACHE/libqjs.so" | tr -d ' ')"
echo "qjs built: $CACHE/libqjs.so $SIZE $BUILT_SHA"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "- qjs (QuickJS-NG $SRC_VERSION, arm64, 16K-aligned) built: \`libqjs.so\` $SIZE bytes, sha256 \`$BUILT_SHA\`" >> "$GITHUB_STEP_SUMMARY"
fi
