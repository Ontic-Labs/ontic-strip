# Prompt Architecture Spec — CFPO v2

> **Principle**: "Compiled, not authored"
> **Status**: Active (v2 — all templates migrated)

---

## 1. Overview

Every AI system prompt follows the **CFPO convention** — a strict five-section ordering that ensures consistency, auditability, and machine-parseable enforcement markers across all AI workflows.

```
  .md Template
  ─────────────────────────
  Voice         (optional)
  Mission
  Rules
  Enforcement
  Output
  ─────────────────────────
          │
    {{VARIABLES}}
          ▼
  compiler → CompiledPrompt
```

---

## 2. CFPO Section Contract

| #   | Section         | Key           | Required | Purpose                                        |
| --- | --------------- | ------------- | -------- | ---------------------------------------------- |
| 1   | **Voice**       | `voice`       | No       | Persona, tone, and style calibration           |
| 2   | **Mission**     | `mission`     | Yes      | What the prompt accomplishes                   |
| 3   | **Rules**       | `rules`       | Yes      | YAML-fenced constraints, taxonomies, enums     |
| 4   | **Enforcement** | `enforcement` | Yes      | Paired ❌ violation / ✓ valid example blocks   |
| 5   | **Output**      | `output`      | Yes      | Output format spec (JSON schema) + enforcement |

### Section Boundaries

Sections are delimited by em-dash lines:

```
———————————————————————————————————————
## Section Title — ENFORCEMENT
```

### Enforcement Blocks

Every rule section is followed by a paired enforcement block:

```
❌ VIOLATIONS:
- "input example" → Why it violates the rule
- ...

✓ VALID:
- "input example" → Why it passes
- ...
```

These are not comments — they are calibration signals for the model. Paired positive/negative examples reduce prompt drift.

---

## 2.1 Convergence Research Integration (2026-02-14)

This section embeds the converged prompt-design findings directly in this spec.

The convergence research defines a stable prompt-design shape across strong systems:

1. Identity
2. Behavioral rules
3. Output contract
4. Tools and environment
5. Markup and structure
6. Examples
7. Reasoning/planning
8. Safety/privacy guardrails
9. Final reminders

CFPO v2 aligns these into operational sections as follows:

| Convergence layer  | CFPO v2 location                        | Integration rule                                                        |
| ------------------ | --------------------------------------- | ----------------------------------------------------------------------- |
| Identity           | **Voice** + **Mission**                 | Keep persona and objective explicit; avoid ambiguous role phrasing      |
| Behavioral rules   | **Rules**                               | Express constraints in machine-parseable blocks where possible          |
| Output contract    | **Output**                              | Require exact return schema and format expectations                     |
| Tools/environment  | **Rules** (tool policy blocks)          | Declare allowed tools, constraints, and non-disclosure behavior         |
| Markup/structure   | Section boundaries + YAML fences        | Preserve deterministic section ordering and parseable delimiters        |
| Examples           | **Enforcement**                         | Use paired ❌/✓ examples to teach boundaries by contrast                |
| Reasoning/planning | **Rules** + **Enforcement**             | Require plan-before-act where relevant; validate via examples           |
| Safety/privacy     | **Rules** + **Enforcement**             | Encode disallowed behaviors explicitly and test with violation examples |
| Final reminders    | **Mission** tail or **Output** preamble | Re-state critical constraints near generation boundary                  |

### Evidence-informed policy

- The retired ablation infrastructure found no measurable gain from treating prompt order alone as an isolated experiment.
- CFPO remains the production architecture because it provides **deterministic structure**, **auditable policy encoding**, and **runtime compilation guarantees**.
- Therefore, this spec treats convergence findings as design guidance for section content quality, while CFPO ordering remains the canonical assembly contract.

---

## 3. Architecture

### File Layout

```
prompts/
├── src/
│   ├── index.ts            # Public API exports
│   ├── types.ts            # CFPOSection, PromptEntry, CompilerInput, etc.
│   ├── registry.ts         # PROMPT_REGISTRY — typed manifest of all templates
│   ├── compiler.ts         # compilePrompt() / getSystemPrompt()
│   ├── loader.ts           # loadTemplate() / resolveVariables()
│   ├── sections.ts         # sectionHeader(), yamlBlock(), enforcementBlock()
│   └── templates/
│       ├── content.ts      # TEMPLATE_MAP — bundler-safe string literals
│       └── <workflow>/
│           └── <task>.system.md
```

### Compilation Pipeline

```
  getSystemPrompt("prompt_key", { VAR: "value" })
      │
      ▼
  registry.ts  →  resolve PromptEntry by key
      │
      ▼
  loader.ts    →  load raw template from content.ts
      │
      ▼
  resolveVariables()  →  {{VAR}} → "value"
      │
      ▼
  CompiledPrompt { systemPrompt, entry }
```

### Dual-Source Design

| Layer         | File                       | Purpose                                                             |
| ------------- | -------------------------- | ------------------------------------------------------------------- |
| **Authoring** | `templates/**/*.system.md` | Human-readable CFPO markdown — edit here first                      |
| **Runtime**   | `templates/content.ts`     | Bundler-safe `TEMPLATE_MAP` — string literals for any JS runtime    |

The `.md` files are the source of truth for authoring. The `content.ts` map is the runtime source. A sync guard in CI verifies parity.

---

## 4. Registry

Every prompt has a typed entry in `PROMPT_REGISTRY`:

```typescript
interface PromptEntry {
  key: string; // "task_clarify"
  name: string; // "Task Clarification"
  workflow: PromptWorkflow; // "task-clarify"
  version: number; // 2
  status: PromptStatus; // "active" | "draft" | "archived"
  templatePath: string; // "task/clarify.system.md"
  changeSummary: string; // What changed in this version
  defaultModel?: string; // "claude-sonnet-4.5"
  defaultTemperature?: number; // 0
  defaultMaxTokens?: number; // 2048
}
```

### Active Templates (v2)

Register each prompt with its workflow, model, and temperature. Example:

| Key              | Workflow       | Model             | Temp |
| ---------------- | -------------- | ----------------- | ---- |
| `task_clarify`   | task-clarify   | claude-sonnet-4.5 | 0.0  |
| `task_draft`     | task-draft     | claude-sonnet-4.5 | 0.1  |
| `task_extract`   | task-extract   | sonar-pro         | 0.1  |
| `chat`           | chat           | claude-sonnet-4.5 | 0.7  |

### Registered Workflows (enum)

Define workflows as an enum to constrain valid prompt keys at the type level. Workflows should map 1:1 to distinct AI pipeline stages.

---

## 5. Public API

```typescript
// Primary — compile and return just the system prompt string
import { getSystemPrompt } from "./prompts";

const prompt = getSystemPrompt("task_clarify", {
  DOMAIN: "healthcare triage",
  SENSITIVITY: "high",
});

// Full compile — returns metadata + prompt
import { compilePrompt } from "./prompts";

const { systemPrompt, entry } = compilePrompt({
  promptKey: "task_draft",
  variables: { DOMAIN: "nutrition" },
  domainAddendum: "Include domain-specific axis rules...",
  examples: "Example axes: status (enum), score (range)...",
});

// Registry introspection
import { listPromptKeys, listActiveEntries } from "./prompts";

// Section helpers (for building new templates programmatically)
import {
  sectionHeader,
  yamlBlock,
  enforcementBlock,
  assembleSections,
} from "./prompts";
```

### Variable Resolution

Templates use `{{PLACEHOLDER}}` syntax:

- `{{VAR}}` with a value → replaced
- `{{VAR}}` with `undefined` → left as-is (no silent swallowing)
- Array values → joined with `\n`
- Boolean/number → stringified

---

## 6. Consumer Integration

Integrate the compiled prompts in your API routes or edge functions by calling `getSystemPrompt()` or `compilePrompt()` with the appropriate key and variables.

For runtimes that cannot share the same module system (e.g., Deno edge functions vs. Node API routes), maintain a parallel prompt-builder that follows the same CFPO structure until runtime unification.

---

## 7. Invariants

1. **Only one `active` entry per key** — `getActiveEntry()` throws if missing or not active
2. **No silent variable swallowing** — unresolved `{{VAR}}` remains visible in output
3. **CFPO ordering is mandatory** — Voice → Mission → Rules → Enforcement → Output
4. **Every rule has enforcement** — paired ❌/✓ blocks follow every YAML rule section
5. **Bundler-safe** — no filesystem reads; `content.ts` is the runtime source
6. **Sync guard** — CI verifies `.md` ↔ `content.ts` parity
7. **Immutable versions** — bump `version`, don't edit in place; archive old entries

