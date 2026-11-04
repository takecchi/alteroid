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

// 本物の `gh` は起動しない: 起動の重さが実行機次第で、CI の混み具合では既定の 5 秒を越えて落ちたため（#6279）。
// 起動は `exec` で差し替え、gh() が組む引数と、成功・失敗の返し方だけを確かめる。
interface ExecCall {
  file: string;
  argv: readonly string[];
  options: { encoding?: string; input?: string; stdio?: readonly string[] };
}

function recordingExec(result: () => string) {
  const calls: ExecCall[] = [];
  const exec = (file: string, argv: readonly string[], options: ExecCall['options']) => {
    calls.push({ file, argv, options });
    return result();
  };
  return { exec, calls };
}

describe('gh', () => {
  it('成功したら stdout を返し、error は null。gh を引数そのままで1回だけ起動する', () => {
    const { exec, calls } = recordingExec(() => '{"ok":true}\n');
    expect(gh(['api', 'repos/x/y'], { exec })).toEqual({ stdout: '{"ok":true}\n', error: null });
    expect(calls).toEqual([
      {
        file: 'gh',
        argv: ['api', 'repos/x/y'],
        options: { encoding: 'utf8', input: undefined, stdio: ['ignore', 'pipe', 'pipe'] },
      },
    ]);
  });

  it('input を渡したときだけ stdin を pipe にして、その中身を渡す', () => {
    const { exec, calls } = recordingExec(() => '');
    gh(['api', '--input', '-'], { input: '{"body":"x"}', exec });
    expect(calls[0]?.options).toEqual({
      encoding: 'utf8',
      input: '{"body":"x"}',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('失敗しても投げず、error に stderr の理由を入れて stdout は null にする', () => {
    const { exec } = recordingExec(() => {
      throw Object.assign(new Error('Command failed: gh'), {
        stderr: 'gh: Not Found (HTTP 404)\n',
      });
    });
    expect(gh(['api', 'repos/x/missing'], { exec })).toEqual({
      stdout: null,
      error: 'gh: Not Found (HTTP 404)',
    });
  });

  it('起動そのものに失敗しても（gh が無いなど）投げず、error に理由を入れる', () => {
    const { exec } = recordingExec(() => {
      throw new Error('spawnSync gh ENOENT');
    });
    expect(gh(['api', 'x'], { exec })).toEqual({
      stdout: null,
      error: 'Error: spawnSync gh ENOENT',
    });
  });
});
