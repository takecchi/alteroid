import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { errorDetail, gh } from './small-helpers-core.mjs';

describe('errorDetail', () => {
  it('stderr があればその trim を返す', () => {
    expect(errorDetail({ stderr: '  gh: Not Found (HTTP 404)\n' })).toBe(
      'gh: Not Found (HTTP 404)',
    );
  });

  it('stderr が Buffer でも文字列にして trim する', () => {
    expect(errorDetail({ stderr: Buffer.from('boom\n') })).toBe('boom');
  });

  it('stderr が空なら String(error) へ倒れる', () => {
    const error = { stderr: '', toString: () => 'spawn failed' };
    expect(errorDetail(error)).toBe('spawn failed');
  });

  it('stderr の無い Error は String(error) を返す', () => {
    expect(errorDetail(new Error('ENOENT'))).toBe('Error: ENOENT');
  });

  it('null / 文字列でも投げずに String(error) を返す', () => {
    expect(errorDetail(null)).toBe('null');
    expect(errorDetail('plain')).toBe('plain');
  });
});

describe('gh', () => {
  it('失敗しても投げず、error に理由を入れて stdout は null にする', () => {
    // 不正な部分コマンドは gh が非0で落ちる。gh が無い環境でも spawn 失敗が error に入る。
    const result = gh(['alteroid-no-such-subcommand']);
    expect(result.stdout).toBeNull();
    expect(typeof result.error).toBe('string');
    expect(result.error).not.toBe('');
  });
});
