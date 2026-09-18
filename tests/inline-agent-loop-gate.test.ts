import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectStartableToolExecutions } from '../core/inline-agent/mid-run-turn';
import { withInlineAgentSubagentSpawnDescriptor } from '../core/inline-agent/subagent-tool';
import { projectToolDescriptorsForNativeSearch } from '../core/tool/native-search-projection';
import { createMemoryToolDescriptors } from '../core/tool/memory';
import { WEB_SEARCH_TOOL_PROVIDER } from '../core/tool/web-search';
import { INCOMPLETE_TOOL_CALL_ERROR_CODE } from '../core/tool/execution-error';
import type { ToolDescriptor, ToolExecutionRecord } from '../core/types';

/**
 * Task "uniform tools" (loop gate): every native turn that executed ≥1 tool
 * starts the ONE structured inline-agent loop, and the loop's grant + parser
 * cover the FULL advertised tool catalog (shell_exec and spawn included).
 *
 * content.ts is an entrypoint (not importable under vitest), so the repo pins
 * its wiring with source contracts (see tests/interruption-acknowledgement.
 * test.ts, tests/subagent-registration.test.ts). The gate policy itself lives
 * in the pure decision module next to the supersede/anchor predicates and is
 * tested behaviorally here.
 */

const contentSource = readFileSync('entrypoints/content.ts', 'utf8');

const GATE_CALL = 'selectStartableToolExecutions(executions)';
const GATE_SUPPRESSION =
  'if (startableExecutions.length === 0 && !superseding) return;';
const ANCHOR_GUARD = 'if (!canAnchorFreshLoop(complete)) return;';
const GRANT_TOAST_BLOCK = [
  '  if (!authorization) {',
  '    // Don\'t fail silently: the user asked for agent work and the loop cannot',
  '    // start without the tool authorization grant (Issue #544).',
  '    showContentToast(contentT("content.agent.startFailed"), "warning");',
  '    mountRefusedToolTurnRecord(',
  '      complete,',
  '      startableExecutions,',
  '      contentT("content.agent.startFailed"),',
  '    );',
  '    return;',
  '  }',
].join('\n');

describe('selectStartableToolExecutions (fresh-loop gate policy)', () => {
  it('a shell_exec-only turn is a loop-starting turn (the dominant real case)', () => {
    const executions = [
      makeExecution({
        name: 'shell_exec',
        provider: {
          kind: 'mcp',
          id: 'shell',
          displayName: 'Shell',
          transport: 'native_messaging',
        },
        result: { ok: true, summary: 'ok' },
      }),
    ];
    expect(selectStartableToolExecutions(executions)).toEqual(executions);
  });

  it('a web_search turn is still a loop-starting turn', () => {
    const executions = [
      makeExecution({ name: 'web_search', provider: WEB_SEARCH_TOOL_PROVIDER }),
    ];
    expect(selectStartableToolExecutions(executions)).toEqual(executions);
  });

  it('any completed execution starts the loop — there is no continuable-subset policy', () => {
    // The old policy kept only MCP/web/browser/memory tools; an opaque local
    // tool now owns its presentation in the loop exactly like the rest.
    const executions = [
      makeExecution({
        name: 'opaque_tool',
        provider: {
          kind: 'local',
          id: 'opaque',
          displayName: 'Opaque',
          transport: 'in_process',
        },
      }),
    ];
    expect(selectStartableToolExecutions(executions)).toEqual(executions);
  });

  it('a zero-tool turn never starts the loop', () => {
    expect(selectStartableToolExecutions([])).toEqual([]);
  });

  it('pending-only executions (artifact streaming) do not start the loop', () => {
    expect(selectStartableToolExecutions([makeExecution({ pending: true })])).toEqual([]);
  });

  it('mixed pending and completed executions keep only the completed ones', () => {
    const completed = makeExecution();
    const startable = selectStartableToolExecutions([
      makeExecution({ pending: true }),
      completed,
    ]);
    expect(startable).toEqual([completed]);
  });

  it('an interrupted (incomplete streamed call) execution stays startable', () => {
    // Recovery-only record: the loop must see the failure so the model can
    // re-emit a closed call (released behavior of the old continuable policy).
    const interrupted = makeExecution({
      result: {
        ok: false,
        summary: 'failed',
        error: {
          code: INCOMPLETE_TOOL_CALL_ERROR_CODE,
          message: 'incomplete',
          retryable: false,
        },
      },
    });
    expect(selectStartableToolExecutions([interrupted])).toEqual([interrupted]);
  });

  it('a pending subagent_spawn seed IS loop-starting (deferred first-turn spawn)', () => {
    // First-turn subagent access (pc directive 3): a parsed subagent_spawn
    // call on the NATIVE trigger turn is deferred into the loop as a pending
    // seed — it has not executed yet, but it is BY DESIGN the loop's step 0,
    // so the gate must treat it as loop-starting. A first turn whose ONLY
    // tool call is the deferred spawn starts the loop instead of vanishing.
    const seed = makeExecution({ pending: true, name: 'subagent_spawn' });
    expect(selectStartableToolExecutions([seed])).toEqual([seed]);
  });

  it('a pending non-spawn execution still never starts the loop', () => {
    // The seed exception is scoped to the exact spawn invocation name: an
    // artifact-streaming pending record (or any other pending tool) keeps the
    // released "not an execution yet" policy.
    expect(
      selectStartableToolExecutions([makeExecution({ pending: true, name: 'artifact_create' })]),
    ).toEqual([]);
    expect(
      selectStartableToolExecutions([makeExecution({ pending: true, name: 'subagent_spawn_typo' })]),
    ).toEqual([]);
  });
});

describe('content-script wiring of the loop gate (source contract)', () => {
  it('replaces the continuable-subset gate with the any-completed-execution gate', () => {
    expect(contentSource).toContain('const startableExecutions = ' + GATE_CALL);
    expect(contentSource).toContain(GATE_SUPPRESSION);
    expect(contentSource).toContain('toolExecutions: startableExecutions,');
  });

  it('keeps no reference to the deleted continuable policy', () => {
    expect(contentSource).not.toContain('selectContinuableToolExecutions');
    expect(contentSource).not.toContain('selectContinuableToolDescriptors');
    expect(contentSource).not.toContain('execution-policy');
    expect(existsSync('core/inline-agent/execution-policy.ts')).toBe(false);
  });

  it('orders the gate after the supersede decision and before the silent bail guards', () => {
    const supersedeStart = contentSource.indexOf('let superseding = false;');
    const gateIndex = contentSource.indexOf(GATE_SUPPRESSION);
    const anchorIndex = contentSource.indexOf(ANCHOR_GUARD);
    const grantToastIndex = contentSource.indexOf(GRANT_TOAST_BLOCK);

    expect(supersedeStart).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(supersedeStart);
    // Anchor-less turn: the guard stays the bail; the refused-turn record
    // mounts just before it (review fix F3).
    expect(anchorIndex).toBeGreaterThan(gateIndex);
    // Grant-less turn: the visible startFailed toast path, now with the
    // refused-turn record too (review fix F3).
    expect(grantToastIndex).toBeGreaterThan(anchorIndex);
  });

  it('loop-owned turns stay suppressed before any gate evaluation', () => {
    const ownTurnReturn = contentSource.indexOf(
      'if (isInlineAgentResponseComplete(complete)) return;',
    );
    const gateIndex = contentSource.indexOf(GATE_SUPPRESSION);
    expect(ownTurnReturn).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThan(ownTurnReturn);
  });

  it('defers a parsed first-turn spawn into the loop instead of executing it on the manual grant', () => {
    // First-turn subagent access (pc directive 3): runToolExecution intercepts
    // the spawn call BEFORE the background manual path, seeds it into the turn
    // (the gate's loop-starting pending record), and hands the CALL itself to
    // the loop payload — the loop's step 0 executes it through the authorized
    // agent_run executor. A first-turn spawn must NEVER execute outside that
    // path.
    const runTool = contentSource.indexOf('function runToolExecution(');
    const interceptIndex = contentSource.indexOf('isInlineAgentSubagentSpawnCall(call)', runTool);
    expect(runTool).toBeGreaterThan(-1);
    expect(interceptIndex).toBeGreaterThan(runTool);
    // The interception happens before the background execution closure.
    const backgroundExecuteIndex = contentSource.indexOf('executeToolCall(call)', interceptIndex);
    expect(backgroundExecuteIndex).toBeGreaterThan(interceptIndex);
    // The deferred calls ride the loop payload; the seed records ride the
    // gate's executions.
    expect(contentSource).toContain('firstTurnSpawnCalls:');
    expect(contentSource).toContain('takeDeferredFirstTurnSpawnSeeds(');
  });

  it('requests the loop grant over the FULL turn catalog with spawn merged (no descriptor subset)', () => {
    expect(contentSource).toMatch(
      /toolDescriptors:\s*withInlineAgentSubagentSpawnDescriptor\(\s*authorization\.descriptors,\s*\),/,
    );
  });

  it('the loop parser recomputes its descriptor set from the RETURNED grant', () => {
    expect(contentSource).toMatch(
      /projectToolDescriptorsForNativeSearch\(\s*authorization\.descriptors,/,
    );
  });

  it('refused tool turns show what executed on BOTH refusal paths (review fix F3)', () => {
    // Anchor-less bail: the record (with its own header) mounts BEFORE the
    // guard's silent return, so the executed tools are never invisible.
    const anchorRecordIndex = contentSource.indexOf(
      'contentT("content.agent.refusedToolTurn")',
    );
    expect(anchorRecordIndex).toBeGreaterThan(0);
    expect(anchorRecordIndex).toBeLessThan(contentSource.indexOf(ANCHOR_GUARD));

    // Grant-less bail: the record reuses the startFailed wording as its
    // header (pinned by GRANT_TOAST_BLOCK above, toast kept).
    expect(contentSource.indexOf(GRANT_TOAST_BLOCK)).toBeGreaterThan(
      contentSource.indexOf(ANCHOR_GUARD),
    );

    // Exactly TWO call sites, both on refusal paths ahead of the run actually
    // starting (the payload build / console mount): a turn that starts a loop
    // NEVER renders a refused record.
    const startMountIndex = contentSource.indexOf('injectInlineAgentStyles();');
    const callOccurrences = contentSource.split('mountRefusedToolTurnRecord(').length - 1;
    expect(callOccurrences).toBe(3); // two refusal calls + the helper declaration
    const firstCall = contentSource.indexOf('mountRefusedToolTurnRecord(');
    const secondCall = contentSource.indexOf('mountRefusedToolTurnRecord(', firstCall + 1);
    expect(firstCall).toBeLessThan(startMountIndex);
    expect(secondCall).toBeLessThan(startMountIndex);
    const declaration = contentSource.indexOf('function mountRefusedToolTurnRecord(');
    expect(declaration).toBeGreaterThan(startMountIndex);

    // In-DOM only: the helper performs no storage writes of any kind.
    const helper = contentSource.slice(declaration);
    expect(helper).not.toMatch(/chrome\.storage|indexedDB|localStorage|sessionStorage/);
    // Non-interactive and structured-UI consistent: the renderer record has
    // its own suite; here the helper must mount through that primitive.
    expect(helper).toContain('createAgentRefusedTurnRecord(');
  });
});

describe('loop tool surface: the full catalog + spawn reaches the loop parser', () => {
  it('a shell_exec descriptor survives the grant round-trip and the loop projection', () => {
    // The turn catalog the content side holds for the request (manual chat's
    // projected set): extension web tools, memory, and an MCP shell tool.
    const catalog: ToolDescriptor[] = [
      makeDescriptor('local:web:web_search', 'web_search', WEB_SEARCH_TOOL_PROVIDER),
      ...createMemoryToolDescriptors('en'),
      makeDescriptor('mcp:shell-local:shell_exec', 'shell_exec', {
        kind: 'mcp',
        id: 'shell-local',
        displayName: 'Shell Local',
        transport: 'native_messaging',
      }),
    ];

    // Background grant resolution (entrypoints/background/tool-execution-
    // handlers.ts): agent_run grants merge the spawn descriptor, then the
    // grant keeps exactly the requested ids. The request carries the FULL
    // catalog + spawn, so the round-trip is lossless.
    const grantable = withInlineAgentSubagentSpawnDescriptor(catalog);
    const requested = withInlineAgentSubagentSpawnDescriptor(catalog);
    const requestedIds = new Set(requested.map((descriptor) => descriptor.id));
    const grant = grantable.filter((descriptor) => requestedIds.has(descriptor.id));
    expect(grant.map((descriptor) => descriptor.id)).toEqual(
      grantable.map((descriptor) => descriptor.id),
    );

    // Loop-side recompute (content.ts): the parser surface derives from the
    // RETURNED grant under the native-search projection. shell_exec and spawn
    // must be recognized in both native-search modes.
    for (const searchEnabled of [true, false]) {
      const loopToolDescriptors = [
        ...projectToolDescriptorsForNativeSearch(grant, searchEnabled),
      ];
      expect(loopToolDescriptors.map((descriptor) => descriptor.name)).toContain(
        'shell_exec',
      );
      expect(loopToolDescriptors.map((descriptor) => descriptor.name)).toContain(
        'subagent_spawn',
      );
      expect(loopToolDescriptors.map((descriptor) => descriptor.name)).toEqual(
        expect.arrayContaining(['memory_save', 'memory_update', 'memory_delete']),
      );
    }

    // Released native-search behavior is unchanged: the extension-owned web
    // tool still leaves the loop surface when the page-native search is on.
    const withNativeSearch = [
      ...projectToolDescriptorsForNativeSearch(grant, true),
    ].map((descriptor) => descriptor.name);
    expect(withNativeSearch).not.toContain('web_search');
  });

  it('the spawn merge stays append-only and idempotent over the full catalog', () => {
    const catalog: ToolDescriptor[] = [
      makeDescriptor('mcp:shell-local:shell_exec', 'shell_exec', {
        kind: 'mcp',
        id: 'shell-local',
        displayName: 'Shell Local',
        transport: 'native_messaging',
      }),
    ];
    const once = withInlineAgentSubagentSpawnDescriptor(catalog);
    const twice = withInlineAgentSubagentSpawnDescriptor(once);
    expect(twice).toEqual(once);
    expect(twice.filter((descriptor) => descriptor.name === 'subagent_spawn')).toHaveLength(1);
  });
});

function makeExecution(
  overrides: Partial<ToolExecutionRecord> = {},
): ToolExecutionRecord {
  return {
    callId: 'call-1',
    name: 'web_fetch',
    provider: { kind: 'local', id: 'web', displayName: 'Web', transport: 'in_process' },
    result: { ok: true, summary: 'done' },
    ...overrides,
  };
}

function makeDescriptor(
  id: string,
  name: string,
  provider: ToolDescriptor['provider'],
): ToolDescriptor {
  return {
    id,
    provider,
    name,
    invocationName: name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}
