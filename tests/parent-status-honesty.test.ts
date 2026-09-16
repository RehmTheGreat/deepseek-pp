import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeInterruptedTrace } from '../core/inline-agent/trace-status';
import { createInlineAgentTraceStore } from '../core/inline-agent/trace-store';
import type { InlineAgentTraceRecord } from '../core/inline-agent/types';
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

const { createInlineAgentSubagentRunner } = await import('../core/inline-agent/subagent');

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

function parentTrace(): InlineAgentTraceRecord {
  const now = Date.now();
  return {
    id: 'trace-parent',
    loopId: 'loop-parent',
    chatSessionId: 'chat-1',
    anchorMessageId: 100,
    url: 'https://chat.deepseek.com/a/chat/s/chat-1',
    originalPrompt: 'parent task',
    agentTaskPrompt: 'parent task',
    status: 'running',
    steps: [],
    totalSteps: 0,
    totalTools: 0,
    finalText: '',
    createdAt: now,
    updatedAt: now,
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
  return { runner, store, controller };
}

/**
 * The parent-status honesty invariant (constraint 2): after the parent run
 * reaches ANY terminal state, no trace row of the run — the parent's own row
 * or a child row — may stay persisted as a non-terminal `running` state. The
 * parent's row is closed by the caller with the EXISTING
 * `closeInterruptedTrace` pattern (trace-status.ts), exactly as content.ts
 * does on supersede/stop; the engine owns the same guarantee for child rows.
 */
describe('parent and child trace status honesty with children in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves no running trace row after the parent turns terminal while a child was in flight', async () => {
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      (_input: unknown, _handlers: unknown, signal: AbortSignal) => abortAwarePendingTurn(signal),
    );
    const { runner, store, controller } = createHarness();
    const parent = parentTrace();
    await store.upsert(parent);

    const child = runner.spawn({ payload: { task: 'in-flight child' }, chainParentMessageId: 101 });
    await vi.advanceTimersByTimeAsync(0);

    // Parent goes terminal mid-child (user stop / supersede): its row closes
    // through the EXISTING closeInterruptedTrace pattern; the abort reaches
    // the child through the engine.
    controller.abort();
    const childResult = await child;
    await vi.advanceTimersByTimeAsync(1_000);
    const closedParent = closeInterruptedTrace(parent, 'stopped by user');
    await store.upsert(closedParent);

    expect(childResult).toMatchObject({ refused: false, status: 'stopping' });
    const rows = await store.read();
    expect(rows.map((row) => row.id).sort()).toEqual(
      ['trace-parent', (childResult as { childTraceId: string }).childTraceId].sort(),
    );
    for (const row of rows) {
      expect(row.status).not.toBe('running');
      // An interrupted close carries its reason — honest, never bare 'stopping'.
      if (row.status === 'stopping') expect(row.error).toBeTruthy();
    }
    const childRow = rows.find((row) => row.id !== 'trace-parent');
    expect(childRow?.parentTraceId).toBe('trace-parent');
    expect(childRow?.loopId).not.toBe(parent.loopId);
  });

  it('a spawn whose result is never awaited still closes its child trace honestly', async () => {
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      (_input: unknown, _handlers: unknown, signal: AbortSignal) => abortAwarePendingTurn(signal),
    );
    const { runner, store, controller } = createHarness();

    // The parent's tool await rejects on abort (raceWithDeadline absorbs the
    // spawn result) — nobody awaits the child's settlement. The engine must
    // still persist the honest terminal row on its own.
    const spawnPromise = runner.spawn({ payload: { task: 'detached child' }, chainParentMessageId: 101 });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);

    const rows = await store.read();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('stopping');
    expect(rows[0].error).toBeTruthy();
    expect(await spawnPromise).toMatchObject({ status: 'stopping' });
  });

  it('a normally completing parent leaves every row of the run terminal', async () => {
    const { runner, store } = createHarness();
    const parent = parentTrace();
    await store.upsert(parent);
    adapterMocks.submitPromptStreaming.mockImplementationOnce(async (
      _input: unknown,
      handlers: { onTextChunk: (t: string) => void },
    ) => {
      handlers.onTextChunk('Child finished cleanly.');
      return { assistantText: '', responseMessageId: 103, requestMessageId: 102, finished: true };
    });

    const result = await runner.spawn({ payload: { task: 'happy child' }, chainParentMessageId: 101 });
    expect(result).toMatchObject({ ok: true, refused: false, status: 'complete' });

    // Parent terminal: the honest closure its own terminal event drives.
    await store.upsert({ ...parent, status: 'complete', finalText: 'done' });

    const rows = await store.read();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(['complete', 'error', 'stopping']).toContain(row.status);
      expect(row.status).not.toBe('running');
    }
    const childRow = rows.find((row) => row.id !== 'trace-parent');
    expect(childRow).toMatchObject({
      parentTraceId: 'trace-parent',
      status: 'complete',
      finalText: 'Child finished cleanly.',
    });
  });
});
