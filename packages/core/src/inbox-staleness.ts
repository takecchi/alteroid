import { DAEMON_TOKEN_POOL_REOPENED_SOURCE } from './clone.js';
import type { InboxEvent } from './schema.js';

/**
 * 器の入れ替えを跨いで拾い直した合図が、**いま配ってもまだ意味が在るか**
 * （Issue #783 段1）。
 *
 * ## なぜ「門」と別に要るのか
 *
 * `#restoreUnread` には既に `redeliveryGate`（`CloneOptions.redeliveryGate`）が
 * 在るが、あれが答えるのは「**いま**配る意味が在るか」という一時的な判定で、
 * 偽でも受信箱の行を消さない（`#foldGatedRedelivery` の doc）。そして
 * `#usageBlocked` は器を跨いで持ち越さないので、起動時の評価は必ず偽になる
 * ——**畳まれ続け、消す経路を一度も通らない。** 実測（2026-09-12、クローンの
 * `manager_list`）で未処理 4,282 件のうち `external` の `token-pool` が
 * 4,255 件、齢24時間以上が 4,243 件だった。
 *
 * ⟹ **足りないのは「もう要らない」を言う口である。**
 *
 * ## ⭐ 門の気分ではなく、合図の性質で答える
 *
 * **この関数は `usageBlocked` を受け取らない。** 受け取る形にすると、同じ合図が
 * 同じ状態でも**評価した瞬間のタイミングで消えたり残ったりする**——そうなると
 * 「消えていない合図」を見た人が、それが「まだ要る」のか「消し損ねた」のかを
 * 区別できない。**引数に無いことが、その形にならないことの保証である。**
 *
 * **答える問いは「器の入れ替えを跨いで拾い直された合図か」に限定してある。**
 * 走っている器の中で配られる合図（`post()` 経由）はこの関数を通らない。
 *
 * ## なぜ `token-pool` だけが `stale` なのか
 *
 * この合図の効果は**1つしかなく、拾い直しの経路はその1つに到達できない。**
 * `CloneHost.usageBlocked`（`host.ts`）の doc が逐語で書いている:
 *
 * > 「認証トークンが通る状態に戻った」という合図は、クローンが枠で止まって
 * > いない限りターンを1本焼くだけで何もしない（`clone.ts` の `post()` の中の
 * > `if (this.#usageBlocked !== null) this.#releaseRequested = true;` が唯一の
 * > 効果であり、止まっていなければそこは1文字も動かない）。
 *
 * そして `RedeliveryGate` の doc が、拾い直しはその `post()` を通らないと書く:
 *
 * > `#restoreUnread` はその門を素通りする。
 *
 * ⟹ **拾い直された `token-pool` の合図は、唯一の効果の場所そのものに到達
 * できない。** 拾い直した瞬間に枠が閉じていれば `#deferred` へ積み直される
 * だけで、**その合図自身が解除を起こすことは無い。**
 *
 * **そして「本当にまだ要る知らせ」は作り直される。** `token-rotator.ts` の
 * `announcedReopen` は逐語「**プロセスの寿命でしか持たない。**」なので、器が
 * 入れ替わった後もまだ回復が要る状況なら、probe が**新しい**合図を作って
 * `clone.post(...)` を通る。⟹ **古い行を消しても仕事は失われない。**
 *
 * ## ⛔ `external` を `type` だけで括らないこと
 *
 * **同じ `external` でも `source` で性質が割れる。**
 *
 * - `runner-registry`（`DAEMON_RUNNER_REGISTRY_SOURCE`）は「挑み直しても
 *   直らない失敗」という**過去に起きた事実の記録**で、`token-pool` の「もう
 *   解決した」という**現在の状態の再掲**とは別物である（`apps/daemon/src/index.ts`
 *   の `postToClone` の doc「日誌にも残るので、後から『いつ繋がらなくなったか』
 *   を追える」）
 * - `POST /events` / `POST /events/:source` 由来の自由文字列の `source` は、
 *   外の世界で何が起きたかを運ぶ。**中身を知らない以上、要らないとは言えない**
 *
 * ⟹ **どちらも `live` に倒す。**「判定できないなら残す」側である
 * （`InboxStore` の doc「二度届く（雑音）より消える（判断材料の喪失）方が高い」）。
 *
 * ## 網羅性を型で強制する
 *
 * `switch (event.type)` で書き、`default` の倒れ先で `never` を受ける
 * ——**新しい合図の型が足されたら、このファイルの `typecheck` が落ちる**
 * （`inboxBacklogDedupeKey`（`inbox-backlog.ts`）と同じ作法）。
 */
export type RestoredInboxEventVerdict = 'live' | 'stale';

/**
 * {@link RestoredInboxEventVerdict} を型ごとに答える純関数。
 *
 * ⚠️ **`stale` は「捨ててよい」であって「無かったことにする」ではない。**
 * 呼び手は消す前に跡（日誌の1行）を残すこと——落ちた分が何件で何だったかが
 * 後から読めなければ、「無い」の種類（届かなかった／畳まれた／そもそも
 * 起きなかった）が区別できなくなる。
 */
export function restoredInboxEventVerdict(event: InboxEvent): RestoredInboxEventVerdict {
  switch (event.type) {
    case 'external':
      // ⛔ `type` だけで括らない。上の doc「`external` を `type` だけで括らないこと」。
      return event.source === DAEMON_TOKEN_POOL_REOPENED_SOURCE ? 'stale' : 'live';
    case 'human_message':
    case 'human_answer':
    case 'manager_message':
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return 'live';
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（staleness）: ${JSON.stringify(exhaustive)}`);
    }
  }
}
