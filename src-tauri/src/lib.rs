use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const QUICK_WINDOW_LABEL: &str = "quick";
const MAIN_WINDOW_LABEL: &str = "main";

fn show_window(window: &tauri::WebviewWindow) {
  let _ = window.unminimize();
  let _ = window.show();
  let _ = window.set_focus();
}

fn show_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    show_window(&window);
  }
}

fn ensure_quick_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
  if let Some(window) = app.get_webview_window(QUICK_WINDOW_LABEL) {
    return Ok(window);
  }

  WebviewWindowBuilder::new(
    app,
    QUICK_WINDOW_LABEL,
    WebviewUrl::App("index.html?desktop=quick".into()),
  )
  .title("RAI")
  .inner_size(460.0, 720.0)
  .min_inner_size(360.0, 560.0)
  .resizable(true)
  .visible(false)
  .build()
}

fn toggle_quick_window(app: &tauri::AppHandle) {
  match ensure_quick_window(app) {
    Ok(window) => {
      if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
      } else {
        let _ = window.eval("window.syncTauriAuthStateFromStorage && window.syncTauriAuthStateFromStorage();");
        show_window(&window);
      }
    }
    Err(error) => {
      eprintln!("failed to open RAI quick window: {error}");
    }
  }
}

fn hide_all_windows(app: &tauri::AppHandle) {
  for window in app.webview_windows().values() {
    let _ = window.hide();
  }
}

#[tauri::command]
fn desktop_show_quick_window(app: tauri::AppHandle) {
  if let Ok(window) = ensure_quick_window(&app) {
    let _ = window.eval("window.syncTauriAuthStateFromStorage && window.syncTauriAuthStateFromStorage();");
    show_window(&window);
  }
}

#[tauri::command]
fn desktop_show_main_window(app: tauri::AppHandle) {
  show_main_window(&app);
}

#[tauri::command]
fn desktop_hide_windows(app: tauri::AppHandle) {
  hide_all_windows(&app);
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
  let quick_i = MenuItem::with_id(app, "quick", "快速对话", true, None::<&str>)?;
  let main_i = MenuItem::with_id(app, "main", "打开完整 RAI", true, None::<&str>)?;
  let hide_i = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
  let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&quick_i, &main_i, &hide_i, &quit_i])?;

  let mut tray = TrayIconBuilder::new()
    .tooltip("RAI")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "quick" => toggle_quick_window(app),
      "main" => show_main_window(app),
      "hide" => hide_all_windows(app),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        toggle_quick_window(tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(icon.clone());
  }

  tray.build(app)?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
          .build(),
        )?;
      }
      setup_tray(app)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      desktop_show_quick_window,
      desktop_show_main_window,
      desktop_hide_windows
    ])
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
