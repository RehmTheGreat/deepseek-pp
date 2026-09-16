import { describe, expect, it, vi } from 'vitest';
import {
  INLINE_AGENT_SUBAGENT_MAX_CONCURRENT,
  INLINE_AGENT_SUBAGENT_MAX_DEPTH,
  INLINE_AGENT_SUBAGENT_MAX_PER_RUN,
  type InlineAgentSubagentSpawnPayload,
  type InlineAgentTraceRecord,
} from '../core/inline-agent/types';
import { createInlineAgentTraceStore } from '../core/inline-agent/trace-store';
import type {
  RawStorageSlot,
  StorageSlotPort,
} from '../core/persistence/versioned-repository';

function trace(
  overrides: Partial<InlineAgentTraceRecord> = {},
): InlineAgentTraceRecord {
  return {
    id: 'trace-1',
    loopId: 'loop-1',
    chatSessionId: 'session-1',
    anchorMessageId: 10,
    url: 'https://chat.deepseek.com/a/chat/s/session-1',
    originalPrompt: 'task',
    agentTaskPrompt: 'task',
    status: 'running',
    steps: [
      {
        index: 0,
        status: 'streaming',
        text: 'working…',
        toolExecutions: [],
        responseMessageId: null,
        collapsed: false,
      },
    ],
    totalSteps: 1,
    totalTools: 0,
    finalText: '',
    createdAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  };
}

function createMemorySlot(initial: RawStorageSlot): StorageSlotPort & {
  write: ReturnType<typeof vi.fn>;
} {
  let slot = initial;
  const write = vi.fn(async (value: unknown) => {
    slot = { present: true, value };
  });
  return {
    read: vi.fn(async () => slot),
    write,
    remove: vi.fn(async () => {
      slot = { present: false };
    }),
  };
}

describe('subagent cap constants', () => {
  it('exposes the decided cap values', () => {
    expect(INLINE_AGENT_SUBAGENT_MAX_CONCURRENT).toBe(2);
    expect(INLINE_AGENT_SUBAGENT_MAX_PER_RUN).toBe(6);
    expect(INLINE_AGENT_SUBAGENT_MAX_DEPTH).toBe(1);
  });
});

describe('subagent spawn payload type', () => {
  it('accepts task-only payloads and an optional string-array allowlist hint', () => {
    const minimal: InlineAgentSubagentSpawnPayload = { task: 'Summarize the page' };
    const withHint: InlineAgentSubagentSpawnPayload = {
      task: 'Summarize the page',
      toolAllowlistHint: ['browser_control', 'memory_search'],
    };
    expect(minimal.task).toBe('Summarize the page');
    expect(minimal.toolAllowlistHint).toBeUndefined();
    expect(withHint.toolAllowlistHint).toEqual(['browser_control', 'memory_search']);
  });

  it('rejects payloads missing task or with a non-string allowlist (compile-time)', () => {
    // Compile-time guards enforced by `npm run compile` (tsc covers tests/):
    // if someone loosens the payload type, these become unused-expect errors.
    // @ts-expect-error — task text is required in the spawn payload
    const missingTask: InlineAgentSubagentSpawnPayload = {};
    // @ts-expect-error — the allowlist hint must be string[] when present
    const badHint: InlineAgentSubagentSpawnPayload = { task: 'x', toolAllowlistHint: [1, 2] };
    expect(missingTask).toBeDefined();
    expect(badHint).toBeDefined();
  });
});

describe('inline-agent trace record parent link', () => {
  it('round-trips a parentTraceId through the existing dpp_inline_agent_traces store path', async () => {
    const storage = createMemorySlot({ present: false });
    const store = createInlineAgentTraceStore(storage);
    const parent = trace({ id: 'trace-parent', loopId: 'loop-parent' });
    const child = trace({
      id: 'trace-child',
      loopId: 'loop-child',
      parentTraceId: 'trace-parent',
    });
    await store.upsert(parent, 2_000);
    await store.upsert(child, 2_001);

    const stored = await store.read();
    expect(stored.map((item) => item.id)).toEqual(['trace-parent', 'trace-child']);
    expect(stored[1].parentTraceId).toBe('trace-parent');

    // The persisted raw slot carries the field verbatim — nothing strips it.
    const raw = (storage.write.mock.calls.at(-1)?.[0] as InlineAgentTraceRecord[]).at(-1);
    expect(raw).toMatchObject({ id: 'trace-child', parentTraceId: 'trace-parent' });
  });

  it('reads a record without parentTraceId identically to before (backward compat)', async () => {
    const storage = createMemorySlot({ present: false });
    const store = createInlineAgentTraceStore(storage);
    const parentless = trace();
    await store.upsert(parentless, 2_000);

    const stored = await store.read();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(parentless);
    // Absent stays absent: no writer change leaks a null/undefined key.
    expect('parentTraceId' in stored[0]).toBe(false);
  });

  it('fails visibly on a corrupt (non-string) parentTraceId at the storage boundary', async () => {
    const corrupt = { ...trace(), parentTraceId: null } as unknown as InlineAgentTraceRecord;
    const storage = createMemorySlot({ present: true, value: [corrupt] });
    await expect(createInlineAgentTraceStore(storage).read()).rejects.toThrow(
      /parentTraceId/,
    );
  });
});
