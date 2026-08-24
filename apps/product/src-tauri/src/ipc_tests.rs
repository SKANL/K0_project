// These tests exercise the same typed entry mapping used by the registered Tauri commands.
use crate::{
    browser_health, browser_navigate, invoke_registered_product_entry, product_consent_resolve,
    vault_backend, vault_get, vault_put, BrowserNavigateRequest, ProductIpcCommand,
    ToolApprovalDecision, VaultGetRequest, VaultPutRequest,
};

#[test]
fn registered_product_entry_uses_its_fixed_main_capability() {
    assert_eq!(
        invoke_registered_product_entry("main-capability/k0_product_shell_contract"),
        Ok(ProductIpcCommand::ProductShellContract)
    );
}

#[test]
fn registered_product_entry_rejects_wrong_capability_and_unknown_command_without_caller_authority()
{
    assert_eq!(
        invoke_registered_product_entry("wrong-capability/k0_product_shell_contract"),
        Err("IPC_CAPABILITY_DENIED")
    );
    assert_eq!(
        invoke_registered_product_entry("main-capability/shell.open"),
        Err("IPC_COMMAND_DENIED")
    );
}

#[test]
fn registered_browser_handlers_enforce_their_fixed_capability_at_the_handler_boundary() {
    assert_eq!(browser_health().unwrap().healthy, true);
    assert_eq!(
        browser_navigate(BrowserNavigateRequest {
            id: "navigate-1".into(),
            url: "https://example.com".into(),
        })
        .unwrap_err()
        .code,
        "BROWSER_CAPABILITY_DENIED"
    );
}

#[test]
fn consent_handler_returns_a_typed_denial_for_unapproved_actions() {
    assert_eq!(
        product_consent_resolve(ToolApprovalDecision {
            command_id: "navigate-1".into(),
            approved: false,
        })
        .unwrap_err()
        .code,
        "CONSENT_DENIED"
    );
}

#[test]
fn native_vault_commands_are_registered_and_fail_closed_without_a_test_fallback() {
    assert_eq!(
        invoke_registered_product_entry("main-capability/vault_get"),
        Ok(ProductIpcCommand::VaultGet)
    );
    assert!(vault_backend().is_ok());
    assert_eq!(
        vault_get(VaultGetRequest {
            tenant_id: "".into(),
            key: "model".into(),
        })
        .unwrap_err()
        .code,
        "VAULT_INPUT_INVALID"
    );
    assert_eq!(
        vault_put(VaultPutRequest {
            tenant_id: "tenant-a".into(),
            key: "model".into(),
            value: "".into(),
        })
        .unwrap_err()
        .code,
        "VAULT_INPUT_INVALID"
    );
}
