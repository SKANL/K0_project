# Observability and diagnostics

`packages/observability` provides an in-memory, provider-neutral diagnostics boundary for local support reports.

## Privacy policy

Diagnostics require an explicit `{ enabled: true }` policy. Disabled collectors store no events. The module has no transport, HTTP client, telemetry exporter, or credential access API; callers choose whether to export the deterministic report string locally.

All event attributes are recursively redacted. Sensitive keys and values include credentials, tokens, passwords, API keys, email addresses, URLs, and query strings. Correlation/request IDs are only propagated when they match the safe identifier format; unsafe values are replaced with a generated ID.

## Health and support reports

`evaluateHealth` produces liveness, readiness, and provider-neutral dependency signals. Readiness requires liveness and every declared dependency to be healthy.

`createDiagnostics(...).export()` produces canonical JSON (`diagnostic-report/v1`): sorted health dependencies and events, redacted fields, and no I/O. Supplying stable timestamps and a correlation-ID factory makes support exports byte-for-byte reproducible.
