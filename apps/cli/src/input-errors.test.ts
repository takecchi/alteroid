import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { describeEditorFailure, readInputFile } from './input-errors.js';

describe('readInputFile（#2867）', () => {
  it('無いファイルは、打った名前・パス・次の手を日本語で言う（ENOENT を出さない）', async () => {
    const dir = await makeTempDir('input-errors-');
    const error = await readInputFile(join(dir, 'nope.json'), '--file', '--file <path>').catch(
      (e: unknown) => e,
    );
    const text = String(error);
    expect(text).toContain('--file で指したファイルを読めない');
    expect(text).toContain('そのファイルは無い');
    expect(text).toContain('--file <path> で渡し直す');
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
