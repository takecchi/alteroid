import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  CLONE_TOOLS_ENTRY_FILE,
  isCloneToolsSourceName,
  isCloneToolsSourceRelPath,
  readCloneToolsSource,
  readCloneToolsSources,
} from './clone-tools-sources.test-support.js';

describe('clone-tools-sources.test-support（道具の実装ソースを文字列で読む試験の入口）', () => {
  it('tools.ts と clone-tools-<族>.ts を数え、テスト・補助・中継の配線は数えない', () => {
    expect(isCloneToolsSourceName('tools.ts')).toBe(true);
    expect(isCloneToolsSourceName('clone-tools-memory.ts')).toBe(true);
    expect(isCloneToolsSourceName('clone-tools-manager-describe.ts')).toBe(true);
    expect(isCloneToolsSourceName('clone-tools-memory.test.ts')).toBe(false);
    expect(isCloneToolsSourceName('clone-tools-sources.test-support.ts')).toBe(false);
    expect(isCloneToolsSourceName('clone-tools-transport.ts')).toBe(false);
    expect(isCloneToolsSourceName('tools.test.ts')).toBe(false);
    expect(isCloneToolsSourceName('manager-tools.ts')).toBe(false);
  });

  it('相対パスの判定は packages/core/src の直下だけを見る', () => {
    expect(isCloneToolsSourceRelPath('packages/core/src/tools.ts')).toBe(true);
    expect(isCloneToolsSourceRelPath('packages/core/src/clone-tools-task.ts')).toBe(true);
    expect(isCloneToolsSourceRelPath('packages/core/src/sub/tools.ts')).toBe(false);
    expect(isCloneToolsSourceRelPath('apps/daemon/src/tools.ts')).toBe(false);
  });

  it('いまの src では tools.ts を含み、どれも本文が空でない', () => {
    const sources = readCloneToolsSources();
    expect(sources.map((entry) => entry.name)).toContain(CLONE_TOOLS_ENTRY_FILE);
    for (const entry of sources) expect(entry.source.length, entry.name).toBeGreaterThan(0);
    expect(readCloneToolsSource()).toContain('createCloneTools');
  });

  it('対象が無い・tools.ts が無い・本文が空のときは、黙って通さず投げる（空振りさせない）', () => {
    const empty = makeTempDirSync('clone-tools-sources-empty-');
    expect(() => readCloneToolsSources(empty)).toThrow('1本も見つからない');

    const withoutEntry = makeTempDirSync('clone-tools-sources-no-entry-');
    writeFileSync(join(withoutEntry, 'clone-tools-memory.ts'), 'export const a = 1;\n');
    expect(() => readCloneToolsSources(withoutEntry)).toThrow('tools.ts が対象に入っていない');

    const blank = makeTempDirSync('clone-tools-sources-blank-');
    mkdirSync(blank, { recursive: true });
    writeFileSync(join(blank, 'tools.ts'), 'export const a = 1;\n');
    writeFileSync(join(blank, 'clone-tools-memory.ts'), '\n  \n');
    expect(() => readCloneToolsSources(blank)).toThrow('本文が空');
  });

  it('族のファイルが増えると、自動で対象に入る', () => {
    const dir = makeTempDirSync('clone-tools-sources-family-');
    writeFileSync(join(dir, 'tools.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'clone-tools-memory.ts'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'clone-tools-transport.ts'), 'export const c = 3;\n');
    expect(readCloneToolsSources(dir).map((entry) => entry.name)).toEqual([
      'clone-tools-memory.ts',
      'tools.ts',
    ]);
  });
});
