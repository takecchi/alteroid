import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as light from './cli-light.js';

const here = dirname(fileURLToPath(import.meta.url));

function valueImports(source: string): string[] {
  const out: string[] = [];
  const re = /^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+'([^']+)'|^import\s+'([^']+)'/gms;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m[1]) continue;
    const spec = m[3] ?? m[4];
    if (spec === undefined) continue;
    const braces = m[2]?.trim().match(/^\{([^}]*)\}$/);
    if (braces) {
      const items = (braces[1] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (items.length > 0 && items.every((i) => i.startsWith('type '))) continue;
    }
    out.push(spec);
  }
  return out;
}

function closure(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else external.add(spec);
    }
  };
  visit(entry);
  return { files, external };
}

describe('@alteroid/core/cli-light（issue #2860）', () => {
  it('SDK・zod・schema.ts の値・tools.ts を推移的に読まない（Node の組み込みだけ）', () => {
    const { files, external } = closure(resolve(here, 'cli-light.ts'));
    const nonBuiltin = [...external].filter((s) => !s.startsWith('node:'));
    expect(nonBuiltin).toEqual([]);
    const names = [...files].map((f) => f.slice(here.length + 1));
    for (const heavy of ['schema.ts', 'tools.ts', 'index.ts', 'store.ts']) {
      expect(names).not.toContain(heavy);
    }
  });

  it('subpath export が package.json に在る', () => {
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./cli-light']).toEqual({
      types: './dist/cli-light.d.ts',
      import: './dist/cli-light.js',
    });
  });

  it('CLI が起動時に要る値を出している', () => {
    expect(light.REMOVE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(light.REMOVE_MANY_LIMIT_MAX).toBe(2000);
    expect(typeof light.formatElapsedAgo).toBe('function');
  });
});
