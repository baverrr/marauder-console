// Prevent a second console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell for Marauder Console.
//!
//! The shell owns the lifecycle of the Python **bridge** (the process that owns the serial port and
//! serves the HTTP + WebSocket API). On launch it resolves a bridge, waits until it is listening, then
//! creates the window — injecting the bridge's base URL into the web UI *before* the page loads, so the
//! existing same-origin client code can target the bridge no matter what origin the webview runs on.
//!
//! Bridge resolution, in order:
//!   1. `MARAUDER_BRIDGE_URL` env var — attach to an already-running bridge, spawn nothing.
//!   2. A bundled `marauder-bridge` sidecar next to this executable (production) — spawn it on a free port.
//!   3. The source venv (`../venv/bin/python ../bridge.py`) relative to this crate (development).
//!   4. Fall back to `http://127.0.0.1:8200` and assume the user started the bridge themselves.
//!
//! Env knobs honoured when the shell spawns the bridge: `MARAUDER_CONSOLE_MOCK=1` (adds `--mock`) and
//! `MARAUDER_CONSOLE_SERIAL_PORT=/dev/ttyUSBx` (adds `--serial-port`).

use std::fs::File;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The spawned bridge child (if the shell started one), kept so it can be killed on exit.
struct BridgeProcess(Mutex<Option<Child>>);

/// Where the shell writes the bridge's stdout/stderr, surfaced by the tray "Open bridge log" item.
struct BridgeLog(Mutex<Option<PathBuf>>);

fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8200)
}

/// Poll until something is accepting connections on the port, or the timeout elapses.
fn wait_until_listening(port: u16, timeout: Duration) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Build the bridge argument list shared by every spawn path.
fn bridge_args(port: u16) -> Vec<String> {
    let mut args = vec![
        "serve".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
    ];
    if std::env::var("MARAUDER_CONSOLE_MOCK").ok().as_deref() == Some("1") {
        args.push("--mock".into());
    }
    if let Ok(serial) = std::env::var("MARAUDER_CONSOLE_SERIAL_PORT") {
        if !serial.is_empty() {
            args.push("--serial-port".into());
            args.push(serial);
        }
    }
    args
}

/// Redirect a spawned bridge's stdout/stderr into `log_path` (best effort).
fn log_stdio(cmd: &mut Command, log_path: &Option<PathBuf>) {
    if let Some(path) = log_path {
        if let Ok(out) = File::create(path) {
            if let Ok(err) = out.try_clone() {
                cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
                return;
            }
        }
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
}

/// Stop a bridge we spawned that never started listening. Dropping a `Child` doesn't kill it, so without
/// this it would keep running (and later bind its port) after we've fallen through to another option.
fn reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Resolve a bridge and (if we spawn it) return the child. See the module docs for the order.
fn start_bridge(log_path: &Option<PathBuf>) -> (String, Option<Child>) {
    // 1) Attach to an externally-managed bridge.
    if let Ok(url) = std::env::var("MARAUDER_BRIDGE_URL") {
        if !url.is_empty() {
            return (url.trim_end_matches('/').to_string(), None);
        }
    }

    // 2) Bundled sidecar next to this executable (production).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) {
                "marauder-bridge.exe"
            } else {
                "marauder-bridge"
            };
            let sidecar = dir.join(name);
            if sidecar.is_file() {
                let port = pick_free_port();
                let mut cmd = Command::new(&sidecar);
                cmd.args(bridge_args(port));
                log_stdio(&mut cmd, log_path);
                if let Ok(mut child) = cmd.spawn() {
                    // The one-file PyInstaller sidecar self-extracts on first launch, so allow extra time.
                    if wait_until_listening(port, Duration::from_secs(30)) {
                        return (format!("http://127.0.0.1:{port}"), Some(child));
                    }
                    reap(&mut child);
                }
            }
        }
    }

    // 3) Development: run the bridge straight from the source tree's venv.
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default();
    let python = repo.join("venv/bin/python");
    let bridge = repo.join("bridge.py");
    if python.is_file() && bridge.is_file() {
        let port = pick_free_port();
        let mut cmd = Command::new(&python);
        cmd.arg(&bridge).args(bridge_args(port));
        log_stdio(&mut cmd, log_path);
        if let Ok(mut child) = cmd.spawn() {
            if wait_until_listening(port, Duration::from_secs(20)) {
                return (format!("http://127.0.0.1:{port}"), Some(child));
            }
            reap(&mut child);
        }
    }

    // 4) Last resort: assume the user started a bridge on the default port.
    ("http://127.0.0.1:8200".to_string(), None)
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let connect = MenuItem::with_id(app, "connect", "Connect board", true, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect", "Disconnect", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop scan", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let open_log = MenuItem::with_id(app, "open_log", "Open bridge log", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &connect,
            &disconnect,
            &stop,
            &sep1,
            &open_log,
            &show,
            &sep2,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Marauder Console")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            // These mirror the in-UI buttons; the web UI listens for the "menu" event.
            id @ ("connect" | "disconnect" | "stop") => {
                let _ = app.emit("menu", id);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "open_log" => {
                if let Some(state) = app.try_state::<BridgeLog>() {
                    if let Some(path) = state.0.lock().unwrap().clone() {
                        let _ = open::that(path);
                    }
                }
            }
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    // On Linux (Wayland + some GPUs, notably AMD), webkit2gtk's DMABUF renderer paints a blank window.
    // Disabling it before the webview starts fixes that. Set only if the user hasn't overridden it.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .setup(|app| {
            // Keep the bridge log beside the app's other logs.
            let log_path = app
                .path()
                .app_log_dir()
                .ok()
                .map(|dir| {
                    let _ = std::fs::create_dir_all(&dir);
                    dir.join("bridge.log")
                });

            let (url, child) = start_bridge(&log_path);
            app.manage(BridgeProcess(Mutex::new(child)));
            app.manage(BridgeLog(Mutex::new(log_path)));

            // Inject the resolved bridge URL before any page script runs.
            let script = format!(
                "window.__MARAUDER_BRIDGE_URL__ = {};",
                serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into())
            );
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Marauder Console")
                .inner_size(1200.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&script)
                .build()?;

            build_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Marauder Console")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<BridgeProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
