# Updater threat model

| Threat | Mitigation | Verification |
| --- | --- | --- |
| Tampered artifact or manifest | SHA-256 provenance equality plus Ed25519 manifest verification | updater negative tests |
| Downgrade | Strictly monotonic semantic versions | updater negative tests |
| Unsigned stable release | Protected production environment, OIDC, Tauri signing, Cosign bundle | release preflight |
| Unhealthy update | Drain workers, health check, verified rollback, resume workers | updater smoke journey |
| Secret disclosure | GitHub secrets only, redacted diagnostics, Gitleaks | CI security job |

This model intentionally fails closed. A missing trust key, signature verifier, runtime capability, worker port, diagnostics sink, or stable provenance record rejects the operation.
