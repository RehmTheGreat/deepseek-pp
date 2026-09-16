import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInlineAgentTraceStore } from '../core/inline-agent/trace-store';
import type { InlineAgentTraceRecord } from '../core/inline-agent/types';
import type {
  RawStorageSlot,
  StorageSlotPort,
} from '../core/persistence/versioned-repository';
import type { ToolDescriptor } from '../core/types';
import type {
  InlineAgentSubagentOutcome,
  InlineAgentSubagentSpawnResult,
} from '../core/inline-agent/subagent';

const adapterMocks = vi.hoisted(() => ({
  createPowHeaders: vi.fn(),
  submitPromptStreaming: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test-token' }),
  createPowHeaders: adapterMocks.createPowHeaders,
  submitPromptStreaming: adapterMocks.submitPromptStreaming,
}));

const { createInlineAgentSubagentRunner } = await import('../core/inline-agent/subagent');

function descriptor(invocationName: string): ToolDescriptor {
  return {
    id: `local:test:${invocationName}`,
    provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
    name: invocationName,
    invocationName,
    title: invocationName,
    description: `test ${invocationName}`,
    inputSchema: { type: 'object' },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

function createMemorySlot(initial: RawStorageSlot): StorageSlotPort {
  let slot = initial;
  return {
    read: vi.fn(async () => slot),
    write: vi.fn(async (value: unknown) => {
      slot = { present: true, value };
    }),
    remove: vi.fn(async () => {
      slot = { present: false };
    }),
  };
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const store = createInlineAgentTraceStore(createMemorySlot({ present: false }));
  const controller = new AbortController();
  const executeTool = vi.fn(async () => ({
    name: 'artifact_create',
    provider: { kind: 'local' as const, id: 'artifact', displayName: 'Artifact', transport: 'in_process' as const },
    result: { ok: true, summary: 'Artifact created' },
  }));
  const runner = createInlineAgentSubagentRunner({
    parentTraceId: 'trace-parent',
    parentLoopId: 'loop-parent',
    chatSessionId: 'chat-1',
    traceUrl: 'https://chat.deepseek.com/a/chat/s/chat-1',
    promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
    toolDescriptors: [descriptor('artifact_create')],
    executeTool,
    signal: controller.signal,
    upsertTrace: (trace: InlineAgentTraceRecord) => store.upsert(trace),
    locale: 'en',
    ...overrides,
  });
  return { runner, store, controller, executeTool };
}

/** Narrows a spawn result to a child outcome (refusals fail the test). */
function outcomeOf(result: InlineAgentSubagentSpawnResult): InlineAgentSubagentOutcome {
  expect(result.refused).toBe(false);
  if (result.refused) throw new Error('expected a child outcome, got a refusal');
  return result;
}

const XML_TOOL_CALL = '<artifact_create>{"filename":"a.txt","content":"ok"}</artifact_create>';
// Legacy single-bar DSML wire form (｜DSML｜, U+FF5C once): the parser surface
// inherited from runPiInlineAgentLoop must treat it EXACTLY like the taught
// XML form in child runs (R9: pinned by test, not assumed).
const DSML_TOOL_CALL = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="artifact_create">',
  '<｜DSML｜parameter name="filename" string="true">a.txt</｜DSML｜parameter>',
  '<｜DSML｜parameter name="content" string="true">ok</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('');

describe('R9: child runs parse DSML and XML tool calls identically', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a legacy DSML tool call in a child run executes and records like the XML form', async () => {
    vi.useFakeTimers();
    const { runner, store, executeTool } = createHarness();

    adapterMocks.submitPromptStreaming
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk(XML_TOOL_CALL);
        return { assistantText: '', responseMessageId: 102, requestMessageId: 101, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('XML child done.');
        return { assistantText: '', responseMessageId: 104, requestMessageId: 103, finished: true };
      });

    const xmlRun = runner.spawn({ payload: { task: 'xml child' }, chainParentMessageId: 100 });
    await vi.advanceTimersByTimeAsync(7_000);
    const xmlResult = outcomeOf(await xmlRun);

    adapterMocks.submitPromptStreaming
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk(DSML_TOOL_CALL);
        return { assistantText: '', responseMessageId: 202, requestMessageId: 201, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('DSML child done.');
        return { assistantText: '', responseMessageId: 204, requestMessageId: 203, finished: true };
      });

    const dsmlRun = runner.spawn({ payload: { task: 'dsml child' }, chainParentMessageId: 100 });
    await vi.advanceTimersByTimeAsync(7_000);
    const dsmlResult = outcomeOf(await dsmlRun);

    // Both wire forms execute the SAME tool with the SAME payload.
    expect(executeTool).toHaveBeenCalledTimes(2);
    const executedCalls = executeTool.mock.calls as unknown as Array<
      [call: { name: string; invocationName?: string; payload: Record<string, unknown> }]
    >;
    const [xmlCall, dsmlCall] = executedCalls.map((call) => call[0]);
    expect(xmlCall).toMatchObject({ name: 'artifact_create', invocationName: 'artifact_create' });
    expect(dsmlCall).toMatchObject({ name: 'artifact_create', invocationName: 'artifact_create' });
    expect(dsmlCall.payload).toEqual(xmlCall.payload);

    // Both children complete with the same execution/trace shape: a clean
    // success record, one tool, and the final text — no parseError penalty for
    // either form, no silent drop for the legacy form.
    expect(xmlResult).toMatchObject({
      ok: true,
      refused: false,
      status: 'complete',
      finalText: 'XML child done.',
      totalTools: 1,
    });
    expect(dsmlResult).toMatchObject({
      ok: true,
      refused: false,
      status: 'complete',
      finalText: 'DSML child done.',
      totalTools: 1,
    });
    expect(dsmlResult.totalSteps).toBe(xmlResult.totalSteps);

    const rows = await store.read();
    const projection = (row: InlineAgentTraceRecord) => ({
      status: row.status,
      totalTools: row.totalTools,
      stepExecutions: row.steps.flatMap((step) => step.toolExecutions.map((exec) => ({
        name: exec.name,
        ok: exec.result.ok,
        summary: exec.result.summary,
      }))),
    });
    const xmlRow = rows.find((row) => row.loopId === xmlResult.childLoopId);
    const dsmlRow = rows.find((row) => row.loopId === dsmlResult.childLoopId);
    expect(xmlRow).toBeDefined();
    expect(dsmlRow).toBeDefined();
    expect(projection(dsmlRow as InlineAgentTraceRecord)).toEqual(projection(xmlRow as InlineAgentTraceRecord));
    expect(projection(dsmlRow as InlineAgentTraceRecord).stepExecutions).toEqual([
      { name: 'artifact_create', ok: true, summary: 'Artifact created' },
    ]);
  });

  it('paces child continuation requests with the same released 2.5-6.5s throttle as parent loops', async () => {
    vi.useFakeTimers();
    const { runner } = createHarness();
    adapterMocks.submitPromptStreaming
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk(XML_TOOL_CALL);
        return { assistantText: '', responseMessageId: 102, requestMessageId: 101, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('Done after the throttle.');
        return { assistantText: '', responseMessageId: 104, requestMessageId: 103, finished: true };
      });

    const run = runner.spawn({ payload: { task: 'paced child' }, chainParentMessageId: 100 });
    await vi.advanceTimersByTimeAsync(0);
    // The child's FIRST model request fires immediately (released semantics:
    // no throttle before the first request of a run).
    expect(adapterMocks.submitPromptStreaming).toHaveBeenCalledTimes(1);

    // The continuation request only fires after the shared pacing window
    // (waitBetweenDeepSeekRequests, 2.5-6.5s) — same adapter path as parents.
    await vi.advanceTimersByTimeAsync(2_499);
    expect(adapterMocks.submitPromptStreaming).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(adapterMocks.submitPromptStreaming).toHaveBeenCalledTimes(2);

    await run;
  });

  it('gives every child its own conversation chain anchored at the injected chain id (R7 isolation)', async () => {
    vi.useFakeTimers();
    const { runner } = createHarness();
    adapterMocks.submitPromptStreaming
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('First child answer.');
        return { assistantText: '', responseMessageId: 555, requestMessageId: 554, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('Second child answer.');
        return { assistantText: '', responseMessageId: 777, requestMessageId: 776, finished: true };
      });

    const first = runner.spawn({ payload: { task: 'child one' }, chainParentMessageId: 100 });
    await first;
    const second = runner.spawn({ payload: { task: 'child two' }, chainParentMessageId: 100 });
    await second;

    // Both children anchor their FIRST request at the injected chain id — the
    // first child's own chain advance (555) never leaks into the second child
    // (session.setParentMessageId is single-owner per fresh child loop).
    const calls = adapterMocks.submitPromptStreaming.mock.calls as Array<
      [input: { parentMessageId: number | null }]
    >;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].parentMessageId).toBe(100);
    expect(calls[1][0].parentMessageId).toBe(100);
  });
});
