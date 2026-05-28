# Proves that every desktop sidecar (bundle.externalBin in src-tauri/tauri.conf.json) really ends
# up in the Windows NSIS installer: installs it silently (currentUser, no admin), then checks the
# install folder. The app resolves sidecars next to its own .exe (src-tauri/src/ytdlp.rs
# sidecar_dir), so a sidecar anywhere else counts as missing.
#
#   pwsh -File scripts/verify-bundle.ps1 [-BundleDir src-tauri/target/release/bundle/nsis] [-Triple x86_64-pc-windows-msvc]
#
# Checks: <name>.exe present next to the app, sha256 equal to src-tauri/binaries/<name>-<triple>.exe
# (the sha256-pinned download), and it runs (yt-dlp --version, ffmpeg -version, qjs -e).
# Warns (does not fail) when an installed .exe imports the VC++ runtime DLLs, which a clean
# Windows does not have. Writes a table to $env:GITHUB_STEP_SUMMARY. Exits 1 on any error.
# Meant for a throwaway CI machine: it leaves the app installed.
param(
  [string]$BundleDir = "src-tauri/target/release/bundle/nsis",
  [string]$Triple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$script:fail = $false
function Fail([string]$msg) { Write-Host "::error title=Windows bundle check::$msg"; $script:fail = $true }

$conf = Get-Content -Raw "src-tauri/tauri.conf.json" | ConvertFrom-Json
$names = @($conf.bundle.externalBin | ForEach-Object { ($_ -split "/")[-1] })
if ($names.Count -eq 0) { Write-Host "::error::no bundle.externalBin entries"; exit 1 }
Write-Host "sidecars expected: $($names -join ', ')"

$setup = @(Get-ChildItem (Join-Path $BundleDir "*-setup.exe"))
if ($setup.Count -ne 1) { Write-Host "::error::expected exactly one *-setup.exe in $BundleDir, found $($setup.Count)"; exit 1 }
$setup = $setup[0]
Write-Host "Installing $($setup.FullName) silently"

# WaitForExit on the installer only (Start-Process -Wait would also wait for anything it launches).
$p = Start-Process -FilePath $setup.FullName -ArgumentList "/S" -PassThru
if (-not $p.WaitForExit(600000)) { $p.Kill(); Write-Host "::error::installer did not finish in 10 minutes"; exit 1 }
if ($p.ExitCode -ne 0) { Write-Host "::error::installer exit code $($p.ExitCode)"; exit 1 }

# currentUser NSIS installs to %LOCALAPPDATA%\<productName>; fall back to the uninstall registry entry.
$dir = $null
$candidates = @(
  (Join-Path $env:LOCALAPPDATA $conf.productName),
  (Join-Path $env:LOCALAPPDATA "Programs\$($conf.productName)")
)
foreach ($c in $candidates) { if (Test-Path (Join-Path $c "$($names[0]).exe")) { $dir = $c; break } }
if (-not $dir) {
  $keys = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue)
  foreach ($k in $keys) {
    $v = Get-ItemProperty $k.PSPath
    if ($v.DisplayName -eq $conf.productName -and $v.InstallLocation) { $dir = $v.InstallLocation.Trim('"'); break }
    if ($v.DisplayName -eq $conf.productName -and $v.UninstallString) { $dir = Split-Path -Parent $v.UninstallString.Trim('"'); break }
  }
}
if (-not $dir -or -not (Test-Path $dir)) {
  Write-Host "::error::install folder not found (tried $($candidates -join ', ') and HKCU Uninstall)"
  exit 1
}
Write-Host "Install folder: $dir"
Get-ChildItem $dir | Format-Table Name, Length -AutoSize | Out-String | Write-Host

$dumpbin = $null
try {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  $dumpbin = & $vswhere -latest -products * -find "VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe" | Select-Object -First 1
} catch { $dumpbin = $null }

function Test-Run([string]$exe, [string]$name) {
  $ErrorActionPreference = "Continue"
  switch -Wildcard ($name) {
    "*yt-dlp" { $out = & $exe --version 2>&1 }
    "*ffmpeg" { $out = & $exe -hide_banner -version 2>&1 }
    "*qjs"    { $out = & $exe -e "print(40+2)" 2>&1 }
    default   { $out = & $exe --version 2>&1 }
  }
  $first = "$(@($out)[0])"
  return @{ ok = ($LASTEXITCODE -eq 0); first = $first }
}

$rows = @()
foreach ($n in $names) {
  $f = Join-Path $dir "$n.exe"
  $src = "src-tauri/binaries/$n-$Triple.exe"
  if (-not (Test-Path $f)) {
    Fail "$($setup.Name): $n.exe is MISSING from the install folder $dir"
    $rows += "| $n.exe | - | MISSING | - |"
    continue
  }
  $got = (Get-FileHash -Algorithm SHA256 $f).Hash.ToLower()
  $match = "NO"
  if (Test-Path $src) {
    $want = (Get-FileHash -Algorithm SHA256 $src).Hash.ToLower()
    if ($got -eq $want) { $match = "yes" } else { Fail "$n.exe sha256 $got differs from the pinned download $want" }
  } else {
    Fail "reference $src not found (fetch-binaries.ps1 not run?)"
  }
  $r = Test-Run $f $n
  if ($r.ok) { $runs = "ok: $($r.first)"; Write-Host "$n runs: $($r.first)" }
  else { $runs = "FAILED"; Fail "$n.exe does not run: $($r.first)" }
  if ($runs.Length -gt 70) { $runs = $runs.Substring(0, 70) }
  $rows += "| $n.exe | $((Get-Item $f).Length) | $match | $($runs -replace '\|', '/') |"
}

# Informational: VC++ runtime imports (a clean Windows has no vcruntime140.dll / msvcp140.dll).
if ($dumpbin -and (Test-Path $dumpbin)) {
  foreach ($exe in Get-ChildItem $dir -Filter *.exe) {
    $deps = & $dumpbin /nologo /dependents $exe.FullName 2>&1 | Out-String
    $vc = @([regex]::Matches($deps, '(?im)^\s*((vcruntime|msvcp)\d+[_\w]*\.dll)\s*$') | ForEach-Object { $_.Groups[1].Value })
    if ($vc.Count -gt 0) {
      Write-Host "::warning title=Windows bundle check::$($exe.Name) imports $($vc -join ', '): needs the VC++ redistributable on a clean Windows"
    } else {
      Write-Host "$($exe.Name): no VC++ runtime DLL imports"
    }
  }
} else {
  Write-Host "dumpbin not found; VC++ runtime import check skipped"
}

$md = @("### Windows bundled sidecars ($($setup.Name), installed to %LOCALAPPDATA%)", "",
  "| Sidecar | Bytes | Same sha256 as pinned download | Runs |", "|---|---|---|---|") + $rows + @("")
if ($env:GITHUB_STEP_SUMMARY) { $md -join "`n" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8 }

if ($script:fail) {
  Write-Host "::error title=Windows bundle check::a bundled sidecar is missing or broken in the installer (see errors above)"
  exit 1
}
Write-Host "All sidecars present and runnable in the installed app."
