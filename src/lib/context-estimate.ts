// ---------------------------------------------------------------------------
// Epoch estimate_from_context — local heuristic classifier
// ---------------------------------------------------------------------------
//
// Classifies free-text task context (issue body, PR/diff description, task
// summary) into {taskType, complexity} using a LOCAL, deterministic,
// keyword/signal-based heuristic — NO LLM call. This is required by the
// no-fabricated-estimate rule (the classification must be reproducible and
// auditable, and the tool must work fully offline / in CI without network
// access). The result is then handed to the caller, which delegates to
// reference_class_estimate's existing correction path (see
// src/dispatcher/tool-registry.ts's "estimate_from_context" handler) — the
// only thing this module owns is turning free text into
// {task_type, complexity, confidence, signals}.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 5 ("classify task_type+complexity from issue text/diff; delegate
// to reference_class/PERT correction"), open question "local heuristic vs
// LLM call" — resolved in favor of the local heuristic.
//
// --- The heuristic, documented in full ---
//
// 1. task_type (one of the 8 canonical categories — see TASK_TYPES below,
//    which must stay in sync with taskTypeEnum in src/schemas/index.ts;
//    context-estimate.test.ts asserts this):
//      Score each category by counting how many of its keyword-phrase
//      patterns match the (lower-cased) context text, using word-boundary
//      regexes so "fix" doesn't match inside "prefix". The category with
//      the highest score wins. Ties are broken by TASK_TYPES declaration
//      order (which starts with "feature", matching the existing
//      inferTaskType() fallback in feedback.ts). If every category scores
//      zero, task_type defaults to "feature" and the signal
//      "task_type_defaulted" is recorded instead of a match signal — this
//      is the honest "we don't know" case, not a guess dressed up as one.
//
// 2. complexity (1-5, integer): starts at a neutral baseline of 3 and is
//    nudged by independent signals, each worth +/-1 and clamped to [1, 5]
//    at the end (not per-signal, so multiple small signals can compound):
//      - diff_markers: >=5 lines that look like unified-diff hunks (a line
//        starting with a single "+" or "-" not part of "++"/"--", or a
//        fenced ```diff block) -> +1. This approximates "how much surface
//        area is being touched."
//      - large_diff: >=20 such diff lines -> an *additional* +1 (so a big
//        diff can contribute up to +2 total).
//      - multi_file: an explicit "N files" / "across N files" mention with
//        N >= 3 -> +1; N >= 10 -> an additional +1.
//      - long_context: context longer than 1200 characters -> +1 (more
//        written context usually correlates with more scope).
//      - short_context: NON-EMPTY context shorter than 80 characters -> -1
//        (very little information to reason about; treat as simpler/lower-
//        risk by default rather than inflating complexity from nothing). A
//        fully empty/whitespace-only context does NOT trigger this — see
//        the confidence section below for why.
//      - vocabulary_high: presence of scope-signaling words/phrases like
//        "overhaul", "rewrite", "redesign", "breaking change",
//        "large-scale", "significant", "epic" -> +1.
//      - vocabulary_low: presence of "trivial", "typo", "tiny", "one-line",
//        "quick fix", "minor", "small tweak" -> -1.
//      - task_type_risk: if task_type resolved via an actual keyword match
//        (not the default) to "migration" or "infrastructure" -> +1, since
//        those categories carry structurally higher risk even when the
//        text doesn't otherwise signal scope.
//
// 3. confidence ("high" | "medium" | "low"): counts the number of *real*
//    (informative) signals that fired — every entry in `signals` except the
//    "task_type_defaulted" placeholder AND except "short_context" (a short
//    or empty context is an absence of information, not a pattern match, so
//    it doesn't get to lift confidence on its own).
//      - "high"   when task_type matched a real category AND >= 2 informative
//                  complexity signals fired (3+ independent signals total).
//      - "medium" when at least 1 informative signal fired (task_type match
//                  OR at least 1 informative complexity signal), but not
//                  enough for "high".
//      - "low"    when zero informative signals fired — task_type defaulted
//                  to "feature" and complexity stayed at (or was only nudged
//                  by "short_context" from) the 3 baseline. This is
//                  surfaced honestly in the output rather than silently
//                  guessing (no-fabricated-estimate rule).
//
// 4. signals: the ordered list of machine-readable signal names that fired,
//    for provenance/debugging (e.g. ["task_type_matched:bugfix",
//    "vocabulary_low"]).
//
// This is intentionally simple, deterministic, and auditable. It can be
// swapped for a smarter local classifier later without changing the public
// shape — classifyContext() returns a stable Classification tuple.
// ---------------------------------------------------------------------------

import type { TaskType } from "../types/index.js";

/** Canonical task types, in tie-break priority order. MUST match taskTypeEnum's .options in src/schemas/index.ts (asserted in context-estimate.test.ts). */
export const TASK_TYPES: readonly TaskType[] = [
  "feature",
  "bugfix",
  "refactor",
  "migration",
  "infrastructure",
  "documentation",
  "testing",
  "design",
];

const DEFAULT_TASK_TYPE: TaskType = "feature";
const BASELINE_COMPLEXITY = 3;
const MIN_COMPLEXITY = 1;
const MAX_COMPLEXITY = 5;

/** Per-category keyword-phrase patterns. Word-boundary anchored, case-insensitive. */
const TASK_TYPE_PATTERNS: Record<TaskType, RegExp> = {
  bugfix: /\b(bug|bugs|fix|fixes|fixed|fixing|error|errors|exception|crash|crashes|crashed|broken|regression|null ?pointer|npe|stack trace|traceback|failing test|flaky|hotfix|patch)\b/gi,
  feature: /\b(add|adds|adding|implement|implements|implementing|new feature|feature request|introduce|introduces|support for|enable|enables)\b/gi,
  refactor: /\b(refactor|refactors|refactoring|clean ?up|restructure|restructuring|reorganize|reorganizing|simplify|simplifying|rename|renaming|extract (?:method|function|class)|dedupe|deduplicate)\b/gi,
  migration: /\b(migrate|migrates|migration|migrating|upgrade|upgrades|upgrading|port to|porting|move to|moving to|switch to|switching to|schema change|breaking change|backfill)\b/gi,
  infrastructure: /\b(deploy|deploys|deployment|\bci\b|\bcd\b|pipeline|infra(?:structure)?|docker|kubernetes|k8s|terraform|helm|provision(?:ing)?|dockerfile|github actions|workflow file)\b/gi,
  documentation: /\b(docs?|documentation|readme|changelog|comment|comments|commenting|docstring)\b/gi,
  testing: /\b(test|tests|testing|spec|specs|unit test|integration test|e2e|coverage|regression test)\b/gi,
  design: /\b(design|\bui\b|\bux\b|mockup|wireframe|figma|layout|styling|\bcss\b|visual|typography|color palette)\b/gi,
};

const VOCAB_HIGH = /\b(overhaul|major refactor|breaking change|large[- ]scale|significant|epic|rewrite|redesign)\b/i;
const VOCAB_LOW = /\b(trivial|typo|tiny|one[- ]line|quick fix|minor|small tweak)\b/i;
/** Diff-hunk line: a lone leading '+' or '-' not part of a '+++'/'---' file marker. */
const DIFF_LINE = /^[+-](?![+-])[^\n]*$/gm;
const FILE_COUNT_MENTION = /\b(\d+)\s+files?\b/i;
const LONG_CONTEXT_CHARS = 1200;
const SHORT_CONTEXT_CHARS = 80;
const DIFF_LINE_THRESHOLD = 5;
const LARGE_DIFF_LINE_THRESHOLD = 20;

export type ClassificationConfidence = "high" | "medium" | "low";

export interface Classification {
  readonly taskType: TaskType;
  readonly complexity: number;
  readonly confidence: ClassificationConfidence;
  readonly signals: readonly string[];
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function classifyTaskType(context: string): { taskType: TaskType; matched: boolean; signal: string } {
  let best: TaskType = DEFAULT_TASK_TYPE;
  let bestScore = 0;
  for (const type of TASK_TYPES) {
    const score = countMatches(context, TASK_TYPE_PATTERNS[type]);
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }
  if (bestScore === 0) {
    return { taskType: DEFAULT_TASK_TYPE, matched: false, signal: "task_type_defaulted" };
  }
  return { taskType: best, matched: true, signal: `task_type_matched:${best}` };
}

function classifyComplexity(
  context: string,
  taskType: TaskType,
  taskTypeMatched: boolean,
): { complexity: number; signals: string[] } {
  let delta = 0;
  const signals: string[] = [];

  const diffLineCount = countMatches(context, DIFF_LINE);
  if (diffLineCount >= DIFF_LINE_THRESHOLD) {
    delta += 1;
    signals.push("diff_markers");
    if (diffLineCount >= LARGE_DIFF_LINE_THRESHOLD) {
      delta += 1;
      signals.push("large_diff");
    }
  }

  const fileCountMatch = context.match(FILE_COUNT_MENTION);
  if (fileCountMatch) {
    const n = Number(fileCountMatch[1]);
    if (Number.isFinite(n) && n >= 3) {
      delta += 1;
      signals.push(`multi_file:${n}`);
      if (n >= 10) {
        delta += 1;
        signals.push("many_files");
      }
    }
  }

  if (context.length > LONG_CONTEXT_CHARS) {
    delta += 1;
    signals.push("long_context");
  } else if (context.length > 0 && context.length < SHORT_CONTEXT_CHARS) {
    // Note: only a *non-empty* short context counts as this signal — an
    // empty/whitespace-only context (length 0 after trim) has no
    // information at all, which is a different, more honest "we truly
    // don't know" case (task_type_defaulted + baseline complexity), not
    // "the author terse-described a small task."
    delta -= 1;
    signals.push("short_context");
  }

  if (VOCAB_HIGH.test(context)) {
    delta += 1;
    signals.push("vocabulary_high");
  }
  if (VOCAB_LOW.test(context)) {
    delta -= 1;
    signals.push("vocabulary_low");
  }

  if (taskTypeMatched && (taskType === "migration" || taskType === "infrastructure")) {
    delta += 1;
    signals.push("task_type_risk");
  }

  const complexity = Math.min(MAX_COMPLEXITY, Math.max(MIN_COMPLEXITY, BASELINE_COMPLEXITY + delta));
  return { complexity, signals };
}

/**
 * Complexity signals that count toward confidence. "short_context" is
 * deliberately excluded: it fires from the ABSENCE of detail (a very short
 * or empty context), which is a poverty of information, not a real pattern
 * match — it should not, by itself, lift a defaulted classification from
 * "low" to "medium" confidence.
 */
function countInformativeSignals(complexitySignals: readonly string[]): number {
  return complexitySignals.filter((s) => s !== "short_context").length;
}

function resolveConfidence(taskTypeMatched: boolean, informativeComplexitySignalCount: number): ClassificationConfidence {
  const realSignalCount = (taskTypeMatched ? 1 : 0) + informativeComplexitySignalCount;
  if (taskTypeMatched && informativeComplexitySignalCount >= 2) return "high";
  if (realSignalCount >= 1) return "medium";
  return "low";
}

/**
 * Classify free-text task context into {taskType, complexity, confidence,
 * signals} using the local heuristic documented at the top of this file.
 * Pure function, deterministic, no I/O, no LLM call.
 */
export function classifyContext(context: string): Classification {
  const trimmed = context.trim();
  const { taskType, matched, signal: taskTypeSignal } = classifyTaskType(trimmed);
  const { complexity, signals: complexitySignals } = classifyComplexity(trimmed, taskType, matched);
  const confidence = resolveConfidence(matched, countInformativeSignals(complexitySignals));
  return {
    taskType,
    complexity,
    confidence,
    signals: [taskTypeSignal, ...complexitySignals],
  };
}

/** Optional caller-supplied hints that override classification, per field. */
export interface ContextEstimateHints {
  readonly taskType?: TaskType;
  readonly complexity?: number;
}

export interface ResolvedContextEstimateInputs {
  readonly taskType: TaskType;
  readonly complexity: number;
  /** True when either input was supplied as a hint rather than classified. */
  readonly taskTypeFromHint: boolean;
  readonly complexityFromHint: boolean;
}

/**
 * Merge a Classification with caller-supplied hints — hints always win.
 * Returns the effective {taskType, complexity} to feed into the estimation
 * path, plus which fields came from a hint (for provenance in the tool
 * output).
 */
export function resolveContextEstimateInputs(
  classification: Classification,
  hints: ContextEstimateHints = {},
): ResolvedContextEstimateInputs {
  return {
    taskType: hints.taskType ?? classification.taskType,
    complexity: hints.complexity ?? classification.complexity,
    taskTypeFromHint: hints.taskType !== undefined,
    complexityFromHint: hints.complexity !== undefined,
  };
}
