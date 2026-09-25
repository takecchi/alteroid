import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  CLONE_TOOLS_TRANSPORT_ENV_KEY,
  CLONE_TOOLS_TRANSPORTS,
  DEFAULT_CLONE_TOOLS_TRANSPORT,
  resolveCloneToolRelayChildEntry,
  resolveCloneToolsTransport,
} from './clone-tools-transport.js';

describe('resolveCloneToolsTransport', () => {
  it('未設定・空・空白は既定（sdk）', () => {
    expect(resolveCloneToolsTransport({})).toBe(DEFAULT_CLONE_TOOLS_TRANSPORT);
    expect(resolveCloneToolsTransport({ [CLONE_TOOLS_TRANSPORT_ENV_KEY]: '' })).toBe('sdk');
    expect(resolveCloneToolsTransport({ [CLONE_TOOLS_TRANSPORT_ENV_KEY]: '   ' })).toBe('sdk');
  });

  it('sdk / stdio はそのまま通す（前後の空白は落とす）', () => {
    expect(resolveCloneToolsTransport({ [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'sdk' })).toBe('sdk');
    expect(resolveCloneToolsTransport({ [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stdio' })).toBe('stdio');
    expect(resolveCloneToolsTransport({ [CLONE_TOOLS_TRANSPORT_ENV_KEY]: '  stdio  ' })).toBe(
      'stdio',
    );
  });

  it('未知の値は黙って sdio へも sdk へも倒さず、例外にして構築を止める', () => {
    expect(() => resolveCloneToolsTransport({ [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stido' })).toThrow(
      /ALTEROID_CLONE_TOOLS_TRANSPORT/,
    );
    expect(() =>
      resolveCloneToolsTransport({ [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'STDIO' }),
    ).toThrow(); // 大文字小文字も緩めない（`resolvePermissionModeFor` と同じ厳密さ）
  });

  it('CLONE_TOOLS_TRANSPORTS は sdk / stdio の2値だけを持つ', () => {
    expect([...CLONE_TOOLS_TRANSPORTS].sort()).toEqual(['sdk', 'stdio']);
  });
});

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
