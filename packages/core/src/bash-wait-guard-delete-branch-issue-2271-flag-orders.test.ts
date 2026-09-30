import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard-delete-branch.test-support.js';

/**
 * Issue #2271 の B（段2の最初の PR）—— 枝を消すマージの判定が、作業者が書きそうな
 * フラグの並べ替え・短縮・前置き・行の継続を通していないか。
 *
 * 字面は組み立てる（このファイルの字面が本番の版のガードに弾かれないように。#2130）。
 * `gh` は起動しない。`inspectBashCommand` を関数として呼ぶだけである。
 *
 * 根拠（2026-09-30、gh 2.101.0 のマニュアルの知識）: `gh pr merge` の短いフラグは
 * `-A`（値）・`-b`（値）・`-d`・`-F`（値）・`-m`・`-r`・`-s`・`-t`（値）、継承の `-R`（値）。
 * 長いフラグは `--admin` `--auto` `--author-email` `--body` `--body-file` `--delete-branch`
 * `--disable-auto` `--match-head-commit` `--merge` `--rebase` `--squash` `--subject`。
 * 真偽のフラグは `--delete-branch=<bool>`（pflag の ParseBool。`1`/`t`/`T`/`TRUE`/`true`/`True`
 * が真）を受ける。`--delete-branch true` の `true` は位置引数であって値ではない
 * （枝は消える）。
 */
const M = ['gh', 'pr', 'merge'].join(' ');
const G = 'gh';
const D = ['--delete', 'branch'].join('-');

function verdictOf(command: string) {
  return inspectBashCommand(command);
}

describe('枝を消すマージ: フラグの並べ替え・短縮を通さない（#2271 B）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    // フラグと番号の並び
    ['番号の前に長いフラグ', `${M} --squash ${D} 123`],
    ['番号の後ろに長いフラグ', `${M} 123 --squash ${D}`],
    ['方式の前', `${M} 123 ${D} --squash`],
    ['方式なし', `${M} ${D} 123`],
    ['-d が先頭', `${M} -d 123`],
    ['-d が方式の後', `${M} 123 --squash -d`],
    ['-d が方式の前', `${M} 123 -d --squash`],
    ['--merge と', `${M} 123 --merge ${D}`],
    ['--rebase と', `${M} ${D} --rebase 123`],
    // 値を取るフラグとの並び
    ['--match-head-commit（空白）の前', `${M} 123 --match-head-commit abc123 --squash ${D}`],
    ['--match-head-commit（空白）の後', `${M} 123 ${D} --match-head-commit abc123`],
    ['--match-head-commit=（等号）の後の -d', `${M} 123 --match-head-commit=abc123 -d`],
    ['--subject の値の後', `${M} 123 --subject "fix: x" ${D}`],
    ['--subject の値の後の -d', `${M} 123 --subject "fix: x" -d`],
    ['--subject=（等号・引用符）の後の -d', `${M} 123 --subject="fix: x" -d`],
    ['--subject=（等号・裸）の後の -d', `${M} 123 --subject=fix -d`],
    ['--body の値の後の -d', `${M} 123 --body "本文" -d`],
    ['--body と --subject の後の -d', `${M} 123 --subject "s" --body "b" -d`],
    ['--body-file の後', `${M} 123 --body-file body.md ${D}`],
    ['--body-file= の後の -d', `${M} 123 --body-file=body.md -d`],
    ['-F の後の -d', `${M} 123 -F body.md -d`],
    ['-t の後の -d', `${M} 123 -t "s" -d`],
    ['-b の後の -d', `${M} 123 -b "b" -d`],
    ['-A の後の -d', `${M} 123 -A a@example.com -d`],
    ['--author-email の後', `${M} 123 --author-email a@example.com ${D}`],
    ['--auto と', `${M} 123 --auto --squash ${D}`],
    ['--admin と', `${M} 123 --admin ${D}`],
    ['-R（末尾）', `${M} 123 -R o/r ${D}`],
    ['-R の後の -d', `${M} 123 -R o/r -d`],
    ['--repo（末尾）', `${M} 123 --repo o/r ${D}`],
    ['--repo=（末尾）', `${M} 123 --repo=o/r ${D}`],
    ['-R が merge の直後', `${M} -R o/r 123 -d`],
    ['gh の直後の -R', `${G} -R o/r pr merge 123 -d`],
    ['gh の直後の --repo=', `${G} --repo=o/r pr merge 123 ${D}`],
    ['pr と merge のあいだの -R', `${G} pr -R o/r merge 123 -d`],
    ['pr と merge のあいだの --repo=', `${G} pr --repo=o/r merge 123 ${D}`],
    // 短縮と結合
    ['-sd', `${M} 123 -sd`],
    ['-ds', `${M} 123 -ds`],
    ['-md', `${M} 123 -md`],
    ['-dm', `${M} 123 -dm`],
    ['-rd', `${M} 123 -rd`],
    ['-dr', `${M} 123 -dr`],
    ['-sd が番号の前', `${M} -sd 123`],
    ['-sd と --match-head-commit', `${M} 123 --match-head-commit abc123 -sd`],
    ['-sdA（値を取る短縮が続く）', `${M} 123 -sdA a@example.com`],
    ['-dR（値を取る短縮が続く）', `${M} 123 -dR o/r`],
    ['-d=true', `${M} 123 -d=true`],
    ['-d が別の短縮の値の後', `${M} 123 -F body.md -sd`],
    // 真偽の値つき
    ['=true', `${M} 123 ${D}=true`],
    ['=TRUE', `${M} 123 ${D}=TRUE`],
    ['=1', `${M} 123 ${D}=1`],
    ['=t', `${M} 123 ${D}=t`],
    ['空白 true（true は位置引数）', `${M} 123 ${D} true`],
    ['空白 false（false は位置引数で、枝は消える）', `${M} 123 ${D} false`],
    // 番号の代わり
    ['URL', `${M} https://github.com/o/r/pull/123 --squash ${D}`],
    ['枝名', `${M} fix/some-branch --squash ${D}`],
    ['owner:枝名', `${M} someone:fix/x -d`],
    ['何も付けない', `${M} --squash ${D}`],
    ['何も付けない -d', `${M} -d`],
    // 前置き
    ['timeout', `timeout 60 ${M} 123 ${D}`],
    ['timeout -s', `timeout -s KILL 60 ${M} 123 -d`],
    ['timeout --kill-after=', `timeout --kill-after=5 60 ${M} 123 -d`],
    ['timeout 60s', `timeout 60s ${M} 123 -d`],
    ['cd &&', `cd /work/tree && ${M} 123 ${D}`],
    ['cd && timeout', `cd /work/tree && timeout 60 ${M} 123 -d`],
    ['GH_PAGER=cat', `GH_PAGER=cat ${M} 123 ${D}`],
    ['GH_PAGER=cat timeout', `GH_PAGER=cat timeout 60 ${M} 123 -d`],
    ['env X=1', `env X=1 ${M} 123 ${D}`],
    ['env -u X', `env -u X ${M} 123 -d`],
    ['env X=1 timeout', `env X=1 timeout 60 ${M} 123 -d`],
    ['cd && GH_PAGER=cat timeout env', `cd /t && GH_PAGER=cat timeout 60 env X=1 ${M} 123 -d`],
    ['cd ; の後', `cd /t; ${M} 123 -d`],
    ['echo の後の &&', `echo start && ${M} 123 -sd`],
    // 改行・行の継続
    ['継続（\\ 改行）で -d', `${M} 123 \\\n  --squash \\\n  -d`],
    ['継続で長いフラグ', `${M} 123 \\\n  --squash \\\n  ${D}`],
    ['継続（CRLF）', `${M} 123 \\\r\n  --squash \\\r\n  ${D}`],
    ['継続で値の後', `${M} 123 \\\n  --match-head-commit abc123 \\\n  --subject "s" \\\n  -sd`],
    ['継続の直後に merge', `${G} pr \\\n  merge 123 -d`],
    ['継続の前置き', `timeout 60 \\\n  ${M} 123 -d`],
    ['タブ区切り', `${M}\t123\t-d`],
    ['空白2つ', `${M}  123   --squash  ${D}`],
    // 本文にヒアドキュメントを使う打ち方
    [
      '--body "$(cat <<EOF …)" の後の長いフラグ',
      `${M} 123 --squash --body "$(cat <<'EOF'\n本文\nEOF\n)" ${D}`,
    ],
    ['--body-file - を標準入力から', `${M} 123 --squash --body-file - ${D} <<'EOF'\n本文\nEOF`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = verdictOf(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['対照: 枝を消さない squash', `${M} 123 --squash --match-head-commit abc123`],
    ['対照: 番号なし・フラグなし', `${M}`],
    [
      '対照: 本文をヒアドキュメントで渡し、枝は消さない',
      `${M} 123 --squash --body "$(cat <<'EOF'\n本文 -d\nEOF\n)"`,
    ],
    ['対照: 引用符の中の改行の後ろに別のコマンド', `echo "a\nb"; git branch -d old`],
    ['対照: --auto のみ', `${M} 123 --auto --squash`],
    ['対照: --disable-auto', `${M} 123 --disable-auto`],
    ['対照: --subject の引用符の中に長いフラグの字面', `${M} 123 --subject "x ${D} y" --squash`],
    ['対照: --subject の引用符の中に -d', `${M} 123 --subject "x -d y" --squash`],
    ['対照: --subject=（等号）の引用符の中に -d', `${M} 123 --subject="x -d y" --squash`],
    ['対照: --body の引用符の中に -sd', `${M} 123 --body "x -sd y" --squash`],
    ['対照: -t の単一引用符の中', `${M} 123 -t 'x ${D} y' --squash`],
    ['対照: -b の中の複数行', `${M} 123 -b "x\n-d\ny" --squash`],
    ['対照: -bd は --body d', `${M} 123 -bd`],
    ['対照: -td は --subject d', `${M} 123 -td`],
    ['対照: 別の語 -dev', `${M} 123 -dev`],
    ['対照: 別のサブコマンド view', `${G} pr view 123 -d`],
    ['対照: 別のサブコマンド checkout', `${G} pr checkout 123 -d`],
    ['対照: git branch -d を後ろに', `${M} 123 --squash && git branch -d old`],
    ['対照: ; の後ろの -d', `${M} 123 --squash; git branch -d old`],
    [
      '対照: 継続のあとの枝を消さないマージ',
      `${M} 123 \\\n  --squash \\\n  --match-head-commit abc123`,
    ],
    ['対照: timeout 付きの枝を消さないマージ', `timeout 60 ${M} 123 --squash`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(verdictOf(command).blocked).toBe(false);
    });
  }
});
