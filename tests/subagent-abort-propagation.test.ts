import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const {
  createInlineAgentSubagentRunner,
  INLINE_AGENT_SUBAGENT_TEARDOWN_GRACE_MS,
} = await import('../core/inline-agent/subagent');

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

function childRow(rows: InlineAgentTraceRecord[]): InlineAgentTraceRecord {
  const row = rows.find((item) => item.parentTraceId === 'trace-parent');
  expect(row).toBeDefined();
  return row as InlineAgentTraceRecord;
}

describe('subagent abort propagation (R8 teardown)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a running child when the parent run aborts; the child settles and its trace closes honestly', async () => {
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      (_input: unknown, _handlers: unknown, signal: AbortSignal) => abortAwarePendingTurn(signal),
    );
    const { runner, store, controller } = createHarness();

    const run = runner.spawn({ payload: { task: 'long child' }, chainParentMessageId: 100 });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    // The spawn RESOLVES with a structured failure — never a throw, never a
    // silent drop: the parent's tool result carries an honest reason.
    const result = await run;
    expect(result).toMatchObject({
      ok: false,
      refused: false,
      status: 'stopping',
      deadlineExceeded: false,
      childTraceId: expect.stringContaining('subagent:trace-parent'),
      childLoopId: expect.stringContaining('subagent:loop-parent'),
    });
    expect((result as { error?: string }).error).toBeTruthy();

    // The child trace closed with an honest terminal status.
    const row = childRow(await store.read());
    expect(row.status).toBe('stopping');
    expect(row.error).toBeTruthy();
  });

  it('propagates a pre-aborted parent signal to a spawn that starts after the abort', async () => {
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      (_input: unknown, _handlers: unknown, signal: AbortSignal) => abortAwarePendingTurn(signal),
    );
    const { runner, controller, store } = createHarness();
    controller.abort();

    const run = runner.spawn({ payload: { task: 'too late' }, chainParentMessageId: 100 });
    const result = await run;
    expect(result).toMatchObject({ ok: false, refused: false, status: 'stopping' });
    const row = childRow(await store.read());
    expect(row.status).toBe('stopping');
  });

  it('surfaces a child loop failure to the parent as a structured result (never a throw, never silence)', async () => {
    const { runner, store } = createHarness();
    // Empty continuation without a chain link: the loop ends AGENT_LOOP_ERROR.
    adapterMocks.submitPromptStreaming.mockImplementationOnce(async () => ({
      assistantText: '',
      responseMessageId: null,
      requestMessageId: 101,
      finished: true,
    }));

    // The spawn promise RESOLVES even though the child failed.
    const result = await runner.spawn({ payload: { task: 'doomed child' }, chainParentMessageId: 100 });
    expect(result).toMatchObject({
      ok: false,
      refused: false,
      status: 'error',
      deadlineExceeded: false,
    });
    expect((result as { error?: string }).error).toContain('empty agent continuation');

    const row = childRow(await store.read());
    expect(row.status).toBe('error');
    expect(row.error).toContain('empty agent continuation');
  });

  it('tears a child down at the 180s tool deadline and reports an honest structured failure', async () => {
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      (_input: unknown, _handlers: unknown, signal: AbortSignal) => abortAwarePendingTurn(signal),
    );
    const { runner, store, controller } = createHarness();

    const run = runner.spawn({ payload: { task: 'slow child' }, chainParentMessageId: 100 });
    await vi.advanceTimersByTimeAsync(180_000);
    const result = await run;

    expect(result).toMatchObject({
      ok: false,
      refused: false,
      status: 'stopping',
      deadlineExceeded: true,
    });
    expect((result as { error?: string }).error).toContain('deadline');

    const row = childRow(await store.read());
    expect(row.status).toBe('stopping');
    expect(row.error).toBeTruthy();

    // Settle the run bookkeeping for teardown hygiene.
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('closes the child trace honestly even when a tool handler is stranded past the deadline', async () => {
    vi.useFakeTimers();
    // A stranded background handler: the tool promise never settles, even
    // on abort — the engine must still close the child run after its grace.
    const strandedTool = vi.fn(() => new Promise<never>(() => {}));
    const { runner, store, controller } = createHarness({ executeTool: strandedTool });
    adapterMocks.submitPromptStreaming.mockImplementationOnce(
      async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('<artifact_create>{"filename":"a.txt","content":"ok"}</artifact_create>');
        return { assistantText: '', responseMessageId: 102, requestMessageId: 101, finished: true };
      },
    ).mockImplementation((_input: unknown, _handlers: unknown, signal: AbortSignal) =>
      abortAwarePendingTurn(signal));

    const run = runner.spawn({ payload: { task: 'stranded child' }, chainParentMessageId: 100 });
    await vi.advanceTimersByTimeAsync(1_000); // tool-call turn streams and the tool starts
    expect(strandedTool).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(180_000); // tool deadline fires, child aborted
    await vi.advanceTimersByTimeAsync(INLINE_AGENT_SUBAGENT_TEARDOWN_GRACE_MS);
    const result = await run;

    expect(result).toMatchObject({ ok: false, refused: false, status: 'stopping', deadlineExceeded: true });
    const row = childRow(await store.read());
    expect(row.status).toBe('stopping');
    expect(row.error).toBeTruthy();
    // The in-flight step (with the recorded tool context) is still persisted.
    expect(row.steps.length).toBeGreaterThan(0);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
  });
});
