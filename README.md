<p align="center">
  <strong>Ontic Strip</strong><br>
  <em>Open-source news integrity analysis — AI-powered scoring for factual grounding, claim veracity, and editorial transparency.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.onticstrip.com"><img src="https://img.shields.io/badge/live-onticstrip.com-brightgreen.svg" alt="Live Site"></a>
</p>

---

## What It Does

Ontic Strip ingests news articles from RSS feeds across the political spectrum, extracts factual claims using the **SIRE framework** (Scope · Information · Retrieval · Exclusions), retrieves evidence from multiple source tiers, and scores each claim via Natural Language Inference. The result is a visual "strip" showing evidence alignment across an entire article.

- **Claim extraction & veracity scoring** — Supported, Contradicted, Mixed, Unknown
- **Grounding Score** (0–100) — proportion of article segments backed by evidence
- **Integrity Score** (0–100) — weighted evidence alignment (contradictions penalised 1.2×)
- **Publisher leaderboard** — integrity baselines and rankings across outlets
- **Story clustering** — compare how different publishers cover the same events
- **Blindspot detection** — surface stories covered by one side but not the other

---

## Architecture

```
                        ┌─────────────────────────────────┐
                        │       React SPA (Vite)          │
                        │  TypeScript · Tailwind · shadcn │
                        └───────────────┬─────────────────┘
                                        │
                                   Supabase SDK
                                        │
               ┌────────────────────────┼────────────────────────┐
               │                   Supabase                      │
               │                                                 │
               │   PostgreSQL ───── Edge Functions ───── pgmq    │
               │   + pgvector       (22 × Deno)       job queue  │
               │                                                 │
               └────────────┬───────────────────┬────────────────┘
                            │                   │
                       OpenRouter          Firecrawl
                     (LLM gateway)        (web scrape)
```

**Pattern:** Serverless SPA → BaaS. Zero custom servers — all backend logic runs as Supabase Edge Functions orchestrated by a pgmq message queue.

---

## Tech Stack

| Layer | Tools |
|---|---|
| **Frontend** | React 18, TypeScript 5.8, Vite, React Router, TanStack Query |
| **UI** | Tailwind CSS, shadcn/ui (Radix primitives), Lucide icons, Recharts |
| **Backend** | 22 Supabase Edge Functions (Deno), pgmq job queue |
| **Database** | PostgreSQL 15 + pgvector + pgmq |
| **AI** | OpenRouter (multi-model), text-embedding-3-large, CFPO v2 prompts |
| **Scraping** | Firecrawl, Inoreader RSS |
| **Quality** | Biome (lint + format), Vitest, Husky + lint-staged |

Full details → [docs/tech-stack.md](docs/tech-stack.md)

---

## Quick Start

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | [nvm](https://github.com/nvm-sh/nvm#installing-and-updating) |
| Supabase CLI | latest | `npm i -g supabase` |
| Deno | ≥ 1.40 | [deno.com](https://docs.deno.com/runtime/) |

### 1. Clone & install

```sh
git clone https://github.com/Ontic-Labs/ontic-strip.git
cd ontic-strip
npm install
cp .env.example .env   # fill in your keys
```

### 2. Run the frontend

```sh
npm run dev             # Vite dev server → http://localhost:8080
```

### 3. Local Supabase (optional)

```sh
supabase start          # spins up local Postgres, Auth, Edge Runtime
supabase db push        # apply migrations
npm run supabase:types:local
```

### Environment Variables

All variables are documented in [.env.example](.env.example). Nothing secret is checked in.

| Variable | Scope | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Frontend | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Frontend | Supabase anon (public) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions | Admin-level DB access |
| `OPENROUTER_API_KEY` | Edge Functions | LLM gateway for oracle pipeline |
| `FIRECRAWL_API_KEY` | Edge Functions | Web scraping for evidence retrieval |

---

## Project Structure

```
src/
  pages/            Route-level page components
  components/       React components (feed, stories, strip, layout, ui)
  hooks/            Custom React hooks
  integrations/     Supabase client & generated types
  lib/              Utilities, types, SEO helpers

supabase/
  migrations/       SQL schema migrations
  functions/
    _shared/        Shared code — prompt templates, LLM client, utils
    pipeline-worker/ pgmq job orchestrator
    rss-collector/   Feed ingestion
    oracle-*         AI analysis pipeline (7 stages)
    story-clusterer/ Multi-source story grouping
    indexer/         pgvector embedding generation
    ...              22 functions total

docs/               Architecture docs, runbooks, prompt spec
```

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build |
| `npm run test` | Vitest test suite |
| `npm run lint` | Biome lint check |
| `npm run lint:fix` | Auto-fix lint + format |
| `npm run check` | Full check (lint + build) |
| `npm run supabase:types` | Generate DB types from remote |
| `npm run supabase:types:local` | Generate DB types from local |

---

## Documentation

| Doc | Description |
|---|---|
| [docs/tech-stack.md](docs/tech-stack.md) | Full technology & tooling reference |
| [docs/prompt-spec.md](docs/prompt-spec.md) | CFPO v2 prompt architecture |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Fork/branch workflow, code style, PR process |
| [supabase/functions/_shared/AI-WORKFLOW.md](supabase/functions/_shared/AI-WORKFLOW.md) | AI function development workflow |

---

## Contributing

Contributions welcome — please read the [Contributing Guide](CONTRIBUTING.md) first.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

---

## Security

Found a vulnerability? See our [Security Policy](SECURITY.md). **Do not open a public issue.**

---

## License

[MIT](LICENSE) © 2026 [Ontic Labs](https://github.com/Ontic-Labs)
