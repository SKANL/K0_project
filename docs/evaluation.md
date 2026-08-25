# Evaluation harness

K0 exposes a deterministic, provider-neutral evaluation harness for boundary behavior rather than model rankings.

## Run it

```bash
npm run eval:test
```

The normal `npm test` command also includes `tests/evals/**`, so CI executes the harness through the repository's existing test job. No provider credentials, network calls, browser sessions, or model-specific fixtures are required.

## What it checks

`evals/fixtures.ts` contains stable inputs for idempotency, determinism, memory provenance, browser safety, recovery, and output quality. An adapter supplies observations through the `EvaluationAdapter` contract. Each fixture is executed twice and the report uses canonical JSON plus SHA-256 digests, making failures reproducible and auditable.

- **Idempotency/determinism:** repeated result digests must match.
- **Memory provenance:** every memory record needs an identifier, source, source type, and positive timestamp.
- **Browser safety:** only allowlisted actions and `http(s)` navigation are accepted, with explicit confirmation and no secret-bearing trace.
- **Recovery:** a transient failure must be attempted and recovered with a named action.
- **Output quality:** required fields must be present, the score must meet `0.8`, and secrets are rejected.

Reports contain fixture IDs, categories, attempts, and output digests. Failure details are intentionally code-only so sensitive adapter output cannot leak through the harness.
