#!/usr/bin/env bash
# Downloads the yt-dlp, ffmpeg and qjs (QuickJS-NG) sidecars into src-tauri/binaries
# with the target-triple names Tauri expects (externalBin), and checks every download
# against the SHA-256 pinned in scripts/binaries.lock.json.
#
#   bash scripts/fetch-binaries.sh [triple]
#
# Supported triples: x86_64-unknown-linux-gnu, aarch64-apple-darwin,
# x86_64-pc-windows-msvc (see "triples" in the lock file). Without an argument the
# triple is guessed from uname (Linux x86_64 or macOS arm64).
#
# Needs: curl, python3 (only to read the JSON lock file), and sha256sum or shasum.
# A hash mismatch fails the script. An entry marked "pinned": false prints a warning
# with the computed hash; a pinned entry with no sha256 fails.
set -euo pipefail

if [ $# -ge 1 ]; then
  TRIPLE="$1"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) TRIPLE="x86_64-unknown-linux-gnu" ;;
    Darwin-arm64 | Darwin-aarch64) TRIPLE="aarch64-apple-darwin" ;;
    *) echo "Cannot guess the target triple for $(uname -s)-$(uname -m); pass it as the first argument." >&2; exit 1 ;;
  esac
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
LOCK="$HERE/binaries.lock.json"
BIN="$ROOT/src-tauri/binaries"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$BIN"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Prints one line per sidecar: name<TAB>url<TAB>sha256<TAB>pinned(1/0)
ENTRIES="$(python3 - "$LOCK" "$TRIPLE" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
triple = sys.argv[2]
platform = lock["triples"].get(triple)
if platform is None:
    sys.exit("Unsupported target triple %s. Supported: %s" % (triple, ", ".join(lock["triples"])))
for name, tool in lock["sidecars"].items():
    entry = tool.get(platform)
    if entry is None:
        sys.exit("binaries.lock.json has no %s entry for %s (%s)" % (name, platform, triple))
    # "-" stands for "no hash": read with IFS=tab would collapse an empty field and shift the columns.
    print("\t".join([name, entry["url"], entry.get("sha256", "").strip().lower() or "-", "1" if tool.get("pinned", True) else "0"]))
PY
)"

EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

while IFS=$'\t' read -r name url want pinned; do
  dest="$BIN/$name-$TRIPLE$EXT"
  echo "Downloading $name from $url"
  curl -fsSL --retry 3 -o "$TMP/$name" "$url"
  got="$(sha256_of "$TMP/$name")"
  if [ "$want" != "-" ]; then
    if [ "$got" != "$want" ]; then
      echo "SHA-256 mismatch for $name. Expected $want, got $got" >&2
      exit 1
    fi
    echo "$name sha256 OK ($got)"
  elif [ "$pinned" = "0" ]; then
    echo "WARNING: $name is NOT verified (\"pinned\": false in binaries.lock.json). Computed sha256: $got" >&2
    echo "WARNING: pin this hash in scripts/binaries.lock.json before release." >&2
  else
    echo "$name is marked pinned but has no sha256 in binaries.lock.json" >&2
    exit 1
  fi
  mv -f "$TMP/$name" "$dest"
  chmod +x "$dest"
done <<< "$ENTRIES"

# ffprobe is no longer bundled; drop a stale copy from older runs.
rm -f "$BIN/ffprobe-$TRIPLE" "$BIN/ffprobe-$TRIPLE.exe"

ls -la "$BIN"
