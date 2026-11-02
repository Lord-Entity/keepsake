# Downloads the yt-dlp, ffmpeg and qjs (QuickJS-NG) sidecars into src-tauri/binaries
# with the target-triple names Tauri expects (externalBin), and checks every download
# against the SHA-256 pinned in scripts/binaries.lock.json.
#
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-binaries.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-binaries.ps1 -Triple x86_64-pc-windows-gnu
#
# Supported triples are listed under "triples" in the lock file. A hash mismatch fails
# the script. An entry marked "pinned": false prints a warning with the computed hash;
# a pinned entry with no sha256 fails.
param(
  [string]$Triple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$lock = Get-Content -Raw (Join-Path $PSScriptRoot "binaries.lock.json") | ConvertFrom-Json
$bin = Join-Path $root "src-tauri\binaries"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("keepsake-bin-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $bin, $tmp | Out-Null

$platform = $lock.triples.$Triple
if (-not $platform) {
  $known = ($lock.triples.PSObject.Properties | ForEach-Object { $_.Name }) -join ", "
  throw "Unsupported target triple $Triple. Supported: $known"
}
$ext = if ($Triple -like "*windows*") { ".exe" } else { "" }

try {
  foreach ($prop in $lock.sidecars.PSObject.Properties) {
    $name = $prop.Name
    $tool = $prop.Value
    $entry = $tool.$platform
    if (-not $entry) { throw "binaries.lock.json has no $name entry for $platform ($Triple)" }

    $dl = Join-Path $tmp $name
    Write-Host "Downloading $name from $($entry.url)"
    Invoke-WebRequest -UseBasicParsing -Uri $entry.url -OutFile $dl
    $got = (Get-FileHash -Algorithm SHA256 $dl).Hash.ToLower()
    $want = "$($entry.sha256)".Trim().ToLower()
    $pinned = -not ($tool.PSObject.Properties.Name -contains "pinned" -and $tool.pinned -eq $false)

    if ($want -ne "") {
      if ($got -ne $want) { throw "SHA-256 mismatch for $name. Expected $want, got $got" }
      Write-Host "$name sha256 OK ($got)"
    } elseif (-not $pinned) {
      Write-Warning "$name is NOT verified (`"pinned`": false in binaries.lock.json). Computed sha256: $got"
      Write-Warning "Pin this hash in scripts/binaries.lock.json before release."
    } else {
      throw "$name is marked pinned but has no sha256 in binaries.lock.json"
    }

    Move-Item -Force $dl (Join-Path $bin "$name-$Triple$ext")
  }

  # ffprobe is no longer bundled; drop a stale copy from older runs.
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $bin "ffprobe-$Triple$ext")

  Get-ChildItem $bin | Format-Table Name, Length -AutoSize
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
