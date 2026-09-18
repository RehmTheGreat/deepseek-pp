import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Renderer-crash containment (Defect 1/7, 2026-09-18).
 *
 * Live evidence (visual-verify-report.md T5 attempt 1): a turn whose model
 * response is a bare tool call crashed DeepSeek's whole React tree into its
 * "crashed due to modifications made by certain browser extensions" error
 * boundary. Root cause chain: the missing bootstrap-snapshot extractor branch
 * let the raw XML reach the page (fixed in
 * tests/turn0-bootstrap-fragments.test.ts), where the rendered-tool-call
 * scrubber then mutated the page's React-owned DOM. These tests pin the
 * containment contracts so no scrubber path can ever corrupt the page tree
 * or take the page down, and document the page-break/reload inventory.
 */
const contentSource = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `expected ${signature} to exist`).toBeGreaterThanOrEqual(0);
  const nextBrace = source.indexOf('{', start);
  let depth = 0;
  for (let i = nextBrace; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

describe('rendered tool-call scrubber containment', () => {
  it('never removes a React-owned element; empty containers are hidden, not deleted', () => {
    const body = functionBody(contentSource, 'function pruneEmptyToolContainers(');
    // Deleting nodes the page reconciler still holds is the classic
    // extension-caused renderer crash (removeChild NotFoundError). Hiding is
    // visually identical and leaves the tree shape intact.
    expect(body).not.toContain('.remove()');
    expect(contentSource).toContain('const PRUNED_TOOL_CONTAINER_MARKER = "data-dpp-pruned-empty";');
    expect(body).toContain('PRUNED_TOOL_CONTAINER_MARKER');
    expect(body).toContain('style.display = "none"');
  });

  it('un-hides pruned containers when the tool capability stops (lifecycle ownership)', () => {
    const reset = functionBody(contentSource, 'function resetPrunedToolContainers(');
    expect(reset).toContain('PRUNED_TOOL_CONTAINER_MARKER');
    expect(reset).toContain('removeProperty("display")');
    expect(reset).toContain('removeAttribute(PRUNED_TOOL_CONTAINER_MARKER)');

    const stopBody = functionBody(contentSource, 'async function stopToolCapability(');
    const stopAt = contentSource.indexOf(stopBody);
    const resetAt = contentSource.indexOf('resetPrunedToolContainers();', stopAt);
    const stopCleanerAt = contentSource.indexOf('stopRenderedToolCallCleaner();', stopAt);
    expect(resetAt).toBeGreaterThan(0);
    expect(stopCleanerAt).toBeGreaterThan(0);
    expect(resetAt).toBeGreaterThan(stopCleanerAt);
  });

  it('contains scrubber throws per message root with a bounded diagnostic log', () => {
    const body = functionBody(contentSource, 'function cleanRenderedToolCalls(');
    expect(body).toContain('try {');
    expect(body).toContain('catch (error)');
    expect(body).toContain('console.warn');
    expect(body).toContain('SCRUBBER_ERROR_LOG_LIMIT');
    // The limit is defined once with a small bound.
    expect(contentSource).toMatch(/const SCRUBBER_ERROR_LOG_LIMIT = \d+;/);
  });
});

describe('page-break and reload inventory (Defect 7)', () => {
  it('has exactly one reload call site and it is the completed-run handoff', () => {
    const callSites = contentSource.split('reloadInlineAgentNativeHistory();').length - 1;
    // One real call site; the second occurrence is the function's own
    // declaration line `function reloadInlineAgentNativeHistory(): void {`,
    // which does not match the call pattern.
    expect(callSites).toBe(1);
    expect(contentSource).toContain('if (shouldReloadNativeHistory) reloadInlineAgentNativeHistory();');
  });

  it('the AGENT_LOOP_ERROR terminal paths never reload the page', () => {
    // Both dispatchers (child consoles and the parent terminal handler) own
    // an AGENT_LOOP_ERROR case; neither may reload the document.
    const bodies: string[] = [];
    let searchFrom = 0;
    for (;;) {
      const at = contentSource.indexOf('case "AGENT_LOOP_ERROR":', searchFrom);
      if (at === -1) break;
      const breakAt = contentSource.indexOf('break;', at);
      bodies.push(contentSource.slice(at, breakAt));
      searchFrom = at + 1;
    }
    expect(bodies.length).toBe(2);
    for (const body of bodies) expect(body).not.toContain('reload');
  });

  it('the completed-run reload gate stays fail-closed on non-complete traces', async () => {
    const { shouldReloadInlineAgentNativeHistory } = await import(
      '../core/inline-agent/native-history'
    );
    const base = {
      modelBackend: 'web' as const,
      budgetPaused: false,
      finalText: 'done',
      trace: {
        id: 't',
        loopId: 'l',
        chatSessionId: 's',
        anchorMessageId: 1,
        url: 'https://chat.deepseek.com/a/chat/s/s',
        originalPrompt: 'p',
        agentTaskPrompt: 'p',
        status: 'error' as const,
        steps: [{
          index: 0,
          status: 'complete' as const,
          text: 'x',
          toolExecutions: [],
          responseMessageId: 42,
          collapsed: true,
        }],
        totalSteps: 1,
        totalTools: 0,
        finalText: 'done',
        createdAt: 1,
        updatedAt: 2,
      },
      visibleChatSessionId: 's',
    };
    // An errored run must NEVER trigger the post-run page reload even when a
    // stale response id survives on its last step.
    expect(shouldReloadInlineAgentNativeHistory(base)).toBe(false);
  });
});
