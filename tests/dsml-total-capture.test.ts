import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactToolDescriptors } from '../core/artifact';
import {
  matchDsmlTagAt,
  findDsmlTag,
  normalizeDsmlDelimiters,
  getDsmlShapeTailLength,
  findNextDsmlToolBlock,
  MAX_DSML_DELIMITER_BARS,
  DSML_WRAPPER_NAMES,
  FULLWIDTH_BAR,
} from '../core/interceptor/dsml-delimiters';
import {
  extractLegacyToolCalls,
  extractToolCalls,
  replaceToolCallsWithSummary,
  stripToolCalls,
} from '../core/interceptor/tool-parser';
import { ToolProviderRegistry, type RuntimeToolProvider } from '../core/tool/provider-registry';
import { createRuntimeToolRuntime } from '../core/tool/runtime';
import type { ToolDescriptor } from '../core/types';
import {
  MISMATCHED_TOOL_CALL_ERROR_CODE,
  TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE,
} from '../core/tool/execution-error';

/**
 * DSML total capture (pc directives, 2026-09-18): DSML must NEVER come back
 * as plain text, and delimiter malformation is a NON-BLOCKING annotation.
 * One delimiter truth (core/interceptor/dsml-delimiters.ts) anchors on the
 * literal `DSML` token inside U+FF5C runs (1..8 bars each side), tolerates
 * whitespace inside tags, accepts BOTH wrapper names (`tool_calls` AND
 * `calls`), any-shape closers, and wrapperless invoke blocks. Extraction stays
 * `extractLegacyInvokes` UNCHANGED; recovered calls carry
 * `tool_call_delimiter_corrected` and EXECUTE.
 */

const BAR = FULLWIDTH_BAR;
const MCP_TOOL_LIST_NAME = 'mcp_t_50c2eea9_ae30_4095_bb7e_4e40cc3d63e3_tool_list';

function makeDescriptor(invocationName: string): ToolDescriptor {
  return {
    id: `local:test:${invocationName}`,
    provider: { kind: 'local', id: 'test', displayName: 'Test', transport: 'in_process' },
    name: invocationName,
    invocationName,
    title: invocationName,
    description: `test ${invocationName}`,
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

const descriptors: ToolDescriptor[] = [
  ...createArtifactToolDescriptors('en'),
  makeDescriptor(MCP_TOOL_LIST_NAME),
  makeDescriptor('sample_tool'),
];

// F-PC: the exact pc live variant — bars DOUBLED ON BOTH SIDES of DSML, a
// SPACE before the tag name, the wrapper name `calls`, an EMPTY invoke body
// (the real capability probe).
const F_PC = [
  `<｜｜DSML｜｜ calls>`,
  `<｜｜DSML｜｜ invoke name="${MCP_TOOL_LIST_NAME}">`,
  ``,
  `</｜｜DSML｜｜ invoke>`,
  `</｜｜DSML｜｜ calls>`,
].join('\n');

// F-PC with intact parameter tags.
const F_PC_WITH_PARAMS = [
  `<｜｜DSML｜｜ calls>`,
  `<｜｜DSML｜｜ invoke name="sample_tool">`,
  `<｜｜DSML｜｜ parameter name="value" string="true">approved</｜｜DSML｜｜ parameter>`,
  `</｜｜DSML｜｜ invoke>`,
  `</｜｜DSML｜｜ calls>`,
].join('');

describe('dsml-delimiters module (one delimiter truth)', () => {
  it('exposes the design constants', () => {
    expect(MAX_DSML_DELIMITER_BARS).toBe(8);
    expect([...DSML_WRAPPER_NAMES]).toEqual(['tool_calls', 'calls']);
    expect(FULLWIDTH_BAR).toBe('\uFF5C');
  });

  it('matchDsmlTagAt parses canonical and generalized shapes, rejects non-shapes', () => {
    // canonical open + close
    expect(matchDsmlTagAt('<｜DSML｜tool_calls>', 0)).toMatchObject({
      index: 0, endIndex: '<｜DSML｜tool_calls>'.length, closing: false, name: 'tool_calls',
    });
    const close = matchDsmlTagAt('</｜DSML｜tool_calls>', 0);
    expect(close).toMatchObject({ closing: true, name: 'tool_calls', endIndex: '</｜DSML｜tool_calls>'.length });

    // `calls` wrapper (observed)
    expect(matchDsmlTagAt('<｜DSML｜calls>', 0)).toMatchObject({ name: 'calls', closing: false });

    // pc variant: doubled bars both sides + SPACE before the name
    const pcOpen = matchDsmlTagAt('<｜｜DSML｜｜ calls>', 0);
    expect(pcOpen).toMatchObject({ closing: false, name: 'calls', endIndex: '<｜｜DSML｜｜ calls>'.length });
    const pcInvoke = matchDsmlTagAt(`<｜｜DSML｜｜ invoke name="${MCP_TOOL_LIST_NAME}">`, 0);
    expect(pcInvoke).toMatchObject({ closing: false, name: 'invoke', hasInvokeNameAttribute: true });

    // invoke without attribute, parameter with attribute
    expect(matchDsmlTagAt('</｜DSML｜invoke>', 0)).toMatchObject({
      closing: true, name: 'invoke', hasInvokeNameAttribute: false,
    });
    expect(matchDsmlTagAt('<｜DSML｜parameter name="a" string="true">', 0)).toMatchObject({
      closing: false, name: 'parameter', hasInvokeNameAttribute: true,
    });

    // bar grid: 1..8 on both sides
    for (let k = 1; k <= MAX_DSML_DELIMITER_BARS; k++) {
      for (let m = 1; m <= MAX_DSML_DELIMITER_BARS; m++) {
        const tag = `<${BAR.repeat(k)}DSML${BAR.repeat(m)}calls>`;
        expect(matchDsmlTagAt(tag, 0)).toMatchObject({ name: 'calls' });
      }
    }

    // REJECTED PERMANENTLY: 9 bars, fused right side, no left bar
    expect(matchDsmlTagAt(`<${BAR.repeat(9)}DSML${BAR}calls>`, 0)).toBeNull();
    expect(matchDsmlTagAt('<｜DSMLtool_calls>', 0)).toBeNull();
    expect(matchDsmlTagAt('<DSML｜tool_calls>', 0)).toBeNull();
    // bare bar runs in prose never match
    expect(matchDsmlTagAt('prose ｜｜DSML｜ stays prose', 6)).toBeNull();
    expect(matchDsmlTagAt('no tag here', 0)).toBeNull();
  });

  it('findDsmlTag returns the earliest predicate-matching tag and never matches arbitrary delimiters', () => {
    const text = `lead <｜｜DSML｜｜ calls> mid <｜DSML｜invoke name="x"> tail`;
    const wrapper = findDsmlTag(text, 0, (t) => !t.closing && t.name === 'calls');
    expect(wrapper).toMatchObject({ closing: false, name: 'calls' });
    const invoke = findDsmlTag(text, 0, (t) => !t.closing && t.name === 'invoke');
    expect(invoke).toMatchObject({ name: 'invoke' });
    expect(text.slice(invoke!.index, invoke!.endIndex)).toBe('<｜DSML｜invoke name="x">');
    expect(findDsmlTag(text, 0, (t) => t.closing && t.name === 'calls')).toBeNull();
    expect(findDsmlTag('<XML|x> <||foo||> <tool_call>', 0, () => true)).toBeNull();
  });

  it('normalizeDsmlDelimiters rewrites ONLY tag-shaped occurrences to canonical single-bar', () => {
    const normalized = normalizeDsmlDelimiters(F_PC_WITH_PARAMS);
    expect(normalized).toBe([
      '<｜DSML｜calls>',
      '<｜DSML｜invoke name="sample_tool">',
      '<｜DSML｜parameter name="value" string="true">approved</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜calls>',
    ].join(''));
    // `calls` wrapper keeps its name (only delimiter bytes normalize).
    expect(normalizeDsmlDelimiters(F_PC)).toContain('<｜DSML｜calls>');
    // prose bars and parameter VALUES stay untouched.
    const prose = 'a ｜｜DSML｜ b <tag>｜DSML｜</tag>';
    expect(normalizeDsmlDelimiters(prose)).toBe(prose);
    const valueInside = '<｜DSML｜invoke name="s"><｜DSML｜parameter name="v" string="true">x ｜｜DSML｜ y</｜DSML｜parameter></｜DSML｜invoke>';
    expect(normalizeDsmlDelimiters(valueInside)).toBe(valueInside);
    // canonical text is a fixed point.
    const canonical = '<｜DSML｜tool_calls></｜DSML｜tool_calls>';
    expect(normalizeDsmlDelimiters(canonical)).toBe(canonical);
  });

  it('getDsmlShapeTailLength holds partial tag shapes across chunk boundaries', () => {
    expect(getDsmlShapeTailLength('hello <｜｜DSML｜｜invo')).toBe('<｜｜DSML｜｜invo'.length);
    expect(getDsmlShapeTailLength('abc</｜DSML｜inv')).toBe('</｜DSML｜inv'.length);
    expect(getDsmlShapeTailLength('<｜')).toBe(2);
    expect(getDsmlShapeTailLength('plain text')).toBe(0);
    expect(getDsmlShapeTailLength(`x <${BAR.repeat(9)}DSML`)).toBe(0);
    // an attribute value mid-stream stays held
    expect(getDsmlShapeTailLength(`<｜DSML｜invoke name="mcp_t_5`)).toBeGreaterThan(0);
    // a completed tag is NOT a proper prefix: the hold covers only partial tails
    expect(getDsmlShapeTailLength('done <｜DSML｜calls> tail')).toBe(0);
  });

  it('findNextDsmlToolBlock claims wrapper, bare-invoke, and unclosed blocks with a canonical flag', () => {
    // C1 wrapper block with any-shape closer
    const block = findNextDsmlToolBlock(`pre ${F_PC} post`, 4);
    expect(block).not.toBeNull();
    expect(block!.openIndex).toBe(4);
    expect(block!.endIndex).toBe(4 + F_PC.length);
    expect(block!.canonical).toBe(false);

    // C2 bare invoke block, no wrapper
    const bare = '<｜DSML｜invoke name="sample_tool">{}</｜DSML｜invoke>';
    const bareBlock = findNextDsmlToolBlock(`x ${bare} y`, 0);
    expect(bareBlock).toMatchObject({ openIndex: 2, endIndex: 2 + bare.length, canonical: true });

    // unclosed opener claims to EOF
    const unclosed = findNextDsmlToolBlock(`x <｜｜DSML｜｜ calls> never closed`, 0);
    expect(unclosed).not.toBeNull();
    expect(unclosed!.endIndex).toBe(`x <｜｜DSML｜｜ calls> never closed`.length);

    // no block in prose
    expect(findNextDsmlToolBlock('nothing here', 0)).toBeNull();
  });
});

describe('DSML total capture: batch extraction (S1)', () => {
  it('captures the exact pc live variant (empty-body probe) with a delimiter_corrected annotation', () => {
    const calls = extractToolCalls(`I'll check. ${F_PC} ok`, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: MCP_TOOL_LIST_NAME,
      payload: {},
      parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE, retryable: false },
    });
    // raw is normalized-canonical: the corrupted bytes never leak into records
    expect(calls[0].raw).not.toContain('｜｜DSML｜');
    expect(calls[0].raw.startsWith(`<｜DSML｜invoke name="${MCP_TOOL_LIST_NAME}">`)).toBe(true);
  });

  it('captures the pc variant with intact parameter tags and correct payload', () => {
    const calls = extractToolCalls(F_PC_WITH_PARAMS, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: 'sample_tool',
      payload: { value: 'approved' },
      parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE },
    });
  });

  it('captures every generalized bar-grid cell through the legacy machinery', () => {
    const cells: Array<[number, number]> = [[3, 1], [1, 2], [3, 3], [2, 2], [8, 1], [1, 8]];
    for (const [k, m] of cells) {
      const block = [
        `<${BAR.repeat(k)}DSML${BAR.repeat(m)}calls>`,
        `<${BAR.repeat(k)}DSML${BAR.repeat(m)}invoke name="sample_tool">`,
        `<${BAR.repeat(k)}DSML${BAR.repeat(m)}parameter name="value" string="true">v</${BAR.repeat(k)}DSML${BAR.repeat(m)}parameter>`,
        `</${BAR.repeat(k)}DSML${BAR.repeat(m)}invoke>`,
        `</${BAR.repeat(k)}DSML${BAR.repeat(m)}calls>`,
      ].join('');
      const calls = extractToolCalls(block, { descriptors });
      expect(calls, `bar grid (${k},${m})`).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        invocationName: 'sample_tool',
        payload: { value: 'v' },
        parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE },
      });
    }
  });

  it('captures a mixed-shape block (single-bar wrapper, double-both invoke, triple-bar parameters)', () => {
    const mixed = [
      '<｜DSML｜tool_calls>',
      '<｜｜DSML｜｜ invoke name="sample_tool">',
      '<｜｜｜DSML｜｜｜ parameter name="value" string="true">deep</｜｜｜DSML｜｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(mixed, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: 'sample_tool',
      payload: { value: 'deep' },
      parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE },
    });
  });

  it('captures a closer with a different bar shape than the opener (any-shape closer)', () => {
    const block = [
      '<｜｜DSML｜tool_calls>',
      '<｜｜DSML｜invoke name="sample_tool">',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(block, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0].invocationName).toBe('sample_tool');
  });

  it('captures a wrapperless bare invoke block (wrapper optional)', () => {
    const canonicalBare = '<｜DSML｜invoke name="sample_tool"></｜DSML｜invoke>';
    const canonicalCalls = extractToolCalls(canonicalBare, { descriptors });
    expect(canonicalCalls).toHaveLength(1);
    expect(canonicalCalls[0].invocationName).toBe('sample_tool');
    expect(canonicalCalls[0].parseError).toBeUndefined();

    const corruptedBare = '<｜｜DSML｜｜ invoke name="sample_tool">x</｜｜DSML｜｜ invoke>';
    const calls = extractToolCalls(`before ${corruptedBare} after`, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0].invocationName).toBe('sample_tool');
    expect(calls[0].parseError?.code).toBe(TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE);
  });

  it('claims an unclosed generalized opener to EOF and still extracts the inner invoke', () => {
    const unclosed = [
      '<｜｜DSML｜｜ calls>',
      `<｜｜DSML｜｜ invoke name="${MCP_TOOL_LIST_NAME}">`,
      '</｜｜DSML｜｜ invoke>',
    ].join('\n');
    const calls = extractToolCalls(`lead ${unclosed}`, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0].invocationName).toBe(MCP_TOOL_LIST_NAME);
  });

  it('extractLegacyToolCalls finds generalized blocks too (StreamFn fallback leg)', () => {
    expect(extractLegacyToolCalls(F_PC, { descriptors })).toHaveLength(1);
  });

  it('keeps 9-bar runs, fused DSML, and no-left-bar shapes as PROSE (documented bound)', () => {
    const nineBars = [
      `<${BAR.repeat(9)}DSML${BAR}calls>`,
      `<${BAR.repeat(9)}DSML${BAR}invoke name="sample_tool">`,
      `</${BAR.repeat(9)}DSML${BAR}invoke>`,
      `</${BAR.repeat(9)}DSML${BAR}calls>`,
    ].join('');
    const text = `before ${nineBars} after`;
    expect(extractToolCalls(text, { descriptors })).toHaveLength(0);
    expect(stripToolCalls(text, { descriptors })).toBe(text);

    const fused = '<｜DSMLtool_calls> x <DSML｜tool_calls>y</DSML｜tool_calls>';
    expect(extractToolCalls(fused, { descriptors })).toHaveLength(0);
  });

  it('strips generalized blocks from display exactly as it extracts them (strip symmetry)', () => {
    expect(stripToolCalls(`Before ${F_PC} after`, { descriptors })).toBe('Before  after');
    // unclosed opener claims to EOF on the display leg (aligned with history)
    expect(stripToolCalls(`keep <｜｜DSML｜｜ calls> swallow`, { descriptors })).toBe('keep');
    // 9-bar prose stays
    expect(stripToolCalls(`x <${BAR.repeat(9)}DSML${BAR}calls> y`, { descriptors })).toBe(
      `x <${BAR.repeat(9)}DSML${BAR}calls> y`,
    );
  });

  it('strips STRIPPED-NO-RECORD regions: a recognized block with no extractable invoke never renders', () => {
    const noName = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="">',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('');
    expect(extractToolCalls(noName, { descriptors })).toHaveLength(0);
    expect(stripToolCalls(`a ${noName} b`, { descriptors })).toBe('a  b');

    const malformedAttr = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=x></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
    expect(extractToolCalls(malformedAttr, { descriptors })).toHaveLength(0);
    expect(stripToolCalls(`a ${malformedAttr} b`, { descriptors })).toBe('a  b');
  });

  it('claims a wrapper block ONCE (C1 beats C2): no duplicate records for nested invokes', () => {
    const nested = [
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="sample_tool">',
      '<｜DSML｜parameter name="value" string="true">outer</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '<｜DSML｜invoke name="sample_tool">',
      '<｜DSML｜parameter name="value" string="true">inner</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(nested, { descriptors });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.parseError === undefined)).toBe(true);
  });

  it('recovers content-level failures with the EXISTING structured codes (never prose)', () => {
    // unterminated invoke inside a closed generalized block
    const unterminated = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="sample_tool">',
      '<｜｜DSML｜｜ parameter name="value" string="true">v</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ calls>',
    ].join('');
    const calls = extractToolCalls(unterminated, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0].parseError?.code).toBe(MISMATCHED_TOOL_CALL_ERROR_CODE);
    expect(stripToolCalls(unterminated, { descriptors })).toBe('');

    // unknown invocation name inside a recognized block: descriptor-less call
    const unknown = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="not_a_real_tool">',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('');
    const unknownCalls = extractToolCalls(unknown, { descriptors });
    expect(unknownCalls).toHaveLength(1);
    expect(unknownCalls[0].invocationName).toBe('not_a_real_tool');
    expect(stripToolCalls(unknown, { descriptors })).toBe('');
  });
});

describe('DSML total capture: summary counting (delimiter_corrected executes)', () => {
  it('counts corrected calls as EXECUTED in the display summary (格式错误 only for blocking codes)', () => {
    const summary = replaceToolCallsWithSummary(F_PC_WITH_PARAMS, { descriptors });
    expect(summary).toContain('已调用工具（1次）');
    expect(summary).not.toContain('格式错误');

    const blocked = replaceToolCallsWithSummary(
      '<｜DSML｜tool_calls><｜DSML｜invoke name="sample_tool">v</｜DSML｜tool_calls>',
      { descriptors },
    );
    expect(blocked).toContain('格式错误');
  });
});

describe('DSML total capture: execution semantics (S9 non-blocking gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Tool-history persistence writes through chrome.storage in production;
    // stub it like the sibling runtime suites do.
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createProviderRuntime() {
    const execute = vi.fn(async () => ({ ok: true, summary: 'provider completed' }));
    const provider: RuntimeToolProvider = {
      registration: { kind: 'local', id: 'test' },
      listTools: async () => descriptors.filter((entry) => entry.id.startsWith('local:test:')),
      execute,
    };
    const runtime = createRuntimeToolRuntime(new ToolProviderRegistry([provider]));
    return { runtime, execute };
  }

  it('EXECUTES a delimiter-corrected call through the runtime (provider result, not parseError result)', async () => {
    const { runtime, execute } = createProviderRuntime();
    const [call] = extractToolCalls(F_PC_WITH_PARAMS, { descriptors });
    const result = await runtime.executeToolCall(call, 'manual_chat');
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('provider completed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('EXECUTES the empty-body pc probe call (a parameterless tool must run)', async () => {
    const { runtime, execute } = createProviderRuntime();
    const [call] = extractToolCalls(F_PC, { descriptors });
    expect(call.payload).toEqual({});
    const result = await runtime.executeToolCall(call, 'manual_chat');
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('still BLOCKS a content-level failure (close mismatch) with the structured error', async () => {
    const { runtime, execute } = createProviderRuntime();
    const [call] = extractToolCalls(
      '<｜DSML｜tool_calls><｜DSML｜invoke name="sample_tool">v</｜DSML｜tool_calls>',
      { descriptors },
    );
    expect(call.parseError?.code).toBe(MISMATCHED_TOOL_CALL_ERROR_CODE);
    const result = await runtime.executeToolCall(call, 'manual_chat');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(MISMATCHED_TOOL_CALL_ERROR_CODE);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('DSML total capture: ReDoS / linear-scan invariant (F-TIMING)', () => {
  it('pc-variant block embedded in 120K text parses well under the bound', () => {
    const input = 'x'.repeat(60_000) + F_PC + 'y'.repeat(59_000);
    const t0 = performance.now();
    const calls = extractToolCalls(input, { descriptors });
    expect(calls).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('repeated 8-bar DSML runs without tags stay linear', () => {
    const unit = `<${BAR.repeat(8)}DSML${BAR.repeat(8)}`;
    const input = unit.repeat(Math.ceil(120_000 / unit.length));
    const t0 = performance.now();
    expect(extractToolCalls(input, { descriptors })).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('repeated well-formed openers with no closers stay linear (unclosed claim recovers ONE mismatched call)', () => {
    const unit = '<｜｜DSML｜｜ invoke name="x">';
    const input = unit.repeat(Math.ceil(120_000 / unit.length));
    const t0 = performance.now();
    // Unclosed C2 claim to EOF: the inner unterminated invoke surfaces as a
    // single tool_call_close_mismatched record (structured error, never
    // prose), and the scan stays linear.
    const calls = extractToolCalls(input, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parseError?.code).toBe(MISMATCHED_TOOL_CALL_ERROR_CODE);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('unclosed generalized opener plus 120K whitespace stays linear', () => {
    const input = '<｜｜DSML｜｜ calls>' + ' '.repeat(119_000);
    const t0 = performance.now();
    expect(extractToolCalls(input, { descriptors })).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('strips a 120K unclosed generalized block linearly', () => {
    const input = 'lead <｜｜DSML｜｜ calls>' + 'z'.repeat(120_000);
    const t0 = performance.now();
    expect(stripToolCalls(input, { descriptors })).toBe('lead');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('scales linearly: 120K of adversarial bar runs takes about twice 60K', () => {
    const unit = `<${BAR.repeat(8)}DSML${BAR.repeat(8)}DSML${BAR.repeat(8)}`;
    const run = (size: number): number => {
      const input = unit.repeat(Math.ceil(size / unit.length));
      const t0 = performance.now();
      normalizeDsmlDelimiters(input);
      findNextDsmlToolBlock(input, 0);
      return performance.now() - t0;
    };
    const small = run(60_000);
    const large = run(120_000);
    expect(large).toBeLessThan(Math.max(2000, small * 6));
  });
});
