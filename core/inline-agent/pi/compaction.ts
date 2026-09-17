/**
 * Inline-agent autocompact (uniform-tools Task 5).
 *
 * Wires the pi-agent-core compaction pipeline to the loop's
 * `transformContext` seam so long loops stay token-efficient: before each
 * LLM call, the context token estimate is checked against
 * `shouldCompact`; when due, the package pipeline
 * (`prepareCompaction` → `compact` → summary message) replaces the
 * compacted prefix with a `compactionSummary` message and keeps the recent
 * tail within `keepRecentTokens`.
 *
 * Contracts (AGENTS.md):
 *  - in-memory only: the SessionTreeEntry bridge and the summary live and
 *    die inside this call / the running loop; nothing is persisted;
 *  - fail-open: every failure across the WHOLE pipeline (token estimate,
 *    SessionTreeEntry bridge, package preparation, summary error, abort,
 *    deadline) logs to the in-memory diagnostic buffer and returns the INPUT
 *    messages unchanged — compaction can never break or stall a run;
 *  - one model authority: the summary request rides the loop's own
 *    provider/model, handed in as the `InlineAgentCompactionSummarizer` port;
 *  - byte-safety: under the threshold the input array reference is returned
 *    untouched, so prompt bytes and the AGENT_* event golden are unchanged.
 *
 * Contract-shaped module: pi packages + the in-memory diagnostic log only —
 * no browser/DOM/entrypoint imports.
 */
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionError,
  type CompactionPreparation,
  type CompactionSettings,
  type MessageEntry,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Models,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { diagnosticLogBuffer } from '../../diagnostics/log-buffer';
import { INLINE_AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS } from '../types';

const LOG_SOURCE = 'inline-agent-compaction';

/**
 * The package `CompactionResult` shape, derived from the exported `compact`
 * function (the root barrel exports the compaction functions but not that
 * interface name). `{ summary, tokensBefore, retainedTail?, ... }`.
 */
export type InlineAgentCompactionResult = Extract<
  Awaited<ReturnType<typeof compact>>,
  { ok: true }
>['value'];
type CompactionRunResult = Awaited<ReturnType<typeof compact>>;

/**
 * The loop's own summary capability: one delegated `completeSimple` over the
 * model the loop is already using (single model-selection authority), plus
 * that same model object. Intentionally NOT the full pi-ai `createModels`
 * registry — its auth-resolution tree would enter the content bundle for
 * zero behavior (pi-bundle-budget guardrail); the package pipeline consumes
 * `Models` only through `completeSimple` (`completeSimpleWithRetries` in
 * pi-agent-core dist/harness/compaction/compaction.js).
 */
export interface InlineAgentCompactionSummarizer {
  model: Model<Api>;
  completeSimple: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => Promise<AssistantMessage>;
}

export interface InlineAgentCompactionInput {
  /** The loop's current context transcript (never mutated). */
  messages: AgentMessage[];
  /** Bounded deadline for the summary request (named constant at the call site). */
  timeoutMs: number;
  /**
   * Summary capability. Absent/null → compaction never fires: the web
   * backend's stream surface is chain-bound (`serializePrompt` in
   * deepseek-stream-fn) and cannot serve the package's arbitrary-context
   * summarization request, and its per-turn wire bytes are bounded by design.
   */
  summarizer?: InlineAgentCompactionSummarizer | null;
  /** Defaults to the package `DEFAULT_COMPACTION_SETTINGS`. */
  settings?: CompactionSettings;
  /** Defaults to `INLINE_AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS`. */
  contextWindowTokens?: number;
}

export interface InlineAgentCompactionOutcome {
  /** Compacted `[compactionSummary, ...retainedTail]`, or the INPUT reference when unchanged. */
  messages: AgentMessage[];
  /** Present only when compaction fired and succeeded. */
  result?: InlineAgentCompactionResult;
}

/**
 * The loop's `convertToLlm`: released pass-through for user/assistant/
 * toolResult plus the package rendering convention for compaction summaries
 * (`COMPACTION_SUMMARY_PREFIX`/`SUFFIX` as a user message). For contexts
 * without a compaction summary the output is byte-identical to the
 * previously inlined role filter.
 */
export function inlineAgentConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    switch (message.role) {
      case 'compactionSummary':
        return [{
          role: 'user',
          content: [{
            type: 'text',
            text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
          }],
          timestamp: message.timestamp,
        }];
      case 'user':
      case 'assistant':
      case 'toolResult':
        return [message];
      default:
        return [];
    }
  });
}

/**
 * Decide-and-compact one loop context. Never throws; never mutates the
 * input; returns the input reference unless compaction actually produced a
 * transformed context.
 */
export async function compactInlineAgentContext(
  input: InlineAgentCompactionInput,
  signal: AbortSignal,
): Promise<InlineAgentCompactionOutcome> {
  const { messages } = input;
  const unchanged: InlineAgentCompactionOutcome = { messages };

  const settings = input.settings ?? DEFAULT_COMPACTION_SETTINGS;
  const contextWindowTokens =
    input.contextWindowTokens ?? INLINE_AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS;

  if (!settings.enabled || signal.aborted || !input.summarizer) {
    return unchanged;
  }

  // Fail-open covers the ENTIRE pipeline (review fix): the token estimate,
  // the SessionTreeEntry bridge (`new Date(...).toISOString()` throws
  // RangeError on a NaN timestamp) and the package preparation are all
  // fallible, and the transformContext contract is "must not throw or
  // reject" — any error logs and returns the INPUT messages unchanged.
  try {
    const estimate = estimateContextTokens(messages);
    if (!shouldCompact(estimate.tokens, contextWindowTokens, settings)) {
      return unchanged;
    }

    // The package pipeline is session-tree shaped; this run's context is a
    // plain message list, so wrap each message in a throwaway MessageEntry.
    // Entries and ids exist only for the duration of this call.
    const entries: SessionTreeEntry[] = messages.map((message, index): MessageEntry => ({
      type: 'message',
      id: `inline-agent-compaction-${index}`,
      parentId: null,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    }));

    const preparation = prepareCompaction(entries, settings);
    if (!preparation.ok || !preparation.value) {
      logFailOpen('compaction preparation failed', preparation.ok ? 'nothing to compact' : preparation.error.message);
      return unchanged;
    }
    const plan = preparation.value;
    if (plan.messagesToSummarize.length === 0 && plan.turnPrefixMessages.length === 0) {
      return unchanged; // nothing to summarize — a summary of empty history is meaningless
    }

    let outcome: CompactionRunResult;
    try {
      outcome = await withBoundedDeadline(plan, input.summarizer, input.timeoutMs, signal);
    } catch (error) {
      logFailOpen('summary request exceeded its deadline', error);
      return unchanged;
    }
    if (!outcome.ok) {
      logFailOpen('summary request failed', outcome.error);
      return unchanged;
    }

    const summaryMessage: AgentMessage = {
      role: 'compactionSummary',
      summary: outcome.value.summary,
      tokensBefore: outcome.value.tokensBefore,
      timestamp: Date.now(),
    };
    return {
      messages: [summaryMessage, ...(outcome.value.retainedTail ?? [])],
      result: outcome.value,
    };
  } catch (error) {
    logFailOpen('compaction pipeline failed', error);
    return unchanged;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs the package `compact` pipeline under a bounded deadline. The loop's
 * abort signal passes through (aborting the summary request), and the
 * deadline additionally aborts the request and rejects this race so a
 * provider that ignores its signal can never stall the loop. A possibly
 * abandoned request rejection is swallowed (observed via the attached
 * catch) — the caller fails open either way.
 */
async function withBoundedDeadline(
  plan: CompactionPreparation,
  summarizer: InlineAgentCompactionSummarizer,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CompactionRunResult> {
  const controller = new AbortController();
  const abortFromOuter = () => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', abortFromOuter, { once: true });
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // Single documented lift of the narrow summarizer port to the package
  // `Models` surface: the summary pipeline resolves auth through the SAME
  // provider the loop streams from, so nothing is bypassed or duplicated.
  const models = { completeSimple: summarizer.completeSimple } as Models;
  const work = compact(plan, models, summarizer.model, undefined, controller.signal);
  void work.catch(() => undefined); // late failure of an abandoned request is unobservable
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          controller.abort(); // stop the underlying summary request
          reject(new Error(`inline-agent compaction exceeded its ${timeoutMs}ms deadline`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    signal.removeEventListener('abort', abortFromOuter);
  }
}

function logFailOpen(message: string, error: unknown): void {
  diagnosticLogBuffer.record({
    level: 'warn',
    source: LOG_SOURCE,
    message,
    details: error instanceof Error ? error.message : String(error),
  });
}
