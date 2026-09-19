import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractToolCalls, stripToolCalls } from '../core/interceptor/tool-parser';
import { createStreamingToolCallParser } from '../core/interceptor/streaming-tool-call-parser';
import { createStreamingToolTextAccumulator } from '../core/interceptor/streaming-tool-text';
import { XmlToolStreamFilter } from '../core/interceptor/fetch-hook';
import { stripToolCallsFromHistory } from '../core/interceptor/history-cleanup';
import {
  createDeepSeekSseFrameDecoder,
  extractResponseTextFromParsed,
} from '../core/deepseek/stream-codec';
import { TOOL_CALL_NAME_AMBIGUOUS_ERROR_CODE } from '../core/tool/execution-error';
import { resolveToolTagName } from '../core/tool/tag-variants';
import type { ToolDescriptor } from '../core/tool/types';
import type { ToolCall } from '../core/types';
import type { InlineAgentStartPayload } from '../core/inline-agent/types';

const adapter = vi.hoisted(() => ({
  createPowHeaders: vi.fn(),
  submitPromptStreaming: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: () => ({ Authorization: 'Bearer test-token' }),
  createPowHeaders: adapter.createPowHeaders,
  submitPromptStreaming: adapter.submitPromptStreaming,
}));

/**
 * D2 (fix round 4, live chat 2e15b839 / trace pyr24x wire replay).
 *
 * Identical `<tool_list>` markup was EXECUTED in step 4 of one run but
 * silently DROPPED and leaked as visible prose in steps 0-3 and 5: the model
 * wrote the tool's SHORT descriptor name (`<tool_list>`, `<tool_invoke>`)
 * while the parsers match EXACT advertised invocation names only
 * (`mcp_t_<server>_tool_list`). Nothing told the model - it burned steps
 * retrying blind ("My earlier tool_list/tool_invoke calls returned nothing at
 * all"). This file replays the captured markup and pins the unified behavior:
 *
 *  - ONE shared tag-name resolution truth (core/tool/tag-variants.ts) behind
 *    the batch parser, the streaming parser, the visible-text accumulator,
 *    the page-side XmlToolStreamFilter and the history-cleanup marker gate;
 *  - a short tag resolving to exactly one advertised tool EXECUTES with a
 *    non-blocking `tool_call_name_recovered` annotation (same policy as
 *    tool_call_delimiter_corrected: recovered bytes execute, no lecture);
 *  - an ambiguous short tag becomes a BLOCKING structured parse error
 *    (`tool_call_name_ambiguous`) that reaches the model through the existing
 *    invalidFormat feedback channel - never silence, never prose leak;
 *  - full invocation names keep the released clean path byte-for-byte.
 */

function mcpDescriptor(serverId: string, toolName: string): ToolDescriptor {
  const invocationName = `mcp_t_${serverId}_${toolName}`;
  return {
    id: `mcp:${serverId}:${toolName}`,
    provider: {
      kind: 'mcp',
      id: serverId,
      displayName: serverId,
      transport: 'sse',
    },
    name: toolName,
    invocationName,
    title: toolName,
    description: `MCP tool ${toolName}`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

/** Verbatim captured shape: fu2-server-messages.json id 36 (step 0 of pyr24x). */
const CAPTURED_STEP_TEXT = [
  'Current time check done. I need to find what scheduler and email capabilities actually exist before promising anything.',
  '',
  '<tool_list>',
  '{"limit": 300}',
  '</tool_list>',
  '',
  '<tool_list>',
  '{"limit": 300}',
  '</tool_list>',
].join('\n');

const GATEWAY_A_TOOL_LIST = mcpDescriptor('a1vps', 'tool_list');
const GATEWAY_B_TOOL_LIST = mcpDescriptor('local1mcp', 'tool_list');

describe('shared tag-name resolution (core/tool/tag-variants.ts)', () => {
  it('treats exact advertised invocation names as the released catalog path', () => {
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    expect(resolveToolTagName('mcp_t_a1vps_tool_list', descriptors)).toEqual({
      kind: 'invocation',
    });
  });

  it('a unique short name is the released accepted alias on both surfaces', () => {
    // One server exposing tool_list: the catalog accepts the short name as an
    // alias, so resolution is the exact path and `<tool_list>` parses clean.
    const descriptors = [GATEWAY_A_TOOL_LIST, mcpDescriptor('a1vps', 'tool_invoke')];
    expect(resolveToolTagName('tool_list', descriptors)).toEqual({ kind: 'invocation' });
    const calls = extractToolCalls(CAPTURED_STEP_TEXT, { descriptors });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.invocationName).toBe('mcp_t_a1vps_tool_list');
      expect(call.descriptorId).toBe(GATEWAY_A_TOOL_LIST.id);
      expect(call.parseError).toBeUndefined();
    }
  });

  it('reports every candidate when a short name matches several servers', () => {
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    expect(resolveToolTagName('tool_list', descriptors)).toEqual({
      kind: 'ambiguous',
      invocationNames: ['mcp_t_a1vps_tool_list', 'mcp_t_local1mcp_tool_list'],
    });
  });

  it('never claims names no advertised tool uses', () => {
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    expect(resolveToolTagName('div', descriptors)).toBeNull();
    expect(resolveToolTagName('tool_lists', descriptors)).toBeNull();
  });
});

describe('batch parser + strip parity (captured wire)', () => {
  it('surfaces the dropped short-name calls as structured ambiguous records', () => {
    const calls = extractToolCalls(CAPTURED_STEP_TEXT, {
      descriptors: [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST],
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.parseError?.code).toBe(TOOL_CALL_NAME_AMBIGUOUS_ERROR_CODE);
      expect(call.parseError!.message).toContain('mcp_t_a1vps_tool_list');
      expect(call.parseError!.message).toContain('mcp_t_local1mcp_tool_list');
      expect(call.payload).toEqual({ limit: 300 });
    }
  });

  it('a unique short name is the released accepted alias (clean call)', () => {
    const calls = extractToolCalls(CAPTURED_STEP_TEXT, {
      descriptors: [GATEWAY_A_TOOL_LIST],
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // One server exposing tool_list: the short name is an accepted alias,
      // so the call is bound and carries no error.
      expect(call.invocationName).toBe('mcp_t_a1vps_tool_list');
      expect(call.descriptorId).toBe(GATEWAY_A_TOOL_LIST.id);
      expect(call.parseError).toBeUndefined();
    }
  });

  it('strips the variant markup from display text - never prose leak', () => {
    for (const descriptors of [[GATEWAY_A_TOOL_LIST], [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST]]) {
      const stripped = stripToolCalls(CAPTURED_STEP_TEXT, { descriptors });
      expect(stripped).not.toContain('<tool_list>');
      expect(stripped).not.toContain('</tool_list>');
      expect(stripped).toContain(
        'I need to find what scheduler and email capabilities',
      );
    }
  });

  it('keeps the full invocation-name path clean (step-4 parity pin)', () => {
    const text = CAPTURED_STEP_TEXT.replaceAll(
      '<tool_list>',
      '<mcp_t_a1vps_tool_list>',
    ).replaceAll('</tool_list>', '</mcp_t_a1vps_tool_list>');
    const calls = extractToolCalls(text, {
      descriptors: [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST],
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.invocationName).toBe('mcp_t_a1vps_tool_list');
      expect(call.parseError).toBeUndefined();
    }
  });
});

describe('streaming parity (loop-turn StreamFn surfaces)', () => {
  it('accumulator suppresses the markup at every chunk split', () => {
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    for (let splitAt = 0; splitAt <= CAPTURED_STEP_TEXT.length; splitAt += 7) {
      const accumulator = createStreamingToolTextAccumulator(descriptors);
      let visible = '';
      visible += accumulator.append(CAPTURED_STEP_TEXT.slice(0, splitAt));
      visible += accumulator.append(CAPTURED_STEP_TEXT.slice(splitAt));
      visible += accumulator.flush();
      expect(visible.includes('<tool_list>'), `split ${splitAt}`).toBe(false);
      expect(visible.includes('</tool_list>'), `split ${splitAt}`).toBe(false);
    }
  });

  it('parser emits the same records as the batch parse at every chunk split', () => {
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    const expected = extractToolCalls(CAPTURED_STEP_TEXT, { descriptors });
    for (let splitAt = 1; splitAt < CAPTURED_STEP_TEXT.length; splitAt += 5) {
      const parser = createStreamingToolCallParser(descriptors);
      const events = [
        parser.append(CAPTURED_STEP_TEXT.slice(0, splitAt)),
        parser.append(CAPTURED_STEP_TEXT.slice(splitAt)),
        parser.flush(),
      ];
      const seen = events.flatMap((event) => [...event.completed, ...event.failed]);
      expect(seen.length, `split ${splitAt}`).toBe(expected.length);
      for (const call of seen) {
        expect(call.parseError?.code).toBe(TOOL_CALL_NAME_AMBIGUOUS_ERROR_CODE);
      }
    }
  });
});

describe('page-side XmlToolStreamFilter parity', () => {
  it('suppresses the variant markup from the visible bytes', () => {
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    // Regular streaming shape: fragment APPEND patches carrying the turn text
    // (the same wire family the live filter consumes).
    const wire = [
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"Current time check done. I need to find what scheduler and email capabilities actually exist before promising anything.\\n\\n"}\n\n',
      'data: {"v":"<tool_list>\\n{\\"limit\\": 300}\\n</tool_list>\\n\\n"}\n\n',
      'data: {"v":"All gateways listed."}\n\n',
    ].join('');
    const decoder = new TextDecoder();
    const output: string[] = [];
    const controller = {
      enqueue(data: Uint8Array) {
        output.push(decoder.decode(data));
      },
    } as ReadableStreamDefaultController<Uint8Array>;
    const frameDecoder = createDeepSeekSseFrameDecoder();
    const filter = new XmlToolStreamFilter(descriptors);
    filter.processFrames(frameDecoder.push(wire), controller);
    filter.processFrames(frameDecoder.finish(), controller);
    filter.flush(controller);
    const visible = output.join('');
    expect(visible).not.toContain('<tool_list>');
    expect(visible).not.toContain('</tool_list>');
    expect(visible).toContain('email capabilities');
    expect(visible).toContain('All gateways listed.');
  });
});

describe('history-cleanup parity (restored history)', () => {
  it('strips variant markup from restored message content', () => {
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    const json = {
      data: {
        chat_messages: [
          { message_id: 36, role: 'ASSISTANT', content: CAPTURED_STEP_TEXT },
        ],
      },
    };
    stripToolCallsFromHistory(json, {
      toolDescriptors: descriptors,
      onToolCallsRestored: () => {},
    });
    const content = json.data.chat_messages[0].content as string;
    expect(content).not.toContain('<tool_list>');
    expect(content).toContain(
      'I need to find what scheduler and email capabilities',
    );
  });
});

describe('loop-turn behavior (engine-level wire replay)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.createPowHeaders.mockResolvedValue({ 'X-DS-PoW-Response': 'pow-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function payloadWith(descriptors: ToolDescriptor[]): InlineAgentStartPayload {
    return {
      loopId: 'loop-variants-1',
      chatSessionId: 'chat-1',
      parentMessageId: 100,
      originalPrompt: 'Discover what tools the gateways expose.',
      agentTaskPrompt: 'Discover what tools the gateways expose.',
      toolExecutions: [],
      promptOptions: {
        modelType: null,
        searchEnabled: false,
        thinkingEnabled: false,
        refFileIds: [],
      },
      toolDescriptors: descriptors,
      locale: 'en',
    };
  }

  function streamedTurn(text: string) {
    return async (
      _input: unknown,
      handlers: { onTextChunk: (t: string) => void },
    ) => {
      handlers.onTextChunk(text);
      return {
        assistantText: '',
        responseMessageId: 101,
        requestMessageId: 100,
        finished: true,
      };
    };
  }

  it('ambiguous short tags never execute and feed the model structured feedback', { timeout: 20_000 }, async () => {
    const { runInlineAgentLoop } = await import('../core/inline-agent/loop');
    const descriptors = [GATEWAY_A_TOOL_LIST, GATEWAY_B_TOOL_LIST];
    adapter.submitPromptStreaming
      .mockImplementationOnce(streamedTurn(CAPTURED_STEP_TEXT))
      .mockImplementationOnce(streamedTurn('The gateway tools are listed.'));
    const executeTool = vi.fn();
    const post = vi.fn();

    await runInlineAgentLoop(payloadWith(descriptors), {
      post,
      executeTool,
      signal: new AbortController().signal,
    });

    // Never executed: the ambiguity is a structured refusal, not a guess.
    expect(executeTool).not.toHaveBeenCalled();
    // The dropped calls surface as detected tool rows (no silence).
    const detected = post.mock.calls.filter(([type]) => type === 'AGENT_TOOL_DETECTED');
    expect(detected).toHaveLength(2);
    // No prose leak: the streamed step text carries no markup.
    const chunks = post.mock.calls
      .filter(([type]) => type === 'AGENT_STREAM_CHUNK')
      .map(([, data]) => (data as { fullText: string }).fullText);
    expect(chunks.join('\n')).not.toContain('<tool_list>');
    // Structured model feedback: the next request carries the blocking code.
    const secondPrompt = adapter.submitPromptStreaming.mock.calls[1]?.[0]?.prompt as string;
    expect(secondPrompt).toContain('tool_call_name_ambiguous');
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_COMPLETE', expect.objectContaining({
      finalText: 'The gateway tools are listed.',
    }));
  });

  it('a single-gateway short name executes cleanly through the authorized path', { timeout: 20_000 }, async () => {
    const { runInlineAgentLoop } = await import('../core/inline-agent/loop');
    const descriptors = [GATEWAY_A_TOOL_LIST];
    adapter.submitPromptStreaming
      .mockImplementationOnce(streamedTurn(CAPTURED_STEP_TEXT))
      .mockImplementationOnce(streamedTurn('Done.'));
    const executeTool = vi.fn(async (call: ToolCall) => ({
      name: call.invocationName ?? call.name,
      result: { ok: true, summary: 'listed' },
    }));
    const post = vi.fn();

    await runInlineAgentLoop(payloadWith(descriptors), {
      post,
      executeTool,
      signal: new AbortController().signal,
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool.mock.calls[0]?.[0]).toMatchObject({
      invocationName: 'mcp_t_a1vps_tool_list',
      payload: { limit: 300 },
    });
    expect(post).toHaveBeenCalledWith('AGENT_LOOP_COMPLETE', expect.objectContaining({
      finalText: 'Done.',
    }));
  });
});
