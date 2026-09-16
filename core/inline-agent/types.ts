import type { ToolCall, ToolDescriptor, ToolExecutionRecord } from '../types';
import type { SupportedLocale } from '../i18n';

export interface InlineAgentStartPayload {
  loopId: string;
  /** Stable scope inherited from the user turn that exposed capability handles. */
  capabilityScopeRequestId?: string;
  chatSessionId: string;
  parentMessageId: number;
  originalPrompt: string;
  agentTaskPrompt: string;
  toolExecutions: ToolExecutionRecord[];
  promptOptions: InlineAgentPromptOptions;
  toolDescriptors: ToolDescriptor[];
  locale?: SupportedLocale;
  powWasmUrl?: string;
  /**
   * Model backend for this loop (B2). Defaults to `'web'` (released
   * DeepSeek-web path, golden-locked). `'official-api'` runs the same pi
   * loop over the DeepSeek official API (OpenAI-compatible messages +
   * reasoning); the caller selects it when an official API key is
   * configured, matching the sidepanel chat auto-switch semantics.
   */
  modelBackend?: 'web' | 'official-api';
}

export interface InlineAgentPromptOptions {
  modelType: string | null;
  searchEnabled: boolean;
  thinkingEnabled: boolean;
  refFileIds: string[];
}

export type InlineAgentStepStatus = 'streaming' | 'executing_tools' | 'complete' | 'error';
export type InlineAgentLoopStatus = 'idle' | 'running' | 'stopping' | 'complete' | 'error';

export interface InlineAgentStepState {
  index: number;
  status: InlineAgentStepStatus;
  streamedText: string;
  toolCalls: ToolCall[];
  toolExecutions: ToolExecutionRecord[];
  responseMessageId: number | null;
}

export interface InlineAgentLoopState {
  loopId: string;
  chatSessionId: string;
  parentMessageId: number | null;
  status: InlineAgentLoopStatus;
  currentStepIndex: number;
  steps: InlineAgentStepState[];
  totalToolExecutions: number;
  startedAt: number;
}

export interface InlineAgentTraceStepRecord {
  index: number;
  status: InlineAgentStepStatus;
  text: string;
  /** Accumulated reasoning/thinking text of the step, when the backend captured it. */
  reasoning?: string;
  toolExecutions: ToolExecutionRecord[];
  responseMessageId: number | null;
  collapsed: boolean;
}

export interface InlineAgentTraceRecord {
  id: string;
  loopId: string;
  chatSessionId: string;
  anchorMessageId: number;
  anchorMessageIndex?: number | null;
  anchorContent?: string;
  /**
   * Parent inline-agent trace when this record is a subagent child run
   * (P1 subagent feature); `undefined` means "parentless". OPTIONAL NULLABLE
   * by decision (the single approved storage addition, constraint 1):
   * no key/name/shape/migration change — the field rides on rows in the
   * EXISTING `dpp_inline_agent_traces` key, existing readers already tolerate
   * unknown fields, old code ignores it, and new code treats undefined as
   * parentless. Backward compatible in both directions; enables hierarchy
   * rendering and parent-status honesty accounting with zero migration cost.
   */
  parentTraceId?: string;
  url: string;
  originalPrompt: string;
  agentTaskPrompt: string;
  status: InlineAgentLoopStatus;
  steps: InlineAgentTraceStepRecord[];
  /**
   * Tool executions of the ORIGINAL native turn that triggered the agent
   * (the full pre-loop execution set, including non-continuable tools such
   * as memory_save). Persisted so a restored console renders the complete
   * run record: the old-style tool block is suppressed for agent-owned
   * messages, and these executions render as the first (new style) tool
   * group instead — the count must not be lost on refresh.
   */
  initialExecutions?: ToolExecutionRecord[];
  totalSteps: number;
  totalTools: number;
  finalText: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InlineAgentStreamChunkMsg {
  loopId: string;
  stepIndex: number;
  text: string;
  fullText: string;
}

/** Reasoning/thinking deltas of the current step (real content, live). */
export interface InlineAgentReasoningChunkMsg {
  loopId: string;
  stepIndex: number;
  fullText: string;
}

export interface InlineAgentToolDetectedMsg {
  loopId: string;
  stepIndex: number;
  call: ToolCall;
}

export interface InlineAgentStepCompleteMsg {
  loopId: string;
  stepIndex: number;
  responseMessageId: number | null;
  toolExecutions: ToolExecutionRecord[];
}

export interface InlineAgentLoopCompleteMsg {
  loopId: string;
  totalSteps: number;
  totalTools: number;
  finalText: string;
}

export interface InlineAgentLoopErrorMsg {
  loopId: string;
  stepIndex: number;
  totalTools: number;
  error: string;
}

/**
 * Structured payload of the subagent-spawn preset tool (P1, decided design):
 * what a parent inline-agent run passes when spawning one child run. The
 * task text is required; the tool allowlist is an advisory HINT only — the
 * child's executable descriptor set is derived by the engine (subagent-spawn
 * itself excluded, depth 1), never taken verbatim from the model.
 */
export interface InlineAgentSubagentSpawnPayload {
  task: string;
  toolAllowlistHint?: string[];
}

export const INLINE_AGENT_MAX_STEPS = 25;
export const INLINE_AGENT_MAX_NUDGES = 8;
// Auto-resume budget (fix/v1.14.1-tool-loop): after an interrupted turn
// (server cut / timeout after chunks / PoW failure) the conversation chain is
// still continuable, so the adapter may start a fresh engine run with a
// resume prompt. This caps how many times one loop may do that, shared
// across the whole run.
export const INLINE_AGENT_MAX_RESUMES = 3;
export const INLINE_AGENT_STEP_TIMEOUT_MS = 120_000;
// Tool-execution deadline (fix/v1.14.1-tool-loop): 3x the stream step
// timeout — generous for legitimately long browser_control/shell tools, but
// bounded so a stranded background handler cannot freeze the loop at
// `executing_tools` forever.
export const INLINE_AGENT_TOOL_CALL_TIMEOUT_MS = 180_000;
export const INLINE_AGENT_REQUEST_DELAY_MIN_MS = 2_500;
export const INLINE_AGENT_REQUEST_DELAY_MAX_MS = 6_500;
// Subagent caps (P1, decided design): depth is fixed at 1 level (children
// never spawn grandchildren). CONCURRENT bounds how many child runs may be
// live at once per parent run; PER_RUN bounds the total spawns across the
// whole parent run. Overflow REFUSES with a structured tool error the model
// sees — no queue. Values are configurable constants following the
// INLINE_AGENT_MAX_RESUMES pattern; enforcement lands with the child-run
// engine (M4).
export const INLINE_AGENT_SUBAGENT_MAX_CONCURRENT = 2;
export const INLINE_AGENT_SUBAGENT_MAX_PER_RUN = 6;
export const INLINE_AGENT_SUBAGENT_MAX_DEPTH = 1;
