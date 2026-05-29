# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not file public issues for security vulnerabilities.**

To report a vulnerability:

1. Email **admin@kyanitelabs.tech** with subject line `[SECURITY] Epoch vulnerability`
2. Include: affected version, attack vector, impact assessment, proof of concept (if available)
3. You will receive acknowledgment within 48 hours
4. We will confirm or dismiss the report within 7 days
5. If confirmed, we will patch and release within 30 days

## Security Controls

- **Supply chain**: All GitHub Actions pinned by SHA. Dependencies audited in CI via `pnpm audit`. Dependabot enabled for npm and GitHub Actions.
- **Secret scanning**: [gitleaks](https://gitleaks.io/) runs on every push and pull request.
- **Input validation**: All tool inputs validated via Zod schemas. HTTP requests limited to 1 MB.
- **Telemetry**: Fully opt-in (disabled by default). Data is anonymized. HMAC-signed payloads.
- **HTTP server**: Binds to `127.0.0.1` by default. Rate-limited (100 req/min, configurable). CORS enabled.
- **No secrets in source**: No API keys, tokens, or credentials in the codebase. All configuration via environment variables.
- **npm provenance**: Published packages include signed provenance attestations.

## Scope

This policy applies to the Epoch MCP server codebase, its CI/CD pipeline, and the published npm package. It does not cover:
- Downstream integrations or third-party MCP clients
- User-deployed infrastructure (reverse proxies, load balancers)
- Issues in dependencies (report upstream, we will update)
