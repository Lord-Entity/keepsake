<#
Host wrapper: builds the image (cached) and runs the Android build in a disposable container.
Usage:  .\docker\android\build-android.ps1 [-NoBuildImage] [-RegenGen] [-AllAbis]
Default output: one arm64-v8a split APK. -AllAbis also builds the universal APK and every ABI split.
Optional signing: place keepsake-release.jks + keystore.password (single line) in -KeystoreDir (default $env:USERPROFILE\.keepsake); mounted read-only at /keys.
Without a keystore the APK is DEBUG-signed: test only, never distribute it.
#>
param([switch]$NoBuildImage, [switch]$RegenGen, [switch]$AllAbis, [string]$KeystoreDir = (Join-Path $env:USERPROFILE ".keepsake"))
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$out  = Join-Path $repo 'apk-out'
New-Item -ItemType Directory -Force $out | Out-Null

if (-not $NoBuildImage) {
  docker build -t keepsake-android $here
  if ($LASTEXITCODE) { throw 'docker build failed' }
}

$dargs = @('run','--rm',
  '-v',"${repo}:/src:ro",
  '-v',"${out}:/out",
  '-v','keepsake-android-cargo:/cargo-home','-e','CARGO_HOME=/cargo-home',
  '-v','keepsake-android-gradle:/root/.gradle',
  '-v','keepsake-android-target:/cache')
if ($RegenGen) { $dargs += @('-e','REGEN_GEN=1') }
if ($AllAbis)  { $dargs += @('-e','ALL_ABIS=1') }
if (Test-Path (Join-Path $KeystoreDir "keepsake-release.jks")) {
  Write-Host "Release keystore found in $KeystoreDir - mounting read-only at /keys"
  $dargs += @("-v","${KeystoreDir}:/keys:ro")
} else {
  Write-Warning "No keepsake-release.jks in $KeystoreDir - APKs will be signed with the DEBUG key (test only, DO NOT distribute)."
}
$dargs += 'keepsake-android'
$sw = [Diagnostics.Stopwatch]::StartNew()
docker @dargs
if ($LASTEXITCODE) { throw "build failed (exit $LASTEXITCODE)" }
Write-Host "Done in $($sw.Elapsed). APKs in $out"
Get-ChildItem $out -Filter *.apk | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
