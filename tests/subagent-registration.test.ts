import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withInlineAgentSubagentSpawnDescriptor,
  isInlineAgentSubagentSpawnCall,
  parseInlineAgentSubagentSpawnPayload,
  describeInlineAgentSubagentSpawnResult,
  claimInlineAgentSubagentSpawnCall,
} from '../core/inline-agent/subagent-tool';
import { deriveChildToolDescriptors } from '../core/inline-agent/subagent';
import { translate } from '../core/i18n/background';
import type { DeepSeekSessionState } from '../core/inline-agent/pi/stream-fn-port';
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
const { runInlineAgentLoop } = await import('../core/inline-agent/loop');
const { createInlineAgentTraceStore } = await import('../core/inline-agent/trace-store');

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

  it('matches a toolAllowlistHint against the ADVERTISED invocation-name set, not the raw field', () => {
    // Hint identity fix (spawn-quality diagnosis §4.1): every MCP-origin
    // descriptor's raw `invocationName` is the prefixed form
    // `mcp_<sanitized-serverId>_<toolName>` while the model is only ever
    // shown the advertised short `name` (unique across the catalog). A hint
    // like `shell_exec` must therefore select the MCP-shaped descriptor —
    // matching only the raw field silently emptied every hint-narrowed child.
    const mcpShaped: ToolDescriptor = {
      ...descriptor('mcp_shell_local_shell_exec'),
      name: 'shell_exec',
    };
    const pool = [mcpShaped, descriptor('web_search')];

    // Hint by the ADVERTISED short name selects the MCP-shaped descriptor.
    expect(
      deriveChildToolDescriptors(pool, ['shell_exec']).map((item) => item.name),
    ).toEqual(['shell_exec']);
    // Hint by the raw invocation name still selects it (both are legal).
    expect(
      deriveChildToolDescriptors(pool, ['mcp_shell_local_shell_exec']).map((item) => item.name),
    ).toEqual(['shell_exec']);
    // Unknown hint names are still ignored (least privilege) — only the
    // unknown ones: a partially-known hint narrows to what it names.
    expect(deriveChildToolDescriptors(pool, ['shell_exec', 'no_such_tool'])).toHaveLength(1);
    // A hint naming nothing real still yields an empty set (unchanged).
    expect(deriveChildToolDescriptors(pool, ['no_such_tool'])).toEqual([]);
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

describe('spawn call identity claiming (one-time per-run claim, review fix 2)', () => {
  it('claims a call id exactly once and refuses a replayed id with the id in the message', () => {
    const claimed = new Set<string>();
    expect(claimInlineAgentSubagentSpawnCall(claimed, 'call-1')).toEqual({
      ok: true,
      callId: 'call-1',
    });

    const replay = claimInlineAgentSubagentSpawnCall(claimed, 'call-1');
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.message).toContain('call-1');
    // The refused replay did not double-claim.
    expect(claimed.size).toBe(1);

    expect(claimInlineAgentSubagentSpawnCall(claimed, 'call-2')).toEqual({
      ok: true,
      callId: 'call-2',
    });
    expect(claimed.size).toBe(2);
  });

  it('fails closed on a missing call id without mutating the claim set', () => {
    const claimed = new Set<string>();
    const result = claimInlineAgentSubagentSpawnCall(claimed, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    expect(claimed.size).toBe(0);
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

  it('consumes the task_complete signal: the body IS the deliverable, stated once', () => {
    const described = describeInlineAgentSubagentSpawnResult('en', {
      ok: true,
      refused: false,
      childTraceId: 'subagent:t:1',
      childLoopId: 'subagent:l:1',
      status: 'complete',
      finalText: [
        'Soft rain on the roof',
        'Grey clouds fold over the hills',
        'Petals drink and shine',
        '',
        '<task_complete>{"summary":"Wrote a single 5-7-5 haiku about rain."}</task_complete>',
      ].join('\n'),
      totalSteps: 1,
      totalTools: 0,
      deadlineExceeded: false,
    });
    expect(described.ok).toBe(true);
    expect(described.summary).not.toContain('<task_complete>');
    expect(described.summary).not.toContain('</task_complete>');
    expect(described.summary).not.toContain('"summary"');
    // Deliverable-once contract (corrected 2026-09-19): the body text is what
    // the child actually answered, so it IS the deliverable; the machine
    // summary is metadata and must neither replace it nor be appended after
    // it. The summary alone is only the fallback for a wrapper-only final
    // text (children taught to put the deliverable in the summary).
    expect(described.summary).toContain('Soft rain on the roof');
    expect(described.summary).toContain('Petals drink and shine');
    expect(described.summary).not.toContain('Wrote a single 5-7-5 haiku about rain.');
  });

  it('maps the four captured gate-run limerick children to their poem text, not the meta-summary', () => {
    // Verbatim child finalText rows from the live G2 failure storage
    // (chrome.storage.local dpp_inline_agent_traces, 2026-09-19 05:12-05:14
    // local): body deliverable plus a taught task_complete marker whose
    // summary is meta-prose. The mapping must surface the poem.
    const captured = [
      {
        id: 'subagent:tp7kgp:1',
        finalText:
          'A gate that creaks in the evening breeze,\nStill holds the world it cannot seize.\n\n<task_complete>{"summary":"Wrote a two-line limerick about gates"}</task_complete>',
      },
      {
        id: 'subagent:tp7kgp:2',
        finalText:
          "A gate that was rusty and old,\nLet nobody through, so I'm told.\n\n<task_complete>{\"summary\":\"Delivered a two-line limerick about gates\"}</task_complete>",
      },
      {
        id: 'subagent:w88m8t:1',
        finalText:
          'A gate that squeaks on its rusted old hinge,\nWill summon a neighbor to lecture and whinge.\n\n<task_complete>{"summary":"Wrote a two-line limerick about gates."}</task_complete>',
      },
      {
        id: 'subagent:w88m8t:2',
        finalText:
          'A gate that swings open with a creak,\nLets in all the wanderers who seek.\n\n<task_complete>{"summary":"Wrote a two-line limerick about gates and output only the limerick."}</task_complete>',
      },
    ];
    for (const row of captured) {
      const described = describeInlineAgentSubagentSpawnResult('en', {
        ok: true,
        refused: false,
        childTraceId: row.id,
        childLoopId: row.id,
        status: 'complete',
        finalText: row.finalText,
        totalSteps: 1,
        totalTools: 0,
        deadlineExceeded: false,
      });
      expect(described.ok).toBe(true);
      expect(described.summary).toContain('A gate that');
      expect(described.summary).not.toContain('Wrote a two-line limerick');
      expect(described.summary).not.toContain('Delivered a two-line limerick');
      expect(described.summary).not.toContain('<task_complete>');
    }
  });

  it('a wrapper-only final text becomes the clean summary deliverable', () => {
    const described = describeInlineAgentSubagentSpawnResult('en', {
      ok: true,
      refused: false,
      childTraceId: 'subagent:t:1',
      childLoopId: 'subagent:l:1',
      status: 'complete',
      finalText: '<task_complete>{"summary":"Sorted the ledger and saved it."}</task_complete>',
      totalSteps: 2,
      totalTools: 1,
      deadlineExceeded: false,
    });
    expect(described.ok).toBe(true);
    expect(described.summary).toBe('Sorted the ledger and saved it.');
  });

  it('a wrapper without a summary falls back to the text minus the wrapper', () => {
    const described = describeInlineAgentSubagentSpawnResult('en', {
      ok: true,
      refused: false,
      childTraceId: 'subagent:t:1',
      childLoopId: 'subagent:l:1',
      status: 'complete',
      finalText: 'The ledger is sorted.\n<task_complete>{"artifacts":[]}</task_complete>',
      totalSteps: 1,
      totalTools: 0,
      deadlineExceeded: false,
    });
    expect(described.ok).toBe(true);
    expect(described.summary).not.toContain('<task_complete>');
    expect(described.summary).toContain('The ledger is sorted.');
  });

  it('a malformed wrapper strips the tags and keeps the inner text', () => {
    const described = describeInlineAgentSubagentSpawnResult('en', {
      ok: true,
      refused: false,
      childTraceId: 'subagent:t:1',
      childLoopId: 'subagent:l:1',
      status: 'complete',
      finalText: 'Draft one.\n<task_complete>not json</task_complete>',
      totalSteps: 1,
      totalTools: 0,
      deadlineExceeded: false,
    });
    expect(described.ok).toBe(true);
    expect(described.summary).not.toContain('<task_complete>');
    expect(described.summary).toContain('Draft one.');
    expect(described.summary).toContain('not json');
  });

  it('a final text without any wrapper passes through unchanged', () => {
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

  it('requests the loop grant over the FULL turn catalog via the shared spawn helper', () => {
    expect(contentSource).toMatch(
      /toolDescriptors:\s*withInlineAgentSubagentSpawnDescriptor\(\s*authorization\.descriptors,\s*\),/,
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

  it('maps detected spawn rows FIFO so two spawns in one step keep their own rows (review fix 1)', () => {
    // Detection collects rows in call order; the executor claims them in the
    // SAME order pi executes calls (sequential). A single overwritten slot
    // would mis-map the first child and drop the second.
    expect(contentSource).toMatch(/const pendingAgentSpawnRows: HTMLElement\[\] = \[\]/);
    expect(contentSource).toContain('pendingAgentSpawnRows.push(row)');
    expect(contentSource).toContain('pendingAgentSpawnRows.shift()');
  });

  it('guards the spawn-row slot clears against supersede clobber (final review fix 1)', () => {
    // The spawning-row slot is module-level: a stale run's executor (or a
    // stale child's first console mount) settling inside the teardown grace
    // AFTER a fresh loop claimed the slot must not null the fresh claim.
    // Both race-prone clears must compare the slot against the row they own
    // before clearing; the parent-run lifecycle reset stays bare on purpose
    // (it wipes ALL child-console bookkeeping for the run together).
    expect(contentSource).toMatch(
      /if \(inlineAgentSpawningRow === spawnRow\) inlineAgentSpawningRow = null;/,
    );
    expect(contentSource).toMatch(
      /if \(inlineAgentSpawningRow === claimedRow\) inlineAgentSpawningRow = null;/,
    );
    // No bare unconditional clear outside the lifecycle reset: strip the
    // guarded lines first so the guarded form cannot trip the negative scan.
    const stripped = contentSource.replace(
      /^\s*if \(inlineAgentSpawningRow === \w+\) inlineAgentSpawningRow = null;.*$/gm,
      '',
    );
    const bareClearLines = stripped
      .split('\n')
      .filter((line) => line.includes('inlineAgentSpawningRow = null;'));
    expect(bareClearLines).toHaveLength(1);
    const resetBody =
      contentSource.split('function resetInlineAgentChildConsoleState')[1]?.split('\n}')[0] ?? '';
    expect(resetBody).toContain('inlineAgentSpawningRow = null;');
    expect(bareClearLines[0]).toBe(
      resetBody
        .split('\n')
        .find((line) => line.includes('inlineAgentSpawningRow = null;')),
    );
  });

  it('binds spawn calls to request identity and claims the id BEFORE runner.spawn (review fix 2)', () => {
    const executorBlock =
      contentSource.split('async function executeInlineAgentSubagentSpawn')[1] ?? '';
    expect(executorBlock).toContain('ensureToolCallId(');
    expect(executorBlock).toContain('"agent_run"');
    const claimIndex = executorBlock.indexOf('claimInlineAgentSubagentSpawnCall(');
    const spawnIndex = executorBlock.indexOf('runner.spawn(');
    expect(claimIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(claimIndex);
    // The claim set is per-run state owned by startInlineAgentLoop.
    expect(contentSource).toMatch(/const claimedSpawnCallIds = new Set<string>\(\)/);
  });

  it('reads the live chain anchor through the minimal sessionRef accessor', () => {
    expect(adapterSource).toContain('sessionRef');
    expect(contentSource).toContain('sessionRef.current?.parentMessageId');
  });

  it('merges the spawn descriptor into agent-run AND manual_chat grants in the background handler', () => {
    expect(handlersSource).toContain('withInlineAgentSubagentSpawnDescriptor');
    // First-turn subagent access (pc directive): manual_chat grants merge the
    // spawn descriptor too, so the FIRST turn's prompt advertises it and the
    // native-turn parser recognizes it. The shared prompt CATALOG sources stay
    // untouched — only the grant-time merge widens.
    expect(handlersSource).toMatch(
      /payload\.trigger === 'agent_run'\s*\|\|\s*payload\.trigger === 'manual_chat'/,
    );
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

describe('E2E advertisement + spawn flow (uniform-tools task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('advertises subagent_spawn on the loop turn, executes the emitted spawn through the authorized runner, and resolves the parent tool result with the child outcome', async () => {
    vi.useFakeTimers();
    // Wire choreography over ONE mocked DS adapter, in call order:
    //   request 1 — parent turn 1: streams the spawn XML (the model saw the
    //               advertised `### Tool subagent_spawn` section).
    //   request 2 — child turn 1: streams the child's final answer.
    //   request 3 — parent turn 2: streams the parent's final answer.
    adapterMocks.submitPromptStreaming
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('<subagent_spawn>{"task":"Summarize the report"}</subagent_spawn>');
        return { assistantText: '', responseMessageId: 102, requestMessageId: 101, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('child final answer.');
        return { assistantText: '', responseMessageId: 202, requestMessageId: 201, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('Parent done with the child outcome.');
        return { assistantText: '', responseMessageId: 104, requestMessageId: 103, finished: true };
      });

    // The loop payload's descriptor set mirrors content.ts: the full catalog
    // (shell_exec included) plus spawn, from the shared helper.
    const loopDescriptors = withInlineAgentSubagentSpawnDescriptor([
      descriptor('web_search'),
      descriptor('shell_exec'),
      descriptor('artifact_create'),
    ]);
    const store = createInlineAgentTraceStore(createMemorySlot({ present: false }));
    const controller = new AbortController();
    const sessionRef: { current: DeepSeekSessionState | null } = { current: null };
    const claimedSpawnCallIds = new Set<string>();
    const events: Array<{ type: string; data: unknown }> = [];

    // Child execution path (the content.ts authorized executor shape):
    // non-spawn calls fall through to the grant path; spawn calls parse →
    // claim → runner.spawn → describe, exactly like the released executor.
    const backgroundExecuteTool = vi.fn(async (call: { name: string }) => {
      throw new Error(`unexpected non-spawn call reached the grant path: ${call.name}`);
    });
    const runner = createInlineAgentSubagentRunner({
      parentTraceId: 'trace-4',
      parentLoopId: 'loop-4',
      chatSessionId: 'chat-1',
      traceUrl: 'https://chat.deepseek.com/a/chat/s/chat-1',
      promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
      toolDescriptors: loopDescriptors,
      executeTool: backgroundExecuteTool,
      signal: controller.signal,
      upsertTrace: (trace) => store.upsert(trace),
      locale: 'en',
    });
    const executeTool = vi.fn(async (call: {
      id?: string;
      name: string;
      invocationName?: string;
      payload: unknown;
      source?: { trigger?: string };
    }) => {
      if (!isInlineAgentSubagentSpawnCall(call)) return backgroundExecuteTool(call);
      const parsed = parseInlineAgentSubagentSpawnPayload(call.payload);
      if (!parsed.ok) {
        return {
          name: call.name,
          result: {
            ok: false,
            summary: parsed.message,
            error: { code: 'subagent_payload_invalid' as const, message: parsed.message, retryable: true },
          },
        };
      }
      const claim = claimInlineAgentSubagentSpawnCall(claimedSpawnCallIds, call.id ?? '');
      if (!claim.ok) {
        return {
          name: call.name,
          result: {
            ok: false,
            summary: claim.message,
            error: { code: 'subagent_call_replayed' as const, message: claim.message, retryable: false },
          },
        };
      }
      const spawnResult = await runner.spawn({
        payload: parsed.payload,
        chainParentMessageId: sessionRef.current?.parentMessageId ?? 100,
      });
      const described = describeInlineAgentSubagentSpawnResult('en', spawnResult);
      return {
        name: call.name,
        result: {
          ok: described.ok,
          summary: described.summary,
          detail: described.detail,
          error: described.error,
        },
      };
    });

    const run = runInlineAgentLoop(
      {
        loopId: 'loop-4',
        chatSessionId: 'chat-1',
        parentMessageId: 100,
        originalPrompt: 'Parent task needing a subagent.',
        agentTaskPrompt: 'Parent task needing a subagent.',
        toolExecutions: [],
        promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
        toolDescriptors: loopDescriptors,
        locale: 'en',
      },
      {
        post: (type, data) => {
          events.push({ type, data });
        },
        executeTool,
        signal: controller.signal,
        sessionRef,
      },
    );
    // Covers the spawn execution, the child loop, and the parent's paced
    // continuation request (max 6.5s); far below the child's 180s deadline.
    await vi.advanceTimersByTimeAsync(7_000);
    await run;

    // 1. ADVERTISEMENT: the parent's first loop request — the one the model
    // answered with the spawn call — carried the tool schema section in the
    // first-turn '### Tool' wire format, spawn included (task 1 widened the
    // set to the full catalog: shell_exec rides along).
    const calls = adapterMocks.submitPromptStreaming.mock.calls;
    expect(calls).toHaveLength(3); // parent turn 1 → child turn → parent turn 2
    const parentFirstPrompt = String((calls[0]?.[0] as { prompt?: string }).prompt ?? '');
    expect(parentFirstPrompt).toContain('### Tool subagent_spawn');
    expect(parentFirstPrompt).toContain('### Tool shell_exec');
    expect(parentFirstPrompt).toContain('<subagent_spawn>');
    // 2. DEPTH SEAM IN THE ADVERTISEMENT: the child's own loop request (call
    // 2) renders the derived (spawn-free) catalog — children never see spawn.
    const childPrompt = String((calls[1]?.[0] as { prompt?: string }).prompt ?? '');
    expect(childPrompt).toContain('### Tool web_search');
    expect(childPrompt).not.toContain('subagent_spawn');
    // The parent's continuation after the child outcome advertises again.
    const parentSecondPrompt = String((calls[2]?.[0] as { prompt?: string }).prompt ?? '');
    expect(parentSecondPrompt).toContain('### Tool subagent_spawn');

    // 3. PARSE + EXECUTE: the spawn call reached the authorized path bound to
    // the agent-run trigger, and the claim set consumed exactly one id.
    expect(executeTool).toHaveBeenCalledTimes(1);
    const spawnCall = executeTool.mock.calls[0]?.[0] as {
      name: string;
      payload: { task: string };
      source?: { trigger?: string };
    };
    expect(spawnCall.name).toBe('subagent_spawn');
    expect(spawnCall.payload).toEqual({ task: 'Summarize the report' });
    expect(spawnCall.source?.trigger).toBe('agent_run');
    expect(claimedSpawnCallIds.size).toBe(1);
    expect(backgroundExecuteTool).not.toHaveBeenCalled();

    // 4. CHILD OUTCOME → PARENT TOOL RESULT: the parent's recorded spawn
    // execution carries the child's final answer as its summary, and the
    // child trace closed honestly as complete.
    const stepComplete = events.find((event) => event.type === 'AGENT_STEP_COMPLETE') as
      | { data: { toolExecutions: Array<{ name: string; result: { ok: boolean; summary: string } }> } }
      | undefined;
    expect(stepComplete).toBeDefined();
    const spawnRecord = stepComplete!.data.toolExecutions.find((record) => record.name === 'subagent_spawn');
    expect(spawnRecord).toBeDefined();
    expect(spawnRecord!.result.ok).toBe(true);
    expect(spawnRecord!.result.summary).toBe('child final answer.');
    const rows = await store.read();
    const childRow = rows.find((row) => row.parentTraceId === 'trace-4');
    expect(childRow).toBeDefined();
    expect(childRow).toMatchObject({ status: 'complete', finalText: 'child final answer.' });

    // 5. PARENT RESOLUTION: the loop completed with the post-spawn turn.
    expect(events.some((event) => event.type === 'AGENT_LOOP_COMPLETE')).toBe(true);
    expect(events.some((event) => event.type === 'AGENT_LOOP_ERROR')).toBe(false);
  });

  it('frames a child run with the dedicated subagent task prompt, not the continuation template', async () => {
    vi.useFakeTimers();
    // Child framing (spawn-quality diagnosis §4.2): the child's FIRST request
    // must establish subagent identity + the deliverable contract and must
    // NOT assert the false "tool results just executed" premise with a
    // literal `<tool_results> []`. The SECOND request (after a real tool
    // call) keeps the released continuation template.
    adapterMocks.submitPromptStreaming
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('<subagent_spawn>{"task":"Reply with exactly one word: banana"}</subagent_spawn>');
        return { assistantText: '', responseMessageId: 102, requestMessageId: 101, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('<shell_exec>{"command":"echo hi"}</shell_exec>');
        return { assistantText: '', responseMessageId: 202, requestMessageId: 201, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('banana');
        return { assistantText: '', responseMessageId: 203, requestMessageId: 204, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('Parent done.');
        return { assistantText: '', responseMessageId: 104, requestMessageId: 103, finished: true };
      });

    const loopDescriptors = withInlineAgentSubagentSpawnDescriptor([
      descriptor('web_search'),
      descriptor('shell_exec'),
    ]);
    const store = createInlineAgentTraceStore(createMemorySlot({ present: false }));
    const controller = new AbortController();
    const sessionRef: { current: DeepSeekSessionState | null } = { current: null };
    const claimedSpawnCallIds = new Set<string>();
    // The child's own tool execution path: the derived (spawn-free) catalog
    // executes shell_exec normally.
    const backgroundExecuteTool = vi.fn(async (_call: { name: string }) => ({
      name: 'shell_exec',
      result: { ok: true, summary: 'hi' },
    }));
    const runner = createInlineAgentSubagentRunner({
      parentTraceId: 'trace-task',
      parentLoopId: 'loop-task',
      chatSessionId: 'chat-1',
      traceUrl: 'https://chat.deepseek.com/a/chat/s/chat-1',
      promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
      toolDescriptors: loopDescriptors,
      executeTool: backgroundExecuteTool,
      signal: controller.signal,
      upsertTrace: (trace) => store.upsert(trace),
      locale: 'en',
    });
    const executeTool = vi.fn(async (call: {
      id?: string;
      name: string;
      payload: unknown;
    }) => {
      if (!isInlineAgentSubagentSpawnCall(call)) return backgroundExecuteTool(call);
      const parsed = parseInlineAgentSubagentSpawnPayload(call.payload);
      if (!parsed.ok) throw new Error('payload must parse in this test');
      const claim = claimInlineAgentSubagentSpawnCall(claimedSpawnCallIds, call.id ?? '');
      if (!claim.ok) throw new Error('claim must succeed in this test');
      const spawnResult = await runner.spawn({
        payload: parsed.payload,
        chainParentMessageId: sessionRef.current?.parentMessageId ?? 100,
      });
      const described = describeInlineAgentSubagentSpawnResult('en', spawnResult);
      return {
        name: call.name,
        result: {
          ok: described.ok,
          summary: described.summary,
          detail: described.detail,
          error: described.error,
        },
      };
    });

    const run = runInlineAgentLoop(
      {
        loopId: 'loop-task',
        chatSessionId: 'chat-1',
        parentMessageId: 100,
        originalPrompt: 'Parent task needing a subagent.',
        agentTaskPrompt: 'Parent task needing a subagent.',
        toolExecutions: [],
        promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
        toolDescriptors: loopDescriptors,
        locale: 'en',
      },
      {
        post: () => {},
        executeTool,
        signal: controller.signal,
        sessionRef,
      },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await run;

    const calls = adapterMocks.submitPromptStreaming.mock.calls;
    expect(calls).toHaveLength(4); // parent → child turn 1 → child turn 2 → parent
    const childFirstPrompt = String((calls[1]?.[0] as { prompt?: string }).prompt ?? '');
    const childSecondPrompt = String((calls[2]?.[0] as { prompt?: string }).prompt ?? '');

    // FIRST child request: dedicated subagent framing.
    expect(childFirstPrompt).toContain('You are a subagent spawned to complete a specific task.');
    expect(childFirstPrompt).toContain('final deliverable');
    expect(childFirstPrompt).toContain('<original_task>');
    expect(childFirstPrompt).toContain('Reply with exactly one word: banana');
    // The false premise is gone: no empty tool_results, no continuation claim.
    expect(childFirstPrompt).not.toContain('<tool_results>');
    expect(childFirstPrompt).not.toContain('tool results just executed');
    // The child still sees its tool schemas on the first request.
    expect(childFirstPrompt).toContain('### Tool shell_exec');
    // Detector safety: the child's first turn stays an internal turn.
    const { isInlineAgentContinuationStructure } = await import('../core/inline-agent/prompt');
    expect(isInlineAgentContinuationStructure(childFirstPrompt)).toBe(true);

    // SECOND child request (after the real tool call): the released
    // continuation template is back, carrying the shell_exec result.
    expect(childSecondPrompt).toContain('tool results just executed');
    expect(childSecondPrompt).toContain('<tool_results>');
    expect(childSecondPrompt).toContain('shell_exec');

    // The child's deliverable finalized as its final text, verbatim.
    const rows = await store.read();
    const childRow = rows.find((row) => row.parentTraceId === 'trace-task');
    expect(childRow).toMatchObject({ status: 'complete', finalText: 'banana' });
  });
});
describe('first-turn subagent_spawn (native-turn deferral, pc directive 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const firstTurnSpawnCall = {
    id: 'spawn-first-turn-1',
    name: 'subagent_spawn',
    invocationName: 'subagent_spawn',
    payload: { task: 'First-turn subagent task' },
    raw: '<subagent_spawn>{"task":"First-turn subagent task"}</subagent_spawn>',
  } as never;

  it('the loop adapter executes a deferred first-turn spawn as STEP 0 through executeTool BEFORE the first model request', async () => {
    vi.useFakeTimers();
    // Wire choreography: the spawn's CHILD request must be the FIRST model
    // request (the spawn executed pre-engine), the parent continuation second.
    adapterMocks.submitPromptStreaming
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('child first-turn answer.');
        return { assistantText: '', responseMessageId: 202, requestMessageId: 201, finished: true };
      })
      .mockImplementationOnce(async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('Parent saw the child outcome and finished.');
        return { assistantText: '', responseMessageId: 104, requestMessageId: 103, finished: true };
      });

    const timeline: string[] = [];
    const events: Array<{ type: string; data: unknown }> = [];
    const executedCalls: Array<{ name: string; payload: unknown; source?: { trigger?: string } }> = [];
    const runner = createInlineAgentSubagentRunner({
      parentTraceId: 'trace-ft',
      parentLoopId: 'loop-ft',
      chatSessionId: 'chat-1',
      traceUrl: 'https://chat.deepseek.com/a/chat/s/chat-1',
      promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
      toolDescriptors: [descriptor('web_search')],
      executeTool: async () => {
        throw new Error('no non-spawn tools in this test');
      },
      signal: new AbortController().signal,
      upsertTrace: async () => {},
      locale: 'en',
    });
    const claimedSpawnCallIds = new Set<string>();
    const sessionRef: { current: DeepSeekSessionState | null } = { current: null };
    const executeTool = vi.fn(async (call: {
      id?: string;
      name: string;
      invocationName?: string;
      payload: unknown;
    }) => {
      if (!isInlineAgentSubagentSpawnCall(call)) throw new Error(`unexpected call ${call.name}`);
      const parsed = parseInlineAgentSubagentSpawnPayload(call.payload);
      if (!parsed.ok) throw new Error('payload must parse in this test');
      const claim = claimInlineAgentSubagentSpawnCall(claimedSpawnCallIds, call.id ?? '');
      if (!claim.ok) throw new Error('claim must succeed in this test');
      timeline.push(`execute:${call.name}`);
      const spawnResult = await runner.spawn({
        payload: parsed.payload,
        chainParentMessageId: sessionRef.current?.parentMessageId ?? 100,
      });
      const described = describeInlineAgentSubagentSpawnResult('en', spawnResult);
      executedCalls.push(call);
      return {
        name: call.name,
        result: {
          ok: described.ok,
          summary: described.summary,
          detail: described.detail,
          error: described.error,
        },
      };
    });

    const run = runInlineAgentLoop(
      {
        loopId: 'loop-ft',
        chatSessionId: 'chat-1',
        parentMessageId: 100,
        originalPrompt: 'Do you have subagent access?',
        agentTaskPrompt: 'Do you have subagent access?',
        toolExecutions: [],
        promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
        toolDescriptors: withInlineAgentSubagentSpawnDescriptor([descriptor('web_search')]),
        locale: 'en',
        // The deferral channel: content.ts parsed the spawn call on the
        // NATIVE trigger turn and hands it to the loop instead of executing
        // it outside the authorized agent_run path.
        firstTurnSpawnCalls: [firstTurnSpawnCall],
      } as Parameters<typeof runInlineAgentLoop>[0],
      {
        post: (type, data) => {
          events.push({ type, data });
          timeline.push(type);
        },
        executeTool,
        signal: new AbortController().signal,
        sessionRef,
      },
    );
    await vi.advanceTimersByTimeAsync(7_000);
    await run;

    // 1. STEP-0 EXECUTION ORDER: the spawn ran through the loop's authorized
    // executor BEFORE any parent model request (the child request is the
    // first submitPromptStreaming call, triggered INSIDE executeTool).
    expect(executedCalls).toHaveLength(1);
    expect(timeline[0]).toBe('AGENT_STEP_STARTED');
    expect(timeline.indexOf('execute:subagent_spawn')).toBeGreaterThan(-1);
    expect(timeline.indexOf('execute:subagent_spawn')).toBeLessThan(timeline.indexOf('AGENT_STEP_COMPLETE'));
    expect(adapterMocks.submitPromptStreaming.mock.calls).toHaveLength(2);
    const stepStarted = events.filter((event) => event.type === 'AGENT_STEP_STARTED') as
      Array<{ data: { stepIndex: number } }>;
    expect(stepStarted[0]?.data.stepIndex).toBe(0);
    const toolDetected = events.find((event) => event.type === 'AGENT_TOOL_DETECTED') as
      | { data: { stepIndex: number; call: { name: string } } }
      | undefined;
    expect(toolDetected?.data.stepIndex).toBe(0);
    expect(toolDetected?.data.call.name).toBe('subagent_spawn');

    // 2. THE MODEL SEES THE CHILD OUTCOME: the step completed with the spawn
    // record before the parent's continuation request, and that request's
    // prompt embeds the child answer as the tool result.
    const stepComplete = events.filter((event) => event.type === 'AGENT_STEP_COMPLETE') as
      Array<{ data: { stepIndex: number; toolExecutions: Array<{ name: string; result: { ok: boolean; summary: string } }> } }>;
    const seedStep = stepComplete.find((event) => event.data.stepIndex === 0);
    expect(seedStep).toBeDefined();
    expect(seedStep!.data.toolExecutions).toHaveLength(1);
    expect(seedStep!.data.toolExecutions[0]?.name).toBe('subagent_spawn');
    expect(seedStep!.data.toolExecutions[0]?.result.summary).toBe('child first-turn answer.');

    const parentPrompt = String(
      (adapterMocks.submitPromptStreaming.mock.calls[1]?.[0] as { prompt?: string }).prompt ?? '',
    );
    expect(parentPrompt).toContain('child first-turn answer.');

    // 3. AUTHORIZED PATH ONLY: the call reached executeTool bound to the run
    // (the executor rewrites the source to agent_run); the loop completed.
    expect(claimedSpawnCallIds).toEqual(new Set(['spawn-first-turn-1']));
    expect(events.some((event) => event.type === 'AGENT_LOOP_COMPLETE')).toBe(true);
    const loopComplete = events.find((event) => event.type === 'AGENT_LOOP_COMPLETE') as
      | { data: { totalTools: number } }
      | undefined;
    expect(loopComplete?.data.totalTools).toBe(1);
  });

  it('the loop adapter runs its normal engine flow untouched when no first-turn spawn calls are deferred (protocol golden safety)', async () => {
    vi.useFakeTimers();
    adapterMocks.submitPromptStreaming.mockImplementation(
      async (_input: unknown, handlers: { onTextChunk: (t: string) => void }) => {
        handlers.onTextChunk('plain final answer.');
        return { assistantText: '', responseMessageId: 55, requestMessageId: 54, finished: true };
      },
    );
    const events: Array<{ type: string; data: unknown }> = [];
    const executeTool = vi.fn(async () => {
      throw new Error('no tool calls expected');
    });
    const run = runInlineAgentLoop(
      {
        loopId: 'loop-no-seeds',
        chatSessionId: 'chat-1',
        parentMessageId: 100,
        originalPrompt: 'plain task',
        agentTaskPrompt: 'plain task',
        toolExecutions: [],
        promptOptions: { modelType: null, searchEnabled: false, thinkingEnabled: false, refFileIds: [] },
        toolDescriptors: [],
        locale: 'en',
      },
      {
        post: (type, data) => events.push({ type, data }),
        executeTool,
        signal: new AbortController().signal,
      },
    );
    await vi.advanceTimersByTimeAsync(7_000);
    await run;

    expect(executeTool).not.toHaveBeenCalled();
    // No synthetic step-0: the first STEP_STARTED is the engine's own first
    // turn (no preceding seed step), no tool was detected, and the final
    // STEP_COMPLETE carries zero tool executions (text-only resolution).
    const firstEvent = events[0] as { type: string } | undefined;
    expect(firstEvent?.type).toBe('AGENT_STEP_STARTED');
    expect(events.some((event) => event.type === 'AGENT_TOOL_DETECTED')).toBe(false);
    const stepComplete = events.find((event) => event.type === 'AGENT_STEP_COMPLETE') as
      | { data: { stepIndex: number; toolExecutions: unknown[] } }
      | undefined;
    expect(stepComplete?.data.stepIndex).toBe(0);
    expect(stepComplete?.data.toolExecutions).toEqual([]);
    expect(events.some((event) => event.type === 'AGENT_LOOP_COMPLETE')).toBe(true);
  });
});
