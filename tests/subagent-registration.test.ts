import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withInlineAgentSubagentSpawnDescriptor,
  isInlineAgentSubagentSpawnCall,
  parseInlineAgentSubagentSpawnPayload,
  describeInlineAgentSubagentSpawnResult,
} from '../core/inline-agent/subagent-tool';
import { deriveChildToolDescriptors } from '../core/inline-agent/subagent';
import { translate } from '../core/i18n/background';
import type { DeepSeekSessionState } from '../core/inline-agent/pi/stream-fn-port';
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

describe('subagent spawn descriptor registration (M5)', () => {
  afterEach(() => {
    // The descriptor identity pins the depth seam: a literal drift must fail
    // here instead of silently disabling the engine's depth-1 filter.
  });

  it('registers the spawn tool with invocationName equal to the IMPORTED engine constant', async () => {
    const { INLINE_AGENT_SUBAGENT_INVOCATION_NAME } = await import(
      '../core/inline-agent/subagent'
    );
    const { createInlineAgentSubagentSpawnDescriptor } = await import(
      '../core/inline-agent/subagent-tool'
    );
    const descriptor = createInlineAgentSubagentSpawnDescriptor('en');

    expect(descriptor.invocationName).toBe(INLINE_AGENT_SUBAGENT_INVOCATION_NAME);
    expect(descriptor.name).toBe(INLINE_AGENT_SUBAGENT_INVOCATION_NAME);
    expect(descriptor.invocationName).toBe('subagent_spawn');
    // Security-snapshot pattern shape: executable local descriptor with a
    // stable id and a structured input schema.
    expect(descriptor.id).toBe(`local:inline_agent:${INLINE_AGENT_SUBAGENT_INVOCATION_NAME}`);
    expect(descriptor.provider).toMatchObject({ kind: 'local', transport: 'in_process' });
    expect(descriptor.execution).toMatchObject({ mode: 'auto', enabled: true });
    expect(descriptor.inputSchema.required).toEqual(['task']);
    expect(descriptor.inputSchema.properties).toHaveProperty('task');
    expect(descriptor.inputSchema.properties).toHaveProperty('toolAllowlistHint');
    expect(descriptor.title.length).toBeGreaterThan(0);
    expect(descriptor.description.length).toBeGreaterThan(0);
  });

  it('localizes the model-facing descriptor text for en and zh-CN', async () => {
    const { createInlineAgentSubagentSpawnDescriptor } = await import(
      '../core/inline-agent/subagent-tool'
    );
    const en = createInlineAgentSubagentSpawnDescriptor('en');
    const zh = createInlineAgentSubagentSpawnDescriptor('zh-CN');

    expect(en.title).toBe(translate('en', 'tool.inlineAgent.spawnTitle'));
    expect(zh.title).toBe(translate('zh-CN', 'tool.inlineAgent.spawnTitle'));
    expect(en.title).not.toBe(zh.title);
    expect(en.description).not.toBe(zh.description);
  });

  it('appends the spawn descriptor to a descriptor pool exactly once (idempotent, pure)', async () => {
    const { createInlineAgentSubagentSpawnDescriptor } = await import(
      '../core/inline-agent/subagent-tool'
    );
    const pool = [descriptor('web_search'), descriptor('memory_save')];
    const snapshot = [...pool];

    const once = withInlineAgentSubagentSpawnDescriptor(pool);
    expect(once).toHaveLength(3);
    expect(pool).toEqual(snapshot);
    const spawnDescriptors = once.filter(
      (item) => item.invocationName === 'subagent_spawn',
    );
    expect(spawnDescriptors).toHaveLength(1);

    const twice = withInlineAgentSubagentSpawnDescriptor(once);
    expect(twice).toHaveLength(3);
  });

  it('keeps the depth seam closed: the registered descriptor never reaches a child set', async () => {
    const { createInlineAgentSubagentSpawnDescriptor } = await import(
      '../core/inline-agent/subagent-tool'
    );
    const pool = withInlineAgentSubagentSpawnDescriptor([
      descriptor('web_search'),
      descriptor('web_fetch'),
    ]);
    expect(pool.some((item) => item.invocationName === 'subagent_spawn')).toBe(true);

    const childSet = deriveChildToolDescriptors(pool, ['web_search']);
    expect(childSet.map((item) => item.invocationName)).toEqual(['web_search']);
    expect(
      deriveChildToolDescriptors(pool, undefined).some(
        (item) => item.invocationName === 'subagent_spawn',
      ),
    ).toBe(false);
  });

  it('recognizes spawn calls by invocation name or canonical name only', () => {
    expect(isInlineAgentSubagentSpawnCall({ name: 'subagent_spawn', invocationName: 'subagent_spawn' })).toBe(true);
    expect(isInlineAgentSubagentSpawnCall({ name: 'subagent_spawn' })).toBe(true);
    expect(isInlineAgentSubagentSpawnCall({ name: 'web_search', invocationName: 'subagent_spawn' })).toBe(true);
    expect(isInlineAgentSubagentSpawnCall({ name: 'web_search' })).toBe(false);
    expect(isInlineAgentSubagentSpawnCall({ name: '' })).toBe(false);
  });
});

describe('subagent spawn payload parsing (fail-closed, model-visible)', () => {
  it('parses a valid payload with an optional allowlist hint', () => {
    const parsed = parseInlineAgentSubagentSpawnPayload({
      task: 'Summarize the page',
      toolAllowlistHint: ['web_search'],
    });
    expect(parsed).toEqual({
      ok: true,
      payload: { task: 'Summarize the page', toolAllowlistHint: ['web_search'] },
    });
    expect(parseInlineAgentSubagentSpawnPayload({ task: 'x' })).toEqual({
      ok: true,
      payload: { task: 'x' },
    });
  });

  it('rejects missing, blank, or non-string tasks with an explicit message', () => {
    for (const payload of [undefined, null, {}, { task: '' }, { task: 42 }, { task: '   ' }]) {
      const parsed = parseInlineAgentSubagentSpawnPayload(payload);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects a malformed allowlist hint but accepts unknown hint names (engine ignores them, R10)', () => {
    expect(parseInlineAgentSubagentSpawnPayload({ task: 'x', toolAllowlistHint: 'web_search' }).ok).toBe(false);
    expect(
      parseInlineAgentSubagentSpawnPayload({ task: 'x', toolAllowlistHint: [1] }).ok,
    ).toBe(false);
    const parsed = parseInlineAgentSubagentSpawnPayload({
      task: 'x',
      toolAllowlistHint: ['not_a_real_tool'],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('spawn result to tool-result mapping (M4 wiring note 4)', () => {
  it('maps a refusal to a failed result carrying the model-visible message', () => {
    const described = describeInlineAgentSubagentSpawnResult('en', {
      ok: false,
      refused: true,
      code: 'subagent_concurrency_cap',
      message: 'Subagent concurrency cap reached (2 child runs are already executing).',
    });
    expect(described.ok).toBe(false);
    expect(described.summary).toContain('concurrency cap');
    expect(described.error?.code).toBe('subagent_concurrency_cap');
    expect(described.error?.retryable).toBe(true);
  });

  it('maps a completed outcome to the child final text', () => {
    const described = describeInlineAgentSubagentSpawnResult('en', {
      ok: true,
      refused: false,
      childTraceId: 'subagent:t:1',
      childLoopId: 'subagent:l:1',
      status: 'complete',
      finalText: 'The answer from the child run.',
      totalSteps: 2,
      totalTools: 1,
      deadlineExceeded: false,
    });
    expect(described.ok).toBe(true);
    expect(described.summary).toBe('The answer from the child run.');
    expect(described.error).toBeUndefined();
  });

  it('maps failed outcomes to the honest failure reason plus a status detail', () => {
    for (const status of ['error', 'stopping'] as const) {
      const described = describeInlineAgentSubagentSpawnResult('en', {
        ok: false,
        refused: false,
        childTraceId: 'subagent:t:1',
        childLoopId: 'subagent:l:1',
        status,
        finalText: '',
        totalSteps: 1,
        totalTools: 0,
        error: 'child failed to stream',
        deadlineExceeded: status === 'stopping',
      });
      expect(described.ok).toBe(false);
      expect(described.summary).toBe('child failed to stream');
      expect(described.detail).toContain('1');
      expect(described.error?.retryable).toBe(status !== 'stopping');
    }
  });

  it('never produces an empty summary (an honest fallback, never silence)', () => {
    const described = describeInlineAgentSubagentSpawnResult('en', {
      ok: true,
      refused: false,
      childTraceId: 'subagent:t:1',
      childLoopId: 'subagent:l:1',
      status: 'complete',
      finalText: '',
      totalSteps: 1,
      totalTools: 0,
      deadlineExceeded: false,
    });
    expect(described.ok).toBe(true);
    expect(described.summary.length).toBeGreaterThan(0);
  });
});

describe('M5 wiring seams (source contracts, content entrypoint pattern)', () => {
  const contentSource = readFileSync('entrypoints/content.ts', 'utf8');
  const handlersSource = readFileSync(
    'entrypoints/background/tool-execution-handlers.ts',
    'utf8',
  );
  const compositionSource = readFileSync(
    'entrypoints/background/tool-provider-composition.ts',
    'utf8',
  );
  const adapterSource = readFileSync(
    'core/inline-agent/pi/loop-adapter.ts',
    'utf8',
  );

  it('registers the descriptor into the parent loop payload via the shared helper', () => {
    expect(contentSource).toMatch(
      /toolDescriptors:\s*withInlineAgentSubagentSpawnDescriptor\(\s*selectContinuableToolDescriptors\(/,
    );
  });

  it('creates ONE runner per parent run with the parent loop abort signal', () => {
    expect(contentSource).toContain('createInlineAgentSubagentRunner({');
    const runnerBlock = contentSource.split('createInlineAgentSubagentRunner({')[1] ?? '';
    expect(runnerBlock).toContain('signal: abort.signal');
    expect(runnerBlock).toContain('executeTool,');
    expect(runnerBlock).toContain('post:');
  });

  it('routes spawn calls through the runner inside the authorized executeTool closure', () => {
    expect(contentSource).toContain('isInlineAgentSubagentSpawnCall(call)');
    expect(contentSource).toContain('runner.spawn(');
  });

  it('reads the live chain anchor through the minimal sessionRef accessor', () => {
    expect(adapterSource).toContain('sessionRef');
    expect(contentSource).toContain('sessionRef.current?.parentMessageId');
  });

  it('merges the agent-only descriptor into agent-run grants in the background handler', () => {
    expect(handlersSource).toContain('withInlineAgentSubagentSpawnDescriptor');
    expect(handlersSource).toMatch(/trigger === 'agent_run'/);
  });

  it('never adds the spawn tool to the shared prompt catalog (prompt bytes unchanged)', () => {
    expect(compositionSource).not.toContain('inline_agent');
    expect(compositionSource).not.toContain('subagent');
  });
});

describe('M5 chain-anchor accessor (M4 wiring note 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  it('exposes the parent loop LIVE session anchor through the minimal sessionRef port', async () => {
    const { runInlineAgentLoop } = await import('../core/inline-agent/loop');

    adapterMocks.submitPromptStreaming.mockImplementation(
      async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('parent turn done.');
        return { assistantText: '', responseMessageId: 555, requestMessageId: 554, finished: true };
      },
    );

    const sessionRef: { current: DeepSeekSessionState | null } = { current: null };
    await runInlineAgentLoop(
      {
        loopId: 'loop-anchor',
        chatSessionId: 'chat-1',
        parentMessageId: 100,
        originalPrompt: 'parent task',
        agentTaskPrompt: 'parent task',
        toolExecutions: [],
        promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
        toolDescriptors: [],
      },
      {
        post: () => {},
        executeTool: async () => {
          throw new Error('this loop has no tools');
        },
        signal: new AbortController().signal,
        sessionRef,
      },
    );

    // The accessor is the LIVE anchor: the session advanced from the static
    // payload anchor (100) to the completed turn's response id (555) — the id
    // a spawn call must hand the engine as its chainParentMessageId.
    expect(sessionRef.current).not.toBeNull();
    expect(sessionRef.current?.parentMessageId).toBe(555);
  });
});
