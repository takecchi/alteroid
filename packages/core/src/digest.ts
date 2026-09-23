import { excerptLine } from './excerpt.js';
import { scanJournalPages } from './journal-scan.js';
// **型だけを取る**（`import type` は実行時に消えるので、`manager.ts` との間に
// 実行時の循環を作らない）。字面の生成元をここに置く理由は
// `describeSessionMissingKind` の doc に在る。
import type { ManagerAwaitingBackground, SessionMissingKind } from './manager.js';
import { describeScheduleSpec } from './schedule.js';
import type { Job, JobStatus, JournalEntry, PendingApproval } from './schema.js';
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
 * 日誌から材料を集めるときに**種別ごとに保持する**件数の上限（issue #1283）。
 *
 * ## 直している穴
 *
 * 直す前の `buildActivityDigest` は `stores.journal.list({ since })` を
 * `limit` なしで呼び、窓の全行を本文ごと1配列へ載せていた。pg 実装は `limit`
 * 省略時に `Number.MAX_SAFE_INTEGER` を渡す
 * （`grep -Fn -- 'query.limit ?? Number.MAX_SAFE_INTEGER' packages/storage-pg/src/journal.ts`）
 * ので、窓の中身が多い日（実測: ある1日で約247万行・約1.4GB）にそれを1クエリで
 * ヒープへ載せようとして落ちる。
 *
 * ## `MAX_ITEMS` より十分大きくしてある理由
 *
 * 一覧に出す詳細は `MAX_ITEMS`（15）件で足りるが、`.slice(0, MAX_ITEMS)` を
 * 直接この保持上限にすると、**新しい側から数えて16件目以降が同じ日の
 * うちに何度も入れ替わる**（`desc` で走査する以上、保持したぶんの先頭
 * `MAX_ITEMS` 件は必ず「本当に新しい `MAX_ITEMS` 件」と一致するが、それを
 * 確かめる余地——`omitted()` へ渡す「実際に保持できた件数」との差——が
 * 無くなる）。**200 にしてあるのは、`MAX_ITEMS` の約13倍という安全率**で、
 * 通常の digest の窓（1日〜数日）でこの上限に当たる種別はまず無い——
 * 当たらない限り、この digest の出力（件数・一覧のどちらも）は直す前と
 * 1文字も変わらない（`buildActivityDigest` 本体の doc を参照）。
 */
export const DIGEST_RETAIN_LIMIT = 200;

/**
 * 日誌の走査そのものに掛ける、1回の `buildActivityDigest` あたりの総件数の
 * 上限（issue #1283）。
 *
 * ## なぜ「保持の上限」とは別に要るか
 *
 * `DIGEST_RETAIN_LIMIT` はヒープに残す量を抑えるが、**走査そのもの
 * （`journal.list()` の呼び出し回数）は抑えない**——ページを読み継ぐ形に
 * しただけでは、247万行の窓を1ページ（`JOURNAL_SCAN_PAGE_SIZE`）ずつ
 * 読み切るのに約5,000回のクエリが走る（起動時の日報の後追い生成が、この
 * 回数を1度に払うことになる）。⟹ **走査そのものにも上限を置き、超えたら
 * 「打ち切った」と名乗って止まる。**
 *
 * ## 値の選び方——**普通の日に当たってはいけない**
 *
 * この上限に当たると、下の件数と一覧は「読んだ範囲のもの」になり、digest は
 * `JOURNAL_SCAN_TRUNCATED_NOTICE` でそう名乗る。**名乗るのだから静かには
 * 痩せない**が、**毎日鳴る断り書きは意味を失う**（`distill-gap.ts` が
 * 「毎回鳴る注釈」を避けている doc と同じ理由）。⟹ この上限は「普通の日の
 * 日誌の行数」より**桁で上**に置く必要がある。
 *
 * **実測（依頼元が DB を読んで取った値、2026-09-22 観測）**: 事故の日
 * （利用上限に当たり続けて同じ1文が積まれた日）が1日で約247万行だったのに
 * 対し、**普通の日は1日で1万行〜3万行の桁**だった。⟹ 1万の桁に上限を置くと
 * 普通の日に当たってしまう。**桁を1つ上げてある。**
 *
 * `JOURNAL_SCAN_PAGE_SIZE` で割ると、この上限に当たる最悪の場合で1走査あたり
 * 200回の往復である（`buildActivityDigest` は走査を2本持つので、その倍が
 * 最悪値）。**247万行を最後まで読み切る約5,000回に比べれば1桁以上小さく、
 * 普通の日（数万行）なら往復は数十回で済む。**
 *
 * ⚠ **実データの分布から精密に決めたわけではない**——観測された2つの桁
 * （普通の日と事故の日）の間に置いた経験則である。普通の日の行数が伸びて
 * ここへ届くようになったら、**上限を上げるのではなく走査の絞り込みの側を
 * 見直すこと**（種別を減らす・窓を割る）。上げ続ければ、いずれ元の穴へ戻る。
 */
export const DIGEST_JOURNAL_SCAN_LIMIT = 100_000;

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
 *
 * ## `since`（Issue #1104）— 経過時間はここで作らず、時刻だけを渡す
 *
 * **この関数に時計を渡して経過を計算させない。** ここは純粋な整形であって、
 * `since` の値そのもの（`ManagerAwaitingBackground.since` の doc）が「時刻で
 * 答えが変わるものを一覧に焼かない」と言っている——`describeManagerState` は
 * 呼ばれるたびに `now` が変わりうる場所（`manager_list` の一覧行）で使われる
 * ので、ここで経過を計算すると同じ入力でも呼ぶ時刻ごとに違う文字列を返す
 * 純関数でなくなる。**出すのは `since`（時刻）そのもの**で、経過を作るのは
 * 読む側（クローン）である。
 *
 * **`since` が無いときは1バイトも変えない。** 第3引数が `{ tasks }` だけの
 * 呼び出し（既存の呼び出し・テスト）はこれまでどおりの字面のまま——`since`
 * を省略できることの裏返しである（`live` の3値と同じ「省略が黙って何かを
 * 主張しない」作法）。
 */
export function describeManagerState(
  status: JobStatus,
  live: boolean | undefined,
  awaitingBackground?: { tasks: number; since?: string },
): string {
  const base = describeLiveState(status, live);
  // **背景タスクの在り高だけを足す。** `breakdown`（`local_agent×3` のような内訳）はここへ
  // 載せない——一覧の1行に出る字面で、件数に比例して伸びるものを載せると、
  // 溜まっているときほど一覧が重くなる（`listing-and-detail` の性質1）。
  // 内訳が要るなら `manager_report` / 日誌（`type: 'decision'` の `grounds`）に
  // 全文が在る。
  if (awaitingBackground === undefined) return base;
  const sinceSuffix =
    awaitingBackground.since === undefined ? '' : `（${awaitingBackground.since} から）`;
  return `${base}/背景処理待ち×${awaitingBackground.tasks}${sinceSuffix}`;
}

/** `describeManagerState` の `live` の部分だけ（3値の分岐は1文字も変えていない）。 */
function describeLiveState(status: JobStatus, live: boolean | undefined): string {
  if (live === true) return status;
  if (live === false) return `${status}/セッション切断`;
  return `${status}/セッション不明`;
}

/**
 * 日報の「マネージャー」節に足す、`job.lastFailure`（`{ code, via, at }`）の
 * 1行（Issue #714 の3面目）。
 *
 * **台帳には前から在った。日報の面だけが読んでいなかった。** `manager_list` /
 * `manager_report`（`tools.ts` の `describeManagerFailure`）は既にこの欄を
 * 出しているが、日報はここまで `job.lastReport` しか見ておらず、直近のターンが
 * 報告ではなく失敗で終わっていても日報の文面に何も現れなかった（north_star
 * 禁止1——人間・他の面にできることがこの面でできないならバグ）。
 *
 * **`describeManagerFailure` をそのまま呼ばない。** あちらは200文字を超える
 * 定型文（次の一手の注意書きまで含む）で、`manager_list` の1エントリ用に
 * 作られている。日報はマネージャー1本につき最大 {@link MAX_ITEMS}（15）本を
 * 並べる面なので、そのまま使うと1節だけで3,000文字級になり、この節の後ろに
 * 続く節（決めたこと・エスカレーション・使った分…）が
 * `PROMPT_CHARACTER_BUDGET`（`prompt.ts`）の tail-cut で押し出される
 * （このファイル冒頭 `isManagerInFlight` の doc が記録している、`lost` を
 * 誤って第1群へ混ぜたときと同じ形の事故——**枠を共有する節を1つ膨らませると、
 * 別の節が黙って消える**）。**だから日報側は短い1行に留め、全文と次の一手は
 * `manager_list` / `manager_report` へ案内する。** `omitted()` が他の節でも
 * 同じ形（`manager_list` で状態を見る）で案内しているのに揃えてある。
 *
 * **`code` / `via` は `brief()` で軽く縛る。** `schema.ts` の `lastFailure` は
 * SDK の語をそのまま持つ（`z.string()` に長さの上限は無い）——通常は
 * `billing_error` のような短い定数だが、`code`/`via` は SDK 側の値で
 * こちらが決められない。他の外部由来の文字列（`request` / `lastReport` /
 * `decision.grounds` など）と同じく、縛らずに出すと worst case が際限なく
 * 伸びる（`prompt.ts` の `PROMPT_CHARACTER_BUDGET` の doc が言う「`brief()` を
 * 通らない列は伸び続けうる」の仲間を増やさない）。
 *
 * **健全な回では `''` を返し、1文字も増えない**（`describeManagerFailure` の
 * doc と同じ約束）。
 */
function describeLastFailureLine(failure: Job['lastFailure']): string {
  if (failure === undefined) return '';
  return (
    `\n  ⚠ 直近のターンは失敗で終わっている: ${brief(failure.code, 60)}` +
    `（via: ${brief(failure.via, 60)}, ${failure.at}）。` +
    '全文と次の一手は `manager_list` / `manager_report` で見る。'
  );
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
 * その委譲を「いまの状態」として**先に出す側**か（`running` / `waiting_human`）。
 *
 * **`describeManagerState` と同じ理由でここに置く——生成元を1つにする。** この
 * 分け方は日報（この下の `buildActivityDigest` の「マネージャー」節）と
 * `manager_list`（`tools.ts`）の両方が使う。**字面ではなく*分け方*が割れると、
 * 片方の面だけで走行中の委譲が窓の外へ落ちる**——`describeManagerState` の doc が
 * 逐語で記録している事故（字面が割れて、クローンが終わった仕事へ3本目の委譲を
 * 出した）と同じ形が、並びの側で起きる。
 *
 * **どちらの面でも、これは「進んでいるか」ではない。** `running` は「走らせた」
 * であって「進んでいる」ではなく（`schema.ts` の `jobStatusSchema` の doc）、
 * ここが答えるのは「まだ人間・クローンの側に手番が残っている可能性がある側か」
 * までである。終端（`done` / `failed` / `lost` / `stopped`）を落とすためではなく、
 * **順序を決めるため**にある——落とすと到達できない委譲が生まれる（north_star
 * 禁止2）。
 *
 * ## ⚠️ `lost` をここへ足さないこと（#688）。見たいなら {@link isManagerAwaitingJudgement}
 *
 * `lost` は「判断待ち」（成果がリモートへ届いているかを誰も確かめていない）なので
 * 前へ出したくなるが、**この述語へ混ぜると日報が壊れる。** 日報のマネージャー節は
 * この述語を第1キーにして `sort` し、そのあと {@link MAX_ITEMS} で `slice` する
 * ——`lost` が第1群へ移ると**枠を食って、最近終わった委譲が押し出される**
 * （`lost` が `MAX_ITEMS` 本を超えれば第2群は1行も出ない）。⟹ **#689 が
 * `manager_list` で直した穴と同じ形を、日報の側に作ることになる。**
 *
 * **だから `lost` は別の述語が持つ**（{@link isManagerAwaitingJudgement}。この
 * すぐ下に在る）。使う側が2つを組み合わせて群を作る——`manager_list` は3群、
 * **日報は2群のままである。** 判断の全文はそちらの doc に在る。
 *
 * **ここは逐語の `grep` ではなく `{@link}` で指している。** この文自身が指す先の
 * 見出しを引用してしまう形になり、**`grep` が自分の citation にも当たって2件
 * 返す**（AGENTS.md が「誤爆——読み手には正しい出典に見える」と言う形である）。
 * 指す先が**同じファイルのすぐ下**なので、シンボル名で指せば曖昧さが無い。
 */
export function isManagerInFlight(status: JobStatus): boolean {
  return status === 'running' || status === 'waiting_human';
}

/**
 * その委譲が**判断待ち**か（`lost`。#688）。
 *
 * ## `lost` は「終わった」ではない。「終わったかどうかを観測していない」である
 *
 * 終端の4値（`done` / `failed` / `lost` / `stopped`）のうち、**`lost` だけが
 * 成果の有無を1度も見ていない。** 台帳の doc が逐語でそう言っている
 * （`grep -Fn -- '**ただし `lost` は「成果が無い」ではない。**' packages/core/src/schema.ts`）し、
 * `manager_list` の但し書きも同じことを言う
 * （`grep -Fn -- '1分半後の器の作り直しで `lost` になり、この行が「途中で失われて' packages/core/src/tools.ts`）。
 * ⟹ **人間・クローンがリモート（PR・ブランチ・コミット）を確かめるまで終われない。**
 *
 * **`failed` / `stopped` に同じ記述は無い**（repo 内で0件）。だからここは
 * `lost` 1値だけを見る——「終端をまとめて後ろへ送る」述語ではない。
 *
 * ## なぜ1値の判定に名前を付けるのか（`status === 'lost'` と直に書かない）
 *
 * この分け方を使う面が**2つ**在る——`situation.ts` の `countManagerSituation`
 * （毎ターンの入口で数える側）と、`tools.ts` の `compareManagerAttention`
 * （`manager_list` の並びの側）である。
 * **`status === 'lost'` を2箇所に書き下ろすと、上の意味論を持つ場所が消える**
 * ——次に読む者には「終端の1つを特別扱いしている」ようにしか見えず、
 * `failed` を足す変更が自然に見えてしまう。{@link isManagerInFlight} /
 * {@link describeManagerState} と同じ理由で、生成元を1つにする。
 *
 * ## ⚠️ この述語を {@link isManagerInFlight} へ足さないこと（日報が壊れる）
 *
 * 「判断待ちも先に出したい」から `isManagerInFlight` に `lost` を混ぜたくなるが、
 * **あれは日報（この下の `buildActivityDigest` の「マネージャー」節）と
 * `manager_list` が共有する正本**で、日報側は `MAX_ITEMS` で `slice` する。
 * ⟹ `lost` が第1群へ移ると**枠を食って、最近終わった委譲が押し出される**
 * （`lost` が `MAX_ITEMS` 本を超えれば第2群は1行も出ない）。#689 が
 * `manager_list` で直した穴と同じ形を、日報の側に作ることになる。
 *
 * **だから2つを別の述語として並べて置く。** 使う側が「いまの状態」（`inFlight`）と
 * 「判断待ち」（こちら）を組み合わせて群を作る（`manager_list` は3群、日報は
 * 2群のまま）。**日報はこの述語を1度も呼ばない**——呼ばないことが #688 の
 * 候補2を採らなかった判断そのものである（Issue #688 のコメント）。
 */
export function isManagerAwaitingJudgement(status: JobStatus): boolean {
  return status === 'lost';
}

/**
 * その委譲が**終端していて、かつ誰も望んでいない終わり方をした**か
 * （`lost` / `failed`。Issue #857）。
 *
 * ## ⛔ {@link isManagerAwaitingJudgement} を書き換えてこれにしないこと
 *
 * あちらは `lost` 1値だけを見る述語で、**日報（#688）の判断を握っている**
 * （`manager_list` の第2群の境界そのもの）。こちらは `failed` を足した別の集合
 * である——`failed` を `isManagerAwaitingJudgement` へ混ぜると、`manager_list`
 * の群1（`lost`）の境界が動き、#688 が決めた並びが1バイト以上変わる。
 * **だから別の述語として並べて置く。** 群の境界は `isManagerAwaitingJudgement`
 * が持ったまま、この述語は**群の中の副順位**にしか使わない
 * （`tools.ts` の `managerPositionOf`）。
 *
 * ## なぜ `done` / `stopped` を含めないのか
 *
 * `done` は報告を受け取って畳んだ終端で、`stopped` は人間・クローンが自分で
 * 止めた終端である——**どちらも「そう終わってほしかった」側**で、依頼者は
 * 終わり方そのものを知っている。`lost`（前のセッションへ戻れなかった）と
 * `failed`（セッションが落ちた）だけが、**依頼者が望まないところで終わり、
 * かつ何が起きたかを台帳が持っていない**（`schema.ts` の `lost` の doc と
 * `lastSystemError` の doc）。
 */
export function isManagerOutcomeUnobserved(status: JobStatus): boolean {
  return status === 'lost' || status === 'failed';
}

/**
 * 終端していて誰も望んでいない終わり方をした委譲の分類の芯: **依頼者に本文が
 * 届いているか**（Issue #857）。
 *
 * - `none`: `lastReport === undefined`。**終端までに本文が1文字も届いていない。**
 *   `manager.ts` の `case 'report'` が唯一の書き込み元で、一度でも届けば上書きで
 *   残る ⟹ 「1文字も届いていない」は台帳から**厳密に真**である。
 * - `failure-wrapped`: `lastReport` は在るが `lastFailure` も在る。中身は runner が
 *   包んだエラー文であって報告ではない（Issue #714。`tools.ts` に逐語で
 *   「失敗した回は「報告」と呼ばない（Issue #714）。」と在る）。
 * - `delivered`: `lastReport` が在り `lastFailure` は無い。**本文は届いたが、完遂
 *   した報告とは限らない**——`runner.ts` の `#flushUnreported(reason, status)` が
 *   終端の直前に「喋っただけの本文」を報告として出す経路を持つ。**この2つは台帳
 *   からは区別できない**ので、`delivered` は「完遂した」とは名乗らない。
 */
export type UnobservedReportState = 'none' | 'failure-wrapped' | 'delivered';

/**
 * 分類を順位の数へ写したもの。**小さいほど先に出る**（`tools.ts` の
 * `managerPositionOf` が `ManagerPosition.judgementRank` として使う）。
 *
 * `none`（何も知らない）→ `failure-wrapped`（届いているのは報告ではない）→
 * `delivered`（本文は届いている）。**「依頼者が何を知らないか」の順であって、
 * 成果が在りそうな順ではない**——成果の有無はこの台帳からは言えない。
 */
export type JudgementRank = 0 | 1 | 2;

/**
 * 分類の対象外（`running` / `waiting_human` / `done` / `stopped`）の委譲が持つ
 * 副順位。
 *
 * **いちばん後ろ（`delivered` と同値）に置く。** 副順位で前へ出さない、という
 * 意味である。⟹ **対象外どうし・対象外と `delivered` の相対順序は `startedAt`
 * のまま1バイトも動かない**（`compareManagerPosition` は `judgementRank` が
 * 同値なら次のキーへ落ちる）。新しい値（`3`）を与えると、群2の中で
 * 「`failed` 全部 → `done`/`stopped` 全部」という**4つ目の群**を黙って作って
 * しまう——#688 が決めた群の境界を動かさない、という約束に反する。
 */
export const JUDGEMENT_RANK_NOT_APPLICABLE = 2 satisfies JudgementRank;

/**
 * {@link classifyUnobservedOutcome} / {@link describeUnobservedOutcome} が読む欄
 * だけを名指しした入力。
 *
 * **`ManagerSummary` をそのまま渡せる**（構造的に代入できる）が、型としては
 * この3欄しか読まないことを宣言しておく——`manager-activity.ts` の
 * `ManagerActivityInput` と同じ作法で、「この判定が台帳の何を見ているか」を
 * 型から読めるようにするためである。
 */
export interface UnobservedOutcomeInput {
  status: JobStatus;
  lastReport?: string;
  lastFailure?: Job['lastFailure'];
}

/** {@link classifyUnobservedOutcome} の結果。 */
export interface UnobservedOutcome {
  reportState: UnobservedReportState;
  rank: JudgementRank;
}

/**
 * 終端していて誰も望んでいない終わり方をした委譲（`lost` / `failed`）を、
 * **台帳だけから**分類する（Issue #857）。**対象外なら `null`。**
 *
 * ## 直した穴
 *
 * `manager_list` は `lost` の行すべてに同じ注記（「前のセッションへ戻れなかった」）
 * を出していた。**ほぼ常に真なので順位が付かない**——依頼者（クローン）は1本ずつ
 * `gh` を叩いて成果の所在を測るしかなかった。
 *
 * ## 芯: 順位は「依頼者が何を知らないか」で付ける。**PR の有無では付けない**
 *
 * PR の有無を順位の芯にすると、**依頼の種類によって系統的に間違える。** 実例
 * （Issue #857 の本文）:
 *
 * 1. `failed` だが PR を出し終えた後に落ちていた（成果は無事）
 * 2. 成果が `main` に着地していたのに、id で検索すると0件だった
 * 3. **調査だけを頼んだ委譲**——PR も枝もコミットも無いが、報告の中身は価値が高かった
 *
 * ⟹ **「PR が無い」を「成果が無い」と読む判定器を作らない。** だから順位は
 * 本文が届いているかだけで付ける。
 *
 * ## 取れなかったときに 0 や「成果なし」へ倒さない
 *
 * `delivered` は「完遂した」とは名乗らない（AGENTS.md の地雷「取れない軸に 0
 * の行を作る」と同じ線）。
 */
export function classifyUnobservedOutcome(
  manager: UnobservedOutcomeInput,
): UnobservedOutcome | null {
  if (!isManagerOutcomeUnobserved(manager.status)) return null;
  const reportState: UnobservedReportState =
    manager.lastReport === undefined
      ? 'none'
      : manager.lastFailure === undefined
        ? 'delivered'
        : 'failure-wrapped';
  const rank: JudgementRank =
    reportState === 'none' ? 0 : reportState === 'failure-wrapped' ? 1 : 2;
  return { reportState, rank };
}

/** 3値で別々の文である（入れ替えると読み手の次の一手が変わる）。 */
function describeReportState(state: UnobservedReportState): string {
  switch (state) {
    case 'none':
      return (
        '⚠ 終端までに本文が1文字も届いていない。' +
        'この委譲が何をしたかは、この一覧からは1文字も読めない' +
        '（台帳の報告欄は一度でも届けば残る欄なので、「まだ読んでいない」ではなく「届いていない」である）。'
      );
    case 'failure-wrapped':
      return (
        '⚠ 届いている本文は runner が包んだエラー文であって報告ではない（Issue #714）。' +
        '中身を完遂の報告として読まないこと。'
      );
    case 'delivered':
      return (
        '⚠ 本文は届いているが、完遂した報告とは限らない。' +
        '終端の直前に「喋っただけの本文」がそのまま報告として出る経路が runner に在り、' +
        '台帳からはこの2つを区別できない。'
      );
  }
}

/**
 * {@link classifyUnobservedOutcome} の結果を、一覧と `manager_report` に添える
 * 1つの字面にする（Issue #857）。**対象外なら `null`——1文字も増やさない。**
 *
 * **字面の生成元はここ1箇所である。** `manager_list`（`tools.ts` の
 * `unobservedOutcomeLine`）と `manager_report` の両方がこれを使う——
 * `describeManagerFailure` / `describeManagerSystemError` / `describeDenials` と
 * 同じ理由（同じ欄を2つの口が別の語で呼ぶと、面をまたいで読む人間がそこで詰まる）。
 * **`digest.ts` に置いてあるのは `describeManagerState` と同じ層に揃えるため**で、
 * 将来 CLI / Web の面が同じ字面で出せる。
 *
 * **健全な（対象外の）委譲では `null` を返し、一覧は1文字も伸びない**——
 * 一覧は文字数の予算（`LIST_BUDGET`）に張り付いていて、行を1本増やすと出る件数が
 * 減る（`describeManagerFailure` の doc と同じ理由）。
 *
 * 🔴 **どの枝でも「成果が無い」と言い切らない。** `delivered` は「完遂した」
 * とは名乗らない——本文が届いたことと、それが完遂の報告であることは別である。
 */
export function describeUnobservedOutcome(manager: UnobservedOutcomeInput): string | null {
  const outcome = classifyUnobservedOutcome(manager);
  if (outcome === null) return null;
  return describeReportState(outcome.reportState);
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
  /**
   * この期間の日誌行の中に取り下げの行があれば、その理由（#963）。
   *
   * `answeredInWindow` と対称の欄。正常な経路では `answeredInWindow` と
   * 両方が同時に埋まることは無い（回答済みは取り下げられない。
   * `tools.ts` の `approval_withdraw` の doc）。
   */
  withdrawnInWindow: { reason: string; at: string } | undefined;
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
    let withdrawnInWindow = existing?.withdrawnInWindow;
    if (
      entry.withdrawnAt !== undefined &&
      (withdrawnInWindow === undefined || entry.at > withdrawnInWindow.at)
    ) {
      withdrawnInWindow = { reason: entry.withdrawnReason ?? '', at: entry.at };
    }
    byId.set(entry.approvalId, {
      approvalId: entry.approvalId,
      question: existing?.question ?? entry.question,
      managerId: existing?.managerId ?? entry.managerId,
      at: existing === undefined || entry.at > existing.at ? entry.at : existing.at,
      answeredInWindow,
      withdrawnInWindow,
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
  // **取り下げも回答と同じ「この期間で終端した」側**（#963）。回答と違い、
  // 取り下げは `pendingOnly` の窓から見ても人間の次の一手が無いので
  // （催促する相手がいない）、`pendingById.has` の枝より先に確かめる。
  if (group.withdrawnInWindow !== undefined) {
    return `取り下げ: ${brief(group.withdrawnInWindow.reason, 80)}`;
  }
  if (pendingById.has(group.approvalId)) {
    // 次の一手: 待つ／催促する。id は下の「人間の回答待ち」節と同じなので
    // 突き合わせられる。
    return '未回答（承認待ちキューに在る。下の「人間の回答待ち」に同じ id で出ている）';
  }
  // ここから先だけ、この1件について承認待ちキューを直接引く。`pendingById`
  // は未回答かつ未取り下げの分しか持たないので、「本当に無い」のか
  // 「答えが付いた／取り下げられて pendingOnly の窓から外れた」のかは、
  // これを呼ばないと分からない。
  const approval = await stores.jobs.getApproval(group.approvalId);
  if (approval !== null) {
    // **取り下げを先に見る。** `withdrawnAt` が付いた行は `answer` を
    // 持たないので、この判定を後回しにすると次の分岐の「回答の本文が無い
    // 記録——台帳の破損の可能性がある」に誤って落ちる（#963 で見つかった
    // ことそのもの——取り下げは破損ではない）。
    if (approval.withdrawnAt !== undefined) {
      // 次の一手: 無い（クローン自身が取り下げた。催促する相手がいない）。
      return (
        `この期間の日誌には取り下げ前の行しか無いが、承認待ちキューでは既に取り下げ済み` +
        `（この期間の外で取り下げられた）: ${brief(approval.withdrawnReason ?? '（理由の記録なし）', 80)}`
      );
    }
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

/** {@link summarizeExternalSources} が1発行元ぶんに作る行の材料。 */
interface ExternalSourceBreakdown {
  source: string;
  /** その発行元の `external_event` の総件数（日誌の行数）。 */
  count: number;
  /** `summary` の完全一致で数えた「本文の種類」の数。 */
  distinctSummaries: number;
  /** いちばん多い1種の件数。 */
  topSummaryCount: number;
}

/**
 * 外部イベントを **発行元（`source`）別**に集計する（Issue #783）。
 *
 * ## なぜ足すのか
 *
 * 上の件数行が「日誌の行数であって届いた合図の実数ではない」と名乗れても、
 * **どの発行元が何件か**が無ければ、そこから原因へ降りる経路が無い（15,047件の
 * 内訳を1件も測れない）。この関数は、その内訳を発行元別・件数の多い順で返す。
 *
 * ## 「本文の種類」は `summary` の**完全一致**で数える——それ以上は寄せない
 *
 * `entry.summary` はそのまま突き合わせる。`id` も `at` も `summary` には
 * 入らないので、同じ出来事なら普通は同じ文字列になる。**ただし
 * `renderPayload`（`apps/daemon/src/index.ts`）が作る `summary` は、末尾に
 * 可変の値（畳んだ件数など。`describeReopenedTokenNotice` の
 * 「この間に同じ合図が…件届き、1件にまとめた」がその一例）を持つことがある**
 * ⟹ 完全一致で数えると、実際には同じ出来事なのに違う「種類」として数えて
 * しまいうる（過大に分ける方向にしか倒れない——足りない方向には倒れない）。
 * **⛔ 正規化して寄せる実装はしない**——揺れを吸収しようとする判定を足すほど、
 * 「何をもって同じ本文としたか」がまた曖昧になる（この doc とその場の1行が、
 * その曖昧さを消す代わりに限界として言語化する）。
 */
function summarizeExternalSources(
  externals: readonly Extract<JournalEntry, { type: 'external_event' }>[],
): ExternalSourceBreakdown[] {
  const summariesBySource = new Map<string, string[]>();
  for (const entry of externals) {
    const list = summariesBySource.get(entry.source);
    if (list === undefined) summariesBySource.set(entry.source, [entry.summary]);
    else list.push(entry.summary);
  }

  const rows: ExternalSourceBreakdown[] = [];
  for (const [source, summaries] of summariesBySource) {
    const countBySummary = new Map<string, number>();
    for (const summary of summaries) {
      countBySummary.set(summary, (countBySummary.get(summary) ?? 0) + 1);
    }
    rows.push({
      source,
      count: summaries.length,
      distinctSummaries: countBySummary.size,
      topSummaryCount: Math.max(...countBySummary.values()),
    });
  }

  // **件数の多い順。** 原因へ降りる入口はいちばん件数の多い発行元であることが
  // 多いので、上位から出す（`MAX_ITEMS` で切ったときに落ちるのが少数派の
  // 発行元になるように）。
  rows.sort((a, b) => b.count - a.count);
  return rows;
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
 * 日誌の1種別ぶんを「正確な件数」と「新しい側から `DIGEST_RETAIN_LIMIT` 件
 * だけの保持」に分けて畳むための小さな器（issue #1283）。
 *
 * ## なぜ2つに分けるか
 *
 * 一覧に出す詳細は `MAX_ITEMS`（15）件で足りるが、`- 自分で決めたこと: N 件`
 * のような**件数の行はそれとは別に正確でなければならない**。件数を
 * 「保持した配列の `.length`」から取ると、保持の上限に当たった日だけ件数が
 * 静かに減る——AGENTS.md の地雷「一覧の上限を件数だけで決める」と同じ形の
 * 事故を、件数の表示側で起こすことになる。**カウンタ（`count`）は保持の
 * 上限に関係なく、走査で当たった行すべてに対して回す。**
 *
 * ## `desc` で走査する限り、`retained` は「保持の上限に当たっていなければ
 * 直す前と1文字も変わらない」
 *
 * `push` を呼ぶ順（＝走査の順）が新しい順である限り、`retained` の先頭
 * `MAX_ITEMS` 件は常に「本当に新しい `MAX_ITEMS` 件」と一致する——保持の
 * 上限（`retainLimit`）に当たっていなければ、`retained` は「直す前の
 * `entries.filter(type)`」とちょうど同じ中身・同じ順序になる。
 */
function createRetainBucket<T>(retainLimit: number) {
  const retained: T[] = [];
  let count = 0;
  return {
    push(entry: T): void {
      count += 1;
      if (retained.length < retainLimit) retained.push(entry);
    },
    get count(): number {
      return count;
    },
    get retained(): readonly T[] {
      return retained;
    },
  };
}

/**
 * 走査を `DIGEST_JOURNAL_SCAN_LIMIT` で打ち切ったときの断り書き（issue #1283）。
 *
 * **冒頭（`期間: …` の行のすぐ後）にだけ置く。** 各節の件数の行そのものは
 * 書き換えない——「読んだ範囲では正確」という性質は保ったまま
 * （`buildActivityDigest` 本体の doc）、この断りが「その範囲が窓の全部とは
 * 限らない」を1箇所で言う。
 *
 * **具体的な件数の値をここへ焼き込まない。** 定数の名前（
 * `DIGEST_JOURNAL_SCAN_LIMIT`）で指す——AGENTS.md「件数・版・sha などの数を
 * 生成物へ焼き込まない」。
 */
const JOURNAL_SCAN_TRUNCATED_NOTICE =
  '⚠ この期間の日誌が多く、走査を `DIGEST_JOURNAL_SCAN_LIMIT` 件で打ち切った。' +
  'これより下の件数・一覧は、日誌の新しい側から読んだ範囲のものである' +
  '（実際はもっと多い可能性がある）。新しい側から読んでいるので、新しいものは' +
  '1件も落ちていない——足りないとすれば古い側である。';

/**
 * `escalationGroups` の件数の行に足す注記（issue #1283）。
 *
 * **`escalation` だけは件数の意味が違う。** `escalationGroups` は
 * `approvalId` で束ねた**問いの数**で、束ねる前の行を全部見ないと正確に
 * 数えられない——他の型のように「走査で当たった行すべてを数えるカウンタ」
 * を持てない（束ねる前の生の行を、保持の上限を超えてまで持ち続けない限り）。
 * ⟹ **保持の上限（`DIGEST_RETAIN_LIMIT`）に当たった（＝ `escalation` の行を
 * 全部は保持していない）ときだけ、この注記を件数の行へ足す。** 当たって
 * いないときは、この関数は呼ばれた側で使われず、文面は1文字も変わらない。
 */
const ESCALATION_RETAIN_CAPPED_NOTICE =
  '（⚠ 束ねた元の行を全部は読んでいない。保持の上限に当たったので、この件数は少なく出ている可能性がある）';

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
  const sinceIso = window.since.toISOString();
  const untilIso = until.toISOString();

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

  // **境界を JS 側で切り直す理由。** `JournalQuery.until` は「以前＝含む」
  // （`store.ts` の `JournalQuery.until` の doc）だが、`DigestWindow.until`
  // は「含まない」（このファイル冒頭の doc）——意味が違う。クエリ側の
  // `until` は走査を早く打ち切るための粗い上限として渡し、正確な境界は
  // ここで `entry.at < untilIso` を掛けて決め直す。**二重に見えるが、
  // 片方だけでは足りない**——クエリ側を外すと OOM の本体（#1283）そのものに
  // 戻り、JS 側を外すと境界のミリ秒が1件ずれる。
  const withinWindow = (entry: JournalEntry): boolean => entry.at < untilIso;

  // **`exchange` は別の走査にする。** `JournalQuery.with` はストアの絞りと
  // して `exchange` にしか効かない契約（`store.ts` の doc）——残り5種別と
  // 1本のクエリに混ぜると、非 exchange 行に対する `with` の意味が契約に
  // 無いまま動く形になる。**この digest はどこにも `exchange` の詳細一覧を
  // 出していない**（下の集計で使うのは件数だけ）ので、保持する配列は要らず
  // 数えるだけでよい。
  let humanTurnsCount = 0;
  const exchangeScan = await scanJournalPages(
    stores.journal,
    { types: ['exchange'], with: ['human'], since: sinceIso, until: untilIso, order: 'desc' },
    (page) => {
      for (const entry of page) {
        if (entry.type !== 'exchange' || !withinWindow(entry)) continue;
        if (entry.role === 'inbound') humanTurnsCount += 1;
      }
    },
    { maxScanned: DIGEST_JOURNAL_SCAN_LIMIT },
  );

  // **残り5種別は1本の走査にまとめる。** `with` を渡さないので、上の
  // exchange 走査を分けた理由（`with` の契約）はここには当たらない——
  // `types` だけの絞りは3実装とも「その種別だけを返す」契約
  // （`JournalQuery.types` の doc）を持つ。
  const decisionBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'decision' }>>(DIGEST_RETAIN_LIMIT);
  const escalationBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'escalation' }>>(DIGEST_RETAIN_LIMIT);
  const memoryUpdateBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'memory_update' }>>(DIGEST_RETAIN_LIMIT);
  const externalBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'external_event' }>>(DIGEST_RETAIN_LIMIT);
  /**
   * ツール実行は**層で分ける**。
   *
   * クローンが自分の手で使った道具も同じ日誌へ落ちるようになった（#32）ので、
   * 1つの数にまとめると「委譲した量」として読める数がクローン自身の手の量で
   * 膨らむ（AGENTS.md「消費の層をモデル名で見分けるな ＝ 層は層の列で言う」と
   * 同じ話で、ここでの層の列は `actor` である）。**この数は digest を読む
   * クローン自身と日報の材料になるので、混ぜると委譲の判断がそのまま狂う。**
   *
   * **保持する配列は要らない。** `cloneToolUses` / `delegatedToolUses` は
   * この digest のどこにも詳細一覧を出さない（件数だけ）——だから
   * `createRetainBucket` ではなく素のカウンタでよい。
   */
  let cloneToolUsesCount = 0;
  let delegatedToolUsesCount = 0;

  const activityScan = await scanJournalPages(
    stores.journal,
    {
      types: ['decision', 'escalation', 'memory_update', 'external_event', 'tool_use'],
      since: sinceIso,
      until: untilIso,
      order: 'desc',
    },
    (page) => {
      for (const entry of page) {
        if (!withinWindow(entry)) continue;
        switch (entry.type) {
          case 'decision':
            decisionBucket.push(entry);
            break;
          case 'escalation':
            escalationBucket.push(entry);
            break;
          case 'memory_update':
            memoryUpdateBucket.push(entry);
            break;
          case 'external_event':
            externalBucket.push(entry);
            break;
          case 'tool_use':
            if (isCloneActor(entry.actor)) cloneToolUsesCount += 1;
            else delegatedToolUsesCount += 1;
            break;
        }
      }
    },
    { maxScanned: DIGEST_JOURNAL_SCAN_LIMIT },
  );

  // **打ち切ったのは、どちらの走査でもよい。** 2本は別のクエリなので独立に
  // 打ち切りうる——どちらか一方でも打ち切っていれば、この digest の件数・
  // 一覧は「読んだ範囲のもの」になる。
  const journalScanTruncated = exchangeScan.truncated || activityScan.truncated;

  const decisions = decisionBucket.retained;
  const decisionsCount = decisionBucket.count;
  // **`approvalId` で束ねる。** 日誌は追記専用なので、1つの問いに「聞いた」
  // 行と「答えた」行が別々に積まれる（`EscalationGroup` の doc）。束ねずに
  // 行ごとに描くと、同じ問いが「未回答」と「回答あり」の両方として並ぶ。
  // **束ねた後、`at` の降順に並べ直す**（`EscalationGroup.at` の doc）。
  // `journal.list()` の既定（`order: 'desc'`）が新しい順を契約として保証
  // するので、この並べ替えは通常 no-op だが、その契約への依存をこの関数の
  // 外（`journal-order-with-contract.ts`）へ置かず、ここで明示する
  // （同 doc に詳しい理由がある）。**束ねる材料は `escalationBucket.retained`
  // ——保持の上限に当たっていれば、束ねる前の行を全部は見ていない**
  // （`ESCALATION_RETAIN_CAPPED_NOTICE` の doc）。
  const escalationGroups = groupEscalations(escalationBucket.retained).sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const escalationRetainCapped = escalationBucket.count > escalationBucket.retained.length;
  const memoryUpdates = memoryUpdateBucket.retained;
  const memoryUpdatesCount = memoryUpdateBucket.count;
  const externals = externalBucket.retained;
  const externalsCount = externalBucket.count;

  // 走行中・返事待ちは期間の外で始まったものも「いまの状態」として要る
  // （判定は `isManagerInFlight`（このファイルの上）。**`manager_list` と同じ
  // 分け方を使うため、ここに書き下ろさない**——そちらの doc を参照）。
  const inFlight = isManagerInFlight;
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

  // **束ねた問いの数であって、日誌の行数ではない。** 1問に「聞いた」
  // 「答えた」の2行が付くことがあるので、行数をそのまま出すと二重に数える
  // （`escalationGroups` の doc）。**escalation だけは exact なカウンタを
  // 持たない**（束ねる前の行を全部見ないと正確に数えられないため。上の
  // `escalationRetainCapped` の doc）ので、保持の上限に当たっていたときだけ
  // `ESCALATION_RETAIN_CAPPED_NOTICE` を添える——当たっていなければ、この
  // 行は直す前と1文字も変わらない。
  const escalationCountLine =
    `- エスカレーション: ${escalationGroups.length} 件` +
    (escalationRetainCapped ? ESCALATION_RETAIN_CAPPED_NOTICE : '');

  const sections: string[] = [
    `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
    // **打ち切ったら、冒頭ですぐに名乗る。** `期間: …` の行のすぐ後——
    // 空行より前に置く（`JOURNAL_SCAN_TRUNCATED_NOTICE` の doc）。
    ...(journalScanTruncated ? [JOURNAL_SCAN_TRUNCATED_NOTICE] : []),
    '',
    `- 人間からの発言: ${humanTurnsCount} 件`,
    `- マネージャーへの委譲（この期間に動いたもの）: ${managers.length} 本`,
    `- 自分で決めたこと（日誌の decision）: ${decisionsCount} 件`,
    escalationCountLine,
    `- 記憶の更新: ${memoryUpdatesCount} 件`,
    // **日誌 external_event の行数であって、届いた合図の実数ではない**
    // （Issue #783）。受信箱を通った合図は配達のたびに1行書かれる —— 配り直しの
    // 回でも、畳んでターンを起こさない回でも同じ1行を書く（`clone.ts` の
    // `#journalIncomingBody` の doc。逐語は
    // `grep -Fn -- '配達のたびに書く' packages/core/src/clone.ts`）。加えて、
    // デーモンが受信箱を通さず直接書く行（source `runner` /
    // `boot-storage-footprint`。`apps/daemon/src/index.ts` と
    // `boot-footprint.ts`）も同じ型に混ざるので、「配達のたびに1行」は型全体には
    // 当てはまらない。発行元別の内訳は下の「届いた外部イベント」節にある
    // （`escalationCountLine` が「束ねた問いの数であって、日誌の行数ではない」と
    // 名乗るのと同じ形で、ここは逆に「日誌の行数であって合図の実数ではない」と
    // 名乗る）。
    //
    // **数えるのは `externalsCount`（走査で当たった全行）であって
    // `externals`（保持の上限で切られた側）ではない**（#1278 が分けた2つ）。
    // 上限に当たっている回に `externals.length` を出すと、この行が黙って
    // 少なく出る。
    `- 外部イベント（日誌 external_event の行数）: ${externalsCount} 件`,
    `- マネージャー・作業者のツール実行: ${delegatedToolUsesCount} 件`,
    `- あなた自身が手を動かした回数（委譲せずに使った道具）: ${cloneToolUsesCount} 件`,
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
      '## 引き受けたまま終わっていない仕事' +
        '（古い側と新しい側の両端。入り切らない分は真ん中を省く。' +
        '片付いたら `commitment_close` で閉じる）',
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
    // **両端を出す（古い側を捨てない。かつ合計は `MAX_ITEMS` のまま）。**
    // 古い未了は「本当に放置されているもの」を見せる材料なので、件数が
    // 増えても先頭から押し出して消してはいけない。一方で、今夜作られた
    // 行が直後から1件も見えないのも困る——だから古い側と新しい側の両方を
    // 少しずつ出す。**合計を増やさない**ために、片方を増やした分は必ず
    // もう片方から削る（`oldestCount + newestCount` は常に
    // `min(commitments.length, MAX_ITEMS)` に揃う。下の算出がそれを保証する）。
    //
    // 奇数分割は古い側へ1件多く渡す（`Math.ceil`）——「古い側を捨てない」を
    // 量でも優先する判断。`commitments` は `CommitmentStore.list()` の契約に
    // より `at` 昇順（古い順）で来るので、先頭が最古・末尾が最新である。
    const oldestCount = Math.min(commitments.length, Math.ceil(MAX_ITEMS / 2));
    const newestCount = Math.min(commitments.length - oldestCount, MAX_ITEMS - oldestCount);
    const shownOldest = commitments.slice(0, oldestCount);
    // `newestCount === 0` のとき（未了が `oldestCount` 件以下）は
    // `slice(commitments.length, commitments.length)` と同値で空配列になるが、
    // 意図を読み手に残すため明示の分岐にしておく。
    const shownNewest =
      newestCount === 0 ? [] : commitments.slice(commitments.length - newestCount);
    const shownTotal = shownOldest.length + shownNewest.length;
    // **重なりを作らない。** 上の算出で `oldestCount + newestCount` は
    // `commitments.length` を超えないので、`shownOldest` と `shownNewest` の
    // 範囲（`[0, oldestCount)` と `[length-newestCount, length)`）は
    // 境界が一致するか離れるかのどちらかで、交差しない（同じ id が2回
    // 出ない）。`commitments.length <= MAX_ITEMS` のときは2範囲が隙間なく
    // 連続して全件を覆い、`commitments.length > MAX_ITEMS` のときだけ
    // 真ん中に隙間ができる。
    const renderCommitment = (entry: (typeof commitments)[number]) =>
      `- ${entry.id}（${entry.at} / ${entry.origin}${entry.source === undefined ? '' : ` / ${entry.source}`}）` +
      `\n  ${brief(entry.body)}`;
    for (const entry of shownOldest) {
      sections.push(renderCommitment(entry));
    }
    // **省いたのは古い側でも新しい側でもなく真ん中である。** 両端を出す形に
    // 変える前は「先頭から `MAX_ITEMS` 件」だったので、省かれるのは常に
    // 新しい側だった。両端を出す以上、省略の断り書きもそれに合わせて
    // 「真ん中を省いた」と言う必要がある——末尾に1行付けるだけだと「新しい側
    // の続きを省いた」に見えてしまうので、古い側の列と新しい側の列の**間**に
    // 置く（AGENTS.md `.claude/skills/listing-and-detail/SKILL.md`——
    // 「切ったなら必ず `omitted()` を通すこと」「続きの取り方を書く」）。
    sections.push(
      ...omitted(
        commitments.length,
        shownTotal,
        '真ん中を省いている。`commitment_list`（古い順で辿れる）でその区間も見られる。' +
          'あちらも入る分までで、残りの件数が本文に出る',
      ),
    );
    for (const entry of shownNewest) {
      sections.push(renderCommitment(entry));
    }
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
          (job.lastReport === undefined ? '' : `\n  直近の報告: ${brief(job.lastReport)}`) +
          describeLastFailureLine(job.lastFailure),
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

  if (decisionsCount > 0) {
    sections.push('', '## 聞かずに決めたこと');
    const shownDecisions = decisions.slice(0, MAX_ITEMS);
    for (const entry of shownDecisions) {
      sections.push(`- ${entry.at} ${brief(entry.decision)}（根拠: ${brief(entry.grounds, 80)}）`);
    }
    sections.push(...omitted(decisionsCount, shownDecisions.length, journalWhere('decision')));
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

  if (memoryUpdatesCount > 0) {
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
      ...omitted(memoryUpdatesCount, shownMemoryUpdates.length, journalWhere('memory_update')),
    );
  }

  if (externalsCount > 0) {
    sections.push('', '## 届いた外部イベント');
    // **なぜ実数ではないか、をここでも1行で言う。** 上の件数行は単位（日誌の
    // 行数）だけを名乗り、理由はここに置く——1行を長くしすぎないための分け方
    // （行と節、両方の doc を参照）。
    sections.push(
      'この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行' +
        '書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を' +
        '通さず直接書く行（source `runner` / `boot-storage-footprint`）も混ざる。',
    );
    const shownExternals = externals.slice(0, MAX_ITEMS);
    for (const entry of shownExternals) {
      sections.push(`- ${entry.source}: ${brief(entry.summary, 120)}`);
    }
    sections.push(
      ...omitted(externalsCount, shownExternals.length, journalWhere('external_event')),
    );

    // **発行元別の内訳（Issue #783）。** 15,047 件がどの発行元のものかが分から
    // なければ、そこから原因へ降りる経路が無い。既存の個別行・`omitted()` の
    // 行は消さず、ここに足すだけ（`summarizeExternalSources` の doc）。
    // **⚠ 内訳は `externals`（保持の上限で切られた側）から作る。** 上の件数行は
    // `externalsCount`（走査で当たった全行）なので、上限に当たった回は
    // **内訳の合計が件数行に届かない**。⟹ 届かない回だけ、そう名乗る
    // （`ESCALATION_RETAIN_CAPPED_NOTICE` と同じ形。当たっていない回は1文字も
    // 増えない）。⛔ 黙って少ない合計を出さない——この節そのものが
    // 「何を数えた値か言わない数」を無くすために在る（Issue #783）。
    const bySourceCapped = externals.length < externalsCount;
    sections.push(
      '',
      '**発行元（source）別の件数** —— 「本文の種類」は `summary` の完全一致で数える' +
        '（末尾に畳んだ件数などの可変値が付くことがあるため、完全一致は同じ出来事を' +
        '過大に分けうる。正規化はしていない）。' +
        (bySourceCapped
          ? `⚠ 保持の上限に当たったので、この内訳が見ているのは ${externalsCount} 件中の` +
            ` ${externals.length} 件（新しい側）だけである——合計は上の件数行に届かない。`
          : ''),
    );
    const bySource = summarizeExternalSources(externals);
    const shownBySource = bySource.slice(0, MAX_ITEMS);
    for (const row of shownBySource) {
      sections.push(
        `- ${row.source}: ${row.count} 件（同じ本文は ${row.distinctSummaries} 種。` +
          `最も多い1種が ${row.topSummaryCount} 件）`,
      );
    }
    sections.push(
      ...omitted(
        bySource.length,
        shownBySource.length,
        `${journalWhere('external_event')}（source では絞れない。読み出した行を自分で ` +
          'source ごとに数える）',
      ),
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

  const summary = summarizeUsage(aggregate.rows, aggregate.turnRows);
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
