import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Task "uniform tools" (post-run visibility parity, spec §2.2): after the
 * completed-run page reload, the restored console keeps the run's tool rows
 * visible and console-rendered final narration no longer renders at the
 * in-run 14px.
 *
 * content.ts is an entrypoint (not importable under vitest), so the repo pins
 * its wiring with source contracts (see tests/interruption-acknowledgement.
 * test.ts, tests/subagent-registration.test.ts). The DOM behavior of the
 * restored step mount and the restored font-size mechanism is tested
 * behaviorally in tests/inline-agent-renderer.test.ts.
 */

const contentSource = readFileSync('entrypoints/content.ts', 'utf8');

function afterMarker(marker: string): string {
  return contentSource.split(marker)[1] ?? '';
}

describe('restored inline-agent console (source contracts, content entrypoint pattern)', () => {
  it('stamps every restored container as restored and dedupable by trace key', () => {
    const createFn = afterMarker('function createRestoredInlineAgentContainer(')
      .split('\nfunction ')[0];
    expect(createFn).toContain('container.setAttribute("data-restored", "true")');
    expect(createFn).toContain(
      'container.setAttribute("data-dpp-agent-trace-key", trace.id)',
    );
  });

  it('keeps nativeHistoryOwnsFinalTurn semantics unchanged (web-backed, tool-free final step)', () => {
    // The native page owns the final turn's text only when the trace is not
    // budget-paused, the final step carried NO tools and the web backend
    // committed a positive response id. Duplicating that text in the console
    // would double-render the answer.
    expect(contentSource).toMatch(
      /const nativeHistoryOwnsFinalTurn =\s*\n\s*!restoredBudgetPaused &&\s*\n\s*lastStepRecord\?\.toolExecutions\.length === 0 &&\s*\n\s*isInlineAgentNativeHistoryBackedTrace\(trace\);/,
    );
  });

  it('skips only the tool-free final step of a native-owned turn — every tool step renders', () => {
    const loop = afterMarker('for (const step of sortedSteps) {')
      .split('\n  }\n')[0];
    // The ONLY skip in the restored step loop: the final step of a turn the
    // native page owns, which is by definition tool-free. Any other step —
    // in particular every step with tool calls — must mount.
    expect(loop).toContain(
      'if (\n      nativeHistoryOwnsFinalTurn &&\n      step.index === lastStepIndex &&\n      step.toolExecutions.length === 0\n    ) {\n      continue;\n    }',
    );
    expect(loop).toMatch(/mountRestoredAgentStep\(\s*consoleBody,\s*\{/);
    // The step's tool executions reach the restored mount…
    expect(loop).toContain('toolExecutions: step.toolExecutions,');
    // …and the final answer substitution only applies to the answer step.
    expect(loop).toContain('stepIsFinalAnswer ? restoredAnswerText : renderStepText');
  });

  it('renders the trigger turn\'s persisted executions as the first tool group', () => {
    const createFn = afterMarker('function createRestoredInlineAgentContainer(')
      .split('\nfunction ')[0];
    expect(createFn).toMatch(
      /for \(const exec of trace\.initialExecutions \?\? \[\]\) \{\s*\n\s*resolveAgentToolEntry\(consoleBody, -1, exec, getAgentRendererLabels\(\)\);\s*\n\s*\}/,
    );
  });

  it('keeps the console-owned final narration for non-native-owned runs', () => {
    // When the native page does NOT own the final turn, the resolved answer
    // must still be appended to the restored console (budget-paused, official
    // -api and legacy traces) — skipping it would leave the run answerless.
    expect(contentSource).toContain(
      'if (!nativeHistoryOwnsFinalTurn && !lastStepReplaced && restoredAnswerText) {',
    );
    expect(contentSource).toContain(
      'appendInlineAgentNarration(container, restoredAnswerText, trace.loopId);',
    );
  });

  it('matches the restored console typography to the measured host body font size', () => {
    // The measurement happens at mount time against the anchor message (the
    // native reference), falling back to the page body; the validated value is
    // published as the inline custom property the restored CSS consumes. A
    // failed measurement is a no-op (CSS fallback 14px).
    const mountFn = afterMarker('function mountRestoredInlineAgentContainer(')
      .split('\nfunction ')[0];
    expect(mountFn).toContain(
      'applyAgentBodyFontSize(container, measureHostBodyFontSize(message))',
    );
    const measureFn = afterMarker('function measureHostBodyFontSize(')
      .split('\nfunction ')[0];
    expect(measureFn).toContain('window.getComputedStyle(element).fontSize');
    expect(measureFn).toContain('document.body');
  });

  it('pairs anchor-less tool-first traces with noted empty bubbles in order', () => {
    // Live finding (smoke 2026-09-18): a tool-first run's anchor message is
    // the stripped-empty bubble, so neither id nor content matching can find
    // it. The restore render pairs those traces (empty anchor content, last
    // step carries tool executions) with the note-marked empty messages in
    // order, instead of leaving the console unmounted forever.
    const source = afterMarker('function renderRestoredInlineAgentTraces(')
      .split('\nfunction ')[0];
    expect(source).toContain('pairNotedEmptyMessagesWithTraces(');
    const pairFn = afterMarker('function pairNotedEmptyMessagesWithTraces(')
      .split('\nfunction ')[0];
    expect(pairFn).toContain('anchorContent');
    expect(pairFn).toContain('.trim().length > 0');
    expect(pairFn).toContain('data-dpp-stripped-note');
  });
});
