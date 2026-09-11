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

/**
 * **DOM を持つ環境（jsdom）のテストは、終わるときに macrotask 境界を1つ必ず作る。**
 *
 * ## 何が起きていたか
 *
 * Radix の `FocusScope`（ドロワー＝`drawer.tsx` → shadcn `sheet` → Radix Dialog が
 * 中で使う）は、**unmount の後始末を `setTimeout(..., 0)` へ逃がす**。その中で
 * `new CustomEvent('focusScope.autoFocusOnUnmount')` を作り、`container` へ
 * `dispatchEvent` して、元の場所へ焦点を戻す
 * （`@radix-ui/react-focus-scope/dist/index.mjs`。実装は現行の依存版
 * `1.1.16` でも変わっていない — `setTimeout(() => { … }, 0)` が逐語のまま在ることを
 * 2026-09-11T15:16Z に `node_modules/.pnpm/@radix-ui+react-focus-scope@1.1.16…` の
 * 現物で確かめてある）。
 *
 * **`cleanup()` はこの macrotask を消化しない。** `cleanup()` が返った時点では
 * まだ積まれたままで、テストが終わってもそのまま残る。残った先で発火すると、
 * その時点の `CustomEvent` が `container` の属する DOM のものと食い違い、
 * 走行全体がこう落ちる（**2026-09-11T05:30Z 観測の実例。件数は観測時点のもので、
 * テストが増減するたびに腐る** — 2026-09-11T15:19Z に同じ症状をこの歯だけを
 * 先に main へ載せて取り直したときは `Test Files 1 failed | 243 passed (244)` /
 * `Tests 1 failed | 5835 passed (5836)` だった。数え方も違う — こちらは歯自身が
 * 赤くなった形で、下の「集計行は全部 `passed`」の間欠とは観測の経路が異なる）:
 *
 * ```
 * Test Files  237 passed (237)
 * Tests       5592 passed (5592)
 * Errors      1 error          ← これだけで exit 1
 *
 * TypeError: Failed to execute 'dispatchEvent' on 'EventTarget':
 *            parameter 1 is not of type 'Event'.
 *  ❯ Timeout._onTimeout @radix-ui/react-focus-scope/dist/index.mjs:97:23
 * ```
 *
 * **集計行は全部 `passed` を名乗ったまま exit 1 になる。** これが一番悪い形で、
 * 「テストが1本落ちている」より重い —— **門が嘘をつく**。しかも同じコミットで
 * 再走させると緑になる（間欠）ので、「あの変更が壊した」を追っても何も出ない。
 *
 * ## なぜ per-file のヘルパにしないのか
 *
 * **上の stdout の歯とまったく同じ理由である。** 「呼べば効くが忘れれば何も
 * しない」ものを各テストファイルへ配ると、次に足されるファイルで静かに再発する。
 * `apps/web` の jsdom テストは現に38本あり（2026-09-11T15:19Z 実測、
 * `grep -rl '@vitest-environment jsdom' apps/web/app | wc -l`）、描画する37本は
 * どれも自前の `afterEach` で `cleanup()` を手で呼んでいて（残り1本
 * `apps/web/app/lib/config.test.ts` は描画しない）、`~/test-support` はライフサイクルの
 * フックを1つも登録していない（同じく2026-09-11T15:19Z に `afterEach(` /
 * `beforeEach(` 等の呼び出しが無いことを読み直して確認済み —— 逐語で
 * 「後片付けは呼ぶ側」と書いてある）、共有のヘルパを足しても
 * **39個目の「呼び忘れうるもの」**が増えるだけである。
 *
 * ## なぜ `afterEach` で足りるのか（実測）
 *
 * - **global setup の `afterEach` は、各ファイル自身の `afterEach` より後に走る。**
 *   `cleanup()` が積んだ macrotask が、ここへ来る時点で必ず積まれている
 *   （ファイル側 → global の順であることは実測で確かめた）。
 * - **Node の timer は同じ遅延どうしなら積んだ順に発火する。** ここで積む 0ms は
 *   Radix のものより後なので、Radix 側が先に走り切る。
 *
 * ## なぜ `globalThis.setTimeout` を直接呼ばないのか
 *
 * テストが `vi.useFakeTimers()` を掛けたまま終わると、`globalThis.setTimeout` は
 * 偽の時計に差し替わっていて**誰も進めないので永久に返らない**。setup が読まれる
 * 時点（＝どのテストも動く前）の本物を捕まえておき、それを使う。
 *
 * ## なぜ DOM のある環境だけなのか
 *
 * 消化したいのは DOM の後始末（`dispatchEvent` / 焦点）だけで、それは jsdom の
 * ファイルにしか無い。**「呼び忘れ」の穴は開かない** —— 判定しているのは
 * 環境そのものであって、テストの書き手が足す1行ではない。
 */
const realSetTimeout = globalThis.setTimeout;

afterEach(async () => {
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });
});
