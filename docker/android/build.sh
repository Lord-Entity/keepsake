#!/usr/bin/env bash
# Runs INSIDE the keepsake-android container (see Dockerfile), or on any Linux host that has:
#   - JDK 17 (JAVA_HOME set)
#   - Android SDK (ANDROID_HOME) with platforms;android-37.0, build-tools;37.0.0, platform-tools
#   - Android NDK 27.2.12479018 (NDK_HOME set)
#   - Rust 1.90.0 with the aarch64-linux-android target
#   - Bun 1.4.x (1.4.4 in the image)
#   - rsync, perl, zipalign + apksigner (build-tools), keytool (JDK)
# Output: arm64-v8a split APK only (tauri android build --apk --split-per-abi --target aarch64).
#   Set ALL_ABIS=1 to also build the universal APK and every split ABI.
# Signing: release-signed only if a keystore is mounted at /keys; otherwise the APK is signed
#   with a throwaway DEBUG key and MUST NOT be distributed.
# Mounts: /src (repo, ro), /out (apk-out), /cache (named volume: cargo target + persisted gen/android),
#         optional /keys (ro): keepsake-release.jks + keystore.password (read at runtime, never printed). Key alias: keepsake.
set -euo pipefail

export CARGO_TARGET_DIR=/cache/target
export CI=true
WORK=/work/app
GEN_CACHE=/cache/gen-android
mkdir -p "$WORK" /out /cache/target

log() { echo -e "\n=== $* ==="; }

if [[ "${REGEN_GEN:-0}" == "1" ]]; then rm -rf "$GEN_CACHE"; fi

log "Copying source to $WORK"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude src-tauri/target --exclude src-tauri/gen --exclude src-tauri/binaries \
  --exclude apk-out --exclude docker \
  /src/ "$WORK/"
mkdir -p "$WORK/src-tauri/binaries"
cd "$WORK"

log "bun install"
bun install --frozen-lockfile

if [[ -d "$GEN_CACHE/android" ]]; then
  log "Restoring persisted src-tauri/gen/android"
  mkdir -p src-tauri/gen && cp -a "$GEN_CACHE/android" src-tauri/gen/android
else
  log "tauri android init"
  bun x tauri android init --ci
  mkdir -p "$GEN_CACHE" && cp -a src-tauri/gen/android "$GEN_CACHE/android"
fi
GEN=src-tauri/gen/android

SIGNED_BY_GRADLE=0
cleanup() { rm -f "$WORK/$GEN/keystore.properties"; }
trap cleanup EXIT
KEYS=/keys
if [[ -f "$KEYS/keepsake-release.jks" && -s "$KEYS/keystore.password" ]]; then
  log "Configuring release signing (keystore from /keys; password read at runtime, never printed)"
  KS_PASS=$(head -n1 "$KEYS/keystore.password" | tr -d '\r\n')
  ( umask 077; printf 'storeFile=%s\nkeyAlias=%s\npassword=%s\n' "$KEYS/keepsake-release.jks" keepsake "$KS_PASS" > "$GEN/keystore.properties" )
  unset KS_PASS
  F="$GEN/app/build.gradle.kts"
  if ! grep -q 'keepsake-signing' "$F"; then
    # imports at top
    sed -i '1i import java.util.Properties // keepsake-signing\nimport java.io.FileInputStream // keepsake-signing' "$F"
    # signingConfigs block before buildTypes
    perl -0pi -e 's/^(\s*)buildTypes \{/$1signingConfigs { \/\/ keepsake-signing\n$1    create("release") {\n$1        val kp = rootProject.file("keystore.properties")\n$1        if (kp.exists()) {\n$1            val props = Properties()\n$1            props.load(FileInputStream(kp))\n$1            keyAlias = props["keyAlias"] as String\n$1            keyPassword = props["password"] as String\n$1            storeFile = file(props["storeFile"] as String)\n$1            storePassword = props["password"] as String\n$1        }\n$1    }\n$1}\n\n$1buildTypes {/m' "$F"
    # use it in release
    perl -0pi -e 's/(getByName\("release"\) \{)/$1\n            if (rootProject.file("keystore.properties").exists()) { signingConfig = signingConfigs.getByName("release") } \/\/ keepsake-signing/' "$F"
    # persist patch
    cp "$F" "$GEN_CACHE/android/app/build.gradle.kts"
  fi
  SIGNED_BY_GRADLE=1
else
  echo "!!!!!!!! WARNING: no release keystore found in /keys (keepsake-release.jks + keystore.password). !!!!!!!!"
  echo "!!!!!!!! Release APKs will be re-signed with the Android DEBUG key: TEST ONLY, NOT for distribution. !!!!!!!!"
fi

DEBUG_KS=/root/.android/debug.keystore
sign_debug() { # $1 in-apk, $2 out-apk
  if [[ ! -f $DEBUG_KS ]]; then
    mkdir -p /root/.android
    keytool -genkeypair -keystore $DEBUG_KS -storepass android -keypass android -alias androiddebugkey \
      -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null
  fi
  local tmp; tmp=$(mktemp --suffix=.apk)
  zipalign -f -p 4 "$1" "$tmp"
  apksigner sign --ks $DEBUG_KS --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey --out "$2" "$tmp"
  rm -f "$tmp" "$2.idsig"
}

collect() { # $1 = mode (universal|split)
  local f name abi dest
  while IFS= read -r f; do
    name=$(basename "$f")
    case "$name" in
      *universal*) abi=universal ;;
      *arm64*)     abi=arm64-v8a ;;
      *armeabi*|*armv7*|*arm-*) abi=armeabi-v7a ;;
      *x86_64*)    abi=x86_64 ;;
      *x86*)       abi=x86 ;;
      *)           abi=other-${name%.apk} ;;
    esac
    [[ "$1" == universal ]] && abi=universal
    dest="/out/keepsake-${abi}-release.apk"
    if [[ "$name" == *unsigned* ]]; then sign_debug "$f" "$dest"; else cp "$f" "$dest"; fi
    echo "collected $name -> $dest"
  done < <(find "$GEN/app/build/outputs/apk" -name '*.apk')
}

rm -f /out/*.apk
if [[ "${ALL_ABIS:-0}" == "1" ]]; then
  log "ALL_ABIS=1: adding the remaining Rust Android targets"
  rustup target add armv7-linux-androideabi i686-linux-android x86_64-linux-android

  rm -rf "$GEN/app/build/outputs/apk"
  log "Build: universal APK"
  bun x tauri android build --apk --ci
  collect universal

  rm -rf "$GEN/app/build/outputs/apk"
  log "Build: split-per-abi APKs (all ABIs)"
  bun x tauri android build --apk --split-per-abi --ci
  collect split
else
  rm -rf "$GEN/app/build/outputs/apk"
  log "Build: arm64-v8a split APK (default; ALL_ABIS=1 for every ABI)"
  bun x tauri android build --apk --split-per-abi --target aarch64 --ci
  collect split
fi

log "Verify"
for a in /out/*.apk; do
  echo "--- $a"
  apksigner verify --print-certs "$a" | grep -E "Signer #1 certificate (DN|SHA-256 digest)" || true
  apksigner verify "$a" && echo "verifies OK"
done
ls -l /out
[[ "$SIGNED_BY_GRADLE" == 1 ]] || echo "!!!!!!!! NOTE: APKs signed with the Android DEBUG key (no keystore supplied). TEST ONLY - DO NOT DISTRIBUTE. !!!!!!!!"
