import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { needsDistSink } from './vitest.quiet-traces.js';

const repoRoot = dirname(fileURLToPath(import.meta.url));

// dist の core の書き先も差し替えるのは、core を `@alteroid/core` として読むパッケージの試験だけ（重い入口を読むのが要るところだけ）
describe('needsDistSink: dist の core の書き先も差し替える試験のファイルか', () => {
  it.each([
    ['apps/runner/src/app.test.ts', true],
    ['apps/cli/src/index.test.ts', true],
    ['apps/daemon/src/app.test.ts', true],
    ['packages/storage-fs/src/index.test.ts', true],
    // core 自身は src を読むので要らない。web は軽い入口しか使わないので読まない
    ['packages/core/src/runner.test.ts', false],
    ['apps/web/app/routes/home.test.tsx', false],
    // ルートの試験・パッケージの外は対象にしない
    ['vitest.config.test.ts', false],
  ])('%s → %s', (relativePath, expected) => {
    expect(needsDistSink(join(repoRoot, relativePath))).toBe(expected);
  });

  it('場所が分からなければ差し替えない', () => {
    expect(needsDistSink(undefined)).toBe(false);
  });
});
