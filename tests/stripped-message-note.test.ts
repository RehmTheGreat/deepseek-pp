import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stripped tool-call messages keep a visible, intentional body (Defect 6,
 * 2026-09-18).
 *
 * pc observed DeepSeek's own edit/copy action buttons rendering on messages
 * whose tool-call text the extension stripped: actions offered on invisible
 * content, and an empty bubble that reads as a breakage. The stripped message
 * now keeps a minimal muted placeholder line (i18n'd en + zh-CN) so the
 * native message and its action bar stay coherent. No fighting the site's
 * React: the note is an appended, extension-owned, idempotent element.
 */

const contentSource = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
const enSource = readFileSync(join(process.cwd(), 'core/i18n/resources/en/content.ts'), 'utf8');
const zhSource = readFileSync(join(process.cwd(), 'core/i18n/resources/zh-CN/content.ts'), 'utf8');

describe('stripped tool-call message placeholder (Defect 6)', () => {
  it('mounts a muted, idempotent note when a message body strips to empty', () => {
    const start = contentSource.indexOf('function ensureStrippedToolCallNote(');
    expect(start).toBeGreaterThan(0);
    const body = contentSource.slice(start, contentSource.indexOf('\n}', start));

    expect(body).toContain('data-dpp-stripped-note');
    expect(body).toContain('querySelector'); // idempotency guard
    expect(body).toContain('getAssistantContentHosts(root)');
    // Only when the assistant content hosts have NO visible text left.
    expect(body).toContain('.trim().length > 0');
    expect(body).toContain('contentT("content.agent.strippedToolCallNote")');
    // Muted chrome typography on the shared type-scale token.
    expect(body).toContain('var(--dpp-ui-text-muted)');
    expect(body).toContain('var(--dpp-ui-font-chrome, 12px)');
  });

  it('runs inside the scrubber pass, after the text nodes are stripped', () => {
    const start = contentSource.indexOf('function cleanRenderedToolCalls(');
    const body = contentSource.slice(start, contentSource.indexOf('\n}', start));
    expect(body).toContain('ensureStrippedToolCallNote(root);');
    expect(body.indexOf('stripToolCallTextNodes(root);'))
      .toBeLessThan(body.indexOf('ensureStrippedToolCallNote(root);'));
  });

  it('is worded in both locales', () => {
    expect(enSource).toContain("strippedToolCallNote: '[tool call executed - see the run record]'");
    expect(zhSource).toContain("strippedToolCallNote: '[工具调用已执行 - 见运行记录]'");
  });
});
