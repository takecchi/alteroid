import type { InboxEvent, JobStatus } from './schema.js';

/**
 * **「その合図がまだ有効か」を答える述語**（Issue #879）。
 *
 * ## なぜ在るのか
 *
 * 配達のたびに走る判定は既に2本在るが、どちらも**別の問い**に答えている。
 *
 * - `reportSettlement`（`clone.ts`）＝ **「私が対処したか」**。その報告自身の
 *   台帳の行だけを引き、`commitment_close` で閉じたかを見る
 * - `countSupersedingReports`（`superseded.ts`、#771）＝ **「同じ委譲から、
 *   より新しい報告が来ているか」**
 *
 * ⟹ **どちらも「その合図が名乗った前提が、まだ生きているか」は見ていない。**
 * それが #879 の題（逐語「**『その合図がまだ有効か』を見る述語が無い**」）である。
 *
 * ## 何を突き合わせるか
 *
 * `manager_message` は **`statusAtDelivery`**（#870）を持つ——器へ積まれた
 * 当時に台帳が名乗っていた `JobStatus` である。⟹ **それと「いまの状態」を
 * 突き合わせれば、その報告が届いた時点の前提が動いたかが言える。**
 *
 * ⚠️ **この突き合わせが成り立つのは、`statusAtDelivery` が配り直しで更新
 * されないからである。** `#restoreUnread`（器の入れ替えを跨いだ配り直し）は
 * `manager.ts` を通らず、積まれた当時の値がそのまま残る。**この性質は
 * `schema.ts` の `statusAtDelivery` の doc に「⛔ ここを新しい値に直さない
 * こと」として書いてあり、`inbox-persistence.test.ts` の歯が見張っている。**
 *
 * ## ⭐ 揺れる値を引数に取ることについて（#783 段1 との違い）
 *
 * `restoredInboxEventVerdict`（`inbox-staleness.ts`）は **`usageBlocked` を
 * 受け取らない**——あちらが決めるのは**消し込み**で、同じ合図が評価の
 * タイミングで消えたり残ったりしてはいけないからである。
 *
 * **こちらは逆に「いまの状態」を受け取る。** 決めるのが**添える言葉**だけ
 * だからで、⛔ **この述語の戻り値で行を消してはいけない。**（消すなら
 * `inbox-staleness.ts` の側で、合図の性質だけで決めること。）
 *
 * ## 「言えなかった」を「同じだった」に畳まない
 *
 * 倒れ先を4つに割ってある（`superseded.ts` の `uncountable` と同じ作法）。
 * **`unclaimed`（名乗っていない）と `unknowable`（いまの状態が引けなかった）
 * を `unchanged` に混ぜない**——混ぜた瞬間、「変わっていない」と「確かめ
 * られなかった」が読む側から同じ顔になる。
 */
export type InboxEventValidity =
  /** 名乗った状態と、いまの状態が同じ。 */
  | { readonly kind: 'unchanged'; readonly status: JobStatus }
  /** 名乗った状態から動いている。⟹ 届いた時点の前提が生きていない。 */
  | { readonly kind: 'changed'; readonly claimed: JobStatus; readonly now: JobStatus }
  /** その合図は状態を名乗っていない（`statusAtDelivery` が無い／持てない型）。 */
  | { readonly kind: 'unclaimed' }
  /** 名乗ってはいるが、いまの状態を引けなかった。 */
  | { readonly kind: 'unknowable'; readonly claimed: JobStatus; readonly detail: string };

/**
 * {@link InboxEventValidity} の核——`InboxEvent` を経由せず、素の値
 * （`claimed` / `now`）だけで呼べる（Issue #1036）。
 *
 * ## なぜ切り出したか
 *
 * `inboxEventValidity` は左辺を `event.statusAtDelivery` に固定しているので、
 * `InboxEvent` を持たない呼び出し元（`Job.lastReportStatus` を突き合わせたい
 * `manager-activity.ts` の `describeReportDrift`）から呼べない。**判定の
 * ロジック（`claimed` と `now` を4値に振り分ける）そのものは `InboxEvent` に
 * 何も依存していない**——依存しているのは `inboxEventValidity` 側の
 * 「`claimed` をどこから取るか」（`event.statusAtDelivery`）だけである。
 *
 * **判定のコピーを2つ作らない。** `inboxEventValidity` はこの核を呼ぶだけの
 * 薄い層にし、`describeReportDrift` も同じ核を呼ぶ——4値への振り分け方を
 * 2箇所に書かない。
 *
 * `now` は呼び手が引いた「いまの状態」。**引けなかったときは `undefined`
 * ではなく `detail` を渡すこと**——`undefined` だと「引けなかった」と
 * 「そんな委譲は無い」が同じ顔になる。
 */
export function statusValidity(
  claimed: JobStatus | undefined,
  now: { readonly status: JobStatus } | { readonly detail: string },
): InboxEventValidity {
  // **名乗っていない回は、そこで止める。** 既定値を作ってはいけない
  // （`schema.ts` の `statusAtDelivery` / `lastReportStatus` の doc「取れない
  // 軸に 0 の行を作る」と同じ約束）。
  if (claimed === undefined) return { kind: 'unclaimed' };
  if ('detail' in now) return { kind: 'unknowable', claimed, detail: now.detail };
  return now.status === claimed
    ? { kind: 'unchanged', status: claimed }
    : { kind: 'changed', claimed, now: now.status };
}

/**
 * {@link InboxEventValidity} を型ごとに答える純関数。
 *
 * **網羅性を型で強制する。** `switch (event.type)` で書き、`default` の
 * 倒れ先で `never` を受ける——新しい合図の型が足されたら `typecheck` が
 * 落ちる（`inboxBacklogDedupeKey` / `restoredInboxEventVerdict` と同じ作法）。
 *
 * **出力は {@link statusValidity} を切り出す前と1バイトも変えていない。**
 * `manager_message` の枝は「`claimed`（＝`event.statusAtDelivery`）を取り出して
 * 核へ渡す」だけの薄い層になった——`claimed === undefined` の早期リターンも
 * 含めて判定は核の内側で行うので、ここで二重に書かない。
 */
export function inboxEventValidity(
  event: InboxEvent,
  now: { readonly status: JobStatus } | { readonly detail: string },
): InboxEventValidity {
  switch (event.type) {
    case 'manager_message':
      return statusValidity(event.statusAtDelivery, now);
    // **他の6型は状態を名乗らない。** `statusAtDelivery` は
    // `manager_message` にしか無い（`schema.ts` の `inboxEventSchema`）。
    case 'human_message':
    case 'human_answer':
    case 'external':
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return { kind: 'unclaimed' };
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（validity）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 断り書きの文言。**`unclaimed` は空文字**——言うことが無い回に1行足すと、
 * 毎ターンの床が伸びるだけである。
 *
 * ⛔ **判定も助言もしない。**「こうしろ」はクローンが決めることで、ここが
 * 言えるのは**測った事実**だけである（`describeSuperseded` と同じ向き）。
 *
 * **`subject` は主語（「いつ・どこで名乗ったか」）だけを差し替える（Issue
 * #1036）。** 既定値 `'受信箱へ積まれた'` は元の呼び出し元（`clone.ts` の
 * `#validityNoticeFor`）が引く形と1バイトも変えていない——省略すれば以前と
 * 同じ文言になる。`manager-activity.ts` の `describeReportDrift` は
 * `'台帳へ書かれた'` を渡す——**主語だけが違い、それ以外の言い回し
 * （「この断り書きを組んだ時点では」等）は共有する**。文言の生成元を
 * 2つに割らないための唯一の場所である。
 */
export function describeValidity(
  validity: InboxEventValidity,
  managerId: string,
  subject: string = '受信箱へ積まれた',
): string {
  switch (validity.kind) {
    case 'changed':
      return (
        `⚠️ この報告が${subject}時点で ${managerId} は \`${validity.claimed}\` でしたが、` +
        `この断り書きを組んだ時点では \`${validity.now}\` です（報告が名乗った前提は動いています。` +
        `中身が要らなくなったとは限りません）。`
      );
    case 'unknowable':
      return (
        `⚠️ この報告が${subject}時点で ${managerId} は \`${validity.claimed}\` でしたが、` +
        `この断り書きを組む時点の状態を引けませんでした（${validity.detail}）。` +
        `**「変わっていない」ではなく「確かめられなかった」です。**`
      );
    case 'unchanged':
    case 'unclaimed':
      return '';
    default: {
      const exhaustive: never = validity;
      throw new Error(`未知の validity: ${JSON.stringify(exhaustive)}`);
    }
  }
}
