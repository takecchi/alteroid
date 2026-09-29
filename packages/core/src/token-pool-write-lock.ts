/**
 * `TokenPoolStore`（トークンの表）への書き込みを、`TokenPoolService`
 * （`token-pool-service.ts`）と `TokenRotator`（`token-rotator.ts`）の**両方**
 * が共有する直列化の鍵（Issue #2200）。
 *
 * ## なぜ要るか —— 別々の `serial()` は互いを待たない
 *
 * `TokenPoolService` と `TokenRotator` は、それぞれ自分の中に関数ローカルの
 * `serial()`（`let tail`）を持つ。**これは別インスタンスの別の列である**
 * ——`TokenPoolService.replace()`（人間の `PUT /tokens`）が自分の列を
 * 直列化していても、`TokenRotator.observe()` / `reconsider()` は別の列を
 * 直列化しているだけなので、両方が同時に走る。
 *
 * 書き手はどちらも `TokenPoolStore.replace()`（CAS の無い全文置換。
 * `store.ts` の doc）で書く——「一覧を読む → 自分の変更を計算する → 全部を
 * 書き戻す」という形である。2つの別々の列がこれを同時にすると、**後に
 * 書いたほうが前の変更を丸ごと消す**（lost update）。
 *
 * **実測（Issue #2200）**: 人間が `PUT /tokens` で3本目のトークンを足して
 * 成功が返った直後、回し手の `observe()` が（probe で候補を試している間に
 * 進んでいた）古い2本の一覧で書き戻し、足した3本目が消えた。
 *
 * ## この鍵が守る範囲 —— 「書く区間」だけ
 *
 * **握るのは「最新の一覧を読み直す → 自分が変えた行だけを id で当てる →
 * 書き戻す」という短い区間だけである。** `probe`（外部の枠を問い合わせる。
 * `TokenProbePort`）や `spread`（回した鍵を runner とクローンへ撒く。
 * `TokenSpreadPort`）のあいだは握らない——ここを握ると、人間の
 * `PUT /tokens` が候補を試す・撒く時間（`CANDIDATE_SWEEP_BUDGET_MS` で
 * 最大60秒）ぶんずっと待たされる。
 *
 * **`TokenPoolStore` に「1行だけ更新する」口は足さない**
 * （`token-pool-service.ts` の `writeOne` の doc の決定はそのまま）。全文
 * 置換のまま、読み直しと書き戻しの間だけをこの鍵で挟む。
 *
 * ## 各サービス内の `serial()` は消さない
 *
 * `TokenPoolService` の `serial()` は「同じサービスへの複数の呼び出しが
 * 混ざらないこと」を、`TokenRotator` の `serial()` は「回し手への複数の
 * 呼び出しを1本ずつ処理すること」を守っている——どちらもこの鍵とは別の
 * 意味を持つので、両方とも残す。この鍵は、それぞれの内側の「書く区間」
 * だけに追加する（外側を置き換えない）。
 */
export interface TokenPoolWriteLock {
  /**
   * `work` を、他の `run` 呼び出しと排他に実行する。**前の `run` が終わって
   * から次が始まる**（`token-pool-service.ts` / `token-rotator.ts` が元々
   * 持っていた `serial()` と同じ形）。
   *
   * **ここに置くのは「読み直す → 変えた行を当てる → 書き戻す」の短い区間
   * だけにすること。** probe や spread のような、外部を待つ・時間の掛かる
   * 処理を中に含めると、この鍵を待つ他方の書き手（人間の `PUT /tokens` や、
   * もう一方の回転判定）がその時間ぶん止まる。
   *
   * 前の `work` が失敗しても列は止めない——常に解決する形で繋ぐ（失敗は
   * 呼び出し側の `run()` の戻り値（Promise の reject）としてそのまま返る）。
   */
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * 新しい鍵を作る。
 *
 * **既定は呼び出し元ごとに別の鍵になる。** `createTokenPoolService` /
 * `createTokenRotator` はどちらも `options.writeLock` を省略すると自分専用の
 * 鍵をここから作る——テストや、まだこの鍵を配線していない呼び手
 * （どちらか一方だけを単体で使う場面）との互換のためである。
 *
 * **本番では1つだけ作って両方へ渡す**（`apps/daemon/src/index.ts`）——
 * 別々のインスタンスを渡すと、直列化の意味が消えて Issue #2200 の状態に
 * 戻る。
 */
export function createTokenPoolWriteLock(): TokenPoolWriteLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work, work);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
