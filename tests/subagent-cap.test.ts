import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInlineAgentTraceStore } from '../core/inline-agent/trace-store';
import type {
  InlineAgentSubagentSpawnPayload,
  InlineAgentTraceRecord,
} from '../core/inline-agent/types';
import type {
  RawStorageSlot,
  StorageSlotPort,
} from '../core/persistence/versioned-repository';
import type { ToolDescriptor } from '../core/types';

const adapterMocks = vi.hoisted(() => ({
  createPowHeaders: vi.fn(),
  submitPromptStreaming: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test-token' }),
  createPowHeaders: adapterMocks.createPowHeaders,
  submitPromptStreaming: adapterMocks.submitPromptStreaming,
}));

const { createInlineAgentSubagentRunner, deriveChildToolDescriptors } = await import(
  '../core/inline-agent/subagent'
);

function abortAwarePendingTurn(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function finishedTurn(text: string, responseMessageId: number) {
  return async (_input: unknown, handlers: { onTextChunk: (text: string) => void }) => {
    if (text) handlers.onTextChunk(text);
    return { assistantText: '', responseMessageId, requestMessageId: responseMessageId - 1, finished: true };
  };
}

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

function spawn(task: string, chainParentMessageId = 100) {
  const payload: InlineAgentSubagentSpawnPayload = { task };
  return { payload, chainParentMessageId };
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
    toolDescriptors: [descriptor('artifact_create'), descriptor('web_search')],
    executeTool,
    signal: controller.signal,
    upsertTrace: (trace: InlineAgentTraceRecord) => store.upsert(trace),
    locale: 'en',
    ...overrides,
  });
  return { runner, store, controller, executeTool };
}

describe('subagent concurrency cap (R5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a third concurrent spawn with a structured model-visible refusal while two children run', async () => {
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      (_input: unknown, _handlers: unknown, signal: AbortSignal) => abortAwarePendingTurn(signal),
    );
    const { runner, store, controller } = createHarness();

    const first = runner.spawn(spawn('child one'));
    const second = runner.spawn(spawn('child two'));
    const third = await runner.spawn(spawn('child three'));

    // REFUSE semantics: a resolved structured refusal — never a throw, never
    // a queue, and the model can read the reason from the message.
    expect(third).toMatchObject({
      ok: false,
      refused: true,
      code: 'subagent_concurrency_cap',
      message: expect.stringContaining('concurrency'),
    });
    const message = (third as { message: string }).message;
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);

    // The refusal never started a child: only the two running children exist.
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.read()).filter((row) => row.parentTraceId === 'trace-parent')).toHaveLength(2);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);
  });

  it('counts concurrently EXECUTING children: a settled child frees its slot', async () => {
    const { runner, controller } = createHarness();
    adapterMocks.submitPromptStreaming.mockImplementationOnce(
      finishedTurn('First child done.', 102),
    );

    const settled = await runner.spawn(spawn('quick child'));
    expect(settled).toMatchObject({ ok: true, refused: false, status: 'complete' });

    // Two NEW children park in-flight; the cap counts them, not the history.
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      (_input: unknown, _handlers: unknown, signal: AbortSignal) => abortAwarePendingTurn(signal),
    );
    const second = runner.spawn(spawn('parked one'));
    const third = runner.spawn(spawn('parked two'));
    const fourth = await runner.spawn(spawn('refused'));

    expect(fourth).toMatchObject({ ok: false, refused: true, code: 'subagent_concurrency_cap' });

    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([second, third]);
  });

  it('refuses the seventh spawn of a run with a structured per-run refusal', async () => {
    const { runner, store } = createHarness();

    for (let i = 1; i <= 6; i += 1) {
      adapterMocks.submitPromptStreaming.mockImplementationOnce(
        finishedTurn(`Child ${i} done.`, 100 + i * 2),
      );
      const result = await runner.spawn(spawn(`child ${i}`));
      expect(result).toMatchObject({ ok: true, refused: false, status: 'complete' });
    }

    const seventh = await runner.spawn(spawn('child seven'));
    expect(seventh).toMatchObject({
      ok: false,
      refused: true,
      code: 'subagent_per_run_cap',
      message: expect.stringContaining('per-run'),
    });
    // The refusal left no trace row behind: exactly the six real children.
    expect(await store.read()).toHaveLength(6);
  });
});

describe('depth cap and allowlist intersection (R5/R10)', () => {
  const pool = [
    descriptor('artifact_create'),
    descriptor('web_search'),
    descriptor('subagent_spawn'),
  ];

  it('always excludes the subagent-spawn descriptor from the child set', () => {
    const derived = deriveChildToolDescriptors(pool, undefined);
    expect(derived.map((d) => d.invocationName)).toEqual(['artifact_create', 'web_search']);
  });

  it('intersects the hint with the available descriptors; unknown names are ignored', () => {
    const derived = deriveChildToolDescriptors(pool, [
      'artifact_create',
      'unknown_tool',
      'subagent_spawn',
    ]);
    // Least privilege: the spawn descriptor stays excluded even when the model
    // hints it; unknown hint names never materialize a descriptor.
    expect(derived.map((d) => d.invocationName)).toEqual(['artifact_create']);
  });

  it('keeps the full (spawn-free) pool when no hint is given', () => {
    expect(deriveChildToolDescriptors(pool, []).map((d) => d.invocationName))
      .toEqual(['artifact_create', 'web_search']);
    expect(deriveChildToolDescriptors(pool, ['web_search']).map((d) => d.invocationName))
      .toEqual(['web_search']);
  });

  it('a child cannot execute a subagent_spawn call (depth 1 end-to-end)', async () => {
    vi.useFakeTimers();
    // The parent pool carries ONLY the spawn descriptor: the derived child set
    // is empty, so a child emitting the spawn XML must not execute anything.
    const { runner, executeTool } = createHarness({
      toolDescriptors: [descriptor('subagent_spawn')],
    });
    adapterMocks.submitPromptStreaming.mockImplementationOnce(
      async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('<subagent_spawn>{"task":"grandchild"}</subagent_spawn>');
        return { assistantText: '', responseMessageId: 102, requestMessageId: 101, finished: true };
      },
    );

    const run = runner.spawn(spawn('spawn attempt'));
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await run;

    // The spawn call is inert for the child: never parsed, never executed.
    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      refused: false,
      status: 'complete',
      totalTools: 0,
      // The unparseable spawn XML survives only as inert visible text — it
      // never became a grandchild run.
      finalText: expect.stringContaining('<subagent_spawn>'),
    });
  });
});
