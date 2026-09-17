import { z } from 'zod';

import { isDaemonSelfNotice } from './daemon-self-notice.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

/**
 * 受信箱（`InboxStore`）の滞留の内訳（#783 段0「測るだけ」）。
 *
 * ## なぜ在るのか
 *
 * `describeInboxBacklog`（`tools.ts`）はこれまで**件数と最古時刻の2つ**しか
 * 出していなかった。#783 が名指しした欠陥は「内訳を測る口がどの層にも無い」
 * ことで、クローンの受信箱に約6,200件・台帳に約6,700件が積み上がっても、
 * それが「同じ合図が何度も配り直されているだけ」なのか「本当に別件が
 * 6,200件」なのかが1文字も言えなかった。この段は**対策ではなく計器**を足す
 * ——何を積むかは決めず、いま何が積まれているかだけを数える。
 *
 * ## 4つの軸
 *
 * - **種類**（`byType`）: `InboxEvent['type']` ごとの件数
 * - **送信元**（`bySource`）: `external.source` / `manager_message.managerId`
 *   など、型ごとに「誰が積んだか」が言える型だけ数える（上位5件まで）。
 *   **打ち切りと「言えない型」で `total` に届かない**——溢れた分は
 *   `bySourceOverflowKinds` / `bySourceOverflowCount` / `bySourceUnknownCount`
 *   で必ず添える（{@link InboxBacklogBreakdown} の doc）
 * - **同一本文**（`distinct` / {@link inboxBacklogDedupeKey}）: `id` と `at`
 *   （1回の発行ごとに必ず変わる2つ）を除いた中身が同じなら同じ本文とみなし、
 *   畳んだら何件になるかを数える
 * - **器の入れ替え回数**（`undelivered` / `deliveredOnce` / `redelivered`）と
 *   **齢**（`ageBuckets`）: `claimPending()` の doc が言う「配達回数は器が
 *   入れ替わった回数であって処理が落ちた回数ではない」を**出力の軸名そのものへ
 *   写した**（#910。理由は {@link describeInboxBacklogBreakdown} の doc）。いまの
 *   器になってから積まれたものと、器の入れ替えを跨いで残っているものを分けて
 *   見せる（**どちらも「配られたか」は答えない。**#910 追補）。
 *   **0回の桶は種類別にも見せる**（`undeliveredByType`）——「いまの器になって
 *   から積まれた分に人間の依頼（`human_message`）が混ざっているか」を、種類と
 *   器の入れ替え回数の突き合わせ無しに直接言えるようにするため
 *
 * ## 純関数である
 *
 * ここは I/O をしない。読むのは呼び出し側（`tools.ts` の `manager_list` /
 * `situation.ts` は触らない——こちらは軽い `pending()` しか使わない）が
 * `InboxStore.peekPending()` で取った行を渡す。判定と副作用を分けておけば、
 * 歯を `InboxStore` の足場を組まずに分岐へ直接当てられる（`situation.ts` の
 * `describeSituation` と同じ作法）。
 */

/** `manager_list` で一覧の内訳を確かめるとき、これを超えたら「詰まり」と読む線。 */
export const INBOX_BACKLOG_LOUD_THRESHOLD = 50;

/**
 * `summarizeInboxBacklog` が出す内訳。
 *
 * ## 0を出す軸と、値を作らない軸
 *
 * ここで数えている軸（種類・送信元・同一本文・器の入れ替え回数・齢）は、
 * **`peekPending()` が返す行を1件も漏らさず全走査すれば必ず数え切れる**
 * ——`AGENTS.md`の地雷「取れない軸に0の行を作る」が指すのは*取れない*軸に
 * 値を作ることであって、ここは全部**実際に数え切れている**軸である。だから
 * 0件のバケツ・型を配列から省いても、それは「数えていない」の意味には
 * ならない。この理由は `situation.ts` の `lost`（#688）が0のとき行を出さない
 * 理由と同じである
 * （逐語は `grep -Fn -- '**`lost`（判断待ち）だけは、0 のときに書かない（#688）。**' packages/core/src/situation.ts`）。
 *
 * ## `total` との算術が成り立つ軸と、成り立たない軸（⚠️ #818 の欠陥と直し方）
 *
 * **算術で「省いた行は0だった」と読めるのは `byType` と `ageBuckets` の2つだけ**
 * ——この2つは全走査したどの行も必ずどれか1つのバケツへ入るので、
 * `省いていない行を足せば必ず total に一致する`。
 *
 * **`bySource` は違う。** 2つの理由で、`bySource` の行を足しても `total` には
 * 届かない——(a) `inboxBacklogSourceFor` が「誰が積んだか」を言えるのは7型中
 * `external` / `manager_message` の2型だけで、残り5型（`human_message` /
 * `human_answer` / `distill` / `timer` / `self_initiative`）はそもそも
 * `bySource` に1件も入らない。(b) 入った送信元も上位5件で打ち切る
 * （`topByCount(..., 5)`）ので、6件目以降の送信元は件数が1以上でも消える。
 * **この2つの欠落が省かれた事実を1文字も言わないと、読み手は「他の送信元は
 * 無かった」と誤読する**——だから欠落そのものを `bySourceOverflowKinds` /
 * `bySourceOverflowCount` / `bySourceUnknownCount` の3値として必ず持たせる
 * （0件でも省かない。「取れない軸に0の行を作る」の逆——ここは実際に数え
 * 切れているので0を作ってよい側である）。**成り立つ不変条件はこちらである:**
 *
 * ```
 * bySource の count の総和 + bySourceOverflowCount + bySourceUnknownCount === total
 * ```
 */
export interface InboxBacklogBreakdown {
  readonly total: number;
  /** 1件も無ければ持たせない（0件のときに値を作らない。`InboxStore.pending` と同じ作法）。 */
  readonly oldestAt?: string;
  /** 件数0の型は載せない。足すと必ず `total` に一致する（全7型を必ずどれかへ分類できるため）。 */
  readonly byType: readonly { readonly type: InboxEvent['type']; readonly count: number }[];
  /**
   * `external` の `source` / `manager_message` の `managerId` など、型ごとに
   * 「誰が積んだか」が言える型だけを数える。上位5件まで（同数なら名前順で
   * 安定させる）。件数0のものは載せない。
   *
   * ⚠️ **これだけでは `total` に届かない**——上位5件から溢れた分（
   * {@link InboxBacklogBreakdown.bySourceOverflowKinds} /
   * {@link InboxBacklogBreakdown.bySourceOverflowCount}）と、`source` を言えない
   * 型の行（{@link InboxBacklogBreakdown.bySourceUnknownCount}）を必ず合わせて読むこと。
   */
  readonly bySource: readonly { readonly source: string; readonly count: number }[];
  /**
   * `bySource` の上位5件から溢れた**送信元の種類数**（0件でも持つ）。
   * 例: 送信元が6種あれば、上位5件に入らない1種が数えられて `1` になる。
   */
  readonly bySourceOverflowKinds: number;
  /**
   * `bySourceOverflowKinds` に数えた送信元の**合計件数**（0件でも持つ）。
   * `bySource` の count の総和 + これ + {@link InboxBacklogBreakdown.bySourceUnknownCount}
   * === `total`。
   */
  readonly bySourceOverflowCount: number;
  /**
   * `source` / `managerId` を言えない型（`human_message` / `human_answer` /
   * `distill` / `timer` / `self_initiative` の5型）の行数の合計（0件でも持つ）。
   */
  readonly bySourceUnknownCount: number;
  /** `inboxBacklogDedupeKey` で畳んだ後の件数。 */
  readonly distinct: number;
  /**
   * {@link inboxBacklogCrossManagerDedupeKey}（`manager_message` は
   * `managerId` を鍵から落として畳む）で畳んだ後の件数（#783 段0 追補）。
   *
   * ## 何のために足したか
   *
   * `distinct`（{@link inboxBacklogDedupeKey}）は `manager_message` を
   * `managerId` ごと分けて畳む。⟹ **同じ壁（枠・429 など）に複数の委譲が
   * 同時に当たって同文の報告が N 本届くと、`distinct` は N のまま減らない**
   * ——一方、上流（`manager.ts` の `#rateLimits` / `#usageNotices`）には
   * `managerId` を跨いで畳む別の畳み込みが既に在り、そちらは逆に「畳み
   * すぎる」方向の欠陥として PR #703 の本文が名指ししている。**畳み込みの
   * 鍵が2つの逆向きに割れている**という状態そのものを、対策を打たずに
   * まず数として読めるようにするのがこの値である（対策そのものは issue
   * #954 として別途切り出してある。ここでは絶対に手を出さない）。
   *
   * ## これが言えること
   *
   * - `distinct` と並べて読むことで、「本文ベースの畳み込みを `managerId`
   *   の有無で行うと、いまの受信箱の内訳としてどれだけ違って見えるか」を
   *   数字で言える
   *
   * ## これが言えないこと（必ず併せて読むこと）
   *
   * - **これは受信箱に残っている行を数えたものであって、上流で既に畳まれて
   *   届かなかった分は入らない。** `#rateLimits` / `#usageNotices` が積む前に
   *   畳んだ件数は最初からここに現れない ⟹ `distinctAcrossManagers` が
   *   小さいからといって「上流の畳み込みは効いている」とは言えないし、
   *   大きいからといって「効いていない」とも言えない。ここは積まれた
   *   *後*の行しか見ていない
   * - **「この数まで減らせる」ではない。** `managerId` を無視して畳んで
   *   よいかどうかは、この計器の外側の判断であり、この変更は畳み込みの
   *   挙動を1ミリも変えていない——数える軸を1つ増やしただけである
   * - **`distinctAcrossManagers <= distinct` が常に成り立つ**（鍵が
   *   `managerId` を落として粗くなる方向にしか動かないため、同じか、
   *   より多くの行が同じ鍵へ畳まれる）。したがって
   *   `distinctAcrossManagers <= distinct <= total` が常に成り立つ
   *   （テストで固定してある）
   *
   * ## なぜ `inboxBacklogDedupeKey` 自体を変えないか
   *
   * `distinct` の意味（`managerId` を含めて畳む）を動かすと、この値を
   * 前提にしている既存の呼び出し側・doc・テストが黙って意味を変える。
   * ここでの目的は「2つの畳み込みの鍵の向きが違う」という事実そのものを
   * **並べて読める**形にすることであって、どちらかを正解として置き換える
   * ことではない——だから鍵を作る関数を分け、`distinct` はそのまま、
   * 新しい軸だけを足す。
   */
  readonly distinctAcrossManagers: number;
  /**
   * `deliveries === 0`。
   *
   * ⚠️ **「まだ配っていない」ではない**（#910 追補）。`post()` は受理した瞬間に
   * `put()` し（`clone.ts` の `#remember`）、同時に待ち行列へも載せるので、
   * **いまの器で積まれた行は、いま処理されている最中のものも含めて必ず 0 である。**
   * ⟹ この数が言えるのは「**いまの器になってから積まれ、まだ片付いていない**」
   * までである。**出力でも `未配達` とは名乗らない**
   * （{@link describeInboxBacklogBreakdown} の doc）。
   */
  readonly undelivered: number;
  /** `deliveries === 1`（器が1回入れ替わった）。 */
  readonly deliveredOnce: number;
  /**
   * `deliveries >= 2`（器が2回以上入れ替わった）。
   *
   * ⚠️ **「この合図の処理が2回以上落ちた」ではない。** `claimPending()` は
   * 残っている未読の**全行**を一緒に進めるので、待ち行列に居ただけで一度も
   * 処理されていない合図も同じだけ増える（`InboxStore.claimPending` の doc）。
   * ⟹ 出力ではこの軸を `配達回数` と名乗らない（#910）。
   *
   * ⚠️ **「2回以上配られた」でもない**（#910 追補）。`#restoreUnread` の門
   * （`CloneOptions.redeliveryGate`）が畳んだ行は `#inbox.push` されない
   * ＝ **ターンが1度も起きない**まま受信箱に残り、起動のたびにこの数だけが
   * 増える。⟹ 名前では塞げない*推論*なので、出力では断り書きを添えている。
   */
  readonly redelivered: number;
  readonly maxDeliveries: number;
  /**
   * `undelivered`（`deliveries === 0`）の行を、種類（`InboxEvent['type']`）別に
   * 数えたもの（#783 段0 追補——「いまの器になってから積まれた分に人間の依頼が混ざっているか」を
   * 直接言えるようにする）。`INBOX_EVENT_TYPE_ORDER` の並びで、件数0の型は
   * 載せない。足すと必ず `undelivered` に一致する（0回の行は必ずどれか1つの
   * 型に分類できるため）。
   */
  readonly undeliveredByType: readonly {
    readonly type: InboxEvent['type'];
    readonly count: number;
  }[];
  /** 件数0のバケツは載せない。足すと必ず `total` に一致する（全行を必ずどれかの齢バケツへ分類できるため）。 */
  readonly ageBuckets: readonly { readonly label: string; readonly count: number }[];
  /**
   * {@link ageBuckets} を数えた基準時刻（`summarizeInboxBacklog` に渡された
   * `now` の ISO 8601。#910 追補）。
   *
   * **齢は相対値なので、基準点が無いと引用に耐えない。** 読んだその場では
   * 「いま」が基準だと分かるが、**この内訳を別の場所へ写した瞬間に基準点が
   * 消える**——写された側は `1時間未満 21` を「いつから見て1時間未満か」を
   * 知らないまま読むことになる。`AGENTS.md`「報告の形」が逐語で言っている
   * 形と同じである（`grep -Fn -- '「その報告がいつの観測か」が報告自身から取れないと' AGENTS.md`）。
   *
   * **新しい観測はしていない。** `summarizeInboxBacklog` が齢を数えるために
   * 既に受け取っている値を、落とさずに持たせているだけである
   * （`Date.now()` はここでも呼ばない——純関数のままである）。
   */
  readonly observedAt: string;
  /**
   * 滞留している行のうち、**人間起点**（`isHumanOriginated`。`human_message` /
   * `human_answer` の2種、`clone.ts` から import——上の import のコメント参照）の
   * ものだけを数えたもの（Issue #917 (B)）。
   *
   * ## なぜ足したか
   *
   * #917 が名指しした欠陥は、`未配達 4301` のような**大きい数字**と、
   * `human_message 1`（`undeliveredByType` の1行）のような**行動を要する
   * 数字**が、出力上まったく同じ字の大きさ・同じ場所（内訳の奥）に並んで
   * いることだった。クローンは大きいほうを先に読み、7行目に埋もれた
   * `human_message 1` を読み飛ばした。**この欄は対策ではなく、行動を要する
   * 数字だけを別の軸として取り出す計器である**——`describeHumanOriginatedInboxAlert`
   * （このファイル）が、これを内訳より前・単独の行として出す。
   *
   * ## `deliveries === 0` に絞らない理由
   *
   * `total` / `byType` は**滞留している人間起点の行を全部**数える。**一度
   * 配達された（`deliveries >= 1`）が、まだ受信箱から消えていない人間の発言も
   * 「人間が言ったのに返事をしていない」ことに変わりはない**——`deliveries`
   * は器が入れ替わった回数であって処理が終わった回数ではない
   * （`InboxBacklogBreakdown.undelivered` の doc、#910）。⟹ 人間起点を
   * `deliveries === 0` だけに絞ると、「配達はされたが、まだ応答していない」
   * 人間の発言を計器から静かに落とすことになる。
   *
   * **`undelivered` はそれとは別に持つ。** #917 が実際に観測した軸
   * （`manager_list` の内訳が見せていたのは0回の桶）を、`total` と並べて
   * 両方読めるようにするため。`undelivered <= total` が常に成り立つ。
   *
   * ## `byType` / `total` の算術
   *
   * `byType` は件数0の型を載せない。足すと必ず `total` に一致する
   * （`human_message` と `human_answer` の2型のどちらかに全行が必ず入るため
   * ——`isHumanOriginated` が真を返す行しかここに来ない）。
   *
   * ## 0件のときは欄ごと持たせない軸・持たせる軸
   *
   * `oldestAt` は0件のとき持たせない（`InboxBacklogBreakdown.oldestAt` と
   * 同じ作法）。`total` / `byType` / `undelivered` は0件でも実際に数え切れて
   * いる値なので、`InboxBacklogBreakdown` の「0を出す軸と、値を作らない軸」の
   * doc が言うとおり0のまま出す（`byType` は空配列、`total`/`undelivered` は
   * `0`）。
   */
  readonly humanOriginated: {
    readonly total: number;
    readonly byType: readonly {
      readonly type: 'human_message' | 'human_answer';
      readonly count: number;
    }[];
    readonly oldestAt?: string;
    readonly undelivered: number;
  };
}

/**
 * 待ち行列で割り込んでよい合図か ＝ 人間が返事を待っている合図か。
 *
 * **2種類ある。** `human_message`（発言）と `human_answer`（承認待ちへの回答）で、
 * どちらも**人間が画面の前で止まっている**。後者を外すと、「答えたのに止まった
 * マネージャーへ返らない」という既知の壊れ方（`commitmentFor` の `human_answer`
 * の doc）が、待ち時間の側からもう一度出る。
 *
 * **タイマー・発意・外部イベント・マネージャーからの一件・蒸留は含まない。**
 * どれも人間が待っている合図ではない。
 *
 * ## なぜこれで人間以外が餓死しないのか
 *
 * **理由は「割り込みの量が有界だから」であって、実装が何かを保証しているから
 * ではない。** 割り込めるのは人間が実際に打った発言だけで、**人間の速さでしか
 * 来ない。** 5件まとめて送られれば5件ぶん遅れて、そのあと必ず進む。
 *
 * **だから機械が人間を名乗る形を作らないこと。** ここに `external`（webhook）や
 * `timer` を足した瞬間、割り込みの量が機械の速さで決まるようになり、**有界性の
 * 根拠が消えて本当に餓死する。** `isHumanOriginated` が2つしか返さないのは、
 * 数が少ないからではなく**ここが有界性の全体だから**である。
 *
 * **テストが測っているのは餓死しないことではない**（それは上の有界性の話で、
 * 有限のテストでは示せない）。**測っているのは「人間を挟んでも人間以外が1件も
 * 消えず、人間以外どうしの到着順も保たれる」＝ 順序の保存と非喪失**である。
 * 歯の名前もそう書いてある。**名前が中身より多くを約束しないこと。**
 *
 * **置き場所はここである（`clone.ts` ではない）。** `clone.ts` は既に
 * `inbox-backlog.ts` から `inboxBacklogDedupeKey` / `INBOX_EVENT_TYPE_ORDER` を
 * import しているので、逆向きに import すると循環になる。判定そのものは
 * 受信箱の合図を型で分類するだけで `Clone` の状態を1つも読まないから、
 * 分類の語彙が集まっているこちら側が本来の置き場所である（#917）。
 */
export function isHumanOriginated(event: InboxEvent): boolean {
  return event.type === 'human_message' || event.type === 'human_answer';
}

/** {@link summarizeInboxBacklog} が並べる齢バケツの境界と順序。 */
const AGE_BUCKET_LABELS = ['1時間未満', '1〜6時間', '6〜24時間', '24時間以上'] as const;

const HOUR_MS = 60 * 60 * 1000;

function ageBucketLabel(ageMs: number): (typeof AGE_BUCKET_LABELS)[number] {
  const hours = ageMs / HOUR_MS;
  if (hours < 1) return AGE_BUCKET_LABELS[0];
  if (hours < 6) return AGE_BUCKET_LABELS[1];
  if (hours < 24) return AGE_BUCKET_LABELS[2];
  return AGE_BUCKET_LABELS[3];
}

/**
 * この合図が「誰が積んだか」を言えるなら、その1語を返す。言えない型は
 * `undefined`——`bySource` から除かれる（0件として数えない。取れない軸に
 * 値を作らない側へ倒す）。
 *
 * `external` と `manager_message` の名前空間が衝突しないよう、種類の接頭辞を
 * 付ける（同じ文字列の `source` と `managerId` が同じ行に畳まれないため）。
 *
 * **export している。**（issue #972）`apps/daemon/src/app.ts` の
 * `POST /inbox/remove`（人間の入口。`matchesInboxRemoveManyFilter` を経由して
 * 使う）が「送信元」で絞り込むとき、ここと同じ判定・同じ表記
 * （`external:<source>` / `manager:<managerId>`）を使う——`manager_list` の
 * 内訳（`bySource`）に出る値と、絞り込みに渡す値が同じ字面になる。判定
 * そのものを2箇所に複製しないのは {@link inboxBacklogDedupeKey} の doc
 * 「なぜ1箇所に閉じるか」と同じ理由である。
 *
 * **クローンの道具 `inbox_remove_many` もこの表記をそのまま使う**（`tools.ts`）
 * ——`manager_list` の内訳に出た送信元を、そのまま `sources` へ貼り付けられる。
 * `inbox_remove_many` が選べる種類は人間起点を除いた5種類に絞ってある
 * （takecchi が (A) 出所で線を引く を採用、2026-09-15。
 * {@link CLONE_REMOVABLE_INBOX_EVENT_TYPES} の doc）。
 */
export function inboxBacklogSourceFor(event: InboxEvent): string | undefined {
  switch (event.type) {
    case 'external':
      return `external:${event.source}`;
    case 'manager_message':
      return `manager:${event.managerId}`;
    case 'human_message':
    case 'human_answer':
    case 'distill':
    case 'timer':
    case 'self_initiative':
      return undefined;
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（source）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * {@link inboxBacklogDedupeKey} がフィールドを繋ぐ区切り。**NUL（`'\u0000'`）
 * である。**
 *
 * 半角スペースから替えた理由は「衝突しないから」ではない（下の限界のとおり、
 * NUL も本文に混ざりうる）。**衝突が倒れる向きが片側だからである** ——
 * 区切りが本文に現れて境界がずれると、別の本文が同じ鍵へ潰れ、`distinct` が
 * 実際より**小さく**出る。⟹ この計器は「畳めば大きく減る」と言う側へ系統的に
 * 偏って嘘をつく。**半角スペースはほぼ全ての本文に含まれるが、NUL は通常の
 * 経路では1つも入らない**（pg は書き込み時に `stripNulls` で落とす。逐語は
 * `grep -Fn -- 'const value = stripNulls(inboxEventSchema.parse(event));' packages/storage-pg/src/inbox.ts`）
 * ので、同じ向きの偏りを桁で小さくできる。
 */
const DEDUPE_SEPARATOR = '\u0000';

/**
 * 「同じ本文か」を畳むための鍵。**このリポジトリで、この判定をするのはここ
 * 1箇所だけである。SQL 側に同じ判定を書かないこと。**
 *
 * ## なぜ1箇所に閉じるか —— #783 が名指しした欠陥の形そのもの
 *
 * `packages/core/src/manager.ts` の `#rateLimits`（鍵は枠の種類・Pool 全体で
 * 1つ）と `#queueSynthesizedNotice`（鍵は `managerId`・マネージャーごと）は、
 * 同じ「畳み込み」という操作を**別々の鍵**で行っている。畳み込みが2つの
 * 別の鍵で割れると、増える側（積む判定）と減る側（消す・数える判定）が
 * 食い違いうる——これがまさに #783 が「内訳を測る口が無い」と言った症状の
 * 裏側にある形である。だからここでは集計（`summarizeInboxBacklog`）を core の
 * 純関数1本に閉じ、ストア（fs / pg）は行を返すだけにする。
 *
 * ## 鍵の作り方
 *
 * `id` と `at`（1回の発行ごとに必ず変わる2つ）を除いた中身から作る。区切りは
 * {@link DEDUPE_SEPARATOR}（NUL）。**`switch (event.type)` で書き、網羅性を
 * 型で強制する** ——新しい合図の型が足されたら、この関数を含むファイルの
 * `typecheck` が落ちる（`AGENTS.md`「テストを弱めずに直す」の #285 と同じ
 * 作法。実行時の倒れ先は default 節で throw する——この repo の同じ union に
 * 対する既存の倒れ先（`clone.ts` の `#dispatch` の `default`）と同じ形である）。
 *
 * ## 限界（3つ）
 *
 * - **区切りは NUL 1文字**（{@link DEDUPE_SEPARATOR}）。フィールドの境界が
 *   ずれて衝突しうる（例: `a` と `'\u0000b'` の2フィールドと、`'a\u0000'` と
 *   `b` の2フィールドは同じ文字列になる）。**それでも「絶対に衝突しない」
 *   区切りは無い** ——NUL も本文（人間の発言・webhook 由来）に混ざりうる
 *   （`packages/storage-pg/src/inbox.ts` の `stripNulls` の存在がその証拠。
 *   `AGENTS.md`「静かに失敗する道具」にも NUL 混入の実例が在る）ので、
 *   「絶対に衝突しない」わけではない
 * - **⚠️ この限界が効くのは、誤差が両側へ散るときだけではない。** 衝突すると
 *   *別の本文が同じ鍵に潰れる*方向にしか働かない——`distinct`（畳んだ後の
 *   件数）は**実際より小さくしか出ない**。⟹ 「畳めば大幅に減る」と読める
 *   側へ**系統的に**偏る。`distinct` / `total` の比は「本文ベースの畳み込み
 *   が効くか」を判断する材料になりうるので、**この計器は『対策を打てば効く』
 *   という、いちばん確かめずに信じたい向きへ嘘をつきやすい形をしている**
 *   ——区切りを NUL にしてもこの向きの偏り自体は消えない（頻度が桁で下がる
 *   だけである）ことを、読む側は割り引くこと（{@link DEDUPE_SEPARATOR} の
 *   doc）。**⚠️ ただし、これは「区切り文字の衝突」という1つの経路の話に
 *   限る。** `distinct` 全体としては逆向き（実際より大きく出る）経路も別に
 *   実在する——下の `external.payload` の直後の項目を見ること。**この計器の
 *   偏りは片方向だけとは言えない**
 * - **`external.payload` は `JSON.stringify` で鍵に含めるが、オブジェクトの
 *   キー順に依存する。** 同じコード経路（同じ webhook ハンドラなど）が作った
 *   同形のオブジェクトなら安定するが、一般には保証されない——キー順が違う
 *   同じ中身の2件を、ここでは「別の本文」として数えることがある
 * - **⚠️ 逆向き（`distinct` が実際より大きく出る）経路も実在する。** 上の
 *   偏り（衝突による「小さく出る」向き）は片側の話であって、`external` では
 *   もう一方向も起きる——`token-pool` が発行する「認証トークンが通る状態に
 *   戻った」合図は、`payload.text` の**本文そのもの**に畳んだ件数を焼き込む
 *   （`apps/daemon/src/index.ts` の `payload: { text:
 *   describeReopenedTokenNotice(reopened, decision.folded) }` と、
 *   `describeReopenedTokenNotice` が `folded > 0` のとき本文へ
 *   `（この間に同じ合図が N 件届き、1件にまとめた）` を足す形——両方とも
 *   同ファイル）。**同じ「戻った」という出来事でも、畳んだ件数 N が違えば
 *   `payload.text` が文字どおり異なる文字列になり、鍵も別になる**——これは
 *   区切り文字の衝突ではなく、`external.payload` の中身自体が畳み込みの
 *   件数に依存して変わるために起きる。滞留の多くを占める
 *   `external:token-pool`（Issue #783 の約78%）ではこの経路が現実に効く。
 *   **⚠️ ただし「必ず大きく出る」ではない**——畳んだ件数が同じ2件は同じ鍵に
 *   なるので、向きは標本（そのとき何件畳まれていたか）に依存する。**言える
 *   のは「`distinct` は小さく出る方向にも大きく出る方向にも偏りうる」まで
 *   であって、どちらか一方だけを警告するのは片手落ちである**
 */
export function inboxBacklogDedupeKey(event: InboxEvent): string {
  switch (event.type) {
    case 'human_message':
      return [event.type, event.conversationId, event.text].join(DEDUPE_SEPARATOR);
    case 'human_answer':
      return [event.type, event.approvalId, event.answer].join(DEDUPE_SEPARATOR);
    case 'manager_message':
      return [event.type, event.managerId, event.kind, event.text].join(DEDUPE_SEPARATOR);
    case 'external':
      return [event.type, event.source, JSON.stringify(event.payload ?? null)].join(
        DEDUPE_SEPARATOR,
      );
    case 'timer':
      return [event.type, event.kind, event.target ?? '', event.cause ?? 'schedule'].join(
        DEDUPE_SEPARATOR,
      );
    case 'self_initiative':
      return [event.type, event.reason, event.cause ?? 'schedule'].join(DEDUPE_SEPARATOR);
    case 'distill':
      return [event.type, event.reason].join(DEDUPE_SEPARATOR);
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（dedupeKey）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * `Clone#post()` が受理の時点で「同一本文の未読が既に在るか」を畳んでよいかを
 * 決めるための鍵（Issue #954 続き。受信箱側）。
 *
 * ## これまでの畳み込みが塞いでいなかった穴
 *
 * PR #946（`manager.ts` の合流窓）は `turn_failed` 単独の束にしか掛からず、
 * PR #1035（{@link hasOpenManagerDuplicate}）は**台帳**が開く前の壁でしか
 * ない——`Clone#post()` の `#remember`（受信箱への書き込み）は台帳を開く
 * *前*に必ず同期で走るので、台帳側の壁は受信箱の行の増殖を1件も防げない
 * （`hasOpenManagerDuplicate` の doc「対象は台帳だけ」）。この関数は、その
 * 手前——受信箱へ書く前——に同じ形の壁をもう1枚足すためのものである。
 *
 * **実測（クローンの日誌、直近24時間）が示した比率はむしろ逆だった。** 429
 * の `manager_message` 連投より、`external` / `source: 'token-pool'`
 * （デーモン自身が「認証トークンが通る状態に戻った」と自分の受信箱へ出す
 * 知らせ）のほうが桁で多い——ある起動が名乗った「拾い直した未読 3,326 件」
 * の正体はほぼこれで、同一本文が数ミリ秒間隔（`.172Z` / `.198Z` / `.207Z`）
 * で積まれていた。⟹ この鍵が畳む対象は `manager_message` だけでは足りない。
 *
 * ## 畳めるのは2つだけ — `manager_message` と「デーモン自身の `external`」
 *
 * **それ以外は必ず `undefined` を返す。** 残り5種（`human_message` /
 * `human_answer` / `timer` / `self_initiative` / `distill`）と、
 * `external` のうち {@link isDaemonSelfNotice} が偽を返すもの（webhook
 * など外から渡された `external`）は、この関数を通しても絶対に畳まれない。
 *
 * **線を引く基準は「起点がクローン自身の外側にある、alteroid 自身が合成した
 * 知らせか」である。** 畳んでよいのは、alteroid 自身（マネージャーの合成
 * 通知・デーモン自身の `wake()`）が自分に宛てて作った知らせだけで、**外から
 * 渡されたものは畳まない**——人間の発言・人間の回答はもちろん、`external`
 * でも `POST /events` 経由で外の誰かが投げたものは対象外にする。外から来た
 * 同文の2件は「1つの出来事が2回届いた」のか「同じ形の出来事が2回起きた」の
 * かを受け手には区別する手段が無いが、alteroid 自身が合成した知らせには
 * その曖昧さが無い（起きたことそのものではなく、alteroid が「起きた」と
 * 判断して自分に書いた文だから、同じ判断が繰り返されているだけだと言える）。
 * **人間の発言・回答を畳まない判断は**、`CLONE_REMOVABLE_INBOX_EVENT_TYPES`
 * が「クローンは自分の側の都合で溜まった合図だけを畳める。人間から届いた
 * 合図は畳めない」と定めた線引き（takecchi、2026-09-15）と同じ理由に立つ。
 *
 * ## 鍵の計算は二重に書かない
 *
 * - **`manager_message`**: 畳んでよいかを決める軸は `managerId` + `kind` +
 *   `text` の3つ——{@link hasOpenManagerDuplicate} が台帳側で見ている
 *   `source`（= `managerId`）+ `body`（= `` `[${kind}] ${text}` ``）と対称な
 *   組で、{@link inboxBacklogDedupeKey} の `manager_message` 分岐が作る鍵
 *   （`event.type` を先頭に足しただけの同じ3項）とも一致する。**だから鍵
 *   そのものは {@link inboxBacklogDedupeKey} へ委譲し、ここで2本目の
 *   `switch` を書かない**——同じ「同一本文か」の判定が2箇所に分かれると、
 *   増える側（積む判定）と減る側（消す・数える判定）が食い違いうるという、
 *   `inboxBacklogDedupeKey` の doc「なぜ1箇所に閉じるか」が名指しした #783
 *   の症状の形そのものを、この関数自身が再現することになる。
 * - **`external`（`isDaemonSelfNotice` が真のときだけ）**: 軸は `source` +
 *   `payload`。{@link inboxBacklogDedupeKey} の `external` 分岐と同じ2項
 *   だが、**ここでは委譲しない**——あちらは `JSON.stringify` の失敗（循環
 *   参照など）をそのまま投げる作りで、計器（`summarizeInboxBacklog`）の
 *   純関数としてはそれでよい（呼び出し側が全部 try 済みの行しか渡さない）が、
 *   こちらは `Clone#post()` から同期で直接呼ばれる制御の鍵なので、投げると
 *   `post()` 自体が落ちる——だから直列化できない場合は「畳まない」側へ
 *   フェイルオープンする（下の実装）。
 *
 * ## この鍵の用途は「畳む・畳まない」の制御であって、計器ではない
 *
 * {@link inboxBacklogDedupeKey} は7型すべてに対して「同じ本文か」を答える
 * **計器**（`distinct` を数えるためだけの純関数で、`summarizeInboxBacklog`
 * の`## 限界`が言うとおり偏りを持つ）である。こちらは `Clone#post()` が
 * **実際に受信箱・台帳への書き込みを畳むかどうかを決める制御の鍵**であり、
 * 意味が違うので別の名前・別のエクスポートにしてある——計器と制御を同じ
 * 関数に載せると、計器側の偏り（同じ限界を参照）がそのまま制御側の挙動の
 * 揺れになる。
 *
 * ## 払っている代償は新しくない
 *
 * {@link isDaemonSelfNotice} の doc が言うとおり、`source` は自由文字列
 * なので外部の呼び手が `"token-pool"` / `"runner-registry"` を名乗れば
 * 同じ扱いになる——**この関数はその代償をそのまま引き継ぐだけで、新しい
 * 代償を作っていない**（`commitmentFor` が台帳側で既に同じ代償を払っている
 * のと同じ判断に乗っている）。
 */
export function inboxCollapseKey(event: InboxEvent): string | undefined {
  if (event.type === 'manager_message') return inboxBacklogDedupeKey(event);

  if (event.type === 'external' && isDaemonSelfNotice(event)) {
    let serializedPayload: string;
    try {
      serializedPayload = JSON.stringify(event.payload ?? null);
    } catch {
      // **直列化できない payload（循環参照など）は畳まない側へ倒す**
      // （fail-open）。畳めなければ受信箱の行は増えるが、それは直しの前と
      // 同じ状態に留まるだけで、黙って合図を落とすよりはるかに安全である。
      return undefined;
    }
    return [event.type, event.source, serializedPayload].join(DEDUPE_SEPARATOR);
  }

  return undefined;
}

/**
 * {@link inboxBacklogDedupeKey} と同じ「同じ本文か」を畳む鍵だが、
 * `manager_message` だけ `managerId` を落とす（#783 段0 追補 / issue #954）。
 *
 * ## 何のためか
 *
 * `manager.ts` の `#rateLimits` / `#usageNotices` は、同じ「畳み込み」という
 * 操作を2つの別々の鍵（枠の種類・Pool全体で1つ／`managerId` ごと）で行って
 * いる——{@link inboxBacklogDedupeKey} の doc「なぜ1箇所に閉じるか」が
 * 名指しした欠陥の実例である。**この関数はその割れそのものを直しはしない**
 * （直すのは issue #954。ここでは絶対に手を出さない）。ここでするのは、
 * 「`managerId` を跨いで畳んだらどう見えるか」を `distinct` と並べて読める
 * ようにするために、鍵をもう1つ用意するだけである。
 *
 * **⚠️ 訂正（2026-09-16、#954 の受信箱側を実装した側から）。** 直上の
 * 「直すのは issue #954」は、**#954 が `managerId` を跨いで畳む、とは読まない
 * こと。** #954 の受信箱側（{@link inboxCollapseKey}）は **`managerId` を鍵に
 * 含めて畳む＝跨がない**形で着地した。理由は2つある —— (1) 台帳側の壁
 * （`hasOpenManagerDuplicate`、PR #1035）が `source`＝`managerId` を見ており、
 * **受信箱と台帳で鍵の粗さが違うと同じ入力に対する畳み方が食い違う**。
 * (2) 跨いで畳むと「どの委譲が落ちたか」が消えるが、落ちた委譲は名指しで
 * `manager_send` して起こす対象なので、名前が消えると次の手が打てなくなる
 * （＝能力の削除。AGENTS.md の地雷表）。**実測でも跨ぐ必要は支持されなかった**
 * —— ある起動が拾い直した未読 3,326 件の内訳は大半が `external`（`token-pool`）
 * で、`manager_message` は 27 件（委譲5本ぶん）だった。跨いで得られるのは数件で、
 * 失うのは名指しである。**必要が出たら粗くするほうが後から効く**ので、細かい側
 * で入れてある。⟹ この関数が作る「跨いだ鍵」は、いまも**計器**
 * （`distinctAcrossManagers` を並べて読むためのもの）のままである。
 *
 * ## 鍵の作り方
 *
 * `manager_message` は `[type, kind, text]`（`managerId` を落とす）を
 * {@link DEDUPE_SEPARATOR} で繋ぐ。**それ以外の6型は
 * {@link inboxBacklogDedupeKey} へそのまま委譲する**——実装を複製すると、
 * 片方だけ直されて2つが食い違う経路を作ってしまう（同じ理由が
 * {@link inboxBacklogDedupeKey} の doc にもある）。
 *
 * ## 不変条件
 *
 * `manager_message` の鍵は {@link inboxBacklogDedupeKey} が返す鍵から
 * `managerId` のフィールドを1つ削っただけなので、必ず**同じか、より粗い**
 * ——これで畳んだ異なり数（`distinctAcrossManagers`）は
 * {@link inboxBacklogDedupeKey} で畳んだ異なり数（`distinct`）を超えない
 * （`summarizeInboxBacklog` / `InboxBacklogBreakdown.distinctAcrossManagers`
 * の doc）。
 *
 * **export している。** テストがこの関数を直接撃てるようにするため
 * （`inboxBacklogDedupeKey` を export している理由と同じ）。
 */
export function inboxBacklogCrossManagerDedupeKey(event: InboxEvent): string {
  if (event.type !== 'manager_message') return inboxBacklogDedupeKey(event);
  return [event.type, event.kind, event.text].join(DEDUPE_SEPARATOR);
}

/** 上位N件・同数は名前順で安定させる、共通の並べ替え。 */
function topByCount<T extends { readonly count: number }>(
  entries: readonly T[],
  nameOf: (entry: T) => string,
  limit?: number,
): T[] {
  const sorted = [...entries].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return nameOf(a).localeCompare(nameOf(b));
  });
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/**
 * 毎ターンの状況の節（`situation.ts`）が、受信箱の未処理 N 件の内訳
 * （種類だけ）を「上位 {@link INBOX_BACKLOG_LOUD_TYPE_FOLD_AT} 件 + 他 N 種
 * M 件」に畳むときの折り返し数（issue #1140）。
 *
 * ## 3 にした根拠（実測して決めたものではない）
 *
 * `InboxEvent['type']` は最大7種類（{@link INBOX_EVENT_TYPE_ORDER}）。動機に
 * なった実例（issue #1140 本文）では有意だったのは `external:token-pool`
 * （3809件）と `manager_message`（39件）の2種類だけだった——2件でも
 * その実例は覆えたが、**この計器を1件の標本だけで決めるのは危うい**（他の
 * 標本では3種目が意味を持つことがありうる）ので、1件だけ余裕を持たせて
 * 3件にした。**行の長さの実害（#1140 本文が明言する「測っていないこと」）も
 * 実測していない**ので、次にこの数を見直す人は根拠のこの薄さごと引き継ぐ
 * こと。
 */
export const INBOX_BACKLOG_LOUD_TYPE_FOLD_AT = 3;

/**
 * `InboxBacklogBreakdown.byType` を「上位 {@link INBOX_BACKLOG_LOUD_TYPE_FOLD_AT}
 * 件 + 他 N 種 M 件」に畳んだ1行にする（issue #1140）。
 *
 * ## 何を数えているか（依頼者の注文——数え方を doc に書く）
 *
 * 材料は呼び出し側が渡す `byType`（{@link summarizeInboxBacklog} が
 * `peekPending()` で読んだ行を集計したもの）そのもの——ここでは新しい観測を
 * 1つもしない。並べ替えは {@link topByCount}（件数の降順、同数は型名の昇順）
 * を使う——`bySource` の上位5件と同じ並べ替えを、型の上位 N 件にも使い回す。
 *
 * ## `total` との算術
 *
 * `byType` は0件の型を含まない（{@link InboxBacklogBreakdown} の doc）ので、
 * 上位 N 件の件数 + 畳んだ残りの件数（`他 N 種 M 件` の `M`）は、必ず渡された
 * `byType` の合計に一致する——省いた行は「畳んだ」と明示するので、算術で
 * 「見えない行があった」と読める（{@link InboxBacklogBreakdown} の doc
 * 「`bySource` はそれだけでは `total` に届かない」と同じ配慮）。
 *
 * ## 空配列
 *
 * `byType` が空なら `'（無し）'` を返す——`describeInboxBacklogBreakdown` の
 * 既存の書式（`種類: （無し）`）と揃える。
 */
export function foldInboxBacklogByType(
  byType: readonly { readonly type: InboxEvent['type']; readonly count: number }[],
  foldAt: number = INBOX_BACKLOG_LOUD_TYPE_FOLD_AT,
): string {
  if (byType.length === 0) return '（無し）';
  const sorted = topByCount(byType, (entry) => entry.type);
  const top = sorted.slice(0, foldAt);
  const rest = sorted.slice(foldAt);
  const topText = top.map((entry) => `${entry.type} ${entry.count}`).join(' / ');
  if (rest.length === 0) return topText;
  const restTotal = rest.reduce((sum, entry) => sum + entry.count, 0);
  return `${topText} / 他 ${rest.length} 種 ${restTotal} 件`;
}

/**
 * `InboxEvent['type']` の並び順（`schema.ts` の `inboxEventSchema` の判別子の並びと揃える）。
 *
 * **export している。**（issue #972）`apps/daemon/src/app.ts` の
 * `POST /inbox/remove` が「渡された `types` が全7種を覆っているか」
 * （＝絞り込みが無いのと同じ呼び）を判定するのに、この配列の**全件数**を
 * 基準にする——`commitment_close_many` が `commitmentOriginSchema.options`
 * を同じ目的で使うのと同じ形。数をここに書き写すと足したときに腐るので、
 * `.length` を直接見る側へ倒す。
 */
export const INBOX_EVENT_TYPE_ORDER = [
  'human_message',
  'human_answer',
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
] as const satisfies readonly InboxEvent['type'][];

/**
 * クローンの道具 `inbox_remove_many`（issue #972）が選べる種類。**人間起点の
 * 合図（`human_message` / `human_answer`）を構造的に除く。**
 *
 * ## 由来（オーナー判断、#972 コメント）
 *
 * #972 本文の提案4は「クローン自身の道具にするかは別途の判断（自分の受信箱を
 * 自分で捨てられることの是非があるため、まずは人間の手で足りる）」と保留して
 * いた。依頼のブリーフがこれを見落として必須スコープに書いたため一度は道具を
 * 実装したが、オーナー（クローン）が差し戻し、次の線引きを指示した:
 *
 * > クローンは、自分の側の都合で溜まった合図だけを畳める。人間から届いた
 * > 合図は畳めない。
 *
 * `human_message`（人間の発言）と `human_answer`（`ask_human` への人間の
 * 回答）だけが人間起点で、残り5種（`distill` / `timer` / `external` /
 * `self_initiative` / `manager_message`）はクローン自身・実装・外部系が
 * 積む——文脈窓を溢れさせる本体（#972 本文の実例）である `manager_message`
 * も、除かれない側に入る。
 *
 * **takecchi がこの設計（出所で線を引く）を採用した（2026-09-15）。**
 *
 * > 文脈窓を溢れさせるのは、マネージャーの報告が大量に届くときであって、
 * > 人間の発言ではありません。⟹ 自律の要件は、人間側を除いても満たせます。
 * > そして除いておけば「人間が私に届けたものを、私が黙って捨てる」経路が
 * > 構造的に消えます。
 *
 * ## なぜ実行時の if ではなく型で塞ぐか
 *
 * `commitment_close_many` の「在る起点を全部並べたら断る」は実行時の分岐
 * （`origin` の4値は本来どれも選べてよいものを、組み合わせだけ禁じるため）
 * だが、こちらは**特定の2値そのものを選べなくする**——`z.enum` の候補集合を
 * 狭めれば済む。`AGENTS.md`「踏みやすい地雷」の「確認が要る行為の一覧を作る」
 * と同じ理由で、**「弾く」ではなく「そもそも渡せない」形を優先する**——歯止めは
 * 「在っても使わずに撃たれる」ことが実際に起きている（オーナーの実例、
 * #972 コメント）。
 *
 * ## ⚠️ `satisfies Exclude<...>` が防ぐもの・防がないもの
 *
 * **防ぐ**: この配列に `human_message` / `human_answer` を**足す**こと
 * （`Exclude<...>` に含まれない値なので、足した瞬間に `typecheck` が落ちる）。
 *
 * **防がない**: `tools.ts` の呼び出し側が、この定数の代わりに
 * `INBOX_EVENT_TYPE_ORDER`（人間起点を含む全7種）を参照するよう**差し替える**
 * こと。`z.enum(X)` の `X` にどの配列を渡すかは呼び出し側の1行の選択であり、
 * 型はそれを強制できない——「この呼び出しは必ずこの定数を指せ」という制約は
 * TypeScript の型システムでは表現できない（呼び出し側の書き換えそのものが
 * 妥当な代入である以上、型検査は通す）。
 *
 * ⟹ **実際の強制力は `tools.ts` の `inbox_remove_many` が本当にこの定数を
 * 使っていることを実測する側（`inbox-remove-many.test.ts` の 2a/2b。本物の
 * MCP round-trip で `human_message`/`human_answer` が拒まれることを見る）が
 * 持つ。** 同ファイルの 2d は「差し替えたら何が起きるか」という機序を
 * 本番コードに触れずに裏付ける（この環境では、検証目的であっても
 * `tools.ts` 側をこの定数から `INBOX_EVENT_TYPE_ORDER` へ書き換える編集
 * 自体が安全側の分類器に拒否された——それ自体が「差し替えは容易ではない」
 * ことの傍証でもある）。
 */
export const CLONE_REMOVABLE_INBOX_EVENT_TYPES = [
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
] as const satisfies readonly Exclude<InboxEvent['type'], 'human_message' | 'human_answer'>[];

/**
 * 種類の配列から「1件以上」を要求する zod スキーマを組み立てる。**どの種類を
 * 許すかはここでは決めない**——渡された配列をそのまま `z.enum` へ渡すだけの
 * 薄い関数である（issue #972）。
 *
 * ## なぜ切り出したか
 *
 * 以前は `tools.ts`（`inbox_remove_many` の `types` 引数）と
 * `inbox-remove-many.test.ts`（変異試験）が、それぞれ独立に
 * `z.array(z.enum(...)).min(1)` を組み立てていた。**2つの式は字面が同じに
 * 見えても、別々の値である**——テストが検証していたのは「同じ形にコピーした
 * スキーマ」であって「道具が実際に使っているスキーマ」ではなかった。片方だけ
 * 書き換えられても、もう片方は何も気づかない。
 *
 * **ここへ1箇所へ寄せ、`tools.ts` は {@link inboxRemoveManyTypesSchema}
 * （この関数を `CLONE_REMOVABLE_INBOX_EVENT_TYPES` で呼んだ、ただ1つの
 * 値）を import して使う——どの配列を渡すかを呼び出し側で選ばせない。**
 * テスト（`inbox-remove-many.test.ts` の 2d）は
 * {@link inboxRemoveManyTypesSchema} を直接 `safeParse` するので、
 * **道具が実際に使っているスキーマそのものを検査する**。この関数自体は、
 * テストが「もし全7種類を許していたら」という対照（`INBOX_EVENT_TYPE_ORDER`
 * を渡した場合）を、同じ組み立てロジックで作るためにも export してある
 * ——比較の両側が同じ関数を通ることで、`.min(1)` のような付随条件の
 * 有無がテストの側で食い違う心配がない。
 */
export function buildInboxEventTypesSchema(allowed: readonly InboxEvent['type'][]) {
  return z.array(z.enum(allowed)).min(1);
}

/**
 * `inbox_remove_many`（`tools.ts`）が実際に使う `types` のスキーマ、まさに
 * その値。**人間起点を除いた {@link CLONE_REMOVABLE_INBOX_EVENT_TYPES} で
 * 固定してある**——`tools.ts` 側はこれを import するだけで、渡す配列を
 * 選べない。この束縛自体が {@link INBOX_EVENT_TYPE_ORDER}（人間起点を含む
 * 全7種）へ書き換えられたら、同じ値を直接検査している
 * `inbox-remove-many.test.ts` の 2d が赤くなる（{@link buildInboxEventTypesSchema}
 * の doc）。
 */
export const inboxRemoveManyTypesSchema = buildInboxEventTypesSchema(
  CLONE_REMOVABLE_INBOX_EVENT_TYPES,
);

/**
 * `POST /inbox/remove`（issue #972。`apps/daemon/src/app.ts`）が受け取る絞り込み。
 *
 * **種類は必須で空にできない。** `commitment_close_many` の `origin` と同じ
 * 理由——「絞り込みを何も渡さない」呼びを型で作れなくする。`types` が
 * {@link INBOX_EVENT_TYPE_ORDER} の全件を覆う呼びは、呼び出し側（いまは
 * `app.ts` のハンドラだけ）で「絞り込みが無いのと同じ」として断る（ここでは
 * 断らない——このファイルは純粋な述語だけを持ち、拒否のような対話的な判断は
 * 呼び出し側に置く）。
 *
 * `sources` / `before` は任意で、渡せばさらに絞る（AND）。
 */
export interface InboxRemoveManyFilter {
  readonly types: readonly InboxEvent['type'][];
  /**
   * {@link inboxBacklogSourceFor} が返す表記（`external:<source>` /
   * `manager:<managerId>`）の完全一致。渡さなければ送信元では絞らない。
   *
   * **送信元を言えない型（`inboxBacklogSourceFor` が `undefined` を返す5型）
   * は、`sources` を渡すと必ず対象から外れる**——「送信元不明」を「一致した」
   * 側へ含めると、絞り込んだはずの一括削除が申告より広い範囲を消す（黙って
   * 広がる方向の誤りは、狭くなる方向の誤りより高くつく）。
   */
  readonly sources?: readonly string[];
  /**
   * この時刻**以前**（`at <= before`）に積まれた行だけを対象にする
   * （ISO8601）。`commitment_close_many` の `until` と同じ意味・同じ向き
   * ——「古いものを畳む」という #972 の主目的にまっすぐ合わせてある。
   */
  readonly before?: string;
}

/**
 * `row` が `filter` に当たるかを判定する（issue #972）。
 *
 * **このリポジトリで、この判定をするのはここ1箇所だけである。** SQL 側
 * （`storage-pg` / `storage-fs`）に同じ判定を複製しないこと——理由は
 * {@link inboxBacklogDedupeKey} の doc「なぜ1箇所に閉じるか」と同じで、
 * 増える側（`summarizeInboxBacklog` が見せる内訳）と消す側（この述語）が
 * 別々の判定を持つと、クローンが一覧で見た件数と実際に消える件数が
 * 食い違いうる。`inboxBacklogSourceFor` を両方から呼ぶことで、それを防ぐ。
 *
 * 純関数（I/O をしない）。呼び出し側（`tools.ts`）が `peekPending()` の
 * 結果へ `Array.prototype.filter` で当てる。
 */
export function matchesInboxRemoveManyFilter(
  row: PendingInboxEvent,
  filter: InboxRemoveManyFilter,
): boolean {
  if (!filter.types.includes(row.event.type)) return false;
  if (filter.sources !== undefined) {
    const source = inboxBacklogSourceFor(row.event);
    if (source === undefined || !filter.sources.includes(source)) return false;
  }
  if (filter.before !== undefined && Date.parse(row.at) > Date.parse(filter.before)) return false;
  return true;
}

/**
 * 消した合図の配達を止められる主体（`CloneHost` / `Clone` がこれを満たす）。
 *
 * **`CloneHost` 型そのものを受けない。** ここが要るのは1つのメソッドだけで、
 * 面全体を要求すると `inbox-backlog.ts`（いまは純関数と述語だけのファイル）が
 * `host.ts` に依存し始める。テストからも1メソッドの偽物で足りる。
 */
export interface InboxDeliveryStopper {
  dropQueuedInboxEvents(ids: readonly string[]): Promise<number>;
}

/**
 * **器から消して、同じ合図の配達も止める**（issue #1049）。
 * `inbox_remove_many`（`tools.ts`）と `POST /inbox/remove`
 * （`apps/daemon/src/app.ts`）が消し込みに使う**唯一の口**である。
 *
 * ## なぜ関数1本に寄せてあるのか —— #1049 は「2箇所のうち片方」の事故だった
 *
 * 消す口は初めから2つあり（クローンの道具と人間の HTTP）、**どちらも
 * `stores.inbox.removeMany()` を直に呼んでいた。** 器の行しか消えないので、
 * 既にクローンのメモリ上の待ち行列へ載った合図はそのまま配られ続けた。
 *
 * ⟹ **配達を止める呼びを「消す側の作法」として足すと、2箇所のうち1箇所を
 * 直し忘れた瞬間に同じ穴が戻る。** しかも戻ったことは赤くならない（消えた行は
 * 消えているので、カウンタも応答も正しく見える）。**だから作法ではなく関数に
 * する** —— 器から消す操作とメモリから落とす操作が、1つの呼びから分けられない。
 *
 * **歯が在る**（`inbox-backlog.test.ts` の「`removeMany` を直に呼ぶ本番コードは
 * この関数の中だけである」）。新しい消し込みの経路がこの関数を通さずに書かれたら
 * そこで落ちる。
 *
 * ## ⚠️ 順序は「器から消す」→「配達を止める」である。逆にしないこと
 *
 * 逆にすると、**配達を止めた直後に器の削除が失敗した**回に、その合図は
 * **配られもせず器にも残らない**（メモリ側からは落ちており、器の行は残るが、
 * 次の起動の `#restoreUnread` まで誰も触らない）——いちばん避けたい「静かな
 * 喪失」である。この順なら、削除が成功して配達停止が失敗した回の倒れ先は
 * 「消えた行が1回配られる」＝**雑音**であって喪失ではない。
 * **`docs/` と AGENTS.md が置いている「消えるより配り直す」の向きに揃えてある。**
 *
 * ## 渡すのは「実際に消えた id」だけである
 *
 * `removeMany` が返さなかった id（既に他の経路で消えていた分）へは配達停止を
 * 掛けない。**器に行が残っているものの配達を止めてはいけない** —— 止めた分は
 * どこからも配られないのに未読として残り、`#restoreUnread` が次の起動で拾う
 * までのあいだ、**誰も処理しない仕事**になる。
 *
 * @returns `removedIds` は器から実際に消えた id。`droppedFromDelivery` は
 *   そのうち配達待ち（待ち行列＋枠で保持していた分）からも落とせた件数。
 *   **前者より小さいのが普通である** —— 器に在っても、まだメモリの待ち行列へ
 *   載っていない合図（`#restoreUnread` がこれから拾う分）が在るので。
 */
export async function removeInboxEventsAndStopDelivery(
  inbox: { removeMany(ids: readonly string[]): Promise<string[]> },
  delivery: InboxDeliveryStopper,
  ids: readonly string[],
): Promise<{ removedIds: string[]; droppedFromDelivery: number }> {
  const removedIds = await inbox.removeMany(ids);
  if (removedIds.length === 0) return { removedIds, droppedFromDelivery: 0 };
  const droppedFromDelivery = await delivery.dropQueuedInboxEvents(removedIds);
  return { removedIds, droppedFromDelivery };
}

/**
 * `peekPending()` が返した行から内訳を作る（純関数。I/O をしない）。
 *
 * @param now 齢バケツの基準時刻（epoch ミリ秒）。呼び出し側が渡す
 *   （`Date.now()` を直接呼ばないことでテストから固定できる）。
 */
export function summarizeInboxBacklog(
  rows: readonly PendingInboxEvent[],
  now: number,
): InboxBacklogBreakdown {
  const total = rows.length;

  const oldestAt = rows.reduce<string | undefined>(
    (min, row) => (min === undefined || row.at < min ? row.at : min),
    undefined,
  );

  const byTypeCounts = new Map<InboxEvent['type'], number>();
  const bySourceCounts = new Map<string, number>();
  const dedupeKeys = new Set<string>();
  const crossManagerDedupeKeys = new Set<string>();
  const ageBucketCounts = new Map<string, number>();
  const undeliveredByTypeCounts = new Map<InboxEvent['type'], number>();
  let undelivered = 0;
  let deliveredOnce = 0;
  let redelivered = 0;
  let maxDeliveries = 0;
  // `source`/`managerId` を言えない型（`inboxBacklogSourceFor` が `undefined`
  // を返す5型）の行数。`bySource` の算術（`InboxBacklogBreakdown` の doc）を
  // 成り立たせる3つの数のうちの1つ。
  let bySourceUnknownCount = 0;
  // 人間起点（`human_message` / `human_answer`）の集計（Issue #917 (B)）。
  // `InboxBacklogBreakdown.humanOriginated` の doc のとおり `deliveries` では
  // 絞らない——`undelivered` だけを別に持つ。
  const humanOriginatedByTypeCounts = new Map<'human_message' | 'human_answer', number>();
  let humanOriginatedTotal = 0;
  let humanOriginatedUndelivered = 0;
  let humanOriginatedOldestAt: string | undefined;

  for (const row of rows) {
    byTypeCounts.set(row.event.type, (byTypeCounts.get(row.event.type) ?? 0) + 1);

    const source = inboxBacklogSourceFor(row.event);
    if (source !== undefined) bySourceCounts.set(source, (bySourceCounts.get(source) ?? 0) + 1);
    else bySourceUnknownCount += 1;

    dedupeKeys.add(inboxBacklogDedupeKey(row.event));
    crossManagerDedupeKeys.add(inboxBacklogCrossManagerDedupeKey(row.event));

    if (row.deliveries === 0) {
      undelivered += 1;
      undeliveredByTypeCounts.set(
        row.event.type,
        (undeliveredByTypeCounts.get(row.event.type) ?? 0) + 1,
      );
    } else if (row.deliveries === 1) deliveredOnce += 1;
    else redelivered += 1;
    if (row.deliveries > maxDeliveries) maxDeliveries = row.deliveries;

    const ageMs = now - new Date(row.at).getTime();
    const bucket = ageBucketLabel(ageMs);
    ageBucketCounts.set(bucket, (ageBucketCounts.get(bucket) ?? 0) + 1);

    if (isHumanOriginated(row.event)) {
      humanOriginatedTotal += 1;
      // `isHumanOriginated` が真を返すのは `human_message` / `human_answer` の
      // 2型だけ（同じファイルの `isHumanOriginated` の doc）——絞り込み済みなので
      // ここでの narrowing は安全である。
      const humanType = row.event.type as 'human_message' | 'human_answer';
      humanOriginatedByTypeCounts.set(
        humanType,
        (humanOriginatedByTypeCounts.get(humanType) ?? 0) + 1,
      );
      if (humanOriginatedOldestAt === undefined || row.at < humanOriginatedOldestAt) {
        humanOriginatedOldestAt = row.at;
      }
      if (row.deliveries === 0) humanOriginatedUndelivered += 1;
    }
  }

  const byType = INBOX_EVENT_TYPE_ORDER.filter((type) => (byTypeCounts.get(type) ?? 0) > 0).map(
    (type) => ({ type, count: byTypeCounts.get(type) ?? 0 }),
  );

  // 上限5件そのものは変えない——ただし打ち切った分を可視化するため、まず
  // 全件を並べ、上位5件と溢れた残りに分ける（`topByCount` の limit 無し呼び
  // 出しと `slice` は同じ並びを共有するので、2回に分けても順序はずれない）。
  const bySourceSorted = topByCount(
    [...bySourceCounts.entries()].map(([source, count]) => ({ source, count })),
    (entry) => entry.source,
  );
  const bySource = bySourceSorted.slice(0, 5);
  const bySourceOverflow = bySourceSorted.slice(5);
  const bySourceOverflowKinds = bySourceOverflow.length;
  const bySourceOverflowCount = bySourceOverflow.reduce((sum, entry) => sum + entry.count, 0);

  const undeliveredByType = INBOX_EVENT_TYPE_ORDER.filter(
    (type) => (undeliveredByTypeCounts.get(type) ?? 0) > 0,
  ).map((type) => ({ type, count: undeliveredByTypeCounts.get(type) ?? 0 }));

  const ageBuckets = AGE_BUCKET_LABELS.filter((label) => (ageBucketCounts.get(label) ?? 0) > 0).map(
    (label) => ({ label, count: ageBucketCounts.get(label) ?? 0 }),
  );

  // `INBOX_EVENT_TYPE_ORDER` の並び（human_message が human_answer より先）を
  // そのまま使う。件数0の型は載せない——`total` と合わせると足して一致する
  // （`InboxBacklogBreakdown.humanOriginated` の doc）。
  const humanOriginatedByType = INBOX_EVENT_TYPE_ORDER.filter(
    (type): type is 'human_message' | 'human_answer' =>
      type === 'human_message' || type === 'human_answer',
  )
    .filter((type) => (humanOriginatedByTypeCounts.get(type) ?? 0) > 0)
    .map((type) => ({ type, count: humanOriginatedByTypeCounts.get(type) ?? 0 }));

  return {
    total,
    ...(oldestAt === undefined ? {} : { oldestAt }),
    byType,
    bySource,
    bySourceOverflowKinds,
    bySourceOverflowCount,
    bySourceUnknownCount,
    distinct: dedupeKeys.size,
    distinctAcrossManagers: crossManagerDedupeKeys.size,
    undelivered,
    deliveredOnce,
    redelivered,
    maxDeliveries,
    undeliveredByType,
    ageBuckets,
    // **齢の基準点を落とさずに持たせる**（#910 追補。{@link InboxBacklogBreakdown.observedAt}）。
    observedAt: new Date(now).toISOString(),
    // Issue #917 (B)。{@link InboxBacklogBreakdown.humanOriginated} の doc。
    humanOriginated: {
      total: humanOriginatedTotal,
      byType: humanOriginatedByType,
      ...(humanOriginatedOldestAt === undefined ? {} : { oldestAt: humanOriginatedOldestAt }),
      undelivered: humanOriginatedUndelivered,
    },
  };
}

/**
 * 内訳を文へ描く。**`manager_list` の一覧本文へそのまま足す前提**——本文は
 * 1文字も載せない（合図の `text` / `payload` は集計値の中でしか使わない。
 * `AGENTS.md` の地雷「エージェントへ返す一覧に本文を全文で載せる」に触れない）。
 *
 * **必ず `total` を出す。** `byType` / `ageBuckets` は0件を省くが、残りを
 * 足せば `total` に一致するので「省かれた行は0だった」と算術で読める
 * （{@link InboxBacklogBreakdown} の doc、`situation.ts` の `lost` と同じ理由）。
 *
 * **`bySource` はそれだけでは `total` に届かない**——だから溢れた種類数・
 * 件数（`bySourceOverflowKinds` / `bySourceOverflowCount`）と、`source` を
 * 言えない型の行数（`bySourceUnknownCount`）を**0件でも必ず**送信元の行に
 * 添える。0のときに省くと「省いた＝0だった」という他の軸と同じ形に見えて
 * しまい、実際には打ち切られている可能性（測っていない）と区別できなくなる
 * ため（{@link InboxBacklogBreakdown} の doc の「⚠️ #818 の欠陥と直し方」）。
 *
 * **0回の桶は種類別の内訳も出す**（`undeliveredByType`）——「いまの器になって
 * から積まれた分に人間の依頼（`human_message`）が混ざっているか」を、種類と
 * 器の入れ替え回数の2つの一覧を突き合わせずに直接言えるようにするため
 * （#783 段0 追補）。**この行が、実際にいちばん行動へ効く**——クローンは
 * `manager_message 25`（受け取っていない報告が25本）をここから読む
 * （実測 2026-09-12）。
 *
 * ## ⚠️ #910: 出力の軸名は「配達回数」ではない。**改名であって、断り書きではない**
 *
 * この関数の doc は #818 の時点で既に「`claimPending()` の doc が言う『配達回数は
 * 器が入れ替わった回数であって処理が落ちた回数ではない』を踏まえ」と書いていたが、
 * **出力には1文字も刷っていなかった。読み手が違う** —— この doc を読むのは
 * このコードを触る実装者で、`配達回数: 2回以上 4249` を読むのはクローンである。
 * クローンは `manager_list` の戻り値しか見えないので、doc へ置いた断り書きは届かない
 * （実測 2026-09-12: クローンがこの2行から「4253 件は実質 30 種類の増殖」「配達しても
 * 消えず、また配達されている」という2つの誤った結論を立て、その筋で委譲を1本出した。
 * #910。同じ誤読は #700 でも起きており、そのときは断り書きを `store.ts` 側へ足した
 * ——**実装者が読む場所へ置いて、4日後に破られた**）。
 *
 * **⟹ ここで採ったのは改名である。** `AGENTS.md`（逐語:
 * `grep -Fn -- '添えるのではなく分ける' AGENTS.md`）が「**列の分かれ目は読む順に
 * 関係なく効くが、断り書きは読み手がそこを通ったときにしか効かない**」と書いている
 * とおりで、断り書きは読み飛ばされうるが、名前は数字を読む前に必ず通る。
 *
 * **2つの数で扱いが違う。その違いには理由がある:**
 *
 * - **`undelivered` / `deliveredOnce` / `redelivered` / `maxDeliveries` は改名した**
 *   （`配達回数` → `器の入れ替え回数`）。**この計器では、この数は例外なく
 *   「器が入れ替わった回数」だからである。** `claimPending()` は残っている未読の
 *   全行を一緒に進め（`InboxStore.claimPending` の doc）、`peekPending()` が返すのは
 *   その全行である ⟹ ここに「この合図の処理が落ちた回数」と読んでよい行は1つも無い。
 *   **名前が無条件に間違っているなら、直すのは名前である。**
 * - **`distinct` は改名せず、断り書きを足した。** 名前（`同一本文…を畳むと N 件`）は
 *   計算しているものを正確に言っている ⟹ 誤読は名前ではなく**そこから引く推論**
 *   （「同じ本文＝同じ出来事の増殖」「畳めば減る」）の側で起きる。**名前の直しは
 *   間違った名前を直せるだけで、正しい名前が招く推論は止められない。**
 *
 * **`clone.ts` の `#redeliveryNoticeFor` を改名しないのは、この線の裏側である。**
 * あちらは1件ごとの断り書きで、`#restoredCohort <= 1`（同じ起動で一緒に拾い直した
 * のがその1件だけ）のときは回数がその合図について語れる ⟹ 名前が**条件付きで
 * 正しい**ので、#700 / #708 が採った「名前は保って修飾を足す」が正しい。ここは
 * その条件が起きえない側である。
 *
 * ## ⚠️ #910 追補: **`未配達` も同じ理由で名前が間違っていた**（実測 2026-09-12、3回目）
 *
 * 上の改名を最初に入れたとき、0の桶だけは `0回（＝未配達）` と旧い語を残した
 * ——「`deliveries === 0` なら一度も配っていないのは本当だろう」と考えたからである。
 * **現物を読むと違った。**
 *
 * - `post()` は受理した瞬間に `put()` する（`clone.ts` の `#remember`）ので、
 *   **いまの器で積まれた行の `deliveries` は必ず 0 である。** 同時に
 *   `#inbox.push` で待ち行列にも載っている ⟹ **0 は「届いていない」ではなく
 *   「いまの器になってから積まれ、まだ片付いていない（＝いま流れている最中）」**
 *   である。処理中のその1件も 0 で数えられる
 * - 逆に **`2回以上` は「配られた」を意味しない。** `#restoreUnread` の門
 *   （`CloneOptions.redeliveryGate`。#843 / #883）が畳んだ行は
 *   **`#inbox.push` されない＝ターンが1度も起きない**まま、受信箱にも残り、
 *   起動のたびに回数だけ増える（逐語は
 *   `grep -Fn -- '**`#inbox.push` をしない ＝ ターンを起こさない。**' packages/core/src/clone.ts`）
 *
 * **実測 2026-09-12（クローン自身の観測）**: 未読 4283 件の内訳を読んだクローンが
 * 「`2回以上 4249` ＝ 既に配達済み＝自分が読んだ上で処理していないだけ」「`未配達 30`
 * ＝ 届いていない＝異常」と読み、**両方とも逆だった。** そしてこのとき
 * `齢: 1時間未満 21 / 1〜6時間 9` の和がちょうど 30 で、**0 の桶は「いまの器の
 * 起動より後に積まれた行」と完全に一致していた。**
 *
 * ⟹ **`未配達` を出力から外し、0 の桶は「いまの器になってから積まれた」と名乗る。**
 * `2回以上` の側は名前では塞げない（`器の入れ替え回数` は正しく数えている——
 * 誤りは「⟹ だから配られたはずだ」という*推論*の側にある）ので、`distinct` と
 * 同じ扱い、すなわち**断り書き**にした。
 *
 * **欄の名前（`undelivered` / `undeliveredByType`）はそのままにしてある。**
 * 直すのは出力の語であって、内部の識別子ではない——実装者はこの doc を読む経路を
 * 持っており（#910 が言う「読み手が違う」の裏側）、識別子まで一緒に変えると
 * 差分が本題から離れる。**この doc がその対応表である。**
 *
 * ## ⚠️ #910 追補2: `齢` は但し書きではなく**基準点**が欠けていた
 *
 * `齢: 1時間未満 21 / …` は `now` からの**相対値**なのに、その `now` を1文字も
 * 刷っていなかった。**読んだその場では困らない**（「いま」が基準だと分かる）が、
 * **この内訳を別の場所へ写した瞬間に基準点が消える。**
 *
 * **実測 2026-09-12（クローン自身の誤り）**: クローンが `resets 6:40am
 * (Asia/Tokyo)` という**時間帯つきの正しい表示**を持っていながら、別の場所から
 * 取った時間帯なしの数字（vitest の `Start at 03:52:01`）を基準にして
 * 「窓はもう明けた」と結論した。実際には9時間ずれていた。⟹ **但し書きの無い数字の
 * 害は、その数字自身が誤読されることだけではない——他の正しい計器を誤読させる
 * 基準にもなる。**
 *
 * **⟹ ここで足したのは断り書きではない。** {@link InboxBacklogBreakdown.observedAt}
 * は齢を数えるために既に受け取っている `now` そのもので、**新しい観測は1つも
 * していない。** 落としていた演算子を落とさなくしただけである。
 *
 * **他の軸には足していない。** `総数` / `種類` / `齢の桶の名前` / `最も古いものは
 * <ISO8601 Z> から` は、どれも基準点を要しない（絶対値か、名前が境界を字面で
 * 言っているか、全行が必ずどれかへ入って足すと `total` になるか）。**全部に足すのが
 * 正解ではない**——足すべきなのは「それ無しでは読めない数」だけである。
 *
 * **`distinct` の断り書きは1行に畳んである。** 偏りの向きは2つあり
 * （区切りの衝突で小さく出る／本文へ畳んだ件数を焼き込む合図で大きく出る。
 * {@link inboxBacklogDedupeKey} の doc の「限界」）、**片方だけ書くと新しい誤読を
 * 作る。** 2つの機構を出力へ書き下すと120字を超えて数字が埋まるので、出力には
 * 向きに中立な事実（「上下どちらへもぶれる」）と**機構が書いてある場所の名前**を
 * 載せ、機構そのものは doc に置く —— クローンが doc へ辿る経路を、出力の側から
 * 作るためである。
 *
 * ## `distinctAcrossManagers`（#783 段0 追補 / issue #954）は差が無ければ1文字も足さない
 *
 * `distinct` と `distinctAcrossManagers`（{@link InboxBacklogBreakdown} の doc）
 * が同じ値なら、`manager_message` に複数の `managerId` がそもそも混ざって
 * いないか、混ざっていても本文が揃っていないかのどちらかで、読み手に新しく
 * 言えることが無い——「0を出す軸と、値を作らない軸」（`InboxBacklogBreakdown`
 * の doc）と同じ作法で、**同値のときは行を増やさない。**
 *
 * **差が出たときだけ**、`同一本文` の行へ添えて足す——独立の行を新設すると、
 * 2つの数がどちらも「同一本文を畳んだら何件か」を数えたものであることが
 * 読み手に伝わりにくくなるため、同じ行に並べて置く。**「畳める」「捨てられる」
 * とは名乗らない。** `distinctAcrossManagers` を数えること自体は `managerId`
 * を無視して数え直しただけで、実際に畳んでよいかは別の判断だからである
 * （{@link InboxBacklogBreakdown.distinctAcrossManagers} の doc「これが
 * 言えないこと」）。
 */
/**
 * 人間起点（`human_message` / `human_answer`）の滞留だけを、**単独の行**として
 * 描く（Issue #917 (B)）。
 *
 * ## なぜ在るのか —— #917 が名指しした症状
 *
 * オーナーがクローンへ出した指示が47分間まるごと配達されなかった。クローンが
 * それに気づいたのは、`manager_list` の内訳の**7行目**に出ていた
 * `human_message 1`（`undeliveredByType` の1行）を自分で拾ったからだった。
 * 同じ日の午後、クローンは同じ計器を読んで**この行を読み飛ばした**——そのとき
 * 目に入ったのは `⚠ クローンの受信箱に未処理の合図が 4301 件ある` だった。
 *
 * > 大きい数字と、行動を要する数字が、同じ字の大きさで並んでいる。大きい
 * > ほうが先に来て、目立つ。
 *
 * **この関数は対策（配達の挙動）を1ミリも変えない。行動を要る数字（人間起点の
 * 滞留）だけを、大きい数字より先・単独の行として取り出す計器である。**
 *
 * ## 呼び出し側の並び（必ず守ること）
 *
 * `tools.ts` の `describeInboxBacklog` は、この行を**内訳より前**——
 * `⚠ クローンの受信箱に未処理の合図が N 件ある` の行より**前**に出す。この
 * 関数自身は並び順を強制しない（「前に置く」のは呼び出し側1行の責務）ので、
 * 並びは `tools.ts` 側の歯（`manager_list` を呼ぶテスト）で固定する。
 *
 * ## 名乗ってよいことの線（このファイルの既存 doc と同じ規律）
 *
 * - **`oldestAt` は `Clone#post()` が受理した時刻であって、人間が実際に書いた
 *   時刻ではない**（`store.ts` の `PendingInboxEvent.at` の doc「`post` が
 *   受理した時刻」）。⟹ 「書かれてから N 分」のような経過時間は計算しない
 *   ——絶対時刻（ISO 8601）と、それが何の時刻かだけを言う
 * - **「配達されていない」とは断定しない。** ここが見ているのは**ストアに
 *   残っている行**であって、メモリ上の待ち行列ではない（#1049 / PR #1052 の
 *   `inbox_flow` の doc）。言えるのは「片付いていない」（受信箱にまだ残って
 *   いる）までである
 *
 * ## 0件なら1文字も返さない
 *
 * `InboxBacklogBreakdown` の「0を出す軸と、値を作らない軸」と同じ作法——
 * ただしこちらは**行そのもの**を作らない（空文字列を返す）。呼び出し側
 * （`tools.ts`）は空文字列を出力へ混ぜない。
 */
export function describeHumanOriginatedInboxAlert(b: InboxBacklogBreakdown): string {
  const h = b.humanOriginated;
  if (h.total === 0) return '';

  const byTypeText = h.byType.map((e) => `${e.type} ${e.count}`).join(' / ');
  const oldestText =
    h.oldestAt === undefined
      ? ''
      : `最も古いものは ${h.oldestAt} に受理された` +
        '（Clone#post が受理した時刻——人間が書いた時刻ではない。PendingInboxEvent.at の doc）。';

  return (
    `⚠ 人間起点（human_message / human_answer）の滞留が ${h.total} 件ある（${byTypeText}）。` +
    `${oldestText}` +
    `そのうち、いまの器になってから積まれ、まだ片付いていない分が ${h.undelivered} 件` +
    '（ストアに残っている行を見ているだけで、配達されていないとは言えない）。'
  );
}

/**
 * 受信箱の**メモリの配達待ち行列**の1行（issue #1084 / #1133）。
 *
 * ## 2つの呼び出し口が、同じ計算・同じ文言を通る（issue #1133）
 *
 * **かつてこの関数は `situation.ts` の中に private な
 * `describeSituationInboxQueued` として在り、`tools.ts` の
 * `describeInboxBacklog`（`manager_list` の末尾に必ず出る、受信箱の滞留を
 * 読むもう1つの口）はメモリの待ち行列を1文字も知らなかった。** ⟹ 同じ
 * クローンが、同じターンの中で、「受信箱の滞留」という同じ言葉に対して
 * 2つの違う定義を読むことになっていた——器の行が0件なら `manager_list` は
 * 「クローンの受信箱に未処理の合図は無い。」と言い切るが、メモリの待ち
 * 行列に数千件残っていてもそれは1文字も反映しない（issue #1133 本文）。
 *
 * **⟹ この関数をここ1箇所へ寄せ、`situation.ts` の `describeSituation` と
 * `tools.ts` の `describeInboxBacklog` の両方がこれを呼ぶ。** 計算・文言の
 * 生成元が1つになったので、2つの呼び出し口が食い違えようがない
 * （どちらかだけを直して忘れる、という形そのものが構造的に作れない）。
 *
 * `situation.ts` の `describeSituationInboxBacklog`、`tools.ts` の
 * `describeInboxBacklog` の**どちらも器の行数の1行とは別の軸**として、この
 * 関数が返す行を隣に置く——{@link describeSituationInboxBacklog}
 * （`situation.ts`）の doc「メモリの配達待ち行列は別の軸である」を先に
 * 読むこと。
 *
 * ## 何を数えるか
 *
 * 呼び出し側（`clone.ts` の `#queuedInMemoryCount`。`#situationNoticeFor` と
 * `#toolContext()` の両方がこれ経由で渡す——issue #1133 が「件数の出どころは
 * 1つにする」と求めた形）が渡す値は、**`Clone#inbox`（配達を待つ FIFO。
 * `inbox.ts` の `Inbox#size`）と `#deferred`（枠＝利用上限で保持している分）
 * を足したもの**である。**両方が「配達待ち」に数える理由**: `#deferred` に
 * 居る合図は枠が開けば `Clone#inbox` の先頭へ戻され（`clone.ts` の `#pump` の
 * 解除ブロック、`Inbox#unshift`）、その時点でまた配達される——まだ処理し
 * 終えていない、という点で `Clone#inbox` の中身と変わらない（`clone.ts` の
 * `dropQueuedInboxEvents` が消すときにこの2つを両方とも落としているのと
 * 同じ理由——`grep -Fn -- '枠（利用上限）で保持している分' packages/core/src/clone.ts`）。
 *
 * ## 何を数えていないか（⚠️ ここが要点——数えていないと、この行を読む側が
 * 「これで全部」と誤読する）
 *
 * 1. **いま処理中のこの1件（このターンの `batch` そのもの）。** `Clone#inbox`
 *    からは `#pump` が `next()` / `drainWhile()` で既に取り出した後なので、
 *    構造上ここには入らない——DB 側の軸のように `events.length` を引く補正は
 *    要らない（引く前の値が既に「これを除いた残り」になっている）。
 * 2. **`Clone#inbox` が待ち手へ直接渡した分。** `Inbox#push` は待ち手（`next()`
 *    で待っている `#pump`）が居ればその場で渡し、`#queue` を素通りする
 *    （`inbox.ts` の `push` の doc「待ち手が居るときは順序の話にならない」）。
 *    この経路を通った合図は1度も `#queue` に載らないので、`size` はそれを
 *    最初から知らない——ただしこれは「これから処理される1件」であって
 *    「取り残された合図」ではない（上の1と同じ理由で、そもそも数える対象では
 *    ない）。
 * 3. **もう配り終えて `#handle` の中を実行中の合図が、その実行の途中で新しい
 *    合図（サブ依頼・ツール呼び出し）を作ることがあっても、それは
 *    `InboxEvent` として `Clone#inbox` を経由しない**（別の経路——委譲・
 *    ツール呼び出し——であって受信箱の合図ではない）ので、この軸の対象にすら
 *    ならない。
 * 4. **`tools.ts` から呼ばれた回に限り、`context.queuedInMemory` を渡さない
 *    呼び出し側（テスト等）が居れば `undefined` になる。** 本番の配線
 *    （`clone.ts` の `#toolContext()`）は必ず渡す——`runtime` / `scheduler`
 *    と同じ「省略はテストのためだけ」という作法（`ToolContext` の doc）。
 *
 * **⟹ 言えるのは「配達を待って、いまメモリに載っている分」までである。**
 * 「クローンにこれから起きる仕事の総量」ではない——走っているターン自身の分
 * （1・2）は、走っている以上どのみち仕事として数える必要が無い。
 *
 * ## `undefined` は「省略」——0 と見分けが付く必要は無い
 *
 * DB の軸と違って、この値は非同期の読み取りを経ない（`Inbox#size` /
 * `#deferred.length` はどちらも同期の getter / 配列長で、失敗しうる操作を
 * 経由しない）。⟹ 「読もうとして読めなかった」という状態がそもそも無い
 * ——`'unreadable'` に対応する型を持たないのはこのためであり、**手抜きでは
 * ない**。`undefined` が意味するのは「呼び出し側が渡さないと決めた」（既存の
 * 呼び出しを壊さないための省略。`tokens` / `backlog` と同じ作法）だけである。
 *
 * ## 0 のときは行を出さない
 *
 * 上の理由（読めない状態が無い）により、`0` は常に「数え切れて0件だった」を
 * 意味する——DB の軸で問題になった「0 が『数えられなかった』を覆い隠す」は
 * ここでは構造的に起きない。⟹ 0 を隠しても情報は失われないので、DB の軸と
 * 同じ「0 なら行を出さない」を採ってよい。
 *
 * ## ⚠️ 2つの軸は**重なる**——「別の軸」を「互いに素」と読ませないこと
 *
 * **通常は、同じ合図が両方に数えられている。** `clone.ts` の `#remember`
 * （`post()` の中）は型を問わず全部の合図を配達より前に器へ書き、消す
 * `#forget` はターンが終わってからしか呼ばれない —— 出典は
 * `grep -Fn -- '消す `#forget()` はこの後' packages/core/src/clone.ts` が当たる
 * `#situationNoticeFor` の doc である。⟹ **メモリの待ち行列に居る合図は、
 * ふつう器にも行を持っている。**
 *
 * **⛔ だから足しても引いても意味が無い。** この行が「別の実体」とだけ名乗る
 * と、読む側は互いに素な2つの箱だと読み、**合計を取って負荷を倍に見積もる**
 * （あるいは差を取って「どちらかが漏れている」と読む）。**2つは同じものを
 * 別の数え方で見た値で、意味を持つのは食い違ったときだけである**——器が空で
 * メモリに残っていれば、それが issue #1049 の形そのものである。
 *
 * **⟹ 行の文言に「足し引きしないこと」と「食い違いが何を意味するか」を
 * 書く。** 添えるのではなく行の中に置く（`AGENTS.md`「報告の形」——断り書き
 * は読み手がそこを通ったときにしか効かない）。
 */
export function describeInboxBacklogQueuedInMemory(queued: number | undefined): string | null {
  if (queued === undefined || queued === 0) return null;
  // **器の行数と合算しない、足し算もしない。** 独立した1行として並べる——
  // 上の doc「2つの軸は重なる」。
  return (
    `メモリの配達待ち行列 ${queued} 件` +
    '（配達を待ってプロセスのメモリに載っている分。器の行数（上）とは' +
    '**同じ合図を別の数え方で見た値**で、ふつう両方に数えられている——' +
    '**足しても引いても意味が無い。**食い違ったときだけ、器と配達がずれて' +
    'いる印である。内訳を割る口は無い）。'
  );
}

export function describeInboxBacklogBreakdown(b: InboxBacklogBreakdown): string {
  const byTypeText =
    b.byType.length === 0 ? '（無し）' : b.byType.map((e) => `${e.type} ${e.count}`).join(' / ');
  const bySourceText =
    b.bySource.length === 0
      ? '（source/managerId を持つ型は無い）'
      : b.bySource.map((e) => `${e.source} ${e.count}`).join(' / ');
  const undeliveredByTypeText =
    b.undeliveredByType.length === 0
      ? '（無し）'
      : b.undeliveredByType.map((e) => `${e.type} ${e.count}`).join(' / ');
  const ageBucketsText =
    b.ageBuckets.length === 0
      ? '（無し）'
      : b.ageBuckets.map((e) => `${e.label} ${e.count}`).join(' / ');
  // `distinct` と同じ値のときは1文字も足さない（describeInboxBacklogBreakdown
  // の doc「distinctAcrossManagers は差が無ければ1文字も足さない」）。
  const crossManagerText =
    b.distinctAcrossManagers === b.distinct
      ? ''
      : ` ／ 同じ本文がマネージャーを跨いで ${b.distinctAcrossManagers} 件（managerId を無視して数え直した参考値。inboxBacklogCrossManagerDedupeKey の doc）`;

  return [
    `内訳（計 ${b.total} 件）:`,
    `種類: ${byTypeText}`,
    `送信元（上位5件。source/managerIdを持つ型のみ。溢れ ${b.bySourceOverflowKinds} 種 ${b.bySourceOverflowCount} 件 / source を言えない型 ${b.bySourceUnknownCount} 件）: ${bySourceText}`,
    `同一本文（id/at を除いた中身）を畳むと ${b.distinct} 件 ⚠ 本文が同じでも別々に起きた出来事である。この数は上下どちらへもぶれる（向きと理由は inboxBacklogDedupeKey の doc）${crossManagerText}`,
    `器の入れ替え回数: 0回＝いまの器になってから積まれた ${b.undelivered} / 1回 ${b.deliveredOnce} / 2回以上 ${b.redelivered}（最大 ${b.maxDeliveries}）⚠ 配られた回数ではない — 門が畳んだ行はターンが1度も起きないまま数だけ増える`,
    `いまの器になってから積まれた分（0回）の内訳（種類別）: ${undeliveredByTypeText}`,
    `齢（観測 ${b.observedAt} 時点。齢は相対値なので、この行を写すときは基準点も一緒に写すこと）: ${ageBucketsText}`,
  ].join('\n');
}
