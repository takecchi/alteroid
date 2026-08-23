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
 * **stderr は見ない。** `apps/daemon/src/storage.ts` や
 * `packages/core/src/credentials.ts` は `process.stderr.write` で人間向けの
 * 注意を書いていて、テスト中にも出る。それは別の穴なので、ここでは触らない
 * （stdout に絞れば当たらないことは、全スイートの stdout と stderr を別ファイル
 * へ分けて取った実測で確かめてある）。
 *
 * `console.log` はここを通らない — vitest が別経路で横取りして、通ったテストの
 * ぶんは捨てる。**通っても落ちても出てしまうのは `process.stdout.write` だけ**で、
 * この歯が見ているのはそれである。
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
      'CLI のコマンド関数を呼ぶテストは captureStdout() で process.stdout.write を' +
      '差し替えること。',
  ).toBe('');
});
