// =============================================================
// CFPO v2 prompt compiler for Deno edge functions.
// Assembles template sections and resolves {{VARIABLES}}.
// =============================================================

import type { CfpoTemplate, CompiledPrompt } from "./prompt-types.ts";
import { getPromptConfig } from "./prompt-registry.ts";

const SECTION_DIVIDER = "\n\n---\n\n";

function sectionHeader(title: string): string {
  return `## ${title}`;
}

/**
 * Assemble CFPO sections into a single system prompt string.
 * Ordering is mandatory: Voice -> Mission -> Rules -> Enforcement -> Output
 */
function assembleSections(template: CfpoTemplate): string {
  const sections: string[] = [];

  if (template.voice) {
    sections.push(`${sectionHeader("Voice")}\n\n${template.voice}`);
  }

  sections.push(`${sectionHeader("Mission")}\n\n${template.mission}`);
  sections.push(`${sectionHeader("Rules")}\n\n${template.rules}`);
  sections.push(`${sectionHeader("Enforcement")}\n\n${template.enforcement}`);
  sections.push(`${sectionHeader("Output")}\n\n${template.output}`);

  return sections.join(SECTION_DIVIDER);
}

/**
 * Replace {{VARIABLE}} placeholders in a prompt string.
 * - Defined values are substituted
 * - Undefined values are LEFT IN PLACE (no silent swallowing — CFPO invariant)
 * - Arrays are joined with newlines
 * - Booleans/numbers are stringified
 */
function resolveVariables(
  text: string,
  variables: Record<string, string | number | boolean | string[] | undefined>,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined) return match;
    if (Array.isArray(value)) return value.join("\n");
    return String(value);
  });
}

/**
 * Compile a CFPO template into a system prompt string.
 */
export function compileSystemPrompt(
  template: CfpoTemplate,
  variables?: Record<string, string | number | boolean | string[] | undefined>,
): string {
  let prompt = assembleSections(template);
  if (variables) {
    prompt = resolveVariables(prompt, variables);
  }
  return prompt;
}

/**
 * Full compile: returns the system prompt string + the registry config.
 */
export function compilePrompt(
  promptKey: string,
  template: CfpoTemplate,
  variables?: Record<string, string | number | boolean | string[] | undefined>,
): CompiledPrompt {
  const config = getPromptConfig(promptKey);
  const systemPrompt = compileSystemPrompt(template, variables);
  return { systemPrompt, config };
}

export { resolveVariables, assembleSections, sectionHeader };
