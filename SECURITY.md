# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Ontic Strip, **please do not open a
public GitHub issue.** Instead, report it responsibly so we can address it before
it is disclosed publicly.

### How to Report

Email **security@onticlabs.com** with:

1. A description of the vulnerability.
2. Steps to reproduce the issue.
3. The potential impact (data exposure, privilege escalation, etc.).
4. Any suggested fix (optional but appreciated).

### What to Expect

- **Acknowledgement** within 48 hours of your report.
- **Status update** within 7 days with an assessment and expected timeline.
- **Credit** in the release notes (unless you prefer to remain anonymous).

We ask that you:

- Give us reasonable time to investigate and address the issue before any public
  disclosure.
- Avoid accessing or modifying other users' data.
- Act in good faith to avoid privacy violations, data destruction, or service
  disruption.

## Supported Versions

We only support the latest version on the `main` branch. Security fixes are not
back-ported to older versions.

| Version | Supported |
|---|---|
| `main` (latest) | ✅ |
| Older commits | ❌ |

## Scope

The following are in scope:

- The Ontic Strip web application
- Supabase Edge Functions
- Database migrations and schema
- Build tooling and CI configuration

The following are **out of scope**:

- Third-party services (Supabase platform, OpenRouter, Firecrawl, Inoreader)
- Social engineering attacks against maintainers
- Denial of service attacks

## Security Best Practices for Contributors

- Never commit secrets, API keys, or credentials to the repository.
- Use `.env` files (git-ignored) for local secrets — see `.env.example`.
- Backend secrets should be set via `supabase secrets set`, never in code.
- Review the [CONTRIBUTING.md](CONTRIBUTING.md) guide for development practices.
