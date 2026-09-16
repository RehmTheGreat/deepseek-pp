import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideMidRunTurn } from '../core/inline-agent/mid-run-turn';
import { closeInterruptedTrace } from '../core/inline-agent/trace-status';
import type { InlineAgentTraceRecord } from '../core/inline-agent/types';
import { translate } from '../core/i18n';

const SUPERSEDED_REASON = translate('en', 'content.agent.superseded');

function runningTrace(): InlineAgentTraceRecord {
  return {
    id: 'trace-1',
    loopId: 'loop-1',
    chatSessionId: 'session-1',
    anchorMessageId: 10,
    url: 'https://chat.deepseek.com/a/chat/s/session-1',
    originalPrompt: 'task',
    agentTaskPrompt: 'task',
    status: 'running',
    steps: [
      {
        index: 0,
        status: 'streaming',
        text: 'working…',
        toolExecutions: [],
        responseMessageId: null,
        collapsed: false,
      },
    ],
    totalSteps: 1,
    totalTools: 0,
    finalText: '',
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('decideMidRunTurn (P0.1 supersede, ruling R1)', () => {
  it('supersedes a mid-run user turn that can anchor and authorize a fresh loop', () => {
    expect(
      decideMidRunTurn({
        loopRunning: true,
        isAgentOwnTurn: false,
        hasFreshLoopAnchor: true,
        hasTurnAuthorization: true,
      }),
    ).toEqual({ action: 'supersede' });
  });

  it('never silently swallows the turn: an unanchorable mid-run turn is visibly refused', () => {
    expect(
      decideMidRunTurn({
        loopRunning: true,
        isAgentOwnTurn: false,
        hasFreshLoopAnchor: false,
        hasTurnAuthorization: true,
      }),
    ).toEqual({ action: 'refuse' });
  });

  it('visibly refuses when the turn carries no tool-authorization grant', () => {
    expect(
      decideMidRunTurn({
        loopRunning: true,
        isAgentOwnTurn: false,
        hasFreshLoopAnchor: true,
        hasTurnAuthorization: false,
      }),
    ).toEqual({ action: 'refuse' });
  });

  it('proceeds on the normal path when no loop is running', () => {
    expect(
      decideMidRunTurn({
        loopRunning: false,
        isAgentOwnTurn: false,
        hasFreshLoopAnchor: true,
        hasTurnAuthorization: true,
      }),
    ).toEqual({ action: 'proceed' });
  });

  it('skips the loop own continuation turns before any supersede decision', () => {
    expect(
      decideMidRunTurn({
        loopRunning: true,
        isAgentOwnTurn: true,
        hasFreshLoopAnchor: true,
        hasTurnAuthorization: true,
      }),
    ).toEqual({ action: 'skip' });
    expect(
      decideMidRunTurn({
        loopRunning: false,
        isAgentOwnTurn: true,
        hasFreshLoopAnchor: false,
        hasTurnAuthorization: false,
      }),
    ).toEqual({ action: 'skip' });
  });
});

describe('supersede closes the old loop honestly', () => {
  it('closes the running trace with a terminal status and the supersede reason', () => {
    const closed = closeInterruptedTrace(runningTrace(), SUPERSEDED_REASON);
    expect(closed.status).toBe('stopping');
    expect(closed.status).not.toBe('running');
    expect(closed.error).toBe(SUPERSEDED_REASON);
    expect(closed.updatedAt).toBeGreaterThanOrEqual(2);
  });

  it('never leaves the trace running or stopping-reopenable: later stale closes cannot overwrite the reason', () => {
    // After the supersede close, the aborted loop's stale AGENT_LOOP_COMPLETE
    // handler runs closeInterruptedTrace again with the generic stopped text
    // (closePersistedInlineAgentTraceByLoopId). Idempotency must keep the
    // supersede reason, not resurrect the run or rewrite the error.
    const superseded = closeInterruptedTrace(runningTrace(), SUPERSEDED_REASON);
    const staleClose = closeInterruptedTrace(
      superseded,
      translate('en', 'content.agent.stopped'),
    );
    expect(staleClose).toBe(superseded);
    expect(staleClose.error).toBe(SUPERSEDED_REASON);
  });

  it('keeps the status vocabulary unchanged (union untouched)', () => {
    const closed = closeInterruptedTrace(runningTrace(), SUPERSEDED_REASON);
    const allowed = ['idle', 'running', 'stopping', 'complete', 'error'];
    expect(allowed).toContain(closed.status);
  });
});

describe('supersede acknowledgment strings are i18n-backed (en + zh-CN)', () => {
  it('has non-empty supersede and refusal reasons in both locales', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      expect(translate(locale, 'content.agent.superseded').length).toBeGreaterThan(0);
      expect(translate(locale, 'content.agent.midRunRefused').length).toBeGreaterThan(0);
    }
    expect(translate('zh-CN', 'content.agent.superseded')).not.toBe(
      translate('en', 'content.agent.superseded'),
    );
  });
});

describe('content-script wiring of the supersede path (source contract)', () => {
  const contentSource = readFileSync('entrypoints/content.ts', 'utf8');

  it('routes mid-run turns through the extracted decision instead of the silent guard toast', () => {
    expect(contentSource).toContain('decideMidRunTurn({');
    expect(contentSource).not.toContain('content.agent.concurrencyGuard');
  });

  it('aborts the old loop through the existing stop path carrying the supersede reason', () => {
    expect(contentSource).toMatch(
      /stopInlineAgent\(\s*contentT\("content\.agent\.superseded"\)\s*\)/,
    );
  });

  it('starts the fresh loop through the existing owned-loop start (no second loop implementation)', () => {
    // The supersede branch falls through to the same tail every loop start
    // uses: startOwnedInlineAgentLoop(payload) is the single owned-loop launch
    // call site.
    expect(contentSource.match(/startOwnedInlineAgentLoop\(payload\)/g)?.length).toBe(1);
  });

  it('renders the refusal persistently in the running panel, not as a transient toast', () => {
    expect(contentSource).toContain('appendAgentConsoleNotice(');
    expect(contentSource).toContain('content.agent.midRunRefused');
  });
});
