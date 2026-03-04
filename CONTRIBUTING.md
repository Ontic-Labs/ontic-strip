# Contributing to Ontic Strip

Thank you for your interest in contributing! This guide covers the workflow and
conventions for making changes to the project.

---

## Getting Started

1. Fork the repository and clone your fork.
2. Install dependencies: `npm install`
3. Copy the env template: `cp .env.example .env`
4. Start the dev server: `npm run dev`
5. Run the full check before submitting: `npm run check`

---

## Development Workflow

### Branch Model

```
main  ← protected, deploys to production (Vercel + Supabase)
  └── dev  ← integration branch, deploys to preview
        └── feat/your-feature  ← your work happens here
```

- **`main`** is protected — no direct pushes. All changes arrive via PR.
- **`dev`** is the integration branch. Feature branches are opened against `dev`.
- When `dev` is stable, a maintainer merges `dev → main` to release.

### Fork or Branch

**External contributors** — fork the repo, then open PRs against `dev`:

```sh
# Fork on GitHub, then:
git clone https://github.com/<your-username>/ontic-strip.git
cd ontic-strip
git remote add upstream https://github.com/Ontic-Labs/ontic-strip.git
git fetch upstream
git checkout -b feat/your-feature upstream/dev
```

**Collaborators** (repo write access) — branch directly:

```sh
git clone https://github.com/Ontic-Labs/ontic-strip.git
cd ontic-strip
git checkout dev
git checkout -b feat/your-feature
```

### Staying Up to Date

```sh
git fetch origin          # or upstream, if forked
git rebase origin/dev     # rebase your feature onto latest dev
```

### Branching Conventions

Use conventional prefixes: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`

### Commits

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add publisher comparison chart
fix: correct integrity score rounding
chore: update dependencies
docs: improve setup instructions
refactor: extract scoring utilities
```

Keep commits atomic — one logical change per commit.

### Pull Requests

1. Push your branch to your fork or to the main repo.
2. Open a PR against **`Ontic-Labs/ontic-strip:dev`** (not `main`).
3. Ensure `npm run check` passes (lint + build).
4. Ensure `npm run test` passes.
5. At least **1 approving review** from a maintainer is required.
6. Write a clear PR description explaining **what** and **why**.
7. Link related issues if applicable.
8. Keep PRs focused — prefer small, reviewable changes.

> **Note:** PRs that don't pass CI checks or lack a review will not be merged.
> Direct PRs to `main` will be redirected to `dev`.

---

## Code Style

This project uses **[Biome](https://biomejs.dev/)** for linting and formatting
(no ESLint or Prettier).

```sh
# Check for issues
npm run lint

# Auto-fix lint + format issues
npm run lint:fix

# Format only
npm run format
```

A pre-commit hook (Husky + lint-staged) runs Biome automatically on staged
`src/**/*.{ts,tsx}` files.

### Key Conventions

- **TypeScript** — strict mode, no `any` except where explicitly suppressed.
- **React** — functional components, hooks only. No class components.
- **Imports** — use path aliases (e.g., `@/components/...`).
- **Buttons** — always include `type="button"` on non-submit buttons.
- **Server state** — use `@tanstack/react-query`, not local state, for API data.

---

## Project Structure

```
src/
  components/     # Reusable UI components
  hooks/          # Custom React hooks
  integrations/   # Supabase client
  lib/            # Shared utilities and types
  pages/          # Route-level page components

supabase/
  functions/      # Supabase Edge Functions (Deno)
    _shared/      # Shared backend code (prompts, LLM client, utils)
  migrations/     # SQL migration files
```

### Edge Functions

Backend functions live in `supabase/functions/`. Each is a standalone Deno
module. Shared code goes in `supabase/functions/_shared/`.

See [`supabase/functions/_shared/AI-WORKFLOW.md`](supabase/functions/_shared/AI-WORKFLOW.md)
for the AI function development workflow.

---

## Contributor To-Do

- Queue orchestration migration (planned, not immediate): keep the current
  Supabase `pgmq` + `pipeline-worker` flow for now, then migrate job orchestration
  to an always-on Node service using Graphile Worker in a later phase.

### Database Migrations

- Use the Supabase CLI to create migrations:
  ```sh
  supabase migration new your_migration_name
  ```
- Keep migrations small and reversible where possible.

---

## Testing

```sh
# Run all tests
npm run test

# Run in watch mode
npm run test:watch
```

Tests use **Vitest** with `jsdom` and `@testing-library/react`.

---

## Supabase Type Generation

After modifying the database schema, regenerate TypeScript types:

```sh
# From remote project
npm run supabase:types

# From local Supabase
npm run supabase:types:local
```

---

## Reporting Issues

- Use GitHub Issues for bugs and feature requests.
- Include reproduction steps, expected vs actual behaviour, and environment
  details.
- For security vulnerabilities, see [SECURITY.md](SECURITY.md) instead.

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating, you agree to uphold this code.

---

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
