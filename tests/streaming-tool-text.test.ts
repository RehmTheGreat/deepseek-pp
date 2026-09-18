import { describe, expect, it } from 'vitest';
import { createStreamingToolTextAccumulator } from '../core/interceptor/streaming-tool-text';
import { createMemoryToolDescriptors } from '../core/tool';
import { createArtifactToolDescriptors } from '../core/artifact';

describe('createStreamingToolTextAccumulator', () => {
  const descriptors = createMemoryToolDescriptors('en');

  it('passes ordinary text through incrementally', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    expect(stream.append('hello ')).toBe('hello ');
    expect(stream.append('world')).toBe('hello world');
    expect(stream.flush()).toBe('hello world');
  });

  it('suppresses completed tool calls across chunk boundaries', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    expect(stream.append('Before <memory_')).toBe('Before ');
    expect(stream.append('save>{"name":"n","content":"c"}</memory_')).toBe('Before ');
    expect(stream.append('save> after')).toBe('Before  after');
    expect(stream.flush()).toBe('Before  after');
  });

  it('releases false-positive partial open tags on flush', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    expect(stream.append('literal <memory_')).toBe('literal ');
    expect(stream.flush()).toBe('literal <memory_');
  });

  it('keeps tail text after a same-chunk tool call', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    const text = [
      'A',
      '<memory_save>{"name":"n","content":"c"}</memory_save>',
      'B',
    ].join('');

    expect(stream.append(text)).toBe('AB');
  });

  it('detects tool calls after literal less-than text', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    const text = [
      'A < draft ',
      '<memory_save>{"name":"n","content":"c"}</memory_save>',
      'B',
    ].join('');

    expect(stream.append(text)).toBe('A < draft B');
  });

  it('suppresses legacy DSML tool-call blocks across chunk boundaries', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    expect(stream.append('Before <｜DSML｜tool_')).toBe('Before ');
    expect(stream.append('calls><｜DSML｜invoke name="memory_save">')).toBe('Before ');
    expect(stream.append('<｜DSML｜parameter name="name" string="true">n</｜DSML｜parameter>')).toBe('Before ');
    expect(stream.append('</｜DSML｜invoke></｜DSML｜tool_')).toBe('Before ');
    expect(stream.append('calls> after')).toBe('Before  after');
    expect(stream.flush()).toBe('Before  after');
  });

  it('releases false-positive partial legacy tags on flush', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    expect(stream.append('literal <｜DSML｜tool_')).toBe('literal ');
    expect(stream.flush()).toBe('literal <｜DSML｜tool_');
  });

  it('suppresses whitespace-padded artifact tags without exposing large HTML', () => {
    const stream = createStreamingToolTextAccumulator(createArtifactToolDescriptors('en'));
    const html = '<!doctype html><html><body><canvas></canvas></body></html>' + '<style>.x{color:red}</style>'.repeat(1000);
    const payload = JSON.stringify({ filename: 'demo.html', content: html, language: 'html' });

    expect(stream.append('Before < artifact')).toBe('Before ');
    expect(stream.append('_create >' + payload.slice(0, 16_000))).toBe('Before ');
    expect(stream.append(payload.slice(16_000) + '</ artifact')).toBe('Before ');
    expect(stream.append('_create > after')).toBe('Before  after');
    expect(stream.flush()).toBe('Before  after');
  });
});

// P0.2 near-miss delimiter policy: the corrupted double-bar legacy block is
// live-suppressed exactly like the single-bar block (no DSML block may ever
// render as prose), including mid-stream across chunk boundaries; prose
// containing a bare ｜DSML｜ substring stays untouched.
describe('createStreamingToolTextAccumulator corrupted double-bar blocks (P0.2)', () => {
  const descriptors = createMemoryToolDescriptors('en');

  it('suppresses corrupted legacy DSML blocks across chunk boundaries', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    expect(stream.append('Before <｜｜DSML｜tool_')).toBe('Before ');
    expect(stream.append('calls><｜｜DSML｜invoke name="memory_save">')).toBe('Before ');
    expect(stream.append('<｜｜DSML｜parameter name="name" string="true">n</｜｜DSML｜parameter>')).toBe('Before ');
    expect(stream.append('</｜｜DSML｜invoke></｜｜DSML｜tool_')).toBe('Before ');
    expect(stream.append('calls> after')).toBe('Before  after');
    expect(stream.flush()).toBe('Before  after');
  });

  it('leaves prose with a bare ｜DSML｜ substring or shapeless double bars visible', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);

    const text = 'Prose ｜DSML｜ and shapeless ｜｜DSML｜ bars stay visible.';
    expect(stream.append(text)).toBe(text);
    expect(stream.flush()).toBe(text);
  });
});

describe('DSML total capture: live suppression of every variant (S3)', () => {
  const descriptors = createMemoryToolDescriptors('en');

  it('suppresses the exact pc live variant across chunk boundaries', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);
    // bars doubled on BOTH sides, space before the name, `calls` wrapper.
    expect(stream.append('Answer <｜｜DSML｜｜ c')).toBe('Answer ');
    expect(stream.append('alls><｜｜DSML｜｜ invoke name="x">')).toBe('Answer ');
    expect(stream.append('body</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls> done')).toBe('Answer  done');
    expect(stream.flush()).toBe('Answer  done');
  });

  it('suppresses bar-grid and wrapperless variants', () => {
    const grid = [
      '<｜｜｜DSML｜｜｜ calls>',
      '<｜｜｜DSML｜｜｜ invoke name="x">v</｜｜｜DSML｜｜｜ invoke>',
      '</｜｜｜DSML｜｜｜ calls>',
    ].join('');
    const stream = createStreamingToolTextAccumulator(descriptors);
    expect(stream.append(`pre ${grid} post`)).toBe('pre  post');

    const bare = '<｜DSML｜invoke name="x">v</｜DSML｜invoke>';
    const bareStream = createStreamingToolTextAccumulator(descriptors);
    expect(bareStream.append(`a ${bare} b`)).toBe('a  b');
  });

  it('holds a partial generalized open across chunks, then suppresses', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);
    expect(stream.append('lead <｜｜DSML｜｜ inv')).toBe('lead ');
    expect(stream.append('oke name="x">v</｜｜DSML｜｜ invoke> tail')).toBe('lead  tail');
  });

  it('DROPS an unclosed generalized block at flush (never prose)', () => {
    const stream = createStreamingToolTextAccumulator(descriptors);
    expect(stream.append('visible <｜｜DSML｜｜ calls> swallowed')).toBe('visible ');
    expect(stream.flush()).toBe('visible ');
  });

  it('9-bar and fused shapes stay prose (documented bound)', () => {
    const bar = '｜';
    const nine = `<${bar.repeat(9)}DSML${bar}calls>x</${bar.repeat(9)}DSML${bar}calls>`;
    const stream = createStreamingToolTextAccumulator(descriptors);
    expect(stream.append(`a ${nine} b`)).toBe(`a ${nine} b`);
    const fused = createStreamingToolTextAccumulator(descriptors);
    expect(fused.append('a <｜DSMLcalls> b')).toBe('a <｜DSMLcalls> b');
  });
  it('suppresses the pc variant at EVERY chunk-boundary split point (property loop)', () => {
    // Task-review fix 3 (design §5 F-SPLIT): the exact live variant (bars
    // doubled on both sides, space before the tag name, `calls` wrapper),
    // split at EVERY index - the boundary can fall inside either bar run,
    // the DSML token, the whitespace, or the tag name. At every split the
    // cumulative visible text NEVER contains DSML bytes and the final flush
    // is exactly the surrounding prose.
    const block = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="x">body</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('');
    const full = `Answer ${block} done`;
    for (let split = 1; split < full.length; split += 1) {
      const stream = createStreamingToolTextAccumulator(descriptors);
      const afterFirst = stream.append(full.slice(0, split));
      const afterSecond = stream.append(full.slice(split));
      expect(afterFirst, `first chunk at split ${split}`).not.toContain('DSML');
      expect(afterSecond, `second chunk at split ${split}`).not.toContain('DSML');
      expect(stream.flush(), `flush at split ${split}`).toBe('Answer  done');
    }
  });
});
