import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contract (UI-1 retirement): the legacy collapsible "Called tools"
// block has NO render path left in the content script — no DOM id/class
// creation, no style injection, no retired i18n title usage — while the
// `dpp_tool_execution_blocks` persistence layer and its live consumers
// (restored-record trace anchoring, regenerate re-authorization fallback)
// remain untouched. Blocking on source text keeps the structured inline-agent
// loop the single tool-call presentation.

const contentSource = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
const enSource = readFileSync(join(process.cwd(), 'core/i18n/resources/en/content.ts'), 'utf8');
const zhSource = readFileSync(join(process.cwd(), 'core/i18n/resources/zh-CN/content.ts'), 'utf8');
const storeSource = readFileSync(join(process.cwd(), 'core/tool/execution-block-store.ts'), 'utf8');
const restoredTargetsSource = readFileSync(
  join(process.cwd(), 'entrypoints/content/restored-message-targets.ts'),
  'utf8',
);
const messageAnchorSource = readFileSync(
  join(process.cwd(), 'core/inline-agent/message-anchor.ts'),
  'utf8',
);

describe('legacy Called-tools block render path is fully removed (UI-1)', () => {
  it('creates no .dpp-tool-block DOM, styles, or retired i18n usage in the content script', () => {
    expect(contentSource).not.toContain('dpp-tool-block');
    expect(contentSource).not.toContain('TOOL_BLOCK_ID');
    expect(contentSource).not.toContain('TOOL_BLOCK_STYLE_ID');
    expect(contentSource).not.toContain('content.toolBlock.title');
    expect(contentSource).not.toContain('content.toolBlock.pythonInterpreter');
    expect(contentSource).not.toContain('content.toolBlock.summaries.saved');
    expect(contentSource).not.toContain('content.toolBlock.summaries.updated');
    expect(contentSource).not.toContain('content.toolBlock.summaries.deleted');
    expect(contentSource).not.toContain('content.toolBlock.summaries.searched');
    expect(contentSource).not.toContain('content.toolBlock.summaries.fetched');
  });

  it('keeps no render/update/restore-render/collapse/detach helper', () => {
    for (const dead of [
      'function renderToolBlock(',
      'function renderActiveToolBlockForCurrentRoute(',
      'function renderRestoredToolBlocks(',
      'function scheduleRenderRestoredToolBlocks(',
      'function updateToolBlockContent(',
      'function createToolBlockShell(',
      'function injectToolBlockStyles(',
      'function placeToolBlock(',
      'function appendToolBlockToMessage(',
      'function collapseToolBlock(',
      'function removeToolBlockFromMessage(',
      'function findRestoredToolBlock(',
      'function renderDetachedArtifactResults(',
      'function renderDetachedArtifactResultsForBlock(',
      'function getRestoredExecutions(',
      'function summarizeRestoredToolCall(',
    ]) {
      expect(contentSource).not.toContain(dead);
    }
  });

  it('drops the retired block references from the shared anchor/mutation selectors', () => {
    expect(restoredTargetsSource).not.toContain('dpp-tool-block');
    expect(messageAnchorSource).not.toContain('dpp-tool-block');
  });

  it('removes the retired keys from BOTH locales', () => {
    expect(enSource).not.toContain("title: 'Called tools ({count})'");
    expect(enSource).not.toContain("pythonInterpreter: 'Python interpreter'");
    expect(zhSource).not.toContain("title: '已调用工具（{count}次）'");
    expect(zhSource).not.toContain("pythonInterpreter: 'Python 解释器'");
  });

  it('keeps the dpp_tool_execution_blocks persistence layer and its consumers', () => {
    expect(storeSource).toContain('dpp_tool_execution_blocks');
    expect(contentSource).toContain('async function persistToolBlockSession(');
    expect(contentSource).toContain('upsertPersistedToolExecutionBlock(block)');
    expect(contentSource).toContain('async function restorePersistedToolBlocks(');
    expect(contentSource).toContain('function rememberRestoredToolRecords(');
    // Restored records keep feeding the inline-agent trace restore anchor.
    expect(contentSource).toContain('scheduleRenderRestoredInlineAgentTraces();');
    // The regenerate re-authorization fallback keeps reading persisted blocks.
    expect(contentSource).toContain('await readPersistedToolExecutionBlocks()');
    // Artifact-result cleanup sweep survives untouched.
    expect(contentSource).toMatch(
      /document\s*\.querySelectorAll\(["']\.dpp-artifact-results["']\)/,
    );
  });
});
