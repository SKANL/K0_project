# Release incident runbook

## First action

Stop promotion. Do not retry a stable release until the failing control is understood.

## Triage checklist

- [ ] Confirm tag, commit, release channel, and GitHub environment approval.
- [ ] Verify SBOM, `checksums.txt`, GitHub attestation, and Cosign provenance bundle.
- [ ] Inspect redacted diagnostics for update, startup, vault, adapter, and browser codes.
- [ ] Confirm workers drained and resumed exactly once.

## Recovery

| Symptom | Action |
| --- | --- |
| Signature/provenance failure | Revoke the release; rotate the affected GitHub secret or key; publish a new signed tag. |
| Startup health failure | Keep the verified prior release active; investigate the health code; do not bypass rollback. |
| Updater tamper/downgrade rejection | Preserve artifacts for forensics; publish a strictly newer, verified release. |
| macOS notarization failure | Correct Apple credentials in `production`; rebuild from the same reviewed commit. |

## Exit criteria

A replacement release must pass CI, signature verification, provenance verification, smoke journeys, and protected environment approval. SKANL alone authorizes the next stable promotion.
