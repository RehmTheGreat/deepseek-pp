import { describe, expect, it } from 'vitest';
import { createStreamingToolCallParser } from '../core/interceptor/streaming-tool-call-parser';
import { XmlToolStreamFilter } from '../core/interceptor/fetch-hook';
import {
  createDeepSeekSseFrameDecoder,
  extractResponseTextFromParsed,
} from '../core/deepseek/stream-codec';
import type { ToolDescriptor } from '../core/tool/types';

/**
 * Turn-0 silent tool-call drop (regression, 2026-09-18).
 *
 * Captured live wire (.superpowers/sdd/e2e-live/t0d-probe-1.json,
 * requests[0].resp, frames verbatim): a turn whose model response STARTS with
 * the tool-call open tag. DeepSeek then embeds the first RESPONSE fragment
 * WITH its first content chunk (`"<"`) inside the bootstrap snapshot frame
 * (`data: {"v":{"response":{...,"fragments":[...]}}}`) instead of the regular
 * fragment-APPEND patches. The extractor had no branch for that shape, the
 * leading `<` never reached the streaming parser, and the whole call was
 * silently dropped (no started/completed/failed, no execution, no record).
 */
const CAPTURED_DROP_WIRE = [
  "event: ready\ndata: {\"request_message_id\":1,\"response_message_id\":2,\"model_type\":\"default\"}\n\n",
  "event: update_session\ndata: {\"updated_at\":1789757375.7091908}\n\n",
  "data: {\"v\":{\"response\":{\"message_id\":2,\"parent_id\":1,\"model\":\"\",\"role\":\"ASSISTANT\",\"thinking_enabled\":true,\"ban_edit\":false,\"ban_regenerate\":false,\"status\":\"WIP\",\"incomplete_message\":null,\"accumulated_token_usage\":0,\"feedback\":null,\"inserted_at\":1789757375.694212,\"search_enabled\":true,\"fragments\":[{\"id\":2,\"type\":\"RESPONSE\",\"content\":\"<\",\"references\":[],\"stage_id\":1}],\"conversation_mode\":\"DEFAULT\",\"has_pending_fragment\":false,\"auto_continue\":false,\"search_triggered\":false,\"extra_search_providers\":[]}}}\n\n",
  "data: {\"p\":\"response/fragments/-1/content\",\"o\":\"APPEND\",\"v\":\"shell\"}\n\n",
  "data: {\"v\":\"_exec\"}\n\n",
  "data: {\"v\":\">\\n\"}\n\n",
  "data: {\"v\":\"{\\\"\"}\n\n",
  "data: {\"v\":\"command\"}\n\n",
  "data: {\"v\":\"\\\":\"}\n\n",
  "data: {\"v\":\" \\\"\"}\n\n",
  "data: {\"v\":\"echo\"}\n\n",
  "data: {\"v\":\" drop\"}\n\n",
  "data: {\"v\":\"-pro\"}\n\n",
  "data: {\"v\":\"be\"}\n\n",
  "data: {\"v\":\"-\"}\n\n",
  "data: {\"v\":\"1\"}\n\n",
  "data: {\"v\":\"\\\"}\\n\"}\n\n",
  "data: {\"v\":\"</\"}\n\n",
  "data: {\"v\":\"shell\"}\n\n",
  "data: {\"v\":\"_exec\"}\n\n",
  "data: {\"v\":\">\"}\n\n",
  "data: {\"p\":\"response\",\"o\":\"BATCH\",\"v\":[{\"p\":\"accumulated_token_usage\",\"v\":16907},{\"p\":\"quasi_status\",\"v\":\"FINISHED\"}]}\n\n",
  "data: {\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}\n\n",
  "event: update_session\ndata: {\"updated_at\":1789757375.825708}\n\n",
  "event: title\ndata: {\"content\":\"Drop probe\"}\n\n",
  "event: close\ndata: {\"click_behavior\":\"none\",\"auto_resume\":false}\n\n",
].join('');

function makeShellDescriptor(): ToolDescriptor {
  return {
    id: 'mcp:shell-local:shell_exec',
    provider: { kind: 'local', id: 'local:shell', displayName: 'shell', transport: 'in_process' },
    name: 'shell_exec',
    invocationName: 'shell_exec',
    title: 'shell_exec',
    description: 'shell_exec',
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

function decodeWireFrames(wire: string): any[] {
  const decoder = createDeepSeekSseFrameDecoder();
  return [...decoder.push(wire), ...decoder.finish()]
    .map((frame) => frame.parsed)
    .filter((parsed) => parsed !== null && parsed !== undefined);
}

describe('turn-0 bootstrap snapshot fragments (Defect 2 regression)', () => {
  it('extracts the first fragment content embedded in the bootstrap snapshot frame', () => {
    const snapshot = decodeWireFrames(CAPTURED_DROP_WIRE).find(
      (parsed) => parsed?.v?.response?.fragments,
    );
    expect(snapshot).toBeTruthy();
    // The missing branch: the snapshot carries the turn's FIRST byte.
    expect(extractResponseTextFromParsed(snapshot)).toBe('<');
  });

  it('replays the captured drop wire into exactly one completed shell_exec call', () => {
    const parser = createStreamingToolCallParser([makeShellDescriptor()]);
    let started = 0;
    const completed: Array<{ name: string; payload: unknown }> = [];
    const failed: unknown[] = [];

    for (const parsed of decodeWireFrames(CAPTURED_DROP_WIRE)) {
      const text = extractResponseTextFromParsed(parsed);
      if (!text) continue;
      const events = parser.append(text);
      started += events.started.length;
      completed.push(...events.completed.map((call) => ({ name: call.name, payload: call.payload })));
      failed.push(...events.failed);
    }
    const flushed = parser.flush();

    expect(started).toBe(1);
    expect(failed).toHaveLength(0);
    expect(completed).toHaveLength(1);
    expect(flushed.completed).toHaveLength(0);
    expect(completed[0]).toMatchObject({ name: 'shell_exec' });
    expect(completed[0].payload).toEqual({ command: 'echo drop-probe-1' });
  });

  it('the page filter suppresses the assembled call so no raw XML reaches the DOM', () => {
    const filter = new XmlToolStreamFilter([makeShellDescriptor()]);
    const frameDecoder = createDeepSeekSseFrameDecoder();
    const decoder = new TextDecoder();
    const output: string[] = [];
    const controller = {
      enqueue(data: Uint8Array) {
        output.push(decoder.decode(data));
      },
    } as ReadableStreamDefaultController<Uint8Array>;

    for (const chunk of [
      CAPTURED_DROP_WIRE.slice(0, 400),
      CAPTURED_DROP_WIRE.slice(400, 900),
      CAPTURED_DROP_WIRE.slice(900),
    ]) {
      filter.processFrames(frameDecoder.push(chunk), controller);
    }
    filter.processFrames(frameDecoder.finish(), controller);
    filter.flush(controller);

    const page = output.join('');
    expect(page).not.toContain('<shell_exec');
    expect(page).not.toContain('drop-probe-1');
  });

  it('a repeated bootstrap snapshot stays pure (extractor emits the same bytes)', () => {
    // Risk noted in the diagnosis: if a full fragments snapshot were ever
    // re-sent mid-stream, the snapshot text would be re-fed. This pins the
    // extractor as pure (same input, same output) so a per-stream pump guard
    // can rely on determinism.
    const snapshot = decodeWireFrames(CAPTURED_DROP_WIRE).find(
      (parsed) => parsed?.v?.response?.fragments,
    );
    expect(extractResponseTextFromParsed(snapshot)).toBe('<');
    expect(extractResponseTextFromParsed(snapshot)).toBe('<');
  });
});
