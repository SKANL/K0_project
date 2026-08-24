use serde::{Deserialize, Serialize};
use tauri::Manager;

#[cfg(test)]
mod ipc_tests;

const MAIN_CAPABILITY: &str = "main-capability";
const MAIN_CAPABILITY_DOCUMENT: &str = include_str!("../capabilities/main.json");

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ProductIpcCommand {
    AppDataPath,
    ProductShellContract,
    BrowserHealth,
    BrowserNavigate,
    ResolveToolApproval,
}

fn resolve_registered_command(command: &str) -> Result<ProductIpcCommand, &'static str> {
    match command {
        "k0_app_data_path" => Ok(ProductIpcCommand::AppDataPath),
        "k0_product_shell_contract" => Ok(ProductIpcCommand::ProductShellContract),
        "browser_health" => Ok(ProductIpcCommand::BrowserHealth),
        "browser_navigate" => Ok(ProductIpcCommand::BrowserNavigate),
        "product_consent_resolve" => Ok(ProductIpcCommand::ResolveToolApproval),
        _ => Err("IPC_COMMAND_DENIED"),
    }
}

fn capability_for(command: ProductIpcCommand) -> &'static str {
    match command {
        ProductIpcCommand::AppDataPath
        | ProductIpcCommand::ProductShellContract
        | ProductIpcCommand::BrowserHealth
        | ProductIpcCommand::BrowserNavigate
        | ProductIpcCommand::ResolveToolApproval => MAIN_CAPABILITY,
    }
}

fn capability_document_allows(capability: &str) -> Result<(), &'static str> {
    if capability == MAIN_CAPABILITY
        && MAIN_CAPABILITY_DOCUMENT.contains("\"identifier\": \"main-capability\"")
    {
        Ok(())
    } else {
        Err("IPC_CAPABILITY_DENIED")
    }
}

fn invoke_registered_product_entry(entry: &str) -> Result<ProductIpcCommand, &'static str> {
    let (capability, command_name) = entry.split_once('/').ok_or("IPC_COMMAND_DENIED")?;
    let command = resolve_registered_command(command_name)?;
    capability_document_allows(capability)?;
    if capability_for(command) != capability {
        return Err("IPC_CAPABILITY_DENIED");
    }
    Ok(command)
}

fn authorize_registered_entry(command_name: &str) -> Result<ProductIpcCommand, &'static str> {
    invoke_registered_product_entry(&format!("{MAIN_CAPABILITY}/{command_name}"))
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct ProductIpcError {
    code: &'static str,
}

impl ProductIpcError {
    fn denied(code: &'static str) -> Self {
        Self { code }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct BrowserHealth {
    healthy: bool,
}

#[derive(Debug, Deserialize)]
struct BrowserNavigateRequest {
    id: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct ToolApprovalDecision {
    command_id: String,
    approved: bool,
}

fn authorize_handler(command_name: &str) -> Result<ProductIpcCommand, ProductIpcError> {
    authorize_registered_entry(command_name).map_err(ProductIpcError::denied)
}

#[tauri::command]
fn k0_app_data_path(app: tauri::AppHandle) -> Result<String, String> {
    authorize_registered_entry("k0_app_data_path").map_err(str::to_owned)?;
    app.path()
        .app_data_dir()
        .map(|path| path.join("K0").to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn k0_product_shell_contract() -> &'static str {
    authorize_registered_entry("k0_product_shell_contract")
        .expect("registered command must map to the installed main capability");
    "product-shell/v1"
}

#[tauri::command]
fn browser_health() -> Result<BrowserHealth, ProductIpcError> {
    authorize_handler("browser_health")?;
    Ok(BrowserHealth { healthy: true })
}

#[tauri::command]
fn browser_navigate(args: BrowserNavigateRequest) -> Result<(), ProductIpcError> {
    authorize_handler("browser_navigate")?;
    if args.id.trim().is_empty() || !args.url.starts_with("https://") {
        return Err(ProductIpcError::denied("BROWSER_REQUEST_DENIED"));
    }
    Err(ProductIpcError::denied("BROWSER_CAPABILITY_DENIED"))
}

#[tauri::command]
fn product_consent_resolve(args: ToolApprovalDecision) -> Result<(), ProductIpcError> {
    authorize_handler("product_consent_resolve")?;
    if args.command_id.trim().is_empty() || !args.approved {
        return Err(ProductIpcError::denied("CONSENT_DENIED"));
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            k0_app_data_path,
            k0_product_shell_contract,
            browser_health,
            browser_navigate,
            product_consent_resolve
        ])
        .run(tauri::generate_context!())
        .expect("failed to run K0 Tauri application");
}
