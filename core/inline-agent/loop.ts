/**
 * Inline agent loop entry (Issue A3-T2).
 *
 * The self-built loop engine was replaced by the pi-agent-core engine
 * (`core/inline-agent/pi/loop-adapter.ts`). This module is now a thin
 * composition root: it preserves the released public contract
 * (`runInlineAgentLoop(payload, deps)` with the same AGENT_* event protocol,
 * execution-policy, authorization and abort semantics) while delegating the
 * engine to the pi loop driven by the DS-web StreamFn and tool bridge.
 */
import { runPiInlineAgentLoop } from './pi/loop-adapter';
import type { PostFn, ExecuteToolFn } from './pi/loop-adapter';
import type { DeepSeekSessionState } from './pi/stream-fn-port';
import type { InlineAgentStartPayload } from './types';

export type { PostFn, ExecuteToolFn };

export interface InlineAgentLoopDeps {
  post: PostFn;
  executeTool: ExecuteToolFn;
  signal: AbortSignal;
  /**
   * M5 minimal read accessor: the loop adapter publishes its DS-web session
   * (the live chain anchor) here for the subagent-spawn executor.
   */
  sessionRef?: { current: DeepSeekSessionState | null };
}

export async function runInlineAgentLoop(
  payload: InlineAgentStartPayload,
  deps: InlineAgentLoopDeps,
): Promise<void> {
  const { post, executeTool, signal, sessionRef } = deps;
  return runPiInlineAgentLoop({ payload, post, executeTool, signal, sessionRef });
}
