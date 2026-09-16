import { describe, expect, it } from 'vitest';
import { createArtifactToolDescriptors } from '../core/artifact';
import { createDefaultToolDescriptors } from '../core/tool';
import {
  extractLegacyToolCalls,
  extractToolCalls,
  replaceToolCallsWithSummary,
  stripToolCalls,
} from '../core/interceptor/tool-parser';
import { stripToolCallsFromHistory } from '../core/interceptor/history-cleanup';
import {
  MISMATCHED_TOOL_CALL_ERROR_CODE,
  TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE,
} from '../core/tool/execution-error';

/**
 * P0.2 DSML near-miss delimiter policy (bounded normalization). Models
 * imitating DeepSeek native protocol tokens sometimes emit legacy DSML tags
 * with a DOUBLED fullwidth bar (`<｜｜DSML｜…`). Exactly these corrupted
 * analogues are recognized as a corrupted legacy block: the delimiter bytes
 * are normalized and the block re-extracted through the SAME legacy
 * machinery, the recovered call carries `tool_call_delimiter_corrected`, and
 * the raw bytes are suppressed from display strip and history cleanup — never
 * prose, never a silent drop. Recognition is structural (exact
 * `<｜｜DSML｜` tag literals), never a bare `｜DSML｜` substring.
 */
describe('DSML near-miss double-bar delimiter policy (P0.2)', () => {
  const descriptors = createArtifactToolDescriptors('en');

  const corruptedBlock = [
    '<｜｜DSML｜tool_calls>',
    '<｜｜DSML｜invoke name="artifact_create">',
    '<｜｜DSML｜parameter name="filename" string="true">a.txt</｜｜DSML｜parameter>',
    '<｜｜DSML｜parameter name="content" string="true">hello</｜｜DSML｜parameter>',
    '</｜｜DSML｜invoke>',
    '</｜｜DSML｜tool_calls>',
  ].join('');

  it('recovers a corrupted double-bar block through the legacy machinery with tool_call_delimiter_corrected', () => {
    const calls = extractToolCalls(`Before ${corruptedBlock} after`, { descriptors });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: 'artifact_create',
      payload: { filename: 'a.txt', content: 'hello' },
      parseError: {
        code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE,
        retryable: false,
      },
    });
    expect(calls[0].parseError?.message).toContain('｜｜DSML｜');
    // The recovered call carries the normalized (canonical) bytes: the
    // corrupted delimiters never leak into tool records or restore records.
    expect(calls[0].raw.startsWith('<｜DSML｜invoke name="artifact_create">')).toBe(true);
    expect(calls[0].raw.endsWith('</｜DSML｜invoke>')).toBe(true);
    expect(calls[0].raw).not.toContain('｜｜DSML｜');
  });

  it('extractLegacyToolCalls finds the same corrupted block (StreamFn fallback leg)', () => {
    const calls = extractLegacyToolCalls(corruptedBlock, { descriptors });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: 'artifact_create',
      payload: { filename: 'a.txt', content: 'hello' },
      parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE },
    });
  });

  it('normalizes mixed corruption: single-bar inner tags inside a double-bar block still parse', () => {
    const mixed = [
      '<｜｜DSML｜tool_calls>',
      '<｜｜DSML｜invoke name="artifact_create">',
      '<｜DSML｜parameter name="filename" string="true">mixed.txt</｜DSML｜parameter>',
      '</｜｜DSML｜invoke>',
      '</｜｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(mixed, { descriptors });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: 'artifact_create',
      payload: { filename: 'mixed.txt' },
      parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE },
    });
  });

  it('failed inner extraction falls through to the existing mismatched-close recovery, never prose', () => {
    const unterminated = [
      '<｜｜DSML｜tool_calls>',
      '<｜｜DSML｜invoke name="artifact_create">',
      '<｜｜DSML｜parameter name="filename" string="true">a.txt</｜｜DSML｜parameter>',
      '</｜｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(unterminated, { descriptors });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: 'artifact_create',
      payload: { filename: 'a.txt' },
      parseError: { code: MISMATCHED_TOOL_CALL_ERROR_CODE, retryable: false },
    });
    // The recovery record does not mask the delimiter correction, and the
    // correction does not mask the recovery: one code wins (no compound).
    expect(calls[0].parseError?.code).not.toBe(TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE);
    expect(stripToolCalls(unterminated, { descriptors })).toBe('');
  });

  it('suppresses the raw bytes from display strip and renders them as malformed in the summary', () => {
    const text = `Before ${corruptedBlock} after`;

    expect(stripToolCalls(text, { descriptors })).toBe('Before  after');

    const summary = replaceToolCallsWithSummary(text, { descriptors });
    expect(summary).toContain('已调用工具');
    expect(summary).toContain('格式错误');
    expect(summary).not.toContain('｜｜DSML｜');
    expect(summary).not.toContain('a.txt');
  });

  it('history cleanup strips the corrupted block and restores the recovered call', () => {
    const records: any[] = [];
    const json = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 40,
              message_role: 'assistant',
              content: `Saved.${corruptedBlock}`,
            },
          ],
        },
      },
    };

    stripToolCallsFromHistory(json, {
      toolDescriptors: [
        ...createDefaultToolDescriptors(),
        ...createArtifactToolDescriptors(),
      ],
      onToolCallsRestored: (next) => records.push(...next),
    });

    expect(json.data.biz_data.chat_messages[0].content).toBe('Saved.');
    expect(records).toHaveLength(1);
    expect(records[0].calls[0]).toMatchObject({
      name: 'artifact_create',
      payload: { filename: 'a.txt', content: 'hello' },
      parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE },
    });
  });

  it('history cleanup strips a huge corrupted block without parsing its payload content', () => {
    const records: any[] = [];
    const huge = [
      '<｜｜DSML｜tool_calls>',
      '<｜｜DSML｜invoke name="artifact_create">',
      '<｜｜DSML｜parameter name="content" string="true">',
      'n'.repeat(130_000),
      '</｜｜DSML｜parameter>',
      '</｜｜DSML｜invoke>',
      '</｜｜DSML｜tool_calls>',
    ].join('');
    const json = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 41,
              message_role: 'assistant',
              content: `Saved.${huge}`,
            },
          ],
        },
      },
    };

    stripToolCallsFromHistory(json, {
      toolDescriptors: [
        ...createDefaultToolDescriptors(),
        ...createArtifactToolDescriptors(),
      ],
      onToolCallsRestored: (next) => records.push(...next),
    });

    expect(json.data.biz_data.chat_messages[0].content).toBe('Saved.');
    expect(records).toHaveLength(1);
    expect(records[0].calls[0].name).toBe('artifact_create');
    expect(records[0].calls[0].payload).toEqual({});
  });

  it('leaves prose containing a bare ｜DSML｜ substring or shapeless double bars untouched', () => {
    const text = 'Prose ｜DSML｜ and shapeless ｜｜DSML｜ bars stay prose.';
    const json = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 42,
              message_role: 'assistant',
              content: text,
            },
          ],
        },
      },
    };

    expect(extractToolCalls(text, { descriptors })).toHaveLength(0);
    expect(stripToolCalls(text, { descriptors })).toBe(text);

    let restored = 0;
    stripToolCallsFromHistory(json, {
      toolDescriptors: [
        ...createDefaultToolDescriptors(),
        ...createArtifactToolDescriptors(),
      ],
      onToolCallsRestored: () => restored += 1,
    });
    expect(restored).toBe(0);
    expect(json.data.biz_data.chat_messages[0].content).toBe(text);
  });

  it('keeps single-bar legacy behavior unchanged (no corrected parseError, no re-recognition)', () => {
    const legacyBlock = [
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="artifact_create">',
      '<｜DSML｜parameter name="filename" string="true">legacy.txt</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(legacyBlock, { descriptors });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invocationName: 'artifact_create',
      payload: { filename: 'legacy.txt' },
    });
    expect(calls[0].parseError).toBeUndefined();
  });

  it('never yields a second record for a call inside a corrupted block (dedupe policy)', () => {
    // A nested single-bar block inside a corrupted double-bar block is
    // extracted exactly once by the claimed corrupted block; the single-bar
    // scan must not re-extract the same region into a duplicate record.
    const nested = [
      '<｜｜DSML｜tool_calls>',
      '<｜｜DSML｜invoke name="artifact_create">',
      '<｜｜DSML｜parameter name="filename" string="true">outer.txt</｜｜DSML｜parameter>',
      '</｜｜DSML｜invoke>',
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="artifact_bundle_create">',
      '<｜DSML｜parameter name="filename" string="true">inner.zip</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
      '</｜｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(nested, { descriptors });

    expect(calls.filter((call) => call.invocationName === 'artifact_bundle_create')).toHaveLength(1);
    expect(calls.filter((call) => call.invocationName === 'artifact_create')).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('extracts side-by-side single-bar and corrupted blocks in document order', () => {
    const singleBlock = [
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="artifact_create">',
      '<｜DSML｜parameter name="filename" string="true">single.txt</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('');
    const corrupted = [
      '<｜｜DSML｜tool_calls>',
      '<｜｜DSML｜invoke name="artifact_bundle_create">',
      '<｜｜DSML｜parameter name="filename" string="true">corrupt.zip</｜｜DSML｜parameter>',
      '</｜｜DSML｜invoke>',
      '</｜｜DSML｜tool_calls>',
    ].join('');
    const calls = extractToolCalls(`${singleBlock} middle text ${corrupted}`, { descriptors });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      invocationName: 'artifact_create',
      payload: { filename: 'single.txt' },
    });
    expect(calls[0].parseError).toBeUndefined();
    expect(calls[1]).toMatchObject({
      invocationName: 'artifact_bundle_create',
      payload: { filename: 'corrupt.zip' },
      parseError: { code: TOOL_CALL_DELIMITER_CORRECTED_ERROR_CODE },
    });

    const stripped = stripToolCalls(`lead ${singleBlock} middle text ${corrupted} tail`, { descriptors });
    expect(stripped).toBe('lead  middle text  tail');
  });
});
