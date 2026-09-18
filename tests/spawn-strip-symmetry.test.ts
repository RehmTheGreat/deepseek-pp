import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripToolCallsFromHistory } from '../core/interceptor/history-cleanup';
import {
  getInlineAgentDisplayFinalText,
  getInlineAgentDisplayStepText,
} from '../core/inline-agent/display-text';
import { createArtifactToolDescriptors } from '../core/artifact';
import type { ToolDescriptor } from '../core/tool/types';

/**
 * Raw spawn markup after reload (Defect 3, 2026-09-18).
 *
 * Live evidence (visual-verify-report.md, 2 of 2 spawn turns): restored
 * messages rendered the raw `<subagent_spawn>...</subagent_spawn>` call as
 * visible text. The display-strip surfaces build their recognition from the
 * shared tool catalog, which deliberately never contains the subagent_spawn
 * descriptor (the spawn tool enters authorization grants only), so restore
 * and scrub recognized the call but never stripped it. The fix: every
 * display-strip surface augments its catalog with the advertised spawn
 * descriptor (strip symmetry: recognize == strip), while execution/prompt
 * composition stays untouched.
 */

const SPAWN_BLOCK = '<subagent_spawn>{"task":"write one haiku about rain"}</subagent_spawn>';

function spawnFreeDescriptors(): ToolDescriptor[] {
  // The real shared catalog: artifact tools, no subagent_spawn descriptor.
  return createArtifactToolDescriptors('en') as unknown as ToolDescriptor[];
}

describe('spawn markup strip symmetry (Defect 3 regression)', () => {
  it('strips a stored spawn call from restored message content', () => {
    const json = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 1,
              message_role: 'user',
              content: 'Do you have subagent access?',
            },
            {
              message_id: 2,
              message_role: 'assistant',
              content: `I'll verify by execution.\n\n${SPAWN_BLOCK}\n\nSubagent run complete.`,
            },
          ],
        },
      },
    };

    stripToolCallsFromHistory(json, {
      toolDescriptors: spawnFreeDescriptors(),
      onToolCallsRestored: () => undefined,
    });

    const restored = json.data.biz_data.chat_messages[1].content;
    expect(restored).not.toContain('<subagent_spawn');
    expect(restored).not.toContain('</subagent_spawn>');
    expect(restored).not.toContain('"task":"write one haiku about rain"');
    expect(restored).toContain("I'll verify by execution.");
    expect(restored).toContain('Subagent run complete.');
  });

  it('strips a stored spawn call carried in message fragments', () => {
    const json = {
      data: {
        biz_data: {
          chat_messages: [
            {
              message_id: 2,
              message_role: 'assistant',
              fragments: [
                { content: 'Intro\n\n' },
                { content: SPAWN_BLOCK },
                { content: '\n\nOutro' },
              ],
            },
          ],
        },
      },
    };

    stripToolCallsFromHistory(json, {
      toolDescriptors: spawnFreeDescriptors(),
      onToolCallsRestored: () => undefined,
    });

    const fragments = json.data.biz_data.chat_messages[0].fragments;
    const joined = fragments.map((frag: { content: string }) => frag.content).join('');
    expect(joined).not.toContain('subagent_spawn');
    expect(joined).toContain('Intro');
    expect(joined).toContain('Outro');
  });

  it('never strips unrecognized content (a lookalike tag survives)', () => {
    const content = 'Custom host markup <subagent_spawns> keep me </subagent_spawns> end';
    const json = {
      data: {
        biz_data: {
          chat_messages: [
            { message_id: 3, message_role: 'assistant', content },
          ],
        },
      },
    };

    stripToolCallsFromHistory(json, {
      toolDescriptors: spawnFreeDescriptors(),
      onToolCallsRestored: () => undefined,
    });

    expect(json.data.biz_data.chat_messages[0].content).toBe(content);
  });

  it('the display final/step text strips spawn blocks for agent-run surfaces', () => {
    const text = `Before ${SPAWN_BLOCK} after`;
    expect(getInlineAgentDisplayFinalText(text, spawnFreeDescriptors())).toBe('Before  after');
    expect(getInlineAgentDisplayStepText(text, spawnFreeDescriptors())).toBe('Before  after');
  });

  it('the DOM scrubber tag pattern includes the advertised spawn descriptor', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
    const start = source.indexOf('function buildToolTagPattern(');
    expect(start).toBeGreaterThan(0);
    const bodyStart = source.indexOf('{', start);
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('withInlineAgentSpawnDisplayDescriptor');
    expect(bodyStart).toBeGreaterThan(0);
  });
});
