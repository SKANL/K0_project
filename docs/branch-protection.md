# Branch protection for `main`

Configure this in GitHub repository settings as **SKANL**:

- Require pull requests, required `CI / Verify` and `CI / Security and supply chain` checks, and a current branch before merge.
- Require linear history and signed commits where GitHub supports it.
- Restrict push, force-push, branch deletion, and bypass permissions to **SKANL** only.
- Require the `production` environment for stable release tags; only **SKANL** may approve deployments or edit release secrets.

This document records the target state because branch protection is repository administration and is deliberately not changed from a workflow.
