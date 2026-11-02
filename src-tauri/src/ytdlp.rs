//! Thin launcher for the bundled yt-dlp sidecar (desktop only).
//!
//! The TypeScript engine (src/engine/ytdlp.ts) builds the argument list. Rust
//! checks it against a fixed allow-list, checks the URL after `--` is http(s),
//! prepends the fixed flags, spawns the process, streams output lines over a
//! `Channel`, resolves with the exit code, and kills the process tree on
//! request. The webview has no `shell:*` permission.
//!
//! JS contract:
//!   invoke<number>("run_ytdlp", { jobId, args, tempDir, onEvent })  // resolves with exit code (-1 = killed by signal)
//!   onEvent messages: { event: "stdout" | "stderr", line: string }
//!   invoke<void>("cancel_ytdlp", { jobId })
//!   invoke<{ ytdlp: string | null, ffmpeg: string | null, node: string | null }>("binary_status")
//!     `node` is the version of the JS runtime run_ytdlp will use: the bundled QuickJS-NG
//!     ("QuickJS..." text) when present, else Node.js ("v22.x"), else null.
//!     Results are cached by path, size and mtime (memory + app cache dir), so a warm start spawns nothing.
//!   invoke<string[]>("list_installed_browsers")  // yt-dlp browser names with a profile folder
//!   run_ytdlp rejects with "js_runtime_missing: ..." for a YouTube URL when neither the bundled
//!   QuickJS (sidecar "qjs") nor Node.js is found.
#![cfg_attr(mobile, allow(dead_code, unused))]

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, Manager};

struct Job {
    pid: u32,
    temp_dir: Option<PathBuf>,
}

/// Running jobs: job id -> process id and the job's own temp folder.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Job>>);

/// Size and modification time of a binary; a change means "probe the version again".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileKey {
    len: u64,
    mtime_ns: u128,
}

type VersionMap = HashMap<PathBuf, (FileKey, String)>;

/// binary_status cache: binary path -> (size/mtime key, version line).
/// `None` until loaded from the app cache dir on first use.
#[derive(Default)]
pub struct VersionCache(Mutex<Option<VersionMap>>);

const VERSION_CACHE_FILE: &str = "binary-versions.tsv";

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum YtdlpEvent {
    Stdout { line: String },
    Stderr { line: String },
}

#[derive(Serialize)]
pub struct BinaryVersions {
    ytdlp: Option<String>,
    ffmpeg: Option<String>,
    node: Option<String>,
}

/// Flags the TypeScript side may pass that take no value.
const FLAGS_NO_VALUE: &[&str] = &[
    "--version",
    "--ignore-config",
    "--newline",
    "-J",
    "--dump-single-json",
    "-j",
    "--dump-json",
    "-i",
    "--ignore-errors",
    "--abort-on-error",
    "--no-playlist",
    "--yes-playlist",
    "--flat-playlist",
    "--progress",
    "--no-progress",
    "--quiet",
    "-q",
    "--no-warnings",
    "--verbose",
    "--simulate",
    "-s",
    "--skip-download",
    "--windows-filenames",
    "--restrict-filenames",
    "--no-part",
    "--no-mtime",
    "--no-overwrites",
    "--force-overwrites",
    "--continue",
    "--no-continue",
    "-x",
    "--extract-audio",
    "--keep-video",
    "--embed-thumbnail",
    "--no-embed-thumbnail",
    "--embed-metadata",
    "--add-metadata",
    "--embed-subs",
    "--write-thumbnail",
    "--write-subs",
    "--write-auto-subs",
    "--no-cache-dir",
    "--list-extractors",
    "--no-color",
];

/// Flags the TypeScript side may pass that take exactly one value (the next argument).
const FLAGS_WITH_VALUE: &[&str] = &[
    "--encoding",
    "--js-runtimes",
    "-f",
    "--format",
    "-S",
    "--format-sort",
    "--merge-output-format",
    "--audio-format",
    "--audio-quality",
    "-o",
    "--output",
    "-P",
    "--paths",
    "--trim-filenames",
    "--progress-template",
    "--print",
    "-O",
    "--convert-thumbnails",
    "--sub-langs",
    "--sub-format",
    "--convert-subs",
    "-I",
    "--playlist-items",
    "-r",
    "--limit-rate",
    "-R",
    "--retries",
    "--fragment-retries",
    "-N",
    "--concurrent-fragments",
    "--socket-timeout",
    "--cookies-from-browser",
    "--extractor-args",
    "--proxy",
];

fn validate_job_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("jobId must be 1-80 characters of A-Z a-z 0-9 - _".into())
    }
}

fn validate_url(u: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(u).map_err(|_| format!("invalid URL: {u}"))?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some_and(|h| !h.is_empty()) => Ok(()),
        _ => Err("only http and https URLs are allowed".into()),
    }
}

/// Options must come from the allow-list. A `--` may appear once and must be
/// followed by exactly one http(s) URL.
fn validate_args(args: &[String]) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            return match &args[i + 1..] {
                [url] => validate_url(url),
                _ => Err("exactly one URL must follow --".into()),
            };
        } else if FLAGS_NO_VALUE.contains(&a) {
            i += 1;
        } else if FLAGS_WITH_VALUE.contains(&a) {
            let Some(v) = args.get(i + 1) else {
                return Err(format!("yt-dlp flag {a} needs a value"));
            };
            if a == "--js-runtimes" && !js_runtime_ok(v.as_str()) {
                return Err("only --js-runtimes node or node:<absolute path> is allowed".into());
            }
            i += 2;
        } else {
            return Err(format!("yt-dlp argument not allowed: {a}"));
        }
    }
    Ok(())
}

/// `--js-runtimes` value: `node` or `node:<absolute path>` (yt-dlp `RUNTIME[:PATH]`).
fn js_runtime_ok(v: &str) -> bool {
    v == "node"
        || v
            .strip_prefix("node:")
            .is_some_and(|p| !p.is_empty() && Path::new(p).is_absolute())
}

/// Error text the TS engine maps to code `js_runtime_missing` (src/engine/ytdlp.ts).
const JS_RUNTIME_MISSING: &str =
    "js_runtime_missing: No JavaScript runtime was found (the bundled QuickJS is missing and Node.js is not installed). Reinstall Keepsake or install Node.js (https://nodejs.org) so YouTube downloads work.";

/// JS runtime yt-dlp uses to solve YouTube's challenges.
#[derive(Debug, PartialEq, Eq)]
enum JsRuntime {
    /// Bundled QuickJS-NG sidecar (`qjs`).
    QuickJs(PathBuf),
    /// User-installed Node.js (fallback).
    Node(PathBuf),
}

impl JsRuntime {
    /// `--js-runtimes` value in yt-dlp `RUNTIME:PATH` form.
    fn yt_dlp_value(&self) -> OsString {
        let (name, path) = match self {
            JsRuntime::QuickJs(p) => ("quickjs:", p),
            JsRuntime::Node(p) => ("node:", p),
        };
        let mut v = OsString::from(name);
        v.push(path.as_os_str());
        v
    }
}

/// Prefer the bundled QuickJS; look for Node only when it is missing. Relative
/// paths are never used (yt-dlp would resolve them against its own cwd).
fn select_js_runtime(
    bundled_qjs: Option<PathBuf>,
    node: impl FnOnce() -> Option<PathBuf>,
) -> Option<JsRuntime> {
    bundled_qjs
        .filter(|p| p.is_absolute())
        .map(JsRuntime::QuickJs)
        .or_else(|| node().filter(|p| p.is_absolute()).map(JsRuntime::Node))
}

/// The bundled `qjs` sidecar, resolved like yt-dlp (next to the app binary).
fn bundled_qjs(sidecar_dir: &Path) -> Option<PathBuf> {
    let p = sidecar_dir.join(exe_name("keepsake-qjs"));
    p.is_file().then_some(p)
}

/// True when the URL after `--` is a YouTube host (yt-dlp needs a JS runtime for its challenges).
fn is_youtube_job(args: &[String]) -> bool {
    let Some(i) = args.iter().position(|a| a == "--") else {
        return false;
    };
    let Some(u) = args.get(i + 1).and_then(|u| tauri::Url::parse(u).ok()) else {
        return false;
    };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    ["youtube.com", "youtu.be", "youtube-nocookie.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// Find a Node.js binary: PATH first, then common install folders (a GUI app may
/// have a stale PATH right after Node was installed).
fn find_node() -> Option<PathBuf> {
    let name = exe_name("node");
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(&name);
            if p.is_absolute() && p.is_file() {
                return Some(p);
            }
        }
    }
    let mut extra: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            extra.push(PathBuf::from(pf).join("nodejs").join(&name));
        }
        extra.push(PathBuf::from(r"C:\Program Files\nodejs").join(&name));
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            extra.push(PathBuf::from(la).join("Programs").join("nodejs").join(&name));
        }
        // nvm-windows keeps the active version behind this symlink.
        if let Some(s) = std::env::var_os("NVM_SYMLINK") {
            extra.push(PathBuf::from(s).join(&name));
        }
    }
    #[cfg(unix)]
    {
        extra.push(PathBuf::from("/usr/local/bin/node"));
        extra.push(PathBuf::from("/usr/bin/node"));
    }
    extra.into_iter().find(|p| p.is_file())
}

/// Browser profile folders, in no particular order (TS owns the retry order).
/// Names are yt-dlp `--cookies-from-browser` names.
fn browser_profile_dirs() -> Vec<(&'static str, PathBuf)> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    #[cfg(windows)]
    let (local, roaming) = (env("LOCALAPPDATA"), env("APPDATA"));
    #[cfg(windows)]
    let table: [(&'static str, &Option<PathBuf>, &str); 7] = [
        ("edge", &local, r"Microsoft\Edge\User Data"),
        ("chrome", &local, r"Google\Chrome\User Data"),
        ("firefox", &roaming, r"Mozilla\Firefox\Profiles"),
        ("brave", &local, r"BraveSoftware\Brave-Browser\User Data"),
        ("chromium", &local, r"Chromium\User Data"),
        ("opera", &roaming, r"Opera Software\Opera Stable"),
        ("vivaldi", &local, r"Vivaldi\User Data"),
    ];
    #[cfg(not(windows))]
    let home = env("HOME");
    #[cfg(not(windows))]
    let config = env("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|h| h.join(".config")));
    #[cfg(not(windows))]
    let table: [(&'static str, &Option<PathBuf>, &str); 8] = [
        ("edge", &config, "microsoft-edge"),
        ("chrome", &config, "google-chrome"),
        ("firefox", &home, ".mozilla/firefox"),
        ("firefox", &home, "snap/firefox/common/.mozilla/firefox"),
        ("brave", &config, "BraveSoftware/Brave-Browser"),
        ("chromium", &config, "chromium"),
        ("opera", &config, "opera"),
        ("vivaldi", &config, "vivaldi"),
    ];
    table
        .iter()
        .filter_map(|&(n, base, rel)| base.as_ref().map(|b| (n, b.join(rel))))
        .collect()
}

/// Only `<anything>/.keepsake-tmp/<jobId>` may be deleted after a run.
fn temp_dir_for_job(temp_dir: &str, job_id: &str) -> Option<PathBuf> {
    let p = PathBuf::from(temp_dir);
    let ok = p.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        && p.file_name().is_some_and(|n| n == job_id)
        && p.parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == ".keepsake-tmp");
    ok.then_some(p)
}

/// Folder that holds the sidecars. Tauri places `externalBin` files next to the
/// main executable in installed apps, and tauri-build copies them next to the
/// dev binary in `target/<profile>/`, without the target-triple suffix.
fn sidecar_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "cannot resolve the app folder".into())
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Kill yt-dlp and its children (ffmpeg) so no orphan keeps writing files.
fn kill_tree(pid: u32) {
    use std::process::Stdio;
    #[cfg(windows)]
    let mut cmd = {
        let mut c = quiet_command("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    };
    #[cfg(unix)]
    let mut cmd = {
        // The child was started in its own process group (pgid == pid).
        let mut c = quiet_command("kill");
        c.args(["-KILL", "--", &format!("-{pid}")]);
        c
    };
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn pump<R: std::io::Read>(r: R, ch: &Channel<YtdlpEvent>, is_err: bool) {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf)
                    .trim_end_matches(['\r', '\n'])
                    .to_string();
                let ev = if is_err {
                    YtdlpEvent::Stderr { line }
                } else {
                    YtdlpEvent::Stdout { line }
                };
                let _ = ch.send(ev);
            }
        }
    }
}

fn remove_dir_with_retries(dir: &Path) {
    for _ in 0..5 {
        if !dir.exists() || std::fs::remove_dir_all(dir).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}

/// Delete a job's `.keepsake-tmp/<jobId>` folder, then the `.keepsake-tmp`
/// parent if it is now empty (`remove_dir` never removes a non-empty folder).
/// The parent step runs under the job-table lock, the same lock new jobs hold
/// while creating their folder, so it cannot delete a folder a new job needs.
fn remove_job_temp(app: &AppHandle, dir: &Path) {
    remove_dir_with_retries(dir);
    let jobs = app.state::<Jobs>();
    let _guard = jobs.0.lock();
    if let Some(parent) = dir.parent() {
        let _ = std::fs::remove_dir(parent);
    }
}

#[cfg(desktop)]
fn run_blocking(
    app: AppHandle,
    job_id: String,
    args: Vec<String>,
    temp_dir: Option<PathBuf>,
    on_event: Channel<YtdlpEvent>,
) -> Result<i32, String> {
    use std::process::Stdio;

    let dir = sidecar_dir()?;
    let ytdlp = dir.join(exe_name("keepsake-yt-dlp"));
    if !ytdlp.is_file() {
        return Err(format!("yt-dlp not found at {}", ytdlp.display()));
    }

    let mut cmd = quiet_command(&ytdlp);
    cmd.args(["--ignore-config", "--no-plugin-dirs", "--no-js-runtimes"]);
    // yt-dlp needs a JS runtime to solve YouTube's challenges; without one YouTube
    // answers with "Sign in to confirm you're not a bot". Use the bundled QuickJS,
    // else Node, by absolute path so a stale GUI PATH does not matter. Other sites
    // run without a runtime.
    match select_js_runtime(bundled_qjs(&dir), find_node) {
        Some(rt) => {
            cmd.arg("--js-runtimes").arg(rt.yt_dlp_value());
        }
        None if is_youtube_job(&args) => return Err(JS_RUNTIME_MISSING.into()),
        None => {}
    }
    cmd.arg("--ffmpeg-location")
        .arg(&dir)
        .args(&args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = {
        let jobs = app.state::<Jobs>();
        let mut map = jobs.0.lock().map_err(|_| "job table poisoned")?;
        if map.contains_key(&job_id) {
            return Err(format!("job {job_id} is already running"));
        }
        if let Some(t) = &temp_dir {
            // Marker lets a startup sweep recognise folders Keepsake created.
            std::fs::create_dir_all(t).map_err(|e| format!("cannot create temp folder: {e}"))?;
            let _ = std::fs::write(t.join(".keepsake-job"), &job_id);
        }
        let child = cmd.spawn().map_err(|e| {
            if let Some(t) = &temp_dir {
                let _ = std::fs::remove_dir_all(t);
                // Lock is held here, so this cannot race another job's folder creation.
                if let Some(parent) = t.parent() {
                    let _ = std::fs::remove_dir(parent);
                }
            }
            format!("could not start yt-dlp: {e}")
        })?;
        map.insert(
            job_id.clone(),
            Job {
                pid: child.id(),
                temp_dir: temp_dir.clone(),
            },
        );
        child
    };

    let stderr = child.stderr.take();
    let err_ch = on_event.clone();
    let err_thread = std::thread::spawn(move || {
        if let Some(s) = stderr {
            pump(s, &err_ch, true);
        }
    });
    if let Some(s) = child.stdout.take() {
        pump(s, &on_event, false);
    }
    let _ = err_thread.join();
    let status = child.wait();
    if let Ok(mut map) = app.state::<Jobs>().0.lock() {
        map.remove(&job_id);
    }
    // The process tree is gone; only now delete this job's temp folder (the
    // .part files, fragments and intermediates of this job and no other).
    if let Some(t) = temp_dir {
        remove_job_temp(&app, &t);
    }
    let status = status.map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(-1))
}

/// Run yt-dlp to completion, streaming lines to `on_event`. Resolves with the exit code.
/// `temp_dir`, when given, must be `<abs path>/.keepsake-tmp/<jobId>`; it is deleted after exit.
#[tauri::command]
pub async fn run_ytdlp(
    app: AppHandle,
    job_id: String,
    args: Vec<String>,
    temp_dir: Option<String>,
    on_event: Channel<YtdlpEvent>,
) -> Result<i32, String> {
    validate_job_id(&job_id)?;
    validate_args(&args)?;
    let temp = match temp_dir.as_deref() {
        Some(t) => Some(
            temp_dir_for_job(t, &job_id)
                .ok_or("tempDir must be an absolute path ending in .keepsake-tmp/<jobId>")?,
        ),
        None => None,
    };
    #[cfg(mobile)]
    {
        return Err("yt-dlp is not available on this platform".into());
    }
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || {
        run_blocking(app, job_id, args, temp, on_event)
    })
    .await
    .map_err(|e| e.to_string())?;
}

/// Kill a running job and its children. No-op if the job is unknown.
/// The pending `run_ytdlp` call then resolves with the exit code.
#[tauri::command]
pub async fn cancel_ytdlp(app: AppHandle, job_id: String) -> Result<(), String> {
    let pid = app
        .state::<Jobs>()
        .0
        .lock()
        .map_err(|_| "job table poisoned")?
        .get(&job_id)
        .map(|j| j.pid);
    if let Some(pid) = pid {
        tauri::async_runtime::spawn_blocking(move || kill_tree(pid))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn first_line(program: &Path, arg: &str) -> Option<String> {
    let out = quiet_command(program)
        .arg(arg)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// QuickJS-NG may not know `--version`; any run that starts counts as working.
fn qjs_version(program: &Path) -> Option<String> {
    let out = quiet_command(program)
        .arg("--version")
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .unwrap_or_default();
    if !line.is_empty() && (out.status.success() || line.to_ascii_lowercase().contains("quickjs")) {
        Some(line)
    } else {
        Some("QuickJS-ng (bundled)".into())
    }
}

fn file_key(p: &Path) -> Option<FileKey> {
    let m = std::fs::metadata(p).ok()?;
    if !m.is_file() {
        return None;
    }
    let mtime_ns = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(FileKey {
        len: m.len(),
        mtime_ns,
    })
}

/// Version of `path`, probing only when its size/mtime differ from the cached entry.
/// A missing file is `None` without probing. Failed probes are not cached.
fn cached_version(
    map: &mut VersionMap,
    dirty: &mut bool,
    path: &Path,
    probe: impl FnOnce(&Path) -> Option<String>,
) -> Option<String> {
    let key = file_key(path)?;
    if let Some((k, v)) = map.get(path) {
        if *k == key {
            return Some(v.clone());
        }
    }
    let v = probe(path);
    *dirty = true;
    match &v {
        Some(s) => {
            map.insert(path.to_path_buf(), (key, s.clone()));
        }
        None => {
            map.remove(path);
        }
    }
    v
}

/// Cache file lines: `len \t mtime_ns \t version \t path` (path last, may hold tabs).
fn parse_version_cache(text: &str) -> VersionMap {
    text.lines()
        .filter_map(|l| {
            let mut f = l.splitn(4, '\t');
            let len = f.next()?.parse().ok()?;
            let mtime_ns = f.next()?.parse().ok()?;
            let version = f.next()?;
            let path = f.next()?;
            (!version.is_empty() && !path.is_empty()).then(|| {
                (
                    PathBuf::from(path),
                    (FileKey { len, mtime_ns }, version.to_string()),
                )
            })
        })
        .collect()
}

fn format_version_cache(map: &VersionMap) -> String {
    let mut out = String::new();
    for (p, (k, v)) in map {
        let Some(ps) = p.to_str() else { continue };
        if ps.contains(['\n', '\r']) || v.contains(['\t', '\n', '\r']) {
            continue;
        }
        out.push_str(&format!("{}\t{}\t{}\t{}\n", k.len, k.mtime_ns, v, ps));
    }
    out
}

/// Versions of the bundled sidecars and of the JS runtime (null = missing or broken).
/// Spawns `--version`/`-version` only when a binary's path, size or mtime changed.
#[tauri::command]
pub async fn binary_status(app: AppHandle) -> Result<BinaryVersions, String> {
    if cfg!(mobile) {
        return Ok(BinaryVersions {
            ytdlp: None,
            ffmpeg: None,
            node: None,
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = sidecar_dir().unwrap_or_default();
        let cache_file = app
            .path()
            .app_cache_dir()
            .ok()
            .map(|d| d.join(VERSION_CACHE_FILE));
        let state = app.state::<VersionCache>();
        // Held across the probes so two concurrent calls never spawn twice.
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let map = guard.get_or_insert_with(|| {
            cache_file
                .as_deref()
                .and_then(|f| std::fs::read_to_string(f).ok())
                .map(|t| parse_version_cache(&t))
                .unwrap_or_default()
        });
        let mut dirty = false;
        let ytdlp = cached_version(map, &mut dirty, &dir.join(exe_name("keepsake-yt-dlp")), |p| {
            first_line(p, "--version")
        });
        let ffmpeg = cached_version(map, &mut dirty, &dir.join(exe_name("keepsake-ffmpeg")), |p| {
            first_line(p, "-version")
        });
        let node = match select_js_runtime(bundled_qjs(&dir), find_node) {
            Some(JsRuntime::QuickJs(p)) => cached_version(map, &mut dirty, &p, qjs_version),
            Some(JsRuntime::Node(p)) => {
                cached_version(map, &mut dirty, &p, |p| first_line(p, "--version"))
            }
            None => None,
        };
        if dirty {
            if let Some(f) = &cache_file {
                if let Some(parent) = f.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let tmp = f.with_extension("tsv.tmp");
                if std::fs::write(&tmp, format_version_cache(map)).is_ok() {
                    let _ = std::fs::rename(&tmp, f);
                }
            }
        }
        BinaryVersions {
            ytdlp,
            ffmpeg,
            node,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// yt-dlp browser names whose profile folder exists (used for the cookie fallback).
#[tauri::command]
pub async fn list_installed_browsers() -> Result<Vec<String>, String> {
    if cfg!(mobile) {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let mut found: Vec<String> = Vec::new();
        for (name, dir) in browser_profile_dirs() {
            if dir.is_dir() && !found.iter().any(|f| f.as_str() == name) {
                found.push(name.to_string());
            }
        }
        found
    })
    .await
    .map_err(|e| e.to_string())
}

/// Called on app exit: kill every running yt-dlp tree, then delete each job's
/// temp folder (the run threads may not get to it before the process exits).
pub fn kill_all(app: &AppHandle) {
    let jobs: Vec<(u32, Option<PathBuf>)> = match app.state::<Jobs>().0.lock() {
        Ok(map) => map.values().map(|j| (j.pid, j.temp_dir.clone())).collect(),
        Err(_) => return,
    };
    for (pid, _) in &jobs {
        kill_tree(*pid);
    }
    for t in jobs.iter().filter_map(|(_, t)| t.as_deref()) {
        remove_job_temp(app, t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn allows_engine_args() {
        let a = s(&[
            "--ignore-config",
            "--encoding",
            "utf-8",
            "--js-runtimes",
            "node",
            "--no-warnings",
            "-J",
            "-i",
            "--flat-playlist",
            "--",
            "https://www.youtube.com/watch?v=abc",
        ]);
        assert!(validate_args(&a).is_ok());
        assert!(validate_args(&s(&["--version"])).is_ok());
    }

    #[test]
    fn rejects_bad_args() {
        assert!(validate_args(&s(&["--exec", "calc"])).is_err());
        assert!(validate_args(&s(&["--ffmpeg-location", "/tmp"])).is_err());
        assert!(validate_args(&s(&["--js-runtimes", "deno"])).is_err());
        assert!(validate_args(&s(&["--js-runtimes", "node:relative/node"])).is_err());
        assert!(validate_args(&s(&["--js-runtimes", "node:"])).is_err());
        assert!(validate_args(&s(&["--js-runtimes", "deno:/usr/bin/deno"])).is_err());
        assert!(validate_args(&s(&["https://x.y"])).is_err());
        assert!(validate_args(&s(&["-f"])).is_err());
        assert!(validate_args(&s(&["--", "file:///etc/passwd"])).is_err());
        assert!(validate_args(&s(&["--", "https://a.b", "https://c.d"])).is_err());
        assert!(validate_args(&s(&["--"])).is_err());
    }

    #[test]
    fn js_runtime_values() {
        let abs = if cfg!(windows) {
            r"node:C:\Program Files\nodejs\node.exe"
        } else {
            "node:/usr/bin/node"
        };
        assert!(js_runtime_ok("node"));
        assert!(js_runtime_ok(abs));
        assert!(!js_runtime_ok("bun"));
    }

    #[test]
    fn youtube_detection() {
        assert!(is_youtube_job(&s(&["-J", "--", "https://www.youtube.com/watch?v=abc"])));
        assert!(is_youtube_job(&s(&["--", "https://youtu.be/abc"])));
        assert!(!is_youtube_job(&s(&["--", "https://vimeo.com/1"])));
        assert!(!is_youtube_job(&s(&["--", "https://notyoutube.com/x"])));
    }

    #[test]
    fn url_scheme() {
        assert!(validate_url("https://www.youtube.com/watch?v=abc").is_ok());
        assert!(validate_url("http://example.com").is_ok());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("--exec").is_err());
    }

    #[test]
    fn temp_dir_rule() {
        let base = if cfg!(windows) {
            "C:\\Users\\u\\Downloads"
        } else {
            "/home/u/Downloads"
        };
        let sep = std::path::MAIN_SEPARATOR;
        let good = format!("{base}{sep}.keepsake-tmp{sep}job1");
        assert!(temp_dir_for_job(&good, "job1").is_some());
        assert!(temp_dir_for_job(&good, "job2").is_none());
        assert!(temp_dir_for_job(base, "job1").is_none());
        assert!(temp_dir_for_job(".keepsake-tmp/job1", "job1").is_none());
    }

    #[test]
    fn dead_and_dangerous_flags_rejected() {
        for f in [
            "--remux-video",
            "--recode-video",
            "--exec",
            "--exec-before-download",
            "--ffmpeg-location",
            "--plugin-dirs",
            "--config-locations",
            "--batch-file",
            "-a",
            "--postprocessor-args",
            "--ppa",
            "--load-info-json",
            "--use-postprocessor",
            "--js-runtimes=node",
        ] {
            assert!(validate_args(&s(&[f, "x"])).is_err(), "{f} must be rejected");
        }
        // A disallowed flag cannot hide as the value of an allowed one and then reappear.
        assert!(validate_args(&s(&["-f", "best", "--exec", "calc"])).is_err());
        // The bundled runtime is Rust-only; TS may not pass quickjs itself.
        assert!(validate_args(&s(&["--js-runtimes", "quickjs"])).is_err());
        assert!(validate_args(&s(&["--js-runtimes", "quickjs:/opt/qjs"])).is_err());
    }

    #[test]
    fn allows_download_args() {
        let a = s(&[
            "--encoding",
            "utf-8",
            "--no-warnings",
            "--cookies-from-browser",
            "edge",
            "-f",
            "bestaudio[ext=m4a]/bestaudio",
            "-x",
            "--audio-format",
            "m4a",
            "--merge-output-format",
            "mp4",
            "--embed-metadata",
            "--newline",
            "--progress",
            "--progress-template",
            "download:KEEPSAKE|x",
            "--print",
            "after_move:KEEPSAKE_DONE|%(filepath)s",
            "-i",
            "--",
            "https://youtu.be/abc",
        ]);
        assert!(validate_args(&a).is_ok());
    }

    fn abs(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\app\{name}.exe"))
        } else {
            PathBuf::from(format!("/opt/app/{name}"))
        }
    }

    #[test]
    fn runtime_prefers_bundled_qjs() {
        let mut node_called = false;
        let rt = select_js_runtime(Some(abs("qjs")), || {
            node_called = true;
            Some(abs("node"))
        });
        assert_eq!(rt, Some(JsRuntime::QuickJs(abs("qjs"))));
        assert!(!node_called, "node lookup must be skipped when qjs is bundled");
        let mut want = OsString::from("quickjs:");
        want.push(abs("qjs").as_os_str());
        assert_eq!(rt.unwrap().yt_dlp_value(), want);
    }

    #[test]
    fn runtime_falls_back_to_node() {
        let rt = select_js_runtime(None, || Some(abs("node")));
        assert_eq!(rt, Some(JsRuntime::Node(abs("node"))));
        let mut want = OsString::from("node:");
        want.push(abs("node").as_os_str());
        assert_eq!(rt.unwrap().yt_dlp_value(), want);
    }

    #[test]
    fn runtime_none_or_relative() {
        assert_eq!(select_js_runtime(None, || None), None);
        // Relative paths are ignored for both runtimes.
        assert_eq!(
            select_js_runtime(Some(PathBuf::from("qjs")), || Some(abs("node"))),
            Some(JsRuntime::Node(abs("node")))
        );
        assert_eq!(
            select_js_runtime(None, || Some(PathBuf::from("node"))),
            None
        );
    }

    #[test]
    fn version_cache_roundtrip() {
        let mut m: VersionMap = HashMap::new();
        m.insert(
            abs("yt-dlp"),
            (
                FileKey {
                    len: 18_000_000,
                    mtime_ns: 1_760_000_000_123_456_789,
                },
                "2026.08.19".into(),
            ),
        );
        // Entries that would break the line format are dropped, not written.
        m.insert(
            abs("bad"),
            (FileKey { len: 1, mtime_ns: 2 }, "a\tb".into()),
        );
        let text = format_version_cache(&m);
        let back = parse_version_cache(&text);
        assert_eq!(back.len(), 1);
        assert_eq!(back.get(&abs("yt-dlp")), m.get(&abs("yt-dlp")));
        // Garbage lines are ignored.
        assert!(parse_version_cache("x\ty\tz\tw\n\n1\t2\t\t/p\n").is_empty());
    }

    #[test]
    fn job_ids() {
        assert!(validate_job_id("info-3f2a").is_ok());
        assert!(validate_job_id("").is_err());
        assert!(validate_job_id("../x").is_err());
    }
}
