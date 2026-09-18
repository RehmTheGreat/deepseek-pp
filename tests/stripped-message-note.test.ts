import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stripped tool-call messages keep a visible, intentional body (Defect 6,
 * 2026-09-18).
 *
 * pc observed DeepSeek's own edit/copy action buttons rendering on messages
 * whose tool-call text the extension strips: actions offered on invisible
 * content, and an empty bubble that reads as a breakage. The stripped message
 * now keeps a minimal muted placeholder line (i18n'd en + zh-CN) so the
 * native message and its action bar stay coherent. No fighting the site's
 * React: the note is an appended, extension-owned, idempotent element.
 *
 * Two strip paths produce the empty bubble, and both must be covered:
 *  - the DOM scrubber strips rendered tool text (note mounts in the same
 *    pass, into an existing content host);
 *  - history-cleanup strips the tool markup from the PAYLOAD before React
 *    renders, so the message never contains tool text and never grows a
 *    content host at all (live finding, smoke 2026-09-18): those messages are
 *    host-less and empty, and a separate render-pass scan covers them.
 */

const contentSource = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
const enSource = readFileSync(join(process.cwd(), 'core/i18n/resources/en/content.ts'), 'utf8');
const zhSource = readFileSync(join(process.cwd(), 'core/i18n/resources/zh-CN/content.ts'), 'utf8');

describe('stripped tool-call message placeholder (Defect 6)', () => {
  it('mounts a muted, idempotent note when a message body strips to empty', () => {
    const start = contentSource.indexOf('function ensureStrippedToolCallNote(');
    expect(start).toBeGreaterThan(0);
    const body = contentSource.slice(start, contentSource.indexOf('\n}', start));
    // The scrubber pass delegates to the shared mounter.
    expect(body).toContain('mountStrippedToolCallNote(root);');
    const mountStart = contentSource.indexOf('function mountStrippedToolCallNote(');
    const mountBody = contentSource.slice(mountStart, contentSource.indexOf('\n}', mountStart));
    expect(mountBody).toContain('data-dpp-stripped-note');
    expect(mountBody).toContain('querySelector'); // idempotency guard
    expect(mountBody).toContain('contentT("content.agent.strippedToolCallNote")');
  });

  it('runs inside the scrubber pass, after the text nodes are stripped', () => {
    const start = contentSource.indexOf('function cleanRenderedToolCalls(');
    const body = contentSource.slice(start, contentSource.indexOf('\n}', start));
    expect(body).toContain('ensureStrippedToolCallNote(root);');
    expect(body.indexOf('stripToolCallTextNodes(root);'))
      .toBeLessThan(body.indexOf('ensureStrippedToolCallNote(root);'));
  });

  it('covers host-less empty messages from a dedicated render-pass scan', () => {
    // History-stripped messages never grow content hosts, so the scrubber
    // pass cannot see them. The scan walks every .ds-message and picks the
    // host-less, text-less bubbles that are not continuation-hidden.
    const start = contentSource.indexOf('function ensureStrippedToolCallNotes(');
    expect(start).toBeGreaterThan(0);
    const body = contentSource.slice(start, contentSource.indexOf('\n}', start));
    expect(body).toContain('querySelectorAll(".ds-message")');
    expect(body).toContain('getAssistantContentHosts(message).length === 0');
    expect(body).toContain('data-dpp-hidden-inline-agent-continuation');
    expect(body).toContain('mountStrippedToolCallNote(message)');
    // Driven from the restored-render pass so virtual-list mounts re-check.
    const renderStart = contentSource.indexOf('function renderRestoredInlineAgentTraces(');
    const renderBody = contentSource.slice(renderStart, contentSource.indexOf('\n}', renderStart));
    expect(renderBody).toContain('ensureStrippedToolCallNotes();');
  });

  it('the shared mounter skips non-empty messages and already-noted ones', () => {
    const start = contentSource.indexOf('function mountStrippedToolCallNote(');
    expect(start).toBeGreaterThan(0);
    const body = contentSource.slice(start, contentSource.indexOf('\n}', start));
    expect(body).toContain('data-dpp-stripped-note');
    expect(body).toContain('.trim().length > 0');
    expect(body).toContain('getAssistantContentHosts(message)');
    // Muted chrome typography on the shared type-scale token.
    expect(body).toContain('var(--dpp-ui-text-muted)');
    expect(body).toContain('var(--dpp-ui-font-chrome, 12px)');
    expect(body).toContain('contentT("content.agent.strippedToolCallNote")');
  });

  it('is worded in both locales', () => {
    expect(enSource).toContain("strippedToolCallNote: '[tool call executed - see the run record]'");
    expect(zhSource).toContain("strippedToolCallNote: '[工具调用已执行 - 见运行记录]'");
  });
});
