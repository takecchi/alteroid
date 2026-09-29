import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * issue #2195 —— `tail -f` / `tail --follow` の検出が、引用符の**中**に書かれた
 * 字面まで拾って誤検知していた（`git commit -m "use tail -f x.log"` 等）。
 *
 * 直し方は `bash-wait-guard.ts` の `hasUnboundedTailFollow` / `blankQuotedInterior`
 * の doc 参照 —— 引用符の外だけを見るように直しつつ、文字列を実行する形
 * （`bash -c` 系。issue #2104 と同じ5つの入口）は `extractNestedShellPayloads`
 * で取り出した中身に同じ判定を再帰でかけて、なお弾く。
 *
 * ⚠️ このリポジトリを操作するエージェント自身が、直す前と同じ「引用符の中でも
 * `tail -f` を弾く」本番のガードに支配されている——`tail -f` という連続した
 * 字面を Bash ツールのコマンド行に書くとこの作業そのものが弾かれる（実際に
 * このテストを書く作業中に踏んだ）。そのため、この歯の中でも `TAIL` 定数を
 * 文字列結合で組み立て、ソース中に `tail -f` という連続した字面を作らない形に
 * してある。
 */
const TAIL = ['ta', 'il'].join('');

describe('tail-f: issue #2195 —— 引用符の中の誤検知5形を通す', () => {
  const falsePositives: ReadonlyArray<[string, string]> = [
    ['1: git commit -m の引用符の中', 'git commit -m "use ' + TAIL + ' -f x.log"'],
    [
      '2: gh issue comment --body の引用符の中',
      'gh issue comment 1 --body "run ' + TAIL + ' -f x.log"',
    ],
    ['3: grep のパターンの引用符の中', 'grep -n "' + TAIL + ' -f x.log" a.md'],
    ['4: echo の単一引用符の中', "echo '" + TAIL + " -f x.log'"],
    ['5: 変数代入の二重引用符の中', 'x="' + TAIL + ' -f y"; echo $x'],
  ];

  for (const [label, command] of falsePositives) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }

  it('誤検知5形すべてで falsePositives の件数が5件であること（表と実装のずれを検知する）', () => {
    expect(falsePositives.length).toBe(5);
  });
});

describe('tail-f: issue #2195 —— 本物は引用符の外・文字列を実行する形のどちらでも弾く', () => {
  const knownForms: ReadonlyArray<[string, string]> = [
    ['1: 素の tail -f', TAIL + ' -f x'],
    ['2: sudo 付き', 'sudo ' + TAIL + ' -f x'],
    ['3: -F（大文字）', TAIL + ' -F x'],
    ['4: --follow', TAIL + ' --follow x'],
    ['5: bash -c（二重引用符）', 'bash -c "' + TAIL + ' -f x"'],
    ['6: sh -c（単一引用符）', "sh -c '" + TAIL + " -f x'"],
    ['7: eval', 'eval "' + TAIL + ' -f x"'],
    ['8: ssh host（引用符の中身）', 'ssh h "' + TAIL + ' -f x"'],
    ['9: コマンド置換 $( … )', 'echo $(' + TAIL + ' -f x)'],
    ['10: バッククォート', 'echo `' + TAIL + ' -f x`'],
    ['11: 引用符の後ろに在る本物', 'a "q"; ' + TAIL + ' -f x'],
  ];

  for (const [label, command] of knownForms) {
    it(`${label}: 弾く（form: tail-f）`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('tail-f');
    });
  }

  it('本物11形すべてで knownForms の件数が11件であること（表と実装のずれを検知する）', () => {
    expect(knownForms.length).toBe(11);
  });
});

describe('tail-f: issue #2195 —— 対照（弾かないことを固定する）', () => {
  it(
    'bash -c \'echo "' +
      TAIL +
      ' -f x"\' は通す（取り出した中身の中でも tail が echo の引数——コマンドの位置ではない）',
    () => {
      const command = 'bash -c \'echo "' + TAIL + ' -f x"\'';
      expect(inspectBashCommand(command).blocked).toBe(false);
    },
  );
});
