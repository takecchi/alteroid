import { afterAll, afterEach, expect } from 'vitest';

import { scrubSecretEnv } from './vitest.env-scrub.js';
import { drainCreatedTempDirsForCurrentFile } from './vitest.tmpdir.js';

// ほかの何よりも先に呼ぶ: この後に読み込まれるテストのコードと、そこから起こされる子プロセスに、本物の秘密の値を渡さないため。
scrubSecretEnv(process.env);

// テストが本物の stdout へ書いたら落とす: 各テストファイルの `captureStdout()` は呼び忘れても何も起きず、同じ穴が黙って再発するため、ここで包んで呼び忘れを赤で出す。
// stderr は見ない: `apps/daemon/src/storage.ts` や `packages/core/src/credentials.ts` が `process.stderr.write` で人間向けの注意を書いていて、テスト中にも出る別の穴のため。
// `console.log` は対象外: vitest が別経路で横取りし、通ったテストのぶんは捨てるため。通っても落ちても出てしまうのは `process.stdout.write` だけ。
// テストの中を覗くのに `process.stdout.write` を足さない: この歯がそのテストを落とし、変異試験では観測のために足した1行が「変異を検出した」に化けるため。`pnpm test --reporter=verbose` か `process.stderr.write` を使う（`.claude/skills/mutation-testing/SKILL.md` の「落ちなかったとき、理由を推測しない」）。

const passThrough = process.stdout.write.bind(process.stdout) as (
  chunk: unknown,
  ...rest: unknown[]
) => boolean;

// 溜めるだけで握り潰さず、本物の stdout へそのまま通す: 出力を消すと、赤くなった理由（何が書かれたか）を出力から追えなくなるため。
let leaked: string[] = [];

process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
  leaked.push(String(chunk));
  return passThrough(chunk, ...rest);
}) as typeof process.stdout.write;

// 溜めた分を消すのは `afterEach` の中だけにする（`beforeEach` で消さない）: import 時やテストとテストの間に書かれたものも次の `afterEach` で拾うため。
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

// DOM を持つ環境（jsdom）のテストは、終わるときに macrotask 境界を1つ必ず作る: Radix の `FocusScope` は unmount の後始末を `setTimeout(..., 0)` へ逃がし、`cleanup()` はそれを消化せず、残った先で発火すると `CustomEvent` が食い違って、集計行は全部 `passed` のまま exit 1 になるため。
// per-file のヘルパにしない: 「呼べば効くが忘れれば何もしない」ものを各テストファイルへ配ると、次に足されるファイルで静かに再発するため。
// `globalThis.setTimeout` を直接呼ばず、setup が読まれた時点の本物を捕まえておく: テストが `vi.useFakeTimers()` を掛けたまま終わると、偽の時計に差し替わっていて誰も進めず永久に返らないため。
// DOM のある環境だけに掛ける: 消化したいのは DOM の後始末だけで、判定するのは環境そのものであり、テストの書き手が足す1行ではないため。
const realSetTimeout = globalThis.setTimeout;

afterEach(async () => {
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });
});

// 一時ディレクトリの掃除は `afterEach` ではなく `afterAll` で行う: `beforeAll` で1つ作ってファイル内の複数の `it` が読む形を壊さないため。呼ぶ場所はここだけにする。
afterAll(async () => {
  await drainCreatedTempDirsForCurrentFile();
});
