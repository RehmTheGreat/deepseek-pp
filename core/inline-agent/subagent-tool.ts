/**
 * P1 subagent spawn TOOL surface (M5) — the registration and mapping half of
 * the subagent feature. Pure module: no DOM, no storage, no entrypoint
 * imports (AGENTS.md contract rule).
 *
 * Registration model (decided design Q1, "preset TOOL"):
 *  - The descriptor lives here as the SINGLE truth. Its `invocationName` is
 *    the IMPORTED engine constant `INLINE_AGENT_SUBAGENT_INVOCATION_NAME`, so
 *    a literal drift cannot silently disable the engine's depth-1 filter
 *    (`deriveChildToolDescriptors` removes exactly that invocation name from
 *    every child descriptor set).
 *  - It is NOT part of the shared model-facing prompt catalog: manual chat,
 *    sidepanel, and automation prompts stay byte-identical. It enters exactly
 *    one surface — agent-run authorization grants (background
 *    `CREATE_TOOL_AUTHORIZATION` merges it for `trigger === 'agent_run'`) —
 *    so the parent inline-agent loop can advertise it and execute it through
 *    the loop's authorized `executeTool` path.
 *  - Spawn EXECUTION is content-owned (the child loop needs the page session),
 *    so `content.ts` intercepts the call inside the loop's authorized
 *    executor closure and resolves it through the per-run runner created with
 *    the parent's AbortSignal. There is no second execution path.
 */
import { DEFAULT_LOCALE, translate, type SupportedLocale } from '../i18n/background';
import type { ToolDescriptor } from '../tool/types';
import type { InlineAgentSubagentSpawnPayload } from './types';
import {
  INLINE_AGENT_SUBAGENT_INVOCATION_NAME,
  type InlineAgentSubagentRefusalCode,
  type InlineAgentSubagentSpawnResult,
} from './subagent';

/** Local provider id owning the subagent-spawn preset tool. */
export const INLINE_AGENT_SUBAGENT_TOOL_PROVIDER_ID = 'inline_agent';

/**
 * Loop-id namespace of engine child runs (`subagent:<parentLoopId>:<n>`).
 * Exported from one place so the engine's id template and the renderer's
 * child-event router share a single truth.
 */
export const INLINE_AGENT_SUBAGENT_LOOP_ID_PREFIX = 'subagent:';

/**
 * The single authoritative descriptor of the subagent-spawn tool. The
 * `invocationName` MUST stay the imported engine constant (depth-seam test).
 */
export function createInlineAgentSubagentSpawnDescriptor(
  locale: SupportedLocale = DEFAULT_LOCALE,
): ToolDescriptor {
  return {
    id: `local:${INLINE_AGENT_SUBAGENT_TOOL_PROVIDER_ID}:${INLINE_AGENT_SUBAGENT_INVOCATION_NAME}`,
    provider: {
      kind: 'local',
      id: INLINE_AGENT_SUBAGENT_TOOL_PROVIDER_ID,
      displayName: translate(locale, 'tool.inlineAgent.displayName'),
      transport: 'in_process',
    },
    name: INLINE_AGENT_SUBAGENT_INVOCATION_NAME,
    invocationName: INLINE_AGENT_SUBAGENT_INVOCATION_NAME,
    title: translate(locale, 'tool.inlineAgent.spawnTitle'),
    description: translate(locale, 'tool.inlineAgent.spawnDescription'),
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: translate(locale, 'tool.inlineAgent.taskDescription'),
        },
        toolAllowlistHint: {
          type: 'array',
          items: { type: 'string' },
          description: translate(locale, 'tool.inlineAgent.hintDescription'),
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    execution: {
      mode: 'auto',
      enabled: true,
      risk: 'low',
    },
  };
}

/**
 * Appends the spawn descriptor to a descriptor pool exactly once (by id,
 * idempotent, input untouched). The parent loop's payload uses this so the
 * agent-run grant and the loop's model-facing descriptor set agree.
 */
export function withInlineAgentSubagentSpawnDescriptor(
  descriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  const spawn = createInlineAgentSubagentSpawnDescriptor();
  if (descriptors.some((descriptor) => descriptor.id === spawn.id)) {
    return [...descriptors];
  }
  return [...descriptors, spawn];
}

/** Narrow claim shape of a parsed model tool call (name is required). */
export interface InlineAgentSpawnCallClaim {
  name: string;
  invocationName?: string;
}

/** True only for the canonical subagent-spawn tool claims. */
export function isInlineAgentSubagentSpawnCall(call: InlineAgentSpawnCallClaim): boolean {
  return (
    call.invocationName === INLINE_AGENT_SUBAGENT_INVOCATION_NAME
    || (!call.invocationName && call.name === INLINE_AGENT_SUBAGENT_INVOCATION_NAME)
  );
}

export type InlineAgentSubagentSpawnPayloadParse =
  | { ok: true; payload: InlineAgentSubagentSpawnPayload }
  | { ok: false; message: string };

/**
 * Fail-closed validation of the model's spawn payload. The messages are
 * model-facing feedback (the same audience as the engine's structured
 * refusals and the parser's parseError codes, both English wire protocol).
 */
export function parseInlineAgentSubagentSpawnPayload(
  payload: unknown,
): InlineAgentSubagentSpawnPayloadParse {
  if (typeof payload !== 'object' || payload === null) {
    return {
      ok: false,
      message: 'subagent_spawn requires a payload object with a "task" string.',
    };
  }
  const candidate = payload as { task?: unknown; toolAllowlistHint?: unknown };
  if (typeof candidate.task !== 'string' || candidate.task.trim().length === 0) {
    return {
      ok: false,
      message: 'subagent_spawn requires a non-empty "task" string describing the subagent run.',
    };
  }
  if (candidate.toolAllowlistHint === undefined) {
    return { ok: true, payload: { task: candidate.task } };
  }
  if (
    !Array.isArray(candidate.toolAllowlistHint)
    || candidate.toolAllowlistHint.some((item) => typeof item !== 'string')
  ) {
    return {
      ok: false,
      message: 'subagent_spawn "toolAllowlistHint" must be an array of tool names when present.',
    };
  }
  return {
    ok: true,
    payload: {
      task: candidate.task,
      toolAllowlistHint: candidate.toolAllowlistHint as string[],
    },
  };
}

/** Pure mapping of a spawn result onto the tool-result surface (M4 note 4). */
export interface InlineAgentSubagentSpawnResultText {
  ok: boolean;
  summary: string;
  detail?: string;
  error?: {
    code: InlineAgentSubagentRefusalCode | 'subagent_run_failed';
    message: string;
    retryable: boolean;
  };
}

/**
 * Maps a SpawnResult to the tool result text the parent model sees:
 * `message` for refusals; `error` / `finalText` for outcomes (M4 wiring note
 * 4). `statusDetail` is a localized one-liner for the run-record surface; the
 * summary/error text itself stays the engine's model-facing protocol text.
 */
export function describeInlineAgentSubagentSpawnResult(
  locale: SupportedLocale,
  result: InlineAgentSubagentSpawnResult,
): InlineAgentSubagentSpawnResultText {
  if (result.refused) {
    return {
      ok: false,
      summary: result.message,
      error: {
        code: result.code,
        message: result.message,
        // A concurrency slot frees up; the per-run budget does not.
        retryable: result.code === 'subagent_concurrency_cap',
      },
    };
  }

  const statusWord = translate(
    locale,
    result.status === 'complete'
      ? 'content.agent.complete'
      : result.status === 'error'
        ? 'content.agent.error'
        : 'content.agent.stopped',
  );
  const statusDetail = translate(locale, 'content.agent.subagentStatusDetail', {
    status: statusWord,
    steps: result.totalSteps,
    tools: result.totalTools,
  });

  if (result.ok) {
    return {
      ok: true,
      summary: result.finalText || translate(locale, 'content.agent.subagentNoFinalText'),
      detail: statusDetail,
    };
  }
  const summary = result.error || statusDetail;
  return {
    ok: false,
    summary,
    detail: statusDetail,
    error: {
      code: 'subagent_run_failed',
      message: summary,
      // An aborted/stopping child cannot be retried inside the same run.
      retryable: result.status !== 'stopping',
    },
  };
}
