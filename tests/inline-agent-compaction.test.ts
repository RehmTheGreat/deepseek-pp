/**
 * Inline-agent autocompact tests (uniform-tools Task 5).
 *
 * Wires pi-agent-core compaction primitives to the inline-agent loop via a
 * contract-shaped module (`core/inline-agent/pi/compaction.ts`):
 *
 *  1. Threshold math against `shouldCompact` semantics — exactly-at-threshold
 *     does NOT compact; one token over does.
 *  2. Under threshold → the SAME message array reference (byte-identical
 *     serialized conversation; prompt goldens stay green without --update).
 *  3. Over threshold → summary message (package `compactionSummary`
 *     convention) + retained tail within `keepRecentTokens`.
 *  4. Fail-open: summary failure, pre-aborted signal, disabled settings,
 *     missing summarizer port (web backend cannot serve arbitrary-context
 *     summary requests) and a hung summary request (bounded deadline) all
 *     return the input UNCHANGED and log to the in-memory diagnostic buffer.
 *
 * Compaction state is in-memory per run: the summarizer rides pi-ai's
 * package-blessed `fauxProvider` + `createModels` pair — no persistence of
 * summaries, messages, or settings anywhere (pi-storage-boundary guards the
 * static surface).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  DEFAULT_COMPACTION_SETTINGS,
  serializeConversation,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
} from '@earendil-works/pi-agent-core';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type FauxResponseStep,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import { diagnosticLogBuffer } from '../core/diagnostics/log-buffer';
import {
  INLINE_AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS,
  INLINE_AGENT_COMPACTION_TIMEOUT_MS,
} from '../core/inline-agent/types';
import {
  compactInlineAgentContext,
  inlineAgentConvertToLlm,
  type InlineAgentCompactionSummarizer,
} from '../core/inline-agent/pi/compaction';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMsg(text: string, timestamp = 1_000): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function assistantMsg(text: string, timestamp = 2_000): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'faux',
    provider: 'faux',
    model: 'faux-1',
    usage: ZERO_USAGE,
    stopReason: 'stop',
    timestamp,
  };
}

/**
 * A loop-shaped context right before the next LLM call: a full turn chain
 * (user → assistant → toolResult) plus a small pending user message. Sizes
 * are chosen so the compaction cut lands exactly ON the user message (no
 * split turn): 250 + 250 + 250 + 200 = 950 estimated tokens.
 */
function loopTranscript(): AgentMessage[] {
  return [
    userMsg('u1 ' + 'a'.repeat(997)),
    assistantMsg('a1 ' + 'b'.repeat(997)),
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'memory_search',
      content: [{ type: 'text', text: 'r1 ' + 'c'.repeat(997) }],
      isError: false,
      timestamp: 3_000,
    },
    userMsg('u2 ' + 'd'.repeat(797), 4_000),
  ];
}

interface FauxHarness {
  summarizer: InlineAgentCompactionSummarizer;
  callCount: () => number;
  setResponses: (responses: FauxResponseStep[]) => void;
  lastSummaryPrompt: () => string | undefined;
}

function createFauxSummarizer(): FauxHarness {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let lastPrompt: string | undefined;
  faux.setResponses([
    (context) => {
      const first = context.messages[0];
      lastPrompt = typeof first.content === 'string'
        ? first.content
        : first.content.map((block) => ('text' in block ? block.text : '')).join('');
      return fauxAssistantMessage('COMPACT SUMMARY');
    },
  ]);
  const model = faux.models[0] as unknown as Model<Api>;
  return {
    summarizer: {
      model,
      completeSimple: (summaryModel, context, options) =>
        models.completeSimple(summaryModel, context, options),
    },
    callCount: () => faux.state.callCount,
    setResponses: (responses: FauxResponseStep[]) => faux.setResponses(responses),
    lastSummaryPrompt: () => lastPrompt,
  };
}

const SMALL_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 100,
  keepRecentTokens: 200,
};

/** The token estimate the module uses (chars/4 per message, no provider usage). */
function messageText(message: AgentMessage): string {
  if (message.role === 'assistant') {
    return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  }
  if (message.role === 'user' || message.role === 'toolResult') {
    if (typeof message.content === 'string') return message.content;
    return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  }
  return '';
}

function estimateOf(messages: AgentMessage[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + messageText(m).length, 0) / 4);
}

beforeEach(() => {
  diagnosticLogBuffer.clear();
});

// ---------------------------------------------------------------------------
// Threshold math
// ---------------------------------------------------------------------------

describe('autocompact threshold math', () => {
  it('never compacts exactly at the threshold (tokens == window - reserve)', () => {
    expect(shouldCompact(900, 1_000, SMALL_SETTINGS)).toBe(false);
    expect(shouldCompact(901, 1_000, SMALL_SETTINGS)).toBe(true);
  });

  it('never compacts when the setting is disabled', () => {
    expect(shouldCompact(1_000_000, 1_000, { ...SMALL_SETTINGS, enabled: false })).toBe(false);
  });

  it('ships sane constants: the default window leaves room beyond the reserve', () => {
    expect(INLINE_AGENT_COMPACTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(INLINE_AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS).toBeGreaterThan(
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    );
  });
});

// ---------------------------------------------------------------------------
// transform behavior
// ---------------------------------------------------------------------------

describe('compactInlineAgentContext', () => {
  it('under threshold returns the SAME array reference and byte-identical conversation', async () => {
    const faux = createFauxSummarizer();
    const messages: AgentMessage[] = [userMsg('hello'), assistantMsg('world')];
    const before = serializeConversation(messages as unknown as Message[]);

    const outcome = await compactInlineAgentContext({
      messages,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: faux.summarizer,
      settings: SMALL_SETTINGS,
      contextWindowTokens: 1_000,
    }, new AbortController().signal);

    expect(outcome.messages).toBe(messages); // same reference — zero churn
    expect(outcome.result).toBeUndefined();
    expect(serializeConversation(outcome.messages as unknown as Message[])).toBe(before);
    expect(faux.callCount()).toBe(0);
  });

  it('does not compact exactly at the threshold, compacts one token over', async () => {
    const faux = createFauxSummarizer();
    const exact: AgentMessage[] = [
      userMsg('x'.repeat(1_200)), // 300 tokens
      userMsg('y'.repeat(1_200), 1_100), // 300 tokens
      userMsg('z'.repeat(1_200), 1_200), // 300 tokens → 900 == 1000 - 100
    ];
    const exactOutcome = await compactInlineAgentContext({
      messages: exact,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: faux.summarizer,
      settings: SMALL_SETTINGS,
      contextWindowTokens: 1_000,
    }, new AbortController().signal);
    expect(exactOutcome.messages).toBe(exact);
    expect(faux.callCount()).toBe(0);

    const over: AgentMessage[] = [...exact, userMsg('w'.repeat(4), 1_300)]; // +1 token
    const overOutcome = await compactInlineAgentContext({
      messages: over,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: faux.summarizer,
      settings: SMALL_SETTINGS,
      contextWindowTokens: 1_000,
    }, new AbortController().signal);
    expect(overOutcome.messages[0].role).toBe('compactionSummary');
    expect(faux.callCount()).toBe(1);
  });

  it('over threshold compacts: summary message + retained tail within keep-recent budget', async () => {
    const faux = createFauxSummarizer();
    const messages = loopTranscript(); // 950 estimated tokens
    expect(estimateOf(messages)).toBe(950);

    const outcome = await compactInlineAgentContext({
      messages,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: faux.summarizer,
      settings: SMALL_SETTINGS, // window 1000 → threshold 900; keepRecent 200
      contextWindowTokens: 1_000,
    }, new AbortController().signal);

    // Shape: [compactionSummary, ...retainedTail]
    const [summary, ...tail] = outcome.messages;
    expect(summary.role).toBe('compactionSummary');
    if (summary.role !== 'compactionSummary') return;
    expect(summary.summary).toBe('COMPACT SUMMARY');
    expect(summary.tokensBefore).toBe(950);

    // Retained tail: the pending user message kept whole (200 tokens, within
    // the 200-token keep-recent budget + one-message slack), same references.
    expect(tail).toHaveLength(1);
    expect(tail[0]).toBe(messages[3]);
    expect(estimateOf(tail as AgentMessage[])).toBeLessThanOrEqual(
      SMALL_SETTINGS.keepRecentTokens + 250,
    );

    // Validated result shape.
    expect(outcome.result).toBeDefined();
    expect(outcome.result?.summary).toBe('COMPACT SUMMARY');
    expect(outcome.result?.tokensBefore).toBe(950);
    expect(outcome.result?.retainedTail).toEqual(tail);

    // The summary request rode the injected summarizer with the conversation.
    expect(faux.callCount()).toBe(1);
    expect(faux.lastSummaryPrompt()).toContain('[User]: u1 aaaa');
  });

  it('summary request failure fails open: unchanged messages, warn logged', async () => {
    const faux = createFauxSummarizer();
    faux.setResponses([]); // faux errors with "No more faux responses queued"
    const messages = loopTranscript();

    const outcome = await compactInlineAgentContext({
      messages,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: faux.summarizer,
      settings: SMALL_SETTINGS,
      contextWindowTokens: 1_000,
    }, new AbortController().signal);

    expect(outcome.messages).toBe(messages);
    expect(outcome.result).toBeUndefined();
    const entries = diagnosticLogBuffer.snapshot();
    expect(entries.some((e) => e.level === 'warn' && e.source === 'inline-agent-compaction')).toBe(true);
  });

  it('pre-aborted signal fails open: unchanged messages, summarizer never called', async () => {
    const faux = createFauxSummarizer();
    const messages = loopTranscript();
    const controller = new AbortController();
    controller.abort();

    const outcome = await compactInlineAgentContext({
      messages,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: faux.summarizer,
      settings: SMALL_SETTINGS,
      contextWindowTokens: 1_000,
    }, controller.signal);

    expect(outcome.messages).toBe(messages);
    expect(faux.callCount()).toBe(0);
  });

  it('disabled settings never compact', async () => {
    const faux = createFauxSummarizer();
    const messages = loopTranscript();

    const outcome = await compactInlineAgentContext({
      messages,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: faux.summarizer,
      settings: { ...SMALL_SETTINGS, enabled: false },
      contextWindowTokens: 1_000,
    }, new AbortController().signal);

    expect(outcome.messages).toBe(messages);
    expect(faux.callCount()).toBe(0);
  });

  it('missing summarizer port (chain-bound web backend) never compacts', async () => {
    const messages = loopTranscript();

    const outcome = await compactInlineAgentContext({
      messages,
      timeoutMs: INLINE_AGENT_COMPACTION_TIMEOUT_MS,
      summarizer: null,
      settings: SMALL_SETTINGS,
      contextWindowTokens: 1_000,
    }, new AbortController().signal);

    expect(outcome.messages).toBe(messages);
    expect(outcome.result).toBeUndefined();
  });

  it('hung summary request fails open at the bounded deadline', async () => {
    const faux = createFauxSummarizer();
    faux.setResponses([() => new Promise<AssistantMessage>(() => { /* never settles */ })]);
    const messages = loopTranscript();

    const outcome = await compactInlineAgentContext({
      messages,
      timeoutMs: 50,
      summarizer: faux.summarizer,
      settings: SMALL_SETTINGS,
      contextWindowTokens: 1_000,
    }, new AbortController().signal);

    expect(outcome.messages).toBe(messages);
    const entries = diagnosticLogBuffer.snapshot();
    expect(entries.some((e) => e.level === 'warn' && e.source === 'inline-agent-compaction')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LLM rendering of the compacted context
// ---------------------------------------------------------------------------

describe('inlineAgentConvertToLlm', () => {
  it('renders standard roles byte-identically to the released filter', () => {
    const messages = loopTranscript();
    const rendered = inlineAgentConvertToLlm(messages);
    // Released behavior: pass user/assistant/toolResult through unchanged.
    expect(rendered).toEqual(messages.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'));
    expect(JSON.stringify(rendered)).toBe(JSON.stringify(messages));
  });

  it('renders the compaction summary with the package prefix/suffix convention', () => {
    const summaryMessage: AgentMessage = {
      role: 'compactionSummary',
      summary: 'COMPACT SUMMARY',
      tokensBefore: 1250,
      timestamp: 9_000,
    };
    const tail = userMsg('u3', 9_100);
    const rendered = inlineAgentConvertToLlm([summaryMessage, tail]);

    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: COMPACTION_SUMMARY_PREFIX + 'COMPACT SUMMARY' + COMPACTION_SUMMARY_SUFFIX }],
      timestamp: 9_000,
    });
    expect(rendered[1]).toBe(tail as unknown as Message);
  });
});
