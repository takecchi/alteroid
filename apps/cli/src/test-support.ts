import { vi } from 'vitest';

/**
 * `apps/cli` の各テストファイルが使う、小さな共有の試験用足場。
 *
 * 起こす先は `apps/web/app/test-support.tsx`（画面側の共有足場）と同型 —
 * 各テストファイルが手で複製していた同一の関数を1本に寄せただけである
 * （#328。寄せる前は `access.test.ts` / `chat.test.ts` / `conversations.test.ts` /
 * `memory.test.ts` の4ファイルが `function captureStdout` を一字一句同じ形で
 * 持っていた）。
 */

/**
 * 端末へ書いたもの（`process.stdout.write` の呼び出し）を集めて、後から
 * まとめて読める形にする。
 *
 * **これを寄せても「呼び忘れ」は直らない。** `apps/cli` のコマンド関数は
 * `stdout.write` で人間向けの文言を書くので、このヘルパを呼ばずにそれを
 * 呼ぶテストがあれば、出力は本物の stdout（＝テストランナーの出力そのもの）
 * へ流れる。それを赤くするのは根の `vitest.setup.ts` の歯（#314 / #319）で
 * あって、この関数の役目ではない — ここが直すのは複製そのものだけである。
 *
 * **⚠️ 純粋関数（`render*`）だけを測ると、書く側の欠陥が緑のまま通る
 * （#361）。** `render*` のテスト（引数を渡して戻り値の文字列を assert する
 * だけの形）が緑でも、それを呼んで実際に端末へ書く側のコマンド関数
 * （`stdout.write` を呼ぶ側）が別のものを書く・書かない・書く先を間違える
 * 欠陥は、`render*` を直接呼ぶテストでは検出できない。コマンド関数も
 * この `captureStdout` を張って測ること。
 *
 * **後始末はテスト側の責務。** ここでは `vi.restoreAllMocks()` を呼ばない —
 * 呼ぶと、同じテストが張った他の spy（`fetch` など）まで巻き込んで戻して
 * しまう。呼び出し側が `afterEach(() => vi.restoreAllMocks())` を持つこと
 * （既存の4ファイルは全部持っている）。
 */
export function captureStdout(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join('');
}
