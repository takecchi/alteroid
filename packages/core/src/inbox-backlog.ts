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
 */
function inboxBacklogSourceFor(event: InboxEvent): string | undefined {
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

/** `InboxEvent['type']` の並び順（`schema.ts` の `inboxEventSchema` の判別子の並びと揃える）。 */
const INBOX_EVENT_TYPE_ORDER: readonly InboxEvent['type'][] = [
  'human_message',
  'human_answer',
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
];

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

  for (const row of rows) {
    byTypeCounts.set(row.event.type, (byTypeCounts.get(row.event.type) ?? 0) + 1);

    const source = inboxBacklogSourceFor(row.event);
    if (source !== undefined) bySourceCounts.set(source, (bySourceCounts.get(source) ?? 0) + 1);
    else bySourceUnknownCount += 1;

    dedupeKeys.add(inboxBacklogDedupeKey(row.event));

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

  return {
    total,
    ...(oldestAt === undefined ? {} : { oldestAt }),
    byType,
    bySource,
    bySourceOverflowKinds,
    bySourceOverflowCount,
    bySourceUnknownCount,
    distinct: dedupeKeys.size,
    undelivered,
    deliveredOnce,
    redelivered,
    maxDeliveries,
    undeliveredByType,
    ageBuckets,
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
 * **`distinct` の断り書きは1行に畳んである。** 偏りの向きは2つあり
 * （区切りの衝突で小さく出る／本文へ畳んだ件数を焼き込む合図で大きく出る。
 * {@link inboxBacklogDedupeKey} の doc の「限界」）、**片方だけ書くと新しい誤読を
 * 作る。** 2つの機構を出力へ書き下すと120字を超えて数字が埋まるので、出力には
 * 向きに中立な事実（「上下どちらへもぶれる」）と**機構が書いてある場所の名前**を
 * 載せ、機構そのものは doc に置く —— クローンが doc へ辿る経路を、出力の側から
 * 作るためである。
 */
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

  return [
    `内訳（計 ${b.total} 件）:`,
    `種類: ${byTypeText}`,
    `送信元（上位5件。source/managerIdを持つ型のみ。溢れ ${b.bySourceOverflowKinds} 種 ${b.bySourceOverflowCount} 件 / source を言えない型 ${b.bySourceUnknownCount} 件）: ${bySourceText}`,
    `同一本文（id/at を除いた中身）を畳むと ${b.distinct} 件 ⚠ 本文が同じでも別々に起きた出来事である。この数は上下どちらへもぶれる（向きと理由は inboxBacklogDedupeKey の doc）`,
    `器の入れ替え回数: 0回＝いまの器になってから積まれた ${b.undelivered} / 1回 ${b.deliveredOnce} / 2回以上 ${b.redelivered}（最大 ${b.maxDeliveries}）⚠ 配られた回数ではない — 門が畳んだ行はターンが1度も起きないまま数だけ増える`,
    `いまの器になってから積まれた分（0回）の内訳（種類別）: ${undeliveredByTypeText}`,
    `齢: ${ageBucketsText}`,
  ].join('\n');
}
