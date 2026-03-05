# Technology & Tooling Stack

> An AI-powered news analysis platform that scores articles for
> factual integrity, sourcing quality, editorialization, and ideological framing.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Frontend](#2-frontend)
3. [Backend (Supabase)](#3-backend-supabase)
4. [AI / LLM Infrastructure](#4-ai--llm-infrastructure)
5. [Database & Storage](#5-database--storage)
6. [Build & Dev Tooling](#6-build--dev-tooling)
7. [Testing](#7-testing)
8. [Linting & Code Quality](#8-linting--code-quality)
9. [Deployment & Infrastructure](#9-deployment--infrastructure)
10. [External Services](#10-external-services)
11. [Project Stats](#11-project-stats)

---

## 1. Architecture Overview

```
  React SPA (Vite + TypeScript + Tailwind + shadcn)
      │
      │  Supabase SDK
      ▼
  Supabase
      ├── PostgreSQL + pgvector
      ├── Edge Functions (Deno)
      └── Graphile Worker (Node.js job orchestration)
            │
      ┌─────┴─────┐
  OpenRouter   Firecrawl
  (LLM)       (scrape)
```

**Pattern:** Serverless SPA → BaaS + Worker. Zero custom servers for the frontend — all backend
logic runs as Supabase Edge Functions orchestrated by Graphile Worker.

---

## 2. Frontend

### Core Framework

| Tool | Version | Purpose |
|---|---|---|
| **React** | 18.3 | UI library |
| **TypeScript** | 5.8 | Type safety |
| **Vite** | 5.4 | Build tool, dev server (port 8080), HMR |
| **React Router DOM** | 6.30 | Client-side routing (17 routes) |
| **TanStack React Query** | 5.83 | Server state management, caching |

### UI Layer

| Tool | Purpose |
|---|---|
| **Tailwind CSS** 3.4 | Utility-first styling |
| **shadcn/ui** (Radix primitives) | 20+ accessible UI components (dialog, dropdown, tabs, tooltip, etc.) |
| **Lucide React** | Icon system |
| **Recharts** | Data visualization (score charts, sparklines) |
| **class-variance-authority** | Component variant management |
| **tailwind-merge** + **clsx** | Conditional class composition |
| **tailwindcss-animate** | Animation utilities |
| **@tailwindcss/typography** | Prose styling for article content |

### Specialized Libraries

| Library | Purpose |
|---|---|
| **react-markdown** + **remark-gfm** + **rehype-raw** | Markdown rendering (methodology page, synthesis text) |
| **react-helmet-async** | SEO meta tags |
| **react-hook-form** + **zod** + **@hookform/resolvers** | Form validation |
| **embla-carousel-react** | Carousel component |
| **react-resizable-panels** | Split-pane layouts |
| **cmdk** | Command palette |
| **sonner** + Radix Toast | Notification system (dual) |
| **vaul** | Drawer component |
| **next-themes** | Dark/light mode |
| **date-fns** | Date formatting |
| **input-otp** | OTP input component |
| **react-day-picker** | Date picker |

### Design System

Custom CSS variables power a domain-specific color system:

- **Strip colors:** `supported`, `contradicted`, `mixed`, `unknown`, `opinion`, `not-checkable`, `neutral`
- **Bias colors:** `left`, `center`, `right`
- **Tier colors:** `t1` through `t5`
- **Fonts:** Inter (sans), JetBrains Mono (monospace)

### Pages (17 routes)

| Route | Page | Description |
|---|---|---|
| `/` | Landing | Public homepage |
| `/feed` | Index (FeedView) | Main news feed |
| `/stories` | Stories | Story cluster listing |
| `/stories/:id` | StoryDetail | Multi-publisher story view |
| `/document/:id` | DocumentDetail | Full article analysis |
| `/publishers` | PublisherList | Publisher directory |
| `/publisher/:name` | PublisherDetail | Publisher profile with baselines |
| `/leaderboard` | Leaderboard | Publisher rankings |
| `/compare` | ComparePublishers | Side-by-side publisher comparison |
| `/search` | ClaimSearch | Full-text claim search |
| `/claims` | TrendingClaims | Trending/recent claims |
| `/admin/feeds` | AdminFeeds | Feed management |
| `/privacy` | Privacy | Privacy policy |
| `/terms` | Terms | Terms of service |
| `/methodology` | Methodology | Scoring methodology documentation |
| `/inoreader/callback` | InoreaderCallback | OAuth callback handler |
| `*` | NotFound | 404 page |

### Component Organization

```
src/components/
├── feed/        # Feed cards, filters, timeline
├── layout/      # App shell, navigation, sidebar
├── stories/     # Story cluster components
├── strip/       # Core domain: ScoreBadge, StripLegend, IdeologyBadge,
│                #   SentimentBadge, SparkScore, StripSummaryBar, etc.
├── ui/          # shadcn/ui primitives (button, dialog, card, ...)
├── ErrorBoundary.tsx
└── NavLink.tsx
```

65 total component files across 5 domains.

---

## 3. Backend (Supabase)

### Edge Functions (Deno)

21 edge functions, all TypeScript, running on Supabase's Deno runtime.

| Category | Functions |
|---|---|
| **Ingestion** | `collector`, `rss-collector` |
| **Processing** | `normalizer`, `indexer` |
| **AI Oracles** | `oracle-classifier`, `oracle-extractor`, `oracle-evidence`, `oracle-veracity`, `oracle-sentiment`, `oracle-synthesis`, `oracle-ideology` |
| **Aggregation** | `aggregator`, `event-enricher`, `story-clusterer` |
| **Orchestration** | Graphile Worker (Node.js) |
| **Auth/Admin** | `inoreader-auth`, `feed-admin` |
| **Utilities** | `firecrawl-scrape`, `generate-feed-description`, `seed-propositions`, `sitemap` |

All oracle functions use the shared CFPO prompt framework
(`_shared/prompt-builder.ts`). See [AI-WORKFLOW.md](../supabase/functions/_shared/AI-WORKFLOW.md)
for full pipeline documentation.

### Shared Modules (`_shared/`)

| Module | Lines | Purpose |
|---|---|---|
| `prompt-types.ts` | ~80 | CFPO + LLM type definitions |
| `prompt-registry.ts` | ~140 | Versioned 12-prompt manifest |
| `prompt-builder.ts` | ~85 | CFPO template compiler |
| `llm-client.ts` | ~95 | Unified LLM gateway client |
| `scoring-constants.ts` | ~180 | All scoring magic numbers |
| `scoring-math.ts` | ~210 | Score computation formulas |
| `ideology-constants.ts` | ~75 | IRT + stance parameters |
| `ideology-irt.ts` | ~180 | Rasch/1PL MAP estimator |
| `entity-normalization.ts` | ~230 | Entity/geo/event normalization |
| `prompts/` (12 files) | ~750 | Individual CFPO templates |

### Deno Configuration

- Lint rules: excludes `no-import-prefix`, `no-explicit-any`
- All functions configured with `verify_jwt = false` in `config.toml`
  (authentication handled at application layer)

---

## 4. AI / LLM Infrastructure

### Gateways

| Gateway | URL | Use Case |
|---|---|---|
| **OpenRouter** | `openrouter.ai/api/v1/chat/completions` | All LLM models (Perplexity Sonar, Google Gemini, embeddings) |

All models use the OpenAI-compatible chat completions API via OpenRouter.

### Models in Use

| Model | Tasks | Key Properties |
|---|---|---|
| **perplexity/sonar** | Classification, extraction, NLI, web verify, synthesis | Web-grounded, citation-capable |
| **google/gemini-2.5-flash** | Ideology, stance extraction | Fast, cost-effective |
| **google/gemini-2.5-flash-lite** | Normalization, sentiment, clustering, event classification, feed descriptions | Cheapest tier, deterministic (temp=0) |
| **openai/text-embedding-3-small** | Segment embeddings, claim embeddings, proposition embeddings, event centroids | Via OpenRouter embeddings API |

### Prompt Framework

**CFPO v2** (Voice → Mission → Rules → Enforcement → Output):
- Versioned templates in `prompts/` directory
- Model config lives in the registry, not in handlers
- Variable substitution with fail-loud semantics
- Enforcement sections use paired violation/valid examples

---

## 5. Database & Storage

### PostgreSQL (Supabase-hosted)

**Extensions:**
- **pgvector** — vector similarity search for embeddings

**Schema:** 35 migrations, ~1200 lines of SQL.

**Key Tables:**

| Table | Purpose |
|---|---|
| `feeds` | RSS feed metadata, polling config, publisher info |
| `documents` | Article lifecycle: raw → normalized → scored |
| `segments` | Chunked text with embeddings, classifications, labels, sentiment |
| `claims` | Extracted claims with SIRE metadata and veracity verdicts |
| `evidence` | Claim-evidence pairs with NLI labels and source tiers |
| `proposition_bank` | 50 canonical political propositions for IRT |
| `stance_extractions` | Per-segment stance votes against propositions |
| `ideology_scores` | Document-level ideology (1D + 2D) |
| `publisher_baselines` | 7d/30d rolling metric averages |
| `story_clusters` | Article cluster metadata |
| `story_cluster_members` | Document ↔ cluster membership |
| `events` | Canonical events with centroids and entity sets |
| `inoreader_tokens` | OAuth token storage |
| `pipeline_dlq` | Dead-letter queue for failed jobs |

**RPC Functions:**
- `match_segments` — pgvector cosine similarity search
- `match_event_centroids` — event embedding crosswalk
- `enqueue_graphile_stage_job` — enqueue pipeline stage jobs into Graphile Worker

### Type Generation

`scripts/gen-supabase-types.mjs` generates TypeScript types from the Supabase
schema into `src/integrations/supabase/types.ts`. Supports `--local` (local DB)
and `--check` (CI validation) modes.

---

## 6. Build & Dev Tooling

### Build Pipeline

| Tool | Config | Purpose |
|---|---|---|
| **Vite** 5.4 | `vite.config.ts` | Build + dev server |
| **@vitejs/plugin-react-swc** | (in Vite config) | React fast-refresh via SWC |
| **PostCSS** | `postcss.config.js` | CSS processing |
| **Autoprefixer** | (in PostCSS) | Vendor prefixes |
| **Tailwind CSS** 3.4 | `tailwind.config.ts` | Utility CSS compilation |

### Vite Configuration Highlights

- **Dev server:** port 8080, IPv6 enabled, HMR overlay disabled
- **Path alias:** `@/` → `./src/`
- **Manual chunks** for production:
  - `vendor-react` (react, react-dom, @tanstack/react-router)
  - `vendor-radix` (all Radix UI primitives)
  - `vendor-query` (TanStack React Query)
  - `vendor-recharts` (Recharts)
  - `vendor-markdown` (react-markdown, remark-gfm, rehype-raw)

### Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `vite` | Start dev server |
| `build` | `vite build` | Production build |
| `build:dev` | `vite build --mode development` | Dev build |
| `preview` | `vite preview` | Preview production build |
| `test` | `vitest run` | Run tests once |
| `test:watch` | `vitest` | Watch mode tests |
| `lint` | `eslint .` | Lint frontend |
| `lint:deno` | `deno lint supabase/functions/` | Lint edge functions |
| `lint:all` | `eslint . && deno lint supabase/functions/` | Lint everything |
| `check` | `npm run lint:all && npm run build` | Full CI check |
| `supabase:types` | `node ./scripts/gen-supabase-types.mjs` | Generate DB types |
| `supabase:types:local` | (with `--local` flag) | Types from local DB |
| `supabase:types:check` | (with `--check` flag) | CI type validation |

---

## 7. Testing

| Tool | Version | Config |
|---|---|---|
| **Vitest** | 3.2 | `vitest.config.ts` |
| **jsdom** | 20.0 | Test environment |
| **@testing-library/react** | 16.0 | Component testing utilities |
| **@testing-library/jest-dom** | 6.6 | DOM assertion matchers |

**Configuration:**
- Environment: jsdom
- Globals enabled
- Setup file: `src/test/setup.ts`
- Include pattern: `src/**/*.{test,spec}.{ts,tsx}`
- Path alias: `@/` → `./src/`

**Current test suites:**
- `src/test/example.test.ts` — 1 test (smoke/sanity)
- `src/test/scoring-math.test.ts` — 19 tests (scoring formula coverage)

---

## 8. Linting & Code Quality

### Frontend (ESLint)

| Plugin | Purpose |
|---|---|
| `@eslint/js` | Base JS rules |
| `typescript-eslint` | TypeScript-specific rules |
| `eslint-plugin-react-hooks` | React hooks rules |
| `eslint-plugin-react-refresh` | Fast refresh compatibility |

**Notable relaxed rules:**
- `no-unused-vars`: off
- `no-explicit-any`: off
- `no-empty-object-type`: off
- `ban-ts-comment`: off
- `no-require-imports`: off

**Ignores:** `dist/`, `supabase/functions/` (Deno has its own linter).

### Backend (Deno Lint)

- Built-in Deno linter via `deno lint supabase/functions/`
- Excludes: `no-import-prefix`, `no-explicit-any`

### Git Hooks

| Tool | Config | Purpose |
|---|---|---|
| **Husky** 9.1 | `.husky/` | Git hook management |
| **lint-staged** 16.3 | `package.json` | Pre-commit lint on staged `src/**/*.{ts,tsx}` files |

### TypeScript Configuration

- **Project references:** `tsconfig.app.json` (app code) + `tsconfig.node.json` (build config)
- **Strict modes off:** `noImplicitAny: false`, `strictNullChecks: false`
- **Relaxed:** `noUnusedParameters: false`, `noUnusedLocals: false`
- **skipLibCheck:** enabled

---

## 9. Deployment & Infrastructure

| Service | Purpose |
|---|---|
| **Supabase** (hosted) | PostgreSQL, Edge Functions, Auth, Storage |
| **Vercel** | Frontend hosting + CI/CD |
| **GitHub** | Source control, `main` branch |

### Edge Function Deployment

All 21 functions deployed to Supabase's global Deno runtime. JWT verification
disabled per-function in `supabase/config.toml`.

### Static Assets

- `public/robots.txt` — Search engine directives
- `public/llms.txt` — LLM crawler guidance

---

## 10. External Services

| Service | Purpose | Integration Point |
|---|---|---|
| **OpenRouter** | LLM API gateway (Perplexity, Google Gemini, OpenAI embeddings) | `llm-client.ts`, `indexer`, `oracle-evidence` |
| **Firecrawl** | Web scraping (URL → Markdown) | `firecrawl-scrape` edge function |
| **Inoreader** | RSS aggregator, OAuth-based feed sync | `collector`, `inoreader-auth` |
| **Supabase** | BaaS (DB, auth, functions, realtime) | Client SDK + edge functions |

### API Keys (Environment Variables)

| Env Var | Service |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter (all LLM models + embeddings) |
| `FIRECRAWL_API_KEY` | Firecrawl scraping |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin access (edge functions) |
| `SUPABASE_ANON_KEY` | Supabase public access (frontend) |

---

## 11. Project Stats

| Metric | Count |
|---|---|
| Frontend pages | 17 |
| React components | 65 |
| Edge functions | 21 |
| Shared modules | 10 + 12 prompts |
| DB migrations | 35 |
| Test suites | 2 (20 tests) |
| LLM prompt templates | 12 |
| AI models used | 4 |
| npm dependencies | 42 |
| npm devDependencies | 16 |
