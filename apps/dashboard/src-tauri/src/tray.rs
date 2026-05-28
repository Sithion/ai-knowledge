use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::widgets;

const SHOW_ID: &str = "show-app";
const QUIT_ID: &str = "quit";
const WIDGET_STATS_ID: &str = "widget-stats";
const WIDGET_PLANS_ID: &str = "widget-plans";
const WIDGET_ACTIVE_ID: &str = "widget-active-plans";
const WIDGET_TOKENS_ID: &str = "widget-tokens";

/// Open a widget from the tray, recording (instead of silently discarding) any
/// failure. Widget-open errors used to vanish via `let _ = ...`, so a click that
/// failed looked identical to the feature not existing — especially on Linux.
fn open_widget_from_tray(app: &AppHandle, widget_id: &str) {
    // Call the sync helper directly — the tray callback already runs on the main
    // thread, so we skip the async command + run_on_main_thread indirection.
    if let Err(e) = widgets::build_widget_window(app, widget_id.into(), None) {
        widgets::widget_log(&format!("tray failed to open widget '{}': {}", widget_id, e));
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_app = MenuItem::with_id(app, SHOW_ID, "Show CogniStore", true, None::<&str>)?;

    // Widgets submenu
    let w_stats = MenuItem::with_id(app, WIDGET_STATS_ID, "Knowledge Stats", true, None::<&str>)?;
    let w_plans = MenuItem::with_id(app, WIDGET_PLANS_ID, "Plan Stats", true, None::<&str>)?;
    let w_active = MenuItem::with_id(app, WIDGET_ACTIVE_ID, "Active Plans", true, None::<&str>)?;
    let w_tokens = MenuItem::with_id(app, WIDGET_TOKENS_ID, "Token Consumption", true, None::<&str>)?;
    let widgets_menu = Submenu::with_items(app, "Widgets", true, &[&w_stats, &w_plans, &w_active, &w_tokens])?;

    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_app, &widgets_menu, &separator, &quit])?;

    let _tray = TrayIconBuilder::new()
        .icon(Image::from_path("icons/32x32.png").unwrap_or_else(|_| {
            Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("Failed to load tray icon")
        }))
        .menu(&menu)
        .tooltip("CogniStore")
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                x if x == SHOW_ID => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                x if x == WIDGET_STATS_ID => open_widget_from_tray(app, "stats"),
                x if x == WIDGET_PLANS_ID => open_widget_from_tray(app, "plans"),
                x if x == WIDGET_ACTIVE_ID => open_widget_from_tray(app, "active-plans"),
                x if x == WIDGET_TOKENS_ID => open_widget_from_tray(app, "tokens"),
                x if x == QUIT_ID => {
                    // Signal intentional quit BEFORE app.exit(0) so the
                    // ExitRequested handler doesn't call prevent_exit() and
                    // silently cancel the quit. Without this flag the app stays
                    // running even after the user clicks Quit.
                    if let Some(flag) = app.try_state::<crate::QuitFlag>() {
                        flag.0.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    widgets::flush_widget_config(app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
