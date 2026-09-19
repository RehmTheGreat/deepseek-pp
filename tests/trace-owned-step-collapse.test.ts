import { describe, expect, it } from 'vitest';
import {
  matchTraceOwnedStepMessages,
} from '../core/inline-agent/message-anchor';
import { readFileSync } from 'node:fs';

/**
 * D3 (fix round 4, live diagnosis): after a completed run's post-run reload,
 * EVERY loop-step message rendered as a standalone native bubble - including
 * the previous turn's full answer - because the loop commits each step to the
 * native chain and nothing filtered them on history render. The extension's
 * restored consoles own that content, so the native copies are collapsed out
 * of the restored view. This file pins the matching rule (identity first,
 * own-text content second, document order, never reusing a message) and the
 * content.ts wiring (source contracts at the bottom).
 */

function message(text: string, id?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ds-message';
  const body = document.createElement('div');
  body.className = 'ds-markdown';
  body.textContent = text;
  el.appendChild(body);
  if (id) el.setAttribute('data-id', id);
  document.body.appendChild(el);
  return el;
}

describe('matchTraceOwnedStepMessages (D3 matcher)', () => {
  it('matches steps by committed message id when the DOM exposes ids', () => {
    const anchor = message('Trigger turn answer', '34');
    const step0 = message('Step zero narration with plenty of text to match', '36');
    const step1 = message('Step one narration with plenty of text to match', '38');
    const steps = [
      { index: 0, responseMessageId: 36, text: 'ignored when ids match' },
      { index: 1, responseMessageId: 38, text: '' },
    ];
    const matched = matchTraceOwnedStepMessages([anchor, step0, step1], steps, new Set());
    expect(matched.get(0)).toBe(step0);
    expect(matched.get(1)).toBe(step1);
  });

  it('falls back to the step own text (markdown-normalized, document order)', () => {
    const anchor = message('Trigger turn answer');
    const step0 = message('**Current time check** done. I need to find capabilities.');
    const step1 = message('Enumerating the gateways with the correct tags now.');
    const steps = [
      { index: 0, responseMessageId: null, text: '**Current time check** done. I need to find capabilities.' },
      { index: 1, responseMessageId: null, text: 'Enumerating the gateways with the correct tags now.' },
    ];
    const matched = matchTraceOwnedStepMessages([anchor, step0, step1], steps, new Set());
    expect(matched.get(0)).toBe(step0);
    expect(matched.get(1)).toBe(step1);
  });

  it('never matches out of order: a later step cannot consume an earlier message', () => {
    const step0 = message('First narration paragraph with enough length here');
    const step1 = message('Second narration paragraph with enough length here');
    const steps = [
      { index: 0, responseMessageId: null, text: 'Second narration paragraph with enough length here' },
      { index: 1, responseMessageId: null, text: 'First narration paragraph with enough length here' },
    ];
    const matched = matchTraceOwnedStepMessages([step0, step1], steps, new Set());
    // Step 0's text only exists at position 1 - matched there; step 1's
    // earlier-positioned text is behind the search cursor and stays unmatched.
    expect(matched.get(0)).toBe(step1);
    expect(matched.has(1)).toBe(false);
  });

  it('skips messages already used by consoles or an earlier collapse', () => {
    const step0 = message('Repeated opening narration with enough length here');
    const step1 = message('Repeated opening narration with enough length here');
    const steps = [
      { index: 0, responseMessageId: null, text: 'Repeated opening narration with enough length here' },
      { index: 1, responseMessageId: null, text: 'Repeated opening narration with enough length here' },
    ];
    const used = new Set<Element>([step0]);
    const matched = matchTraceOwnedStepMessages([step0, step1], steps, used);
    expect(matched.get(0)).toBe(step1);
  });

  it('leaves short and missing step text unmatched (no false collapses)', () => {
    const msg = message('tiny');
    const steps = [{ index: 0, responseMessageId: null, text: 'tiny' }];
    const matched = matchTraceOwnedStepMessages([msg], steps, new Set());
    expect(matched.size).toBe(0);
  });

  it('anchors the text leg at message start: a mid-message mention never matches', () => {
    // Review fix: the loose `includes` leg could collapse an unrelated longer
    // message (e.g. a later summary that QUOTES the step's opening line in
    // its middle). The step's text must anchor at the message's own start.
    const stepText = 'Check one passed with a detailed observation here';
    const midMessageMention = message(`Summary of everything: ${stepText}, plus more prose.`);
    const realStepBubble = message(`${stepText} Continue.`);
    const steps = [{ index: 0, responseMessageId: null, text: stepText }];
    const matched = matchTraceOwnedStepMessages(
      [midMessageMention, realStepBubble],
      steps,
      new Set(),
    );
    expect(matched.get(0)).toBe(realStepBubble);
  });
});

describe('content.ts collapse wiring (D3, source contracts)', () => {
  const contentSource = readFileSync('entrypoints/content.ts', 'utf8');

  it('collapses matched step messages with a dedicated marker after restore', () => {
    const fn = contentSource
      .split('function collapseRestoredInlineAgentStepMessages(')[1]
      ?.split('\nfunction ')[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('data-dpp-collapsed-inline-agent-step');
    expect(fn).toContain('matchTraceOwnedStepMessages');
    // Never hide a message the consoles anchor on or an intentionally
    // annotated stripped bubble (tool-first pairing depends on it).
    expect(fn).toContain('findRestoredInlineAgentTrace');
    expect(fn).toContain('data-dpp-stripped-note');
  });

  it('never collapses the native-owned final answer of a completed run', () => {
    const fn = contentSource
      .split('function collapseRestoredInlineAgentStepMessages(')[1]
      ?.split('\nfunction ')[0];
    expect(fn).toContain('isInlineAgentNativeHistoryBackedTrace');
    expect(fn).toContain('lastStepIndex');
  });

  it('runs the collapse pass inside the restore render flow', () => {
    const render = contentSource
      .split('function renderRestoredInlineAgentTraces(')[1]
      ?.split('\nfunction ')[0];
    expect(render).toContain('collapseRestoredInlineAgentStepMessages');
  });

  it('only considers assistant-hosted messages as collapse targets', () => {
    // Review fix: the shared getAssistantMessages fallback can return user
    // bubbles when the DOM exposes no assistant hosts - hiding a user's own
    // bubble would lose their content. The collapse must filter to
    // assistant-hosted messages first.
    const fn = contentSource
      .split('function collapseRestoredInlineAgentStepMessages(')[1]
      ?.split('\nfunction ')[0];
    expect(fn).toContain('getAssistantContentHosts');
  });
});
