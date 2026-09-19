import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryToolDescriptors } from '../core/tool/memory';
import type { InlineAgentStartPayload } from '../core/inline-agent/types';

/**
 * D1 (fix round 4, live diagnosis trace pyr24x): a loop that goes quiet left a
 * `running` zombie trace forever because deadlines bound single awaits only.
 * Three guards close every silent-death path:
 *  - a no-event watchdog in the loop adapter aborts + finalizes a run that
 *    posts no AGENT_* event and no tool activity for the watchdog threshold;
 *  - a pagehide finalizer in content.ts writes the honest `stopping` trace and
 *    aborts the live controller when the page goes away mid-run;
 *  - zombie healing on restore finalizes any stored `running` row without a
 *    live loop (pinned in tests/inline-agent-trace-status.test.ts and via the
 *    source contracts at the bottom of this file).
 */

const adapterMocks = vi.hoisted(() => ({
  createPowHeaders: vi.fn(),
  submitPromptStreaming: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test-token' }),
  createPowHeaders: adapterMocks.createPowHeaders,
  submitPromptStreaming: adapterMocks.submitPromptStreaming,
}));

const { runInlineAgentLoop } = await import('../core/inline-agent/loop');
const { INLINE_AGENT_LOOP_EVENT_WATCHDOG_MS } = await import(
  '../core/inline-agent/types'
);
const { INLINE_AGENT_LOOP_WATCHDOG_ERROR_MESSAGE } = await import(
  '../core/inline-agent/pi/loop-adapter'
);

function createPayload(): InlineAgentStartPayload {
  return {
    loopId: 'loop-watchdog-1',
    chatSessionId: 'chat-1',
    parentMessageId: 100,
    originalPrompt: 'Use the tool and summarize the result.',
    agentTaskPrompt: 'Use the tool and summarize the result.',
    toolExecutions: [],
    promptOptions: {
      modelType: null,
      searchEnabled: false,
      thinkingEnabled: false,
      refFileIds: [],
    },
    toolDescriptors: createMemoryToolDescriptors('en'),
    locale: 'en',
  };
}

describe('inline-agent loop no-event watchdog (D1b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({
      'X-DS-PoW-Response': 'pow-1',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    adapterMocks.submitPromptStreaming.mockReset();
  });

  it('finalizes a silent run with a structured AGENT_LOOP_ERROR and settles it', async () => {
    vi.useFakeTimers();
    // A hang OUTSIDE every per-await deadline - the exact zombie shape of the
    // live diagnosis (trace pyr24x went quiet after a completed step and
    // never came back): the PoW phase never resolves and never errors. The
    // real PoW deadline lives inside createPowHeaders; a defect there (or in
    // any engine-internal await between events) escapes the 120s step
    // timeout, the 180s tool deadline and the 20s PoW deadline alike. The
    // hang respects abort (as every real layer does), so the watchdog abort
    // unwinds the run.
    adapterMocks.createPowHeaders.mockImplementation(
      (_headers: unknown, _powUrl: unknown, signal: AbortSignal) => {
        if (signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    );

    const post = vi.fn();
    const run = runInlineAgentLoop(createPayload(), {
      post,
      executeTool: vi.fn(),
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(INLINE_AGENT_LOOP_EVENT_WATCHDOG_MS - 1);
    expect(post).not.toHaveBeenCalledWith(
      'AGENT_LOOP_ERROR',
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_ERROR', expect.objectContaining({
      loopId: 'loop-watchdog-1',
      error: INLINE_AGENT_LOOP_WATCHDOG_ERROR_MESSAGE,
    }));
    // The run must settle after the watchdog aborts the engine: no hung
    // promise may keep the caller (content.ts loop task) alive forever.
    await vi.advanceTimersByTimeAsync(100);
    await expect(Promise.race([
      run,
      vi.advanceTimersByTimeAsync(60_000).then(() => {
        throw new Error('run did not settle after the watchdog fired');
      }),
    ])).resolves.toBeUndefined();
  });

  it('never fires while the run is legitimately slow but eventful', async () => {
    vi.useFakeTimers();
    // A legal slow shape: turn 1 parses a tool call, the tool phase sits
    // quiet 180s (the tool deadline's own magnitude - the longest legal quiet
    // stretch, which the watchdog threshold must exceed), then the model
    // answers and the loop completes.
    adapterMocks.submitPromptStreaming.mockImplementationOnce(
      async (_input, handlers) => {
        handlers.onTextChunk(
          '<memory_save>{"type":"user","name":"watchdog","content":"note","tags":["t"]}</memory_save>',
        );
        return {
          assistantText: '',
          responseMessageId: 101,
          requestMessageId: 100,
          finished: true,
        };
      },
    );
    adapterMocks.submitPromptStreaming.mockImplementationOnce(
      async (_input, handlers) => {
        handlers.onTextChunk('Done after the slow tool.');
        return {
          assistantText: '',
          responseMessageId: 103,
          requestMessageId: 102,
          finished: true,
        };
      },
    );

    let releaseTool: (() => void) | undefined;
    const executeTool = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      return {
        name: 'memory_save',
        result: { ok: true, summary: 'saved' },
      } as never;
    });

    const post = vi.fn();
    const run = runInlineAgentLoop({
      ...createPayload(),
      toolDescriptors: createMemoryToolDescriptors('en'),
    }, {
      post,
      executeTool,
      signal: new AbortController().signal,
    });

    // Let the first turn stream and the tool start (TOOL_DETECTED pokes).
    await vi.advanceTimersByTimeAsync(50);
    expect(releaseTool).not.toBeNull();
    // The longest legal quiet stretch: the tool phase. The watchdog threshold
    // is strictly above it, so this whole advance must stay ERROR-free.
    await vi.advanceTimersByTimeAsync(
      INLINE_AGENT_LOOP_EVENT_WATCHDOG_MS - 60_000,
    );
    expect(post).not.toHaveBeenCalledWith(
      'AGENT_LOOP_ERROR',
      expect.anything(),
    );

    releaseTool!();
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_COMPLETE', expect.objectContaining({
      finalText: 'Done after the slow tool.',
    }));
    expect(post).not.toHaveBeenCalledWith(
      'AGENT_LOOP_ERROR',
      expect.anything(),
    );
  });

  it('uses a named constant strictly above the 180s tool deadline', () => {
    expect(INLINE_AGENT_LOOP_EVENT_WATCHDOG_MS).toBeGreaterThan(180_000);
  });
});

describe('content.ts pagehide finalizer + zombie healing wiring (D1a/D1c, source contracts)', () => {
  const contentSource = readFileSync('entrypoints/content.ts', 'utf8');

  it('registers a pagehide finalizer that closes the running trace and aborts the live loop', () => {
    expect(contentSource).toMatch(/addEventListener\(\s*"pagehide"/);
    const finalizer = contentSource
      .split('function finalizeInlineAgentRunOnPageHide(')[1]
      ?.split('\nfunction ')[0];
    expect(finalizer).toBeTruthy();
    // Honest terminal status: the existing closeInterruptedTrace helper with
    // the stopped message - no new loop status values.
    expect(finalizer).toContain('closeInterruptedTrace');
    expect(finalizer).toContain('content.agent.stopped');
    // Abort semantics reuse the stop/supersede controller (no new status).
    expect(finalizer).toContain('activeAgentAbort.abort()');
    // The write must bypass the debounce: pagehide kills pending timers.
    expect(finalizer).toContain('{ immediate: true }');
  });

  it('heals abandoned running rows in the restore pass regardless of route', () => {
    const restore = contentSource
      .split('async function restorePersistedInlineAgentTraces(')[1]
      ?.split('\nasync function ')[0];
    expect(restore).toBeTruthy();
    // Every stored `running` row without a live loop is finalized, even when
    // its chat session is not the visible one (the pyr24x zombie stayed
    // `running` for four hours because healing was restore-gated).
    expect(restore).toContain('healAbandonedRunningTrace');
  });
});
