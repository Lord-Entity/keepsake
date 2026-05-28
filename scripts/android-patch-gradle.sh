#!/usr/bin/env bash
# Patches the GENERATED Android project:
#   1. root build.gradle.kts (and, in the fallback, settings.gradle[.kts]): the Chaquopy classpath, so the
#      keepsake-media plugin module can apply Chaquopy (Chaquopy itself lives in the plugin module);
#   2. the app module, only this: one appended block in $GEN_DIR/app/build.gradle.kts (marker
#      "// keepsake: jniLibs executables") and android:extractNativeLibs="true" on <application> in
#      $GEN_DIR/app/src/main/AndroidManifest.xml. libqjs.so/libffmpeg.so are executables shipped as jniLibs;
#      Android lets an app exec its own files only from nativeLibraryDir, which is populated only when native
#      libs are extracted at install time, and AGP must not strip them.
# Idempotent: safe to run again on a restored gen/android. Fails loudly if any patch does not apply.
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

# ---- app module: extract and keep the jniLibs executables (plan 11, section 3.1) ----
APP_GRADLE="$GEN_DIR/app/build.gradle.kts"
APP_MANIFEST="$GEN_DIR/app/src/main/AndroidManifest.xml"
PACKAGING_MARKER="// keepsake: jniLibs executables"

patch_app_packaging() {
  [ -f "$APP_GRADLE" ] || die "$APP_GRADLE not found (run tauri android init first)"
  if grep -qF "$PACKAGING_MARKER" "$APP_GRADLE"; then
    echo "already patched: $APP_GRADLE"
  else
    cat >> "$APP_GRADLE" <<'KTS'

// keepsake: jniLibs executables (appended by scripts/android-patch-gradle.sh). libqjs.so and libffmpeg.so
// are programs yt-dlp runs. Android executes app files only from nativeLibraryDir, which is populated only
// when native libs are extracted at install (useLegacyPackaging -> extractNativeLibs=true). Never strip them.
android {
    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += setOf("**/libqjs.so", "**/libffmpeg.so")
        }
    }
}
KTS
    echo "appended jniLibs packaging block to $APP_GRADLE"
  fi
  grep -qF "$PACKAGING_MARKER" "$APP_GRADLE" || die "marker '$PACKAGING_MARKER' missing from $APP_GRADLE after patching"
  grep -qF 'useLegacyPackaging = true' "$APP_GRADLE" || die "useLegacyPackaging = true missing from $APP_GRADLE after patching"
}

# Belt and braces for plan risk R2: AGP derives extractNativeLibs from useLegacyPackaging, and an explicit
# attribute keeps the merged manifest at true even if that mapping changes. AGP may print a deprecation
# warning about the attribute; that is expected and harmless.
patch_app_manifest() {
  [ -f "$APP_MANIFEST" ] || die "$APP_MANIFEST not found (run tauri android init first)"
  grep -q '<application' "$APP_MANIFEST" || die "no <application tag in $APP_MANIFEST"
  grep -q 'xmlns:android=' "$APP_MANIFEST" || die "$APP_MANIFEST does not declare xmlns:android"
  if grep -qF 'android:extractNativeLibs="true"' "$APP_MANIFEST"; then
    echo "already patched: $APP_MANIFEST"
  elif grep -qF 'android:extractNativeLibs=' "$APP_MANIFEST"; then
    sed -i -E 's/android:extractNativeLibs="[^"]*"/android:extractNativeLibs="true"/' "$APP_MANIFEST"
    echo "set android:extractNativeLibs=true in $APP_MANIFEST"
  else
    # First <application tag only (GNU sed 0,/re/); the attribute goes right after the tag name, which is
    # valid whether the other attributes follow on the same line or on the next ones.
    sed -i -E '0,/<application([[:space:]>]|$)/s//<application android:extractNativeLibs="true"\1/' "$APP_MANIFEST"
    echo "added android:extractNativeLibs=true to $APP_MANIFEST"
  fi
  grep -qF 'android:extractNativeLibs="true"' "$APP_MANIFEST" \
    || die "android:extractNativeLibs=\"true\" missing from $APP_MANIFEST after patching"
}

patch_app_packaging
patch_app_manifest
echo "--- keepsake block in $APP_GRADLE ---"
awk -v m="$PACKAGING_MARKER" 'index($0, m) { f = 1 } f' "$APP_GRADLE"
echo "--- <application> in $APP_MANIFEST ---"
grep -n -A3 '<application' "$APP_MANIFEST"
