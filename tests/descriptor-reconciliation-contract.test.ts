import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOTS = ['core', 'entrypoints'] as const;
const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      yield* walkSourceFiles(fullPath);
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      yield fullPath;
    }
  }
}

describe('descriptor authorization reconciliation contract', () => {
  it('never fails a grant with the removed unknown_tool_authorization_descriptor error', () => {
    // Stale loop descriptor ids are reconciled in the background handler
    // (intersection, with a full-grantable fallback) and reported to the model
    // BY NAME in prompt bytes. The hard grant failure was deleted at the root;
    // this grep-assert keeps it deleted: the string may survive only in this
    // negative assertion and in historical docs — never in production source.
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walkSourceFiles(join(REPO_ROOT, root))) {
        if (readFileSync(file, 'utf8').includes('unknown_tool_authorization_descriptor')) {
          offenders.push(relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
