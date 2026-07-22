use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::plugin::Builder as PluginBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

#[cfg(all(windows, not(debug_assertions)))]
use std::path::Path;

#[cfg(all(windows, not(debug_assertions)))]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(all(windows, not(debug_assertions)))]
fn is_repo_root(path: &Path) -> bool {
    path.join("package.json").is_file()
        && path.join(".git").exists()
        && path.join("scripts").join("launch.ps1").is_file()
}

#[cfg(all(windows, not(debug_assertions)))]
fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if is_repo_root(&current) {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

#[cfg(all(windows, not(debug_assertions)))]
fn launch_script(root: &Path) -> PathBuf {
    root.join("scripts").join("launch.ps1")
}

/// Returns true when `.run/built-stamp` matches current sources + release exe.
#[cfg(all(windows, not(debug_assertions)))]
fn verify_release_is_fresh(root: &Path) -> bool {
    let script = launch_script(root);
    if !script.is_file() {
        return false;
    }

    let mut command = std::process::Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-VerifyOnly")
        .current_dir(root)
        .env_remove("DEEZ_VRM_SKIP_UPDATE");

    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);

    match command.status() {
        Ok(status) => status.code() == Some(0),
        Err(_) => false,
    }
}

#[cfg(all(windows, not(debug_assertions)))]
fn spawn_updater(root: &Path) -> bool {
    let script = launch_script(root);
    let mut command = std::process::Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-FromExe")
        .args(std::env::args().skip(1))
        .current_dir(root)
        // Never let a stale parent env force the child to skip rebuild.
        .env_remove("DEEZ_VRM_SKIP_UPDATE");

    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);

    command.spawn().is_ok()
}

/// When the release exe is launched from inside a git clone, hand off to
/// `scripts/launch.ps1` so it can pull/rebuild before relaunching with
/// `DEEZ_VRM_SKIP_UPDATE=1`. Returns true if this process should exit.
///
/// Even with `DEEZ_VRM_SKIP_UPDATE` set, refuse to continue unless
/// `-VerifyOnly` confirms the release binary matches current sources.
#[cfg(all(windows, not(debug_assertions)))]
fn try_handoff_to_updater() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(exe_dir) = exe.parent() else {
        return false;
    };
    let Some(root) = find_repo_root(exe_dir) else {
        return false;
    };

    let skip_requested = std::env::var_os("DEEZ_VRM_SKIP_UPDATE").is_some();
    if skip_requested && verify_release_is_fresh(&root) {
        return false;
    }

    // In-repo launches must never continue on a stale binary. If the updater
    // spawn fails, still exit this process rather than opening stale UI.
    let _ = spawn_updater(&root);
    true
}

struct PendingModel(Mutex<Option<PathBuf>>);

#[derive(Clone, Serialize)]
struct ModelFile {
    name: String,
    bytes: Vec<u8>,
}

fn is_model_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".vrm") || lower.ends_with(".glb") || lower.ends_with(".gltf")
}

fn is_export_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".vrm") || lower.ends_with(".png")
}

fn model_path_from_args(args: &[String]) -> Option<PathBuf> {
    args.iter()
        .skip(1)
        .find(|argument| is_model_path(argument))
        .map(PathBuf::from)
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn emit_model_path(app: &AppHandle, path: PathBuf) {
    let _ = app.emit("open-model-path", path.to_string_lossy().to_string());
}

fn queue_or_emit_model(app: &AppHandle, pending: &PendingModel, path: PathBuf) {
    if app.get_webview_window("main").is_some() {
        emit_model_path(app, path);
    } else if let Ok(mut guard) = pending.0.lock() {
        *guard = Some(path);
    }
}

fn choose_model(app: &AppHandle) {
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("Open a VRM or glTF model")
        .add_filter("VRM and glTF models", &["vrm", "glb", "gltf"])
        .pick_file(move |file| {
            if let Some(file) = file {
                if let Ok(path) = file.into_path() {
                    emit_model_path(&handle, path);
                }
            }
        });
}

fn open_external(app: &AppHandle, url: &str) {
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        let _ = app
            .dialog()
            .message(format!("Could not open link:\n{error}"))
            .kind(MessageDialogKind::Error)
            .title("Deez VRM Viewer")
            .blocking_show();
    }
}

#[tauri::command]
fn read_model_file(path: String) -> Result<ModelFile, String> {
    if !is_model_path(&path) {
        return Err("Choose a .vrm, .glb, or .gltf model.".into());
    }
    let path = PathBuf::from(&path);
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err("This file is empty and cannot be opened.".into());
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model.vrm".into());
    Ok(ModelFile { name, bytes })
}

#[tauri::command]
fn take_pending_model_path(pending: State<'_, PendingModel>) -> Option<String> {
    pending
        .0
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn write_export_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if !is_export_path(&path) {
        return Err("Exports must be saved as .vrm or .png.".into());
    }
    if bytes.is_empty() {
        return Err("Refusing to write an empty export.".into());
    }
    let path = PathBuf::from(&path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    std::fs::write(&path, bytes).map_err(|error| error.to_string())
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open = MenuItemBuilder::with_id("open-model", "Open Model…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit"))?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&open)
        .separator()
        .item(&quit)
        .build()?;

    let reload = MenuItemBuilder::with_id("reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let fullscreen = MenuItemBuilder::with_id("toggle-fullscreen", "Toggle Fullscreen")
        .accelerator("F11")
        .build(app)?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&reload)
        .item(&fullscreen)
        .build()?;

    let minimize = PredefinedMenuItem::minimize(app, Some("Minimize"))?;
    let close = PredefinedMenuItem::close_window(app, Some("Close"))?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .item(&close)
        .build()?;

    MenuBuilder::new(app)
        .item(&file)
        .item(&view)
        .item(&window)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        if try_handoff_to_updater() {
            return;
        }
    }

    let pending = PendingModel(Mutex::new(model_path_from_args(
        &std::env::args().collect::<Vec<_>>(),
    )));

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            PluginBuilder::<tauri::Wry, ()>::new("navigation-guard")
                .on_navigation(|webview, url| {
                    let scheme = url.scheme();
                    if scheme == "tauri" || scheme == "asset" || scheme.is_empty() {
                        return true;
                    }
                    if scheme == "http" || scheme == "https" {
                        let host = url.host_str().unwrap_or_default();
                        // Allow Vite devUrl and Windows/Android custom-protocol hosts
                        // (https://tauri.localhost/, https://<name>.localhost/).
                        if host == "127.0.0.1"
                            || host == "localhost"
                            || host == "tauri.localhost"
                            || host.ends_with(".localhost")
                        {
                            return true;
                        }
                        open_external(webview.app_handle(), url.as_str());
                        return false;
                    }
                    false
                })
                .build(),
        )
        .manage(pending)
        .invoke_handler(tauri::generate_handler![
            read_model_file,
            take_pending_model_path,
            write_export_file
        ]);

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            focus_main_window(app);
            if let Some(path) = model_path_from_args(&args) {
                if let Some(pending) = app.try_state::<PendingModel>() {
                    queue_or_emit_model(app, pending.inner(), path);
                } else {
                    emit_model_path(app, path);
                }
            }
        }));
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-model" => choose_model(app),
            "reload" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.reload();
                }
            }
            "toggle-fullscreen" => {
                if let Some(window) = app.get_webview_window("main") {
                    let next = !window.is_fullscreen().unwrap_or(false);
                    let _ = window.set_fullscreen(next);
                }
            }
            _ => {}
        })
        .on_page_load(|window, _payload| {
            let app = window.app_handle();
            if let Some(pending) = app.try_state::<PendingModel>() {
                if let Ok(mut guard) = pending.0.lock() {
                    if let Some(path) = guard.take() {
                        emit_model_path(app, path);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
