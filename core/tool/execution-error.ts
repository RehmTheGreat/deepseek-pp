export const INCOMPLETE_TOOL_CALL_ERROR_CODE = 'tool_call_incomplete';

// A tool call whose closing tag is missing but whose block is bounded by a
// foreign terminator (another tool's closing tag, a legacy `</｜DSML｜invoke>` /
// `</invoke>`, or the next known open tag). Recovered as a parseError record so
// the loop sees the call and fails visibly instead of silently dropping it.
export const MISMATCHED_TOOL_CALL_ERROR_CODE = 'tool_call_close_mismatched';

// A legacy ｜DSML｜ block emitted with non-canonical delimiters (doubled
// fullwidth bars on either side, tolerated whitespace, the `calls` wrapper
// name, or a wrapperless invoke block). Recovered through the normal legacy
// path after bounded delimiter normalization. NON-BLOCKING annotation (pc
// directive 2, 2026-09-18): the recovered call EXECUTES; the parseError stays
// on the record for trace/restore visibility only. All other codes above and
// below remain blocking and model-visible.
export const TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE = 'tool_call_delimiter_corrected';
// A tag written with a tool's SHORT descriptor name (live: `<tool_list>`
// instead of `mcp_t_<server>_tool_list`, fix round 4 D2) that matches SEVERAL
// advertised tools. Blocking: no silent arbitrary server selection - the
// structured, model-visible error names every full advertised tag so the
// model can disambiguate. (A unique short name is an accepted catalog alias
// and executes cleanly.)
export const TOOL_CALL_NAME_AMBIGUOUS_ERROR_CODE = 'tool_call_name_ambiguous';

/**
 * Parse-error codes that are NON-BLOCKING annotations: the recovered call
 * EXECUTES and the annotation stays on the record for trace visibility only
 * (pc directive 2). Every other code blocks the call through the structured
 * retryable feedback channel.
 */
export function isNonBlockingToolParseError(code: string | undefined): boolean {
  return code === TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE;
}

export class ToolPostEffectPersistenceError extends Error {
  readonly code = 'tool_post_effect_persistence_failed' as const;
  readonly retryable = false as const;
  readonly externalOutcome = 'ambiguous' as const;

  constructor(readonly originalError: unknown) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError);
    super(
      'The tool provider may have completed, but execution history could not be persisted. '
      + `Do not retry automatically: ${detail}`,
    );
    this.name = 'ToolPostEffectPersistenceError';
  }
}
