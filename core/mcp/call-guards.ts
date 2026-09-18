import type { JsonValue, ToolDescriptor } from '../tool/types';

/**
 * Model-boundary guards for MCP tool calls (wave 2, 2026-09-18).
 *
 * ANSI leak: shell hosts colorize stderr/stdout with terminal escape codes;
 * those bytes are meaningful in a terminal but pure noise (wasted tokens,
 * confused model answers) in a tool result. They are stripped once here, at
 * the result-normalization boundary, so the model AND the work-log row see
 * the same clean text.
 *
 * Empty arguments: a call whose arguments are `{}` (or missing required
 * fields) used to be dispatched to the provider and rejected there. The gate
 * below refuses it client-side with the same structured, retryable channel
 * before any privileged dispatch happens.
 */

const CSI_SEQUENCE = '\u001B\\[[0-9;:?]*[ -/]*[@-~]';
const OSC_SEQUENCE = '\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\?)';
const FE_SEQUENCE = '\u001B[@-Z\\-_]';

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${OSC_SEQUENCE}|${CSI_SEQUENCE}|${FE_SEQUENCE}`,
  'g',
);

const MAX_STRIP_DEPTH = 8;

export function stripAnsiEscapeSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

export function stripAnsiInDepth<T>(value: T, depth = 0): T {
  if (depth > MAX_STRIP_DEPTH) return value;
  if (typeof value === 'string') return stripAnsiEscapeSequences(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => stripAnsiInDepth(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      next[key] = stripAnsiInDepth(item, depth + 1);
    }
    return next as unknown as T;
  }
  return value;
}

export type McpToolCallArgumentsCheck =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Fail-closed client-side validation of a model tool call's arguments against
 * the descriptor's declared schema. An empty body is refused whenever the
 * schema declares any parameter; tools that genuinely take no arguments are
 * unaffected. The refusal text is model-facing wire protocol (English), like
 * the parser's structured errors.
 */
export function validateMcpToolCallArguments(
  payload: unknown,
  descriptor?: ToolDescriptor,
): McpToolCallArgumentsCheck {
  const schema = descriptor?.inputSchema;
  const properties = schema?.properties;
  const required = schema?.required ?? [];
  const declaresParameters =
    Boolean(properties && Object.keys(properties).length > 0) || required.length > 0;

  const isObject =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload);
  const keys = isObject ? Object.keys(payload as Record<string, unknown>) : [];

  if (!isObject) {
    if (declaresParameters) {
      return {
        ok: false,
        message: 'Tool call arguments must be a JSON object with the required parameters. Re-send the call with the required arguments.',
      };
    }
    return { ok: true };
  }

  if (keys.length === 0 && declaresParameters) {
    return {
      ok: false,
      message: required.length > 0
        ? `Tool call had empty arguments, but this tool requires: ${required.join(', ')}. Re-send the call with the required arguments.`
        : 'Tool call had empty arguments, but this tool declares parameters. Re-send the call with the required arguments.',
    };
  }

  if (keys.length > 0 && required.length > 0) {
    const record = payload as Record<string, unknown>;
    const missing = required.filter((name) => {
      const item = record[name];
      if (item === undefined || item === null) return true;
      if (typeof item === 'string' && item.trim() === '') return true;
      return false;
    });
    if (missing.length > 0) {
      return {
        ok: false,
        message: `Tool call is missing required arguments: ${missing.join(', ')}. Re-send the call with the required arguments.`,
      };
    }
  }

  return { ok: true };
}
