import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../core/i18n';

/**
 * O3 (wave 3): status-line counts pluralize - "1 step"/"2 steps",
 * "1 tool call"/"3 tool calls" - in both locales (zh uses one form per unit).
 * The prober saw "Ran 1 tool calls" and "Complete - 1 steps".
 */

describe('status-line pluralization (O3)', () => {
  const en = createTranslator('en').t;
  const zh = createTranslator('zh-CN').t;

  it('renders singular counts for one step and one tool call', () => {
    expect(
      en('content.agent.consoleComplete', {
        steps: 1,
        stepUnit: en('content.agent.stepUnitOne'),
        tools: 1,
        toolUnit: en('content.agent.toolUnitOne'),
        seconds: 5,
      }),
    ).toBe('Complete · 1 step · 1 tool call · 5s');
  });

  it('renders plural counts for several steps and tool calls', () => {
    expect(
      en('content.agent.consoleComplete', {
        steps: 2,
        stepUnit: en('content.agent.stepUnitMany'),
        tools: 3,
        toolUnit: en('content.agent.toolUnitMany'),
        seconds: 5,
      }),
    ).toBe('Complete · 2 steps · 3 tool calls · 5s');
  });

  it('pluralizes the tool-group label', () => {
    expect(en('content.agent.toolGroup', { count: 1, toolUnit: en('content.agent.toolUnitOne') })).toBe('Ran 1 tool call');
    expect(en('content.agent.toolGroup', { count: 3, toolUnit: en('content.agent.toolUnitMany') })).toBe('Ran 3 tool calls');
  });

  it('keeps zh status lines grammatical (single unit form)', () => {
    expect(
      zh('content.agent.consoleComplete', {
        steps: 1,
        stepUnit: zh('content.agent.stepUnitOne'),
        tools: 2,
        toolUnit: zh('content.agent.toolUnitMany'),
        seconds: 5,
      }),
    ).toBe('已完成 · 1 步 · 2 次工具 · 用时 5s');
  });

  it('defines the unit keys in both locales', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const source = readFileSync(
        join(process.cwd(), `core/i18n/resources/${locale === 'zh-CN' ? 'zh-CN' : 'en'}/content.ts`),
        'utf8',
      );
      for (const key of ['stepUnitOne', 'stepUnitMany', 'toolUnitOne', 'toolUnitMany']) {
        expect(source).toContain(`${key}:`);
      }
    }
  });
});
