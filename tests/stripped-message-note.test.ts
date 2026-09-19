import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stripped tool-call messages stay coherent with DeepSeek's message actions
 * (Defect: "Buttons on invisible content do exist", 2026-09-19).
 *
 * Live DOM finding (playwright probe, 2026-09-19): DeepSeek renders the
 * native action bar (copy/like/dislike/share/download, `div.ds-button`) as a
 * SIBLING of the `.ds-message` bubble inside the row wrapper, so the prior
 * muted placeholder (06b6016) made the bubble coherent but left a full
 * action bar operating on content the extension stripped: Copy on a
 * stripped tool-turn copies an empty string, and pre-reload the store still
 * holds the raw tool-call text the copy/edit handlers would surface.
 *
 * Fix contract:
 *  - every message whose native content the extension strips (DOM scrubber
 *    path) or whose payload was emptied before render (host-less empty
 *    path) is marked with `data-dpp-stripped-tool-call`;
 *  - marker-scoped CSS hides ONLY DeepSeek's native `ds-button` actions in
 *    the following-sibling bar - extension-owned actions in that bar
 *    (dpp-export-action) stay usable, and no React-owned node is touched;
 *  - the muted placeholder still mounts so a fully stripped bubble keeps an
 *    intentional body (06b6016, kept);
 *  - "empty" marks self-heal: if the message later shows native content
 *    (streaming mount raced the text), the marker and note retire so the
 *    native actions come back.
 */

const contentSource = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
const enSource = readFileSync(join(process.cwd(), 'core/i18n/resources/en/content.ts'), 'utf8');
const zhSource = readFileSync(join(process.cwd(), 'core/i18n/resources/zh-CN/content.ts'), 'utf8');

function fnBody(name: string): string {
  const start = contentSource.indexOf(`function ${name}(`);
  expect(start, `function ${name} must exist in entrypoints/content.ts`).toBeGreaterThan(0);
  return contentSource.slice(start, contentSource.indexOf('\n}', start));
}

describe('stripped tool-call message actions (buttons-on-invisible-content)', () => {
  it('marks messages whose rendered tool text the scrubber strips', () => {
    const body = fnBody('cleanRenderedToolCalls');
    // The strip reports whether it removed tool markup...
    expect(body).toContain('const stripped = stripToolCallTextNodes(root);');
    // ...and the message root carries the marker the CSS scopes to.
    expect(body).toContain('STRIPPED_TOOL_CALL_MESSAGE_ATTRIBUTE, "stripped"');
    expect(body).toContain('ensureStrippedToolCallNote(root);');
    expect(body.indexOf('stripToolCallTextNodes(root);'))
      .toBeLessThan(body.indexOf('ensureStrippedToolCallNote(root);'));
  });

  it('strip reports tool-markup removal, not blank-line cosmetics', () => {
    const body = fnBody('stripToolCallTextNodes');
    // Only real tool markup (open tag, close tag, orphan closer) counts;
    // blank-line collapse alone must never hide a legit message's actions.
    expect(body).toContain('removedToolMarkup = true');
    expect(body).toContain('return removedToolMarkup;');
  });

  it('marks host-less empty bubbles and mounts the muted note on them', () => {
    const body = fnBody('ensureStrippedToolCallNotes');
    expect(body).toContain('querySelectorAll(".ds-message")');
    expect(body).toContain('getAssistantContentHosts(message).length === 0');
    expect(body).toContain('data-dpp-hidden-inline-agent-continuation');
    expect(body).toContain('STRIPPED_TOOL_CALL_MESSAGE_ATTRIBUTE, "empty"');
    expect(body).toContain('mountStrippedToolCallNote(message)');
    // Collapsed step bubbles are extension-consumed; never re-noted.
    expect(body).toContain('data-dpp-collapsed-inline-agent-step');
  });

  it('re-checks every mounted bubble on every scrubber pass, not only restored renders', () => {
    const body = fnBody('cleanRenderedToolCalls');
    expect(body).toContain('ensureStrippedToolCallNotes();');
    // The restored-render pass keeps its dedicated call for virtual-list
    // mounts that do not trigger the mutation hub.
    const renderBody = fnBody('renderRestoredInlineAgentTraces');
    expect(renderBody).toContain('ensureStrippedToolCallNotes();');
  });

  it('self-heals a mis-marked empty message when native content appears', () => {
    const body = fnBody('ensureStrippedToolCallNotes');
    expect(body).toContain('removeAttribute(STRIPPED_TOOL_CALL_MESSAGE_ATTRIBUTE)');
    expect(body).toContain('removeStrippedToolCallNote(message)');
  });

  it('measures native text excluding extension-owned subtrees', () => {
    const body = fnBody('getNativeVisibleText');
    // The run record container and the note itself live inside the message;
    // they must not make a stripped bubble look "non-empty".
    expect(body).toContain('isExtensionOwnedUiElement(child)');
    const owned = fnBody('isExtensionOwnedUiElement');
    expect(owned).toContain('startsWith("dpp-")');
    expect(owned).toContain('data-dpp-');
  });

  it('the shared mounter keys on native text and stays idempotent', () => {
    const body = fnBody('mountStrippedToolCallNote');
    expect(body).toContain('data-dpp-stripped-note');
    expect(body).toContain('querySelector'); // idempotency guard
    expect(body).toContain('getNativeVisibleText(message)');
    expect(body).toContain('getAssistantContentHosts(message)');
    expect(body).toContain('contentT("content.agent.strippedToolCallNote")');
    // Muted chrome typography on the shared type-scale token.
    expect(body).toContain('var(--dpp-ui-text-muted)');
    expect(body).toContain('var(--dpp-ui-font-chrome, 12px)');
  });

  it('hides only DeepSeek native actions in the sibling bar for marked messages', () => {
    const body = fnBody('injectStrippedMessageActionStyles');
    // The action bar is a FOLLOWING SIBLING of the message bubble inside the
    // row wrapper (live DOM map, 2026-09-19); scope by the marker attribute.
    expect(body).toContain('.ds-message[data-dpp-stripped-tool-call] ~ .ds-flex .ds-button');
    expect(body).toContain('display: none !important;');
    // Extension-owned actions in the same bar (export) stay usable: the rule
    // targets DeepSeek's ds-button namespace only.
    expect(body).not.toContain('dpp-export-action');
  });

  it('the action-hiding stylesheet follows the capability lifecycle', () => {
    expect(contentSource).toContain('STRIPPED_MESSAGE_STYLE_ID = "dpp-stripped-message-css"');
    const start = fnBody('startToolCapability');
    expect(start).toContain('injectStrippedMessageActionStyles();');
    const stop = fnBody('stopToolCapability');
    expect(stop).toContain('document.getElementById(STRIPPED_MESSAGE_STYLE_ID)?.remove();');
  });

  it('the placeholder stays worded in both locales', () => {
    expect(enSource).toContain("strippedToolCallNote: '[tool call executed - see the run record]'");
    expect(zhSource).toContain("strippedToolCallNote: '[工具调用已执行 - 见运行记录]'");
  });
});
