#!/usr/bin/env bash
# Proves that every desktop sidecar (bundle.externalBin in src-tauri/tauri.conf.json) really ends
# up inside each Linux package Tauri produced, next to the app binary (usr/bin), and that it runs.
# The app resolves sidecars next to its own executable (src-tauri/src/ytdlp.rs sidecar_dir), so a
# sidecar anywhere else counts as missing.
#
#   bash scripts/verify-bundle.sh [bundle-dir] [triple]
#   defaults: src-tauri/target/release/bundle  x86_64-unknown-linux-gnu
#
# Checks per package (deb, rpm, AppImage; each type must exist at least once):
#   - file present at usr/bin/<name>, non-empty, executable
#   - sha256 equals src-tauri/binaries/<name>-<triple> (the sha256-pinned download).
#     deb/rpm: a mismatch is an error. AppImage: linuxdeploy may patch/strip ELF files in the
#     AppDir, so a mismatch is only a warning there; the run check below is what counts.
#   - runs: yt-dlp --version, ffmpeg -version, qjs -e 'print(40+2)'
# Writes a table to $GITHUB_STEP_SUMMARY (when set). Exits 1 on any error.
# Needs: jq, dpkg-deb, rpm2cpio + cpio (apt package "rpm"), sha256sum.
set -euo pipefail

B="${1:-src-tauri/target/release/bundle}"
TRIPLE="${2:-x86_64-unknown-linux-gnu}"
CONF=src-tauri/tauri.conf.json
SRC=src-tauri/binaries
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

mapfile -t NAMES < <(jq -r '.bundle.externalBin[] | split("/") | last' "$CONF")
if [ "${#NAMES[@]}" -eq 0 ]; then
  echo "::error::no bundle.externalBin entries in $CONF"
  exit 1
fi
echo "sidecars expected: ${NAMES[*]}"

fail=0
err() { echo "::error title=Linux bundle check::$*"; fail=1; }
rows=()

# $1 = sidecar path, $2 = sidecar name. Prints the first output line; returns the exit status.
run_check() {
  local p="$1" n="$2" out rc=0
  case "$n" in
    *yt-dlp) out="$(timeout 120 "$p" --version 2>&1)" || rc=$? ;;
    *ffmpeg) out="$(timeout 60 "$p" -hide_banner -version 2>&1)" || rc=$? ;;
    *qjs)    out="$(timeout 60 "$p" -e 'print(40+2)' 2>&1)" || rc=$? ;;
    *)       out="$(timeout 60 "$p" --version 2>&1)" || rc=$? ;;
  esac
  printf '%s' "${out%%$'\n'*}"
  return "$rc"
}

# $1 = label, $2 = extracted package root, $3 = 1 for a strict hash check
check_tree() {
  local label="$1" root="$2" strict="$3" n f src got want first match runs
  for n in "${NAMES[@]}"; do
    f="$root/usr/bin/$n"
    src="$SRC/$n-$TRIPLE"
    if [ ! -f "$f" ]; then
      other="$(find "$root" -name "$n*" -type f 2>/dev/null | sed "s#^$root/##" | tr '\n' ' ')"
      err "$label: $n is MISSING from usr/bin (found elsewhere: ${other:-nowhere})"
      rows+=("| $label | $n | - | MISSING | - |")
      continue
    fi
    [ -s "$f" ] || err "$label: usr/bin/$n is empty"
    [ -x "$f" ] || err "$label: usr/bin/$n is not executable"
    got="$(sha256sum "$f" | cut -d' ' -f1)"
    if [ -f "$src" ]; then
      want="$(sha256sum "$src" | cut -d' ' -f1)"
    else
      want=""
      err "$label: reference $src not found (fetch-binaries.sh not run?)"
    fi
    if [ -n "$want" ] && [ "$got" = "$want" ]; then
      match=yes
    elif [ "$strict" = 1 ]; then
      match=NO
      err "$label: usr/bin/$n sha256 $got differs from the pinned download $want"
    else
      match="no (patched)"
      echo "::warning title=Linux bundle check::$label: usr/bin/$n differs from the pinned download (linuxdeploy rewrote it); relying on the run check"
    fi
    if first="$(run_check "$f" "$n")"; then
      runs="ok: ${first:0:60}"
      echo "$label: $n runs: $first"
    else
      runs="FAILED"
      err "$label: usr/bin/$n does not run: $first"
    fi
    rows+=("| $label | $n | $(stat -c %s "$f") | $match | ${runs//|//} |")
  done
}

shopt -s nullglob
debs=("$B"/deb/*.deb)
rpms=("$B"/rpm/*.rpm)
apps=("$B"/appimage/*.AppImage)
[ "${#debs[@]}" -gt 0 ] || err "no .deb in $B/deb"
[ "${#rpms[@]}" -gt 0 ] || err "no .rpm in $B/rpm"
[ "${#apps[@]}" -gt 0 ] || err "no .AppImage in $B/appimage"

i=0
for pkg in "${debs[@]}"; do
  i=$((i + 1)); d="$WORK/deb$i"; mkdir -p "$d"
  echo "=== $pkg"
  dpkg-deb -c "$pkg" | grep -E 'usr/bin/' || true
  dpkg-deb -x "$pkg" "$d"
  check_tree "deb $(basename "$pkg")" "$d" 1
done
for pkg in "${rpms[@]}"; do
  i=$((i + 1)); d="$WORK/rpm$i"; mkdir -p "$d"
  echo "=== $pkg"
  abs="$(cd "$(dirname "$pkg")" && pwd)/$(basename "$pkg")"
  (cd "$d" && rpm2cpio "$abs" | cpio -idm --quiet)
  find "$d/usr/bin" -maxdepth 1 -type f 2>/dev/null || true
  check_tree "rpm $(basename "$pkg")" "$d" 1
done
for pkg in "${apps[@]}"; do
  i=$((i + 1)); d="$WORK/appimage$i"; mkdir -p "$d"
  echo "=== $pkg"
  abs="$(cd "$(dirname "$pkg")" && pwd)/$(basename "$pkg")"
  chmod +x "$abs"
  # --appimage-extract needs no FUSE.
  (cd "$d" && "$abs" --appimage-extract > /dev/null)
  find "$d/squashfs-root/usr/bin" -maxdepth 1 -type f 2>/dev/null || true
  check_tree "AppImage $(basename "$pkg")" "$d/squashfs-root" 0
done

{
  echo "### Linux bundled sidecars"
  echo ""
  echo "| Package | Sidecar | Bytes | Same sha256 as pinned download | Runs |"
  echo "|---|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
  echo ""
} >> "$SUMMARY"

if [ "$fail" != 0 ]; then
  echo "::error title=Linux bundle check::a bundled sidecar is missing or broken in a Linux package (see errors above)"
  exit 1
fi
echo "All sidecars present and runnable in every Linux package."
