/**
 * P1 subagent child-run engine (M4, decided design R3-R10).
 *
 * Runs one or more child inline-agent loops to completion by REUSING
 * `runPiInlineAgentLoop` — there is no second loop implementation: a child
 * inherits the full released parser surface (direct XML tags + legacy DSML +
 * corrected double-bar near-miss with parseError feedback), the released
 * pacing (`waitBetweenDeepSeekRequests` per run), step/nudge/resume semantics,
 * and the AGENT_* event protocol, byte-for-byte.
 *
 * Rulings implemented here:
 *  - R5 caps: `INLINE_AGENT_SUBAGENT_MAX_CONCURRENT` across concurrently
 *    executing children, `INLINE_AGENT_SUBAGENT_MAX_PER_RUN` per parent-run
 *    lifetime. Overflow REFUSES with a structured, model-visible refusal
 *    result — no queue machinery.
 *  - Depth 1: `deriveChildToolDescriptors` always excludes the subagent-spawn
 *    descriptor, so a child can never spawn grandchildren; the optional
 *    `toolAllowlistHint` is ENFORCED as an intersection (least privilege) with
 *    the available descriptors and unknown hint names are ignored (R10).
 *  - R7 chain isolation: every child loop gets a FRESH `DeepSeekSessionState`
 *    (created inside `runPiInlineAgentLoop` per invocation) anchored at the
 *    injected `chainParentMessageId` number — a child can never touch the
 *    parent's session or its `parentMessageId`.
 *  - R8 synchronous spawn: the spawn promise's resolution IS the child run's
 *    outcome (structured) or a structured failure. It NEVER rejects, so a
 *    child failure always reaches the parent as a tool result. Each child is
 *    bounded by the released tool-execution deadline
 *    (`INLINE_AGENT_TOOL_CALL_TIMEOUT_MS`): on deadline or parent abort the
 *    engine tears the child down through its own AbortController and settles
 *    with an honest structured failure after a bounded grace wait.
 *  - R6 traces: child runs write rows to the EXISTING
 *    `dpp_inline_agent_traces` store (optional `parentTraceId` set, M3 field).
 *    Every child row is closed with a terminal status on every settlement
 *    path — `closeInterruptedTrace` is reused for the interrupted closures, so
 *    no run persists `running` after terminal (constraint 2).
 *
 * The spawn TOOL descriptor registration, content.ts authorization wiring and
 * renderer hierarchy are M5 — this module is the engine M5's executor calls.
 */
import { runPiInlineAgentLoop } from './pi/loop-adapter';
import type { ExecuteToolFn } from './pi/loop-adapter';
import { closeInterruptedTrace } from './trace-status';
import { upsertPersistedInlineAgentTrace } from './trace-store';
import type {
  InlineAgentLoopStatus,
  InlineAgentPromptOptions,
  InlineAgentStartPayload,
  InlineAgentSubagentSpawnPayload,
  InlineAgentTraceRecord,
  InlineAgentTraceStepRecord,
} from './types';
import {
  INLINE_AGENT_SUBAGENT_MAX_CONCURRENT,
  INLINE_AGENT_SUBAGENT_MAX_PER_RUN,
  INLINE_AGENT_TOOL_CALL_TIMEOUT_MS,
} from './types';
import type { SupportedLocale } from '../i18n';
import type { ToolDescriptor } from '../types';

/**
 * Canonical invocation name of the subagent-spawn tool descriptor. M5
 * registers the preset tool with this `invocationName`; the engine excludes
 * it from every child descriptor set (depth 1) regardless of any allowlist
 * hint (R10).
 */
export const INLINE_AGENT_SUBAGENT_INVOCATION_NAME = 'subagent_spawn';

/**
 * Bounded wait for a child loop to settle after its abort fired before the
 * engine force-closes the trace and reports the structured failure (covers a
 * stranded tool handler that ignores the abort). The released tool deadline
 * has already elapsed by the time this runs.
 */
export const INLINE_AGENT_SUBAGENT_TEARDOWN_GRACE_MS = 5_000;

/** Why a spawn never started a child (R5: REFUSE, no queue). */
export type InlineAgentSubagentRefusalCode =
  | 'subagent_concurrency_cap'
  | 'subagent_per_run_cap';

/** Structured, model-visible refusal of a spawn (becomes the tool result). */
export interface InlineAgentSubagentRefusal {
  ok: false;
  refused: true;
  code: InlineAgentSubagentRefusalCode;
  /** Model-visible reason text. */
  message: string;
}

/** Honest terminal status of a settled child run. */
export type InlineAgentSubagentOutcomeStatus = Extract<
  InlineAgentLoopStatus,
  'complete' | 'error' | 'stopping'
>;

/** Structured outcome of one child run (R8: the spawn result IS the outcome). */
export interface InlineAgentSubagentOutcome {
  /** True only when the child completed; every other settlement is a failure the model sees. */
  ok: boolean;
  refused: false;
  childTraceId: string;
  childLoopId: string;
  /** `complete` | `error` (child loop failed) | `stopping` (aborted or deadline). */
  status: InlineAgentSubagentOutcomeStatus;
  finalText: string;
  totalSteps: number;
  totalTools: number;
  /** Failure reason for `error`/`stopping` settlements. */
  error?: string;
  /** True when the child was torn down by the tool-execution deadline (R8). */
  deadlineExceeded: boolean;
}

export type InlineAgentSubagentSpawnResult =
  | InlineAgentSubagentOutcome
  | InlineAgentSubagentRefusal;

/** One spawn request: the parsed model payload plus the child chain anchor. */
export interface InlineAgentSubagentSpawnRequest {
  /** Parsed spawn payload from the model (task + optional allowlist hint). */
  payload: InlineAgentSubagentSpawnPayload;
  /**
   * Message id the child's DS-web conversation chain anchors to (the parent
   * run's live anchor). The child's OWN session starts here and advances
   * independently (R7 isolation); the official-api backend ignores the page
   * anchor (its chain authority is the pi Context transcript).
   */
  chainParentMessageId: number;
}

/**
 * Injected dependencies of the subagent engine (narrow ports; the engine
 * never touches the DOM, chrome storage, or authorization itself).
 */
export interface InlineAgentSubagentRunnerDeps {
  /** Parent run's trace id — namespaces child trace ids and the parentTraceId link. */
  parentTraceId: string;
  /** Parent run's loop id — namespaces child loop ids. */
  parentLoopId: string;
  chatSessionId: string;
  /** Page URL recorded on child trace rows (the parent's tool-block URL). */
  traceUrl: string;
  /** Prompt options the child inherits from the parent run. */
  promptOptions: InlineAgentPromptOptions;
  /**
   * Descriptors the parent can expose to children. The child set is derived
   * per spawn: subagent-spawn excluded (depth 1), intersected with the hint.
   */
  toolDescriptors: readonly ToolDescriptor[];
  /**
   * The authorized tool-execution path for children (the existing
   * grant-checking `executeTool`; M5 binds the child's authorization).
   * Never bypassed — there is no second execution path.
   */
  executeTool: ExecuteToolFn;
  /**
   * The parent run's abort signal: aborting it aborts every live child
   * (abort propagation into children).
   */
  signal: AbortSignal;
  /**
   * Child trace persistence. Defaults to the EXISTING
   * `dpp_inline_agent_traces` singleton (same default-parameter pattern as
   * `createInlineAgentTraceStore`); tests inject an in-memory store.
   */
  upsertTrace?: (trace: InlineAgentTraceRecord) => Promise<void>;
  locale?: SupportedLocale;
  powWasmUrl?: string;
  /** Backend selection is the caller's authority (B2); the engine forwards it. */
  modelBackend?: 'web' | 'official-api';
  /** Authorization scope id forwarded into the child payload's call source. */
  capabilityScopeRequestId?: string;
}

export interface InlineAgentSubagentRunner {
  /**
   * Runs one child inline-agent loop to completion and resolves with its
   * structured outcome, or with a structured refusal when a cap is exhausted.
   * NEVER rejects and never starts a child on refusal — the resolved result
   * is the parent's tool result (R8).
   */
  spawn(request: InlineAgentSubagentSpawnRequest): Promise<InlineAgentSubagentSpawnResult>;
}

/**
 * Builds the per-parent-run subagent engine. One runner per parent run: it
 * owns the run's concurrency window, per-run spawn budget, and child
 * sequence numbers.
 */
export function createInlineAgentSubagentRunner(
  deps: InlineAgentSubagentRunnerDeps,
): InlineAgentSubagentRunner {
  const persist = deps.upsertTrace ?? upsertPersistedInlineAgentTrace;
  let nextSequence = 0;
  let startedRuns = 0;
  const inFlight = new Set<Promise<InlineAgentSubagentSpawnResult>>();

  function spawn(
    request: InlineAgentSubagentSpawnRequest,
  ): Promise<InlineAgentSubagentSpawnResult> {
    // R5 cap gates run synchronously BEFORE any child work: overflow refuses
    // with a structured result the model sees — no queue, no silent drop.
    if (inFlight.size >= INLINE_AGENT_SUBAGENT_MAX_CONCURRENT) {
      return Promise.resolve({
        ok: false,
        refused: true,
        code: 'subagent_concurrency_cap',
        message:
          `Subagent concurrency cap reached (${INLINE_AGENT_SUBAGENT_MAX_CONCURRENT} child runs are already executing). `
          + 'Wait for the running subagents to finish before spawning another one.',
      } satisfies InlineAgentSubagentRefusal);
    }
    if (startedRuns >= INLINE_AGENT_SUBAGENT_MAX_PER_RUN) {
      return Promise.resolve({
        ok: false,
        refused: true,
        code: 'subagent_per_run_cap',
        message:
          `Subagent per-run cap reached (at most ${INLINE_AGENT_SUBAGENT_MAX_PER_RUN} subagent runs per parent run). `
          + 'Continue the task without spawning more subagents.',
      } satisfies InlineAgentSubagentRefusal);
    }
    const sequence = nextSequence += 1;
    startedRuns += 1;
    const run: Promise<InlineAgentSubagentSpawnResult> = runChild(request, sequence)
      .finally(() => {
        inFlight.delete(run);
      });
    // Registered synchronously so concurrent spawn calls in one model step
    // observe the cap deterministically.
    inFlight.add(run);
    return run;
  }

  return { spawn };

  // -------------------------------------------------------------------------

  async function runChild(
    request: InlineAgentSubagentSpawnRequest,
    sequence: number,
  ): Promise<InlineAgentSubagentSpawnResult> {
    const childTraceId = `subagent:${deps.parentTraceId}:${sequence}`;
    const childLoopId = `subagent:${deps.parentLoopId}:${sequence}`;
    const task = request.payload.task;

    // Depth-1 descriptor set: spawn excluded, hint intersected (R5/R10).
    const toolDescriptors = deriveChildToolDescriptors(
      deps.toolDescriptors,
      request.payload.toolAllowlistHint,
    );

    // Abort wiring: the child dies when the parent aborts (propagation in)
    // or when the released tool deadline expires (R8). Nothing else aborts it.
    const childAbort = new AbortController();
    const propagateParentAbort = () => {
      childAbort.abort(new DOMException('Parent inline-agent run aborted.', 'AbortError'));
    };
    if (deps.signal.aborted) propagateParentAbort();
    else deps.signal.addEventListener('abort', propagateParentAbort, { once: true });

    const startedAt = Date.now();
    const record: InlineAgentTraceRecord = {
      id: childTraceId,
      loopId: childLoopId,
      chatSessionId: deps.chatSessionId,
      anchorMessageId: request.chainParentMessageId,
      parentTraceId: deps.parentTraceId,
      url: deps.traceUrl,
      originalPrompt: task,
      agentTaskPrompt: task,
      status: 'running',
      steps: [],
      totalSteps: 0,
      totalTools: 0,
      finalText: '',
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    let deadlineFired = false;
    const deadlineTimer = setTimeout(() => {
      deadlineFired = true;
      childAbort.abort(new DOMException(
        'Subagent run exceeded the tool execution deadline.',
        'TimeoutError',
      ));
    }, INLINE_AGENT_TOOL_CALL_TIMEOUT_MS);

    // Terminal event recorded by the child's event sink (first one wins;
    // post-teardown ghost events from a detached loop are ignored). Held in a
    // mutable ref so the event closure's writes stay visible to the checks.
    const terminal: {
      current:
        | { kind: 'complete'; finalText: string; totalSteps: number; totalTools: number }
        | { kind: 'error'; error: string; totalSteps: number; totalTools: number }
        | null;
    } = { current: null };

    const recordEvent = (type: string, data: unknown): void => {
      switch (type) {
        case 'AGENT_STEP_STARTED': {
          const { stepIndex } = data as { stepIndex: number };
          const step: InlineAgentTraceStepRecord = {
            index: stepIndex,
            status: 'streaming',
            text: '',
            toolExecutions: [],
            responseMessageId: null,
            collapsed: true,
          };
          record.steps = [
            ...record.steps.filter((item) => item.index !== stepIndex),
            step,
          ].sort((a, b) => a.index - b.index);
          record.totalSteps = Math.max(record.totalSteps, stepIndex + 1);
          break;
        }
        case 'AGENT_STREAM_CHUNK': {
          const { stepIndex, fullText } = data as { stepIndex: number; fullText: string };
          const step = record.steps.find((item) => item.index === stepIndex);
          if (step) step.text = fullText;
          break;
        }
        case 'AGENT_REASONING_CHUNK': {
          const { stepIndex, fullText } = data as { stepIndex: number; fullText: string };
          const step = record.steps.find((item) => item.index === stepIndex);
          if (step) step.reasoning = fullText;
          break;
        }
        case 'AGENT_STEP_COMPLETE': {
          const msg = data as {
            stepIndex: number;
            responseMessageId: number | null;
            toolExecutions: ToolExecutionRecordOf;
          };
          const step = record.steps.find((item) => item.index === msg.stepIndex);
          if (step) {
            step.status = 'complete';
            step.toolExecutions = [...msg.toolExecutions];
            step.responseMessageId = msg.responseMessageId;
          }
          record.totalTools += msg.toolExecutions.length;
          break;
        }
        case 'AGENT_LOOP_COMPLETE': {
          if (terminal.current) break;
          const msg = data as { totalSteps: number; totalTools: number; finalText: string };
          terminal.current = {
            kind: 'complete',
            finalText: msg.finalText,
            totalSteps: msg.totalSteps,
            totalTools: msg.totalTools,
          };
          break;
        }
        case 'AGENT_LOOP_ERROR': {
          if (terminal.current) break;
          const msg = data as { totalTools: number; error: string };
          terminal.current = {
            kind: 'error',
            error: msg.error,
            totalSteps: record.totalSteps,
            totalTools: msg.totalTools,
          };
          break;
        }
        default:
          break;
      }
    };

    try {
      // The running child row is persisted BEFORE the loop starts so the
      // hierarchy (parentTraceId) is queryable while the child is in flight.
      await persist({ ...record });
      // The authoritative loop entry: a child IS a released inline-agent run.
      const loopDone: Promise<string | null> = runPiInlineAgentLoop({
        payload: buildChildPayload(request, childLoopId, toolDescriptors, task),
        post: recordEvent,
        executeTool: deps.executeTool,
        signal: childAbort.signal,
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      const settledCleanly = await awaitSettledOrGrace(loopDone, childAbort.signal);
      const teardownNotice = deadlineFired
        ? `Subagent run stopped: it exceeded the ${Math.round(INLINE_AGENT_TOOL_CALL_TIMEOUT_MS / 1000)}s tool execution deadline.`
        : 'Subagent run stopped because the parent run aborted.';

      if (terminal.current) {
        // Terminal event: apply the loop's own accounting, then pick the
        // honest status — a torn-down run never reports 'complete' even when
        // the adapter's silent-abort terminal arrived.
        const seen = terminal.current;
        record.totalSteps = seen.totalSteps;
        record.totalTools = seen.totalTools;
        if (seen.kind === 'error') {
          record.status = 'error';
          record.error = seen.error;
        } else if (deadlineFired || childAbort.signal.aborted) {
          record.status = 'stopping';
          record.error = teardownNotice;
          record.finalText = '';
        } else {
          record.status = 'complete';
          record.finalText = seen.finalText;
        }
      } else {
        // No terminal event arrived (the loop settled without one — adapter
        // contract violation — or the grace expired on a stranded loop):
        // force-close through the EXISTING interrupted-trace pattern so no
        // child row can persist as `running` (constraint 2).
        const adapterError = settledCleanly ? await loopDone : null;
        const closed = closeInterruptedTrace(
          record,
          adapterError ?? teardownNotice,
          {
            status: 'stopping',
            totalSteps: record.totalSteps,
          },
        );
        record.status = closed.status;
        record.error = closed.error;
        record.updatedAt = closed.updatedAt;
      }

      await persist({ ...record });
      const status: InlineAgentSubagentOutcomeStatus =
        record.status === 'complete' ? 'complete'
        : record.status === 'error' ? 'error'
        : 'stopping';
      return {
        ok: status === 'complete',
        refused: false,
        childTraceId,
        childLoopId,
        status,
        finalText: record.finalText,
        totalSteps: record.totalSteps,
        totalTools: record.totalTools,
        ...(record.error !== undefined ? { error: record.error } : null),
        deadlineExceeded: deadlineFired,
      } satisfies InlineAgentSubagentOutcome;
    } catch (error) {
      // The engine's contract (R8): spawn NEVER rejects — an unexpected
      // settlement (e.g. a persistence failure) still reaches the parent as a
      // structured failure, with the child trace force-closed honestly.
      const message = error instanceof Error ? error.message : String(error);
      try {
        const closed = closeInterruptedTrace(record, message, {
          status: 'stopping',
          totalSteps: record.totalSteps,
        });
        await persist({ ...record, ...closed, status: closed.status });
      } catch {
        // The structured failure below already carries the original error;
        // nothing further can be persisted.
      }
      return {
        ok: false,
        refused: false,
        childTraceId,
        childLoopId,
        status: 'error',
        finalText: record.finalText,
        totalSteps: record.totalSteps,
        totalTools: record.totalTools,
        error: message,
        deadlineExceeded: deadlineFired,
      } satisfies InlineAgentSubagentOutcome;
    } finally {
      clearTimeout(deadlineTimer);
      deps.signal.removeEventListener('abort', propagateParentAbort);
    }
  }

  function buildChildPayload(
    request: InlineAgentSubagentSpawnRequest,
    childLoopId: string,
    toolDescriptors: ToolDescriptor[],
    task: string,
  ): InlineAgentStartPayload {
    return {
      loopId: childLoopId,
      capabilityScopeRequestId: deps.capabilityScopeRequestId,
      chatSessionId: deps.chatSessionId,
      // R7: the child chain anchors at the injected NUMBER — the child's
      // fresh session (created inside runPiInlineAgentLoop) is the single
      // owner of its own parentMessageId; the parent's session is untouched.
      parentMessageId: request.chainParentMessageId,
      originalPrompt: task,
      agentTaskPrompt: task,
      toolExecutions: [],
      promptOptions: deps.promptOptions,
      toolDescriptors,
      ...(deps.locale === undefined ? null : { locale: deps.locale }),
      ...(deps.powWasmUrl === undefined ? null : { powWasmUrl: deps.powWasmUrl }),
      ...(deps.modelBackend === undefined ? null : { modelBackend: deps.modelBackend }),
    };
  }
}

/**
 * Depth-1 + allowlist derivation (R5/R10): the child's executable descriptor
 * set is the available pool MINUS the subagent-spawn descriptor (always,
 * regardless of any hint), intersected with the advisory
 * `toolAllowlistHint` when one is present (least privilege); unknown hint
 * names are ignored.
 */
export function deriveChildToolDescriptors(
  available: readonly ToolDescriptor[],
  toolAllowlistHint: readonly string[] | undefined,
): ToolDescriptor[] {
  const pool = available.filter(
    (descriptor) => descriptor.invocationName !== INLINE_AGENT_SUBAGENT_INVOCATION_NAME,
  );
  if (!toolAllowlistHint || toolAllowlistHint.length === 0) return [...pool];
  const allowed = new Set(toolAllowlistHint);
  return pool.filter((descriptor) => allowed.has(descriptor.invocationName));
}

/**
 * Waits for the child loop to settle. Once the child's abort fires, the wait
 * stays bounded by the teardown grace so a stranded tool handler cannot keep
 * the parent's tool call hanging past its deadline; resolves true only when
 * the loop actually settled.
 */
function awaitSettledOrGrace(
  loopDone: Promise<string | null>,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      if (graceTimer !== null) clearTimeout(graceTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      if (finished) return;
      graceTimer = setTimeout(() => finish(settled), INLINE_AGENT_SUBAGENT_TEARDOWN_GRACE_MS);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void loopDone.then(() => finish(true));
  });
}

type ToolExecutionRecordOf = InlineAgentTraceStepRecord['toolExecutions'];
