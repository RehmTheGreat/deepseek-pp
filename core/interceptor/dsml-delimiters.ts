/**
 * One DSML delimiter truth (pc directives, 2026-09-18): DSML must NEVER come
 * back as plain text, so EVERY delimiter variant is captured. Recognition is
 * anchored on the literal token `DSML` inside fullwidth-bar (U+FF5C) runs of
 * 1..8 bars on each side, tolerating bounded whitespace between the right bar
 * run and the tag name (observed live variant: `<｜｜DSML｜｜ calls>`). Both
 * wrapper names (`tool_calls` AND `calls`), wrapperless invoke blocks, and
 * closers of ANY bar shape are claimed. Everything here is a pure string
 * function with zero browser/DOM imports so both the batch bundle and the
 * streaming bundle consume the SAME rule (strip symmetry invariant).
 *
 * Linear-scan invariant (ReDoS H1): every scanner below advances strictly
 * forward and examines each `DSML` token occurrence in bounded constant work;
 * there is no backtracking and no `[\s\S]*?`. The bar cap (8) is what keeps
 * the streaming suffix holdback constant-work; 9+ bars stay prose by design.
 */

export const MAX_DSML_DELIMITER_BARS = 8;
export const DSML_TOKEN = 'DSML';
export const FULLWIDTH_BAR = '｜';
export const DSML_WRAPPER_NAMES = ['tool_calls', 'calls'] as const;
export type DsmlWrapperName = (typeof DSML_WRAPPER_NAMES)[number];
export type DsmlTagName = DsmlWrapperName | 'invoke' | 'parameter';

/**
 * Bounded whitespace tolerance between the right bar run and the tag name.
 * Mirrors the bar cap so tag shapes stay bounded-length for the streaming
 * holdback contract.
 */
const MAX_DSML_TAG_WHITESPACE = 8;
/** Bound for the attribute area (` name="..."` + optional ` string="...">`). */
const MAX_DSML_TAG_ATTRIBUTE_CHARS = 512;
/**
 * Longest partial-tag suffix the streaming holdback ever needs to keep:
 * `'</' + 8 bars + DSML + 8 bars + 8 ws + 'tool_calls'` = 41 code points.
 */
const MAX_DSML_PARTIAL_TAG_CHARS = 41;

const DSML_TAG_NAMES: readonly DsmlTagName[] = ['tool_calls', 'calls', 'invoke', 'parameter'];

export interface DsmlTagMatch {
  /** Start of '<'. */
  index: number;
  /** Exclusive end ('>' + 1 for complete tags). */
  endIndex: number;
  /** '</' prefix seen. */
  closing: boolean;
  /** 'tool_calls' | 'calls' | 'invoke' | 'parameter' (shape-level). */
  name: DsmlTagName;
  /** Tag carries a ` name="` attribute (invoke/parameter opens). */
  hasInvokeNameAttribute: boolean;
  /** Index where the name token starts (after delimiter run + whitespace). */
  nameStart: number;
  /** First index AFTER the opening quote of the name attribute value. */
  nameValueStart: number;
}

function isWrapperName(value: DsmlTagName): value is DsmlWrapperName {
  return value === 'tool_calls' || value === 'calls';
}

function isTagWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

/**
 * Attempts to parse a DSML tag AT position `i` (`text[i]` must be '<').
 * Shape: `'<' ['/'] BAR{1..8} 'DSML' BAR{1..8} [WS{0..8}] name-tail` where
 * name-tail is a wrapper name followed by `>` (complete tag), or
 * `invoke`/`parameter` followed by `>` or by a bounded ` name="…">`
 * attribute area. Returns null unless the full shape holds; bare `｜DSML｜`
 * prose and arbitrary delimiters never match.
 */
export function matchDsmlTagAt(text: string, i: number): DsmlTagMatch | null {
  if (i < 0 || text[i] !== '<') return null;
  let j = i + 1;
  const closing = text[j] === '/';
  if (closing) j += 1;

  const leadingBars = countBars(text, j);
  if (leadingBars < 1 || leadingBars > MAX_DSML_DELIMITER_BARS) return null;
  j += leadingBars;
  if (!text.startsWith(DSML_TOKEN, j)) return null;
  j += DSML_TOKEN.length;
  const trailingBars = countBars(text, j);
  if (trailingBars < 1 || trailingBars > MAX_DSML_DELIMITER_BARS) return null;
  j += trailingBars;

  // Observed variant tolerance: bounded whitespace between the delimiter run
  // and the tag name (`<｜｜DSML｜｜ calls>`).
  let whitespace = 0;
  while (whitespace < MAX_DSML_TAG_WHITESPACE && isTagWhitespace(text[j + whitespace])) {
    whitespace += 1;
  }
  const nameStart = j + whitespace;

  // 'tool_calls' is checked before 'calls' (no shared prefix, but keep the
  // longest-first discipline anyway).
  let name: DsmlTagName | null = null;
  for (const candidate of DSML_TAG_NAMES) {
    if (text.startsWith(candidate, nameStart)) {
      name = candidate;
      break;
    }
  }
  if (!name) return null;
  j = nameStart + name.length;

  if (isWrapperName(name)) {
    // Wrappers are bare tags: the shape requires '>' immediately.
    if (text[j] !== '>') return null;
    return {
      index: i, endIndex: j + 1, closing, name,
      hasInvokeNameAttribute: false, nameStart, nameValueStart: -1,
    };
  }

  // invoke/parameter tail: '>' directly, or a bounded name attribute area.
  if (text[j] === '>') {
    return {
      index: i, endIndex: j + 1, closing, name,
      hasInvokeNameAttribute: false, nameStart, nameValueStart: -1,
    };
  }
  if (closing) return null; // closing tags never carry attributes
  if (!text.startsWith(' name="', j)) return null;
  const valueStart = j + ' name="'.length;
  // The attribute area ends at the first '>' after the opening quote; the
  // canonical machinery requires `">` / `" string="true|false">`, but the
  // shape check only needs the bounded terminator to exist.
  const attributeEnd = text.indexOf('>', valueStart);
  if (attributeEnd === -1 || attributeEnd - j > MAX_DSML_TAG_ATTRIBUTE_CHARS) return null;
  return {
    index: i,
    endIndex: attributeEnd + 1,
    closing,
    name,
    hasInvokeNameAttribute: true,
    nameStart,
    nameValueStart: valueStart,
  };
}

function countBars(text: string, from: number): number {
  let count = 0;
  while (count < MAX_DSML_DELIMITER_BARS + 1 && text[from + count] === FULLWIDTH_BAR) {
    count += 1;
  }
  return count;
}

/**
 * Forward scan for the earliest DSML tag from `fromIndex` matching `pred`.
 * Implementation: `indexOf(DSML_TOKEN)` loop; for each hit, walk back over
 * the bar run (<= 8) and require '<' (or '</') immediately before it, then
 * validate the full shape via {@link matchDsmlTagAt}. Each candidate is
 * examined in bounded constant work and the scan position always advances
 * past the token, so the scan is strictly linear (no backtracking).
 */
export function findDsmlTag(
  text: string,
  fromIndex: number,
  pred: (tag: DsmlTagMatch) => boolean,
): DsmlTagMatch | null {
  let searchFrom = Math.max(0, fromIndex);
  while (searchFrom < text.length) {
    const tokenIndex = text.indexOf(DSML_TOKEN, searchFrom);
    if (tokenIndex === -1) return null;
    const tagStart = findTagStartBefore(text, tokenIndex);
    if (tagStart !== -1) {
      const match = matchDsmlTagAt(text, tagStart);
      if (match && pred(match)) return match;
    }
    searchFrom = tokenIndex + DSML_TOKEN.length;
  }
  return null;
}

/** Index of the '<' (or '</') immediately preceding the bar run before `tokenIndex`, or -1. */
function findTagStartBefore(text: string, tokenIndex: number): number {
  let bars = 0;
  let i = tokenIndex - 1;
  while (i >= 0 && bars <= MAX_DSML_DELIMITER_BARS && text[i] === FULLWIDTH_BAR) {
    bars += 1;
    i -= 1;
  }
  if (bars < 1 || bars > MAX_DSML_DELIMITER_BARS) return -1;
  if (text[i] === '<') return i;
  if (text[i] === '/' && text[i - 1] === '<') return i - 1;
  return -1;
}

/**
 * Rewrites EVERY tag-shaped DSML delimiter occurrence in the text to the
 * canonical single-bar form: `'<' ['/'] BAR{1..8} 'DSML' BAR{1..8} [WS] name…`
 * becomes `'<' ['/'] '｜DSML｜' name…` (the tolerated whitespace inside the
 * delimiter is dropped). Wrapper names are preserved (`calls` stays `calls`):
 * only delimiter BYTES normalize, because extraction never reads the wrapper
 * name and the claim scanner accepts both. Bare `｜｜DSML｜` bytes inside
 * prose or parameter VALUES are untouched (no '<' immediately before the bar
 * run). Single forward pass, linear.
 */
export function normalizeDsmlDelimiters(text: string): string {
  let output = '';
  let cursor = 0;
  let searchFrom = 0;
  let changed = false;
  while (searchFrom < text.length) {
    const tokenIndex = text.indexOf(DSML_TOKEN, searchFrom);
    if (tokenIndex === -1) break;
    const tagStart = findTagStartBefore(text, tokenIndex);
    const match = tagStart !== -1 ? matchDsmlTagAt(text, tagStart) : null;
    if (!match) {
      searchFrom = tokenIndex + DSML_TOKEN.length;
      continue;
    }
    output += text.slice(cursor, tagStart);
    output += match.closing ? '</｜DSML｜' : '<｜DSML｜';
    output += text.slice(match.nameStart, match.endIndex);
    cursor = match.endIndex;
    searchFrom = match.endIndex;
    changed = true;
  }
  return changed ? output + text.slice(cursor) : text;
}

export interface DsmlToolBlockRange {
  openIndex: number;
  /** Exclusive end of the block (past its closing tag; text.length when unclosed). */
  endIndex: number;
  /** A same-name closer of any bar shape was found. */
  closed: boolean;
  /**
   * Canonical shape: single bars everywhere, no tolerated whitespace, and a
   * `tool_calls` wrapper (C1) — i.e. normalizing the claimed slice is the
   * identity. Non-canonical blocks recover with the non-blocking
   * `tool_call_delimiter_corrected` annotation.
   */
  canonical: boolean;
  /** Name of the opening tag (wrapper name for C1, 'invoke' for C2). */
  openName: DsmlTagName;
}

function isOpenBlockTag(tag: DsmlTagMatch): boolean {
  return !tag.closing && (isWrapperName(tag.name) || tag.name === 'invoke');
}

/**
 * Claims the next DSML tool block from `fromIndex` (the ONE block scanner).
 *
 * C1 wrapper block: open = a non-closing wrapper tag (`tool_calls` OR the
 * observed `calls`), close = the FIRST closing tag of the SAME name after the
 * open, of ANY bar shape. C2 bare-invoke block: open = a non-closing
 * `invoke` tag, close = the first closing `invoke`. The earliest opener wins
 * (C1 and C2 can never tie: different names cannot match at one position).
 * An unclosed opener claims to EOF (display/history strip policy; inner
 * invokes recover via the existing unterminated-invoke path). Both scans are
 * single forward `findDsmlTag` passes, so the claim loop stays linear.
 */
export function findNextDsmlToolBlock(
  text: string,
  fromIndex: number,
): DsmlToolBlockRange | null {
  const open = findDsmlTag(text, fromIndex, isOpenBlockTag);
  if (!open) return null;
  const close = findDsmlTag(
    text,
    open.endIndex,
    (tag) => tag.closing && tag.name === open.name,
  );
  const endIndex = close ? close.endIndex : text.length;
  return {
    openIndex: open.index,
    endIndex,
    closed: Boolean(close),
    canonical: (open.name === 'tool_calls' || open.name === 'invoke')
      && normalizeDsmlDelimiters(text.slice(open.index, endIndex)) === text.slice(open.index, endIndex),
    openName: open.name,
  };
}

/**
 * Longest suffix of `text` that is a PROPER PREFIX of some DSML tag shape
 * (`'</' BAR{0..8} 'DSML' BAR{0..8} [WS] name-partial…`), capped at
 * {@link MAX_DSML_PARTIAL_TAG_CHARS} code points so a chunk boundary never
 * holds back more than constant work (streaming holdback contract). A suffix
 * can only be a tag prefix when it starts at the LAST '<' of the text.
 */
export function getDsmlShapeTailLength(text: string): number {
  const lastOpen = text.lastIndexOf('<');
  if (lastOpen === -1) return 0;
  const suffix = text.slice(lastOpen);
  const bounded = suffix.length > MAX_DSML_PARTIAL_TAG_CHARS
    ? suffix.slice(0, MAX_DSML_PARTIAL_TAG_CHARS)
    : suffix;
  if (!isPartialDsmlTagPrefix(bounded)) return 0;
  return Math.min(suffix.length, MAX_DSML_PARTIAL_TAG_CHARS);
}

/**
 * Whether `text` (already bounded) could still complete into a DSML tag:
 * every consumed segment stays shape-legal and the walk either ends
 * mid-shape (proper prefix) or consumed exactly a prefix of one. A COMPLETE
 * tag followed by any character is not a proper prefix.
 */
function isPartialDsmlTagPrefix(text: string): boolean {
  let j = 0;
  if (text[j] !== '<') return false;
  j += 1;
  if (text[j] === '/') j += 1;

  const leadingBars = countBars(text, j);
  if (leadingBars > MAX_DSML_DELIMITER_BARS) return false;
  j += leadingBars;
  if (j === text.length) return true; // '<' + partial bar run
  if (leadingBars === 0) return false; // DSML must be bar-delimited on the left
  for (let k = 0; k < DSML_TOKEN.length; k += 1) {
    if (j === text.length) return true; // mid-'DSML'
    if (text[j] !== DSML_TOKEN[k]) return false;
    j += 1;
  }

  const trailingBars = countBars(text, j);
  if (trailingBars > MAX_DSML_DELIMITER_BARS) return false;
  j += trailingBars;
  if (j === text.length) return true; // bars may continue up to the cap
  let whitespace = 0;
  while (whitespace < MAX_DSML_TAG_WHITESPACE && isTagWhitespace(text[j])) {
    whitespace += 1;
    j += 1;
  }
  if (j === text.length) return true; // whitespace may continue to the cap

  // Name segment: a full candidate name followed by its legal tail keeps the
  // shape alive; a PROPER prefix of a candidate keeps it alive only when it
  // reaches the end of the text (the name can still complete). A completed
  // tag followed by any character is never a proper prefix.
  let bestFull: DsmlTagName | null = null;
  let bestFullLength = 0;
  let partialToEdge = false;
  for (const candidate of DSML_TAG_NAMES) {
    let common = 0;
    while (common < candidate.length && j + common < text.length && text[j + common] === candidate[common]) {
      common += 1;
    }
    if (common === candidate.length) {
      if (common > bestFullLength) {
        bestFull = candidate;
        bestFullLength = common;
      }
    } else if (common > 0 && j + common === text.length) {
      partialToEdge = true;
    }
  }
  if (bestFull) {
    j += bestFullLength;
    if (j === text.length) return true; // awaiting '>' or ' name="'
    if (isWrapperName(bestFull)) return false; // wrappers accept only '>', which completes the tag
    return text[j] === '>' ? false : text.startsWith(' name="', j);
  }
  return partialToEdge;
}
