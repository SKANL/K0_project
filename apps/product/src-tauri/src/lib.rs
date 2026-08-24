use tauri::Manager;

#[tauri::command]
fn k0_app_data_path(app: tauri::AppHandle) -> Result<String, String> {
    app.path().app_data_dir()
        .map(|path| path.join("K0").to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![k0_app_data_path])
        .run(tauri::generate_context!())
        .expect("failed to run K0 Tauri application");
}
