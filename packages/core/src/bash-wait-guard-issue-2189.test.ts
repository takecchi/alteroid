import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * Issue #2189 —— 待つ形のガード（背景の run watch・`tail -f`）が、行の継続（`\` + 改行）で
 * 折り返した形を見落としていた（#2179 の残り）。直す前（main 8d6289b）は、下の「弾く」のうち
 * ループの2形を除いてすべて `blocked: false` だった（写しに直接当てた実測、2026-09-29T13:09Z）。
 *
 * `run watch` の字面は組み立てる（このファイルをヒアドキュメントで書くと、本番の版のガードに
 * 誤検知で弾かれるため。#2130）。
 */
const W = ['gh', 'run', 'watch'].join(' ');
const RUN = ['gh', 'run'].join(' ');

describe('待つ形のガードは、行の継続で折り返した形も弾く（#2189）', () => {
  const blocked: ReadonlyArray<[string, string, string]> = [
    ['tail の -f を次の行へ', 'tail \\\n  -f x.log', 'tail-f'],
    ['tail の -n の後ろで折り返す', 'tail -n 100 \\\n  -f x.log', 'tail-f'],
    ['CRLF の継続', 'tail \\\r\n  -f x.log', 'tail-f'],
    ['背景の & を次の行へ', `${W} 1 \\\n  &`, 'gh-run-watch-background'],
    ['フラグの後ろの & を次の行へ', `${W} 1 \\\n  --exit-status &`, 'gh-run-watch-background'],
    ['watch を次の行へ', `${RUN} \\\n  watch 1 &`, 'gh-run-watch-background'],
    // 直す前から弾けていた形（回帰の確かめ）
    ['until の本体の中の折り返し', 'until false; do \\\n  sleep 1; done', 'until-sleep'],
    ['C 形式の for の本体の中の折り返し', 'for ((;;)); do \\\n  sleep 1; done', 'for-sleep'],
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
    ['-f の無い tail の折り返し', 'tail \\\n  -n 100 x.log'],
    ['前景の run watch の折り返し', `${W} 1 \\\n  --exit-status`],
    ['timeout で包んだ tail -f の折り返し', 'timeout 60 \\\n  tail -f x.log'],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});
