import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { resolveCloneToolRelayChildEntry } from './clone-tools-transport.js';

describe('resolveCloneToolRelayChildEntry', () => {
  it('呼び出し側と同じディレクトリに成果物が在れば、それを返す（本番のバンドル後の並び）', () => {
    const dir = makeTempDirSync('clone-tools-transport-same-dir-');
    const childPath = join(dir, 'clone-tool-relay-child.js');
    writeFileSync(childPath, '// dummy\n');
    const callerUrl = pathToFileURL(join(dir, 'index.js')).href;

    expect(resolveCloneToolRelayChildEntry(callerUrl)).toBe(childPath);
  });

  it('呼び出し側の1つ上の dist/ に成果物が在れば、それを返す（vitest が src を直接読む場合）', () => {
    const root = makeTempDirSync('clone-tools-transport-sibling-dist-');
    const srcDir = join(root, 'src');
    const distDir = join(root, 'dist');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    const childPath = join(distDir, 'clone-tool-relay-child.js');
    writeFileSync(childPath, '// dummy\n');
    const callerUrl = pathToFileURL(join(srcDir, 'clone.js')).href;

    expect(resolveCloneToolRelayChildEntry(callerUrl)).toBe(childPath);
  });

  it('同じディレクトリを優先する（両方に在れば先勝ち）', () => {
    const root = makeTempDirSync('clone-tools-transport-both-');
    const srcDir = join(root, 'src');
    const distDir = join(root, 'dist');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    const sameDirChild = join(srcDir, 'clone-tool-relay-child.js');
    const distChild = join(distDir, 'clone-tool-relay-child.js');
    writeFileSync(sameDirChild, '// dummy (same dir)\n');
    writeFileSync(distChild, '// dummy (dist)\n');
    const callerUrl = pathToFileURL(join(srcDir, 'clone.js')).href;

    expect(resolveCloneToolRelayChildEntry(callerUrl)).toBe(sameDirChild);
  });

  it('どちらにも無ければ、ビルドを忘れていることを名指しして投げる', () => {
    const root = makeTempDirSync('clone-tools-transport-missing-');
    const srcDir = join(root, 'src');
    mkdirSync(srcDir, { recursive: true });
    const callerUrl = pathToFileURL(join(srcDir, 'clone.js')).href;

    expect(() => resolveCloneToolRelayChildEntry(callerUrl)).toThrow(/pnpm build/);
  });
});
