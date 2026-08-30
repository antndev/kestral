mod agent;
mod approval;
mod audit;
mod commands;
mod error;
mod forward;
mod hosts;
mod mcp;
mod model;
mod policy;
mod portable;
mod settings;
mod sftp;
mod skill;
mod snippets;
mod ssh;
mod state;
mod terminal;
mod util;
mod vault;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::state::{AppState, McpInfo, Services};

const MCP_PORT: u16 = 4517;

// Bring the main window back from the tray (or a background second launch).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn ai_status_text(policy: &policy::PolicyEngine) -> String {
    if policy.status().active {
        "AI: on".to_string()
    } else {
        "AI: off".to_string()
    }
}

struct TrayAiItem(tauri::menu::MenuItem<tauri::Wry>);

// Push the current AI access state to the tray line immediately. Called the
// moment access is toggled so the tray never lags behind the app.
pub fn refresh_tray_ai(app: &tauri::AppHandle) {
    let (Some(item), Some(state)) = (app.try_state::<TrayAiItem>(), app.try_state::<AppState>())
    else {
        return;
    };
    let text = ai_status_text(&state.services.policy);
    let item = item.0.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = item.set_text(text);
    });
}

fn kestral_data_dir() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Some(dir) = std::env::var_os("KESTRAL_DATA_DIR")
        .or_else(|| std::env::var_os("HELMSMAN_DATA_DIR"))
    {
        return PathBuf::from(dir);
    }
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return PathBuf::from(".");
    };
    let home = PathBuf::from(home);
    let dir = home.join(".kestral");
    let old = home.join(".helmsman");

    if !dir.exists() && old.exists() {
        match std::fs::rename(&old, &dir) {
            Ok(()) => tracing::info!(
                "Data directory migrated from {} to {}",
                old.display(),
                dir.display()
            ),
            Err(e) => {
                tracing::error!(
                    "Data directory {} could not be renamed to {}: {e}. \
                     Keeping the old directory.",
                    old.display(),
                    dir.display()
                );
                return old;
            }
        }
    }
    dir
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().try_init().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            // When "minimize to tray" is on, the close button hides the window
            // instead of quitting, so the MCP server keeps serving the AI in the
            // background. Picking Exit from the tray sets `quitting` first.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(settings) =
                    window.app_handle().try_state::<Arc<settings::SettingsStore>>()
                {
                    if settings.minimize_to_tray.load(Ordering::SeqCst)
                        && !settings.quitting.load(Ordering::SeqCst)
                    {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .setup(|app| {
            // Paint the loading window in the system's light/dark colour, so the
            // first frame before the webview renders is not a theme-mismatched
            // flash. The app defaults to following the system theme.
            if let Some(w) = app.get_webview_window("main") {
                let dark = w.theme().map(|t| t == tauri::Theme::Dark).unwrap_or(true);
                let color = if dark {
                    tauri::window::Color(10, 10, 10, 255)
                } else {
                    tauri::window::Color(255, 255, 255, 255)
                };
                let _ = w.set_background_color(Some(color));
            }

            let base_dir = kestral_data_dir();
            let _ = std::fs::create_dir_all(&base_dir);
            util::restrict_dir(&base_dir);
            util::harden_dir(&base_dir);

            let settings_store =
                Arc::new(settings::SettingsStore::load(base_dir.join("app_settings.json")));
            app.manage(settings_store);

            let vault_path = base_dir.join("vault.json");

            let vault = Arc::new(vault::Vault::new(vault_path));
            let audit = Arc::new(audit::AuditLog::new(
                base_dir.join("audit.log"),
                vault.clone(),
            ));
            let services = Services {
                vault: vault.clone(),
                hosts: Arc::new(hosts::HostStore::new(base_dir.join("hosts.json"), vault.clone())),
                policy: Arc::new(policy::PolicyEngine::new(
                    base_dir.join("ai_state"),
                    base_dir.join("protected_paths.json"),
                    base_dir.join("ai_caps.json"),
                )),
                approval: Arc::new(approval::ApprovalBroker::new(app.handle().clone())),
                audit: audit.clone(),
                ssh: Arc::new(ssh::SshManager::new(audit.clone())),
                snippets: Arc::new(snippets::SnippetStore::new(
                    base_dir.join("snippets.json"),
                    vault.clone(),
                )),
                transfers_dir: base_dir.join("ai-transfers"),
            };

            let token_path = base_dir.join("mcp_token");
            let token = vault::load_or_create_token(&token_path);
            let bearer: mcp::Bearer = Arc::new(std::sync::RwLock::new(token.clone()));
            let mcp = McpInfo {
                url: format!("http://127.0.0.1:{MCP_PORT}/mcp"),
                token: token.clone(),
                running: false,
            };

            let ct = tokio_util::sync::CancellationToken::new();

            let services_for_mcp = services.clone();
            let bearer_for_mcp = bearer.clone();
            app.manage(AppState {
                services,
                mcp: Mutex::new(mcp),
                mcp_cancel: ct.clone(),
                mcp_bearer: bearer,
                mcp_token_path: token_path,
            });
            app.manage(terminal::Sessions::default());
            app.manage(sftp::SftpSessions::default());
            app.manage(forward::ForwardManager::default());

            let ai_item = tauri::menu::MenuItem::with_id(
                app,
                "tray_ai",
                ai_status_text(&app.state::<AppState>().services.policy),
                false,
                None::<&str>,
            )?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let open_item =
                tauri::menu::MenuItem::with_id(app, "tray_open", "Open", true, None::<&str>)?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "tray_quit", "Exit", true, None::<&str>)?;
            let tray_menu = tauri::menu::Menu::with_items(
                app,
                &[&ai_item, &separator, &open_item, &quit_item],
            )?;
            let _tray = tauri::tray::TrayIconBuilder::with_id("kestral-tray")
                .icon(app.default_window_icon().cloned().expect("window icon"))
                // On macOS the menu-bar icon must be a template: macOS then draws
                // the feather's silhouette from its alpha as a native monochrome
                // glyph instead of squeezing in the full-colour app icon. No-op
                // on Windows, where the tray keeps the colour icon.
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("Kestral")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_open" => show_main(app),
                    "tray_quit" => {
                        if let Some(settings) = app.try_state::<Arc<settings::SettingsStore>>() {
                            settings.quitting.store(true, Ordering::SeqCst);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Toggling AI access updates the tray line instantly (see
            // refresh_tray_ai in ai_enable/ai_disable). This poll is only the
            // safety net for changes with no command behind them: a timed
            // expiry, or the protected-path kill switch tripping.
            app.manage(TrayAiItem(ai_item.clone()));
            let tray_policy = app.state::<AppState>().services.policy.clone();
            let tray_ai_item = ai_item.clone();
            let tray_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last = String::new();
                loop {
                    let text = ai_status_text(&tray_policy);
                    if text != last {
                        last = text.clone();
                        let item = tray_ai_item.clone();
                        let _ = tray_app.run_on_main_thread(move || {
                            let _ = item.set_text(text);
                        });
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            });

            let mcp_handle = app.handle().clone();
            let reset_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::serve(mcp_handle, services_for_mcp, bearer_for_mcp, MCP_PORT, ct).await {
                    tracing::error!("MCP server stopped: {e}");
                }
                if let Some(state) = reset_handle.try_state::<AppState>() {
                    if let Ok(mut info) = state.mcp.lock() {
                        info.running = false;
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_exists,
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_change_master,
            commands::vault_export,
            commands::vault_import,
            commands::secret_put,
            commands::secret_list,
            commands::secret_delete,
            commands::secret_reveal,
            commands::generate_key,
            commands::derive_pubkey,
            commands::app_changelog,
            commands::drag_icon_path,
            commands::host_list,
            commands::host_add,
            commands::host_update,
            commands::host_remove,
            commands::host_set_policy,
            commands::host_set_file_policy,
            commands::ai_status,
            commands::ai_enable,
            commands::ai_disable,
            commands::ai_caps,
            commands::ai_set_caps,
            commands::ai_protected_list,
            commands::ai_set_protected,
            commands::approval_respond,
            commands::audit_list,
            commands::audit_user_command,
            commands::snippet_list,
            commands::snippet_add,
            commands::snippet_update,
            commands::snippet_delete,
            commands::mcp_info,
            commands::mcp_rotate_token,
            commands::mcp_connect_claude_code,
            commands::install_skill,
            commands::uninstall_skill,
            commands::skill_installed,
            commands::data_warnings,
            commands::mcp_list_registrations,
            commands::mcp_remove_registration,
            commands::run_command_ui,
            commands::run_command_stream,
            commands::forward_start,
            commands::forward_stop,
            commands::forward_active,
            commands::sftp_open,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_download_dir,
            commands::sftp_upload,
            commands::sftp_upload_dir,
            commands::sftp_read_text,
            commands::sftp_write_text,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_close,
            terminal::ssh_open_shell,
            terminal::ssh_write,
            terminal::ssh_resize,
            terminal::ssh_close,
            commands::settings_get,
            commands::settings_set_minimize_to_tray,
            commands::settings_set_onboarded,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.mcp_cancel.cancel();
                }
            }
        });
}
