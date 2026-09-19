import type { ToolCall, ToolDescriptor, ToolError } from '../types';
import {
  createToolCallFromInvocation,
  createToolInvocationCatalog,
  getToolCloseTag,
  type ToolInvocationCatalog,
} from '../tool';
import { createExternalizedToolPayload } from '../tool/externalized-payload';
import {
  INCOMPLETE_TOOL_CALL_ERROR_CODE,
  MISMATCHED_TOOL_CALL_ERROR_CODE,
} from '../tool/execution-error';
import { resolveToolTagName } from '../tool/tag-variants';
import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from '../tool/xml-tags';
import { findDsmlTag, getDsmlShapeTailLength } from './dsml-delimiters';

/** Builds the BLOCKING error for a short-name tag matching several tools. */
function createNameAmbiguousParseError(
  name: string,
  invocationNames: string[],
): ToolError {
  return {
    code: 'tool_call_name_ambiguous',
    message: `Tool tag <${name}> matches several advertised tools (${invocationNames
      .map((invocationName) => `<${invocationName}>`)
      .join(', ')}); use the full advertised tag name.`,
    retryable: true,
    details: { invocationName: name },
  };
}

const STREAM_TOOL_RAW_MAX_LENGTH = 2048;
const TRUNCATION_SUFFIX = '\n...[truncated]';
const EXTERNALIZE_BODY_THRESHOLD_CHARS = 64_000;
const STREAM_TOOL_BODY_MAX_CHARS = 1_048_576;
// Foreign close emitted by models trained on a generic `<invoke>` wire format.
// The DSML analogue is scanned in EVERY bar shape through the shared
// delimiter truth (core/interceptor/dsml-delimiters.ts) — total capture, pc
// directive 1 — with the canonical single-bar literal as the message label.
const INVOKE_CLOSE_TERMINATOR_LEGACY_LABEL = '</｜DSML｜invoke>';
const INVOKE_CLOSE_TERMINATOR_PLAIN = '</invoke>';

export interface StreamingToolCallParserEvent {
  started: ToolCall[];
  completed: ToolCall[];
  failed: ToolCall[];
  streamed: ToolCallPayloadChunk[];
}

export interface StreamingToolCallParser {
  append(chunk: string): StreamingToolCallParserEvent;
  flush(): StreamingToolCallParserEvent;
}

export interface ToolCallPayloadChunk {
  id: string;
  invocationName: string;
  chunk: string;
  requestId?: string;
}

export interface StreamingToolCallParserOptions {
  // The active local skill's skillDir for the request owning the current response; when non-empty, parsed
  // shell_exec / shell_session_begin calls carry localSkillDir as the "initial cwd hint" at the background
  // runtime (not a hard persistent binding; Review #4 Route A).
  activeLocalSkillDir?: string;
}

export function createStreamingToolCallParser(
  descriptors: readonly ToolDescriptor[],
  options?: StreamingToolCallParserOptions,
): StreamingToolCallParser {
  return new XmlStreamingToolCallParser(createToolInvocationCatalog(descriptors), options);
}

class XmlStreamingToolCallParser implements StreamingToolCallParser {
  // Shared scanner truth (D2): the scan set includes short descriptor names;
  // matches resolve through the ONE variant rule in core/tool/tag-variants.ts.
  private readonly scanNames: ReadonlySet<string>;
  private state: 'NORMAL' | 'SUPPRESSING' = 'NORMAL';
  private pendingNormal = '';
  private pendingSuppressed = '';
  private current: {
    id: string;
    /** The tag name as written; the record and the close scan both use it. */
    invocationName: string;
    /** The tag name as the model wrote it - the close-tag scan uses this. */
    rawName: string;
    openTag: string;
    closeTag: string;
    bodyParts: string[];
    bodyLength: number;
    externalized: boolean;
    externalizable: boolean;
    failed: boolean;
    resolution: 'ambiguous' | null;
  } | null = null;

  constructor(
    private readonly catalog: ToolInvocationCatalog,
    options?: StreamingToolCallParserOptions,
  ) {
    this.scanNames = new Set(catalog.toolTagNames);
    this.activeLocalSkillDir = options?.activeLocalSkillDir || undefined;
  }

  private readonly activeLocalSkillDir: string | undefined;

  append(chunk: string): StreamingToolCallParserEvent {
    const event = createEmptyParserEvent();
    if (!chunk || this.scanNames.size === 0) return event;

    let remaining = chunk;
    while (remaining.length > 0) {
      remaining = this.state === 'SUPPRESSING'
        ? this.consumeSuppressedText(remaining, event)
        : this.consumeNormalText(remaining, event);
    }
    return event;
  }

  flush(): StreamingToolCallParserEvent {
    const event = createEmptyParserEvent();
    if (this.current && !this.current.failed) {
      event.failed.push(this.createIncompleteCall(this.current, this.pendingSuppressed));
    }
    this.state = 'NORMAL';
    this.pendingNormal = '';
    this.pendingSuppressed = '';
    this.current = null;
    return event;
  }

  private consumeNormalText(input: string, event: StreamingToolCallParserEvent): string {
    const text = this.pendingNormal + input;
    this.pendingNormal = '';

    const found = findFirstXmlToolTag(text, this.scanNames, { closing: false });
    if (!found) {
      const tailLength = getPartialXmlToolTagTailLength(text, this.scanNames, { closing: false });
      this.pendingNormal = tailLength > 0 ? text.slice(-tailLength) : '';
      return '';
    }

    const id = crypto.randomUUID();
    // Shared variant rule: the only divergence from the released exact path
    // is the AMBIGUOUS short name (several advertised tools claim it); exact
    // names and accepted unique aliases go through the released factory.
    const resolution = resolveToolTagName(found.name, this.catalog)?.kind === 'ambiguous'
      ? 'ambiguous'
      : null;
    this.state = 'SUPPRESSING';
    this.pendingSuppressed = '';
    this.current = {
      id,
      invocationName: found.name,
      rawName: found.name,
      openTag: found.raw,
      closeTag: getToolCloseTag(found.name),
      bodyParts: [],
      bodyLength: 0,
      externalized: false,
      externalizable: isExternalizableInvocation(found.name),
      failed: false,
      resolution,
    };
    event.started.push(this.createCurrentCallRecord({}, found.raw, undefined, this.current));
    return text.slice(found.endIndex);
  }

  private consumeSuppressedText(input: string, event: StreamingToolCallParserEvent): string {
    const current = this.current;
    if (!current) {
      this.state = 'NORMAL';
      return input;
    }

    const text = this.pendingSuppressed + input;
    this.pendingSuppressed = '';
    // Close-tag scanning uses the name AS WRITTEN (`</tool_list>` for a short
    // form), never the canonical full invocation name.
    const closeTag = findFirstXmlToolTag(text, new Set([current.rawName]), { closing: true });
    // Fail-fast mismatched-close recovery: whichever comes first between the
    // same-name close (complete path below) and a foreign terminator bounds the
    // call. Without this, one malformed call swallowed every following parallel
    // call until EOF.
    const foreign = this.findForeignTerminator(text, closeTag?.index);

    if (closeTag && (!foreign || closeTag.index < foreign.index)) {
      this.appendBody(text.slice(0, closeTag.index), event);
      if (!current.failed) {
        event.completed.push(this.createCompletedCall({ ...current, closeTag: closeTag.raw }));
      }
      this.state = 'NORMAL';
      this.pendingSuppressed = '';
      this.current = null;
      return text.slice(closeTag.endIndex);
    }

    if (foreign) {
      this.appendBody(text.slice(0, foreign.index), event);
      if (!current.failed) {
        event.failed.push(this.createMismatchedCloseCall(current, foreign.label));
      }
      this.state = 'NORMAL';
      this.pendingSuppressed = '';
      this.current = null;
      // Re-consume from the terminator index in NORMAL state so the stray close
      // is dropped and the following parallel tool call parses.
      return text.slice(foreign.index);
    }

    // No close and no foreign terminator: keep buffering, but hold back every
    // bounded suffix that could still complete into a terminator (same-name or
    // foreign closing tag, next known open tag, legacy/plain `</invoke>`
    // literals) so a terminator split across chunks stays contiguous here.
    const tailLength = Math.max(
      getPartialXmlToolTagTailLength(text, this.scanNames, { closing: true }),
      getPartialXmlToolTagTailLength(text, this.scanNames, { closing: false }),
      getInvokeCloseTailLength(text),
    );
    this.appendBody(text.slice(0, text.length - tailLength), event);
    this.pendingSuppressed = tailLength > 0 ? text.slice(-tailLength) : '';
    return '';
  }

  /**
   * Earliest foreign terminator in the suppressed buffer: any catalog closing
   * tag other than the pending call's own close (same-name index excluded), a
   * legacy/plain `</invoke>` close, or the next known open tag. Every
   * candidate is a single linear scan over the pending buffer (no
   * chunk-boundary lookahead), so consumption stays O(n).
   */
  private findForeignTerminator(
    text: string,
    sameNameCloseIndex: number | undefined,
  ): { index: number; label: string } | null {
    let best: { index: number; label: string } | null = null;
    const consider = (index: number, label: string) => {
      if (index === -1) return;
      if (sameNameCloseIndex !== undefined && index === sameNameCloseIndex) return;
      if (!best || index < best.index) best = { index, label };
    };

    const foreignClose = findFirstXmlToolTag(text, this.scanNames, { closing: true });
    if (foreignClose) consider(foreignClose.index, `</${foreignClose.name}>`);
    // DSML invoke close in ANY bar shape (1..8 each side, whitespace-tolerant,
    // any wrapper context) — the shared generalized scanner, same linear cost
    // as the old exact literals.
    const dsmlClose = findDsmlTag(
      text,
      0,
      (tag) => tag.closing && tag.name === 'invoke',
    );
    if (dsmlClose) consider(dsmlClose.index, INVOKE_CLOSE_TERMINATOR_LEGACY_LABEL);
    consider(text.indexOf(INVOKE_CLOSE_TERMINATOR_PLAIN), INVOKE_CLOSE_TERMINATOR_PLAIN);
    const nextOpen = findFirstXmlToolTag(text, this.scanNames, { closing: false });
    if (nextOpen) consider(nextOpen.index, `<${nextOpen.name}>`);

    return best;
  }

  // createIncompleteCall-style raw bounding: the recovered call keeps its
  // streamed body (truncated) but never claims the foreign terminator.
  private createMismatchedCloseCall(
    current: NonNullable<XmlStreamingToolCallParser['current']>,
    terminatorLabel: string,
  ): ToolCall {
    return this.createCurrentCallRecord(
      current.externalized
        ? createExternalizedToolPayload(current.id, current.invocationName)
        : {},
      createIncompleteRaw(current, ''),
      createToolParseError(
        MISMATCHED_TOOL_CALL_ERROR_CODE,
        current.invocationName,
        `Tool call <${current.rawName}> was interrupted by ${terminatorLabel} instead of ${current.closeTag}.`,
      ),
      current,
    );
  }

  private appendBody(value: string, event: StreamingToolCallParserEvent): void {
    if (!value || !this.current) return;
    if (this.current.failed) return;

    this.current.bodyLength += value.length;
    if (this.current.bodyLength > STREAM_TOOL_BODY_MAX_CHARS) {
      this.current.failed = true;
      this.current.bodyParts = [];
      event.failed.push(this.createOversizedCall(this.current));
      return;
    }

    if (this.current.externalized) {
      event.streamed.push({ id: this.current.id, invocationName: this.current.invocationName, chunk: value });
      return;
    }

    this.current.bodyParts.push(value);
    if (this.current.externalizable && this.current.bodyLength > EXTERNALIZE_BODY_THRESHOLD_CHARS) {
      this.current.externalized = true;
      const buffered = this.current.bodyParts.join('');
      this.current.bodyParts = [];
      if (buffered) {
        event.streamed.push({
          id: this.current.id,
          invocationName: this.current.invocationName,
          chunk: buffered,
        });
      }
    }
  }

  private createCompletedCall(current: NonNullable<XmlStreamingToolCallParser['current']>): ToolCall {
    if (current.externalized) {
      return this.createCurrentCallRecord(
        createExternalizedToolPayload(current.id, current.invocationName),
        createExternalizedRaw(current),
        undefined,
        current,
      );
    }

    const body = current.bodyParts.join('');
    const raw = createBoundedRaw(current, body);

    try {
      const parsed = body.length === 0 ? {} : JSON.parse(body);
      if (!isToolPayload(parsed)) {
        return this.createCurrentCallRecord({}, raw, createToolParseError(
          'tool_call_payload_invalid',
          current.invocationName,
          'Tool call body must be a JSON object.',
        ), current);
      }
      return this.createCurrentCallRecord(parsed, raw, undefined, current);
    } catch (error) {
      return this.createCurrentCallRecord({}, raw, createToolParseError(
        'tool_call_json_invalid',
        current.invocationName,
        [
          'Tool call body is not valid JSON.',
          'Use double quotes for strings and escape backslashes in local file paths, for example "D:\\\\project\\\\file.txt" or "D:/project/file.txt".',
          error instanceof Error ? error.message : String(error),
        ].join(' '),
      ), current);
    }
  }

  private createIncompleteCall(
    current: NonNullable<XmlStreamingToolCallParser['current']>,
    pendingTail: string,
  ): ToolCall {
    return this.createCurrentCallRecord(
      current.externalized
        ? createExternalizedToolPayload(current.id, current.invocationName)
        : {},
      createIncompleteRaw(current, pendingTail),
      createToolParseError(
        INCOMPLETE_TOOL_CALL_ERROR_CODE,
        current.invocationName,
        `Tool call ended before the closing tag ${current.closeTag}.`,
      ),
      current,
    );
  }

  private createOversizedCall(
    current: NonNullable<XmlStreamingToolCallParser['current']>,
  ): ToolCall {
    return this.createCurrentCallRecord(
      {},
      createOversizedRaw(current),
      createToolParseError(
        'tool_call_payload_too_large',
        current.invocationName,
        createOversizedToolCallMessage(current.invocationName),
      ),
      current,
    );
  }

  /**
   * Builds the emitted record for the current tag match through the shared
   * variant rule: exact names keep the released factory shape byte-for-byte;
   * a bound short name executes with its NON-BLOCKING recovery annotation
   * (a body error wins); an ambiguous name becomes the identity-less
   * BLOCKING record that feeds the model structured feedback.
   */
  private createCurrentCallRecord(
    payload: Record<string, unknown>,
    raw: string,
    specificError: ToolError | undefined,
    current: NonNullable<XmlStreamingToolCallParser['current']> | null,
  ): ToolCall {
    if (current?.resolution === 'ambiguous') {
      // Bind to the FIRST advertised candidate so the record flows through
      // the engine's normal tool path (beforeToolCall); the blocking
      // ambiguity error is what reaches the model. Routing-only binding -
      // the call never executes and no server is guessed.
      const name = current.rawName;
      const bound = createToolCallFromInvocation(
        this.ambiguousCandidates(name)[0] ?? name,
        payload,
        raw,
        this.catalog,
        { id: current.id },
      );
      return {
        ...bound,
        parseError: specificError
          ?? createNameAmbiguousParseError(name, this.ambiguousCandidates(name)),
      };
    }
    return createToolCallFromInvocation(
      current?.invocationName ?? '',
      payload,
      raw,
      this.catalog,
      {
        ...(current?.id ? { id: current.id } : {}),
        ...(this.activeLocalSkillDir ? { localSkillDir: this.activeLocalSkillDir } : {}),
        ...(specificError ? { parseError: specificError } : {}),
      },
    );
  }

  private ambiguousCandidates(name: string): string[] {
    const matches = this.catalog.descriptorsByName.get(name) ?? [];
    return matches.map((descriptor) => descriptor.invocationName);
  }
}

function createEmptyParserEvent(): StreamingToolCallParserEvent {
  return { started: [], completed: [], failed: [], streamed: [] };
}

/**
 * Longest suffix of `text` that is a proper prefix of a foreign close
 * terminator: the plain `</invoke>` literal, or ANY partial DSML tag shape
 * (single/double/any bar count) via the shared
 * {@link getDsmlShapeTailLength} — so a DSML terminator split across chunks
 * stays in the pending buffer until complete. Bounded by the DSML partial
 * cap plus the plain literal length, i.e. constant work per chunk.
 */
function getInvokeCloseTailLength(text: string): number {
  let longest = getDsmlShapeTailLength(text);
  const max = Math.min(text.length, INVOKE_CLOSE_TERMINATOR_PLAIN.length - 1);
  for (let length = max; length > longest; length -= 1) {
    if (INVOKE_CLOSE_TERMINATOR_PLAIN.startsWith(text.slice(text.length - length))) {
      longest = length;
      break;
    }
  }
  return longest;
}

function createBoundedRaw(
  current: { openTag: string; closeTag: string },
  body: string,
): string {
  const rawLength = current.openTag.length + body.length + current.closeTag.length;
  if (rawLength <= STREAM_TOOL_RAW_MAX_LENGTH) return `${current.openTag}${body}${current.closeTag}`;
  return [
    current.openTag,
    `...[payload ${body.length} chars omitted]`,
    current.closeTag,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createExternalizedRaw(
  current: { openTag: string; closeTag: string; bodyLength: number },
): string {
  return [
    current.openTag,
    `...[payload ${current.bodyLength} chars externalized]`,
    current.closeTag,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createIncompleteRaw(
  current: {
    openTag: string;
    bodyParts: string[];
    bodyLength: number;
    externalized: boolean;
  },
  pendingTail: string,
): string {
  const bodyLength = current.bodyLength + pendingTail.length;
  if (current.externalized) {
    return [
      current.openTag,
      `...[payload ${bodyLength} chars externalized before EOF]`,
      TRUNCATION_SUFFIX,
    ].join('\n');
  }

  const body = current.bodyParts.join('') + pendingTail;
  const raw = current.openTag + body;
  if (raw.length <= STREAM_TOOL_RAW_MAX_LENGTH) return raw;
  return [
    current.openTag,
    `...[incomplete payload ${bodyLength} chars omitted]`,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createOversizedRaw(
  current: { openTag: string; bodyLength: number },
): string {
  return [
    current.openTag,
    `...[payload exceeded ${STREAM_TOOL_BODY_MAX_CHARS} chars; ${current.bodyLength} chars received]`,
    TRUNCATION_SUFFIX,
  ].join('\n');
}

function createOversizedToolCallMessage(invocationName: string): string {
  const limit = `Tool call body exceeded the safe streaming limit of ${STREAM_TOOL_BODY_MAX_CHARS} characters.`;
  if (invocationName === 'artifact_create' || invocationName === 'artifact_bundle_create') {
    return [
      limit,
      'Do not embed binary or base64 file data in artifact calls.',
      'Keep files produced by Shell or OfficeCLI at their local path and report that path to the user.',
    ].join(' ');
  }
  return `${limit} Split the operation into smaller tool calls.`;
}

function isToolPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function createToolParseError(code: string, invocationName: string, message: string): ToolError {
  return {
    code,
    message,
    retryable: false,
    details: { invocationName },
  };
}

function isExternalizableInvocation(invocationName: string): boolean {
  return invocationName === 'artifact_create' ||
    invocationName === 'artifact_bundle_create' ||
    invocationName === 'shell_exec' ||
    invocationName === 'shell_session_exec' ||
    invocationName === 'local_file_write';
}
