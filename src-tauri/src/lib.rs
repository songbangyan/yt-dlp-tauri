use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    env,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const TOOLS_ROOT: &str = "Tools/win-x64";
const PROGRESS_PREFIX: &str = "yt-dlp-windows-progress:";
const OUTPUT_PATH_PREFIX: &str = "yt-dlp-windows-output:";

#[derive(Debug, Serialize)]
struct AppState {
    download_directory: String,
    tools_root: String,
}

#[derive(Debug, Serialize)]
struct ToolStatus {
    name: String,
    relative_path: String,
    full_path: String,
    availability: String,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct VideoMetadata {
    title: String,
    id: Option<String>,
    webpage_url: String,
    thumbnail_url: Option<String>,
    duration_seconds: Option<f64>,
    description: Option<String>,
    format_options: Vec<VideoFormatOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VideoFormatOption {
    label: String,
    format_selector: String,
    height: Option<u32>,
    extension: String,
    is_best: bool,
}

#[derive(Debug, Deserialize)]
struct DownloadRequest {
    url: String,
    format_selector: String,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    percent: Option<f64>,
    status: String,
    speed: Option<String>,
    eta: Option<String>,
    raw: Option<String>,
}

#[derive(Debug, Clone)]
struct ToolPaths {
    root: PathBuf,
    yt_dlp: PathBuf,
    ffmpeg: PathBuf,
    ffmpeg_dir: PathBuf,
    ffprobe: PathBuf,
    deno: PathBuf,
}

#[derive(Clone, Default)]
struct DownloadProcessState {
    active_pid: Arc<Mutex<Option<u32>>>,
    cancel_requested: Arc<Mutex<bool>>,
}

#[tauri::command]
async fn get_app_state(app: AppHandle) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tools = locate_tools(&app);
        ensure_writable_directories()?;
        Ok(AppState {
            download_directory: download_directory()?.display().to_string(),
            tools_root: tools.root.display().to_string(),
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn set_download_directory(directory: String) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = directory.trim();
        if trimmed.is_empty() {
            return Err("Download directory cannot be empty.".to_string());
        }

        let path = PathBuf::from(trimmed);
        fs::create_dir_all(&path).map_err(to_string)?;
        let state_dir = state_directory()?;
        fs::create_dir_all(&state_dir).map_err(to_string)?;
        fs::write(state_dir.join("download-directory.txt"), path.display().to_string()).map_err(to_string)?;

        Ok(AppState {
            download_directory: path.display().to_string(),
            tools_root: String::new(),
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn reset_download_directory() -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state_file = state_directory()?.join("download-directory.txt");
        if state_file.exists() {
            fs::remove_file(state_file).map_err(to_string)?;
        }

        let directory = download_directory()?;
        fs::create_dir_all(&directory).map_err(to_string)?;
        Ok(AppState {
            download_directory: directory.display().to_string(),
            tools_root: String::new(),
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn open_download_directory() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = download_directory()?;
        fs::create_dir_all(&directory).map_err(to_string)?;
        open_path(&directory)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn check_tools(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tools = locate_tools(&app);
        Ok(vec![
            probe_tool("yt-dlp", "Tools/win-x64/yt-dlp/yt-dlp.exe", &tools.yt_dlp, &["--version"]),
            probe_tool("ffmpeg", "Tools/win-x64/ffmpeg/bin/ffmpeg.exe", &tools.ffmpeg, &["-version"]),
            probe_tool("ffprobe", "Tools/win-x64/ffmpeg/bin/ffprobe.exe", &tools.ffprobe, &["-version"]),
            probe_tool("deno", "Tools/win-x64/deno/deno.exe", &tools.deno, &["--version"]),
        ])
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn parse_metadata(app: AppHandle, url: String) -> Result<VideoMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_http_url(&url)?;
        let tools = locate_tools(&app);
        require_tools(&tools)?;
        append_log("metadata", &format!("Parsing {url}"));

        let output = Command::new(&tools.yt_dlp)
            .args([
                "--ignore-config",
                "--no-playlist",
                "--dump-single-json",
                "--ffmpeg-location",
            ])
            .arg(&tools.ffmpeg_dir)
            .args(["--js-runtimes"])
            .arg(format!("deno:{}", tools.deno.display()))
            .arg(&url)
            .output()
            .map_err(to_string)?;

        if !output.status.success() {
            append_log("metadata", "Failed to parse metadata.");
            return Err(user_process_error(
                "Failed to parse video metadata.",
                &String::from_utf8_lossy(&output.stderr),
            ));
        }

        parse_metadata_json(&String::from_utf8_lossy(&output.stdout), &url)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn download_video(
    app: AppHandle,
    process_state: tauri::State<'_, DownloadProcessState>,
    request: DownloadRequest,
) -> Result<Option<String>, String> {
    let process_state = process_state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        validate_http_url(&request.url)?;
        let tools = locate_tools(&app);
        require_tools(&tools)?;
        ensure_writable_directories()?;
        let output_dir = download_directory()?;
        append_log("download", &format!("Starting {} {}", request.label, request.url));

        let mut child = Command::new(&tools.yt_dlp)
            .args([
                "--ignore-config",
                "--no-playlist",
                "--newline",
                "--paths",
            ])
            .arg(format!("home:{}", output_dir.display()))
            .args(["--output", "%(title).200B [%(id)s].%(ext)s", "--format"])
            .arg(if request.format_selector.trim().is_empty() {
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b".to_string()
            } else {
                request.format_selector.clone()
            })
            .args(["--merge-output-format", "mp4", "--ffmpeg-location"])
            .arg(&tools.ffmpeg_dir)
            .args(["--js-runtimes"])
            .arg(format!("deno:{}", tools.deno.display()))
            .args([
                "--progress-template",
                &format!(
                    "{}%(progress.status)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
                    PROGRESS_PREFIX
                ),
                "--print",
                &format!("after_move:{}%(filepath)s", OUTPUT_PATH_PREFIX),
                "--progress",
            ])
            .arg(&request.url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(to_string)?;
        let pid = child.id();
        set_active_process(&process_state, pid)?;

        emit_progress(
            &app,
            DownloadProgress {
                percent: None,
                status: format!("Starting {}", request.label),
                speed: None,
                eta: None,
                raw: None,
            },
        );

        let output_path = Arc::new(Mutex::new(None::<String>));
        let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));

        let stdout_handle = child.stdout.take().map(|stdout| {
            let app = app.clone();
            let output_path = Arc::clone(&output_path);
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(progress) = parse_progress_line(&line) {
                        emit_progress(&app, progress);
                    }

                    if let Some(path) = line.strip_prefix(OUTPUT_PATH_PREFIX) {
                        if let Ok(mut guard) = output_path.lock() {
                            *guard = Some(path.trim().to_string());
                        }
                    }
                }
            })
        });

        let stderr_handle = child.stderr.take().map(|stderr| {
            let stderr_lines = Arc::clone(&stderr_lines);
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Ok(mut guard) = stderr_lines.lock() {
                        guard.push(line);
                    }
                }
            })
        });

        let status = child.wait().map_err(to_string)?;
        if let Some(handle) = stdout_handle {
            let _ = handle.join();
        }
        if let Some(handle) = stderr_handle {
            let _ = handle.join();
        }

        if !status.success() {
            let details = stderr_lines.lock().map(|lines| lines.join("\n")).unwrap_or_default();
            let cancelled = was_cancel_requested(&process_state);
            clear_active_process(&process_state, pid);
            if cancelled {
                append_log("download", "Cancelled by user.");
                return Err("Download cancelled.".to_string());
            }
            append_log("download", &format!("Failed. {details}"));
            return Err(user_process_error("Download failed.", &details));
        }

        clear_active_process(&process_state, pid);

        emit_progress(
            &app,
            DownloadProgress {
                percent: Some(100.0),
                status: "Completed".to_string(),
                speed: None,
                eta: None,
                raw: None,
            },
        );

        let saved_path = output_path.lock().ok().and_then(|guard| guard.clone());
        append_log("download", &format!("Completed. Output={}", saved_path.as_deref().unwrap_or("unknown")));
        Ok(saved_path)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn cancel_download(process_state: tauri::State<'_, DownloadProcessState>) -> Result<(), String> {
    let pid = {
        let guard = process_state.active_pid.lock().map_err(lock_error)?;
        *guard
    };

    let Some(pid) = pid else {
        return Ok(());
    };

    {
        let mut guard = process_state.cancel_requested.lock().map_err(lock_error)?;
        *guard = true;
    }

    tauri::async_runtime::spawn_blocking(move || kill_process_tree(pid))
        .await
        .map_err(join_error)?
}

fn locate_tools(app: &AppHandle) -> ToolPaths {
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join(TOOLS_ROOT));
        roots.push(resource_dir.join("Tools").join("win-x64"));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join(TOOLS_ROOT));
            roots.push(parent.join("Tools").join("win-x64"));
        }
    }

    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(TOOLS_ROOT));

    if let Ok(current_dir) = env::current_dir() {
        roots.push(current_dir.join("src-tauri").join(TOOLS_ROOT));
        roots.push(current_dir.join(TOOLS_ROOT));
    }

    let root = roots
        .into_iter()
        .find(|root| root.join("yt-dlp").join("yt-dlp.exe").exists())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(TOOLS_ROOT));

    ToolPaths {
        yt_dlp: root.join("yt-dlp").join("yt-dlp.exe"),
        ffmpeg: root.join("ffmpeg").join("bin").join("ffmpeg.exe"),
        ffmpeg_dir: root.join("ffmpeg").join("bin"),
        ffprobe: root.join("ffmpeg").join("bin").join("ffprobe.exe"),
        deno: root.join("deno").join("deno.exe"),
        root,
    }
}

fn require_tools(tools: &ToolPaths) -> Result<(), String> {
    for path in [&tools.yt_dlp, &tools.ffmpeg, &tools.ffprobe, &tools.deno] {
        if !path.exists() {
            return Err(format!("Missing bundled tool: {}", path.display()));
        }
    }
    Ok(())
}

fn probe_tool(name: &str, relative_path: &str, full_path: &Path, version_args: &[&str]) -> ToolStatus {
    if !full_path.exists() {
        return ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "missing".to_string(),
            version: None,
            error: Some("Bundled tool file is missing.".to_string()),
        };
    }

    match Command::new(full_path).args(version_args).output() {
        Ok(output) if output.status.success() => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "available".to_string(),
            version: first_line(&output.stdout),
            error: None,
        },
        Ok(output) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "cannot_execute".to_string(),
            version: None,
            error: first_line(&output.stderr).or_else(|| Some(format!("Exit code {:?}", output.status.code()))),
        },
        Err(error) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "cannot_execute".to_string(),
            version: None,
            error: Some(error.to_string()),
        },
    }
}

fn parse_metadata_json(json: &str, fallback_url: &str) -> Result<VideoMetadata, String> {
    if json.trim().is_empty() {
        return Err("yt-dlp returned empty metadata.".to_string());
    }

    let root: Value = serde_json::from_str(json).map_err(to_string)?;
    let title = root
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Untitled video")
        .to_string();
    let id = root.get("id").and_then(Value::as_str).map(str::to_string);
    let webpage_url = root
        .get("webpage_url")
        .or_else(|| root.get("original_url"))
        .and_then(Value::as_str)
        .unwrap_or(fallback_url)
        .to_string();
    let thumbnail_url = root
        .get("thumbnail")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| read_last_thumbnail(&root));
    let duration_seconds = root.get("duration").and_then(Value::as_f64);
    let description = root.get("description").and_then(Value::as_str).map(str::to_string);
    let format_options = build_format_options(&root);

    Ok(VideoMetadata {
        title,
        id,
        webpage_url,
        thumbnail_url,
        duration_seconds,
        description,
        format_options,
    })
}

fn build_format_options(root: &Value) -> Vec<VideoFormatOption> {
    let mut options = vec![VideoFormatOption {
        label: "Best MP4".to_string(),
        format_selector: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b".to_string(),
        height: None,
        extension: "mp4".to_string(),
        is_best: true,
    }];

    for height in read_available_heights(root).into_iter().rev() {
        options.push(VideoFormatOption {
            label: format!("{height}p MP4"),
            format_selector: format!(
                "bv*[height<={height}][ext=mp4]+ba[ext=m4a]/b[height<={height}][ext=mp4]/bv*[height<={height}]+ba/b[height<={height}]"
            ),
            height: Some(height),
            extension: "mp4".to_string(),
            is_best: false,
        });
    }

    options
}

fn read_available_heights(root: &Value) -> Vec<u32> {
    let mut heights = BTreeSet::new();
    if let Some(formats) = root.get("formats").and_then(Value::as_array) {
        for format in formats {
            let height = format.get("height").and_then(Value::as_u64);
            let video_codec = format.get("vcodec").and_then(Value::as_str);
            if let Some(height) = height {
                if height > 0 && video_codec.map(|codec| codec != "none").unwrap_or(true) {
                    heights.insert(height as u32);
                }
            }
        }
    }
    heights.into_iter().collect()
}

fn read_last_thumbnail(root: &Value) -> Option<String> {
    root.get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|items| items.iter().filter_map(|item| item.get("url").and_then(Value::as_str)).last())
        .map(str::to_string)
}

fn parse_progress_line(line: &str) -> Option<DownloadProgress> {
    let payload = line.strip_prefix(PROGRESS_PREFIX)?;
    let parts = payload.split('|').collect::<Vec<_>>();
    Some(DownloadProgress {
        status: normalize_status(parts.first().copied().unwrap_or_default()),
        percent: parse_percent(parts.get(1).copied().unwrap_or_default()),
        speed: normalize_optional(parts.get(2).copied()),
        eta: normalize_optional(parts.get(3).copied()),
        raw: Some(line.to_string()),
    })
}

fn parse_percent(value: &str) -> Option<f64> {
    let number = value
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    number.parse::<f64>().ok().map(|percent| percent.clamp(0.0, 100.0))
}

fn normalize_status(value: &str) -> String {
    match value.trim() {
        "downloading" => "Downloading".to_string(),
        "finished" => "Merging".to_string(),
        "error" => "Failed".to_string(),
        "" => "Processing".to_string(),
        other => other.to_string(),
    }
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value == "N/A" {
        None
    } else {
        Some(value.to_string())
    }
}

fn emit_progress(app: &AppHandle, progress: DownloadProgress) {
    let _ = app.emit("download-progress", progress);
}

fn set_active_process(state: &DownloadProcessState, pid: u32) -> Result<(), String> {
    {
        let mut guard = state.active_pid.lock().map_err(lock_error)?;
        *guard = Some(pid);
    }
    {
        let mut guard = state.cancel_requested.lock().map_err(lock_error)?;
        *guard = false;
    }
    Ok(())
}

fn clear_active_process(state: &DownloadProcessState, pid: u32) {
    if let Ok(mut guard) = state.active_pid.lock() {
        if guard.is_some_and(|active_pid| active_pid == pid) {
            *guard = None;
        }
    }
    if let Ok(mut guard) = state.cancel_requested.lock() {
        *guard = false;
    }
}

fn was_cancel_requested(state: &DownloadProcessState) -> bool {
    state.cancel_requested.lock().map(|guard| *guard).unwrap_or(false)
}

fn kill_process_tree(pid: u32) -> Result<(), String> {
    let pid_text = pid.to_string();
    let status = if cfg!(target_os = "windows") {
        Command::new("taskkill")
            .args(["/PID", &pid_text, "/T", "/F"])
            .status()
    } else {
        Command::new("kill").args(["-TERM", &pid_text]).status()
    }
    .map_err(to_string)?;

    if status.success() {
        append_log("download", &format!("Cancel requested for process {pid}."));
        Ok(())
    } else {
        Err(format!("Failed to cancel process {pid}. Exit code {:?}", status.code()))
    }
}

fn download_directory() -> Result<PathBuf, String> {
    let configured = state_directory()?.join("download-directory.txt");
    if configured.exists() {
        let value = fs::read_to_string(configured).map_err(to_string)?;
        let value = value.trim();
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }

    Ok(default_download_directory())
}

fn default_download_directory() -> PathBuf {
    home_directory()
        .map(|home| home.join("Downloads").join("yt-dlp-windows"))
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("downloads"))
}

fn app_data_root() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data).join("yt-dlp-windows-tauri"));
        }
    }

    if let Ok(xdg_data_home) = env::var("XDG_DATA_HOME") {
        return Ok(PathBuf::from(xdg_data_home).join("yt-dlp-windows-tauri"));
    }

    home_directory()
        .map(|home| home.join(".local").join("share").join("yt-dlp-windows-tauri"))
        .ok_or_else(|| "Unable to determine app data directory.".to_string())
}

fn state_directory() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("state"))
}

fn log_directory() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("logs"))
}

fn ensure_writable_directories() -> Result<(), String> {
    fs::create_dir_all(app_data_root()?).map_err(to_string)?;
    fs::create_dir_all(state_directory()?).map_err(to_string)?;
    fs::create_dir_all(log_directory()?).map_err(to_string)?;
    fs::create_dir_all(download_directory()?).map_err(to_string)?;
    Ok(())
}

fn append_log(phase: &str, message: &str) {
    let Ok(directory) = log_directory() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("app.log"))
    else {
        return;
    };
    let sanitized = message.replace('\r', " ").replace('\n', " ");
    let _ = writeln!(file, "{} [{phase}] {sanitized}", unix_timestamp());
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn home_directory() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn validate_http_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Ok(())
    } else {
        Err("Enter a valid http or https video URL.".to_string())
    }
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

fn open_path(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command.spawn().map_err(to_string)?;
    Ok(())
}

fn user_process_error(summary: &str, details: &str) -> String {
    let trimmed = details.trim();
    if trimmed.is_empty() {
        summary.to_string()
    } else {
        format!("{summary} {trimmed}")
    }
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn lock_error(error: impl std::fmt::Display) -> String {
    format!("State lock failed: {error}")
}

fn join_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DownloadProcessState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            set_download_directory,
            reset_download_directory,
            open_download_directory,
            check_tools,
            parse_metadata,
            download_video,
            cancel_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
