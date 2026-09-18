import { describe, expect, it } from 'vitest';
import {
  stripAnsiEscapeSequences,
  stripAnsiInDepth,
  validateMcpToolCallArguments,
} from '../core/mcp/call-guards';
import type { ToolDescriptor } from '../core/tool/types';

function descriptorWithSchema(schema: ToolDescriptor['inputSchema']): ToolDescriptor {
  return {
    id: 'local:shell:python_exec',
    provider: { kind: 'local', id: 'shell', displayName: 'shell', transport: 'in_process' },
    name: 'python_exec',
    invocationName: 'python_exec',
    title: 'python_exec',
    description: 'python_exec',
    inputSchema: schema,
    execution: { mode: 'auto', enabled: true, risk: 'low' },
  };
}

describe('stripAnsiEscapeSequences (wave-2 ANSI boundary)', () => {
  it('removes CSI color and cursor sequences from shell output', () => {
    const raw = '\u001B[31;1mERROR:\u001B[0m command not found: definitely-not-a-real-command-xyz123';
    expect(stripAnsiEscapeSequences(raw)).toBe('ERROR: command not found: definitely-not-a-real-command-xyz123');
  });

  it('removes OSC sequences and preserves plain and CJK text byte-for-byte', () => {
    expect(stripAnsiEscapeSequences('\u001B]0;title\u0007rest')).toBe('rest');
    expect(stripAnsiEscapeSequences('命令执行成功 exit 0')).toBe('命令执行成功 exit 0');
    expect(stripAnsiEscapeSequences('plain stdout line\r\n')).toBe('plain stdout line\r\n');
  });
});

describe('stripAnsiInDepth', () => {
  it('cleans nested result payloads without touching numbers or structure', () => {
    const raw = {
      ok: true,
      data: {
        stdout: '\u001B[32mfx2-ui-2\r\n\u001B[0m',
        exitCode: 0,
        nested: { stderr: '\u001B[31;1mboom\u001B[0m', items: ['\u001B[1mx\u001B[0m', 5] },
      },
    };
    expect(stripAnsiInDepth(raw)).toEqual({
      ok: true,
      data: {
        stdout: 'fx2-ui-2\r\n',
        exitCode: 0,
        nested: { stderr: 'boom', items: ['x', 5] },
      },
    });
  });
});

describe('validateMcpToolCallArguments (wave-2 empty-args gate)', () => {
  const pythonExec = descriptorWithSchema({
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python code to run.' },
    },
    required: ['code'],
  });

  it('refuses an empty arguments body when the schema declares parameters', () => {
    const check = validateMcpToolCallArguments({}, pythonExec);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.message).toContain('empty arguments');
      expect(check.message).toContain('code');
    }
  });

  it('refuses missing required arguments by name', () => {
    const check = validateMcpToolCallArguments({ timeout: 5 }, pythonExec);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain('code');
  });

  it('refuses blank-string required arguments', () => {
    const check = validateMcpToolCallArguments({ code: '   ' }, pythonExec);
    expect(check.ok).toBe(false);
  });

  it('accepts a complete arguments body', () => {
    const check = validateMcpToolCallArguments({ code: 'print(1)' }, pythonExec);
    expect(check).toEqual({ ok: true });
  });

  it('accepts an empty body only for schemas that declare no parameters', () => {
    const noParams = descriptorWithSchema({ type: 'object' });
    expect(validateMcpToolCallArguments({}, noParams)).toEqual({ ok: true });
    expect(validateMcpToolCallArguments({}, undefined)).toEqual({ ok: true });
  });

  it('refuses non-object bodies when the schema declares parameters', () => {
    const check = validateMcpToolCallArguments('print(1)', pythonExec);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain('JSON object');
  });
});
