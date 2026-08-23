import { afterEach, expect } from 'vitest';

/**
 * **テストが本物の stdout へ書いたら、そのテストを落とす。**
 *
 * `apps/cli` のコマンド関数は人間向けの文言を `stdout.write` で書く
 * （`import { stdout } from 'node:process'`）。テスト側がそれを差し替えずに
 * 呼ぶと、文言が**テストランナーの出力そのものへ**流れる。#314 はこれを
 * 「runner の子プロセスの stdout へ何かが挿入された」と読んだ報告で、
 * 逐語は空行の位置まで一致していた。**混入とテストの漏れが見分けられない。**
 *
 * 各テストファイルの `captureStdout()` は「呼べば効く」が「呼び忘れても何も
 * 起きない」ので、同じ穴が黙って再発する。ここで包むのは、その呼び忘れを
 * **赤で出す**ためである。
 *
 * **掛かるのは `apps/cli` だけではない。** `setupFiles` は root の
 * `vitest.config.ts` が集める全テストファイルに効く（`packages/core` の
 * テストへ `process.stdout.write` を1行足す変異で、そこでも赤くなることを
 * 確かめてある）。#314 の現物が CLI だっただけで、歯は口を選ばない。
 *
 * **stderr は見ない。** `apps/daemon/src/storage.ts` や
 * `packages/core/src/credentials.ts` は `process.stderr.write` で人間向けの
 * 注意を書いていて、テスト中にも出る。それは別の穴なので、ここでは触らない
 * （stdout に絞れば当たらないことは、全スイートの stdout と stderr を別ファイル
 * へ分けて取った実測で確かめてある）。
 *
 * `console.log` はここを通らない — vitest が別経路で横取りして、通ったテストの
 * ぶんは捨てる。**通っても落ちても出てしまうのは `process.stdout.write` だけ**で、
 * この歯が見ているのはそれである。
 *
 * **⚠️ この歯が塞いだぶん、デバッグの観測手段が1つ減っている。** テストの中を
 * 覗くのに `process.stdout.write` を1行足すと、この歯がそのテストを落とす
 * （出力自体は出る — 握り潰していない — が、赤くなる）。**変異試験ではこれが
 * 特に重い: 生存＝テストが通った、なので、観測のために足した1行が「変異を
 * 検出した」に化ける。** 代わりに使えるものは実測してある —
 * `pnpm test --reporter=verbose` なら通ったテストの `console.log` も出るし、
 * 既定の reporter のままなら `process.stderr.write` が出る（どちらも歯を通らず、
 * テストは緑のまま）。**この赤を見てここへ来た人が、次にどうすればよいかを
 * 出力から辿れるように書いてある** — 詳細は
 * `.claude/skills/mutation-testing/SKILL.md` の「落ちなかったとき、理由を推測しない」。
 */

const passThrough = process.stdout.write.bind(process.stdout) as (
  chunk: unknown,
  ...rest: unknown[]
) => boolean;

/**
 * 溜めるだけで握り潰さない。**本物の stdout へはそのまま通す** — 歯が出力を
 * 消してしまうと、赤くなった理由（何が書かれたか）を出力から追えなくなる。
 */
let leaked: string[] = [];

process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
  leaked.push(String(chunk));
  return passThrough(chunk, ...rest);
}) as typeof process.stdout.write;

/**
 * **溜めた分を消すのは `afterEach` の中だけ**（`beforeEach` で消さない）。
 * import 時やテストとテストの間に書かれたものも、次の `afterEach` で拾いたい —
 * `beforeEach` で消すと、そのぶんが誰にも見られないまま落ちる。
 *
 * 逆に、ファイル内の最後のテストより後（`afterAll` など）に書かれたものは、
 * 受け止める `afterEach` がもう無いのでここでは捕まえられない。
 */
afterEach(() => {
  const written = leaked.join('');
  leaked = [];
  expect(
    written,
    'このテストが本物の stdout へ書いた。人間向けの出力がテストランナーの出力に' +
      '混ざり、別プロセスからの混入と見分けが付かなくなる（#314）。' +
      'stdout へ書く関数（apps/cli のコマンド関数など）を呼ぶテストは、呼ぶ前に ' +
      'process.stdout.write を spy へ差し替えること' +
      '（apps/cli の各テストファイルにある captureStdout() がその形）。' +
      ' デバッグで自分で書いたのなら、--reporter=verbose + console.log か' +
      ' process.stderr.write を使うこと（どちらもこの歯を通らない）。',
  ).toBe('');
});
