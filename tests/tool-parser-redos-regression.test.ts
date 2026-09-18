import { describe, expect, it } from 'vitest';
import { extractToolCalls, stripToolCalls, replaceToolCallsWithSummary } from '../core/interceptor/tool-parser';
import { createArtifactToolDescriptors } from '../core/artifact';
import { TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE } from '../core/tool/execution-error';

describe('H1 ReDoS regression', () => {
  const descriptors = createArtifactToolDescriptors('en');
  it('parses 120K whitespace without catastrophic backtracking', () => {
    const input = '<artifact_create>' + ' '.repeat(119_000);
    const t0 = performance.now();
    const calls = extractToolCalls(input, { descriptors });
    expect(calls).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('strips unterminated tag fast (kept verbatim)', () => {
    const input = '<artifact_create>' + ' '.repeat(119_000);
    const t0 = performance.now();
    expect(stripToolCalls(input, { descriptors })).toBe('<artifact_create>');
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('replace-with-summary on unterminated tag fast', () => {
    const input = '<artifact_create>' + ' '.repeat(119_000);
    const t0 = performance.now();
    expect(replaceToolCallsWithSummary(input, { descriptors })).toBe(input);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('legacy block 120K whitespace without catastrophic backtracking', () => {
    const input = '<｜DSML｜tool_calls>' + ' '.repeat(119_000);
    const t0 = performance.now();
    expect(extractToolCalls(input, { descriptors })).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('mismatched close tag without catastrophic backtracking', () => {
    const input = '<artifact_create>' + ' '.repeat(50_000) + '</artifact_creat>';
    const t0 = performance.now();
    extractToolCalls(input, { descriptors });
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('recovers a mismatched-close call bounded by a foreign terminator fast (linear)', () => {
    // Deliberate expectation change (mismatched-close recovery task): the
    // foreign `</invoke>` terminator now BOUNDS the block, so the call is
    // recovered as tool_call_close_mismatched and stripped. Pure unterminated
    // input (tests above) keeps the 'kept verbatim' expectation.
    const input = '<artifact_create>' + ' '.repeat(120_000) + '</invoke>';
    const t0 = performance.now();
    const calls = extractToolCalls(input, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0].parseError?.code).toBe('tool_call_close_mismatched');
    expect(stripToolCalls(input, { descriptors })).toBe('');
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('parses a well-formed call inside 120K text fast', () => {
    const input = 'x'.repeat(60_000) + '<artifact_create>{"filename":"a","content":"b"}</artifact_create>' + 'y'.repeat(60_000);
    const t0 = performance.now();
    const calls = extractToolCalls(input, { descriptors });
    expect(calls).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('corrupted double-bar block scan stays linear without catastrophic backtracking', () => {
    const input = '<｜｜DSML｜tool_calls>' + ' '.repeat(119_000);
    const t0 = performance.now();
    expect(extractToolCalls(input, { descriptors })).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('recovers a corrupted double-bar block bounded inside 120K text fast (linear)', () => {
    const block = [
      '<｜｜DSML｜tool_calls>',
      '<｜｜DSML｜invoke name="artifact_create">',
      '<｜｜DSML｜parameter name="filename" string="true">a.txt</｜｜DSML｜parameter>',
      '</｜｜DSML｜invoke>',
      '</｜｜DSML｜tool_calls>',
    ].join('');
    const input = 'x'.repeat(60_000) + block + 'y'.repeat(60_000);
    const t0 = performance.now();
    const calls = extractToolCalls(input, { descriptors });
    expect(calls).toHaveLength(1);
    expect(calls[0].parseError?.code).toBe(TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('DSML total capture: adversarial timing (pc directives 2026-09-18)', () => {
  const descriptors = createArtifactToolDescriptors('en');
  const bar = '｜';
  it('pc-variant block embedded in 120K text parses well under the bound', () => {
    const block = [
      `<${bar.repeat(2)}DSML${bar.repeat(2)} calls>`,
      `<${bar.repeat(2)}DSML${bar.repeat(2)} invoke name="artifact_create">`,
      `<${bar.repeat(2)}DSML${bar.repeat(2)} parameter name="filename" string="true">a.txt</${bar.repeat(2)}DSML${bar.repeat(2)} parameter>`,
      `</${bar.repeat(2)}DSML${bar.repeat(2)} invoke>`,
      `</${bar.repeat(2)}DSML${bar.repeat(2)} calls>`,
    ].join('');
    const input = 'x'.repeat(60_000) + block + 'y'.repeat(59_000);
    const t0 = performance.now();
    const calls = extractToolCalls(input, { descriptors });
    expect(calls).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('120K of 8-bar DSML runs without tag names stays linear', () => {
    const unit = `<${bar.repeat(8)}DSML${bar.repeat(8)}`;
    const input = unit.repeat(Math.ceil(120_000 / unit.length));
    const t0 = performance.now();
    expect(extractToolCalls(input, { descriptors })).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('unclosed generalized opener plus 120K whitespace stays linear', () => {
    const input = `<${bar.repeat(3)}DSML${bar}calls>` + ' '.repeat(119_000);
    const t0 = performance.now();
    expect(extractToolCalls(input, { descriptors })).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('normalize+claim scales linearly: 120K of adversarial bar runs is about twice 60K', async () => {
    const unit = `<${bar.repeat(8)}DSML${bar.repeat(8)}DSML${bar.repeat(8)}`;
    const { normalizeDsmlDelimiters, findNextDsmlToolBlock } = await import('../core/interceptor/dsml-delimiters');
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
