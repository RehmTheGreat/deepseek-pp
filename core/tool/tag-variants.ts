/**
 * ONE shared tool-tag name resolution truth (fix round 4, D2).
 *
 * Models shorten advertised invocation names to the tool's plain descriptor
 * name (`mcp_t_<server>_tool_list` -> `<tool_list>`, live wire 2026-09-19).
 * Before this module the exact-name scanners silently ignored those bytes:
 * identical markup EXECUTED in one step (the model writing the full tag) and
 * leaked as visible prose with no model feedback in the next (trace pyr24x,
 * steps 0-3 vs step 4). Every surface (batch parser, streaming parser,
 * visible-text accumulator, page stream filter, history cleanup, DOM
 * scrubber) now scans the SAME extended tag set (`catalog.toolTagNames`) and
 * resolves matches through the SAME rule:
 *
 *  - the tag names an advertised tool EXACTLY (its invocation name, or its
 *    plain descriptor name when that name is unique across the advertised
 *    set - the catalog accepts those as aliases) -> the released clean path;
 *  - the tag names SEVERAL advertised tools -> a BLOCKING
 *    `tool_call_name_ambiguous` record naming every full advertised tag, so
 *    the model disambiguates through the existing structured feedback
 *    channel - never silence, never prose, never an arbitrary server guess.
 *
 * Pure string/record logic, zero browser/DOM imports.
 */
import type { ToolCall, ToolDescriptor, ToolError } from './types';
import {
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  type ToolInvocationCatalog,
} from './invocation';
import { TOOL_CALL_NAME_AMBIGUOUS_ERROR_CODE } from './execution-error';

export type ToolTagVariantResolution =
  | { kind: 'invocation' }
  | { kind: 'ambiguous'; invocationNames: string[] };

/**
 * Resolves a scanner-matched tag name against the advertised descriptors.
 * Names already in the catalog's invocation map (invocation names plus
 * accepted unique aliases) are the released exact path. Returns null when no
 * advertised tool claims the name (prose, not a call).
 */
export function resolveToolTagName(
  name: string,
  descriptorsOrCatalog: readonly ToolDescriptor[] | ToolInvocationCatalog,
): ToolTagVariantResolution | null {
  const catalog: ToolInvocationCatalog = Array.isArray(descriptorsOrCatalog)
    ? createToolInvocationCatalog(descriptorsOrCatalog as readonly ToolDescriptor[])
    : (descriptorsOrCatalog as ToolInvocationCatalog);
  if (catalog.descriptorByInvocationName.has(name)) return { kind: 'invocation' };
  const matches = catalog.descriptorsByName.get(name);
  if (!matches || matches.length <= 1) return null;
  return {
    kind: 'ambiguous',
    invocationNames: matches.map((descriptor) => descriptor.invocationName),
  };
}

function createNameAmbiguousError(
  name: string,
  invocationNames: string[],
): ToolError {
  return {
    code: TOOL_CALL_NAME_AMBIGUOUS_ERROR_CODE,
    message: `Tool tag <${name}> matches several advertised tools (${invocationNames
      .map((invocationName) => `<${invocationName}>`)
      .join(', ')}); use the full advertised tag name.`,
    retryable: true,
    details: { invocationName: name },
  };
}

export interface TagMatchCallOptions {
  payload?: Record<string, unknown>;
  raw: string;
  /** Existing parse error (e.g. a body JSON failure) - it wins over the name error. */
  parseError?: ToolError;
}

/**
 * Builds the ToolCall for a scanner-matched tag, applying the shared variant
 * rule. Exact names (invocation names plus accepted unique aliases) pass
 * through the released factory untouched (byte-for-byte block shape); an
 * ambiguous short name binds the record to the FIRST advertised candidate so
 * it flows through the engine's normal tool path (beforeToolCall), with the
 * parse error overridden by the structured ambiguity error - that error is
 * what reaches the model, naming every full advertised tag. The binding is
 * routing-only: the blocking error guarantees the call never executes and no
 * server is ever guessed.
 */
export function createToolCallFromTagMatch(
  name: string,
  catalog: ToolInvocationCatalog,
  options: TagMatchCallOptions,
): ToolCall {
  const resolution = resolveToolTagName(name, catalog);
  if (resolution && resolution.kind === 'ambiguous') {
    const bound = createToolCallFromInvocation(
      resolution.invocationNames[0],
      options.payload ?? {},
      options.raw,
      catalog,
    );
    return {
      ...bound,
      parseError: options.parseError
        ?? createNameAmbiguousError(name, resolution.invocationNames),
    };
  }
  return createToolCallFromInvocation(name, options.payload ?? {}, options.raw, catalog, {
    parseError: options.parseError,
  });
}
