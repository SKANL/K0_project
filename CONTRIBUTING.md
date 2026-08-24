# Contributing to K0

Thank you for helping improve K0. Contributions are evaluated for correctness, security impact, operational safety, and long-term maintainability.

## Before you begin

1. Read the [security policy](./.github/SECURITY.md). Do not report vulnerabilities in public issues or pull requests.
2. Search existing issues and pull requests to avoid duplicate work.
3. Open an issue before a substantial feature, behavior change, or architectural proposal so maintainers can confirm scope.

## Development workflow

1. Fork the repository and create a focused branch from `main`.
2. Make the smallest coherent change, including tests or documentation when behavior changes.
3. Run the relevant checks locally:

   ```sh
   npm test
   npm run typecheck
   npm run build:product
   ```

4. Open a pull request using the repository template. Explain the problem, the approach, validation performed, and any operational or security impact.

## Contribution standards

- Keep commits focused and use conventional commit messages.
- Do not commit secrets, signing material, private customer data, generated credentials, or local environment files.
- Preserve fail-closed behavior and document changes to deployment, release, or security assumptions.
- Follow existing project style and avoid unrelated formatting or refactors.
- Be respectful and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Review and release

Maintainers decide what is accepted, when it is released, and which release controls apply. A pull request is not a commitment to merge or support a feature. Release and deployment credentials remain maintainer-managed.

## Getting help

For non-security questions and reproducible problems, follow [SUPPORT.md](./SUPPORT.md). Security reports must use the private path in [SECURITY.md](./.github/SECURITY.md).
