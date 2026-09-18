import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Unified extension type scale (Defect 5, 2026-09-18).
 *
 * pc observed inconsistent font sizes across the extension's rendered UI:
 * hardcoded 14px/12px steps, stray 11px/13px outliers, and a restored-mode
 * custom property that made in-run and restored consoles render at different
 * sizes. One coherent scale now applies everywhere:
 *   - content (narration bodies): the native-matching measured size,
 *     `--dpp-ui-font-body`, fallback 14px - identical in-run and restored;
 *   - chrome (status lines, tool rows, summaries, notices, refused records,
 *     child consoles, buttons, toasts, menus): one 12px token,
 *     `--dpp-ui-font-chrome`.
 * No surface may hardcode an ad-hoc px size anymore.
 */

const rendererSource = readFileSync(
  join(process.cwd(), 'core/inline-agent/renderer.ts'),
  'utf8',
);
const contentSource = readFileSync(join(process.cwd(), 'entrypoints/content.ts'), 'utf8');
const themeSource = readFileSync(join(process.cwd(), 'core/ui/injected-theme.ts'), 'utf8');

function rendererCss(): string {
  const start = rendererSource.indexOf('style.textContent = `');
  const end = rendererSource.indexOf('`;', start);
  return rendererSource.slice(start, end);
}

describe('unified extension type scale (Defect 5)', () => {
  it('defines one chrome size token in the shared theme (light and dark)', () => {
    const matches = themeSource.match(/--dpp-ui-font-chrome: 12px;/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('renders agent content at the measured body size in-run and restored (one rule)', () => {
    const css = rendererCss();
    // Single body rule consuming the shared measured token.
    const bodyRule = css.match(/\.dpp-agent-step-body\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bodyRule).toContain('font-size: var(--dpp-ui-font-body, 14px)');
    // The restored-mode override is gone: no second size for restored runs.
    expect(css).not.toContain('[data-restored="true"] .dpp-agent-step-body');
  });

  it('keeps every chrome surface on the shared chrome token (no ad-hoc px steps)', () => {
    const css = rendererCss();
    // Every font-size in the agent styles is either the measured body token,
    // the chrome token, or a relative (em) size inside the narration body.
    const sizes = css.match(/font-size: [^;]+/g) ?? [];
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(
        size.startsWith('font-size: var(--dpp-ui-font-body')
        || size.startsWith('font-size: var(--dpp-ui-font-chrome')
        || /font-size: \d+(\.\d+)?em/.test(size),
      ).toBe(true);
    }
    // The old ad-hoc steps are gone.
    expect(css).not.toContain('font-size: 11px');
    expect(css).not.toContain('font-size: 12px');
    expect(css).not.toContain('font-size: 13px');
    expect(css).not.toContain('font-size: 14px');
  });

  it('applies the measured size to in-run containers too, not only restored ones', () => {
    // In-run mount: the agent container inherits the measured native body
    // size at mount time (same mechanism as the restored mount).
    const mountAt = contentSource.indexOf('function mountInlineAgentContainer(');
    expect(mountAt).toBeGreaterThan(0);
    const mountBody = contentSource.slice(mountAt, contentSource.indexOf('\n}', mountAt));
    expect(mountBody).toContain('applyAgentBodyFontSize(');
    expect(mountBody).toContain('measureHostBodyFontSize(message)');

    // Restored mount uses the same single mechanism.
    expect(contentSource).toContain(
      'applyAgentBodyFontSize(container, measureHostBodyFontSize(message));',
    );
    // The old restored-only names are gone.
    expect(contentSource).not.toContain('applyRestoredBodyFontSize');
    expect(contentSource).not.toContain('measureRestoredHostFontSize');
  });

  it('puts toasts, export menus, and permission chrome on the shared chrome token', () => {
    expect(contentSource).toContain('font-size: var(--dpp-ui-font-chrome, 12px)');
    // The old hardcoded toast/menu sizes are gone.
    expect(contentSource).not.toContain('font-size: 13px');
  });
});
