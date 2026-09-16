import type { InboxEvent } from './schema.js';

/**
 * ⚠️ **この3つ（{@link DAEMON_TOKEN_POOL_REOPENED_SOURCE} /
 * {@link DAEMON_RUNNER_REGISTRY_SOURCE} / {@link isDaemonSelfNotice}）は
 * 元々 `clone.ts` に在った。ここへ動かした理由は、`clone.ts` から独立させる
 * ためではなく、循環参照を避けるためである** —— `clone.ts` は
 * `inbox-backlog.ts` を import しており（`inboxBacklogDedupeKey` /
 * `inboxCollapseKey`）、`inboxCollapseKey` が「デーモン自身が自分の受信箱へ
 * 出した `external` 合図か」を問うのにこの3つが要る（Issue #954 続き）。
 * 定義を `clone.ts` に残したまま `inbox-backlog.ts` から import すると
 * `clone.ts → inbox-backlog.ts → clone.ts` の閉路になるので、両方から
 * import できる独立したファイルへ切り出した。**`clone.ts` は引き続きこれを
 * 使う**（`commitmentFor` の `external` 分岐）ので、そちらは import した
 * うえで re-export して既存の呼び出し元（`apps/daemon/src/index.ts` /
 * `packages/core/src/inbox-staleness.ts` / `packages/core/src/index.ts`）の
 * import 元（`from './clone.js'`）を変えずに済ませてある。
 */

/**
 * `apps/daemon/src/index.ts` の `wake()` が
 * `clone.post({ type: 'external', source: DAEMON_TOKEN_POOL_REOPENED_SOURCE, ... })`
 * で出す送信元名（正本）。
 *
 * **正本をここ（`packages/core`）に置く理由。** `apps/daemon/src/index.ts` の
 * `TOKEN_POOL_REOPENED_SOURCE` の doc は、リテラルを発行側（`post` の呼び出し）と
 * 判定側（`isTokenPoolReopenedNotice`）の2箇所に直書きすると、どちらかを直し
 * 忘れたときに黙ってずれる、という理由で定数へ括ってあった。**判定側は`commitmentFor`
 * （`clone.ts`）と `inboxCollapseKey`（`inbox-backlog.ts`）の2つに増えている**——
 * どちらも台帳を開くか・受信箱で畳むかにこの同じ文字列を使う。だが
 * `packages/core` は `apps/daemon` に依存できない（`packages/core/package.json`
 * の deps に daemon は無く、`apps/daemon/package.json` が `@alteroid/core` を
 * 依存する片方向だけがある）ので、定数を daemon 側に置いたまま core が import
 * することはできない。**だから正本をこちらへ置き、daemon 側の
 * `TOKEN_POOL_REOPENED_SOURCE` はこの値をそのまま指す形にしてある。**
 */
export const DAEMON_TOKEN_POOL_REOPENED_SOURCE = 'token-pool';

/**
 * `apps/daemon/src/index.ts` の `postToClone`（runner の登録・接続まわりの
 * 不具合をクローンへ知らせる経路）が使う送信元名（正本）。
 *
 * **かつては `postToClone` の中に直書きのリテラルだった** — 判定側
 * （`commitmentFor` / `inboxCollapseKey`）がこの文字列を見るようになったので、
 * {@link DAEMON_TOKEN_POOL_REOPENED_SOURCE} と同じ理由でここへ括った。
 */
export const DAEMON_RUNNER_REGISTRY_SOURCE = 'runner-registry';

/**
 * `event` が、デーモン自身が自分の受信箱へ出した合図か。
 *
 * **対象はいまのところ2つ** — {@link DAEMON_TOKEN_POOL_REOPENED_SOURCE}
 * （`wake()` が出す「認証トークンが通る状態に戻った」通知）と
 * {@link DAEMON_RUNNER_REGISTRY_SOURCE}（`postToClone` が出す runner 登録の
 * 不具合通知）。どちらも `apps/daemon/src/index.ts` が **自分で作って自分の
 * クローンへ渡す** `external` の合図であって、外の誰か・何かがクローンへ渡して
 * きたものではない。
 *
 * **2つの呼び手を持つ。** `commitmentFor`（`clone.ts`）の `external` 分岐が
 * これを見て台帳を開かないよう絞り、`inboxCollapseKey`（`inbox-backlog.ts`）
 * の `external` 分岐がこれを見て受信箱で畳んでよいかを絞る（Issue #954
 * 続き）——**判断の軸は同じ「alteroid 自身が自分に宛てて合成した知らせか」**
 * で、開く相手の有無を問うか（台帳）、畳んでよいかを問うか（受信箱）が違う
 * だけである。`isTokenPoolReopenedNotice`（`apps/daemon/src/index.ts`）とは
 * 別物である — あちらは「枠が開いたら配り直しを待たせるか」の判定
 * （`token-pool` だけを見る）で、こちらは「相手が alteroid 自身か」の判定
 * （2つとも見る）である。対象が重なるからといって同じ関数に寄せない——
 * 問う相手が違う。
 *
 * **⚠️ 払っている代償。** `source` は自由文字列である
 * （`schema.ts` の `inboxEventSchema` の `external` 枝、`source: z.string()`）。
 * `POST /events` / `POST /events/:source`（`apps/daemon/src/app.ts`）から
 * 外部の呼び手が `source: "token-pool"` あるいは `"runner-registry"` を送れば、
 * その本物の外部イベントも台帳に載らず、受信箱でも畳まれる——この関数は合図の
 * 中身（型と `source` の文字列）しか見えず、発行元がデーモン自身か外部かを
 * 区別する手段を持たない。**それでも受け入れているのは、この2つがデーモンが
 * 自分の名として使う予約語であり、外から同じ名を名乗るのは名前空間の衝突だと
 * 考えているからである。** 衝突を見分ける手段をこの関数は持てない——持たせる
 * なら受信箱か API の入口に「デーモン自身が出した」印を足すことになり、それは
 * この関数の——延いては #852 の——範囲を超える。**`inboxCollapseKey` はこの
 * 代償をそのまま引き継ぐ。新しい代償ではなく、既存の判断に乗っただけである。**
 */
export function isDaemonSelfNotice(event: InboxEvent): boolean {
  return (
    event.type === 'external' &&
    (event.source === DAEMON_TOKEN_POOL_REOPENED_SOURCE ||
      event.source === DAEMON_RUNNER_REGISTRY_SOURCE)
  );
}
