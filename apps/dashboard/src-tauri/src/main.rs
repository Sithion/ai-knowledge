// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod tray;
mod secrets;
mod oauth;
mod widget_config;
mod widgets;

use sidecar::SidecarState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;
use widget_config::WidgetPositions;
use widgets::{PortState, TokenState, WidgetRegistry};

/// Set to true by the tray Quit handler before calling app.exit(0). The
/// ExitRequested listener checks this flag so it only calls prevent_exit()
/// when the exit was NOT explicitly requested by the user — otherwise
/// app.exit(0) is immediately cancelled by prevent_exit() and Quit never works.
pub struct QuitFlag(pub AtomicBool);

/// Generate a user-friendly error page HTML for the webview.
fn error_page_html(title: &str, detail: &str) -> String {
    let escaped_detail = detail
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    format!(
        r#"document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:20px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a1a;padding:32px;text-align:center"><div style="font-size:48px">🧠</div><h2 style="color:#e2e8f0;margin:0;font-size:18px">{title}</h2><p style="color:#94a3b8;margin:0;font-size:13px">Something went wrong while starting CogniStore.</p><details style="color:#6b7280;font-size:11px;max-width:500px;text-align:left"><summary style="cursor:pointer;color:#94a3b8;font-size:12px;margin-bottom:8px">Show details</summary><pre style="background:#111827;padding:12px;border-radius:8px;overflow-x:auto;color:#fca5a5;font-size:10px;white-space:pre-wrap;word-break:break-all">{escaped_detail}</pre></details><div style="display:flex;gap:12px"><button onclick="location.reload()" style="padding:8px 20px;border-radius:6px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-size:13px">Retry</button></div></div>';"#,
        title = title,
        escaped_detail = escaped_detail
    )
}

/// Run the full setup logic. Extracted so that errors can be caught
/// and displayed in the webview instead of panicking through FFI.
fn run_setup(app: &mut tauri::App) -> Result<(), String> {
    // 1. Find Node.js
    let node_bin = sidecar::find_node()?;

    // 2. Resolve resource paths
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resources: {}", e))?;

    let script_path = resource_dir.join("dist-server").join("index.js");

    if !script_path.exists() {
        return Err(format!("Server script not found at: {:?}", script_path));
    }

    // 3. Resolve SQLite path
    let home = dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    let sqlite_path = home.join(".cognistore").join("knowledge.db");

    // 4. Find available port
    // No ephemeral fallback: the Origin/Host checks and the Tauri capability's
    // remote.urls are pinned to this range, so a port outside it would be
    // reachable but unprotected by any of them.
    let port = sidecar::find_available_port(3210).ok_or_else(|| {
        "No free port in 3210-3309. Close whatever is occupying that range and reopen CogniStore."
            .to_string()
    })?;

    // 5. Spawn sidecar (returns child process, identity token, and its stdout)
    let (child, token, stdout) = sidecar::spawn_node(
        &node_bin,
        &script_path,
        &resource_dir,
        &sqlite_path,
        port,
    )?;

    app.manage(SidecarState::new(child));
    app.manage(PortState { port });
    app.manage(TokenState { token: token.clone() });
    app.manage(WidgetRegistry::default());
    app.manage(WidgetPositions::default());

    // 6. Set up system tray
    tray::setup_tray(app.handle()).map_err(|e| format!("Tray setup failed: {}", e))?;

    // 7. Build the main window with the sidecar token seeded into it.
    //
    // The window is created here rather than declared in tauri.conf.json purely
    // so it can carry an initialization script. The token has to reach the
    // webview out of band: serving it inside index.html would not work, because
    // the SPA route is unauthenticated by necessity (the webview fetches the
    // document before any script of ours has run), so any page on any other
    // local port could fetch `/` and read the credential out of the HTML.
    //
    // An initialization script runs before every page's own scripts and, unlike
    // `eval`, SURVIVES the navigate() below — it is re-injected on each
    // navigation. It is scoped to this webview and never crosses the network.
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("CogniStore")
    .inner_size(1200.0, 800.0)
    .resizable(true)
    .center()
    .initialization_script(&format!(
        "window.__COGNISTORE_TOKEN__ = {};",
        serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into())
    ))
    .build()
    .map_err(|e| format!("Failed to create main window: {}", e))?;

    let app_handle_for_restore = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // Allow up to 120s: a first launch / upgrade without Node 24 present triggers a
        // cold `nvm install 24` before the sidecar can bind, which can exceed 30s.
        let ready = sidecar::wait_for_ready(stdout, Duration::from_secs(120)).await;
        if ready {
            let url = format!("http://localhost:{}", port);
            let _ = window.navigate(url.parse().unwrap());

            // Restore saved widgets after sidecar is ready
            let config = widget_config::load_config();
            for ws in &config.widgets {
                if let Ok(new_label) = widgets::open_widget(app_handle_for_restore.clone(), ws.widget_type.clone(), None).await {
                    // Set position for the new instance and move the window
                    if let Some(positions) = app_handle_for_restore.try_state::<WidgetPositions>() {
                        if let Ok(mut pos) = positions.positions.lock() {
                            pos.insert(new_label.clone(), (ws.x, ws.y));
                        }
                    }
                    if let Some(win) = app_handle_for_restore.get_webview_window(&new_label) {
                        let _ = win.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition::new(ws.x as i32, ws.y as i32),
                        ));
                    }
                }
            }
        } else {
            let detail = format!("The server did not respond within 120 seconds on port {}. Ensure Node.js v24 is installed.", port);
            let _ = window.eval(&error_page_html("Failed to start server", &detail));
        }
    });

    Ok(())
}

fn main() {
    // Workaround for EGL_NOT_INITIALIZED crash on Linux with certain GPU/driver
    // configurations where WebKitGTK's DMABUF renderer fails to initialise.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(QuitFlag(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            widgets::open_widget,
            widgets::close_widget,
            widgets::get_open_widgets,
            secrets::set_provider_secret,
            secrets::delete_provider_secret,
            secrets::cleanup_provider_secrets,
            secrets::set_oauth_tokens,
            secrets::get_oauth_tokens,
            secrets::delete_oauth_tokens,
            oauth::oauth_reserve,
            oauth::oauth_await,
        ])
        .manage(oauth::OAuthListeners::default())
        .setup(|app| {
            if let Err(msg) = run_setup(app) {
                eprintln!("Setup error: {}", msg);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(&error_page_html("CogniStore failed to start", &msg));
                }
            }
            Ok(()) // Always succeed — never panic through FFI
        })
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if label == "main" {
                        // Hide main window instead of closing — reopen via dock/tray
                        api.prevent_close();
                        let _ = window.hide();
                    } else if label.starts_with("widget-") {
                        // User explicitly closed a widget — remove from positions and save to disk
                        if let Some(positions) = window.try_state::<WidgetPositions>() {
                            if let Ok(mut pos) = positions.positions.lock() {
                                pos.remove(&label);
                            }
                        }
                        // Flush remaining positions to disk immediately
                        widgets::flush_widget_config(window.app_handle());
                    }
                }
                tauri::WindowEvent::Moved(position) => {
                    if label.starts_with("widget-") {
                        if let Some(positions) = window.try_state::<WidgetPositions>() {
                            if let Ok(mut pos) = positions.positions.lock() {
                                pos.insert(label.clone(), (position.x as f64, position.y as f64));
                            }
                        }
                        // Flush to disk (debounced — at most once per 500ms during drag)
                        widgets::flush_widget_config_debounced(window.app_handle(), false);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if label == "main" {
                        if let Some(state) = window.try_state::<SidecarState>() {
                            state.kill();
                        }
                    } else if label.starts_with("widget-") {
                        if let Some(registry) = window.try_state::<WidgetRegistry>() {
                            registry.remove(&label);
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("Error while building CogniStore")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                // Only keep running in background when the exit was NOT explicitly
                // requested via the tray Quit item. When QuitFlag is true the user
                // chose to quit; let app.exit(0) go through unblocked.
                let user_quit = app
                    .try_state::<QuitFlag>()
                    .map_or(false, |f| f.0.load(Ordering::Relaxed));
                if !user_quit {
                    api.prevent_exit();
                }
            }
        });
}
