import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import {
  describeEditorFailure,
  editorCommandExists,
  openEditor,
  pickEditor,
  quoteForShell,
  readInputFile,
} from './input-errors.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    on(event: string, cb: (code: number) => void) {
      if (event === 'close') cb(0);
      return undefined;
    },
  })),
}));

describe('readInputFile（#2867）', () => {
  it('無いファイルは、打った名前・パス・次の手を日本語で言う（ENOENT を出さない）', async () => {
    const dir = await makeTempDir('input-errors-');
    const error = await readInputFile(join(dir, 'nope.json'), '--file', '--file <path>').catch(
      (e: unknown) => e,
    );
    const text = String(error);
    expect(text).toContain('--file で指したファイルを読めない');
    expect(text).toContain('そのファイルは無い');
    expect(text).toContain('--file <path>で渡し直す');
    expect(text).not.toContain('ENOENT');
  });

  it('ディレクトリを指したら、そう言う', async () => {
    const dir = await makeTempDir('input-errors-');
    await expect(readInputFile(dir, '引数 <file>', '<file>')).rejects.toThrow(
      '引数 <file> で指したファイルを読めない',
    );
    await expect(readInputFile(dir, '引数 <file>', '<file>')).rejects.toThrow(
      'ディレクトリであってファイルではない',
    );
  });
});

describe('describeEditorFailure（#2867）', () => {
  const alt = 'alteroid memory set <slug> --file <path>';

  it('127（見つからない）は、EDITOR / VISUAL の設定と、エディタ無しの打ち方を案内する', () => {
    const text = describeEditorFailure('vi', { code: 127 }, alt).message;
    expect(text).toContain('エディタ「vi」を起動できない');
    expect(text).toContain('VISUAL か EDITOR');
    expect(text).toContain(alt);
    expect(text).not.toContain('異常終了しました');
  });

  it('起動そのものの失敗（error）も同じ案内にする', () => {
    expect(describeEditorFailure('vi', { error: new Error('spawn') }, alt).message).toContain(
      'VISUAL か EDITOR',
    );
  });

  it('それ以外の非0は、反映していないことと終了コードを言う', () => {
    const text = describeEditorFailure('nano', { code: 2 }, alt).message;
    expect(text).toContain('終了コード 2');
    expect(text).toContain('反映していない');
  });

  it('シグナルで打ち切られたら、シグナル名を言う', () => {
    expect(describeEditorFailure('vi', { code: null, signal: 'SIGKILL' }, alt).message).toContain(
      'SIGKILL',
    );
  });
});

describe('editorCommandExists（#2867）', () => {
  it('PATH 上に在るコマンドは在る、無いものは無い（引数つきの指定は先頭の語で見る）', async () => {
    const dir = await makeTempDir('input-errors-');
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'myedit'), '#!/bin/sh\n');
    await chmod(join(bin, 'myedit'), 0o755);
    await expect(editorCommandExists('myedit', { PATH: bin }, 'linux')).resolves.toBe(true);
    await expect(
      editorCommandExists('myedit --wait', { PATH: `/nope:${bin}` }, 'linux'),
    ).resolves.toBe(true);
    await expect(editorCommandExists('vi', { PATH: bin }, 'linux')).resolves.toBe(false);
    await expect(editorCommandExists('nosuch --wait', { PATH: bin }, 'linux')).resolves.toBe(false);
  });

  it('パスで指したものは、その場所の実行できるファイルだけを在るとする', async () => {
    const dir = await makeTempDir('input-errors-');
    const plain = join(dir, 'plain');
    await writeFile(plain, 'x');
    await expect(editorCommandExists(plain, { PATH: '' }, 'linux')).resolves.toBe(false);
    await chmod(plain, 0o755);
    await expect(editorCommandExists(plain, { PATH: '' }, 'linux')).resolves.toBe(true);
    await expect(editorCommandExists(dir, { PATH: '' }, 'linux')).resolves.toBe(false);
  });

  it('シェルが解く形・PATH が無い・Windows は確かめない（undefined）', async () => {
    await expect(
      editorCommandExists('"/a b/vim"', { PATH: '/bin' }, 'linux'),
    ).resolves.toBeUndefined();
    await expect(
      editorCommandExists('FOO=1 vim', { PATH: '/bin' }, 'linux'),
    ).resolves.toBeUndefined();
    await expect(
      editorCommandExists('$HOME/bin/vim', { PATH: '/bin' }, 'linux'),
    ).resolves.toBeUndefined();
    await expect(
      editorCommandExists('~/bin/vim', { PATH: '/bin' }, 'linux'),
    ).resolves.toBeUndefined();
    await expect(editorCommandExists('vim', {}, 'linux')).resolves.toBeUndefined();
    await expect(
      editorCommandExists('notepad', { PATH: 'C:\\Windows' }, 'win32'),
    ).resolves.toBeUndefined();
  });
});

describe('openEditor（#2867）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(spawn).mockClear();
  });

  it('エディタが無ければ起こさずに断る（シェルの「not found」の行を出さない）', async () => {
    vi.stubEnv('VISUAL', 'alteroid-no-such-editor-2867');
    const error = await openEditor('/tmp/x', 'alteroid memory set <slug> --file <path>').catch(
      (e: unknown) => e,
    );
    expect(String(error)).toContain('エディタ「alteroid-no-such-editor-2867」を起動できない');
    expect(String(error)).toContain('alteroid memory set <slug> --file <path>');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('在るエディタは、指定の文字列のままシェルで起こす', async () => {
    vi.stubEnv('VISUAL', 'sh -c true');
    await openEditor('/tmp/x', 'alt');
    expect(spawn).toHaveBeenCalledWith('sh -c true', ["'/tmp/x'"], {
      stdio: 'inherit',
      shell: true,
    });
  });
});

describe('pickEditor（#4051）', () => {
  it('VISUAL → EDITOR → vi の順に使う', () => {
    expect(pickEditor({ VISUAL: 'nano', EDITOR: 'ed' })).toBe('nano');
    expect(pickEditor({ EDITOR: 'ed' })).toBe('ed');
    expect(pickEditor({})).toBe('vi');
  });

  it.each(['', ' ', ' \t\n'])('VISUAL が %j なら未設定として EDITOR へ進む', (blank) => {
    expect(pickEditor({ VISUAL: blank, EDITOR: 'nano' })).toBe('nano');
  });

  it.each(['', '   '])('VISUAL も EDITOR も %j なら vi にする', (blank) => {
    expect(pickEditor({ VISUAL: blank, EDITOR: blank })).toBe('vi');
    expect(pickEditor({ VISUAL: blank })).toBe('vi');
  });

  it('値は刻まず、指定の文字列のまま返す', () => {
    expect(pickEditor({ VISUAL: ' sh -c true ' })).toBe(' sh -c true ');
  });
});

describe('openEditor は空の VISUAL を飛ばす（#4051）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(spawn).mockClear();
  });

  it('VISUAL が空文字でも、EDITOR のエディタを起こす（空の名前を起こさない）', async () => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'sh -c true');
    await openEditor('/tmp/x', 'alt');
    expect(spawn).toHaveBeenCalledWith('sh -c true', ["'/tmp/x'"], {
      stdio: 'inherit',
      shell: true,
    });
  });

  it('EDITOR が空白だけで VISUAL が在るときは、VISUAL を使う', async () => {
    vi.stubEnv('VISUAL', 'sh -c true');
    vi.stubEnv('EDITOR', '  ');
    await openEditor('/tmp/x', 'alt');
    expect(spawn).toHaveBeenCalledWith('sh -c true', ["'/tmp/x'"], {
      stdio: 'inherit',
      shell: true,
    });
  });
});

describe('quoteForShell（#3728）', () => {
  it('POSIX は単一引用符で包み、中の単一引用符を閉じて開き直す', () => {
    expect(quoteForShell('/tmp/a b/c.md', 'linux')).toBe("'/tmp/a b/c.md'");
    expect(quoteForShell("/tmp/it's;$(x).md", 'linux')).toBe("'/tmp/it'\\''s;$(x).md'");
  });

  it('Windows は二重引用符で包む', () => {
    expect(quoteForShell('C:\\Temp\\a b\\c.md', 'win32')).toBe('"C:\\Temp\\a b\\c.md"');
  });
});
