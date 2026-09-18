import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripToolCalls, stripOrphanClosingTags } from '../core/interceptor/tool-parser';
import { createStreamingToolTextAccumulator } from '../core/interceptor/streaming-tool-text';
import { XmlToolStreamFilter } from '../core/interceptor/fetch-hook';
import { createDeepSeekSseFrameDecoder } from '../core/deepseek/stream-codec';
import {
  getInlineAgentDisplayFinalText,
  getInlineAgentDisplayStepText,
} from '../core/inline-agent/display-text';
import type { ToolDescriptor } from '../core/tool/types';

/**
 * Orphan closing tag leak (wave 3 / D1, 2026-09-19).
 *
 * Live evidence (final-verify-report-2.md, 5 of 5 tool turns): the model
 * double-closes tool tags -
 *   <shell_exec>{"command": ...}</shell_exec>
 *   </shell_exec>
 * Extraction consumes the well-formed pair; the ORPHAN second closing tag
 * survives in the residual text and renders raw in the chat bubble, the
 * console step bodies, and post-reload restore. The fix strips orphan
 * closing tags of ADVERTISED tool names (and the invoke/calls DSML family,
 * any bar shape) from every display/streaming/restore surface - silently,
 * like the delimiter-corrected policy. The executed tool result remains the
 * only feedback; no model lecture is added.
 */

function shellDescriptor(): ToolDescriptor {
  return {
    id: 'local:shell:shell_exec',
    provider: { kind: 'local', id: 'local:shell', displayName: 'shell', transport: 'in_process' },
    name: 'shell_exec',
    invocationName: 'shell_exec',
    title: 'shell_exec',
    description: 'shell_exec',
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

function spawnDescriptor(): ToolDescriptor {
  return {
    id: 'local:inline_agent:subagent_spawn',
    provider: { kind: 'local', id: 'inline_agent', displayName: 'agent', transport: 'in_process' },
    name: 'subagent_spawn',
    invocationName: 'subagent_spawn',
    title: 'subagent_spawn',
    description: 'subagent_spawn',
    inputSchema: { type: 'object', properties: {} },
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

describe('stripOrphanClosingTags (D1)', () => {
  it('removes duplicated closing tags after the well-formed pair is consumed', () => {
    const text = '<shell_exec>{"command":"echo x"}</shell_exec>\n</shell_exec>';
    const stripped = stripToolCalls(text, { descriptors: [shellDescriptor()] });
    expect(stripped).toContain('</shell_exec>');
    const clean = stripOrphanClosingTags(stripped, { descriptors: [shellDescriptor()] });
    expect(clean).not.toContain('shell_exec');
  });

  it('removes barred orphan closers for the invoke family', () => {
    const clean = stripOrphanClosingTags('kept\n</｜DSML｜｜invoke>', { descriptors: [shellDescriptor()] });
    expect(clean).toBe('kept\n');
  });

  it('removes several orphan closers and keeps the surrounding prose', () => {
    const text = 'Before\n</shell_exec>\n</shell_exec>\n</subagent_spawn>\nAfter';
    const clean = stripOrphanClosingTags(text, { descriptors: [shellDescriptor(), spawnDescriptor()] });
    expect(clean).toContain('Before');
    expect(clean).toContain('After');
    expect(clean).not.toContain('shell_exec');
    expect(clean).not.toContain('subagent_spawn');
  });

  it('leaves text without any closing tag untouched', () => {
    expect(stripOrphanClosingTags('plain prose only', { descriptors: [shellDescriptor()] })).toBe('plain prose only');
  });
});

describe('display surfaces drop orphan closers (D1)', () => {
  it('display final and step text strip the orphan after extraction', () => {
    const text = '<shell_exec>{"command":"echo final-sweep"}</shell_exec>\n</shell_exec>';
    const descriptors = [shellDescriptor()];
    expect(getInlineAgentDisplayFinalText(text, descriptors)).not.toContain('</shell_exec>');
    expect(getInlineAgentDisplayStepText(text, descriptors)).not.toContain('</shell_exec>');
  });
});

describe('history restore drops orphan closers (D1)', () => {
  it('strips orphan closers from stored message content and fragments', async () => {
    const { stripToolCallsFromHistory } = await import('../core/interceptor/history-cleanup');
    const json = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              message_role: 'assistant',
              content: 'Answer.\n</shell_exec>',
            },
            {
              message_id: 2,
              message_role: 'assistant',
              fragments: [{ content: 'Step text.\n</shell_exec>' }],
            },
          ],
        },
      },
    };
    stripToolCallsFromHistory(json, {
      toolDescriptors: [shellDescriptor()],
      onToolCallsRestored: () => undefined,
    });
    const messages = json.data.biz_data.chat_messages;
    const first = messages[0] as { content: string };
    const second = messages[1] as { fragments: Array<{ content: string }> };
    expect(first.content).not.toContain('</shell_exec>');
    expect(first.content).toContain('Answer.');
    expect(second.fragments[0].content).not.toContain('</shell_exec>');
    expect(second.fragments[0].content).toContain('Step text.');
  });
});

describe('streaming surfaces drop orphan closers (D1)', () => {
  const sse = (v: unknown) => `data: ${JSON.stringify({ v })}\n\n`;

  function runFilter(chunks: string[]): string {
    const filter = new XmlToolStreamFilter([shellDescriptor()]);
    const frameDecoder = createDeepSeekSseFrameDecoder();
    const decoder = new TextDecoder();
    const output: string[] = [];
    const controller = {
      enqueue(data: Uint8Array) { output.push(decoder.decode(data)); },
    } as ReadableStreamDefaultController<Uint8Array>;
    for (const chunk of chunks) filter.processFrames(frameDecoder.push(chunk), controller);
    filter.processFrames(frameDecoder.finish(), controller);
    filter.flush(controller);
    return output.join('');
  }

  it('the live page filter suppresses orphan closers', () => {
    const whole = runFilter([
      sse('<shell_exec>{"command":"echo x"}</shell_exec>'),
      sse('\n</shell_exec>'),
      sse('done'),
    ]);
    expect(whole).not.toContain('shell_exec');
    expect(whole).toContain('done');
  });

  it('the orphan closer split across chunk boundaries is suppressed at every split', () => {
    const orphan = '</shell_exec>';
    for (let split = 1; split < orphan.length; split++) {
      const output = runFilter([
        sse('<shell_exec>{"command":"echo x"}</shell_exec>'),
        sse(`\n${orphan.slice(0, split)}`),
        sse(`${orphan.slice(split)}done`),
      ]);
      expect(output).not.toContain('shell_exec');
      expect(output).toContain('done');
    }
  });

  it('the step-text accumulator suppresses orphan closers at every split point', () => {
    const text = 'intro\n</shell_exec>\n</shell_exec>\noutro';
    for (let split = 1; split < text.length; split++) {
      const acc = createStreamingToolTextAccumulator([shellDescriptor()]);
      acc.append(text.slice(0, split));
      acc.append(text.slice(split));
      acc.flush();
      const visible = acc.getVisibleText();
      expect(visible).not.toMatch(/<\/?shell_exec/);
      expect(visible).toContain('intro');
      expect(visible).toContain('outro');
    }
  });
});

describe('content scrubber drops orphan closers (D1, source contract)', () => {
  it('the scrubber consumes close tags of advertised names without an active open', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
    expect(source).toContain('toolCloseTagRe');
    const start = source.indexOf('function stripToolCallTextNodes(');
    const next = source.indexOf('\nfunction ', start + 10);
    const body = source.slice(start, next);
    expect(body).toContain('toolCloseTagRe.exec');
  });
});
