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

/**
 * {@link DAEMON_TOKEN_POOL_REOPENED_SOURCE} の通知が運ぶ構造化した中身
 * （Issue #1223 再発 / #1240 続き）。
 *
 * ## なぜ構造化した欄が要るか
 *
 * `apps/daemon/src/index.ts` の `wake()` が `clone.post()` へ渡す payload は、
 * これまで人間向けの `text` 1本だけだった（`describeReopenedTokenNotice` が
 * 組む本文）。ところが「この知らせは同じ鍵・同じ resetsAt に対する使い回しか」
 * を機械が判定するには、**文言を解析せず**に `tokenId` と「観測に基づく
 * 回復か」を読める形が要る（AGENTS.md「型と `source` だけを見る。文言では
 * 判定しない」——`isTokenPoolReopenedNotice` と同じ流儀）。
 *
 * **`text` は残す。** 人間が読む本文は変わらない——構造化した2つの欄は
 * `text` に**足す**だけで、置き換えない。
 */
export interface TokenPoolReopenedPayload {
  /** 人間向けの本文（`describeReopenedTokenNotice` が組んだもの）。 */
  readonly text: string;
  /** この知らせが指しているトークンの id。 */
  readonly tokenId: string;
  /**
   * 根拠が**観測**（probe がまた通ることを測った／ターンが実際に成功した）
   * だったか。
   *
   * `apps/daemon/src/index.ts` の `ReopenedHow` は3値（`回した` / `また通る
   * ようになった` / `冷却が明けた`）を持つが、ここへその型をそのまま持ち込む
   * ことはしない——`packages/core` は `apps/daemon` に依存できない
   * （このファイル冒頭の doc）ので、daemon 側の語彙をここへ漏らさず、
   * {@link staleObservedRecoveryForBlockedKey} が実際に要る1点（観測だった
   * かどうか）だけを真偽値として渡す。`また通るようになった` のときだけ真。
   */
  readonly observedRecovery: boolean;
}

/**
 * `event` が {@link DAEMON_TOKEN_POOL_REOPENED_SOURCE} の通知で、かつ
 * {@link TokenPoolReopenedPayload} の形を持っているなら、その中身を返す
 * （Issue #1223 再発）。
 *
 * **`payload` は `z.unknown()` である**（`schema.ts` の `inboxEventSchema` の
 * `external` 枝）ので、実行時に形を確かめてから読む。**持っていなければ
 * `undefined` を返す** —— 古い（この直しより前に積まれた）通知や、
 * `payload` を省略した通知（`clone.test.ts` の `DAEMON_TOKEN_POOL_REOPENED_SOURCE`
 * の歯がまさにこの形で作る）がここに当たる。**判定できないときは能力を
 * 削らない側へ倒す**（AGENTS.md 地雷2）—— 呼び手はみな `undefined` を
 * 「使い回しではない（＝従来どおり扱う）」側へ読む。
 */
export function tokenPoolReopenedPayload(event: InboxEvent): TokenPoolReopenedPayload | undefined {
  if (event.type !== 'external' || event.source !== DAEMON_TOKEN_POOL_REOPENED_SOURCE) {
    return undefined;
  }
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { text, tokenId, observedRecovery } = payload as Record<string, unknown>;
  if (
    typeof text !== 'string' ||
    typeof tokenId !== 'string' ||
    typeof observedRecovery !== 'boolean'
  ) {
    return undefined;
  }
  return { text, tokenId, observedRecovery };
}

/**
 * 「また通るようになった」の知らせが、**いま止まっている同じ鍵の、同じ
 * 冷却（resetsAt）に対する使い回し**でしかないか（Issue #1223 再発）。
 *
 * ## 何を直しているか
 *
 * 本番（2026-09-23 観測）で、次の輪が4〜6秒周期で回り続けた:
 *
 * 1. `turn_success` によりいまの現役が「また通るようになった」（`recovered`）
 * 2. 別のセッションが同じ現役へ当たり、組織の月間支出上限などで `exhausted`
 *    （通る鍵が無い）を観測——`settleTokenOutcome` が `cloneWakeGate.observeUnusable()`
 *    を呼び、配達済みの印（`told`）を全消去する（`observeUnusable` の doc）
 * 3. 次の `turn_success` の「また通るようになった」が、印を失った `told` に
 *    対して**新しい知らせ**として配られる
 * 4. 配られた通知が {@link usageBlockAlwaysRearms}（token-pool は resetsAt に
 *    関係なく常に再武装する）を通って本物のターンを走らせ、また同じ理由で
 *    弾かれる → 1 に戻る
 *
 * **`observeUnusable()` を呼ぶこと自体は正しい**（`exhausted` は本物の
 * 「鍵が通らない」の観測である——`observeUnusable` の doc）。壊れているのは
 * `usageBlockAlwaysRearms` の側の前提である——あの関数が token-pool の通知を
 * 無条件に再武装させてよい根拠は「**プールへトークンを足す・削る・有効化
 * すると resetsAt の予定は無意味になる**」（`usageBlockAlwaysRearms` の
 * doc）ことだった。**同じ鍵の `turn_success` による「また通るようになった」
 * はプールを1文字も変えていないので、この根拠が当たらない。** 止まって
 * いる理由（同じ鍵の同じ冷却）は何も変わっていないのに、「観測した」という
 * 事実だけを理由に無条件へ倒していたのが実体である。
 *
 * ## 判定
 *
 * 4つの条件が**すべて**成り立つときだけ真（＝畳んでよい）。**1つでも
 * 欠ければ従来どおり配る／再武装する**（判定できないときは能力を削らない
 * 側へ倒す。AGENTS.md 地雷2）。
 *
 * | 条件 | なぜ要るか |
 * | --- | --- |
 * | `observedRecovery` が真 | `回した`（鍵の構成そのものが変わった）と `冷却が明けた`（resetsAt を過ぎた——この関数の対象外）は、どちらも「試す価値がある新しい事実」なので対象外にする |
 * | `blockedResetsAt` が分かっている | 分からなければ「まだ先か」を判定できない——分からない回は今までどおり試す |
 * | `blockedTokenId` が分かっている | 「同じ鍵か」を判定できない——分からない回は今までどおり試す |
 * | `now < blockedResetsAt` | resetsAt を過ぎていれば、次に来る「また通るようになった」は本物の新しい事実である（`reopenedTokenOf` の `冷却が明けた` と同じ境界） |
 * | `reopenedTokenId === blockedTokenId` | 違う鍵の知らせなら、いま止まっている鍵について何も言っていない——畳む理由が無い |
 *
 * **時間の窓（「N 秒以内は捨てる」）でも件数の上限（「N 回配ったら止める」）
 * でもない。** ここが見るのは状態（resetsAt・鍵の同一性）だけで、
 * `docs/north_star.md` の禁止2（能力の削除）を避ける形は
 * `CloneWakeGate` の doc「3つ目の条件」と同じ流儀である。
 *
 * ## 1箇所の関数を複数の呼び手が使う
 *
 * - `packages/core/src/clone.ts` の `post()`（`usageBlockAlwaysRearms` の
 *   例外を、この条件が真の回だけ外す）
 * - `apps/daemon/src/index.ts` の `CloneWakeGate.decide`（`wake()` が
 *   `clone.post()` を呼ぶ前の門）
 * - `apps/daemon/src/index.ts` の `redeliveryGate`（`#restoreUnread` の門。
 *   {@link staleObservedRecoveryNoticeEvent} 経由）
 *
 * 同じ判定をコピーすると、片方だけを直したときに黙ってずれる
 * （`worthDeliveringNow` の doc「呼び手は2つある」と同じ理由）。
 */
export function staleObservedRecoveryForBlockedKey(args: {
  observedRecovery: boolean;
  reopenedTokenId: string;
  blockedResetsAt: number | undefined;
  blockedTokenId: string | undefined;
  /** 主にテスト用。既定は `Date.now()`。 */
  now?: number;
}): boolean {
  if (!args.observedRecovery) return false;
  if (args.blockedResetsAt === undefined || args.blockedTokenId === undefined) return false;
  const now = args.now ?? Date.now();
  if (now >= args.blockedResetsAt) return false;
  return args.reopenedTokenId === args.blockedTokenId;
}

/**
 * {@link staleObservedRecoveryForBlockedKey} の、`InboxEvent` を受け取る形
 * （Issue #1223 再発）。
 *
 * `packages/core/src/clone.ts` の `post()` と `apps/daemon/src/index.ts` の
 * `redeliveryGate` は、どちらも「いま届いた `event`」から判定したい——
 * {@link tokenPoolReopenedPayload} で構造化した中身を読み、読めなければ
 * （token-pool の通知でない・欠けている・古い形）偽を返す（＝従来どおり
 * 扱う。判定できないときは能力を削らない側へ倒す）。
 */
export function staleObservedRecoveryNoticeEvent(
  event: InboxEvent,
  blockedResetsAt: number | undefined,
  blockedTokenId: string | undefined,
  now?: number,
): boolean {
  const payload = tokenPoolReopenedPayload(event);
  if (payload === undefined) return false;
  return staleObservedRecoveryForBlockedKey({
    observedRecovery: payload.observedRecovery,
    reopenedTokenId: payload.tokenId,
    blockedResetsAt,
    blockedTokenId,
    ...(now === undefined ? {} : { now }),
  });
}
