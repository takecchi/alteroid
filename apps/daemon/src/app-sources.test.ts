import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  APP_ENTRY_FILE,
  isAppSourceName,
  isAppSourceRelPath,
  readAppSource,
  readAppSources,
} from './app-sources.test-support.js';

describe('app-sources.test-support（HTTP の口のソースを文字列で読む試験の入口）', () => {
  it('app.ts と app-routes-<族>.ts を数え、テスト・補助・JSON は数えない', () => {
    expect(isAppSourceName('app.ts')).toBe(true);
    expect(isAppSourceName('app-context.ts')).toBe(true);
    expect(isAppSourceName('app-routes-memory.ts')).toBe(true);
    expect(isAppSourceName('app-routes-integration-keys.ts')).toBe(true);
    expect(isAppSourceName('app.test.ts')).toBe(false);
    expect(isAppSourceName('app-routes-pin.test.ts')).toBe(false);
    expect(isAppSourceName('app-routes-pin.json')).toBe(false);
    expect(isAppSourceName('app-sources.test-support.ts')).toBe(false);
    expect(isAppSourceName('openapi.ts')).toBe(false);
    expect(isAppSourceName('runner-app.ts')).toBe(false);
  });

  it('相対パスの判定は apps/daemon/src の直下だけを見る', () => {
    expect(isAppSourceRelPath('apps/daemon/src/app.ts')).toBe(true);
    expect(isAppSourceRelPath('apps/daemon/src/app-routes-tasks.ts')).toBe(true);
    expect(isAppSourceRelPath('apps/daemon/src/sub/app.ts')).toBe(false);
    expect(isAppSourceRelPath('apps/runner/src/app.ts')).toBe(false);
  });

  it('いまの src では app.ts を含み、どれも本文が空でない', () => {
    const sources = readAppSources();
    expect(sources.map((entry) => entry.name)).toContain(APP_ENTRY_FILE);
    for (const entry of sources) expect(entry.source.length, entry.name).toBeGreaterThan(0);
    expect(readAppSource()).toContain('export function createApp');
  });

  it('対象が無い・app.ts が無い・本文が空のときは、黙って通さず投げる（空振りさせない）', () => {
    const empty = makeTempDirSync('app-sources-empty-');
    expect(() => readAppSources(empty)).toThrow('1本も見つからない');

    const withoutEntry = makeTempDirSync('app-sources-no-entry-');
    writeFileSync(join(withoutEntry, 'app-routes-memory.ts'), 'export const a = 1;\n');
    expect(() => readAppSources(withoutEntry)).toThrow('app.ts が対象に入っていない');

    const blank = makeTempDirSync('app-sources-blank-');
    writeFileSync(join(blank, 'app.ts'), 'export const a = 1;\n');
    writeFileSync(join(blank, 'app-routes-memory.ts'), '\n  \n');
    expect(() => readAppSources(blank)).toThrow('本文が空');
  });

  it('族のファイルが増えると、自動で対象に入る', () => {
    const dir = makeTempDirSync('app-sources-family-');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'app-routes-memory.ts'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'app-routes-memory.test.ts'), 'export const c = 3;\n');
    expect(readAppSources(dir).map((entry) => entry.name)).toEqual([
      'app-routes-memory.ts',
      'app.ts',
    ]);
  });
});
