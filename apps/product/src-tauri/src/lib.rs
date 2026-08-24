use serde::{Deserialize, Serialize};
use tauri::Manager;

const VAULT_SERVICE: &str = "com.boop.k0.production-vault";
const VAULT_BACKEND_VERSION: &str = "1.0.0";

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
    VaultBackend,
    VaultGet,
    VaultPut,
}

fn resolve_registered_command(command: &str) -> Result<ProductIpcCommand, &'static str> {
    match command {
        "k0_app_data_path" => Ok(ProductIpcCommand::AppDataPath),
        "k0_product_shell_contract" => Ok(ProductIpcCommand::ProductShellContract),
        "browser_health" => Ok(ProductIpcCommand::BrowserHealth),
        "browser_navigate" => Ok(ProductIpcCommand::BrowserNavigate),
        "product_consent_resolve" => Ok(ProductIpcCommand::ResolveToolApproval),
        "vault_backend" => Ok(ProductIpcCommand::VaultBackend),
        "vault_get" => Ok(ProductIpcCommand::VaultGet),
        "vault_put" => Ok(ProductIpcCommand::VaultPut),
        _ => Err("IPC_COMMAND_DENIED"),
    }
}

fn capability_for(command: ProductIpcCommand) -> &'static str {
    match command {
        ProductIpcCommand::AppDataPath
        | ProductIpcCommand::ProductShellContract
        | ProductIpcCommand::BrowserHealth
        | ProductIpcCommand::BrowserNavigate
        | ProductIpcCommand::ResolveToolApproval
        | ProductIpcCommand::VaultBackend
        | ProductIpcCommand::VaultGet
        | ProductIpcCommand::VaultPut => MAIN_CAPABILITY,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultGetRequest {
    tenant_id: String,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultPutRequest {
    tenant_id: String,
    key: String,
    value: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct VaultBackendResponse {
    platform: &'static str,
    provider: &'static str,
    version: &'static str,
    approval: &'static str,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct VaultGetResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct VaultPutResponse {
    status: &'static str,
}

fn authorize_handler(command_name: &str) -> Result<ProductIpcCommand, ProductIpcError> {
    authorize_registered_entry(command_name).map_err(ProductIpcError::denied)
}

fn vault_input_is_valid(tenant_id: &str, key: &str) -> bool {
    !tenant_id.trim().is_empty() && !key.trim().is_empty()
}

fn vault_backend_response() -> Result<VaultBackendResponse, ProductIpcError> {
    #[cfg(target_os = "windows")]
    {
        return Ok(VaultBackendResponse {
            platform: "windows",
            provider: "windows-credential-manager",
            version: VAULT_BACKEND_VERSION,
            approval: "approved",
        });
    }
    #[cfg(target_os = "macos")]
    {
        return Ok(VaultBackendResponse {
            platform: "macos",
            provider: "macos-keychain",
            version: VAULT_BACKEND_VERSION,
            approval: "approved",
        });
    }
    #[cfg(target_os = "linux")]
    {
        return Ok(VaultBackendResponse {
            platform: "linux",
            provider: "linux-secret-service",
            version: VAULT_BACKEND_VERSION,
            approval: "approved",
        });
    }
    #[allow(unreachable_code)]
    Err(ProductIpcError::denied("VAULT_UNSUPPORTED"))
}

fn native_vault_entry(tenant_id: &str, key: &str) -> Result<keyring::Entry, ProductIpcError> {
    vault_backend_response()?;
    keyring::Entry::new(VAULT_SERVICE, &format!("{tenant_id}\u{0}{key}"))
        .map_err(|_| ProductIpcError::denied("VAULT_UNSUPPORTED"))
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

/// Reports the one OS credential store compiled into this production binary.
/// Unsupported targets are denied; this boundary intentionally has no fallback store.
#[tauri::command]
fn vault_backend() -> Result<VaultBackendResponse, ProductIpcError> {
    authorize_handler("vault_backend")?;
    vault_backend_response()
}

/// Reads a tenant-scoped credential only from the native OS vault.
#[tauri::command]
fn vault_get(args: VaultGetRequest) -> Result<VaultGetResponse, ProductIpcError> {
    authorize_handler("vault_get")?;
    if !vault_input_is_valid(&args.tenant_id, &args.key) {
        return Err(ProductIpcError::denied("VAULT_INPUT_INVALID"));
    }
    match native_vault_entry(&args.tenant_id, &args.key)?.get_password() {
        Ok(value) if !value.is_empty() => Ok(VaultGetResponse {
            status: "available",
            value: Some(value),
            code: None,
        }),
        _ => Ok(VaultGetResponse {
            status: "unsupported",
            value: None,
            code: Some("VAULT_UNSUPPORTED"),
        }),
    }
}

/// Writes a tenant-scoped credential only to the native OS vault.
#[tauri::command]
fn vault_put(args: VaultPutRequest) -> Result<VaultPutResponse, ProductIpcError> {
    authorize_handler("vault_put")?;
    if !vault_input_is_valid(&args.tenant_id, &args.key) || args.value.is_empty() {
        return Err(ProductIpcError::denied("VAULT_INPUT_INVALID"));
    }
    native_vault_entry(&args.tenant_id, &args.key)?
        .set_password(&args.value)
        .map_err(|_| ProductIpcError::denied("VAULT_UNSUPPORTED"))?;
    Ok(VaultPutResponse { status: "stored" })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            k0_app_data_path,
            k0_product_shell_contract,
            browser_health,
            browser_navigate,
            product_consent_resolve,
            vault_backend,
            vault_get,
            vault_put
        ])
        .run(tauri::generate_context!())
        .expect("failed to run K0 Tauri application");
}
