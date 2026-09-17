/**
 * Mid-run user turn decision (P0.1 interruption honesty, ruling R1).
 *
 * A real user turn arriving while an inline-agent loop is running must never
 * be silently swallowed. The decided semantics are SUPERSEDE: abort the
 * running loop through the existing stop/teardown paths (honest terminal
 * trace status; the in-flight-only auto-resume can never resurrect an
 * aborted loop) and start a fresh loop whose prompt is the user's turn text
 * (existing initial-prompt bytes only). A turn that cannot anchor a fresh
 * loop (missing session/message identifiers or missing tool-authorization
 * grant — provable from the fresh-start requirements in content.ts) is
 * visibly REFUSED instead: the running loop is kept and the refusal is
 * rendered persistently in the running panel, never as a transient toast.
 *
 * Pure decision table — content.ts owns the state reads and the side effects
 * (stopInlineAgent, panel notice, fresh loop start).
 */

import type { ToolExecutionRecord } from '../types';

export interface MidRunTurnInput {
  /** An inline-agent loop is currently mid-flight (live, un-aborted controller). */
  loopRunning: boolean;
  /**
   * The turn is the loop's own continuation/resume request. Those turns are
   * internal protocol and are skipped before any supersede decision (they
   * never represent user input).
   */
  isAgentOwnTurn: boolean;
  /**
   * The turn carries the identifiers a fresh loop anchors to
   * (chatSessionId + assistantMessageId on the RESPONSE_COMPLETE payload).
   */
  hasFreshLoopAnchor: boolean;
  /**
   * The turn carries a tool-authorization grant whose descriptors a fresh
   * loop inherits (augmentation succeeded for this request).
   */
  hasTurnAuthorization: boolean;
}

export type MidRunTurnDecision =
  /** Internal loop turn: existing early return, no user-facing action. */
  | { action: 'skip' }
  /** No loop running: normal start path, nothing to supersede. */
  | { action: 'proceed' }
  /** Stop the running loop honestly, then start a fresh loop on this turn. */
  | { action: 'supersede' }
  /** Fresh loop impossible: keep the running loop, refuse visibly and persistently. */
  | { action: 'refuse' };

export function decideMidRunTurn(input: MidRunTurnInput): MidRunTurnDecision {
  if (input.isAgentOwnTurn) return { action: 'skip' };
  if (!input.loopRunning) return { action: 'proceed' };
  if (input.hasFreshLoopAnchor && input.hasTurnAuthorization) {
    return { action: 'supersede' };
  }
  return { action: 'refuse' };
}

/** The anchor identifiers a fresh inline-agent loop requires on a turn. */
export interface InlineAgentLoopAnchor {
  chatSessionId: string;
  assistantMessageId: number;
}

/**
 * THE anchor predicate for starting a fresh inline-agent loop off a
 * RESPONSE_COMPLETE turn, and a type guard: passing it narrows the turn's
 * `chatSessionId`/`assistantMessageId` to the non-null anchor shape, so the
 * fresh-start bail guard and the payload construction share one authority —
 * the supersede decision and the guard can never disagree.
 *
 * Semantics mirror the released fresh-start guard exactly
 * (`!chatSessionId || assistantMessageId == null`): the request producer
 * passes blank `""` session ids through (`typeof === "string"`), and the
 * codebase convention treats a blank session id as ABSENT. Evaluating a
 * blank-but-non-null session id as present would let a mid-run turn supersede
 * (kill) the running loop and then bail at the fresh-start guard — the exact
 * silent loss P0.1 removes. `0` is a legal message id, so only `null`
 * disqualifies it.
 */
export function canAnchorFreshLoop<
  T extends { chatSessionId: string | null; assistantMessageId: number | null },
>(turn: T): turn is T & InlineAgentLoopAnchor {
  return !!turn.chatSessionId && turn.assistantMessageId !== null;
}

/**
 * THE fresh-loop start gate over a turn's executed tools: EVERY completed
 * (non-pending) tool execution makes the turn a loop-starting turn. The
 * structured loop owns the presentation and continuation of any executed
 * tool — shell_exec exactly like web_search — so there is no continuable
 * subset anymore. A pending start (artifact still streaming) is not an
 * execution yet and must never start a loop; an interrupted (incomplete
 * streamed) call stays included so the loop can see the failure and recover.
 */
export function selectStartableToolExecutions(
  executions: readonly ToolExecutionRecord[],
): ToolExecutionRecord[] {
  return executions.filter((execution) => !execution.pending);
}
