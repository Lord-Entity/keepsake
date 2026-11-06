#!/usr/bin/env bash
# Patches the GENERATED Android project so the keepsake-media plugin module can apply Chaquopy.
# Only the root build.gradle.kts (and, in the fallback, settings.gradle[.kts]) is touched.
# The app module ($GEN_DIR/app) is never modified: Chaquopy lives in the plugin module.
# Idempotent: safe to run again on a restored gen/android.
#
# usage: scripts/android-patch-gradle.sh [GEN_DIR]     (default GEN_DIR=src-tauri/gen/android)
set -euo pipefail

CHAQUOPY_VERSION="17.2.0"
GEN_DIR="${1:-src-tauri/gen/android}"
ROOT="$GEN_DIR/build.gradle.kts"
CLASSPATH_LINE="classpath(\"com.chaquo.python:gradle:${CHAQUOPY_VERSION}\")"
PLUGIN_LINE="id(\"com.chaquo.python\") version \"${CHAQUOPY_VERSION}\" apply false"
PM_LINE='pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }'

die() { echo "::error::android-patch-gradle: $*" >&2; exit 1; }

[ -f "$ROOT" ] || die "$ROOT not found (run tauri android init first)"

# Insert $2 right after line number $1 of $ROOT, copying that line's indentation.
insert_after() {
  local n="$1" text="$2" indent
  indent="$(sed -n "${n}p" "$ROOT" | sed -E 's/^([[:space:]]*).*/\1/')"
  sed -i "${n}a\\
${indent}${text}" "$ROOT"
}

patch_classpath() {
  local n
  n="$(grep -n 'classpath("com.android.tools.build:gradle:' "$ROOT" | head -n1 | cut -d: -f1 || true)"
  [ -n "$n" ] || return 1
  grep -q 'mavenCentral()' "$ROOT" || die "$ROOT has no mavenCentral(); Chaquopy's classpath artifact would not resolve"
  insert_after "$n" "$CLASSPATH_LINE"
}

patch_plugins_block() {
  local n settings
  n="$(grep -n '^plugins {' "$ROOT" | head -n1 | cut -d: -f1 || true)"
  [ -n "$n" ] || return 1
  sed -i "${n}a\\
    ${PLUGIN_LINE}" "$ROOT"
  settings=""
  for f in "$GEN_DIR/settings.gradle" "$GEN_DIR/settings.gradle.kts"; do
    if [ -f "$f" ]; then settings="$f"; break; fi
  done
  [ -n "$settings" ] || die "no settings.gradle[.kts] in $GEN_DIR"
  if ! grep -q 'pluginManagement' "$settings"; then
    # pluginManagement must be the first block in a settings script.
    printf '%s\n\n' "$PM_LINE" | cat - "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"
  fi
  grep -q 'pluginManagement' "$settings" || die "pluginManagement missing in $settings after patch"
}

if grep -q 'com.chaquo.python' "$ROOT"; then
  echo "already patched: $ROOT"
elif patch_classpath; then
  echo "patched buildscript classpath in $ROOT"
elif patch_plugins_block; then
  echo "patched plugins block (+ pluginManagement) for $ROOT"
else
  echo "--- first 40 lines of $ROOT ---" >&2
  head -n 40 "$ROOT" >&2
  die "neither a buildscript classpath anchor nor a plugins { block was found in $ROOT"
fi

# Verify the exact strings; fail loudly if the patch did not apply.
if grep -qF "$CLASSPATH_LINE" "$ROOT" || grep -qF "$PLUGIN_LINE" "$ROOT"; then
  echo "verified: Chaquopy ${CHAQUOPY_VERSION} present in $ROOT"
else
  die "Chaquopy ${CHAQUOPY_VERSION} line missing from $ROOT after patching"
fi

echo "--- patched $ROOT ---"
cat "$ROOT"
