import { excerptLine } from './excerpt.js';
// **型だけを取る**（`import type` は実行時に消えるので、`manager.ts` との間に
// 実行時の循環を作らない）。字面の生成元をここに置く理由は
// `describeSessionMissingKind` の doc に在る。
import type { ManagerAwaitingBackground, SessionMissingKind } from './manager.js';
import { describeScheduleSpec } from './schedule.js';
import type { JobStatus, JournalEntry, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { formatUsd, isCloneActor, summarizeUsage, usageDate } from './usage.js';

/**
 * ある期間に何が起きたかの要約（日報と発意 tick の材料）。
 *
 * 日誌・ジョブ台帳・承認待ちキューはすべてデーモン側にあり、クローンは
 * `journal_read` などの道具で覗ける。それでも要約をこちらで組んで渡すのは、
 * 「1日を締める」「次の一手を決める」ときに**まず全体が見えている**状態から
 * 始めさせたいからである。細部が要るならクローンが自分で掘る。
 *
 * ここに「何をすべきか」は書かない。材料だけを渡し、判断はクローンに残す。
 */

export interface DigestWindow {
  /** この時刻以降（含む）。 */
  since: Date;
  /**
   * この時刻より前（含まない）。省略時は「いまこの瞬間まで（含む）」。
   *
   * 上端を含まないのは日の境界のためである（`00:00:00.000` の記録が前日と当日の
   * 両方に出ないように）。省略時だけは 1ms 足して、たったいま書かれた記録が
   * 落ちないようにする。
   */
  until?: Date;
}

/**
 * 各節に並べる件数の上限。細部はクローンが自分の道具で掘れる。
 *
 * **切ったなら必ず `omitted()` を通すこと**（下の doc を読むこと）。export して
 * あるのはテストが期待件数を計算するためで、`index.ts` からは出していない。
 */
export const MAX_ITEMS = 15;

/**
 * マネージャーの id から「このデーモンから話しかけられるか」への写像。
 *
 * `ManagerPool` が実行時に `isLive()` で決める値（`manager.ts`）であって、
 * ジョブ台帳の軸ではない。だから `buildActivityDigest` は自分では持てず、
 * 呼び出し側（`clone.ts`）に渡してもらう。
 */
export type ManagerLiveness = ReadonlyMap<string, boolean>;

/**
 * マネージャーの id から「背景処理の完了待ちで畳んだ報告を握り潰しているか」への
 * 写像（`ManagerLiveness` と同じ理由で持つ）。
 *
 * **ジョブ台帳の軸ではない。** 材料は `ManagerPool` のプロセス内の在庫
 * （`#withheldReports`）なので、`buildActivityDigest` は自分では取れず、
 * 呼び出し側（`clone.ts`）に渡してもらう。**`ManagerLiveness` と別の Map に
 * してあるのは、片方だけ取れた回を潰さないためである**——1つの Map に畳むと、
 * `live` は取れたが握り潰しは無かった委譲と、そもそも何も取れなかった委譲が
 * 同じ「載っていない」になる。
 */
export type ManagerAwaitingBackgroundMap = ReadonlyMap<string, ManagerAwaitingBackground>;

/**
 * マネージャー1本の状態を、`manager_list`（`tools.ts`）と**同じ字面**で言う。
 *
 * **`describeManagerState` を通す側と通さない側で字面が割れると、「走行中」と
 * 「走行中だがセッションが切れている」が要約の側で潰れる。** 実際にクローンが
 * これで誤り、終わった仕事へ3本目の委譲を出した（この関数を作る直接の理由）。
 * `manager_list` 側（`tools.ts`）もこの関数を通すことで、生成を1箇所に閉じる。
 *
 * `live` を必須にせず3値で受けるのは、`buildActivityDigest` が `liveness` を
 * 省略できることの裏返しである（そちらの doc を参照）。**`undefined` を
 * `true` に倒さない。** 理由は `manager.ts` の `summaryOf` の doc が逐語で
 * 持っている——`grep -Fn -- '省略した側が黙って「繋がっている」と名乗る' packages/core/src/manager.ts`。
 * あちらは「引数を必須にして呼ぶ側に必ず書かせる」ことで省略そのものを防いだが、
 * ここでは呼ぶ側（`liveness?.get(job.id)`）が構造的に `undefined` を返しうる
 * ので、必須にする代わりに**否定でも肯定でもない第三の値**（`/セッション不明`）
 * を既定にして、同じ轍（省略が黙って「繋がっている」と名乗ること）を避ける。
 *
 * ## 第3引数（`awaitingBackground`）— 「手が空いた」と「背景処理を待っている」を潰さない
 *
 * `status: 'done'` は2つの状態を同じ字面へ潰していた。**手が空いた**（次の指示を
 * 待っている）と、**自分が起こした背景処理・作業者の完了を待って畳んだだけ**である。
 * runner は最初から区別して報告しており（`runner-protocol.ts` の
 * `report.awaitingBackground`。作業者への委譲も `local_agent` として数に入る）、
 * デーモンもそれを受け取って在庫（`manager.ts` の `#withheldReports`）に持って
 * いるが、`job.status` へは写らない——`case 'report'` が
 * `record.job.status = event.status;` を `awaitingBackground` の分岐**より前**に
 * 実行するので、`status` は必ず `'done'` へ潰れる。**潰れたぶんを字面の側で戻す。**
 *
 * **`undefined` ＝「そうではない」ではなく「そう名乗られていない」である。**
 * この欄が立つのは runner が `awaitingBackground` を送ってきた回だけで、その欄を
 * まだ送らない古い runner では、実際に背景処理を待っていても立たない（`report.
 * awaitingBackground` の `.optional()` の doc——ずれはどちらの向きでも「配る」側へ
 * 倒れる）。**だから `undefined` に「背景処理は無い」と言わせない**——この関数は
 * 何も書き足さないだけである（`live` の `undefined` を `true` へ倒さないのと同じ
 * 向きの判断で、**言っていないことを言わせない**）。
 *
 * **`live` の字面の後ろに足す。** 2つは別の軸で、同時に立つ（話しかけられない
 * まま背景処理を待っていることがある）——`done/セッション切断/背景処理待ち×3` の
 * ように両方が並ぶ形にしてあり、片方がもう片方を隠さない。
 */
export function describeManagerState(
  status: JobStatus,
  live: boolean | undefined,
  awaitingBackground?: { tasks: number },
): string {
  const base = describeLiveState(status, live);
  // **背景タスクの在り高だけを足す。** `breakdown`（`local_agent×3` のような内訳）はここへ
  // 載せない——一覧の1行に出る字面で、件数に比例して伸びるものを載せると、
  // 溜まっているときほど一覧が重くなる（`listing-and-detail` の性質1）。
  // 内訳が要るなら `manager_report` / 日誌（`type: 'decision'` の `grounds`）に
  // 全文が在る。
  return awaitingBackground === undefined
    ? base
    : `${base}/背景処理待ち×${awaitingBackground.tasks}`;
}

/** `describeManagerState` の `live` の部分だけ（3値の分岐は1文字も変えていない）。 */
function describeLiveState(status: JobStatus, live: boolean | undefined): string {
  if (live === true) return status;
  if (live === false) return `${status}/セッション切断`;
  return `${status}/セッション不明`;
}

/**
 * 「runner にセッションが無い」の**由来**を一言で言う（#579。
 * `ManagerSummary.sessionMissingKind`）。
 *
 * **`describeManagerState` と同じ理由でここに置く——生成元を1つにする。** この
 * 一言は `manager_list`（`tools.ts`）と CLI（`apps/cli`）の両方が出す。字面が
 * 割れると、**同じ状態が面によって違う次の一手を指すことになる。**
 * （Web UI は同じ文言を自前で書いている。直すときは
 * `grep -Fn -- 'resume はまだ試していない' apps/web/app/routes/managers.tsx` も
 * 一緒に見ること。）
 *
 * **短くしてある。** ここが出るのは一覧の中で、読み手が毎ターン通る場所である
 * ——伸ばすと他の行が読まれなくなる。
 *
 * **`undefined` は空文字にする（「不明」と書かない）。** 由来を持たない印は、
 * この欄が足される前の版のデーモンが立てたものだけである。そこへ新しい語を
 * 出すと、**実際には2つしかない区別が3つに見える。**
 */
export function describeSessionMissingKind(kind: SessionMissingKind | undefined): string {
  if (kind === 'resume-failed') return 'resume でも入り直せなかった。';
  if (kind === 'unlisted') return '名簿に載っていなかった。resume はまだ試していない。';
  return '';
}

/**
 * `escalation` の journal 行を `approvalId` で束ねた、1つの問い（クローンが
 * 何を聞いて何を答えてもらえたか）。
 *
 * **日誌は追記専用である。** `ask_human`（`tools.ts`）が積むのは未回答の行1本
 * で、人間が答えると `answerApproval`（`clone.ts`）が**別の新しい行**を
 * `answeredAt` / `answer` 付きで積む（マネージャー発の確認も同型 —
 * `manager.ts` の `case 'ask'` が質問の行、回答経路が `answeredAt` 付きの行を
 * 別々に積む）。**同じ `approvalId` を持つ2行が、同じ期間の中に両方入る
 * ことがある。** それを束ねずに1行ずつ描くと、同じ問いが「未回答」と
 * 「回答あり」の両方として並ぶ（この関数を作った直接の理由）。
 *
 * ここでは**束ねるだけ**で、状態は決めない。状態は `describeEscalationState`
 * が、この束ねた材料と承認待ちキュー（権威ある出所）を突き合わせて決める。
 */
interface EscalationGroup {
  approvalId: string;
  question: string;
  /** マネージャー発の確認ならその manager_id（`escalation` 行のどれかが持つ）。 */
  managerId: string | undefined;
  /**
   * グループの中で最も新しい行の `at`。表示順の基準として実際に使う
   * （`buildActivityDigest` が束ねた直後にこれで降順ソートする）。
   *
   * **`managers`（同じファイル内）の並べ替えとは事情が違う——`jobs.listJobs()`
   * には順序の契約が無い（`store.ts` の `JobStore` の doc を見ること）が、
   * `escalation` の材料である `journal.list()` には既定 `order: 'desc'`＝
   * 新しい順を3実装（fs / pg / memory）すべてで保証する契約がある
   * （`journal-order-with-contract.ts` の逐語:
   * `grep -Fn -- '既存の挙動を1文字も変えない' packages/core/src/journal-order-with-contract.ts`）。
   * ⟹ この契約が守られている限り、`groupEscalations` の Map 挿入順は
   * すでに `at` 降順になっている（束ねる前の並びが新しい順なら、各
   * `approvalId` を最初に見た時点の行がそのグループの最新行になるため）ので、
   * ここでの並べ替えは**通常は no-op である**。
   *
   * **それでも明示的に並べ替える理由は、この契約への暗黙の依存をこのファイル
   * の外へ置かないため。** `journal.list()` 側の契約が将来変わる・呼び出し側
   * （`buildActivityDigest`）が `order` を指定するようになる・束ねる前に
   * 別の絞り込みを挟む、といった変更が起きても、この節の表示順の正しさは
   * `digest.ts` を読むだけで分かる形にしておく。**この安全側の並べ替えは、
   * 現実の `journal.list()` を使う限りテストでは検出できない**（削除しても
   * 通常の歯は赤くならない——実際に1文字消して確かめた。`digest.test.ts`
   * の「束ねた後は at の新しい順に並ぶ」は、契約を守らない `journal.list`
   * へ差し替えることでこの並べ替えだけを切り出して測っている）。
   */
  at: string;
  /**
   * この期間の日誌行の中に回答済みの行があれば、その回答。
   *
   * 同じグループに複数の回答済み行が入ることは通常無い（1回の回答で1行しか
   * 積まれない）が、在ったとしても「いちばん新しい `at` を持つ行」を採る
   * ——古い行が新しい行を上書きして answer が後退することを防ぐ。
   */
  answeredInWindow: { answer: string; at: string } | undefined;
}

/**
 * `escalation` 行を `approvalId` で束ねる。**並べ替えはしない**——呼び出し側
 * （`buildActivityDigest`）が `at` で降順に並べ直す（`EscalationGroup.at` の
 * doc）。
 *
 * **行の処理順に依存しない。** `journal.list` の既定は新しい順だが、この
 * 関数は「そのグループに答えの行が1本でもあるか」を、`at` を比べて決める
 * ので、新しい順に来ようが古い順に来ようが同じグループが組み上がる
 * （呼び出し側の並びを前提にしない）。
 */
function groupEscalations(
  entries: readonly Extract<JournalEntry, { type: 'escalation' }>[],
): EscalationGroup[] {
  const byId = new Map<string, EscalationGroup>();
  for (const entry of entries) {
    const existing = byId.get(entry.approvalId);
    let answeredInWindow = existing?.answeredInWindow;
    if (
      entry.answer !== undefined &&
      (answeredInWindow === undefined || entry.at > answeredInWindow.at)
    ) {
      answeredInWindow = { answer: entry.answer, at: entry.at };
    }
    byId.set(entry.approvalId, {
      approvalId: entry.approvalId,
      question: existing?.question ?? entry.question,
      managerId: existing?.managerId ?? entry.managerId,
      at: existing === undefined || entry.at > existing.at ? entry.at : existing.at,
      answeredInWindow,
    });
  }
  return [...byId.values()];
}

/**
 * この行の `approvalId` がどの id 空間のものかを言う。**`describeEscalationState`
 * と違い、承認待ちキューを引かない**（store 呼び出しゼロ）。
 *
 * `ask_human`（`tools.ts`）が積む escalation 行は `approvalId: approval.id`
 * ——承認待ちキュー（`PendingApproval.id`）そのもの——を持ち、`managerId` は
 * 一度も書かない（`grep -Fn -- "approvalId: approval.id" packages/core/src/tools.ts`
 * の周辺を見ること）。**`manager.ts` の `case 'ask'` が積む行だけが
 * `managerId` を持ち**、その `approvalId` は承認待ちキューの id ではなく
 * runner の `requestId` である（`schema.ts` の `escalation.approvalId` の
 * doc）。⟹ `managerId` の有無だけで、この2つの id 空間を journal だけから
 * 区別できる——`getApproval` で実在を確かめなくても、**その id を
 * `approvals_list id=<id>` へ渡してよい id なのか、`manager_send` の
 * `requestId` として使う id なのか**は決まる。ここを取り違えると、
 * 読み手が別の id 空間へ同じ意味で問い合わせて空振りする。
 */
function escalationIdLabel(group: EscalationGroup): string {
  if (group.managerId !== undefined) {
    return `requestId: ${group.approvalId}（マネージャー ${group.managerId} 発。承認待ちキューの id ではない）`;
  }
  return `id: ${group.approvalId}`;
}

/**
 * 束ねた1問の「いま」を人間の次の一手が変わる形で言う。
 *
 * **日誌の行だけでは決めない。** この期間の日誌に答えの行が無いとき、それは
 * 「本当にまだ答えていない」と「答えは付いたが、その行がこの期間の外に
 * 出た（この digest の窓の外で回答された）」の2通りがあり、日誌だけでは
 * 区別できない。**権威ある出所は承認待ちキューである** — `ask_human` が積む
 * `PendingApproval` は `answerApproval` が同じ id に対して `answeredAt` /
 * `answer` を上書きする（`putApproval` は id で置き換える。`store.ts` の
 * `JobStore`）。
 *
 * **ただし承認待ちキューを引く回数は、呼び出し側（`buildActivityDigest`）が
 * 表示する分（`MAX_ITEMS` 件まで）に絞る。** キューの行を消す口が無い
 * （`JobStore` は `listApprovals` / `getApproval` / `putApproval` だけ）ので、
 * 運用のあいだ単調に増える表。全件を毎回引くと、聞いた質問が積み上がるほど
 * digest 1回のコストが増えてしまう。だから：
 *
 * 1. まず `pendingById`（`listApprovals({ pendingOnly: true })` の結果。
 *    直す前の digest と同じ、未回答分だけの**有界な**取得——呼び出し側で
 *    1回だけ引き、`describeEscalationState` へは既に取れた Map として渡す）
 *    を無料で見る。見つかれば「未回答でキューに在る」まで店を叩かずに言える。
 * 2. そこに無ければ、**この1件だけ** `getApproval` を呼ぶ。呼ばれるのは
 *    `shownEscalations`（`MAX_ITEMS` 件まで）についてだけなので、呼び出し
 *    回数はそこで頭打ちになる。
 *
 * **マネージャー発の確認（`approvalId` が `requestId`）はキューに無いのが
 * 正常である。** `manager.ts` の `case 'ask'` は承認待ちキューへは積まない
 * （`putApproval` を呼ばない）——待つのはマネージャー側の `record.waiting`
 * であって、人間からはキューを経由せず `manager_send` で直接答えが返る
 * こともある（クローンが `ask_human` へ転送すれば、そのときは**別の**
 * `approvalId`＝キュー側の id で新しいグループができる）。だから「キューに
 * 見つからない」ことは、この形では欠落ではない。
 *
 * **キューにも無く、`managerId` も無い状態は、黙ってどちらかへ倒さない。**
 * 通常の経路では起こらない（`ask_human` は必ず `putApproval` してから
 * `journal.append` する）が、台帳の破損・移行前の古い行など、想定していない
 * 経路まで無いとは言えない。「判定できない」という第3の状態として出す
 * （AGENTS.md「静かに失敗する道具」「判定できないという3つ目の状態を持つ」）。
 */
async function describeEscalationState(
  stores: Stores,
  group: EscalationGroup,
  pendingById: ReadonlyMap<string, PendingApproval>,
): Promise<string> {
  if (group.answeredInWindow !== undefined) {
    return `回答: ${brief(group.answeredInWindow.answer, 80)}`;
  }
  if (pendingById.has(group.approvalId)) {
    // 次の一手: 待つ／催促する。id は下の「人間の回答待ち」節と同じなので
    // 突き合わせられる。
    return '未回答（承認待ちキューに在る。下の「人間の回答待ち」に同じ id で出ている）';
  }
  // ここから先だけ、この1件について承認待ちキューを直接引く。`pendingById`
  // は未回答分しか持たないので、「本当に無い」のか「答えが付いて
  // pendingOnly の窓から外れた」のかは、これを呼ばないと分からない。
  const approval = await stores.jobs.getApproval(group.approvalId);
  if (approval !== null) {
    // 次の一手: この digest では見えない答えを読みに行く（`approvals_list`
    // id=<approvalId> か、この期間より後の journal_read）。「2」（未回答で
    // キューに在る）とは次の一手が違うので、同じ文言にしない。
    const answerText =
      approval.answer === undefined
        ? '（回答の本文が無い記録——answeredAt はあるが answer が欠けている。台帳の破損の可能性がある）'
        : brief(approval.answer, 80);
    return (
      `この期間の日誌には未回答の行しか無いが、承認待ちキューでは既に回答済み` +
      `（この期間の外で回答された）: ${answerText}`
    );
  }
  if (group.managerId !== undefined) {
    // 次の一手: マネージャー ${managerId} 側の状態（manager_list / manager_report）
    // を見る。キューに無いのはこの形では正常。
    return `未回答（マネージャー ${group.managerId} 発の確認。承認待ちキューには載らない設計——欠落ではない）`;
  }
  return '判定できない（承認待ちキューに見つからず、マネージャー発でもない）';
}

/**
 * 上限で切ったことと、残りの件数と、続きの取り方を出す。
 *
 * **切ること自体は要件である** — 件数に比例して伸びる材料は MCP の出力上限を
 * 超えるとクローンに1文字も届かない。壊れるのは**切ったことが出力から消える**
 * 場合であって、そのときクローンの手元に残るのは「これで全部だ」と読める一覧に
 * なる。続きを掘るという判断そのものが起きなくなるので、件数が増えるほど静かに
 * 材料が減る。
 *
 * **節ごとに手で書いていたのをここへ寄せた。** 後から足した6節（マネージャー・
 * 決定・エスカレーション・回答待ち・記憶の更新・外部イベント）が黙って切れて
 * いたのは、この行が各節の実装の側にあって、書き忘れても何も落ちなかったから
 * である。節ごとに違うのは「続きをどう取るか」だけなので、それだけを渡す。
 *
 * **`where` に「全部見える」と書けるのは、その道具が打ち切らないときだけである。**
 * `approvals_list` はそう。`journal_read` / `manager_list` / `commitment_list` /
 * `usage_read` は予算や件数で打ち切るので、そう書けば嘘になる（`usage_read` に
 * ついて先に踏んだ轍である。下の `usageSection` のコメント参照）。
 *
 * **`total` からではなく「実際に出した件数（`shown`）」から引く。** 理由は
 * 下の `usageOmitted` の doc（「省いた件数は `MAX_ITEMS` ではなく…」の段）と
 * 同じである——呼ぶ側の `.slice(0, MAX_ITEMS)` の件数がこの定数から離れた日に、
 * 出した数と合図の数が食い違う（合図そのものは在るので、読んだ側からは
 * 気づけない）。呼ぶ側は切った配列の長さをそのまま渡すこと。
 */
function omitted(total: number, shown: number, where: string): string[] {
  if (total <= shown) return [];
  return [`- …ほか ${total - shown} 件（${where}）`];
}

/**
 * 日誌から作った節の続きの取り方。
 *
 * **`since` だけでは続きに届かない。** ここに出ているのは新しい側の一部で、
 * `journal_read` も新しい順に返すので、手前の最新分が `limit` を食い尽くして
 * 狙った時刻には決して届かない。だから `until` まで書く（`journal_read` の
 * 説明文が言っているのと同じことを、切った現場でもう一度言う）。
 */
function journalWhere(type: JournalEntry['type']): string {
  return (
    `新しい側だけ出している。続きは \`journal_read\` に types=["${type}"] と until を渡して掘る` +
    '（あちらも予算で打ち切り、残りの件数が本文に出る）'
  );
}

/**
 * `usageSection` の4軸（モデル・層・場所・委譲）を `top()` で切ったときの合図。
 *
 * **4軸ともここを通すこと。「3軸に if を3つ足す」形にしない。** 上の `omitted()`
 * の doc が逐語で記録している轍——「節ごとに手で書いていたのをここへ寄せた。
 * 後から足した6節が黙って切れていたのは、この行が各節の実装の側にあって、
 * 書き忘れても何も落ちなかったから」——を、軸の側でも踏むことになる。合図を
 * 作る場所を1つに閉じておけば、軸を足す人はこの関数を呼ぶだけで済み、書き
 * 忘れる余地が無い。
 *
 * **到達可能性は軸で違うが、それを理由にここを通す/通さないを分けない。**
 * `model`（`ALTEROID_*_MODEL` は値を検証しない `z.string()`）と `manager`
 * （委譲ごとに `randomUUID()`）は `MAX_ITEMS` を超えうる。`layer` / `site`
 * （`usage-format.ts` の `USAGE_LAYERS` / `USAGE_SITES`）はいまは2値の閉じた
 * enum なので超ええない。**それでも4軸ともここを通すのは、値が増えた日に
 * ここだけ書き忘れないためである。**
 *
 * 文言は `usage_read`（`tools.ts` の `USAGE_AXES`）の `axis` 引数と同じ名前を
 * 使う——続きを辿る呼び方を渡す以上、そこで通る名前でなければ嘘になる。
 *
 * **省いた件数は `MAX_ITEMS` ではなく「実際に出した件数」から引く。** 定数から
 * 引くと、`top()` が切る件数がこの定数から離れた日に、出した数と合図の数が
 * 食い違う——**合図そのものは在るので、出力は黙って嘘になる**（合図が無いのと
 * 違って、読んだ側からは食い違いに気づけない）。切った側が出した数を渡す形に
 * しておけば、その食い違いが起きようがない。
 */
function usageOmitted(total: number, shown: number, axis: string, unit: string): string {
  if (total <= shown) return '';
  return (
    `…ほか ${total - shown} ${unit}` +
    `（\`usage_read\` に axis="${axis}", offset=0 を渡すと続きから辿れる）`
  );
}

/**
 * @param liveness マネージャーの id から「話しかけられるか」への写像
 * （`ManagerLiveness` の doc）。**必須にしない。** 省略時は
 * `describeManagerState` が全件 `undefined` を受け取り、全件
 * `/セッション不明` になる——**黙って「繋がっている」と名乗ることが
 * 起こり得ない**ので、省略は静かに嘘をつかず、出力に「取れていない」と
 * そのまま出る（`describeManagerState` の doc と同じ理由）。
 * @param awaitingBackground マネージャーの id から「背景処理の完了待ちで畳んだ
 * 報告を握り潰しているか」への写像（`ManagerAwaitingBackgroundMap` の doc）。
 * **`liveness` と同じ理由で必須にしない。** 省略時は
 * `describeManagerState` が全件 `undefined` を受け取り、**何も書き足さない**
 * ——それは「背景処理を待っていない」という主張ではなく「そう名乗られていない」
 * である（`ManagerAwaitingBackground` の doc）。⟹ 省略しても、取れていない
 * ことを「手が空いている」と偽る側へは倒れない。
 */
export async function buildActivityDigest(
  stores: Stores,
  window: DigestWindow,
  liveness?: ManagerLiveness,
  awaitingBackground?: ManagerAwaitingBackgroundMap,
): Promise<string> {
  const until = window.until ?? new Date(Date.now() + 1);
  const entries = (await stores.journal.list({ since: window.since.toISOString() })).filter(
    (entry) => entry.at < until.toISOString(),
  );

  const jobs = await stores.jobs.listJobs();
  // **直す前と同じ、有界な取得のまま。** 承認待ちキューの行を消す口が無い
  // （`JobStore` は `listApprovals` / `getApproval` / `putApproval` だけ）ので、
  // `pendingOnly` を外して全件を毎回引くと、運用のあいだ聞いた質問が積み上がる
  // ぶんだけ digest 1回のコストが単調に増える——直す前の digest が引いていた
  // のは「未回答の分」（人間が答えれば減る＝有界）だった。それに戻す。
  // エスカレーション節が権威ある出所を引く必要があるときは、表示する分
  // （`MAX_ITEMS` 件まで）だけ `describeEscalationState` の中で個別に引く
  // （そちらの doc を参照。呼び出し回数はそこで頭打ちになる）。
  const pending = await stores.jobs.listApprovals({ pendingOnly: true });
  const pendingById = new Map(pending.map((approval) => [approval.id, approval] as const));
  // 継続中の依頼は期間で切らない。「いま何を頼まれたままか」は常に材料である
  // （これが無いと、発意 tick のたびに頼まれた仕事を思い出せるかの賭けになる）。
  const standing = await stores.schedules.list();
  // 未了も期間で切らない。**切ると、この器の目的そのものが消える** — 24時間の窓で
  // 切れば、2日前に頼まれてまだ手を付けていない仕事だけが静かに落ちる（それは
  // いちばん落としてはいけないものである）。
  //
  // **`list()` は `{ entries, unreadable, trimmedClosed }` を返す
  // （issue #296 / #416）。** 読めない行を件数からもここからも消さないため、
  // `unreadable` を別に持ち回り、下の節へ渡す。`trimmedClosed`（保持上限を
  // 超えて物理削除された片付き行の累計）も同じ理由で持ち回る——この節を
  // 「この期間に片付けた仕事」の集計だと読む人に、fs 実装では歴史が
  // `CLOSED_HISTORY_LIMIT` を超えた時点で古い期間の集計が静かに減っている
  // ことを黙っていると、日報の材料としての信頼が静かに崩れる。
  const commitmentList = await stores.commitments.list();
  const commitments = commitmentList.entries;
  const unreadableCommitments = commitmentList.unreadable;
  const trimmedClosedCount = commitmentList.trimmedClosed;
  // **片付けたものは期間で切る。** 未了と逆で、こちらは「この期間に何を終えたか」
  // だからである（日報の「今日何をしたか」の材料になる）。切らないと、日報が
  // 過去に片付けた分を毎日並べ直すことになる。
  const settled = (await stores.commitments.list({ includeClosed: true })).entries.filter(
    (entry) =>
      entry.closedAt !== undefined &&
      entry.closedAt >= window.since.toISOString() &&
      entry.closedAt < until.toISOString(),
  );

  const of = <T extends JournalEntry['type']>(type: T) =>
    entries.filter((entry): entry is Extract<JournalEntry, { type: T }> => entry.type === type);

  const exchanges = of('exchange');
  const humanTurns = exchanges.filter(
    (entry) => entry.with === 'human' && entry.role === 'inbound',
  );
  const decisions = of('decision');
  // **`approvalId` で束ねる。** 日誌は追記専用なので、1つの問いに「聞いた」
  // 行と「答えた」行が別々に積まれる（`EscalationGroup` の doc）。束ねずに
  // 行ごとに描くと、同じ問いが「未回答」と「回答あり」の両方として並ぶ。
  // **束ねた後、`at` の降順に並べ直す**（`EscalationGroup.at` の doc）。
  // `journal.list()` の既定（`order: 'desc'`）が新しい順を契約として保証
  // するので、この並べ替えは通常 no-op だが、その契約への依存をこの関数の
  // 外（`journal-order-with-contract.ts`）へ置かず、ここで明示する
  // （同 doc に詳しい理由がある）。
  const escalations = of('escalation');
  const escalationGroups = groupEscalations(escalations).sort((a, b) => b.at.localeCompare(a.at));
  const memoryUpdates = of('memory_update');
  const externals = of('external_event');
  /**
   * ツール実行は**層で分ける**。
   *
   * クローンが自分の手で使った道具も同じ日誌へ落ちるようになった（#32）ので、
   * 1つの数にまとめると「委譲した量」として読める数がクローン自身の手の量で
   * 膨らむ（AGENTS.md「消費の層をモデル名で見分けるな ＝ 層は層の列で言う」と
   * 同じ話で、ここでの層の列は `actor` である）。**この数は digest を読む
   * クローン自身と日報の材料になるので、混ぜると委譲の判断がそのまま狂う。**
   */
  const toolUses = of('tool_use');
  const cloneToolUses = toolUses.filter((entry) => isCloneActor(entry.actor));
  const delegatedToolUses = toolUses.filter((entry) => !isCloneActor(entry.actor));

  // 走行中・返事待ちは期間の外で始まったものも「いまの状態」として要る
  const inFlight = (status: JobStatus) => status === 'running' || status === 'waiting_human';
  // **上限で切っても「いまの状態」が落ちない順に並べる。** 材料の順序は器ごとに
  // 違う（pg は `createdAt` 昇順・fs は最終更新順・memory は挿入順）ので、並べ直さ
  // ないと、上で期間の外からわざわざ拾った走行中・返事待ちが古い `done` に押し
  // 出されて消えうる。それはこの節がやろうとしていることの逆である。
  const managers = jobs
    .filter((job) => job.updatedAt >= window.since.toISOString() || inFlight(job.status))
    .sort((a, b) => {
      if (inFlight(a.status) !== inFlight(b.status)) return inFlight(a.status) ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  const sections: string[] = [
    `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
    '',
    `- 人間からの発言: ${humanTurns.length} 件`,
    `- マネージャーへの委譲（この期間に動いたもの）: ${managers.length} 本`,
    `- 自分で決めたこと（日誌の decision）: ${decisions.length} 件`,
    // **束ねた問いの数であって、日誌の行数ではない。** 1問に「聞いた」
    // 「答えた」の2行が付くことがあるので、行数をそのまま出すと二重に数える
    // （`escalationGroups` の doc）。
    `- エスカレーション: ${escalationGroups.length} 件`,
    `- 記憶の更新: ${memoryUpdates.length} 件`,
    `- 外部イベント: ${externals.length} 件`,
    `- マネージャー・作業者のツール実行: ${delegatedToolUses.length} 件`,
    `- あなた自身が手を動かした回数（委譲せずに使った道具）: ${cloneToolUses.length} 件`,
    `- いま人間の回答を待っているもの: ${pending.length} 件`,
    `- 継続中の依頼（定期の仕込み）: ${standing.length} 件`,
    `- 引き受けたまま終わっていない仕事: ${commitments.length} 件`,
    // **0件でも出す**（他の行と同じ扱い）。台帳の破損は稀だが、無いことも
    // 常に言えるようにしておく（「取れない軸に0の行を作る」の逆 — ここは
    // 実際に取れている軸なので0を隠さない）。詳細は下の節（issue #296）。
    `- 読めない行（台帳が壊れている。片付いたのではない）: ${unreadableCommitments.length} 件`,
    `- この期間に片付けた仕事: ${settled.length} 件`,
    // **0件でも出す**（`unreadableCommitments` の直上の行と同じ理由）。
    // 保持上限を超えて物理削除された片付き行の累計（issue #416）。0件は
    // 「削除が起きていない」であって「数えていない」ではない（`CommitmentList`
    // の doc）。
    `- 保持上限を超えて物理削除された片付き行（累計。この記憶ストアが最初から数えている分）: ${trimmedClosedCount} 件`,
  ];

  // **読めない行が在れば、件数と一緒に節を出す（issue #296）。** `commitments`
  // （＝ `entries`）が0件でも読めない行だけは在りうるので、`commitments.length`
  // だけをこの節の出し分けの条件にしない。
  if (commitments.length > 0 || unreadableCommitments.length > 0) {
    sections.push(
      '',
      '## 引き受けたまま終わっていない仕事（古い順。片付いたら `commitment_close` で閉じる）',
      '**順序はここには無い。** どれを先にやるかは記憶にある目的と価値観に照らして決めること。',
    );
    if (unreadableCommitments.length > 0) {
      // **件数やログではなくここでも明言する。** 「片付いたのではない」を
      // 落とすと、読めない行が静かに未了から消えたのと区別が付かなくなる
      // （`store.ts` の `CommitmentList` の doc と同じ理由）。
      const idsAll = unreadableCommitments
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      // **ここも上限を付ける。** `unreadableCommitments` は台帳の破損の度合いに
      // 比例して伸びるので、`ids.join(', ')` を無制限にすると台帳が壊れるほど
      // digest が伸びる（MAX_ITEMS で切っている他の一覧と同じ理由）。
      const ids = idsAll.slice(0, MAX_ITEMS);
      // **「commitment_list を呼べば全部出る」と書けるのは、実際に確かめたから
      // である。** `tools.ts` の `commitment_list`（id を渡さない一覧モード）が
      // 読めない行の id を出す節は `ids.join(', ')` をそのまま使っており、件数の
      // 上限を掛けていない（実装を読んで確認した。まだ上限が無い時点の話なので、
      // 後で上限が付いたらこの文言も直す必要がある）。
      // 省いた件数は、他の節と同じく**出した件数から引く**（`omitted()` の doc）。
      const idsExtra =
        idsAll.length > ids.length
          ? `（…ほか ${idsAll.length - ids.length} 件。id は commitment_list（id を指定しない一覧モード）を呼べば読めない行の id が全部出る）`
          : '';
      sections.push(
        `**読めない行が ${unreadableCommitments.length} 件ある（片付いたのではない）。**` +
          (ids.length === 0 ? '' : ` id: ${ids.join(', ')}${idsExtra}。`) +
          // **「全文が見られる」とは書かない。** `commitment_list id=<id>` の
          // 全文モードは `get(id)` が読めない行で throw するので、本文は
          // 返らない（`UnreadableCommitmentError` を捕まえて「読めない」と
          // 返すだけの3値目になる。`tools.ts` の該当箇所）。ここは実際に
          // できることだけを書く。
          '`commitment_list id=<id>` で状態は確かめられる（本文はここでは取れない）。',
      );
    }
    const shownCommitments = commitments.slice(0, MAX_ITEMS);
    for (const entry of shownCommitments) {
      sections.push(
        `- ${entry.id}（${entry.at} / ${entry.origin}${entry.source === undefined ? '' : ` / ${entry.source}`}）` +
          `\n  ${brief(entry.body)}`,
      );
    }
    // 継続中の依頼と同じ理由で、黙って切らない。
    sections.push(
      // **`commitment_list` も件数で打ち切る**ので「全部見える」とは書けない
      // （あちらは残り件数を本文に出す）。
      ...omitted(
        commitments.length,
        shownCommitments.length,
        '`commitment_list` で古い順に辿れる。あちらも入る分までで、残りの件数が本文に出る',
      ),
    );
  }

  if (standing.length > 0) {
    sections.push('', '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）');
    const shownStanding = standing.slice(0, MAX_ITEMS);
    for (const plan of shownStanding) {
      sections.push(
        `- ${plan.kind}（${describeScheduleSpec(plan.spec)}）${brief(plan.request)}` +
          `\n  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
      );
    }
    // 黙って切らない。他の節は期間で切った一部だが、ここは「常に材料である」ことが
    // 趣旨なので、切ったことを見せないと「あるのに見えない」になる。
    sections.push(
      ...omitted(standing.length, shownStanding.length, '`schedule_list` で全部見える'),
    );
  }

  if (settled.length > 0) {
    sections.push('', '## この期間に片付けた仕事');
    const shownSettled = settled.slice(0, MAX_ITEMS);
    for (const entry of shownSettled) {
      sections.push(
        `- ${brief(entry.body, 120)}\n  片付いたとした理由: ${brief(entry.closedReason ?? '', 120)}`,
      );
    }
    sections.push(
      ...omitted(
        settled.length,
        shownSettled.length,
        '`commitment_list` に includeClosed=true を渡すと辿れる',
      ),
    );
  }

  if (managers.length > 0) {
    sections.push('', '## マネージャー（走行中・返事待ちから先に出す）');
    const shownManagers = managers.slice(0, MAX_ITEMS);
    for (const job of shownManagers) {
      sections.push(
        `- ${job.id} [${describeManagerState(job.status, liveness?.get(job.id), awaitingBackground?.get(job.id))}] ${brief(job.request ?? job.summary)}` +
          (job.lastReport === undefined ? '' : `\n  直近の報告: ${brief(job.lastReport)}`),
      );
    }
    sections.push(
      ...omitted(
        managers.length,
        shownManagers.length,
        '`manager_list` で状態を見る。あちらも入る分までで、残りの件数が本文に出る',
      ),
    );
  }

  if (decisions.length > 0) {
    sections.push('', '## 聞かずに決めたこと');
    const shownDecisions = decisions.slice(0, MAX_ITEMS);
    for (const entry of shownDecisions) {
      sections.push(`- ${entry.at} ${brief(entry.decision)}（根拠: ${brief(entry.grounds, 80)}）`);
    }
    sections.push(...omitted(decisions.length, shownDecisions.length, journalWhere('decision')));
  }

  if (escalationGroups.length > 0) {
    sections.push('', '## エスカレーション');
    // 束ねたグループを切る（行ではなく問いの数で MAX_ITEMS を適用する）。
    // **承認待ちキューへの個別の問い合わせ（`describeEscalationState` 内の
    // `getApproval`）は、ここで切った後の分だけに限られる**——切る前の
    // `escalationGroups` 全件に対して行うと、束ねてもなお呼び出し回数が
    // 問いの総数に比例してしまう（`describeEscalationState` の doc）。
    const shownEscalations = escalationGroups.slice(0, MAX_ITEMS);
    for (const group of shownEscalations) {
      const state = await describeEscalationState(stores, group, pendingById);
      // **行そのものに id を出す。** 依頼者の指摘どおり、直す前はここに id が
      // 一度も出ておらず、状態2の文言が「同じ id で出ている」と言いながら
      // 突き合わせる id を読み手が質問文から探すしかなかった。id の種類
      // （承認待ちキューの id か、マネージャーの requestId か）は
      // `escalationIdLabel` が journal だけから決める（store 呼び出し無し）。
      sections.push(`- ${brief(group.question)} → ${state}（${escalationIdLabel(group)}）`);
    }
    sections.push(
      ...omitted(escalationGroups.length, shownEscalations.length, journalWhere('escalation')),
    );
  }

  if (pending.length > 0) {
    sections.push('', '## 人間の回答待ち（保留中。他の仕事は進めてよい）');
    const shownPending = pending.slice(0, MAX_ITEMS);
    for (const approval of shownPending) {
      sections.push(
        `- ${approval.id}（${approval.createdAt}）${brief(approval.question)}` +
          (approval.jobId === undefined ? '' : ` [マネージャー ${approval.jobId}]`),
      );
    }
    // ここだけは打ち切らない道具があるので「全部見える」と書ける。
    sections.push(...omitted(pending.length, shownPending.length, '`approvals_list` で全部見える'));
  }

  if (memoryUpdates.length > 0) {
    sections.push('', '## 記憶の更新');
    const shownMemoryUpdates = memoryUpdates.slice(0, MAX_ITEMS);
    for (const entry of shownMemoryUpdates) {
      // `queries.ts` の `summarizeJournalEntry` と同じ言い方に揃える
      // （`action`/`cause` を1つの括弧にまとめ、バイトの注記を `/` で続ける）。
      // 単位はバイト（`schema.ts` の `bytesBefore`/`bytesAfter` の doc）。
      // `action`/`bytesBefore`/`bytesAfter` はこの区別が導入される前の
      // 古いエントリでは `undefined` — 無いことを `0` として出すと
      // 「変化が無かった」と読めてしまうので、値が無いときは「不明」と
      // 明示する（`tools.ts`/`queries.ts` と同じ扱い）。
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${entry.bytesBefore}→${entry.bytesAfter} バイト`;
      sections.push(
        `- ${entry.slug}（${entry.cause}${action} / ${bytes}）${brief(entry.summary, 120)}`,
      );
    }
    sections.push(
      ...omitted(memoryUpdates.length, shownMemoryUpdates.length, journalWhere('memory_update')),
    );
  }

  if (externals.length > 0) {
    sections.push('', '## 届いた外部イベント');
    const shownExternals = externals.slice(0, MAX_ITEMS);
    for (const entry of shownExternals) {
      sections.push(`- ${entry.source}: ${brief(entry.summary, 120)}`);
    }
    sections.push(
      ...omitted(externals.length, shownExternals.length, journalWhere('external_event')),
    );
  }

  sections.push('', ...(await usageSection(stores, window.since, until)));

  return sections.join('\n');
}

/**
 * この期間にいくら使ったか。
 *
 * **これは判断の材料である。** 委譲を続けてよいか、重い仕事をいま投げてよいかは、
 * 使った量が見えなければ勘で決めるしかない。実際に支出上限へ当たって走行中の
 * マネージャーが2本同時に落ちたことがあり、そのときクローンには事前に知る手段が
 * 無かった。日報では「どの委譲が高かったか」「どの層（Fable / Opus / Sonnet）が
 * 高いか」が、委譲の粒度を直す材料になる。
 *
 * **取れなかったものを 0 と書かない。** 台帳が無かった期間は「記録が無い」であって
 * 「使っていない」ではない。
 */
async function usageSection(stores: Stores, since: Date, until: Date): Promise<string[]> {
  let aggregate;
  try {
    aggregate = await stores.usage.aggregate({
      from: usageDate(since),
      // 上端は含まないので 1ms 引いてから日付にする（境界の日が余分に入らない）。
      to: usageDate(new Date(until.getTime() - 1)),
    });
  } catch {
    // 台帳が読めないこと自体で digest を落とさない。ただし黙らない。
    return ['## 使った分', '（台帳を読めなかった。集計は出せない）'];
  }

  const lines = ['## 使った分'];
  if (aggregate.since === null) {
    lines.push('（台帳にまだ記録が無い。この機能を入れる前の分は残っていない）');
    return lines;
  }

  const summary = summarizeUsage(aggregate.rows);
  if (aggregate.rows.length === 0) {
    lines.push('この期間の記録は無い。');
  } else {
    lines.push(`- 合計: ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `- 出力トークン: ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `入力: ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み: ${summary.total.cacheReadInputTokens.toLocaleString('en-US')}`,
    );
    // 高い順。どの層・どの委譲に効くかを先に見せる。
    const top = <T extends { totals: { costUsd: number } }>(entries: readonly T[]) =>
      [...entries].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, MAX_ITEMS);
    // **合図は `usageOmitted` から取る（4軸とも同じ関数を通す）。** 超えて
    // いなければ空文字が返るので、その行には何も足さない。
    const shownModels = top(summary.byModel);
    const modelExtra = usageOmitted(summary.byModel.length, shownModels.length, 'model', '件');
    lines.push(
      `- モデル別: ${shownModels
        .map((entry) => `${entry.model} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${modelExtra === '' ? '' : ` / ${modelExtra}`}`,
    );
    // **誰が**使ったか。モデル別と別に出す — `ALTEROID_CLONE_MODEL` を置けば
    // クローンとマネージャーは同じモデル帯に並び、モデル名では層を見分けられない。
    const shownLayers = top(summary.byLayer);
    const layerExtra = usageOmitted(summary.byLayer.length, shownLayers.length, 'layer', '件');
    lines.push(
      `- 層別（誰が）: ${shownLayers
        .map((entry) => `${entry.layer} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${layerExtra === '' ? '' : ` / ${layerExtra}`}`,
    );
    const shownSites = top(summary.bySite);
    const siteExtra = usageOmitted(summary.bySite.length, shownSites.length, 'site', '件');
    lines.push(
      `- 場所別（どこで）: ${shownSites
        .map((entry) => `${entry.site} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${siteExtra === '' ? '' : ` / ${siteExtra}`}`,
    );
    lines.push('- 高かった委譲:');
    const shownManagers = top(summary.byManager);
    for (const entry of shownManagers) {
      lines.push(`  - ${entry.managerId}: ${formatUsd(entry.totals.costUsd)}`);
    }
    // **「`usage_read` で全部見える」と書かない。** あちらも軸ごとに打ち切るので
    // 嘘になる。実際に打てる手（続きを辿る呼び方）をそのまま書く——文言は
    // `usageOmitted` から取る（同じ関数を4軸とも通す理由は同関数の doc）。
    const managerExtra = usageOmitted(
      summary.byManager.length,
      shownManagers.length,
      'manager',
      '本',
    );
    if (managerExtra !== '') lines.push(`  - ${managerExtra}`);
  }

  if (aggregate.beforeLedger) {
    lines.push(
      `- この期間の一部は台帳の始点（${aggregate.since}）より前で、**記録が無い**（0 ではない）`,
    );
  }
  if (aggregate.beforeLayers) {
    // **層の始点を台帳の始点と混ぜない。** 層の軸のほうが後から入ったので、それより
    // 前の行の層と場所は既定値であって観測ではない。
    lines.push(
      '- この期間の一部は層と場所の軸の始点' +
        `（${aggregate.layersSince ?? 'まだ1件も記録が無い'}）より前で、` +
        'その分の層と場所は**既定値であって観測ではない**',
    );
  }
  lines.push(`- ${aggregate.notice}`);
  return lines;
}

/**
 * 一覧に載せるための抜粋。
 *
 * **切ったことを黙らない。** 省いた分量が出ていれば、続きが要るかどうかを
 * 読んだ側が判断できる（報告の全文は `manager_report` で取れる）。
 */
function brief(value: string, limit = 200): string {
  return excerptLine(value, limit);
}
