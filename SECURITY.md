# Security Policy

## Supported Branch

Security fixes are currently maintained on `main`.

## Reporting a Vulnerability

If you find a vulnerability:

1. Do not open a public issue with exploit details.
2. Contact the maintainers privately first.
3. Include reproduction steps, impact, and affected files/paths.

## Secrets and Key Handling

- Never commit real provider keys.
- Keep secrets in local `.env` only.
- Use `.env.example` placeholders for documentation.
- Rotate keys immediately if accidental exposure is suspected.

## Pre-Publish Security Gate

Run this before opening PRs or pushing public changes:

```bash
npm run prepublish:audit
git status --short
```

The audit script checks tracked files for:

- high-confidence secret patterns
- high-risk PII markers
- tracked temp/junk artifacts

## Third-Party Sources

This repository includes upstream third-party code under `doom-wasm-main/`.

- Upstream attribution metadata (including public maintainer contact info) may exist there.
- Do not remove required license or attribution content from vendored upstream code.
