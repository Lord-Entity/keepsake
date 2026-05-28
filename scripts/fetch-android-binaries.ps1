# Places the Android (arm64-v8a) native libraries into the keepsake-media plugin's jniLibs
# directory, as listed under "android" in scripts/binaries.lock.json (libqjs.so, libffmpeg.so).
#
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-android-binaries.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-android-binaries.ps1 -UseBuilt libffmpeg.so -Require libffmpeg.so
#
# CI uses scripts/fetch-android-binaries.sh; this script is the Windows dev-parity twin.
# libffmpeg.so is produced by scripts/build-android-ffmpeg.sh (Linux + Android NDK only), so
# on Windows it normally comes only from a cache dir someone copied in (android.cacheDir).
#
# Per lib:
#   - cache file present and (lock url empty or lib listed in -UseBuilt): copy from the cache
#     dir; an adjacent <name>.sha256 file, if present, must match.
#   - lib listed in -UseBuilt but no cache file: fail.
#   - lock url present: download, verify sha256 (and "bytes" if set) like fetch-binaries.ps1.
#   - already in jniLibs (e.g. written by build-android-ffmpeg.sh): keep it (ELF-checked).
#   - otherwise: fail if listed in -Require, else warn and continue.
# Every placed file is checked to be a 64-bit little-endian aarch64 ELF.
#
# Environment (used when the matching parameter is not given):
#   KEEPSAKE_ANDROID_CACHE      overrides the cache dir (default: android.cacheDir in the lock)
#   KEEPSAKE_ANDROID_USE_BUILT  lib names to take from the cache, space/comma separated
#   KEEPSAKE_ANDROID_REQUIRE    lib names that must be present, space/comma separated
#
# No chmod here: the Linux script does chmod 755, but the APK packager does not rely on
# the mode bit. The script exits non-zero only by throwing.
param(
  [string]$CacheDir = "",
  [string[]]$UseBuilt = @(),
  [string[]]$Require = @()
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Split-Names([string[]]$items) {
  $out = @()
  foreach ($i in $items) {
    if ($i) { $out += ($i -split "[\s,]+" | Where-Object { $_ }) }
  }
  return $out
}

$root = Split-Path -Parent $PSScriptRoot
$lock = Get-Content -Raw (Join-Path $PSScriptRoot "binaries.lock.json") | ConvertFrom-Json
$android = $lock.android
if (-not $android) { throw "binaries.lock.json has no top-level ""android"" section" }

if (-not $CacheDir) {
  if ($env:KEEPSAKE_ANDROID_CACHE) { $CacheDir = $env:KEEPSAKE_ANDROID_CACHE }
  else { $CacheDir = Join-Path $root ($android.cacheDir -replace "/", "\") }
}
if ($UseBuilt.Count -eq 0 -and $env:KEEPSAKE_ANDROID_USE_BUILT) { $UseBuilt = @($env:KEEPSAKE_ANDROID_USE_BUILT) }
if ($Require.Count -eq 0 -and $env:KEEPSAKE_ANDROID_REQUIRE) { $Require = @($env:KEEPSAKE_ANDROID_REQUIRE) }
$UseBuilt = @(Split-Names $UseBuilt)
$Require = @(Split-Names $Require)

$jni = Join-Path $root ($android.jniLibsDir -replace "/", "\")
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("keepsake-android-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $jni, $tmp | Out-Null

function Assert-Elf64Aarch64([string]$path, [string]$name) {
  $fs = [IO.File]::OpenRead($path)
  try {
    $h = New-Object byte[] 20
    $n = $fs.Read($h, 0, 20)
  } finally {
    $fs.Dispose()
  }
  $problem = ""
  if ($n -lt 20) { $problem = "file is shorter than an ELF header" }
  elseif ($h[0] -ne 0x7F -or $h[1] -ne 0x45 -or $h[2] -ne 0x4C -or $h[3] -ne 0x46) { $problem = "missing ELF magic" }
  elseif ($h[4] -ne 2) { $problem = "not a 64-bit ELF (EI_CLASS=$($h[4]))" }
  elseif ($h[5] -ne 1) { $problem = "not little-endian (EI_DATA=$($h[5]))" }
  else {
    $machine = [int]$h[18] + ([int]$h[19] * 256)
    if ($machine -ne 183) { $problem = "e_machine is $machine, expected 183 (aarch64)" }
  }
  if ($problem) {
    Remove-Item -Force -ErrorAction SilentlyContinue $path
    throw "$name is not a valid arm64-v8a ELF shared library: $problem. Removed $path"
  }
}

$rows = @()
try {
  foreach ($prop in $android.libs.PSObject.Properties) {
    $name = $prop.Name
    $entry = $prop.Value
    $dest = Join-Path $jni $name
    $cached = Join-Path $CacheDir $name
    $url = "$($entry.url)".Trim()
    $buildScript = "$($entry.buildScript)"
    $isPinned = -not ($entry.PSObject.Properties.Name -contains "pinned" -and $entry.pinned -eq $false)
    $wantBuilt = $UseBuilt -contains $name
    $source = ""

    if ((Test-Path -LiteralPath $cached) -and ($url -eq "" -or $wantBuilt)) {
      $got = (Get-FileHash -Algorithm SHA256 $cached).Hash.ToLower()
      $sumFile = "$cached.sha256"
      if (Test-Path -LiteralPath $sumFile) {
        $tokens = @((Get-Content -Raw $sumFile) -split "\s+" | Where-Object { $_ })
        $expected = if ($tokens.Count -gt 0) { $tokens[0].ToLower() } else { "" }
        if ($got -ne $expected) { throw "SHA-256 mismatch for cached $name. Expected $expected (from $sumFile), got $got" }
        Write-Host "$name cache sha256 OK ($got)"
      }
      Copy-Item -Force $cached $dest
      $source = "cache"
    } elseif ($wantBuilt) {
      throw "$name requested from build cache but $cached is missing; run $buildScript"
    } elseif ($url -ne "") {
      $dl = Join-Path $tmp $name
      Write-Host "Downloading $name from $url"
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dl
      $got = (Get-FileHash -Algorithm SHA256 $dl).Hash.ToLower()
      $want = "$($entry.sha256)".Trim().ToLower()

      if ($want -ne "") {
        if ($got -ne $want) { throw "SHA-256 mismatch for $name. Expected $want, got $got" }
        Write-Host "$name sha256 OK ($got)"
      } elseif (-not $isPinned) {
        Write-Warning "$name is NOT verified (`"pinned`": false in binaries.lock.json). Computed sha256: $got"
        Write-Warning "Pin this hash in scripts/binaries.lock.json before release."
      } else {
        throw "$name is marked pinned but has no sha256 in binaries.lock.json"
      }

      $wantBytes = 0
      if ($entry.PSObject.Properties.Name -contains "bytes" -and $entry.bytes) { $wantBytes = [long]$entry.bytes }
      if ($wantBytes -ne 0) {
        $len = (Get-Item $dl).Length
        if ($len -ne $wantBytes) { throw "Size mismatch for $name. Expected $wantBytes bytes, got $len" }
      }

      Move-Item -Force $dl $dest
      $source = "release"
    } elseif (Test-Path -LiteralPath $dest) {
      # Already placed by its build script (build-android-ffmpeg.sh writes straight into jniLibs).
      Write-Host "${name}: keeping the copy already in $jni (no url in the lock, no cache file)"
      $source = "existing"
    } else {
      if ($Require -contains $name) {
        throw "$name is required but has no url in binaries.lock.json and no $cached; run $buildScript"
      }
      Write-Warning "$name NOT bundled: no url in binaries.lock.json and no $cached. The APK will build but ytdlp_status.ready will be false. Run $buildScript (on Linux/WSL with the NDK) first."
      $rows += [pscustomobject]@{ Name = $name; Source = "missing"; Length = 0; Sha256 = "" }
      continue
    }

    Assert-Elf64Aarch64 $dest $name
    $rows += [pscustomobject]@{
      Name   = $name
      Source = $source
      Length = (Get-Item $dest).Length
      Sha256 = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
    }
  }

  $rows | Format-Table Name, Source, Length, Sha256 -AutoSize
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
