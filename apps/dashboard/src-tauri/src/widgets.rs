use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::widget_config::{self, WidgetPositions};

/// Append a widget diagnostic/error line to ~/.cognistore/cognistore.log and stderr.
/// Widget-open failures used to be swallowed silently; now they are recorded.
pub fn widget_log(msg: &str) {
    eprintln!("[widget] {}", msg);
    if let Some(home) = dirs::home_dir() {
        let path = home.join(".cognistore").join("cognistore.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            use std::io::Write;
            let _ = writeln!(f, "[widget] {}", msg);
        }
    }
}

/// Stores the sidecar port so widget windows can connect to the same server.
pub struct PortState {
    pub port: u16,
}

/// Counter for generating unique widget instance labels.
static INSTANCE_COUNTER: AtomicU32 = AtomicU32::new(1);

/// Tracks open widget instances: label -> widget_type
pub struct WidgetRegistry {
    pub instances: Mutex<HashMap<String, String>>,
}

impl Default for WidgetRegistry {
    fn default() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }
}

impl WidgetRegistry {
    pub fn remove(&self, label: &str) {
        if let Ok(mut map) = self.instances.lock() {
            map.remove(label);
        }
    }
}

/// Widget definitions: (width, height) per widget type.
fn widget_size(widget_type: &str) -> (f64, f64) {
    match widget_type {
        "stats" => (300.0, 240.0),
        "plans" => (300.0, 260.0),
        "active-plans" => (320.0, 400.0),
        "tokens" => (320.0, 300.0),
        _ => (300.0, 220.0),
    }
}

/// Extract the widget type from a window label (e.g. "widget-stats-3" -> "stats")
pub fn widget_type_from_label(label: &str) -> String {
    let without_prefix = label.strip_prefix("widget-").unwrap_or(label);
    // Remove the trailing -N instance number
    if let Some(pos) = without_prefix.rfind('-') {
        let (base, suffix) = without_prefix.split_at(pos);
        // Check if the suffix (after '-') is a number
        if suffix[1..].parse::<u32>().is_ok() {
            return base.to_string();
        }
    }
    without_prefix.to_string()
}

/// Build and show a widget window synchronously. Must be called on the main thread
/// (GTK requirement). Used directly by the tray path (already on the main thread)
/// and dispatched via run_on_main_thread by the async command path.
pub fn build_widget_window(app: &AppHandle, widget_id: String, params: Option<String>) -> Result<String, String> {
    let instance_num = INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("widget-{}-{}", widget_id, instance_num);

    let port = app.state::<PortState>().port;
    let query = params.map(|p| format!("?{}", p)).unwrap_or_default();
    let url = format!("http://localhost:{}/widgets/{}.html{}", port, widget_id, query);
    let (w, h) = widget_size(&widget_id);

    let parsed_url = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            widget_log(&format!("failed to parse widget URL for {}: {}", label, e));
            return Err(format!("Failed to parse widget URL: {}", e));
        }
    };

    // NOTE: widget windows are intentionally OPAQUE. macOS transparent webview
    // windows render blank in release/DMG builds (tauri#13415 / wry#1524), which
    // made widgets invisible ("nothing appears"). The content uses a solid dark
    // background (widget.css) so an opaque window looks the same minus the
    // see-through/rounded outer corners.
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed_url))
        .title("")
        .inner_size(w, h)
        .decorations(false)
        .transparent(false)
        .resizable(false);

    // always_on_top + skip_taskbar at creation time are unreliable on Linux
    // WebKitGTK (X11/Wayland WMs): a borderless, always-on-top, taskbar-skipped
    // window can fail to map, render blank, or land off-screen. On Linux we build
    // without them and set always-on-top AFTER the window maps (see below); on
    // macOS/Windows they're safe to set up front.
    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.always_on_top(true).skip_taskbar(true);
    }

    // Restore saved position for this specific label, or center
    if let Some((x, y)) = widget_config::get_widget_position(&label) {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }

    // Surface failures that used to be swallowed (the tray path ignores the Result).
    let window = match builder.build() {
        Ok(win) => win,
        Err(e) => {
            widget_log(&format!("failed to create widget window {}: {}", label, e));
            return Err(format!("Failed to create widget window: {}", e));
        }
    };

    // On Linux, apply always-on-top post-map (more reliable than at build time).
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = window.set_always_on_top(true) {
            widget_log(&format!("set_always_on_top failed for {}: {}", label, e));
        }
    }

    if let Ok(mut map) = app.state::<WidgetRegistry>().instances.lock() {
        map.insert(label.clone(), widget_id);
    }

    Ok(label)
}

/// IPC command: open a widget window from the webview UI.
///
/// Must be `async` — creating a WebviewWindow inside a *synchronous* Tauri command
/// deadlocks on Linux/WebKitGTK because the sync command runs on the main thread and
/// `builder.build()` reenters the GTK event loop (which is blocked waiting for the
/// command to return). Making the command async moves it off the main thread;
/// `run_on_main_thread` then queues the actual build back onto the now-free GTK loop.
/// The tray path (`build_widget_window` called directly from Rust) is unaffected
/// because tray callbacks already run on the main thread and never go through IPC.
#[tauri::command]
pub async fn open_widget(app: AppHandle, widget_id: String, params: Option<String>) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let app_clone = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(build_widget_window(&app_clone, widget_id, params));
    })
    .map_err(|e| format!("failed to dispatch to main thread: {e}"))?;
    rx.recv().map_err(|e| format!("widget build channel closed unexpectedly: {e}"))?
}

#[tauri::command]
pub fn close_widget(app: AppHandle, widget_id: String) -> Result<(), String> {
    // widget_id can be either:
    // - a full label like "widget-stats-1" (from the widget's close button)
    // - a widget type like "stats" (close the first instance of that type)
    let label = if widget_id.starts_with("widget-") {
        widget_id.clone()
    } else {
        // Find the first instance of this widget type
        let registry = app.state::<WidgetRegistry>();
        let found = registry
            .instances
            .lock()
            .ok()
            .and_then(|map| {
                map.iter()
                    .find(|(_, wtype)| **wtype == widget_id)
                    .map(|(label, _)| label.clone())
            });
        match found {
            Some(l) => l,
            None => return Ok(()), // No instance found, nothing to close
        }
    };

    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    // Registry and position cleanup happens in the Destroyed event handler
    Ok(())
}

#[tauri::command]
pub fn get_open_widgets(app: AppHandle) -> Vec<String> {
    // Return widget types (with duplicates for multiple instances)
    app.state::<WidgetRegistry>()
        .instances
        .lock()
        .map(|map| map.values().cloned().collect())
        .unwrap_or_default()
}

/// Flush current in-memory widget positions to disk.
/// When `force` is false, debounces to at most once per 500ms.
pub fn flush_widget_config_debounced(app: &AppHandle, force: bool) {
    if let Some(positions) = app.try_state::<WidgetPositions>() {
        // Debounce: skip if flushed less than 500ms ago (unless forced)
        if !force {
            if let Ok(mut last) = positions.last_flush.lock() {
                if last.elapsed().as_millis() < 500 {
                    return;
                }
                *last = std::time::Instant::now();
            }
        }
        if let Ok(pos) = positions.positions.lock() {
            let widgets: Vec<widget_config::WidgetState> = pos
                .iter()
                .map(|(label, (x, y))| {
                    let wtype = widget_type_from_label(label);
                    widget_config::WidgetState {
                        label: label.clone(),
                        widget_type: wtype,
                        x: *x,
                        y: *y,
                    }
                })
                .collect();
            widget_config::save_config(&widget_config::WidgetConfig { widgets });
        }
    }
}

/// Flush current in-memory widget positions to disk (always writes).
pub fn flush_widget_config(app: &AppHandle) {
    flush_widget_config_debounced(app, true);
}
