// These tests exercise the same typed entry mapping used by the registered Tauri commands.
use crate::{
    browser_health, browser_navigate, invoke_registered_product_entry, product_consent_resolve,
    BrowserNavigateRequest, ProductIpcCommand, ToolApprovalDecision,
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
