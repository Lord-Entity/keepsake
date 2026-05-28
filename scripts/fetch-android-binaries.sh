#!/usr/bin/env bash
# Places the Android (arm64-v8a) executables that the in-process yt-dlp runs (libqjs.so = QuickJS-NG,
# libffmpeg.so = minimal LGPL FFmpeg) into the keepsake-media plugin's jniLibs directory, as listed under
# "android" in scripts/binaries.lock.json. AGP packages them as lib/arm64-v8a/lib*.so and the package
# manager extracts them to nativeLibraryDir, the one app-owned place Android lets an app execute from.
#
#   bash scripts/fetch-android-binaries.sh
#
# Per lib, in this order:
#   1. <cache>/<name> exists AND (the lock has no url for it OR it is listed in KEEPSAKE_ANDROID_USE_BUILT):
#      copy from the cache; an adjacent <name>.sha256 ("<hex>  <name>"), if present, must match.
#   2. listed in KEEPSAKE_ANDROID_USE_BUILT but no cache file: fail.
#   3. the lock has a url: download (curl --retry 3), verify sha256 (and "bytes"), like fetch-binaries.sh.
#   4. already in jniLibs (scripts/build-android-ffmpeg.sh writes libffmpeg.so straight there): keep it.
#   5. otherwise: fail if listed in KEEPSAKE_ANDROID_REQUIRE; else a LOUD warning (::error:: annotation
#      plus the job summary) and exit 0. The APK still builds; the app reports ytdlp_status.ready=false.
# Every placed file is chmod 755 and must be a 64-bit little-endian ELF with e_machine 183 (aarch64).
#
# Environment (all optional):
#   KEEPSAKE_ANDROID_CACHE      cache dir (default: android.cacheDir in the lock, repo-relative)
#   KEEPSAKE_ANDROID_USE_BUILT  lib names to take from the cache (space/comma separated), e.g. "libqjs.so"
#                               to use scripts/build-android-qjs.sh output instead of the release asset
#   KEEPSAKE_ANDROID_REQUIRE    lib names whose absence fails the script, e.g. "libqjs.so libffmpeg.so"
#   GITHUB_STEP_SUMMARY         when set (GitHub Actions), a table is appended to it
# Needs: bash, curl, python3, sha256sum or shasum.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
LOCK="$HERE/binaries.lock.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

die() { echo "::error::fetch-android-binaries: $*" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# "a b,c" -> " a b c " so membership is a plain substring test on " name ".
norm_list() { printf ' %s ' "$(printf '%s' "${1:-}" | tr ',' ' ' | tr -s '[:space:]' ' ')"; }
USE_BUILT="$(norm_list "${KEEPSAKE_ANDROID_USE_BUILT:-}")"
REQUIRE="$(norm_list "${KEEPSAKE_ANDROID_REQUIRE:-}")"
in_list() { case "$2" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Line 1: jniLibsDir<TAB>cacheDir. Then one line per lib: name<TAB>url<TAB>sha256<TAB>bytes<TAB>pinned<TAB>buildScript
# "-" stands for an empty field: read with IFS=tab would collapse it and shift the columns.
LINES="$(python3 - "$LOCK" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
a = lock.get("android")
if not a:
    sys.exit("binaries.lock.json has no top-level \"android\" section")
print("\t".join([a["jniLibsDir"], a["cacheDir"]]))
for name, e in a["libs"].items():
    print("\t".join([
        name,
        e.get("url", "").strip() or "-",
        e.get("sha256", "").strip().lower() or "-",
        str(e.get("bytes") or 0),
        "1" if e.get("pinned", True) else "0",
        e.get("buildScript", "") or "-",
    ]))
PY
)"

IFS=$'\t' read -r JNI_REL CACHE_REL <<< "$(printf '%s\n' "$LINES" | head -n1)"
JNI="$ROOT/$JNI_REL"
CACHE="${KEEPSAKE_ANDROID_CACHE:-$ROOT/$CACHE_REL}"
mkdir -p "$JNI"

check_elf() {
  python3 - "$1" <<'PY' || return 1
import struct, sys
with open(sys.argv[1], "rb") as f:
    h = f.read(20)
if len(h) < 20 or h[:4] != b"\x7fELF":
    sys.exit("missing ELF magic")
if h[4] != 2 or h[5] != 1:
    sys.exit("not a 64-bit little-endian ELF (class=%d data=%d)" % (h[4], h[5]))
machine = struct.unpack_from("<H", h, 18)[0]
if machine != 183:
    sys.exit("e_machine is %d, expected 183 (aarch64)" % machine)
PY
}

SUMMARY="| Lib | Source | Bytes | sha256 |"$'\n'"|---|---|---|---|"
MISSING=""

while IFS=$'\t' read -r name url want bytes pinned script; do
  dest="$JNI/$name"
  cached="$CACHE/$name"
  [ "$script" = "-" ] && script="(no build script)"
  source=""
  if [ -f "$cached" ] && { [ "$url" = "-" ] || in_list "$name" "$USE_BUILT"; }; then
    got="$(sha256_of "$cached")"
    if [ -f "$cached.sha256" ]; then
      expected="$(awk 'NR==1{print tolower($1)}' "$cached.sha256")"
      [ "$got" = "$expected" ] || die "SHA-256 mismatch for cached $name. Expected $expected (from $cached.sha256), got $got"
      echo "$name cache sha256 OK ($got)"
    fi
    cp -f "$cached" "$dest"
    source="cache"
  elif in_list "$name" "$USE_BUILT"; then
    die "$name requested from the build cache (KEEPSAKE_ANDROID_USE_BUILT) but $cached is missing; run $script"
  elif [ "$url" != "-" ]; then
    echo "Downloading $name from $url"
    curl -fsSL --retry 3 -o "$TMP/$name" "$url"
    got="$(sha256_of "$TMP/$name")"
    if [ "$want" != "-" ]; then
      [ "$got" = "$want" ] || die "SHA-256 mismatch for $name. Expected $want, got $got"
      echo "$name sha256 OK ($got)"
    elif [ "$pinned" = "0" ]; then
      echo "::warning::$name is NOT verified (\"pinned\": false in binaries.lock.json). Computed sha256: $got. Pin it before release." >&2
    else
      die "$name is marked pinned but has no sha256 in binaries.lock.json"
    fi
    if [ "$bytes" != "0" ]; then
      size="$(wc -c < "$TMP/$name" | tr -d ' ')"
      [ "$size" = "$bytes" ] || die "Size mismatch for $name. Expected $bytes bytes, got $size"
    fi
    mv -f "$TMP/$name" "$dest"
    source="release"
  elif [ -f "$dest" ]; then
    echo "$name: keeping the copy already in $JNI_REL (no url in the lock, no cache file)"
    source="existing"
  else
    if in_list "$name" "$REQUIRE"; then
      die "$name is required (KEEPSAKE_ANDROID_REQUIRE) but has no url in binaries.lock.json and no $cached; run $script"
    fi
    echo "::error::$name NOT bundled: no url in binaries.lock.json, no $cached, nothing in $JNI_REL. The APK will build WITHOUT it and the app will report ytdlp_status.ready=false (legacy yt-dlp route only). Produce it with $script." >&2
    SUMMARY+=$'\n'"| $name | **MISSING** | 0 | - |"
    MISSING+=" $name"
    continue
  fi

  chmod 755 "$dest"
  if ! err="$(check_elf "$dest" 2>&1)"; then
    rm -f "$dest"
    die "$name is not an arm64-v8a ELF: $err (removed $dest)"
  fi
  size="$(wc -c < "$dest" | tr -d ' ')"
  SUMMARY+=$'\n'"| $name | $source | $size | \`$(sha256_of "$dest")\` |"
done < <(printf '%s\n' "$LINES" | tail -n +2)

echo "$SUMMARY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Android bundled executables (jniLibs/arm64-v8a)"
    echo ""
    echo "$SUMMARY"
    if [ -n "$MISSING" ]; then
      echo ""
      echo "> **WARNING:** missing:$MISSING. This APK cannot use the self-contained yt-dlp route (ytdlp_status.ready=false)."
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi
ls -la "$JNI"
