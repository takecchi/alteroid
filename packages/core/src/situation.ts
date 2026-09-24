// **`lost` の判定はここで書き下ろさない**（#688）。`isManagerInFlight` の隣に
// 置いた同じ形の述語から取る——`manager_list` の並び（`tools.ts`）も同じものを
// 見るので、2箇所に `status === 'lost'` を書くと *分け方* が割れる（あちらの doc）。
import { isManagerAwaitingJudgement } from './digest.js';
import {
  INBOX_BACKLOG_LOUD_THRESHOLD,
  describeInboxBacklogQueuedInMemory,
  foldInboxBacklogByType,
} from './inbox-backlog.js';
import type { InboxBacklogBreakdown } from './inbox-backlog.js';
import type { ManagerSummary } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { CooldownSource } from './token-pool.js';
import { RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN } from './usage-limits.js';

/**
 * クローンのターンの入口（`clone.ts` の `#runTurn`）に載せる「いまの全体」。
 *
 * ## なぜ在るのか（この節が塞いでいる穴）
 *
 * **クローンは、自分が空いていることに気づけない。** 実測（2026-09-05）で、
 * runner 3台が `connected` のまま `runner_list` の47本のマネージャーが全部
 * `[done]` で、能動的に動いていたのは1本だけだった。それでもクローンの側には
 * 何も見えていない——クローンを起こす合図は7型あり、そのうち**全体が載るのは
 * digest を持つ3つ（日報・継続中の依頼・発意 tick）だけ**で、`manager_message`
 * （報告・質問・許可確認）のプロンプトには稼働本数も器の状態も1文字も入らない。
 * 終端（最後の `report`）に至っては、それが最後だということすら伝えない。
 *
 * ## 置き場所は「ターンの入口」である
 *
 * `clone.ts` の `#notices`（`clone-notices.ts` の `CloneNotices`。`TurnNoticeKey`
 * の `redelivery` / `commitment`）が逐語で持っている理由と同じ——**プロンプトの
 * 組み立ては起点の数だけ散っていて、どれか1か所へ
 * 入れ忘れると、その起点にだけ全体の見えないターンが生まれる。ターンの入口は
 * 1か所しかない。**
 *
 * ## `#commitmentNoticeFor` に混ぜない
 *
 * あちらは**台帳**（引き受けたまま終わっていない仕事）の話で、こちらは
 * **委譲と器の現在の状態**の話である。材料の器も、読めなかったときの倒れ先も
 * 違う（あちらは空文字を返してターンを進める＝節が消える。こちらは
 * 「数えられなかった」と書いた行を必ず出す。下の {@link describeSituationUnavailable}）。
 * `turn-input.ts` が逐語で言う「**規則が違うものを同じ場所に置かない**」に従い、
 * 別の組み立て関数として隣に置く。
 *
 * ## 「空き枠」を作らない（north_star 禁止2）
 *
 * クローンからは「枠がいくつ空いているか教えてほしい」と要望が出ているが、
 * **この repo に「枠」「定員」は意図的に存在しない。** `runner-protocol.ts` は
 * 資源の欄を `capacity` と名付けないことを逐語で意図だと書いており、
 * `apps/runner/src/app.ts` の `/health` は「あと何本置けるか」に答えないと書き、
 * `runner-count-equivalence.test.ts` は「定員で断らない」を歯で固定している。
 * **⟹ ここが出すのは観測値の軸だけである**——「手が空いている」は「置ける」
 * ではなく「そのマネージャーが手を動かしていない」であって、置けるかどうかは
 * 1文字も答えない。
 *
 * ## 指図を書かない
 *
 * 「空いているから何か始めろ」「新しい委譲を置け」の類は1文字も書かない。
 * 出すのは**数と、その数が何を意味しないかの断り**だけで、何をするかは
 * クローンが記憶と台帳に照らして決める（`#commitmentNoticeFor` が
 * 「どれを先にやるかは……毎回決め直すこと」と書いているのと同じ線である）。
 *
 * ## 起床を増やさない
 *
 * ここが足すのは**既に走ると決まったターンの本文**だけである。新しい受信箱
 * イベントも、新しい `post` も、新しいポーラーも1つも足していない。
 */

/** ターンの入口へ載せる節の先頭（後から grep で全部拾えるように固定する）。 */
const SITUATION_HEAD = '[system] いまの全体';

/**
 * 節が**いつ数えた値か**を名乗る短い形（UTC の時刻だけ。#902）。
 *
 * ## なぜ要るのか —— 節は1つではない。**セッションに溜まる**
 *
 * この節は `clone.ts` の `#runTurn` が `#pushInput` で**ユーザー入力の本文へ
 * 連結する**。⟹ **会話履歴に残る。** ターンが N 回走れば、文脈には N 個の
 * 「いまの全体」が並ぶ。**そしてどれも現在形で断定する。**
 *
 * ⟹ 🔑 **読む側には、どれがいちばん新しいのかを節の中から判定する手段が
 * 1つも無かった。** 数が変わっていなければ、古い節と新しい節は**1バイトも
 * 違わない**（#902 の実測）。
 *
 * ## ⚠️ 「この行を組んだ時点では」という*言い回し*では、これは直らない
 *
 * PR #898 が新しい行（有効性の断り書き）で採ったのはその形で、**1つの行が
 * 自分の断定を弱める**目的には足りている。**しかしこの節の欠陥は断定の強さ
 * ではなく、`同じ顔をした節が複数ある`ことである** —— 全部が「組んだ時点では」
 * と名乗っても、**どれがいちばん新しいかは依然として分からない。**
 * ⟹ **区別を作れるのは、実際に違う値を持つ時刻そのものだけである。**
 *
 * ## ⚠️ 秒までしか出さない（そして日付を出さない）
 *
 * **同じ秒に2つの節が積まれれば、やはり区別が付かない。** 実運用のターンは
 * 秒〜分の間隔なので実害は無いと踏んでいるが、**「必ず区別できる」とは
 * 書かない。** 日付を出さないのも同じ割り切りで、**24時間ちょうど離れた2つの
 * 節は取り違えうる**（1つの文脈窓にそれが起きるとは考えていない）。
 * ⟹ どちらも**毎ターンの文字数を増やさない**ことを優先した結果である。
 *
 * **`clone.ts` の他の毎ターン注入節（#960）にも同じ形で使う。** #960 は
 * `#commitmentNoticeFor` / `#mergedBatchTruncationNoticeFor` が「現在形で
 * 断定し、時刻を1文字も名乗らない」まま残っていたのを見つけた —— 直し方は
 * 上の「言い回しだけでは直らない」という結論のとおり、この関数が作る具体的な
 * 時刻の値を埋めることである。**同じ判定関数を2つ持つと、片方だけ直して
 * 忘れる形が再発する**（この関数が直したのはまさにその再発である）ので、
 * ここから export して使い回す。
 */
export function readAtLabel(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)}Z`;
}

/**
 * `lost` の区分の見出し（#688）。**`status` の綴りを括弧で添える。**
 *
 * ここを読んだクローンが次にやるのは `manager_list status:["lost"]` である
 * （#689 で入った到達口）。**引数に渡す綴りが本数の隣に無いと、日本語の見出しから
 * `status` の値を推測することになる。**
 */
const LOST_LABEL = '戻れなかった(lost)';

/**
 * `lost` が1本以上あるときだけ出す1行（#688）。**本数の直後に置く。**
 *
 * ## この行が答える問いは「終わったか」ではなく「確かめたか」である
 *
 * `lost` が観測したのは「前のセッションへ戻れなかった」の1点だけで、**成果が
 * リモート（PR・ブランチ・コミット）まで届いていることがある**（`schema.ts` の
 * `jobStatusSchema` の doc / `digest.ts` の `isManagerAwaitingJudgement` の doc に
 * 出典。実際に、落ちる1分半前に PR をマージまで済ませていた1本が `lost` になった）。
 * ⟹ **人間・クローンがリモートを確かめるまで終われない。**
 *
 * ## ⚠️ 「起こし直せ」と書かないこと
 *
 * 確かめる前に `manager_start` を撃つと**同じ仕事が2本になる**（`manager_list` の
 * `lost` の行が同じ順序で言っている）。だからここが名指しするのは
 * **確かめる順序**までで、その先の判断は書かない（このファイル冒頭「指図を書かない」）。
 *
 * ## なぜ本数ではなく到達口を書くのか
 *
 * 本数だけを出すと、**名指しできない**。`manager_report` は `managerId` を要求
 * するが、`manager_list` の本文は文字数の予算（`LIST_BUDGET`）で切られるので、
 * 古い `lost` の id は本文に出ないことがある（#688 の実測: 台帳 10,000 本で
 * 本文に出たのは 12 件）。**`status` で絞れば予算より前に効く**（#689）ので、
 * 絞りの綴りをここで渡す。
 */
const LOST_NOTICE =
  `**${LOST_LABEL} は「終わった」ではない。** 見ているのは「前のセッションへ戻れたか」だけで、` +
  '**成果の有無は1度も観測していない** — 落ちる前にリモート（PR・ブランチ・コミット）まで' +
  '届いていた実例がある。⟹ 誰かがそこを確かめるまで終われない。' +
  '名指しで引くなら `manager_list` に status: ["lost"] を渡す（絞りは文字数の予算より前に効くので、' +
  '古いものも本文に出る）。中身は `manager_report <managerId>` で読める。' +
  RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN;

/**
 * **直近の1ターンが報告ではなく失敗で終わっている**という軸の見出し（#1212）。
 *
 * **`status` の区分ではない。** 軸の実体は `ManagerSummary.lastFailure` で、
 * これは `status` と独立に立つ——枠(429)で畳まれた回もセッションは生きている
 * ので `status` は `done` のままである（`manager.ts` の `lastFailure` の doc
 * 「**`status` と混ぜない。**」）。**だから `status` では切り出せない。**
 */
const LAST_FAILURE_LABEL = '直近のターンが失敗で終わっている';

/**
 * `lastFailure` が立っている委譲が1本以上あるときだけ出す1行（#1212）。
 * **`LOST_NOTICE` と同じ作法**——本数の直後に置き、指図は書かない。
 *
 * ## この行が塞ぐ穴は「届いていない」ではなく「同じ本文の中で食い違う」である
 *
 * 委譲ごとの ⚠ 行は既に2面が出している（`tools.ts` の `describeManagerFailure`
 * ＝ `manager_list` の各行、`digest.ts` の `describeLastFailureLine` ＝ tick と
 * 日報に載る digest の行）。**どちらも `status` を読まない**ので、枠(429)で
 * 畳まれた委譲にも ⚠ が付く。
 *
 * ⟹ 🔑 **欠けていたのは集計の側だけだった。** この節の数え上げ
 * （{@link countManagerSituation}）は `lastFailure` を1度も見ないので、同じ
 * 委譲が**同じターンの本文の中で**「`⚠ 直近のターンは失敗で終わっている`」と
 * 「`手が空いている` の1本」として並ぶ。**読み手はそこで数のほうを採る**
 * ——数は全体を名乗り、⚠ は1本ぶんにしか見えないからである（#1212 の実測:
 * `手が空いている 61` の大半が、枠で落ちて空の報告しか持っていない委譲だった）。
 *
 * ## ⚠️ `idle` から外さない
 *
 * 外すと「置けない」と読まれ、このファイル冒頭の「空き枠を作らない」を壊す
 * （`idle` は「そのマネージャーが手を動かしていない」という観測値で、それ自体は
 * 正しいままである）。**直すのは分類ではなく、その数が何を含むかの名乗りである。**
 *
 * ## なぜ到達口を書くのか
 *
 * `LOST_NOTICE` と同じ理由で、本数だけでは名指しできない。**ただし `lost` と
 * 違い、この軸には絞りの綴りが無い**——`status` の値ではないので
 * `manager_list status: [...]` では切り出せない。⟹ 引けるのは各行の ⚠ であり、
 * **そう書くこと自体が「status で切り出せる」という誤読を塞ぐ。**
 */
const LAST_FAILURE_NOTICE =
  `**${LAST_FAILURE_LABEL}委譲は、区分の中では見分けが付かない。** ` +
  'とくに `done`（手が空いている）が数えているのは「ターンが1回終わった」ことだけで、' +
  'そのターンが枠(429)などの失敗で畳まれた回も同じ `done` に座る' +
  '——セッションは生きているので `status` は動かさない（それは仕様である）。' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ' +
  '名指しで引くなら `manager_list` の各行に付く ⚠（`直近のターンは報告ではなく失敗で終わっている`）を見る' +
  '——**この軸で絞る綴りは無い**（`status` の値ではないので絞りでは切り出せない）。' +
  '中身は `manager_report <managerId>` で読める。';

/**
 * **枠（利用上限）で止まっている**という軸の見出し（#1212 残件2）。
 *
 * **`lastTurnFailed` とは別の軸である。** あちらの実体は
 * `ManagerSummary.lastFailure`——理由を問わずターンが失敗で終わったことを
 * 指す広い印。こちらの実体は `ManagerSummary.usageStoppedAt`——**利用上限
 * そのものに当たった**ことだけを指す狭い印（`usage_notice` の
 * `kind === 'reached'`。`manager.ts` の `#usageStopped` の doc）。
 *
 * ## `lastTurnFailed` との重なり方 —— 決めたこと（排他にしない）
 *
 * **同じ委譲が両方の軸に数えられることを許す。** `manager.ts` の
 * `case 'report'` は、ターンが失敗で終わった回（`event.failure` 在り）は
 * `lastFailure` だけを書いて `usageStoppedAt` には触れず、ターンが成功した
 * 回（`event.failure` 無し）だけが両方を同じ分岐で一緒に下ろす
 * （`ManagerSummary.usageStoppedAt` の doc）。⟹ **`done` に落ち着いた時点で
 * `usageStoppedAt` が残っているなら、直前の報告は必ず失敗だった**——だから
 * 利用上限で止まった委譲は、通常 `lastTurnFailed` 側にも数えられる。
 * **逆は成り立たない**——`lastFailure` は利用上限以外の理由（他の 429・
 * SDK のクラッシュ等）でも立つので、`lastTurnFailed` のほうが常に広い。
 *
 * **走行中は重ならないことがある。** `usage_notice` はターンの途中でも
 * 届く（`manager.ts` の `#usageStopped` の doc「ターンの途中でも届く」）ので、
 * まだ `report` が来ていない回では `usageStoppedAt` だけが先に立ち、
 * `lastFailure` は前のターンの値（無いこともある）のままである。
 *
 * ⟹ **どちらか一方の集計からもう一方を推測しない。** 2本は独立に数える。
 */
const USAGE_STOPPED_LABEL = '枠(利用上限)で止まっている';

/**
 * `usageStoppedAt` が立っている委譲が1本以上あるときだけ出す1行（#1212
 * 残件2）。**`LAST_FAILURE_NOTICE` と同じ作法**——本数の直後に置き、
 * 指図は書かない。
 *
 * ## この行が塞ぐ穴 —— 残件2がそのまま指した欠落
 *
 * PR #1246（`lastTurnFailed` / `lastTurnFailedIdle`）が閉じたのは「同じ
 * 本文の中で `lastFailure` の ⚠ 行と `idle` の数が食い違う」だけで、
 * **「枠で止まっている」を直接名乗る軸はまだ無かった**（#1212 の
 * 2026-09-19 コメント）。`lastTurnFailed` は理由を問わない広い軸なので、
 * それだけでは「利用上限に当たったのか、それとも別の理由で失敗したのか」を
 * 読み手は選べない——`usage_notice`（`manager_list` の各行・digest には
 * まだ載らない。`manager_report` の本文を読むしかない）を直接名指しする
 * 軸をここに足す。
 *
 * ## ⚠️ `idle` から外さない
 *
 * `LAST_FAILURE_NOTICE` と同じ理由——外すと「置けない」と読まれ、この
 * ファイル冒頭の「空き枠を作らない」を壊す。
 */
const USAGE_STOPPED_NOTICE =
  `**${USAGE_STOPPED_LABEL}委譲は、区分の中では見分けが付かない。** ` +
  '鍵が回ってこの委譲が起こし直されるまで、その間ずっと `done`（手が空いている）または' +
  '`running` のまま座る——セッションは生きているので `status` は動かさない（それは仕様である）。' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ' +
  `${LAST_FAILURE_LABEL}（上）と重なることが多いが同じ軸ではない` +
  '——あちらは失敗の理由を問わない全体、こちらは利用上限に当たった委譲だけを名指しする。' +
  '中身は `manager_report <managerId>` で読める' +
  '——**この軸で絞る綴りは無い**（`status` の値ではないので絞りでは切り出せない）。';

/**
 * 委譲の数え上げ。**6つの区分は同じ1回の数え上げの「分割」である**——どの
 * マネージャーもちょうど1つに入り、合計は `total` に一致する。
 *
 * **区分は 5 → 6 になった（#688 で `lost` を `other` から分けた）。** 数を足す
 * ときは、この doc の「6つ」と歯（`situation.test.ts` の合計の歯）も一緒に直す
 * こと——**合計が `total` に一致するという性質そのものが、この型の契約である。**
 *
 * **横断する軸は分割ではない**——`reachable`（話しかけられる）、#1212 で
 * 足した `lastTurnFailed` / `lastTurnFailedIdle`（直近のターンが失敗で終わって
 * いる）、#1212 残件2で足した `usageStopped` / `usageStoppedIdle`（枠で止まって
 * いる）の5つがそれで、走行中でも返事待ちでも立ちうる。**6つの区分と
 * 足し合わせないこと。**
 */
export interface ManagerSituationCounts {
  readonly total: number;
  /** `status === 'running'` かつ `awaitingBackground === undefined`。**「進んでいる」ではない**（`describeManagerCounts` と同じ断り）。 */
  readonly running: number;
  /** `status === 'waiting_human'`。 */
  readonly waitingHuman: number;
  /**
   * 背景処理（`run_in_background` の子・作業者への委譲）の完了待ちで畳んだ報告が
   * 握り潰されているもの（`ManagerSummary.awaitingBackground`）。
   *
   * **器が名乗った分だけである。** この欄を送らない古い runner では、実際に
   * 待っていてもここには数えられない（`runner-protocol.ts` の
   * `report.awaitingBackground` の `.optional()` の doc）。
   */
  readonly awaitingBackground: number;
  /**
   * **手が空いている**＝ `status === 'done'` かつ背景処理待ちではなく、かつ
   * `live`（このデーモンから話しかけられる）。
   *
   * **「置ける」ではない。** 置けるかどうかはこの数からは決まらない
   * （このファイル冒頭の「空き枠を作らない」）。
   */
  readonly idle: number;
  /**
   * **判断待ち**（`status === 'lost'`。#688）。`other` から分けてある。
   *
   * **これは「終わった」ではない。** `lost` が観測したのは「前のセッションへ
   * 戻れなかった」の1点だけで、**成果の有無は1度も見ていない**——落ちる直前に
   * PR をマージまで済ませていた実例が在る（`digest.ts` の
   * `isManagerAwaitingJudgement` の doc に出典）。⟹ 人間・クローンがリモートを
   * 確かめるまで終われない。
   *
   * **だから `failed` / `stopped` と同じ袋に入れない。** あの2つに「成果の有無を
   * 観測していない」という記述は repo 内に0件で、`lost` だけが持つ。
   */
  readonly lost: number;
  /**
   * 上の5つのどれでもないもの（`failed` / `stopped` と、`done` だが
   * 話しかけられないもの）。
   *
   * **`lost` はもうここに入らない**（#688 で分けた）。畳んでいたあいだ、
   * `lost` の本数は**どの面からも読めなかった**——毎ターン載るこの節では
   * `other` に潰れ、`describeManagerCounts`（`tools.ts`）は1度も数えていなかった。
   */
  readonly other: number;
  /** `live` が立っているもの（**上の6つと足し合わせない**。横断する軸である）。 */
  readonly reachable: number;
  /**
   * **直近の1ターンが報告ではなく失敗で終わっているもの**（`ManagerSummary.lastFailure`
   * が立っている本数。#1212）。**`reachable` と同じく、6つの区分と足し合わせない
   * 横断する軸である**——`lastFailure` は `status` と独立に立つので、走行中にも
   * 手が空いているものにも重なりうる。
   *
   * **区分にしない理由は分類の正しさではなく、読ませたい向きである。** `done` の
   * まま座っているのは仕様どおりで（`manager.ts` の `lastFailure` の doc）、
   * `idle` から外すと「置けない」と読まれる（このファイル冒頭「空き枠を作らない」）。
   * ⟹ 数え直すのではなく、**同じ本数に別の軸を1本添える。**
   *
   * **`lastUnreported` / `lastSystemError` は数えない。** `manager.ts` が
   * 「**軸が違う**」と逐語で分けている別の欄で、委譲ごとの ⚠ 行
   * （`tools.ts` / `digest.ts`）もそれぞれ別の字面で出す。ここで畳むと、
   * 本数と ⚠ 行が**また**食い違う（この欄が塞いだ穴そのものを作り直す）。
   */
  readonly lastTurnFailed: number;
  /**
   * `lastTurnFailed` のうち、**この数え上げで `idle`（手が空いている）に入った
   * もの**（#1212）。**`lastTurnFailed` の部分集合である**（`0 <=
   * lastTurnFailedIdle <= lastTurnFailed`）。
   *
   * **2つに割ってあるのは、食い違いが起きる場所が `idle` だからである。**
   * 走行中の委譲に前のターンの `lastFailure` が残っているのは「いま動いている」
   * と矛盾しない（次の `report` で消える）。**矛盾するのは「手が空いている」と
   * 並んだときだけ**なので、そこを名指しで数える。
   */
  readonly lastTurnFailedIdle: number;
  /**
   * **枠（利用上限）で止まっているもの**（`ManagerSummary.usageStoppedAt` が
   * 立っている本数。#1212 残件2）。**`lastTurnFailed` と同じく、6つの区分と
   * 足し合わせない横断する軸である**——`usageStoppedAt` は `status` と独立に
   * 立つので、走行中にも手が空いているものにも重なりうる。
   *
   * **`lastTurnFailed` とは別の軸。重なりは許すが、包含関係を型では固定
   * しない。** 決めた経緯は {@link USAGE_STOPPED_NOTICE} の doc。要点だけ:
   * `done` に落ち着いた時点でこの数に残っているなら、直前の報告は必ず
   * 失敗だった（⟹ 通常は `lastTurnFailed` 側にも数えられる）が、走行中は
   * `usage_notice` がターンの途中で先に届くことがあり、その回はまだ
   * `lastFailure` が立っていない——**片方からもう一方を計算しない。**
   */
  readonly usageStopped: number;
  /**
   * `usageStopped` のうち、**この数え上げで `idle`（手が空いている）に入った
   * もの**（#1212 残件2）。`lastTurnFailedIdle` と同じ理由で分けてある——
   * 矛盾するのは「手が空いている」と並んだときだけなので、そこを名指しで
   * 数える。
   */
  readonly usageStoppedIdle: number;
}

/**
 * `ManagerSummary` の並びを数える。**分類は上から順に「最初に当たったもの」で
 * 決め、区分どうしを重ねない。**
 *
 * **背景処理待ちを `status` より先に見る。** `case 'report'`（`manager.ts`）は
 * `record.job.status = event.status;` を `awaitingBackground` の分岐より前に
 * 実行するので、握り潰された回の `status` は必ず `'done'` へ潰れている——
 * `status` を先に見ると、この区分が `idle`（手が空いている）へ吸い込まれて
 * **この節が答えようとしている問いそのものが消える。**
 *
 * **`lost`（判断待ち）は背景処理待ちより後ろで見る（#688）。** 理由は同じ
 * 順序の話である——握り潰しの印が立っている委譲は、`status` が何であっても
 * まず「背景処理待ち」として数える。`lost` を先に見ると、印が立ったまま
 * `lost` へ落ちた回で握り潰しのほうが消える。
 *
 * **`other` の直前に置いてある**のは、`lost` が `other` から**切り出した**もの
 * だと読める順にするためである（`idle` との前後は結果を変えない——`lost` は
 * 定義上 `done` ではないので、どちらの順でも同じ数になる。**入れ替えても緑に
 * なるので、この順序そのものは歯では測れていない**）。
 */
export function countManagerSituation(managers: readonly ManagerSummary[]): ManagerSituationCounts {
  let running = 0;
  let waitingHuman = 0;
  let awaitingBackground = 0;
  let idle = 0;
  let lost = 0;
  let other = 0;
  let reachable = 0;
  let lastTurnFailed = 0;
  let lastTurnFailedIdle = 0;
  let usageStopped = 0;
  let usageStoppedIdle = 0;
  for (const manager of managers) {
    if (manager.live) reachable += 1;
    // **区分の分岐より前に数える（#1212 / 残件2）。** 横断する軸なので
    // `else if` の鎖に混ぜない——混ぜると、どの区分に入ったかでこの軸が落ちる。
    if (manager.lastFailure !== undefined) lastTurnFailed += 1;
    if (manager.usageStoppedAt !== undefined) usageStopped += 1;
    if (manager.awaitingBackground !== undefined) awaitingBackground += 1;
    else if (manager.status === 'running') running += 1;
    else if (manager.status === 'waiting_human') waitingHuman += 1;
    else if (manager.status === 'done' && manager.live) {
      idle += 1;
      // **`idle` の枝の中で数える（#1212 / 残件2）。** 外側で
      // `status === 'done' && live` を書き直すと、上の鎖の順序（背景処理待ちを
      // 先に見る）と割れる——握り潰された回は `status` が `'done'` へ潰れて
      // いるので、条件だけを写すと `awaitingBackground` の分までここへ
      // 数えることになる。
      if (manager.lastFailure !== undefined) lastTurnFailedIdle += 1;
      if (manager.usageStoppedAt !== undefined) usageStoppedIdle += 1;
    } else if (isManagerAwaitingJudgement(manager.status)) lost += 1;
    else other += 1;
  }
  return {
    total: managers.length,
    running,
    waitingHuman,
    awaitingBackground,
    idle,
    lost,
    other,
    reachable,
    lastTurnFailed,
    lastTurnFailedIdle,
    usageStopped,
    usageStoppedIdle,
  };
}

/**
 * 「直近」の窓の長さ（ミリ秒。#1103 案1）。
 *
 * ## なぜ3時間か
 *
 * #1103 の実測は、走行中の委譲が実質1本のまま**4時間36分**誰も気づかなかった、
 * というものだった。この窓を実測と同じか長く取ると、その停滞のあいだ一度も
 * 「直近◯時間に0本」という値が出ないまま眠り続ける回が生まれる。⟹ **実測
 * （4時間36分）より意図して短く**取ってある——低稼働が#1103の事故の水準へ
 * 育つ前に、少なくとも1回は「0本」という値を見せるためである。
 *
 * ## 閾値ではなく本数だけを出す（案2・案3は入れていない）
 *
 * #1103 の「期待する挙動」には3つの案があった——
 * (1) 直近N時間に新しく起こした委譲の本数、
 * (2) 走行中が1本以下だった連続時間に閾値を引いて ⚠ を立てる、
 * (3) 直近N時間に片付いた仕事（`commitment_close`）の件数。
 * **ここで実装するのは案1だけである。** 案2・案3は意図して入れていない——この
 * ファイル冒頭の「空き枠を作らない」「指図を書かない」と同じ理由で、閾値と ⚠ を
 * 持たせた瞬間、この節は「低稼働を判定する」側へ回ってしまう。出すのは数え
 * 上げの材料だけで、それが合図かどうかの判定はクローンに委ねる——0 本という
 * 値そのものが、閾値なしで既に合図である（{@link countRecentManagerStarts}
 * の doc）。
 */
export const RECENT_MANAGER_START_WINDOW_MS = 3 * 60 * 60 * 1000;

/** {@link RECENT_MANAGER_START_WINDOW_MS} を文中に出すための時間数。 */
const RECENT_MANAGER_START_WINDOW_HOURS = RECENT_MANAGER_START_WINDOW_MS / (60 * 60 * 1000);

/**
 * 直近 {@link RECENT_MANAGER_START_WINDOW_MS} に `manager_start` した委譲の
 * 本数を数える（#1103 案1）。
 *
 * ## 何を見るか
 *
 * `ManagerSummary.startedAt`（＝ `Job.createdAt`。`manager.ts` の `summaryOf`
 * が `startedAt: job.createdAt` として写す欄）が `[at - 窓, at]` に入るものを
 * 数える。
 *
 * ## `at` は呼び出し側の観測時刻をそのまま使う
 *
 * この関数は `Date.now()` を自分では呼ばない。**`describeSituation` が既に
 * 持っている `at`**（呼び出し側が渡した観測時刻、渡さなければ `Date.now()`。
 * {@link readAtLabel} が名乗る時刻と同じもの）をそのまま受け取る——ここで
 * 独自に時刻を引き直すと、この節が名乗る「いつ数えたか」と、この本数が実際に
 * 数えた瞬間とがずれる（1つの節が2つの「いま」を持つことになる）。
 *
 * ## 境界（ちょうど窓の端）は含める
 *
 * `startedAtMs >= at - 窓` かつ `startedAtMs <= at` の**両端を含む閉区間**で
 * 判定する。`at` はこの節が「いつ数えたか」として名乗る観測時刻そのものなので、
 * ちょうどその瞬間に始まった委譲を除く理由が無い。下限も同じ理由で閉じている
 * ——「直近3時間」は「3時間以内」の意味で読むのが自然で、ちょうど3時間前を
 * 除くと自然な読みと食い違う。
 *
 * ## 壊れた `startedAt` は数えない
 *
 * `Date.parse` が `NaN` を返す委譲（欠けている・壊れている値）は数えに含め
 * ない。**黙って除いているのではなく、ここにその理由を書く**——他のファイル
 * で日付を読む数え方（`superseded.ts` の `countSupersedingReports`、
 * `manager-fold-candidate.ts` の同種の判定）はどれも「読めない値は比較に
 * 使わず除外する」という同じ倣いを採っており、ここもそれに揃える。**専用の
 * 「読めなかった」状態は持たせていない**——`ManagerSummary.startedAt` は
 * `manager.ts` 側で `job.createdAt` を直接写すだけの欄で、台帳を経由する限り
 * 壊れる経路が無い（壊れうるとすれば呼び出し元のテスト・将来の変更である）。
 * `describeSituationInboxBacklog` の `'unreadable'` のような3値を持たせる
 * ほどの重さをここには与えず、「無い」より軽い「数えない」で足りると判断した。
 */
export function countRecentManagerStarts(managers: readonly ManagerSummary[], at: number): number {
  const from = at - RECENT_MANAGER_START_WINDOW_MS;
  let count = 0;
  for (const manager of managers) {
    const startedAtMs = Date.parse(manager.startedAt);
    if (Number.isNaN(startedAtMs)) continue;
    if (startedAtMs >= from && startedAtMs <= at) count += 1;
  }
  return count;
}

/**
 * 器の state ごとの本数。**`RunnerLiveness` の6値は畳まない**（`manager.ts` の
 * `RunnerOverview` の doc——`unreachable` / `unusable` / `lost` / `vacating` の
 * 違いはクローンの判断材料そのものである）。
 *
 * **並びは渡された順ではなく、最初に現れた順で固定する。** `Map` の反復順は
 * 挿入順なので、同じ器の集まりなら同じ並びが出る。
 */
export function countRunnerStates(
  runners: readonly { readonly state: RunnerLiveness }[],
): ReadonlyMap<RunnerLiveness, number> {
  const byState = new Map<RunnerLiveness, number>();
  for (const runner of runners) byState.set(runner.state, (byState.get(runner.state) ?? 0) + 1);
  return byState;
}

/**
 * ターンの入口へ載せる節を組み立てる。**I/O をしない純関数である**——呼び出し側
 * （`clone.ts` の `#situationNoticeFor`）が `ManagerPool` を読んでから渡す
 * （`runner-swap-notice.ts` の `decideRunnerSwapNotice` と同じ作法。判定と
 * 副作用を分けておけば、分岐それぞれに歯を直接通せる）。
 *
 * ## 0 を書く軸と、書かない軸（軸ごとに規則が違う）
 *
 * **委譲の5区分は 0 でも全部書く。** `走行中` / `返事待ち` / `背景処理待ち` /
 * `手が空いている` / `その他` は同じ1回の数え上げの分割で、合計（`全 N 本`）も
 * 並んでいるので、「0 と書いた」を「数えていない」と読む余地が無い。そして
 * **「手が空いている」の行を消すと、この節が在る理由そのものが消える**——0件でも
 * 必ず1行出す `describeInboxBacklog`（`tools.ts`）が #562 で直したのと同じ形で、
 * 行が無いことは「機能が無い」と同じ顔になる。
 *
 * **`lost`（判断待ち）だけは、0 のときに書かない（#688）。** 同じ分割の6つ目
 * なのに規則が違うので、理由を2つ置く:
 *
 * 1. **「行が無い」は「0 だった」と*算術で*確定する。** 残りの5区分は 0 でも
 *    必ず出るので、その5つを足して `total` に一致すれば `lost` は 0 である。
 *    ⟹ 器の行（合計しか出ないので内訳は導けない）と違い、ここでは
 *    **「数えていない」と読む余地が構造的に無い。** これが `describeManagerCounts`
 *    （`tools.ts`）の「0 の行は作らない」を、この節でも安全に採れる理由である
 * 2. **この行は本数ではなく*次の一手*を伝える行である。** `lost` の 0 は
 *    「確かめるものが1つも無い」＝ 判断が1つも変わらない。**毎ターン載る節に
 *    変わらない行を足すと、変わる行が読まれなくなる**（器の行を 0 で並べない
 *    のと同じ規則）
 *
 * **⚠️ この規則を残りの5区分へ広げないこと。** あちらは「いまの状態」の軸で、
 * 0 そのものが判断材料である（「手が空いているのが 0 本」は読む価値がある）。
 * こちらは「判断待ちの待ち行列の長さ」で、0 は空である。
 *
 * **器の行は、0 の state を書かない。** こちらは `RunnerLiveness` の6値ぜんぶを
 * 毎ターン並べると、行が「state の一覧」に化けて実際に居る state が読みにくく
 * なる。台数の合計（`器 N 台`）は必ず書くので、ここでも「数えていない」とは
 * 読めない——`describeManagerCounts`（`tools.ts`）が「0 の行は作らない」を
 * 選んでいるのと同じ規則である。
 *
 * **どちらの行も、数えられなかったときは 0 で埋めない。** そのときはこの関数を
 * 呼ばず、{@link describeSituationUnavailable} が「数えられなかった」と名乗る
 * 行を出す（`runner-swap-notice.ts` の `affected: number | undefined` —— 数え
 * 切れたときだけ本数——と同じ向きの判断である）。
 */
/**
 * 認証トークンの1行（人間の決定 2026-09-07）。**数えた材料だけを書く。**
 *
 * ## なぜ毎ターン注入するのか —— クローンが「枠が塞がっている」を*記憶*から書いた
 *
 * 実運用の事故（2026-09-07）: 巡回の番でクローンが**新しい委譲を1本も出さず**、
 * 理由をこう書いた ——
 *
 * > 枠が JST 19:30 まで塞がっているので、出しても1手も始まらずに落ちます。
 *
 * **その 19:30 は、既に降りた鍵（`production`）の reset である。** そのとき現役は
 * `staging` で、記録の上では `ready` だった。⟹ **前提が事実と違っていた。**
 *
 * 前提が作られた機構は3つ重なっている:
 *
 * 1. **毎ターンの文脈に鍵の話が1文字も無かった**（この関数が無かった）⟹ 手元の
 *    材料は自分が食らった 429 の文言だけになる
 * 2. **その文言は「アカウントの枠」ではなく「そのとき走っていた鍵の枠」である。**
 *    回っても文言は文脈に残るので、**降りた鍵の事実が現在形で読まれる**
 * 3. 回転は受信箱へ入らない（人間の決定 2026-08-25。2026-09-07 に「通る鍵に
 *    戻った」だけ覆した）⟹ 鍵が変わったことを否定する材料が文脈に来ない
 *
 * **⟹ 直すのは判断ではなく材料である。** 事実を隣に置けば、記憶から書けなくなる。
 *
 * ## ⭐ 「枠を理由に見送る」は、書ける状況では必ず偽である
 *
 * これは推論ではなく機構から出る**不変条件**である ——
 * **枠が閉じているあいだ、クローンのターンは1つも走らない**
 * （逐語は `grep -Fn -- '枠（利用上限）が閉じている間はターンを回さない' packages/core/src/clone.ts`）。
 *
 * ⟹ **クローンが何かを書けているなら、枠は全面的には閉じていない。**
 * だから最後の行でそれを名指しする（{@link TOKEN_INVARIANT}）。
 *
 * ## ⚠️ 「だから必ず通る」とは書かない
 *
 * このターンが走っていることが証明するのは「**このセッションが持っている鍵**が
 * いま受け入れられている」までで、これから起こす委譲が受け取る**現役の鍵**が通ると
 * は言えない（世代がずれている状態が実際にあった）。⟹ 言えるのは
 * **「1手も始まらない、とは言えない」**までである。**確実性を反転させないこと。**
 */
export function describeTokenSituation(input: {
  /** プールの行（外向きの顔。**値は持たない**）。読めなかったときは `undefined`。 */
  readonly tokens: readonly TokenSituationRow[] | undefined;
  /** 現役の指名。まだ一度も回していなければ `null`。読めなかったときは `undefined`。 */
  readonly active: { readonly tokenId: string } | null | undefined;
  /** 判定の基準時刻（epoch ミリ秒）。 */
  readonly at: number;
}): string {
  // **読めなかったことを 0 や「無し」で埋めない**（`AGENTS.md` の地雷
  // 「取れない軸に 0 の行を作る」）。**それでも不変条件の行は落とさない** ——
  // あれはプールの状態に依存しないので、読めなくても真である。
  if (input.tokens === undefined || input.active === undefined) {
    return (
      '認証トークン: **プールを読めなかった**（塞がっているかどうかは、ここからは言えない）。' +
      TOKEN_INVARIANT
    );
  }

  const ready = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'ready');
  const cooling = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'cooling');
  const withheld = input.tokens.length - ready.length - cooling.length;
  const active = input.active;

  const current = ((): string => {
    if (active === null) {
      // **「1本目が現役」と書かない**（`TokenPoolStore.readActive` の doc）。
      return '現役の指名は**まだ一度も無い**（器の環境変数のまま走っている）';
    }
    const row = input.tokens.find((token) => token.id === active.tokenId);
    if (row === undefined) {
      return '現役として記録された行がプールに無い（人間が消した）';
    }
    const state = tokenStateOf(row, input.at);
    const until =
      state === 'cooling' && row.cooldownUntil !== undefined
        ? '。冷却明けは ' +
          new Date(row.cooldownUntil).toISOString() +
          // **出所を添える（#683）。** ここは「冷却中でも1手も始まらないとは
          // 言えない」を言う行なので、**その期限が推測なのかどうかは判断に効く。**
          '（' +
          (TOKEN_COOLDOWN_SOURCE_LABEL[row.cooldownSource ?? 'unrecorded'] ?? '出所の記録が無い') +
          '）'
        : '';
    return '現役は「' + row.label + '」（記録の上では ' + TOKEN_STATE_LABEL[state] + until + '）';
  })();

  return (
    '認証トークン: ' +
    current +
    '。プール ' +
    String(input.tokens.length) +
    ' 本: いま使える ' +
    String(ready.length) +
    ' / 冷却中 ' +
    String(cooling.length) +
    ' / 外されている ' +
    String(withheld) +
    '。' +
    TOKEN_INVARIANT
  );
}

/** {@link describeTokenSituation} が見る列だけ。**値は受けない。** */
export interface TokenSituationRow {
  readonly id: string;
  readonly label: string;
  readonly disabledAt?: string;
  readonly invalidatedAt?: string;
  readonly cooldownUntil?: number;
  /**
   * 冷却の期限の出所（#683。{@link CooldownSource}）。**無い行が在る** ——
   * 既定で埋めないこと（「推測だと観測した」という嘘になる）。
   */
  readonly cooldownSource?: CooldownSource;
}

/**
 * 冷却の期限の出所を、クローンへ出す1語にする（#683 / #682）。
 *
 * **入れ子の三項演算子で書かないこと。** ここは一度その形で書いていて、
 * `notice_text`（#682）が増えた瞬間に**「課金枠のリセット時刻」と言う**形に
 * なった —— 型でも歯でも捕まらず、**新しい値だけが静かに嘘を言う。**
 * `Record` にしてあると、値が増えたときに `tsc` が落ちる。
 *
 * **`unrecorded` を鍵に持つ**（`tools.ts` の同じ表と同じ理由）。「出所が無い」は
 * **取れなかったこと**であって `default`（推測だと観測した）ではない。
 */
const TOKEN_COOLDOWN_SOURCE_LABEL: Record<CooldownSource | 'unrecorded', string> = {
  quota_reset: '出所は枠のリセット時刻（権威ある値）',
  overage_reset: '出所は課金枠のリセット時刻（権威ある値）',
  notice_text: '**出所は上限の文言に書かれていた時刻。推測である**',
  default: '**出所は設定の既定。ただの推測である**',
  unrecorded: '出所の記録が無い',
};

const TOKEN_STATE_LABEL: Record<'ready' | 'cooling' | 'disabled' | 'invalidated', string> = {
  ready: '使える',
  cooling: '冷却中',
  disabled: '人間が外している',
  invalidated: '失効',
};

/**
 * **枠を理由に見送らないための1行。** プールの状態に依存しないので、読めなかった
 * 回でも落とさない（{@link describeTokenSituation} の doc「不変条件」）。
 *
 * **⚠️ 「必ず通る」へ反転させないこと。** 言えるのは「1手も始まらない、とは
 * 言えない」までである（同じ doc の最後の節）。
 */
const TOKEN_INVARIANT =
  '\n**⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは' +
  '1つも走らない（`#usageBlocked`）—— **いまあなたが書けているなら、枠は全面的には' +
  '閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。' +
  'そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**' +
  '（回っても文言は文脈に残る）—— 現役の状態は上の行か `token_list` で見る。' +
  '**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、' +
  '実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**';

/** {@link TokenSituationRow} から状態を出す。**判定順を崩さないこと。** */
function tokenStateOf(
  row: TokenSituationRow,
  at: number,
): 'ready' | 'cooling' | 'disabled' | 'invalidated' {
  if (row.disabledAt !== undefined) return 'disabled';
  if (row.invalidatedAt !== undefined) return 'invalidated';
  if (row.cooldownUntil !== undefined && row.cooldownUntil > at) return 'cooling';
  return 'ready';
}

/**
 * 受信箱（デーモン→クローンの脚）の滞留を1行にする（#783 段0）。
 *
 * ## ここに置く理由 —— 「観測を足すことは、対策を足すことではない」
 *
 * `manager_list` の `describeInboxBacklog`（`tools.ts`）は内訳まで持つが、
 * **明示的に呼ばれたときしか読まれない。** クローンが受信箱の滞留に気づいて
 * いなければ、そもそも呼ぼうとしない——だから、呼ばれなければ存在しないのと
 * 同じになる。**この節はクローンが見落としようがない場所（毎ターンの
 * 入口）に出す** ためにある。
 *
 * ## 4つの状態（当初3つとして実装し、レビューで4つに直った）
 *
 * - **省略（`undefined`） → 行を出さない**（既存の呼び出しを壊さない側の
 *   「渡さないと決めた」——`tokens` と同じ作法）
 * - **`'unreadable'`（`pending()` が落ちた＝読もうとして読めなかった） →
 *   行を出す。⛔ `0` という数字は1文字も作らない。**
 * - **`count === 0`（実際に数え切れて0件だった） → 行そのものを出さない**
 *   （`lost` と同じ作法）
 * - **1件以上 → 短く1行、{@link INBOX_BACKLOG_LOUD_THRESHOLD} 超えで膨らむ**
 *
 * ## ⚠️ 「読めなかった」と「0件」を同じ「行が無い」に潰さない
 *
 * **当初の実装はここを潰していた**（`backlog === undefined || count === 0`
 * を1つの分岐で `null` にしていた）。これは `AGENTS.md` の地雷「取れない軸に
 * 0 の行を作る」の裏返しの形で、この repo が何度も踏んでいる形そのものである:
 *
 * - {@link describeSituationUnavailable} の doc: 「0 で埋めれば『全部片付いて
 *   いる』と読める（**いちばん見落としたい向きへ倒れる**）」「`runner-swap-
 *   notice.ts` が `'none-affected'`（0本と数え切れた）と `'ledger-
 *   unreadable'`（数えられなかった）を**型で分けている**のと同じ理由」
 * - `tools.ts` の `describeInboxBacklog` の doc: 「**『常に実測できるか、
 *   観測できていないことがありうるか』という違いが、この非対称性の理由その
 *   ものである**」
 *
 * `lost` との類比が効くのは「同じ配列から必ず数え切れる」ときだけである
 * （`lost` は `managers` 配列を全走査すれば必ず数えられるので「行が無い＝0」
 * が本当に成り立つ）。**受信箱の `pending()` は読めないことがある**（だから
 * `clone.ts` 側で catch している）ので、`undefined` へ潰した瞬間に「読めな
 * かった」が「0件」と見分けが付かなくなっていた。`'unreadable'` を専用の
 * 状態として型で分けたのはこのため——`'unreadable'` を渡されたら **必ず
 * 行を出す**（0 で埋めず、数字も作らない）。
 *
 * ## 閾値はなぜ 50 か
 *
 * #783 本文が引く #562 は、28件（9〜56分の遅れ）を「詰まり」として扱った。
 * その倍を超えたら「詰まり」では説明が付かない、という線として
 * {@link INBOX_BACKLOG_LOUD_THRESHOLD} を置く。
 *
 * ## 毎ターン載るので、平常時は短く保つ
 *
 * `distill` 以外の全ターンに載るため、行の肥大はそのままトークンの肥大に
 * 直結する。**指図（「〜せよ」）は書かない**（このファイル冒頭「指図を
 * 書かない」）——書くのは数と、内訳を割る口の名前までである。
 *
 * ## `pending()` が読めなかったとき
 *
 * `clone.ts` の `#situationNoticeFor` は `pending()` の失敗を捕まえて
 * `'unreadable'` を渡す——鍵の材料 {@link describeTokenSituation} と同じ
 * 「個別に catch して、読めなかった軸だけを落とす」作法だが、**落とす先が
 * 違う**（鍵は「読めなかった」と名乗る専用の1行を持ち、こちらも同じく専用の
 * 1行を持つ——0 で埋めない）。ターン全体を {@link describeSituationUnavailable}
 * へ倒すのは委譲・器の数え上げ自体が読めなかったときだけで、受信箱の滞留は
 * それとは独立の材料である。
 *
 * ## メモリの配達待ち行列は別の軸である（issue #1084）
 *
 * 上のすべては `InboxStore.pending()`——**器（DB / ファイル）の行数**——の話
 * である。**配達はここを読んでいない**（`clone.ts` の `#pump` が読むのは
 * `Clone#inbox`——プロセスのメモリに載っただけの `FIFO`）。⟹ 器の行数が 0
 * でも、メモリの待ち行列には合図が残っていることがある（issue #1049 で実際に
 * 起きた——`inbox_remove_many` は器の行を消すだけで、メモリの待ち行列には
 * 触れていなかった。#1049 の修正・PR #1086 で `dropQueuedInboxEvents` が消す
 * 側から両方を落とすようにしたが、**両方を落とす経路が無かったこと自体は
 * 直っても、「2つの実体を1つの数字で名乗っていた」という見えなさは別に残る**
 * ——この Issue が塞ぐのはそちらである）。
 *
 * **⟹ 片方へ畳まない。** 合算すると「器が詰まっているのか、メモリの配達が
 * 詰まっているのか」が区別できなくなる——まさに #1049 で起きたことの逆再生
 * である（あのときは「器は空、メモリは数千件」だった。合算していたら
 * 「数千件」としか見えず、器側が本当に空だという事実が消える）。
 *
 * ## 何を数え、何を数えていないか（{@link describeInboxBacklogQueuedInMemory}（`inbox-backlog.ts`）の doc）
 *
 * 材料・除外の詳細はそちらへ集約する——ここに書き写すと2箇所がずれる。
 *
 * ## 閾値超えの回だけ、種類の内訳を持つ（issue #1140）
 *
 * `backlog.typeBreakdown` は**閾値（{@link INBOX_BACKLOG_LOUD_THRESHOLD}）を
 * 超えた回だけ**、呼び出し側（`clone.ts` の `#situationNoticeFor`）が埋める。
 * ⚠ **重い `peekPending()`（全行を zod で parse する）は、その回にしか
 * 呼ばれない**——平常時は安い `pending()`（`count(*)` / `min(at)`）だけを
 * 読む（`clone-situation-notice.test.ts` の歯がこれを固定する）。暴発
 * （#1140 本文の実例: `external:token-pool` が 3809 件・`manager_message` が
 * 39 件）を読み解きたいのは、まさに件数が閾値を超えた回だからである。
 *
 * **⚠️ `typeBreakdown.total` と、この行の見出しの件数はずれうる。** 見出しの
 * `backlog.count` は「このターン自身が処理中の分」（`events.length`）を
 * 引いた値だが、`typeBreakdown`（`summarizeInboxBacklog` が `peekPending()`
 * の生の行を集計したもの）は引いていない——`tools.ts` の
 * `describeInboxBacklog` と同じ数え方（`manager_list` はこの引き算をしない）
 * にわざと揃えてある。⟹ **両者は最大 `events.length` 件（通常1件）ずれる
 * ことがある**——このずれを1文字も言わずに2つの数を並べると、依頼者が
 * 実際に踏んだ「`chars=340` が現物と合わない」のと同じ形の混乱を生む
 * （依頼者の注文）ので、行の文言そのものに明記する。
 *
 * **本文は載せない。** 送信元・同一本文・器の入れ替え回数・齢は、この行には
 * 出さない——`manager_list` に委ねる（この行が肥大しないための線引き。
 * `foldInboxBacklogByType` の doc「なぜ畳むか」と同じ理由）。
 */
function describeSituationInboxBacklog(
  backlog:
    | {
        readonly count: number;
        readonly oldestAt?: string;
        /** 閾値超えの回だけ埋まる（このファイル doc「閾値超えの回だけ」）。 */
        readonly typeBreakdown?: InboxBacklogBreakdown;
      }
    | 'unreadable'
    | undefined,
): string | null {
  if (backlog === undefined) return null;
  if (backlog === 'unreadable') {
    // ⛔ ここに `0` という数字を書かない——「数えられなかった」を「0件」と
    // 見分けられなくすることが、この分岐が存在する理由そのものを壊す。
    return '受信箱の未処理を数えられなかった（`manager_list` で自分で引くこと）。';
  }
  if (backlog.count === 0) return null;
  const oldest =
    backlog.oldestAt === undefined ? '' : `（最も古いものは ${backlog.oldestAt} から）`;
  const base = `受信箱の未処理 ${backlog.count} 件${oldest}。`;
  if (backlog.count <= INBOX_BACKLOG_LOUD_THRESHOLD) return base;
  // **軸の名前はここが出す側と揃える**（#910）。この1行は滞留が閾値を超えている
  // 間`distill` 以外の全ターンに載るので、ここで古い軸名（`配達回数`）を名乗ると、
  // クローンは `manager_list` を引く前にその名前を覚える —— 実際に、誤った名前で
  // 読んだ数字から2つの誤った結論が立ち、その筋で委譲が1本出ている（#910）。
  // 逐語の出所は `grep -Fn -- '器の入れ替え回数: 0回＝いまの器になってから積まれた' packages/core/src/inbox-backlog.ts`。
  if (backlog.typeBreakdown === undefined) {
    // **内訳が届かなかった回**（`peekPending()` が失敗した、あるいは呼び出し
    // 側が省略した）。件数自体は数え切れているので `base` は出したまま、
    // 内訳は `manager_list` へ誘導する（issue #783 段0 以来の既定の文言）。
    return (
      `⚠ ${base}` + '内訳（種類 / 同一本文 / 器の入れ替え回数 / 齢）は `manager_list` で割れる。'
    );
  }
  // issue #1140: 種類の内訳（上位 N 件 + 他）を添える。数え方のずれは
  // このファイル doc「閾値超えの回だけ、種類の内訳を持つ」に明記済み。
  const typeLine = foldInboxBacklogByType(backlog.typeBreakdown.byType);
  return (
    `⚠ ${base}種類: ${typeLine}` +
    `（器の生の行 ${backlog.typeBreakdown.total} 件を数えた——このターン自身の分は` +
    '引いていないので、上の件数と1件前後ずれることがある。本文は載せない。' +
    '残り（送信元 / 同一本文 / 器の入れ替え回数 / 齢）は `manager_list` で見る）。'
  );
}

/**
 * 受信箱の**メモリの配達待ち行列**の1行（issue #1084）。
 *
 * **実体は `inbox-backlog.ts` の `describeInboxBacklogQueuedInMemory`。**
 * issue #1133 で、`tools.ts` の `describeInboxBacklog`（`manager_list` 側）が
 * このメモリの軸を1文字も読んでいなかったことが分かり、**2つの呼び出し口が
 * 同じ計算・同じ文言を通る**ようにそちらへ寄せた。`describeSituationInboxBacklog`
 * （器の行数、このファイル内）とは別の軸である——doc の全文は
 * {@link describeInboxBacklogQueuedInMemory}（`inbox-backlog.ts`）を読むこと。
 */
export function describeSituation(input: {
  readonly managers: readonly ManagerSummary[];
  readonly runners: readonly { readonly state: RunnerLiveness }[];
  /**
   * 認証トークンの材料（人間の決定 2026-09-07）。**省略できる** ——
   * 省略すると鍵の行が出ない（既存の呼び出しを1つも壊さない）。
   */
  readonly tokens?: readonly TokenSituationRow[] | undefined;
  readonly active?: { readonly tokenId: string } | null | undefined;
  readonly at?: number;
  /**
   * 受信箱（デーモン→クローンの脚）の滞留（#783 段0）。**省略できる** ——
   * 省略すると行が出ない（既存の呼び出しを1つも壊さない。`tokens` と同じ
   * 作法）。**`'unreadable'` は「省略」とは別の状態**（読もうとして読めな
   * かった）——両方とも `undefined` へ潰すと「0件」と見分けが付かなくなる。
   * {@link describeSituationInboxBacklog} の doc を見る。
   *
   * `typeBreakdown` は issue #1140 で足した——**閾値超えの回だけ**呼び出し側
   * （`clone.ts`）が埋める。詳細・数え方のずれは
   * {@link describeSituationInboxBacklog} の doc「閾値超えの回だけ、種類の
   * 内訳を持つ」を見る。
   */
  readonly backlog?:
    | {
        readonly count: number;
        readonly oldestAt?: string;
        readonly typeBreakdown?: InboxBacklogBreakdown;
      }
    | 'unreadable'
    | undefined;
  /**
   * 受信箱の**メモリの配達待ち行列**の長さ（issue #1084）。**省略できる** ——
   * 省略すると行が出ない（既存の呼び出しを1つも壊さない。`backlog` と同じ
   * 作法）。**`backlog` とは別の軸——足し合わせない**（{@link
   * describeSituationInboxBacklog} の doc「メモリの配達待ち行列は別の軸で
   * ある」）。材料と除外は {@link describeInboxBacklogQueuedInMemory}
   * （`inbox-backlog.ts`）の doc を見る。
   */
  readonly queuedInMemory?: number | undefined;
}): string {
  const counts = countManagerSituation(input.managers);
  const byState = countRunnerStates(input.runners);
  const runnerBreakdown = [...byState.entries()]
    .map(([state, count]) => `${state} ${count}`)
    .join(' / ');
  const inboxBacklogLine = describeSituationInboxBacklog(input.backlog);
  const inboxQueuedLine = describeInboxBacklogQueuedInMemory(input.queuedInMemory);
  // **`at` はここでも使う（#902）。** かつてこの値はトークンの行の判定にしか
  // 渡っておらず、**節の本体は自分がいつの値かを1文字も名乗らなかった。**
  // {@link readAtLabel} の doc（節は会話履歴に溜まる）。
  const at = input.at ?? Date.now();
  // **#1103 案1。`at` をそのまま渡す**——{@link countRecentManagerStarts} の
  // doc「`at` は呼び出し側の観測時刻をそのまま使う」。ここで独自に
  // `Date.now()` を引き直すと、節が名乗る時刻とこの本数の観測時刻がずれる。
  const recentStarts = countRecentManagerStarts(input.managers, at);
  return block([
    `${SITUATION_HEAD}（${readAtLabel(at)} に数えた材料だけ。ここから何をするかは決めない）。`,
    // **`lost` の区分だけ 0 のとき出さない**（上の doc の2つの理由）。残りの5つは
    // 0 でも出るので、5つを足して `total` に一致すれば `lost` は 0 だと*算術で*
    // 読める——**「数えていない」と読む余地が構造的に無い。**
    //
    // **`その他` の直前に置く。** `lost` はそこから切り出したものなので、隣に
    // 並んでいれば「その他が減って lost が増えた」と読める。
    `委譲 全 ${counts.total} 本: 走行中 ${counts.running} / 返事待ち ${counts.waitingHuman} / ` +
      `背景処理待ち ${counts.awaitingBackground} / 手が空いている ${counts.idle} / ` +
      (counts.lost === 0 ? '' : `${LOST_LABEL} ${counts.lost} / `) +
      `その他 ${counts.other}。話しかけられるのは ${counts.reachable} 本。` +
      // **横断する軸は分割の後ろに置く（#1212）。** `reachable` と同じ場所で、
      // 同じ「本。」の形にする——区分の並びの中へ差し込むと、足せば `total` に
      // なる数の列に別の軸が混ざる。**0 のときは1文字も出さない**（`lost` と
      // 同じ作法。`AGENTS.md` の地雷「取れない軸に 0 の行を作る」）。
      (counts.lastTurnFailed === 0
        ? ''
        : `${LAST_FAILURE_LABEL}のは ${counts.lastTurnFailed} 本` +
          `（うち「手が空いている」に数えたものが ${counts.lastTurnFailedIdle} 本。` +
          '上の区分とは足し合わせない）。') +
      // **`lastTurnFailed` の直後に置く（#1212 残件2）。** 同じ横断する軸の
      // 仲間として並べる——離れた場所に置くと、片方だけが「唯一の失敗の軸」
      // に見える。**0 のときは1文字も出さない**（同じ作法）。
      (counts.usageStopped === 0
        ? ''
        : `${USAGE_STOPPED_LABEL}のは ${counts.usageStopped} 本` +
          `（うち「手が空いている」に数えたものが ${counts.usageStoppedIdle} 本。` +
          '上の区分とは足し合わせない）。') +
      // **#1103 案1。0 本でも出す（0 が合図だから）。** 閾値も ⚠ も持たない
      // ——{@link RECENT_MANAGER_START_WINDOW_MS} の doc「閾値ではなく本数
      // だけを出す」。だから他の横断する軸（`lastTurnFailed` 等）と違い、
      // ここは三項演算子で 0 を隠さない。
      `直近${RECENT_MANAGER_START_WINDOW_HOURS}時間に新しく起こした委譲: ${recentStarts} 本。`,
    // **本数の直後に置く（#688）。** この節は `distill` 以外の全ターンの入口に
    // 載る（`clone.ts` の `#situationNoticeFor`）ので、**いちばん確実に読まれる
    // 場所**である。数と、そこから何を確かめるかを離すと、数だけが読まれる。
    //
    // **0 のときは1文字も出さない**（行そのものが無い。上の doc の理由2）。
    // **指図は書かない**（このファイル冒頭「指図を書かない」）——書いてあるのは
    // 「この数が何を意味しないか」と、名指しで引く口の名前までである。
    ...(counts.lost === 0 ? [] : [LOST_NOTICE]),
    // **`LOST_NOTICE` の直後に置く（#1212）。** どちらも「この本数を『終わった』と
    // 読むな」という同じ向きの断りで、離すと片方だけが読まれる。**0 のときは
    // 1文字も出さない**（`lost` と同じ作法）。
    ...(counts.lastTurnFailed === 0 ? [] : [LAST_FAILURE_NOTICE]),
    // **`LAST_FAILURE_NOTICE` の直後に置く（#1212 残件2）。** 同じ向きの
    // 断りが3つ並ぶ（`LOST_NOTICE` → `LAST_FAILURE_NOTICE` →
    // `USAGE_STOPPED_NOTICE`）。**0 のときは1文字も出さない**（同じ作法）。
    ...(counts.usageStopped === 0 ? [] : [USAGE_STOPPED_NOTICE]),
    `器 ${input.runners.length} 台${runnerBreakdown === '' ? '' : `: ${runnerBreakdown}`}。`,
    '**「手が空いている」は「空き枠」ではない** — この器に定員は無いので、' +
      '置けるかどうかはここでは答えていない。' +
      // **この一文は本数が 0 でも出す（#1212）。** 上の「直近のターンが失敗で
      // 終わっている」の本数は 0 のとき1文字も出ないので、**出ていないことが
      // 「数えていない」と読める余地**が残る（`lost` は5区分の和が `total` に
      // 一致することで算術的に 0 だと確定するが、横断する軸にその手は無い）。
      // ⟹ **軸が在ることだけを常に名乗り、本数は在るときだけ出す。**
      '**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく' +
      '失敗で終わった委譲も `done` のまま座る（セッションが生きているためで、仕様である）。' +
      'その本数は1本以上あるときだけ上の行に出る。' +
      // **同じ理由で本数が 0 でも出す（#1212 残件2）。** 直上の一文と対で、
      // こちらは「失敗の理由の1つ（利用上限）」を名指しする軸が在ることを
      // 常に名乗る。
      '**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限' +
      'そのもので止まった委譲も `done` のまま座る（鍵の回転を待っているだけで、' +
      'セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。' +
      '**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、' +
      '待っていても「手が空いている」側に数える。' +
      '**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — ' +
      '`status` が `running` でも、背景処理待ちの印が立っていればそちらへ数える。' +
      // **`lost` をここから外した（#688）。** 畳んでいたあいだ、この一文が
      // 「lost は終端したものである」と読ませていた——`lost` は終端の値だが、
      // **成果の有無を観測していない**のはこれだけで、`failed` / `stopped` と
      // 同じ袋に入れると「終わったもの」として読み飛ばされる。
      '「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。' +
      '個別の状態は `manager_list` / `runner_list` で見る。',
    // **受信箱の滞留は、委譲・器の直後・鍵の行より前に置く**（#783 段0）。
    // 0件・読めなかった場合は行を出さない（`describeSituationInboxBacklog` の doc）。
    ...(inboxBacklogLine === null ? [] : [inboxBacklogLine]),
    // **メモリの配達待ち行列は、器の行数の直後に置く**（issue #1084）。同じ
    // 「受信箱」という話題の中で隣に並べることで、2つが別の実体だと読める形に
    // する——離れた場所に置くと、器の行数の1行だけが「受信箱の全部」に見える。
    // 0件・省略時は行を出さない（`describeInboxBacklogQueuedInMemory` の doc）。
    ...(inboxQueuedLine === null ? [] : [inboxQueuedLine]),
    // **鍵の行は最後に置く。** 数えた材料（委譲・器）の後に、判断を縛る不変条件が
    // 来る順にしてある（{@link describeTokenSituation}）。**省略した呼びでは出ない。**
    ...(input.tokens === undefined && input.active === undefined
      ? []
      : [
          describeTokenSituation({
            tokens: input.tokens,
            active: input.active,
            at,
          }),
        ]),
  ]);
}

/**
 * 数えられなかったときの節。**行を消さず、0 でも埋めない。**
 *
 * `describeSituation` が出す形と**見分けが付くこと**がこの関数の全部である
 * ——`AGENTS.md` の地雷「取れない軸に 0 の行を作る」がそのまま当たる場所で、
 * 0 で埋めれば「全部片付いている」と読める（いちばん見落としたい向きへ倒れる）。
 * `runner-swap-notice.ts` が `'none-affected'`（0本と数え切れた）と
 * `'ledger-unreadable'`（数えられなかった）を型で分けているのと同じ理由である。
 */
export function describeSituationUnavailable(error: unknown, at: number = Date.now()): string {
  return block([
    // **こちらも時刻を名乗る（#902）。** 数えられた節だけが名乗る形にすると、
    // 「非対称そのものが理由を要求する」という #902 の指摘を、**この関数が
    // そっくり作り直すことになる。**
    `${SITUATION_HEAD}を数えられなかった（${readAtLabel(at)} 時点）: ${String(error)}`,
    'これは「全部片付いている」ではなく「**数えられなかった**」である。' +
      '本数が要るなら `manager_list` / `runner_list` を自分で呼ぶこと。',
  ]);
}

/**
 * 節を1つの塊にする。**末尾の区切り（`---`）まで含めて返す**——
 * `#commitmentNoticeFor`（`clone.ts`）が同じ形（`'', '---', ''` で終わる配列を
 * `join('\n')` する）で返しており、区切りを呼び出し側で足す形にすると、節を1つ
 * 足すたびに `#runTurn` の連結の側にも手が要る。
 */
function block(lines: readonly string[]): string {
  return [...lines, '', '---', ''].join('\n');
}
