import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2399 —— `isTimeoutWrapped` が、先頭が `timeout` なら全体を有界と読み、区切りの後ろの
 * 待つ形を見なかった。全体が1つの単純コマンドのときだけ有界と読む。
 */
describe('先頭の timeout は、区切りの後ろのコマンドを有界にしない（#2399）', () => {
  const blocked: ReadonlyArray<[string, string, string]> = [
    ['; の後ろの tail -f', 'timeout 60 make build; tail -f x.log', 'tail-f'],
    ['; の後ろの while', 'timeout 5 true; while true; do sleep 1; done', 'while-sleep'],
    ['&& の後ろの tail -f', 'timeout 60 make && tail -f x.log', 'tail-f'],
    ['|| の後ろの tail -f', 'timeout 60 make || tail -f x.log', 'tail-f'],
    ['| の後ろの tail -f', 'timeout 60 cat a | tail -f x.log', 'tail-f'],
    ['単体の & の後ろの tail -f', 'timeout 60 make & tail -f x.log', 'tail-f'],
    ['改行の後ろの tail -f', 'timeout 60 make\ntail -f x.log', 'tail-f'],
    ['環境変数付きでも', 'FOO=1 timeout 60 make; tail -f x.log', 'tail-f'],
    ['行の継続の後の区切り', 'timeout 60 make \\\n  -j4; tail -f x.log', 'tail-f'],
  ];
  for (const [label, command, form] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe(form);
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['対照: timeout tail -f', 'timeout 60 tail -f x.log'],
    ['環境変数付き', 'FOO=1 timeout 60 tail -f x.log'],
    ['末尾の &（背景）', 'timeout 60 tail -f x.log &'],
    ['末尾の ;', 'timeout 60 tail -f x.log;'],
    ['2>&1', 'timeout 60 tail -f x.log 2>&1'],
    ['&> のリダイレクト', 'timeout 60 tail -f x.log &> o.log'],
    ['引用符の中の ;', "timeout 60 tail -f 'a;b.log'"],
    ['引用符の中の改行と &', 'timeout 60 tail -f "a & b\nc.log"'],
    [
      'ヒアドキュメントの本体は区切りに数えない',
      "timeout 60 bash <<'EOF'\nwhile true; do sleep 1; done\nEOF",
    ],
    ['行の継続', 'timeout 60 tail -f \\\n  x.log'],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('timeout の単純コマンド判定は長い入力で2乗にならない（#2399）', () => {
  it('区切りの無い長い引数列', () => {
    const makeInput = (n: number) => `timeout 60 tail -f ${'x '.repeat(n)}`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });
  it('リダイレクトの & の繰り返し', () => {
    const makeInput = (n: number) => `timeout 60 tail -f x ${'2>&1 '.repeat(n)}`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500 });
  });
});
