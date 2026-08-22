import { randomUUID } from 'node:crypto';

import { journalEntryShape, noteDroppedRecord, noteUnreadableRecord } from './dropped-record.js';
import type { ProfileService } from './profile-service.js';
import { createRecentMap, type RecentMap } from './recent.js';
import { describeRunnerEntries, isRetryableRunnerError } from './runner-protocol.js';
import type {
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerLiveness,
  RunnerProfileFingerprint,
  RunnerRegistry,
} from './runner-protocol.js';
import { brief } from './runner.js';
import type { InboxEvent, Job, JobStatus, JournalEntryInput, WorkspaceLocator } from './schema.js';
import type { Stores } from './store.js';
import { describeUsageNotice, usageTransitionOf, type RateLimitFacts } from './usage-limits.js';
import { usageDate } from './usage.js';

/**
 * 委譲のデーモン側（docs/architecture.md「配線」）。
 *
 * SDK を動かすのはここではない。**マネージャーは manager-runner の中で走り**、
 * ここがするのは「どの runner へ命じるか」「返ってきた出来事をどう記録し、
 * クローンの受信箱へどう回すか」だけである。
 *
 * 分けた理由は認証情報の配布範囲である。同じ器で走らせる限り、マネージャーは
 * `/proc/1/environ` からデーモンの環境変数＝記憶ストアの鍵に届いてしまう。
 * ツールを削って塞ぐのは禁止（north_star 禁止2）なので、実行環境を分ける。
 *
 * 記録（日誌・ジョブ台帳・アーカイブ・セッションの生ログ）は**すべてこちら側**に
 * 残る。runner は記憶へ到達する鍵を持たないので、書けるのはデーモンだけである。
 */

export { MANAGER_MODEL, WORKER_MODEL, WORKER_AGENT_NAME, WITHHELD_ENV_KEYS } from './runner.js';

export interface ManagerStartInput {
  request: string;
  /** 実プロジェクトの作業ディレクトリ。人間が Claude Code を開く場所と同じ。 */
  cwd?: string;
  /**
   * 置き先の指名（`runner_list` / `manager_list` が出す `runnerId`）。
   *
   * **これは配置の指名であって、本数の制限ではない。** 省略すれば、いままでどおり
   * 資源による自動配置（`RunnerRegistry#select` の `#place`）が選ぶ。指名した場合は
   * その器が開けていて使えるときだけそこへ置き、名簿に無い・使えない・名前が
   * 重複のいずれでも**自動配置へは落とさない**（`RunnerRegistry#select` の doc）。
   */
  runnerId?: string;
}

export interface ManagerSummary {
  managerId: string;
  status: JobStatus;
  /**
   * このデーモンから話しかけられるか。
   *
   * 再起動を跨いで台帳から拾い直した分も `true` になる（宛先の runner が居て、
   * session_id から resume できる）。宛先を失ったものだけが `false`。
   *
   * **`status: lost` と `live: true` は両立しない。** `lost` は resume を試して
   * 前のセッションへ戻れなかったという事実で、戻る先が無いのだから話しかけ
   * られない。この組を出さないのは `isLive()` の仕事である。
   */
  live: boolean;
  cwd: string;
  request: string;
  startedAt: string;
  updatedAt: string;
  sessionId?: string;
  lastReport?: string;
  /**
   * 直近の1ターンが**報告ではなく失敗**で終わったこと（`jobSchema.lastFailure`）。
   *
   * **台帳に載っているのに要約へ載っていなかった。** 台帳（`Job`）は `lastFailure` を
   * 持つのに、外へ出るのはここを通った分だけなので、人間の面（CLI の `/managers`・
   * Web のマネージャー画面）には「報告が来た」としか出ていなかった。塞いだ穴が
   * ここで開き直る — `lastReport` の本文は runner 側で包んであるが、包んだ文字列
   * だけに頼ると、読む側は本文の先頭を読んで失敗かどうかを判定することになる。
   *
   * **`status` と混ぜない。** 支出上限に当たった回もセッションは生きているので
   * `status` は `done`（＝終えて待機中。話しかければ続く）のままである
   * （`schema.ts` の `lastFailure` の doc）。
   */
  lastFailure?: NonNullable<Job['lastFailure']>;
  /** どの runner で走っているか（`manager_id → runner_id` の対応）。 */
  runnerId?: string;
  workspace?: WorkspaceLocator;
  /**
   * 返事待ちで止まっている件。
   *
   * **1本のマネージャーが同時に複数を待つことがある。** 1回のアシスタント応答で
   * 並列に呼ばれた道具は、それぞれ別の確認として同時に降りてくる。だから配列で持ち、
   * 回答は `requestId` で宛先を指定する。
   */
  waiting: { requestId: string; summary: string }[];
}

/**
 * 「確認へ上がらずに止められた」件数（道具ごと）。
 *
 * **`status` では表せない。** 分類器か deny 規則がその場で拒否したとき、その仕事は
 * `running` のまま手が止まる — デーモンから見えるのは「拒否があった」という事実
 * だけで、**それで止まったのかどうかは観測していない**。だから状態の値は増やさず、
 * 状態に**添える**形で出す（`manager_list`）。
 */
export interface ManagerDenial {
  tool: string;
  count: number;
}

/**
 * 器（runner）1台の様子と、そこに紐づくマネージャー（`runner_list` の材料）。
 *
 * `label` / `state` / `since` / `error?` / `runnerId?` / `workspacePath?` は
 * `RunnerEntry`（`runner-protocol.ts`）と同じ形をそのまま写す。**`state` は
 * 5値のまま渡し、`connected` へ畳まない**——`unreachable` / `unusable` / `lost` の
 * 違いは、クローンが「これ以上起こさない」を判断する材料そのものである。
 */
export interface RunnerOverview {
  label: string;
  state: RunnerLiveness;
  since: string;
  error?: string;
  runnerId?: string;
  workspacePath?: string;
  /**
   * この器に紐づくマネージャー（`ManagerSummary.runnerId` が一致した分）。
   *
   * **ここで数えている本数はデーモンの台帳から見た数である。** 新しいマネージャー
   * をどこへ置くかの判断（資源による自動配置 `chooseByResources`）が使っている
   * 本数は、runner 自身が `/health` で名乗る別の値（`RunnerPlacementResources.
   * managers`）で、**この一覧とは別物であり、ずれうる。** 混ぜて「配置はこの数を
   * 見て決めている」と読まないこと。
   */
  managers: { managerId: string; status: JobStatus }[];
  /** 配られている鍵の指紋。`fingerprints: true` を渡したときだけ載る（値は sha256）。 */
  credentials?: RunnerCredentialFingerprint[];
  /** 置かれている実行環境プロファイルの指紋。`fingerprints: true` を渡したときだけ載る。 */
  profile?: RunnerProfileFingerprint;
}

/** `runner_list` が返す全体像。 */
export interface RunnerFleetOverview {
  runners: RunnerOverview[];
  /**
   * `runnerId` が付いていないマネージャー（宛先の runner が記録されていない）。
   *
   * **どの器の内訳にも混ぜず、0 に畳まず、この別枠へ出す**
   * （AGENTS.md「取れない軸に 0 の行を作らない」がこの形）。混ぜれば、たまたま
   * 記録の無いマネージャーの分だけどこかの器の本数が水増しされる。捨てれば、
   * 「マネージャーは全部どこかの器に居る」という誤った前提を実装が持つことになる。
   */
  unassigned: { managerId: string; status: JobStatus }[];
}

export type ManagerDecision = 'allow' | 'deny';

export interface ManagerSendResult {
  /** `answered` = 止まっていた確認を解いた。`delivered` = 追加指示として届けた。 */
  outcome: 'answered' | 'delivered' | 'unknown';
  detail: string;
}

export interface ManagerSendOptions {
  decision?: ManagerDecision;
  /** どの確認への回答か。複数を待っているときは省略できない。 */
  requestId?: string;
}

/**
 * 誰が止めたか。
 *
 * **記録が嘘をつかないためだけのもの**で、止まり方は誰が押しても同じである
 * （人間の Web UI もクローンの `manager_stop` も、この下は1本の道を通る）。
 * ここが無いと、クローンが止めた仕事の日誌に「人間が停止させた」と残り、
 * 人間とクローンで見えている経緯が食い違う。
 */
export type ManagerStopActor = 'human' | 'clone';

/**
 * 「止めた」を4値で言う（PR #137 で持ち込んだ「成功 / 明確な失敗 / 不明」の語彙に、
 * ここでは「そのものが居ない」を足したもの）。
 *
 * **以前は `'stopped' | 'unknown'` の2値で、`sessionGone` という別のフィールドに
 * 実際の判定を逃がしていた。** `sessionGone: false`（＝止まっていないと確かめた）
 * でも `outcome` は必ず `'stopped'` になっていたので、HTTP 応答・クローンの道具・
 * CLI・Web はどれも `outcome` だけを見ると「止まった」という嘘を受け取っていた
 * （`sessionGone` は `ManagerAbortResult` にしか載らず、`app.ts` の JSON 応答には
 * 出ていなかった）。ここで判定そのものを `outcome` に持ち上げる。
 *
 * | 値 | 意味 | 台帳への書き込み | HTTP |
 * | --- | --- | --- | --- |
 * | `'stopped'` | `sessionGone === true`。止まったと確かめた | `status: 'stopped'` へ、`waiting`/`attached` を畳んで `#retire` | 200 |
 * | `'not_stopped'` | `sessionGone === false`。**止まっていないと確かめた**（明確な失敗） | 何も書かない | 200 |
 * | `'unknown'` | 確かめられなかった（`runner.list()` が答えない／`runner.stop()` が期限切れ／**宛先の runner が名簿に開いていない**） | 何も書かない | 200 |
 * | `'absent'` | **そのマネージャーが台帳に居ない。** 旧 `'unknown'` の改名 | — | 404 |
 *
 * **`'absent'` は「宛先の runner が居ない」を含んでいた。** その2つは別である —
 * 台帳に居ないマネージャーは存在しないが、**宛先が開いていないだけのマネージャーは
 * 存在する。** しかも「開いていない」は `unreachable`（まだ開けていない。再試行は
 * 予約済み）を含むので、**待てば直る状態を 404 という機械可読な終端で返していた。**
 * 404 は人間もクローンも CLI も Web も「そんなものは無い」としてしか読めず、
 * **文言と違って読み手の解釈で救われない。**
 *
 * `'unknown'`（そのものは居るが確かめられなかった → 200）が、この場合のために
 * 既に在る。新しい値は足していない。
 */
export interface ManagerAbortResult {
  outcome: 'stopped' | 'not_stopped' | 'unknown' | 'absent';
  detail: string;
  /**
   * **止めた結果、本当に止まったか。** runner のセッション一覧から消えたことを
   * 見に行った結果で、`undefined` は確かめられなかった（runner に訊けなかった）。
   *
   * 「停止を受理した」と「止まった」は別の観測である。`runner.stop()` は該当の
   * セッションが手元に無ければ黙って何もしないので、受理だけを見て「止まった」と
   * 言うと、走り続けているマネージャーを止めたことにしてしまう。
   *
   * **`outcome` と重複しているように見えるが、外向きの面（HTTP・道具）が読むのは
   * `outcome` の方である。** ここは `outcome` を導いた根拠として残す（`true` ⟺
   * `'stopped'`、`false` ⟺ `'not_stopped'`、`undefined` ⟺ `'unknown'` /
   * `'absent'`）。
   */
  sessionGone?: boolean;
}

export interface ManagerPool {
  start(input: ManagerStartInput): Promise<ManagerSummary>;
  send(
    managerId: string,
    message: string,
    options?: ManagerSendOptions,
  ): Promise<ManagerSendResult>;
  /**
   * この仕事をやめさせる（`stop()` の全停止とは別物）。
   *
   * **人間が直接止められること自体が要件である。** 走っているマネージャーを
   * 止める手段がクローン経由しか無いと、クローンが取り込み中のときや、そもそも
   * クローンの判断が間違っているときに、人間が手を出せない層ができる。
   * 止めた事実は日誌に残る（見えない層を作らない）。
   *
   * **クローンも同じここを通る**（`manager_stop`）。人間に出来てクローンに
   * 出来ないことを作らない（north_star 禁止1）。違うのは `by` に残る名前だけで、
   * 止まり方は変えない — 停止が2種類あると、人間とクローンで見えている状態が
   * 食い違う。
   */
  abort(managerId: string, reason?: string, by?: ManagerStopActor): Promise<ManagerAbortResult>;
  list(): Promise<ManagerSummary[]>;
  /**
   * このマネージャーで拒否された道具と件数を、**古い順**で返す。
   *
   * **`ManagerSummary` には載せない。** これはデーモンのプロセス内の像であって、
   * 台帳には無い（器を作り直せば数え直しになる）。読む口をここに分けておけば、
   * 台帳から作る `ManagerSummary` を汚さずに、読む側が状態へ添えられる。
   *
   * **`GET /managers` の spec には載っている。** かつてここには「spec にも無い」と
   * 書いてあったが、それは応答が宣言を通っていなかった頃の話である。いまは
   * `app.ts` が返す前に `managerSummarySchema` を通すので、外向きの面に出すものは
   * 宣言しなければ出ない。宣言した上で、この口から読んで合流させている。
   */
  denials(managerId: string): ManagerDenial[];
  /**
   * 器（runner）の一覧と、器ごとに何本のマネージャーが走っているか（`runner_list`）。
   *
   * **`ToolContext` に `RunnerRegistry` を足すのではなく、ここへ置く。** 器ごとの
   * 本数を数えるには名簿（`RunnerRegistry#entries`）とマネージャー台帳
   * （`list()`）の**両方**が要り、`ManagerPool` はその両方を既に持っている
   * 唯一の場所である——数え上げの持ち主を1か所にする（AGENTS.md「リポジトリの
   * 約束」）。`ToolContext.managers` は既に配線済みなので、`clone.ts` の配線を
   * 増やさずに済むという利点もある。`manager_stop` が `pool.abort()` を直接
   * 呼ぶのと同じ作法である。
   *
   * **`resources()` は呼ばない。** この一覧のためにネットワーク往復を足さない
   * ——ここで数える本数は台帳から見えている分であって、配置が使う本数
   * （`RunnerPlacementResources.managers`）とは別物である（`RunnerOverview` の doc）。
   *
   * `fingerprints: true` を渡すと、開けている器について鍵とプロファイルの
   * 指紋も添える。**既定では出さない**——クローンの判断で「要らないものを文脈へ
   * 載せない」側に倒す。それでも出せる口を残すのは、north_star 禁止2 が
   * 「制限は方針で表し、方針は設定で開けられなければならない」と要求している
   * からである。人間は Web UI（`GET /runners`）で常に見られるので、クローンだけ
   * 永久に見えない形にはしない。
   */
  runners(options?: { fingerprints?: boolean }): Promise<RunnerFleetOverview>;
  /** manager_id からセッションの生ログへ降りる（可観測性の最下段）。 */
  transcript(managerId: string): Promise<string | null>;
  /**
   * デーモン起動時に、走行中だったマネージャーを台帳と runner から拾い直す。
   * 戻り値は「中断されていて実際に resume した」分。
   */
  restore(): Promise<ManagerSummary[]>;
  stop(): Promise<void>;
}

export interface ManagerPoolOptions {
  stores: Stores;
  /** マネージャーからの出来事をクローンの受信箱へ流す。 */
  post: (event: InboxEvent) => void;
  /** runner の名簿。宛先の決定はここを通す（固定 URL を前提にしない）。 */
  runners: RunnerRegistry;
  /**
   * 実行環境プロファイルの1本道。
   *
   * **降ろし直しもここを通す。** runner へ書く操作は更新（`apply`）と同じ列に
   * 入れないと、更新の最中に古い本文を読んで新しい本文を上書きする。
   */
  profile?: ProfileService;
}

export function createManagerPool(options: ManagerPoolOptions): ManagerPool {
  return new Pool(options);
}

/**
 * 取り直しを挑み直すまでの待ち時間（倍々で伸ばし、上限で頭打ちにする）。
 *
 * **これは能力の上限ではなく、混雑を作らないための間隔である**（north_star 禁止2 は
 * 実行回数の制限を禁じている。回数は制限していない）。上限で頭打ちにするのは、
 * 器が長く戻らないときに秒間何度も叩かないためで、諦めるためではない。
 */
const REATTACH_RETRY_BASE_MS = 1_000;
const REATTACH_RETRY_MAX_MS = 30_000;

/**
 * 預かってある生ログを引いた結果。
 *
 * **`unknown[] | null` にしない。** `null` にすると「預かっていない」と
 * 「読みに行って失敗した」が同じ値になり、呼び出し側は前者としてしか読めない。
 * 実際にそうなっていて、**一時的に読めなかっただけの委譲が `lost` で終端し、
 * クローンには「生ログも預かっていないので、続きの材料が無い」という存在の否定が
 * 届いていた。**
 *
 * **書く側は既にこの区別を守っている。** `case 'mirror'` は `append` が失敗
 * したとき `noteDroppedRecord` で跡を残す —「預かり損ねたことすら残らないと、
 * 後から『無い』のか『預かれなかった』のかが分からない」。**読む側にだけそれが
 * 無かった。**
 */
type SessionMaterial =
  | { kind: 'loaded'; entries: unknown[] }
  /** 預かっていない（store が無い / `projectKey` が無い / 引いたが空だった）。 */
  | { kind: 'absent' }
  /** **引きに行って失敗した。** 待てば直りうるので、恒久の結論に変えない。 */
  | { kind: 'unreadable' };

/**
 * resume を投げた結果。
 *
 * **`boolean` にしない。** `false` は「戻る先が無い（`session_id` が無い）」の
 * 意味で使われていて、`send()` はそれを「新しく起こし直すこと」と報告する。
 * **読めなかっただけのときに同じ言葉を出すと、一時を恒久として報告したうえに、
 * 誤った行動まで指示することになる**（起こし直せば、続きは失われる）。
 * **呼ぶ側に区別させる** — 既定を持たせて省略させないのは `summaryOf` の
 * `live` と同じ論法である。
 */
type ResumeOutcome =
  | 'resumed'
  /** 戻る先が無い（`session_id` を持っていない）。**恒久である。** */
  | 'no-session'
  /** 生ログを引きに行って失敗した。**恒久ではない。** */
  | 'unreadable'
  /** 別の契機が同じ session を取り直している最中。**恒久ではない。** */
  | 'busy';

/** デーモン側が持つ1マネージャーの像（正本は JobStore）。 */
interface ManagerRecord {
  job: Job;
  waiting: { requestId: string; summary: string }[];
  /** runner に生きたセッションがあるか。無ければ send のときに resume する。 */
  attached: boolean;
  /**
   * **一度でもクローンへ配った確認の id。**
   *
   * `waiting` は「いま待っている」ものしか持たない。それだけで重複を見ると、
   * 解けた後に届いた同じ `ask` が新しい待ちとして積まれ、クローンへ二度目が
   * 届く。解決という事実は runner とデーモンの**両方**で観測できる必要がある
   * （片方にしか残らないのが、この不具合の形である）。
   *
   * **これは重複の抑止であって、経路の短絡ではない。** ここで答えを決めることは
   * 一切しない — 知らない確認はこれまでどおり全部クローンへ回る（M4 の制御面分離）。
   *
   * 最初の `ask` で作る。像はマネージャーと一緒に消えるので寿命は元から有限で、
   * 件数の蓋（`ASKED_MEMORY_LIMIT`）は1本が異常に多くの確認を出したときの保険。
   */
  asked?: RecentMap<true>;
  /**
   * **道具ごとの、確認へ上がらず止められた件数。**
   *
   * 拒否は正常な運用でも起きるので、1件ずつ受信箱へ流すとクローンの判断が雑音で
   * 鈍る。**日誌には全部残し、受信箱へは繰り返しの形になったときだけ**上げる
   * （`shouldEscalateDenial`）。その「繰り返し」を数える状態がここである。
   *
   * 寿命と置き場所:
   *
   * - **プロセス内のこの像だけに載る**（`Job` には書かない＝ストアへ持ち越さない）
   * - デーモンを作り直したら**消える**。数え直しから始まる — 拒否が続いていれば
   *   すぐまた閾値に届くし、止まっていれば黙るのが正しい
   * - 覚えるのは**道具の名前**で、件数の蓋は `DENIED_TOOL_LIMIT`。溢れたら
   *   `onForget` が日誌へ残す（黙って数え直さない）
   */
  denied?: RecentMap<number>;
}

/** 1マネージャーぶんで覚えておく確認の件数。達したら**黙らずに日誌へ残す**。 */
const ASKED_MEMORY_LIMIT = 512;

/**
 * 1マネージャーぶんで拒否を数える道具の種類。達したら**黙らずに日誌へ残す**。
 *
 * 道具の名前の種類なので、実際にはまず届かない（届いたら、それ自体が異常である）。
 */
const DENIED_TOOL_LIMIT = 64;

/** 何件目の拒否からクローンへ上げるか。以後は3倍ごと（3, 9, 27, 81…）。 */
const DENIED_ESCALATE_AT = 3;

class Pool implements ManagerPool {
  readonly #stores: Stores;
  readonly #post: (event: InboxEvent) => void;
  readonly #runners: RunnerRegistry;
  readonly #profile: ProfileService | undefined;
  readonly #records = new Map<string, ManagerRecord>();
  /**
   * 直近の枠の事実（種類ごと）。**アカウント単位なのでマネージャーに紐づけない。**
   *
   * 走行中は `rate_limit_event` がターンの頭ごとに来るので、ここが最新になる。
   * 揮発してよい — デーモンを作り直したら、使い捨ての probe が取り直す。
   */
  readonly #rateLimits = new Map<string, RateLimitFacts>();
  /**
   * 種類ごとに最後にクローンへ流した上限の文言。
   *
   * **同じ知らせで受信箱を埋めないため**にある。通知はターンごとに繰り返し届きうる
   * ので、そのまま流すと本当に変わった1回が埋もれる。
   */
  readonly #usageNotices = new Map<string, string>();
  /** 起動時の引き取りが走っている間だけ立つ。`#reattach` はこれを待つ。 */
  #restoring: Promise<void> | null = null;
  /** 取り直しが走っている runner（同じ runner について重ねない）。 */
  readonly #reattaching = new Set<string>();
  /** 取り直し中に届いた名乗り。**捨てずに、終わってからもう一度回す。** */
  readonly #reattachAgain = new Set<string>();
  /** 予約済みの取り直し（`hello` を待たずに自分で挑み直すため）。 */
  readonly #reattachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 次に待つ時間。うまくいったら忘れる。 */
  readonly #reattachDelays = new Map<string, number>();
  /** いま resume を投げている最中のマネージャー（同じ session を二本起こさない）。 */
  readonly #resuming = new Set<string>();
  /**
   * 自動では戻せないと分かったマネージャー。
   *
   * **`retry` は runner 単位、この判定はジョブ単位である。** 同じ runner に一時
   * 障害のジョブが1本あるだけで予約は積まれ続けるので、ここに覚えておかないと
   * 「挑み直さない」と決めたジョブが毎回巻き込まれて再送され、同じ障害通知が
   * クローンの受信箱に積み上がる。
   *
   * **人間とクローンの明示的な経路は塞がない** — `manager_send` の resume は
   * ここを見ないし、成功すれば忘れる（`#resume`）。デーモンを作り直したときも
   * 消える（別の器・別の runner なら結果が変わりうる）。
   */
  readonly #unresumable = new Set<string>();
  /**
   * 繋ぎ済み（か、いま繋いでいる最中）の宛先。**旗は宛先ごとに持つ。**
   *
   * 弱参照なのは、名簿から外れた runner をここが握り続けないためである。
   */
  readonly #connections = new WeakMap<RunnerClient, Promise<void>>();
  /** 名簿の購読を解く（`stop` で外す。外し忘れると止めたプールが後から動く）。 */
  readonly #unsubscribe: () => void;
  #stopped = false;

  constructor({ stores, post, runners, profile }: ManagerPoolOptions) {
    this.#stores = stores;
    this.#post = post;
    this.#runners = runners;
    this.#profile = profile;
    // **後から載った runner に自分から繋ぐ。** 名簿が動的である以上、受け口を開く
    // 契機を起動時にしか持たないと、後から現れた runner は永久に無言のままになる。
    this.#unsubscribe = runners.subscribe((runner) => {
      if (this.#stopped) return;
      void this.#connectTo(runner).catch(() => undefined);
    });
  }

  // -------------------------------------------------------------------------
  // 委譲
  // -------------------------------------------------------------------------

  async start(input: ManagerStartInput): Promise<ManagerSummary> {
    if (this.#stopped) throw new Error('デーモンが停止中のためマネージャーを起こせない');
    await this.#ensureConnected();

    const runner = await this.#runners.select({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId }),
    });
    // **選んだ相手に繋がっていることを確かめてから起こす。** ここを best-effort に
    // すると、受け口の開いていない runner でマネージャーが走り出し、報告も許可確認も
    // 誰にも届かない（黙って止まっているように見える）。
    await this.#connectTo(runner);
    const managerId = `mgr-${randomUUID().slice(0, 8)}`;
    const cwd = input.cwd ?? runner.workspacePath;
    const at = new Date().toISOString();

    const record: ManagerRecord = {
      job: {
        id: managerId,
        managerId,
        createdAt: at,
        updatedAt: at,
        status: 'running',
        summary: brief({ request: input.request }),
        request: input.request,
        cwd,
        runnerId: runner.runnerId,
        workspace: { kind: 'runner-volume', runnerId: runner.runnerId, path: cwd },
      },
      waiting: [],
      attached: true,
    };
    this.#records.set(managerId, record);

    // 委譲はノンブロッキング。起こして即返し、クローンは次の判断へ移る。
    try {
      await runner.start({ managerId, request: input.request, cwd });
    } catch (error) {
      // 起こせなかったものを一覧に残さない。残すと「走っている」と見えるのに、
      // 誰も読まない相手へクローンが指示を送り続けることになる。
      this.#records.delete(managerId);
      throw error;
    }

    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${managerId}] ${input.request}`,
    });
    return summaryOf(record, isLive(record));
  }

  /**
   * クローンからの一言。止まっている確認があればその回答として使い、無ければ
   * 追加指示として流す（architecture.md「会話に戻れる」）。
   *
   * **宛先を推測しない。** 1本のマネージャーが複数の確認を同時に待つことがあり、
   * そこで先頭に入れてしまうと、拒否のつもりの一言が別の質問の答えになる。
   */
  async send(
    managerId: string,
    message: string,
    options: ManagerSendOptions = {},
  ): Promise<ManagerSendResult> {
    await this.#ensureConnected();

    const record = this.#records.get(managerId) ?? (await this.#load(managerId));
    if (!record) {
      return { outcome: 'unknown', detail: `${managerId} というマネージャーは居ない。` };
    }

    const runner = await this.#runnerOf(record);
    if (!runner) {
      return { outcome: 'unknown', detail: this.#absentRunnerDetail(record) };
    }

    const { decision, requestId } = options;
    const pending = this.#choosePending(record, requestId);
    if (pending === 'ambiguous') {
      return {
        outcome: 'unknown',
        detail:
          `${managerId} は複数の確認を同時に待っている。requestId を指定して答えること: ` +
          record.waiting.map((item) => `${item.requestId}（${item.summary}）`).join(' / '),
      };
    }
    if (pending === 'gone') {
      return {
        outcome: 'unknown',
        detail: `${requestId ?? ''} という確認は ${managerId} で待っていない（既に解けたか、別のマネージャーのもの）。`,
      };
    }

    if (pending) {
      const answered = await runner.answer(managerId, {
        requestId: pending.requestId,
        message,
        ...(decision === undefined ? {} : { decision }),
      });
      if (!answered) {
        return {
          outcome: 'unknown',
          detail: `${pending.requestId} は runner 側で既に解けている。`,
        };
      }
      // 追記専用なので新しい行。日誌だけを追っても、誰が何と答えたかまで分かる。
      await this.#journal({
        type: 'escalation',
        question: pending.summary,
        approvalId: pending.requestId,
        managerId,
        answeredAt: new Date().toISOString(),
        answer: decision === undefined ? message : `[${decision}] ${message}`,
      });
      return { outcome: 'answered', detail: `${pending.summary} に回答した。` };
    }

    // 待機していた（＝runner にセッションが居ない）相手なら、ここで続きへ戻す。
    if (!record.attached) {
      // 器の入れ替えで取り直している最中に重ねない（同じ session を二本起こす）。
      // **「戻れない」とは別の理由なので、別のことを言う。**
      if (this.#resuming.has(managerId)) {
        return { outcome: 'unknown', detail: resumeFailureDetail(managerId, 'busy') };
      }
      const resumed = await this.#resumeOnce(record, runner, message);
      if (resumed !== 'resumed') {
        return { outcome: 'unknown', detail: resumeFailureDetail(managerId, resumed) };
      }
    } else {
      await runner.send(managerId, message);
    }

    record.job.status = 'running';
    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${managerId}] ${message}`,
    });
    return { outcome: 'delivered', detail: '追加指示として届けた。' };
  }

  async list(): Promise<ManagerSummary[]> {
    await this.#ensureConnected();

    const known = new Map<string, ManagerSummary>();
    for (const record of this.#records.values()) {
      known.set(record.job.id, summaryOf(record, isLive(record)));
    }
    // 台帳にしか無い分も見せる。**`live: false` を決め打ちしない。** `#retire`
    // （終端した委譲を `#records` から外す）が入った後は、「台帳にしか無い」は
    // 「runner に宛先が無い」の意味とは限らない — `session_id` が残っていれば
    // `manager_send` で明示的に起こし直せる（`#load()` と同じ判定）。決め打ちで
    // `false` にすると、外した瞬間に `live: true` だった委譲が `false` へ化ける
    // ＝完了した委譲について読めていたものが読めなくなる（デグレード）。
    for (const job of await this.#stores.jobs.listJobs()) {
      if (known.has(job.id)) continue;
      const fallback: ManagerRecord = { job, waiting: [], attached: false };
      known.set(job.id, summaryOf(fallback, isLive(fallback)));
    }
    return [...known.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  denials(managerId: string): ManagerDenial[] {
    // 台帳へは降りない。**プロセス内の像にしか無い**ので、知らないものは
    // 「無い」ではなく「数えていない」— どちらも空配列だが、そう読めるように
    // 一覧側で「デーモンを作り直すと数え直しになる」と添えてある。
    const denied = this.#records.get(managerId)?.denied;
    if (denied === undefined) return [];
    return denied.entries().map(([tool, count]) => ({ tool, count }));
  }

  async runners(options: { fingerprints?: boolean } = {}): Promise<RunnerFleetOverview> {
    // `list()` が台帳とプロセス内の像を合流させ、`#ensureConnected` も済ませる。
    const managers = await this.list();
    const entries = this.#runners.entries();

    // **`runnerId` が無い分は、どの器にも混ぜず別枠へ。** 0 に畳むと「記録が無い
    // マネージャーは存在しない」と読める（AGENTS.md「取れない軸に0の行を作らない」）。
    const byRunner = new Map<string, { managerId: string; status: JobStatus }[]>();
    const unassigned: { managerId: string; status: JobStatus }[] = [];
    for (const manager of managers) {
      const item = { managerId: manager.managerId, status: manager.status };
      if (manager.runnerId === undefined) {
        unassigned.push(item);
        continue;
      }
      const bucket = byRunner.get(manager.runnerId);
      if (bucket) bucket.push(item);
      else byRunner.set(manager.runnerId, [item]);
    }

    // 指紋は明示的に頼まれたときだけ聞きに行く（開けている器にしか聞けない）。
    const open = options.fingerprints
      ? new Map(
          (await this.#runners.list().catch(() => [])).map((runner) => [runner.runnerId, runner]),
        )
      : undefined;

    const runners = await Promise.all(
      entries.map(async (entry) => {
        const client = entry.runnerId === undefined ? undefined : open?.get(entry.runnerId);
        const [credentials, profile] =
          client === undefined
            ? [undefined, undefined]
            : await Promise.all([
                client.credentials().catch(() => undefined),
                client.profile().catch(() => undefined),
              ]);

        const overview: RunnerOverview = {
          label: entry.label,
          state: entry.state,
          since: entry.since,
          ...(entry.error === undefined ? {} : { error: entry.error }),
          ...(entry.runnerId === undefined ? {} : { runnerId: entry.runnerId }),
          ...(entry.workspacePath === undefined ? {} : { workspacePath: entry.workspacePath }),
          managers: entry.runnerId === undefined ? [] : (byRunner.get(entry.runnerId) ?? []),
          ...(credentials === undefined ? {} : { credentials }),
          ...(profile === undefined ? {} : { profile }),
        };
        return overview;
      }),
    );

    return { runners, unassigned };
  }

  async transcript(managerId: string): Promise<string | null> {
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    if (!job) return null;

    // 走行中なら runner のディスクの上にある。
    const record = this.#records.get(managerId);
    if (record) {
      const runner = await this.#runnerOf(record);
      const live = await runner?.transcript(managerId).catch(() => null);
      if (live !== null && live !== undefined && live.length > 0) return live;
    }

    // 無ければ退避済みへ降りる。
    for (const id of [...(job.archiveIds ?? [])].reverse()) {
      const body = await this.#stores.archive.read(id);
      if (body !== null) return body;
    }

    // 最後の砦。runner が強制終了されても、生ログ自体は預かってある。
    return this.#fromSessionStore(job);
  }

  /**
   * 起動時に、走っていたマネージャーを拾い直す。
   *
   * 2通りある。**runner が生きていれば、そのセッションはまだ手を動かしている**
   * （デーモンの再起動でマネージャーは死なない）。この場合は繋ぎ直すだけでよい。
   * runner ごと作り直されていたら、JobStore の session_id と預かった生ログから
   * **実際に resume する** — 「話しかけられるまで止めておく」は、人間の不在で
   * 仕事が止まらないという要件（PRD「自律」）に反する。
   */
  async restore(): Promise<ManagerSummary[]> {
    // **走っていることを、await を挟む前に立てる。** 同一プロセスの runner は
    // `connect()` の中で同期的に名乗るので、ここで立てそこねると `#reattach` が
    // 引き取りと同時に走り、同じ仕事を二重に起こす。
    let finished!: () => void;
    this.#restoring = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      return await this.#restoreJobs();
    } finally {
      this.#restoring = null;
      finished();
    }
  }

  async #restoreJobs(): Promise<ManagerSummary[]> {
    if (this.#stopped) return [];
    await this.#ensureConnected();

    // runner に生きているセッションを先に拾う（繋ぎ直しの相手）。
    const alive = new Map<
      string,
      { runner: RunnerClient; state: Awaited<ReturnType<RunnerClient['list']>>[number] }
    >();
    for (const runner of await this.#runners.list()) {
      for (const state of await runner.list().catch(() => [])) {
        alive.set(state.managerId, { runner, state });
      }
    }

    const resumed: ManagerSummary[] = [];
    for (const job of await this.#stores.jobs.listJobs()) {
      if (this.#records.has(job.id)) continue;

      const living = alive.get(job.id);
      if (living) {
        // まだ走っている……とは限らない。**runner が `lost` / `failed` と名乗る
        // ことがある。** どちらも `RunnerSession#finish()` が `#stopped = true` を
        // 立ててからアーカイブの送出（実 I/O）を挟んで一覧から消えるので、その
        // 隙間では畳まれたセッションが `lost` / `failed` のまま一覧に載っている。
        // `attached` が言うのは「runner に**生きた**セッションがあるか」であり、
        // 畳まれたセッションへの `push` は黙って捨てられる（`RunnerSession#push`
        // は `#stopped` を見て何もしない）。
        //
        // ここで `true` を固定すると、`send()` が `!record.attached` で resume と
        // send を分けているせいで、**届かない `runner.send()` を届いたことにして**
        // 台帳の終端状態まで `running` へ巻き戻す。像を上流で正す。
        //
        // **`done` も同じ隙間を持つ。しかし名前では見分けられない。** `lost` /
        // `failed` は `#finish()` を通ったものしか名乗らないが、`'done'` は
        // `#finish('done', ...)`（＝畳まれた）と、`#finish` を通らずに `#status`
        // だけを `'done'` にして `#sessions` に生き残る経路（＝1ターン終えて次の
        // 指示を待っている）の**両方**から付く。この一覧（`RunnerManagerState`）は
        // どちらの `done` かを区別する材料を持たない — 畳まれた方への `push` は
        // 上と同じ隙間で黙って捨てられ、待機している方への `push` はそのまま届く。
        //
        // 区別できないなら安全側に倒す。**そのためにブラックリストを伸ばさず、
        // ホワイトリストに変える。** `!== 'lost' && !== 'failed'` へ `&& !== 'done'`
        // を足す形は、次に状態が増えたとき既定が `attached: true`（危険側）へ倒れる
        // — 足す人は `attached` のことを考えていないのが普通である（`summaryOf` の
        // `live` を必須引数にしたのと同じ理由）。生きているとしか読めない状態を
        // 名指しすれば、未知の状態は既定で `attached: false`（安全側）に落ちる。
        // 同じホワイトリストは既に `#reattach` と、この下の台帳のみの経路にある。
        //
        // **倒した先の代償は無い。** 待機している `done` へは `attached: false`
        // 経由で resume 扱いになるが、実 runner の `host.resume()` は生きた
        // セッションを見つけたら `command.message` を `push` して短絡するので、
        // `runner.send()` が呼ぶ `session.push(text)` と同一の呼び出しになる。
        // セッションが二重に起こされることはない。
        const attached =
          living.state.status === 'running' || living.state.status === 'waiting_human';
        const record: ManagerRecord = {
          job: {
            ...job,
            status: living.state.status,
            runnerId: living.runner.runnerId,
            ...(living.state.sessionId === undefined ? {} : { sessionId: living.state.sessionId }),
          },
          waiting: living.state.waiting,
          attached,
        };
        this.#records.set(job.id, record);
        await this.#persist(record);
        // 「runner の中で走り続けている」は `lost` にも `failed` にも言えない。
        if (attached) this.#notifyRestored(record, 'attached');
        resumed.push(summaryOf(record, isLive(record)));
        continue;
      }

      if (job.sessionId === undefined) continue;

      // **戻せないと分かっているものを「居る」ことにしない。** ここで `#records`
      // へ載せると `list()` が `live: true` で見せ、話しかければ続くように見える
      // 相手が生まれる（持っているのは腐った session_id だけである）。台帳には
      // 残るので、クローンからは `lost` として — **起こし直す対象として** 見える。
      if (job.status === 'lost') continue;

      const record: ManagerRecord = { job: { ...job }, waiting: [], attached: false };
      this.#records.set(job.id, record);

      // 手を動かしている最中に器が落ちた分だけ、実際に続きへ戻す。待機（`done`）
      // だったものは台帳に載せるだけにする（話しかけられたら resume する）。
      if (job.status !== 'running' && job.status !== 'waiting_human') continue;

      const runner = await this.#runnerOf(record);
      if (!runner) continue;

      const nudge = restartNudge(job.status, 'daemon');
      const ok = await this.#resumeOnce(record, runner, nudge);
      if (ok !== 'resumed') continue;
      // **受理は「戻れた」ではない。** この `await` の間に「戻れなかった」が確定
      // していることがある（runner は別プロセスで、失敗は SSE で追いかけてくる）。
      // ここで無条件に上書きすると、書いたばかりの終端状態が `running` へ巻き戻る。
      if (record.job.status === 'lost') continue;
      record.job.status = 'running';
      await this.#persist(record);
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'outbound',
        text: `[${job.id}] （再起動後の再開）${nudge}`,
      });
      this.#notifyRestored(record, 'resumed');
      resumed.push(summaryOf(record, isLive(record)));
    }
    return resumed;
  }

  async abort(
    managerId: string,
    reason?: string,
    by: ManagerStopActor = 'human',
  ): Promise<ManagerAbortResult> {
    await this.#ensureConnected();

    const who = by === 'clone' ? 'クローン' : '人間';

    const record = this.#records.get(managerId) ?? (await this.#load(managerId));
    if (!record) {
      return { outcome: 'absent', detail: `${managerId} というマネージャーは居ない。` };
    }

    const runner = await this.#runnerOf(record);
    if (!runner) {
      // **台帳に居ないのと同じ答えを返さない。** ここまで来ているということは
      // `#load` が台帳から像を作れた＝**このマネージャーは存在する**。宛先が
      // いま開いていないだけで、その中には `unreachable`（まだ開けていない。
      // 再試行は予約済み）が含まれる。`'absent'` を返すと `app.ts` が 404 に
      // するので、**一時的な状態が「そんなものは無い」という機械可読な終端に
      // なる**（`ManagerAbortResult` の doc）。
      //
      // **言い方は `send()` と同じものを使う。** 同じ観測に2つの言い方を
      // 持たせると、片方だけが直る形になる。
      return { outcome: 'unknown', detail: this.#absentRunnerDetail(record) };
    }

    // **`runner.stop()` が投げても、ここで abort() ごと reject させない。** HTTP
    // 越しの runner では期限切れ（`RunnerUnknownError`）や明確な失敗（接続拒否等）
    // が投げられる（`runner-client.ts` の `#call`）。投げたまま素通しすると、日誌の
    // 1行も、クローンへの通知も、状態の更新も、何も残らずに `DELETE /managers/:id`
    // が 500 になる — **「止めた事実は日誌に残る」という約束がいちばん要る場面で
    // 消える**。捕まえて、権威は下の `sessionGone` の探りに置く（stop の RPC が
    // 返らなくても、届いていて実際に止まっていることがある）。
    let stopError: unknown;
    try {
      await runner.stop(managerId);
    } catch (error) {
      stopError = error;
    }

    // **「受理した」で終わらせない。** `runner.stop()` は該当セッションが手元に
    // 無ければ黙って何もしない（`#sessions.get(id)?.stop()`）ので、戻り値だけを
    // 見て「止まった」と言うと、走り続けているものを止めたことにしてしまう。
    // 実際に畳まれたセッションは runner の一覧から消える（`onClosed`）ので、
    // そこを見に行く。訊けなかったときは黙って成功にせず undefined のまま返す。
    // **`stop()` が例外を投げていても、この探りは必ず行う** — 探りが「消えた」と
    // 答えるなら、stop の RPC が不明のままでも止まったと言い切ってよい。
    const sessionGone = await runner
      .list()
      .then((sessions) => !sessions.some((session) => session.managerId === managerId))
      .catch(() => undefined);

    const outcome: 'stopped' | 'not_stopped' | 'unknown' =
      sessionGone === true ? 'stopped' : sessionGone === false ? 'not_stopped' : 'unknown';

    if (outcome === 'stopped') {
      record.waiting = [];
      record.attached = false;
      record.job.status = 'stopped';
      await this.#persist(record);
      // **停止は明示的な終端である。** 台帳には残るので `list()` / `manager_send` は
      // これまでどおり答えられる（`#retire` の JSDoc）。
      this.#retire(managerId);
    }
    // **`outcome` が `'not_stopped'` / `'unknown'` のときは台帳を1文字も書かない。**
    // 生きている（かもしれない）マネージャーの `waiting`（未回答の許可確認）を
    // 畳まない、確かめられていない状態を確定させない — 「止めた」と機械可読な形で
    // 言えるのは、実際に止まったと確かめたときだけである。

    // **止めたことを日誌に残す。** 消えた理由が分からないマネージャーを作らない
    // （PRD「可観測性」）。クローンにも知らせるので、次のターンで気づける。
    const stopErrorNote =
      stopError === undefined
        ? ''
        : `（runner.stop() が例外を投げた: ${stopError instanceof Error ? stopError.message : String(stopError)}）`;
    const attemptedBase =
      reason === undefined ? `${who}が停止を試みた。` : `${who}が停止を試みた: ${reason}`;
    const stoppedBase =
      reason === undefined ? `${who}が停止させた。` : `${who}が停止させた: ${reason}`;
    const detail =
      outcome === 'stopped'
        ? `${stoppedBase}${stopErrorNote}`
        : outcome === 'not_stopped'
          ? `${attemptedBase}runner には ${managerId} のセッションがまだ残っている。止まっていない。${stopErrorNote}`
          : `${attemptedBase}runner に確認が取れず、止まったかは未確認。${stopErrorNote}`;
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      // **`（停止）` はそのまま残す**（既存テストがこの文字列を固定している）。
      // `[outcome=...]` は同じ行に足すだけ——`outcome` を文の解釈なしに grep で
      // 数えられるようにする（「止まらなかった試み」を辿る側のため）。
      text: `[${managerId}] （停止）[outcome=${outcome}] ${detail}`,
    });
    // **outcome ごとに言い分ける。** 止まっていない・不明のときまで「停止させ
    // ました」と言うと、クローンは止まったつもりで次の判断へ進む（R1 の再発）。
    const messageText =
      outcome === 'stopped'
        ? `${managerId} を${who}が停止させました。${reason === undefined ? '' : `理由: ${reason}`}`
        : outcome === 'not_stopped'
          ? `${managerId} を${who}が止めようとしましたが、まだ止まっていません` +
            `（runner にセッションが残っています）。`
          : `${managerId} を${who}が止めようとしましたが、止まったかどうか確認が取れませんでした。`;
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId,
      kind: 'report',
      text: messageText,
    });

    return { outcome, detail, ...(sessionGone === undefined ? {} : { sessionGone }) };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    // 名簿の購読も畳む（載り続ける runner に、止めたプールが繋ぎに行かない）。
    this.#unsubscribe();
    // 予約してあった取り直しは畳む（止めたはずのプールが後から動かない）。
    for (const timer of this.#reattachTimers.values()) clearTimeout(timer);
    this.#reattachTimers.clear();
    this.#reattachDelays.clear();
    this.#unresumable.clear();
    // **runner のマネージャーは止めない。** デーモンの都合で人の仕事を殺さない
    // （インプロセス runner だけは、プロセスが消えるので中で畳まれる）。
    for (const runner of await this.#runners.list().catch(() => [])) {
      await runner.close().catch(() => undefined);
    }
    this.#records.clear();
  }

  // -------------------------------------------------------------------------
  // runner との配線
  // -------------------------------------------------------------------------

  /**
   * 名乗ってきた runner へ、いまの実行環境プロファイルを降ろす。
   *
   * **runner が自分で取りに行く形にしない。** 取りに行けるということは runner に
   * 記憶ストアの鍵があるということで、それは M4 受け入れ基準3 が無いと言っている
   * ものである（AGENTS.md「runner に記憶ストアの鍵を足さないこと」）。
   *
   * 失敗しても委譲は止めない。**プロファイルが降りていないことは日誌に残す** —
   * 黙って古い環境で走ると、「鍵が届いていない」のか「鍵の権限が足りない」のかを
   * 誰も切り分けられなくなる（鍵の指紋を出しているのと同じ理由）。
   */
  async #pushProfile(runner: RunnerClient): Promise<void> {
    if (this.#stopped || this.#profile === undefined) return;
    const runnerId = runner.runnerId;
    try {
      // **更新と同じ列に入れる。** 直に読んで直に書くと、人間やクローンの更新の
      // 最中に古い本文で上書きしうる（3層が別々の本文を持つ状態になる）。
      const result = await this.#profile.syncRunner(runner);
      if (result === null || result.ok) return;

      await this.#stores.journal.append({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text:
          `${runnerId} に実行環境プロファイルを置けなかった（前のものが残っている）: ` +
          `${result.error ?? '理由不明'}${result.output === undefined || result.output.length === 0 ? '' : `\n${result.output}`}`,
      });
    } catch (error) {
      await this.#stores.journal
        .append({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text: `${runnerId} へ実行環境プロファイルを降ろせなかった: ${String(error)}`,
        })
        .catch(() => undefined);
    }
  }

  /**
   * イベントの受け口を開く。**繋ぎに行くのはデーモン側**である。
   *
   * **一度きりにしない。** 名簿は動的で、runner は後から載る（roadmap M5）。
   * 「もう繋いだ」を1つの旗で持つと、起動時に居た runner にしか繋がらず、後から
   * 現れた runner の報告も許可確認も永久に届かない。旗は**宛先ごと**に持つ。
   *
   * ここで転んだ1台に他を道連れにさせない。**選んだ相手に繋がっているかどうかは
   * `start` が別に確かめる**（そこは黙って進めない場所である）。
   */
  async #ensureConnected(): Promise<void> {
    if (this.#stopped) return;
    const runners = await this.#runners.list().catch(() => []);
    await Promise.all(runners.map((runner) => this.#connectTo(runner).catch(() => undefined)));
  }

  /**
   * 1台へ繋ぐ。**同じ宛先へ多重に繋ぎに行かない。**
   *
   * 契機は3つある（`#ensureConnected` / 名簿の購読 / 委譲の直前）。旗を持たないと、
   * 同じ runner に SSE が何本も張られ、同じイベントが二重に記録される。
   *
   * **失敗は覚えない。** 覚えると、瞬断で1度こけた runner に二度と繋がらなくなる。
   */
  #connectTo(runner: RunnerClient): Promise<void> {
    const already = this.#connections.get(runner);
    if (already !== undefined) return already;
    const opening = (async () => {
      await runner.connect((event) => void this.#onEvent(event));
      // **委譲を始める前に環境を整える。** ここを名乗り（`hello`）任せにすると、
      // 最初のマネージャーがプロファイルの届く前に走り出しうる。届いていない
      // ことは本人には見えないので、「たまに鍵が無い」という形で現れる。
      await this.#pushProfile(runner);
    })().catch((error: unknown) => {
      this.#connections.delete(runner);
      throw error;
    });
    this.#connections.set(runner, opening);
    return opening;
  }

  /**
   * runner が繋ぎ直してきたときに、走っていたはずの仕事を取り直す。
   *
   * **引き取りの契機がデーモンの起動時しか無いと、デーモンだけが生き残った
   * 再デプロイで仕事が誰にも拾われない。** runner の器だけが入れ替わると、
   * 台帳は `running` のまま、runner の中にセッションは無く、クローンが
   * `manager_send` するまで永久に止まる。人間の不在で止まってよいのは承認待ちの
   * 仕事だけである（PRD「自律」）。
   *
   * ストリームが切れただけ（器はそのまま）なら、`list()` にセッションがそのまま
   * 並ぶので何も起きない。**生死は台帳ではなく runner に聞く。**
   */
  async #reattach(runnerId: string): Promise<void> {
    if (this.#stopped) return;
    // **重なった名乗りを捨てない。** 起動直後の名乗りを処理している最中に器が
    // 入れ替わるのは、まさに拾いたい場合そのものである。ここで return するだけ
    // だと、その入れ替えが誰にも見られないまま終わる。
    if (this.#reattaching.has(runnerId)) {
      this.#reattachAgain.add(runnerId);
      return;
    }
    this.#reattaching.add(runnerId);
    let retry = false;
    try {
      // 起動時の引き取りと重ならせない。両方が同じ `list()` を見てから動くと、
      // 同じ仕事を二本起こす。
      await this.#restoring;
      if (this.#stopped) return;

      // 名簿を引けなかったのは一時障害（予約して挑み直す）。**居ないと答えられた
      // のは別**である — その runner は戻ってこないので、挑み直しても同じ答えしか
      // 返らない。宛先を失ったことは `list()` の `live: false` で見える。
      const runner = await this.#runners.get(runnerId).catch(() => {
        retry = true;
        return null;
      });
      if (runner === null) return;

      // **取り直しの前に環境を整える。** 器が入れ替わっていれば置いたものは
      // 消えているので、resume して走り出す前に降ろし直す（走り出してから
      // 降ろすと、その仕事の最初のコマンドだけが古い環境で走る）。
      await this.#pushProfile(runner);

      // **台帳を先に、runner を後に読む。** 逆にすると、2つの読みの隙間で起こされた
      // 委譲が「runner に居ないのに台帳には居る」と見えて、走り出したばかりの仕事を
      // 死んだものとして起こし直す。この順なら、隙間で生まれた仕事はそもそも
      // 手元の一覧に入らない。
      const jobs = await this.#stores.jobs.listJobs().catch(() => {
        retry = true;
        return null;
      });
      if (jobs === null || this.#stopped) return;

      // **聞けなかったときは何もしない。** 応答が無いことを「セッションが無い」と
      // 読むと、生きている仕事を二重に起こす。
      //
      // ただし**黙って引き下がるのは駄目である。** `GET /managers` は resume と
      // 同じ HTTP 経路なので、器の起動直後・瞬断・一時的な 5xx でこける。SSE が
      // 既に安定していれば次の名乗りは来ないので、ここで予約せずに帰ると、生死
      // 確認の段階に同じ恒久停止が残る（台帳は `running`、セッションは不在）。
      const states = await runner.list().catch(() => {
        retry = true;
        return null;
      });
      if (states === null || this.#stopped) return;
      const alive = new Set(states.map((state) => state.managerId));

      for (const job of jobs) {
        // 宛先が書かれていない古いジョブはここでは触らない（どの runner の器が
        // 入れ替わったのかを、この情報だけでは決められない）。起動時の `restore`
        // が拾って `runner_id` を書くので、次からはこの経路に乗る。
        if (job.runnerId !== runnerId || alive.has(job.id) || this.#stopped) continue;

        // **一度「挑み直さない」と決めたものは、自動では二度と触らない。** ここを
        // 抜かすと、同じ runner の別ジョブが一時障害で予約を積むたびに巻き込まれ、
        // 無意味な resume と同じ通知が予約の間隔ごとに繰り返される。
        if (this.#unresumable.has(job.id)) continue;

        // 器の中に居ないことは確かめた。台帳の `attached` はもう嘘である。
        const known = this.#records.get(job.id);
        if (known) known.attached = false;

        // 手を動かしている最中だったものだけ戻す（`done` は死ではなく待機であり、
        // 話しかけられたら続く。ここで起こすと開いたままの窓を勝手に閉じる）。
        // **判定より前に `#records` へ載せない** — 載せると `list()` が終わった
        // 仕事まで `live: true` で見せ、話しかけると必ず失敗する相手が生まれる。
        const status = known?.job.status ?? job.status;
        if (status !== 'running' && status !== 'waiting_human') continue;

        const record = known ?? { job: { ...job }, waiting: [], attached: false };
        this.#records.set(job.id, record);
        record.attached = false;
        // **待っていた確認を持ち越さない。** 新しい器はその request_id を知らない
        // ので、残すと以後の `manager_send` が死んだ確認への回答として横取りされ、
        // 解けもしない。クローンからも人間からも届かないマネージャーになる
        // （`restartNudge` はマネージャーに「失われている」と伝えている）。
        record.waiting = [];

        // **1本が戻せなくても、残りを道連れにしない。** ここで抜けると、後ろに
        // 並んでいた仕事が誰にも拾われないまま `running` として残る。
        try {
          const message = restartNudge(status, 'runner');
          const outcome = await this.#resumeOnce(record, runner, message);
          // **引けなかっただけなら諦めない。** 予約して挑み直す（`retry` は runner
          // 単位の予約であって、`#unresumable` のようにこのジョブを恒久に降ろす
          // ものではない）。ここを `continue` だけで済ませると、次の名乗り
          // （`hello`）まで誰もこの委譲を拾わない——`hello` は SSE が繋がった
          // ときにしか来ないので、永久に来ないことがある。
          if (outcome === 'unreadable') {
            retry = true;
            continue;
          }
          if (outcome !== 'resumed') continue;
          // 受理と「戻れた」を取り違えない（`restore` と同じ理由）。
          if (record.job.status === 'lost') continue;
          record.job.status = 'running';
          await this.#persist(record);
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'outbound',
            text: `[${job.id}] （runner 入れ替え後の再開）${message}`,
          });
          this.#notifyRestored(record, 'resumed', 'runner');
        } catch (error) {
          // **「次の `hello` でまた挑む」は嘘だった。** `hello` は SSE が繋がった
          // ときにしか来ない。器は上がってストリームも安定しているのに resume だけが
          // 一時的にこけた場合（起動直後・瞬断・5xx）、次の名乗りは永久に来ないので、
          // 台帳が `running` のまま誰も走っていない仕事が残る — この経路が塞ごうと
          // していた穴と同じ形である。だから**自分で予約する**。
          if (isRetryableRunnerError(error)) retry = true;
          else {
            // 挑み直さないと決めたので、**ジョブ側に覚える**（runner 単位の `retry`
            // では表せない。同じ runner の別ジョブが予約を積むたびに巻き込まれる）。
            // 台帳にも書く — 記憶は器と一緒に消えるが、諦めた事実は消えない。
            this.#unresumable.add(job.id);
            record.job.status = 'lost';
            await this.#persist(record);
            this.#notifyUnresumable(record, error);
            // waiting は上で（resume を挑む前に）既に空にしてある。
            this.#retire(job.id);
          }
        }
      }
    } catch {
      // 想定していないところで転んでもデーモンごと落とさない。**ただし黙って
      // 終わらない** — 何で転んだか分からないものを「もう挑まない」に倒すと、
      // 走行中だった仕事が誰にも拾われないまま `running` で残る。
      retry = true;
    } finally {
      this.#reattaching.delete(runnerId);
      // うまくいった回で待ち時間を忘れる（次の障害はまた1秒から数える）。
      if (!retry) this.#reattachDelays.delete(runnerId);
      // 走っている間に届いた名乗りの分を、ここで回す（予約より即時が優先）。
      if (this.#reattachAgain.delete(runnerId) && !this.#stopped) void this.#reattach(runnerId);
      else if (retry && !this.#stopped) this.#scheduleReattach(runnerId);
    }
  }

  /**
   * 取り直しをもう一度予約する。**外からの合図を待たない。**
   *
   * 間隔は伸ばすが、**諦めはしない。** 回数で打ち切ると、打ち切った先に残るのは
   * 「台帳では走っているのに誰も走っていない仕事」であり、それはこの経路が直そうと
   * している状態そのものである（人間の不在で止まってよいのは承認待ちだけ。PRD
   * 「自律」）。待っても直らない失敗は、そもそもここへ来ない（`isRetryableRunnerError`）。
   */
  #scheduleReattach(runnerId: string): void {
    if (this.#reattachTimers.has(runnerId)) return;
    const delay = this.#reattachDelays.get(runnerId) ?? REATTACH_RETRY_BASE_MS;
    this.#reattachDelays.set(runnerId, Math.min(delay * 2, REATTACH_RETRY_MAX_MS));
    const timer = setTimeout(() => {
      this.#reattachTimers.delete(runnerId);
      if (!this.#stopped) void this.#reattach(runnerId);
    }, delay);
    // デーモンの停止をこのタイマーで引き延ばさない。
    timer.unref?.();
    this.#reattachTimers.set(runnerId, timer);
  }

  /**
   * 戻せないと分かった仕事をクローンへ知らせる。
   *
   * **黙って `running` のまま置かない。** 再試行しても同じ答えが返る失敗なので、
   * ここで人間（とクローン）に見えるようにするのが唯一の出口である
   * （roadmap M5 受け入れ基準4「復旧不能な未永続状態を人間へ明示できる」）。
   */
  #notifyUnresumable(
    record: ManagerRecord,
    error: unknown,
    cause: 'runner' | 'session' = 'runner',
  ): void {
    const { job } = record;
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId: job.id,
      kind: 'report',
      text: [
        cause === 'session'
          ? 'この委譲を前のセッションから戻せなかった（SDK に会話が残っていない）。' +
            '生ログも預かっていないので、続きの材料が無い。'
          : 'runner の器が作り直されたが、この委譲を前のセッションから戻せなかった。',
        `理由: ${String(error)}`,
        `依頼: ${job.request ?? job.summary}`,
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        job.lastReport === undefined ? '' : `直近の報告: ${job.lastReport}`,
        '',
        // **戻れなかったことしか観測していない。** このデーモンは PR もブランチも
        // 見に行かない（リポジトリの事情はマネージャーの領域である）。だから
        // 「成果が無い」とは言わず、確かめる先だけを渡す。落ちる直前にマージまで
        // 済ませていた、が実際に起きている。
        '同じ命令を投げ直しても同じ答えが返る種類の失敗なので、自動では再試行しない。' +
          'ただし**この失敗は「仕事が終わっていない」ことの証拠ではない** — ' +
          '落ちる前に成果がリモート（PR・ブランチ・コミット）まで届いていることがある。' +
          '`manager_start` で起こし直す前に、そこを確かめること。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  /**
   * 生ログから作り直して続けたことをクローンへ知らせる。
   *
   * **成功として黙らせない。** 続いてはいるが、続きは前のセッションそのものでは
   * ない — マネージャーは記録から状況を組み立て直しており、会話の記憶も、
   * 直前に走らせていた道具の結果も持っていない。それを知らないクローンは、
   * 「前に渡した細かい指示は効いている」という前提で次を積んでしまう。
   */
  #notifyResumeFallback(record: ManagerRecord, sessionId: string, reason: string): void {
    const { job } = record;
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId: job.id,
      kind: 'report',
      text: [
        `前のセッション（${sessionId}）へは戻れなかったので、預かってあった生ログから` +
          '新しいセッションを起こして続けさせた。',
        `理由: ${reason}`,
        `依頼: ${job.request ?? job.summary}`,
        job.lastReport === undefined ? '' : `直近の報告: ${job.lastReport}`,
        '',
        'マネージャーが持っているのは記録から読み取れる範囲だけである。' +
          '前のセッションで口頭で足した細かい指示は効いていないと考えて、' +
          '必要なら `manager_send` で言い直すこと。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  /**
   * 宛先を引けなかったときに返す1行。
   *
   * **観測しているのは「いま名簿に開いた宛先が無い」ことだけである。** ここは
   * 「別の runner で続きを起こすには workspace の移送が要る」と**恒久の話**を
   * していたが、そう言える材料はここに無い。`RunnerRegistry#get()` が `null` を
   * 返すのは `entry.client` が無いときで、そこには**まだ開けていない**
   * （`connecting` / `unreachable`。再試行は予約済み）が含まれる — つまり
   * **待てば直る状態を、待っても直らない状態の言葉で報告していた**。
   *
   * **文言の誤りは、状態の誤りより直りにくい。** 読んだ側は「この宛先はもう
   * 戻せない」という結論を持ち帰り、その結論はデーモンのどこにも残らないので、
   * 後から名簿が `connected` へ戻っても訂正が届かない。**判定できないものは
   * 言わない**（AGENTS.md「取れない軸に 0 の行を作らない」）。
   *
   * 代わりに**名簿の状態を5値のまま添える。** `connected` へ畳まないのは
   * `RunnerOverview` と同じ理由で、「まだ開けていない」と「待っても同じ答えが
   * 返る」の違いが、読む側が待つか起こし直すかを決める材料そのものだからである
   * （`RunnerRegistry#select` の doc が「呼んだ側の対応が変わるので必ず区別する」
   * として3種類を数え上げている。**`select` はそれを守っていて、ここだけが
   * 守っていなかった**）。
   *
   * **畳み方は新しく作らない。** 同じことを名簿の側が既に持っている
   * （`describeRunnerEntries`）ので、そちらを呼ぶ。両方で組み立てると、片方だけが
   * 畳んだ形へ倒れても誰も気づけない。**値の意味もここに書き写さない** — 持ち主は
   * `runner_list` の説明であり、写せば必ずずれる。
   *
   * **宛先1台に絞れない。** `RunnerEntry` が `runnerId` を載せるのは
   * `entry.client` があるときだけで（`runner-protocol.ts` の `entries()`）、
   * ここはまさにそれが無い場合である。**引けない対応付けを推測で埋めない**ので、
   * 名簿はそのまま見せて、絞り込みは読む側に任せる。
   */
  #absentRunnerDetail(record: ManagerRecord): string {
    const entries = this.#runners.entries();
    const runnerId = record.job.runnerId;
    const head =
      runnerId === undefined
        ? `${record.job.id} には宛先の runner が記録されておらず、いま開いている runner も無い。`
        : `${record.job.id} の宛先（runner ${runnerId}）は、いま名簿に開いていない。`;
    const fleet =
      entries.length === 0
        ? '名簿には runner が1台も登録されていない（時間では直らない）。'
        : `名簿: ${describeRunnerEntries(entries)}。`;
    return (
      `${head}${fleet}` +
      'これは「いま開いた宛先が無い」という観測であって、戻せないことの証明ではない。' +
      '状態の読み方と、待つか起こし直すかの判断材料は runner_list が持つ。'
    );
  }

  async #runnerOf(record: ManagerRecord): Promise<RunnerClient | null> {
    const runnerId = record.job.runnerId;
    // 宛先が書かれていない古いジョブは、いまの1台へ寄せる（M4 は単一 runner）。
    //
    // **ここで `select` を呼ばない。** `select` は繋がるまで待つ（新しい委譲を
    // 「いま空いていない」で断らないため）が、この経路は起動時の引き取りや
    // `manager_send` の下にあり、待たせると台帳を読むだけの操作が固まる。
    // 開いている runner が無いなら「宛先が居ない」と答えるのが正しい。
    if (runnerId === undefined) {
      const open = await this.#runners.list().catch(() => []);
      return open[0] ?? null;
    }
    return this.#runners.get(runnerId);
  }

  /**
   * 同じ session を二本起こさない resume。
   *
   * 引き取りの契機は複数ある（起動時の `restore` / runner の `hello` / クローンの
   * `manager_send`）。重なると同じ仕事が二重に走り、同じコミットや同じ PR が
   * 二度出る。**確かめてから立てるまでに `await` を挟まない**こと — 挟むと、
   * その隙に別の契機が同じ判断をする。
   */
  async #resumeOnce(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
  ): Promise<ResumeOutcome> {
    const id = record.job.id;
    if (this.#resuming.has(id)) return 'busy';
    this.#resuming.add(id);
    try {
      return await this.#resume(record, runner, message);
    } finally {
      this.#resuming.delete(id);
    }
  }

  async #resume(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
  ): Promise<ResumeOutcome> {
    const { sessionId, cwd, request, projectKey } = record.job;
    if (sessionId === undefined) return 'no-session';

    // 生ログを渡して materialize させる。runner のディスクに残っている前提を
    // 置かない（器は作り直される）。
    const material = await this.#loadSession(projectKey, sessionId);

    // **引けなかったものを「無い」として先へ進めない。** 材料無しで resume を
    // 投げると、runner は `renderSessionLog` が `null` を返す枝へ入り
    // （`runner.ts` の `#recoverFromFailedResume`）、`resume_failed` の
    // `recovered: false` が返ってくる。受けた側はそれを `lost` に確定させ
    // `#unresumable` へ積む——**一時的に DB が読めなかっただけで、委譲が恒久に
    // 終端する。** 引けなかったことは引けなかったこととして返す。
    if (material.kind === 'unreadable') return 'unreadable';

    await runner.resume({
      managerId: record.job.id,
      sessionId,
      cwd: cwd ?? runner.workspacePath,
      request: request ?? record.job.summary,
      ...(message === undefined ? {} : { message }),
      ...(material.kind === 'loaded' ? { entries: material.entries } : {}),
    });
    record.attached = true;
    record.job.runnerId = runner.runnerId;
    // 戻れたなら諦めを忘れる（人間やクローンが起こし直した後も自動で拾える）。
    this.#unresumable.delete(record.job.id);
    return 'resumed';
  }

  /**
   * 預かってある生ログを引く。**「無い」と「読めなかった」を分けて返す。**
   *
   * ここは `catch` で `null` を返していた。呼び出し側から見ると預かっていない
   * のと見分けが付かず、下流はそれを恒久の結論へ変える（`#resume` の doc）。
   * **書く側（`case 'mirror'`）が守っている線を、読む側だけが破っていた。**
   *
   * **跡を残すのも書く側と揃える。** 黙って握り潰すのをやめるのではなく、
   * stderr に1行だけ残す（`noteUnreadableRecord`）——読めなかったことが
   * どこにも残らないと、後から「無い」のか「読めなかった」のかを誰も言えない。
   * **本文は出さない**（`noteDroppedRecord` と同じ理由。#52）。
   */
  async #loadSession(projectKey: string | undefined, sessionId: string): Promise<SessionMaterial> {
    const store = this.#stores.sessionStore;
    if (store === undefined || projectKey === undefined) return { kind: 'absent' };
    try {
      const entries = await store.load({ projectKey, sessionId });
      // **空と不在を分けない。** どちらも「渡せる材料が無い」であり、引けては
      // いるので待っても変わらない。分けるのは「引けなかった」だけである。
      if (entries === null || entries.length === 0) return { kind: 'absent' };
      return { kind: 'loaded', entries };
    } catch (error) {
      noteUnreadableRecord(
        '預かってある生ログ',
        `projectKey=${projectKey} sessionId=${sessionId}`,
        error,
      );
      return { kind: 'unreadable' };
    }
  }

  async #fromSessionStore(job: Job): Promise<string | null> {
    const material = await this.#loadSession(job.projectKey, job.sessionId ?? '');
    // **読めなかった回に「記録が無い」と答えない。** ここは `transcript()` の
    // 最後の砦で、`null` は呼び出し側で「見せるものが無い」になる。跡は
    // `#loadSession` が stderr に残しているので、少なくとも後から区別できる。
    if (material.kind !== 'loaded') return null;
    const { entries } = material;
    // 生ログの形（1行1 JSON）のまま返す。読む側は runner 由来と区別しなくてよい。
    return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  }

  /**
   * runner から降りてきた出来事をさばく。
   *
   * 記録（日誌・台帳・アーカイブ・生ログ）はすべてここで行う。runner は記憶へ
   * 到達する鍵を持たないので、書けるのはデーモンだけである。
   */
  async #onEvent(event: RunnerEvent): Promise<void> {
    if (event.type === 'hello') {
      // **名乗りは全部 `#reattach` に通す。** 「初回だけ素通り」にすると、起動時に
      // 掴んだ器と、SSE が繋がった先の器が違う場合（畳まれつつある旧 runner が
      // まだ `/health` に答える猶予の間）に取り直しが起きない。`#reattach` は
      // runner に生死を聞くので、何も起きていなければ何もしない。
      void this.#reattach(event.runnerId);
      return;
    }

    const record = this.#records.get(event.managerId) ?? (await this.#load(event.managerId));
    if (!record) return;

    switch (event.type) {
      case 'session': {
        record.job.sessionId = event.sessionId;
        record.attached = true;
        await this.#persist(record);
        return;
      }

      case 'project_key': {
        if (record.job.projectKey === event.projectKey) return;
        record.job.projectKey = event.projectKey;
        await this.#persist(record);
        return;
      }

      case 'report': {
        // **止めたマネージャーを、後から届く出来事で甦らせない。** `abort()` が
        // `#retire()` しても、`#onEvent` は台帳から像を作り直す（`#load()`）ので、
        // 止めた後に届く `report` を無条件に処理すると `record.job.status` を
        // `stopped` から上書きし、`#emit()` でクローンのターンを起こしてしまう
        // （R4）。日誌にだけは残す — 捨てると「黙って失われる」を作る。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `[${event.managerId}] （停止済みのため受信箱へは回さない）${event.text}`,
          });
          return;
        }
        record.job.lastReport = event.text;
        record.job.status = event.status;
        // **失敗として終わった回は台帳にもそう残す。** 本文（`event.text`）は
        // runner 側で既に包まれているが、包んだ文字列だけに頼ると、一覧を出す側は
        // 「報告が来た」と「エラーで死んだ」を本文の先頭を読んで判定することに
        // なる（＝ 表示のたびに文言の判定が要る）。
        //
        // **応答として終わった回では消す。** 残すと、いま生きているマネージャーに
        // 過去の失敗が貼り付いたままになる（`lastReport` と同じで「直近」の意味を
        // 守る）。`delete` にしているのは、`undefined` を入れると
        // `exactOptionalPropertyTypes` で通らないため。
        if (event.failure === undefined) {
          delete record.job.lastFailure;
        } else {
          record.job.lastFailure = { ...event.failure, at: new Date().toISOString() };
        }
        await this.#persist(record);
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}] ${event.text}`,
        });
        // **中身の無い報告は、記録は残すがクローンのターンを起こさない。**
        // `event.contentless` は `runner.ts` の `resultText()` / `reportText()`
        // が「SDK の `result` にも `said`（実際に喋った本文）にも文字が無かった」
        // と確定させたときだけ立つ構造化された印で、`event.text` の中身
        // （`'（報告なし）'` という文字列）を見て判定してはいない
        // （`runner-protocol.ts` の `contentless` の doc）。台帳（`lastReport`）
        // と日誌には上と同じくこれまでどおり残っている — 捨てると「黙って
        // 失われる」を作る（R4 のすぐ上の条件とは別の理由でここに置く。
        // R4 は「止めた後」、こちらは「止めていないが中身が無い」）。
        if (event.contentless === true) return;
        this.#emit(event.managerId, 'report', event.text);
        return;
      }

      case 'ask': {
        // **止めたマネージャーの確認要求を待ちへ積まない。** `report` と同じ理由
        // （R4）——`#retire()` の後も `#load()` が像を作り直すので、ここで無条件に
        // 積むと `waiting` / `status` を `stopped` から動かし、クローンへも
        // `#emit()` してしまう。日誌にだけは残す。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'escalation',
            question: event.summary,
            approvalId: event.requestId,
            managerId: event.managerId,
          });
          return;
        }
        // **requestId で冪等に。** 同じ確認が二度届いても、待ちを積み直さず、
        // 日誌にも二度書かず、クローンへも二度配らない。二度目を配ると、答えた
        // はずの確認がもう一度クローンへ届く（そしてその再送は runner 側で既に
        // 中断済みなので、答えたときには「待っていない」と返る）。
        const asked = this.#askedOf(record);
        if (asked.has(event.requestId)) return;
        asked.set(event.requestId, true);

        record.waiting.push({ requestId: event.requestId, summary: event.summary });
        record.job.status = 'waiting_human';
        await this.#persist(record);
        await this.#journal({
          type: 'escalation',
          question: event.summary,
          approvalId: event.requestId,
          managerId: event.managerId,
        });
        this.#emit(event.managerId, event.kind, event.summary, event.requestId);
        return;
      }

      case 'settled': {
        record.waiting = record.waiting.filter((item) => item.requestId !== event.requestId);
        if (record.job.status === 'waiting_human' && record.waiting.length === 0) {
          record.job.status = 'running';
        }
        await this.#persist(record);
        return;
      }

      case 'note': {
        // runner の内側の事実。マネージャーの発言ではないので受信箱へは出さず、
        // 日誌にだけ残す（`resume_failed` の記録と同じ置き場所）。
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}] ${event.text}`,
        });
        return;
      }

      case 'tool_use': {
        await this.#journal({
          type: 'tool_use',
          actor: event.actor,
          tool: event.tool,
          input: event.input,
        });
        return;
      }

      case 'permission_denied': {
        // **日誌には全部残す。** 確認の入り口を閉じた（`permissionMode: 'auto'`）
        // 以上、閉じた側で何が起きたかを後から辿れる場所が要る。ここが無いと
        // 「静かになった」と「起きていない」が区別できない。
        //
        // **受信箱へは繰り返しのときだけ。** 拒否は正常な運用でも起きるので、
        // 1件ずつ流すとクローンの判断が雑音で鈍る（同じ知らせで埋めない、は
        // `usage_notice` と同じ考え方）。
        const denied = this.#deniedOf(record);
        const count = (denied.get(event.tool) ?? 0) + 1;
        denied.set(event.tool, count);

        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `[${event.managerId}] ${event.tool} の実行が確認へ上がらずに止められた` +
            `（このマネージャーで ${count} 件目 / ${event.via === 'live' ? '走行中の合図' : 'result の記録'}）: ` +
            brief(event.input),
        });

        if (!shouldEscalateDenial(count)) return;
        this.#emit(
          event.managerId,
          'report',
          `${event.tool} の実行が確認へ上がらずに止められた（このマネージャーで ${count} 件目）。` +
            'モデル分類器か deny 規則がその場で拒否しているので、**この確認はクローンには回ってきていない**。' +
            'マネージャーか作業者の手が止まっている可能性がある。' +
            `直近の入力: ${brief(event.input)}\n` +
            '全件は日誌に残っている（`journal_read` で辿れる）。',
        );
        return;
      }

      case 'worker_wait': {
        // **日誌に閉じる。** 台帳（`Job` / `ManagerSummary`）には足さない —
        // 集計は「何を契機にターンが回ったか」を後から掘るためのもので、
        // いま生きているマネージャーの状態を表す値ではない（`runner-protocol.ts`
        // の doc）。クローンの受信箱へも出さない（1区間ごとに割り込むほどの
        // 事実ではなく、掘りたければ `journal_read` で辿れる）。
        await this.#journal({
          type: 'worker_wait',
          openedAt: event.openedAt,
          tasks: event.tasks,
          turns: event.turns,
          byCause: event.byCause,
          toolless: event.toolless,
          notifications: event.notifications,
          submits: event.submits,
          ...(event.sources === undefined ? {} : { sources: event.sources }),
          settled: event.settled,
        });
        return;
      }

      case 'usage': {
        // 降りてくるのは累積という事実で、差分にして積むのはここ（runner は
        // 記憶ストアの鍵を持たないので書けない）。読む→畳む→書くはストアの
        // 1操作に閉じてある。
        const at = new Date();
        let fold;
        try {
          fold = await this.#stores.usage.record({
            // **モデル id で層を代用しないこと。** マネージャーは opus だが、
            // `ALTEROID_CLONE_MODEL` を置けばクローンも opus で走る。
            layer: 'manager',
            // マネージャーのセッション本体。**その中の作業者（Task subagent）と
            // compaction 自体の分もここに混ざっている** — SDK の `modelUsage` が
            // 合算して降ろすので分離できない（`usage.ts` の `usageLayerSchema`）。
            // **作業者の 0 行を作らないこと**（「使っていない」と読める）。
            site: 'session',
            managerId: event.managerId,
            date: usageDate(at),
            at: at.toISOString(),
            snapshot: { sessionId: event.sessionId, models: event.models },
            // streaming-input の長寿命セッションなので、降りてくるのは走行合計。
            accumulation: 'cumulative',
          });
        } catch {
          // 台帳に積めないことで仕事は止めない。ただし黙って消さない。
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `[${event.managerId}] 消費を台帳へ記録できなかった（この分は集計に出ない）`,
          });
          return;
        }

        // **ターン1回ぶんの増分を日誌へ残す。** 台帳は日 × actor × モデル ×
        // 層 × 場所に畳むので、このターンがいくらだったかは台帳のどこにも
        // 残らない（`schema.ts` の `turn_usage` の doc）。**両層（クローンと
        // マネージャー）に入れる** — 片方だけだと非対称が残る（`clone.ts` の
        // `#recordUsage` と同じ形をここにも置く）。
        //
        // 増分が空の回は行を書かない（取れない軸に0の行を作らない。
        // `foldUsageSnapshot` は増えていないモデルの行を `delta` に作らない
        // ので、キーが1つも無ければ増分ゼロが確定する）。
        if (Object.keys(fold.delta).length > 0) {
          await this.#journal({
            type: 'turn_usage',
            layer: 'manager',
            site: 'session',
            managerId: event.managerId,
            ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
            models: fold.delta,
            ...(fold.reset === undefined
              ? {}
              : {
                  reset: { fromCostUsd: fold.reset.fromCostUsd, toCostUsd: fold.reset.toCostUsd },
                }),
          });
        }

        // **数え直しを黙って通さない。** resume や mid-session の `/clear` で
        // 累積が 0 に戻るのは正常だが、記録がないと後から「なぜ集計が飛んで
        // いるか」を誰も辿れない（PRD「可観測性」）。
        if (fold.reset !== undefined) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `[${event.managerId}] 消費の累積が数え直された` +
              `（$${fold.reset.fromCostUsd.toFixed(4)} → $${fold.reset.toCostUsd.toFixed(4)}）。` +
              'resume か /clear で SDK 側の累積が 0 から始まったため。記録済みの分は保持している。',
          });
        }
        return;
      }

      case 'usage_notice': {
        // **ここは `report` / `ask` / `closed` / `resume_failed` と違い、`stopped`
        // ガードを意図的に足していない。** あの4つが運ぶのは**このマネージャー
        // の**仕事の出来事（報告・確認・終了・再開の成否）で、そのマネージャーを
        // 止めた後は捨てて（＝日誌にだけ残して）よい——ターン自体がもう無いから
        // である。対して `usage_notice` / `rate_limit` が運ぶのは**アカウント
        // 単位の枠の事実**（「枠を使い切って課金枠から引き始めた」「枠から追い
        // 返された」）であり、`event.managerId` はどのターンでそれに気づいたかの
        // 印にすぎない。この事実は該当マネージャーを止めても消えない（他の
        // マネージャーも同じ枠を使っている）ので、ここで畳むと**クローンが知る
        // べき本物の情報を「止めたマネージャーの後始末」と誤って一緒に捨てる**
        // ことになる。だから `stopped` かどうかに関わらず、いつもどおりクローン
        // へ知らせる。
        //
        // **クローンへ知らせる。** ここが「上限に当たる前に気づく」の実体である。
        // 枠の利用率は「いま重い仕事を投げてよいか」に効くが、この文言は
        // 「今日もう委譲を続けられるか」に効く。
        //
        // **同じ文言で受信箱を埋めない。** 通知はターンごとに繰り返し届きうるので、
        // そのまま流すとクローンは同じ知らせを何十回も読むことになり、本当に
        // 変わった1回が埋もれる。
        const text = describeUsageNotice(event.notice);
        if (this.#usageNotices.get(event.notice.kind) !== event.notice.text) {
          this.#usageNotices.set(event.notice.kind, event.notice.text);
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `[${event.managerId}] ${text}`,
          });
          this.#emit(event.managerId, 'report', text);
        }
        return;
      }

      case 'rate_limit': {
        // **ここも `stopped` ガードを意図的に足していない。** 理由は `usage_notice`
        // の冒頭のコメントと同じ——運んでいるのはこのマネージャーの仕事ではなく
        // アカウント単位の枠の事実なので、止めたマネージャー経由で届いたからと
        // いって畳まない。
        //
        // 枠の事実はアカウント単位なので、マネージャーごとに持たない。
        // **ターン中しか届かない**ので、走行中はここが最新になる。
        const transition = usageTransitionOf(
          this.#rateLimits.get(event.facts.kind ?? ''),
          event.facts,
        );
        this.#rateLimits.set(event.facts.kind ?? '', event.facts);
        if (transition === undefined) return;

        // 「移った」「追い返された」の**瞬間だけ**を知らせる（状態を毎回流さない）。
        const reason =
          event.facts.overageDisabledReason === undefined
            ? ''
            : `（課金枠が使えない理由: ${event.facts.overageDisabledReason}）`;
        const text =
          transition === 'entered_overage'
            ? `枠を使い切って課金枠から引き始めた（${event.facts.kind ?? '枠'}）。` +
              `**まだ動くが、この先で止まる。**${reason}`
            : `枠から追い返された（${event.facts.kind ?? '枠'}）。この枠ではもう通らない。${reason}`;
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}] ${text}`,
        });
        this.#emit(event.managerId, 'report', text);
        return;
      }

      case 'mirror': {
        const store = this.#stores.sessionStore;
        if (store === undefined) return;
        try {
          await store.append(event.key, event.entries as never);
        } catch (error) {
          // 生ログを預かれなくてもマネージャーは止めない。ただし黙って消さない —
          // 器を作り直した後に生ログへ降りられないのは可観測性の最下段が抜ける
          // ことで、預かり損ねたことすら残らないと、後から「無い」のか
          // 「預かれなかった」のかが分からない。
          noteDroppedRecord(
            '生ログのミラー',
            `managerId=${event.managerId} projectKey=${event.key.projectKey} ` +
              `sessionId=${event.key.sessionId} entries=${event.entries.length}`,
            error,
          );
        }
        return;
      }

      case 'archive': {
        try {
          const id = await this.#stores.archive.archive(event.managerId, event.body);
          record.job.archiveIds = [...(record.job.archiveIds ?? []), id];
          await this.#persist(record);
        } catch (error) {
          // 退避できなくてもマネージャーを止めない。ただし黙って消さない —
          // 退避できなかったトランスクリプトは器と一緒に消えるので、
          // 跡が無いと「そもそも退避しなかった」と区別が付かない。
          noteDroppedRecord(
            'トランスクリプトの退避',
            `managerId=${event.managerId} chars=${event.body.length}`,
            error,
          );
        }
        return;
      }

      case 'resume_failed': {
        // **止めたマネージャーの resume_failed で status を巻き戻さない・クローンを
        // 起こさない（R4）。** `abort()` が `stopped` を確定させた後で、直前に
        // 投げていた resume（`#restoreJobs` / `#reattach` の自動再開）の結果が
        // 遅れて届くことがある。無条件に処理すると、下の分岐が
        // `record.job.status` を `running`（`event.recovered` のとき）か
        // `'lost'`（それ以外）へ書き換え、`#notifyResumeFallback` /
        // `#notifyUnresumable` で `#post()` してしまう——`report` / `ask` /
        // `closed` と同じ形で終端が甦る。日誌にだけは残す。
        //
        // **明示的な `manager_send` で起こし直した場合はここに掛からない。**
        // `send()` は `#resumeOnce` を呼んで resume が受理された後、
        // 同じ呼び出しの中で `record.job.status = 'running'` を先に書く
        // （`send()` 本体）。この `resume_failed` は SDK 側の検証が終わってから
        // 別経路（SSE）で遅れて届くので、その頃には status は既に `'stopped'`
        // ではない——つまり `stopped` から人間・クローンが明示的に戻す能力
        // （`schema.ts` の `jobStatusSchema` の doc）は、このガードで塞がれない
        // （`manager.test.ts` の「止めたマネージャーの後続イベント（R4）」で
        // 固定してある）。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `[${event.managerId}] （停止済みのため無視）前のセッション` +
              `（${event.sessionId}）を開き直せなかった: ${event.reason}`,
          });
          return;
        }
        // **「resume を投げた」は「戻れた」ではない。** ここが来るということは、
        // `#resume` が `true` を返した後に SDK が会話を見つけられなかったという
        // ことである。台帳と受信箱を、実際に起きたことへ揃え直す。
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `[${event.managerId}] 前のセッション（${event.sessionId}）を開き直せなかった: ` +
            event.reason,
        });
        if (event.recovered) {
          record.job.status = 'running';
          record.attached = true;
          await this.#persist(record);
          this.#notifyResumeFallback(record, event.sessionId, event.reason);
          return;
        }
        // 待っても同じ答えが返る失敗である。**自動の挑み直しはここで打ち切る** —
        // 続けても同じ障害通知が受信箱に積み上がるだけで、誰も状況を知れない。
        // 人間とクローンの明示的な `manager_send` は塞がない（`#unresumable` は
        // 見られていないし、戻れたら忘れる）。
        this.#unresumable.add(event.managerId);
        // **諦めをプロセス内の記憶だけに置かない。** `#unresumable` は器と一緒に
        // 消えるので、それだけだと次のデプロイでまた同じ死体を起こしに行き、また
        // 失敗し、また忘れる — 長い目で見れば「黙って挑み続けている」のと同じで
        // ある。台帳を終端状態へ落として、諦めを再起動の向こう側まで持たせる。
        record.job.status = 'lost';
        record.attached = false;
        // **`waiting` は `closed` と揃えて畳む。** 現在の呼び出し元（`send` /
        // `#reattach` / `#restoreJobs`）はどれも resume を投げる前に `waiting` を
        // 空にしているので実害は無いはずだが、`#retire` で像ごと消す以上、
        // 「消える時点で waiting が空である」を代入の数え上げに頼らせない。
        record.waiting = [];
        await this.#persist(record);
        this.#notifyUnresumable(record, event.reason, 'session');
        this.#retire(event.managerId);
        return;
      }

      case 'closed': {
        // **既に止めたマネージャーの `closed` で status を巻き戻さない（R4）。**
        // `abort()` が `stopped` に確定させたあとで runner 側の
        // `RunnerSession#finish()` が遅れて届くことがある。ここで無条件に
        // `event.status`（`done` / `lost` / `failed`）へ上書きすると終端が甦り、
        // `status === 'failed'` の枝がクローンへ `#emit()` してしまう。日誌には
        // 残す——`#retire()` は abort() が既に済ませているので、ここではもう一度
        // 呼ばない（呼んでも `#records.delete` は冪等だが、意味の無い呼び出しを
        // 増やさない）。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `[${event.managerId}] （停止済みのため無視）runner 側の終了イベント` +
              `（status=${event.status}）を受け取った: ${event.reason}`,
          });
          return;
        }
        record.job.status = event.status;
        record.waiting = [];
        record.attached = false;
        await this.#persist(record);
        if (event.status === 'failed') this.#emit(event.managerId, 'report', event.reason);
        // **`closed` は runner 側の `RunnerSession#finish()` を通った印**であり、
        // done / lost / failed のどれであれ、この委譲はもう走っていない。
        this.#retire(event.managerId);
        return;
      }

      default: {
        const exhaustive: never = event;
        throw new Error(`未知の runner イベント: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 台帳と受信箱
  // -------------------------------------------------------------------------

  /**
   * 配った確認の帳面。無ければここで作る。
   *
   * 上限に達したら**黙って忘れない** — 忘れた id の `ask` が再送されると、
   * それは新しい確認としてもう一度クローンへ回る。日誌に残っていなければ、
   * 「なぜ同じ確認が二度来たのか」を後から誰も辿れない。
   */
  #askedOf(record: ManagerRecord): RecentMap<true> {
    const existing = record.asked;
    if (existing !== undefined) return existing;
    const managerId = record.job.id;
    const asked = createRecentMap<true>({
      limit: ASKED_MEMORY_LIMIT,
      onForget: (ids) => {
        void this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `[${managerId}] 配り終えた確認の記憶が上限（${ASKED_MEMORY_LIMIT}件）に達したので、` +
            `古い ${ids.length} 件を忘れた: ${ids.join(', ')}。` +
            'この id の確認が再送されると、新しい確認としてもう一度回る。',
        });
      },
    });
    record.asked = asked;
    return asked;
  }

  /**
   * 拒否を数える帳面。無ければここで作る。
   *
   * 上限に達したら**黙って忘れない** — 忘れた道具の件数は 0 から数え直しになり、
   * 「もう何十回も止められている」という形が受信箱に出るまでの距離が伸びる。
   */
  #deniedOf(record: ManagerRecord): RecentMap<number> {
    const existing = record.denied;
    if (existing !== undefined) return existing;
    const managerId = record.job.id;
    const denied = createRecentMap<number>({
      limit: DENIED_TOOL_LIMIT,
      onForget: (tools) => {
        void this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `[${managerId}] 拒否の件数を覚えている道具が上限（${DENIED_TOOL_LIMIT}種）に達したので、` +
            `古い ${tools.length} 件を忘れた: ${tools.join(', ')}。` +
            'この道具が次に止められたら 1 件目から数え直す（日誌には全件残っている）。',
        });
      },
    });
    record.denied = denied;
    return denied;
  }

  #choosePending(
    record: ManagerRecord,
    requestId: string | undefined,
  ): { requestId: string; summary: string } | null | 'ambiguous' | 'gone' {
    if (requestId !== undefined) {
      return record.waiting.find((item) => item.requestId === requestId) ?? 'gone';
    }
    if (record.waiting.length === 0) return null;
    if (record.waiting.length === 1) return record.waiting[0] ?? null;
    return 'ambiguous';
  }

  /** 台帳から像を作る（再起動後に届いたイベントの受け皿）。 */
  async #load(managerId: string): Promise<ManagerRecord | null> {
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    if (!job) return null;
    const record: ManagerRecord = { job: { ...job }, waiting: [], attached: false };
    this.#records.set(managerId, record);
    return record;
  }

  #notifyRestored(
    record: ManagerRecord,
    how: 'attached' | 'resumed',
    cause: RestartCause = 'daemon',
  ): void {
    const { job } = record;
    const head = cause === 'runner' ? 'runner の器が作り直された' : 'デーモンが再起動した';
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId: job.id,
      kind: 'report',
      text: [
        how === 'attached'
          ? `${head}。この委譲は runner の中で走り続けている。`
          : `${head}。中断されていたこの委譲を、前のセッションから再開させた。`,
        `依頼: ${job.request ?? job.summary}`,
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        job.lastReport === undefined ? '' : `直近の報告: ${job.lastReport}`,
        '',
        how === 'attached'
          ? '返事待ちがあれば改めて届く。`manager_send` で追加の指示も送れる。'
          : '再開の指示は送信済みなので、報告を待てばよい。' +
            '返事待ちだった確認は器と一緒に失われているので、必要ならマネージャーが聞き直してくる。',
        // **作業ディレクトリが空かもしれないことを黙っていない。** 器に永続化が
        // 無ければコミット前の変更は消えている（roadmap M5「workspace 復旧」）。
        cause === 'runner'
          ? '器に永続化が無ければ、コミット前の変更は失われている。' +
            '同じ結果を期待せず、手元の状態から組み立て直させること。'
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
  }

  #emit(
    managerId: string,
    kind: 'report' | 'question' | 'permission',
    text: string,
    requestId?: string,
  ): void {
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId,
      kind,
      text,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  async #persist(record: ManagerRecord): Promise<void> {
    record.job.updatedAt = new Date().toISOString();
    try {
      await this.#stores.jobs.putJob(record.job);
    } catch (error) {
      // ジョブ台帳が書けなくてもマネージャーは走らせる。
      // **ただし黙って消さない。** ここが落ちると `status` と `lastReport` が
      // 台帳に載らない。「後から `manager_report` で読めた ⟹ 経路が通っていた」は
      // 成功した場合の話であって、**失敗は台帳にも日誌にも跡を残さない**。
      noteDroppedRecord('ジョブ台帳', `job id=${record.job.id} status=${record.job.status}`, error);
    }
  }

  /**
   * **本当に終わった**委譲の像を `#records` から外す。
   *
   * `ManagerRecord` の JSDoc は「像はマネージャーと一緒に消えるので寿命は元から
   * 有限」と書いているが、その前提を実装のどこも守っていなかった —
   * `#records` は委譲1本ごとに1件増え続け、`done` / `lost` / `failed` に着いても
   * 一度も外れない（実測で6日に58本）。ここが唯一の出口である。
   *
   * **呼び方は「上限で古いものを捨てる」ではなく「終端したものを外す」。** 上限を
   * 持たせると、走行中のマネージャーが増えただけで無関係な1本が押し出される形に
   * なりうる — それは north_star 禁止2（実行回数・保持数の上限で能力を制限する）
   * に触れる。ここは**状態遷移だけ**を契機にする。
   *
   * **消えるのはプロセス内の像だけ。** `Job` 本体は `#persist()` 済みなので
   * `JobStore` に残る。`list()` はそこから summary を作り直せる（下記）ので、
   * 一覧・`manager_report` の機能は落ちない。消えるのは `waiting`（＝もう
   * 空である前提。呼び出し側が先に畳んでから呼ぶこと）・`asked`・`denied` の
   * プロセス内だけの帳面である。**`denied` はそもそも起動をまたいで残らない
   * 設計**（`denied` の JSDoc）なので、ここで早める分は「デーモンを作り直せば
   * どうせ消える」ものが少し早く消えるだけで、性質は変わらない。
   *
   * **`send()` / `abort()` / 届いたイベントは困らない。** どれも
   * `#records.get(managerId) ?? (await this.#load(managerId))` の形で、居なければ
   * 台帳から作り直す経路を最初から持っている（`#load()`）。外した直後に
   * `manager_send` が来ても、`#load()` が同じ形の像を作り直し、`sessionId` が
   * 残っていれば `lost` / `failed` へ明示的に話しかけて起こし直す経路
   * （`send()` の `!record.attached` 分岐）はそのまま通る。
   */
  #retire(managerId: string): void {
    this.#records.delete(managerId);
  }

  async #journal(entry: JournalEntryInput): Promise<void> {
    try {
      await this.#stores.journal.append(entry);
    } catch (error) {
      // 記録できないこと自体は致命ではない。委譲を止める方が高くつく。
      // **ただし黙って消さない。** 跡がどこにも無いと「日誌に無い」が
      // 「起きなかった」と読めてしまう（本文を出さない理由は `noteDroppedRecord`）。
      noteDroppedRecord('日誌', journalEntryShape(entry), error);
    }
  }
}

/**
 * この件数の拒否をクローンへ上げるか。
 *
 * `3, 9, 27, 81…`（3倍ごと）。**上げ続けない**のは、止められ続けている1本が
 * 受信箱を埋めると、他の判断材料がそれで押し流されるからである。**黙りもしない** —
 * 続いていれば次の桁で必ずもう一度出る。
 *
 * **束ねる単位は道具の名前**である（入力の中身では束ねない）。1文字違う `Edit` を
 * 別物として数えると、実機で起きた形（同じファイルの編集が何度も拒否される）を
 * 取り逃す。粗いぶん「別々の対象で1回ずつ拒否された3件」も束ねるが、**それも
 * 知りたい形**なので意図してこうしてある。
 */
function shouldEscalateDenial(count: number): boolean {
  if (count < DENIED_ESCALATE_AT) return false;
  let step = DENIED_ESCALATE_AT;
  while (step < count) step *= 3;
  return step === count;
}

/**
 * 何が作り直されたか。**マネージャーから見える景色が違う。**
 *
 * デーモンだけなら作業ディレクトリはそのまま残っている。runner ごとなら、
 * 器に永続化が無ければコミット前の変更は消えている。
 */
/**
 * resume が `'resumed'` にならなかったときに `manager_send` が返す1行。
 *
 * **種類ごとに違うことを言う。** ここは全部を「`session_id` を持っておらず、
 * 続きへ戻れない。新しく起こし直すこと。」と言っていた——**引きに行って失敗した
 * だけのときにもそう言っていた**ので、読んだ側は恒久の結論を持ち帰り、しかも
 * 「起こし直せ」という誤った行動を指示されていた（起こし直せば続きは失われる）。
 *
 * **恒久と一時を混ぜない。** `no-session` だけが恒久で、`unreadable` と
 * `busy` は待てば直りうる。この区別は `RunnerRegistry#select` の doc が
 * 「呼んだ側の対応が変わるので必ず区別する」と書いているものと同じ形である。
 *
 * **言い方の持ち主を1つにする。** `send()` は `#resuming` を事前にも見るので、
 * 同じ「取り直している最中」を2箇所で書くと、片方だけが直る形になる。
 */
function resumeFailureDetail(
  managerId: string,
  outcome: Exclude<ResumeOutcome, 'resumed'>,
): string {
  switch (outcome) {
    case 'no-session':
      return `${managerId} は session_id を持っておらず、続きへ戻れない。新しく起こし直すこと。`;
    case 'unreadable':
      return (
        `${managerId} の続きに要る生ログを、いま読み出せなかった。` +
        '預かっていないのではなく、引きに行って失敗した（跡はデーモンの stderr にある）。' +
        '待てば直る種類の失敗なので、少し置いてから送り直すこと。' +
        '起こし直すと続きは失われるので、ここで起こし直さないこと。'
      );
    case 'busy':
      return `${managerId} は器の入れ替えから取り直している最中である。少し置いてから送り直すこと。`;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`未知の resume の結果: ${JSON.stringify(exhaustive)}`);
    }
  }
}

type RestartCause = 'daemon' | 'runner';

/** 再起動後に流す一言。**開き直すだけでは仕事は進まない。** */
function restartNudge(status: JobStatus, cause: RestartCause): string {
  // **runner が入れ替わったことを「デーモンが再起動した」と伝えない。** 手元が
  // 残っている前提で続きを書き始めると、消えた作業を書いたつもりで進む。
  const head =
    cause === 'runner'
      ? '[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、' +
        '続きに入る前に手元の状態を確かめよ。'
      : '[system] デーモンが再起動した。';
  if (status === 'waiting_human') {
    return (
      `${head}あなたが待っていた確認は器と一緒に失われている。` +
      'まだ必要なら聞き直し、不要なら中断していた作業の続きを進めよ。'
    );
  }
  return `${head}中断していた作業の続きを進めよ。`;
}

/**
 * プロセス内の像から「このデーモンから話しかけられるか」を出す。
 *
 * **像が `#records` に載っていること自体は「話しかけられる」ではない。** 載る
 * 契機は引き取り（`#restoreJobs`）だけではなく、`send()` / `abort()` /
 * 届いたイベントが台帳から作る `#load()` もある。そちらは戻れるかを何も
 * 確かめていないので、載っていることを根拠に `true` と数えると、
 * `status: lost`（前のセッションへ戻れなかった）と `live: true`（繋がっている）
 * という両立しない組が出る。
 */
function isLive(record: ManagerRecord): boolean {
  // **`lost` は何より先に見る。** 「繋がっている（`attached`）なら live」を先に
  // 置くと、両立しない組を出さないことが「両者が同時に立つ代入が無い」という
  // 追跡結果に頼ることになる。実際に立つ隙間がある — 起動時の引き取りは runner が
  // 名乗った状態をそのまま採りつつ `attached: true` を固定する（`#restoreJobs`）
  // ので、runner の側で resume 失敗が確定してからそのセッションが一覧から消える
  // までの間に引き取ると、`lost` の像が `attached: true` で立つ。
  // **`stopped` も `lost` と同じ列に置く。** どちらも「戻せるか」を実際に確かめた
  // 結果として付く終端で、当て推量ではない — `lost` は resume を試して戻れな
  // かったという事実、`stopped` は `abort()` が `runner.list()` を探ってセッション
  // が消えたことを確かめた事実である。`abort()` は `job.sessionId` 自体は消さない
  // ので（消す積極的な理由が無い限り、消せる情報は残す）、下の `sessionId` 分岐
  // だけに任せると停止後も古い `sessionId` が生きていて `live: true` に化ける。
  //
  // **これは「ブラックリストを伸ばす」ことにはしていない。** ここで名指しして
  // いるのは「デーモン自身が既に確かめて確定させた終端状態」の列挙であって、
  // `#restoreJobs` の `attached` 判定（未知の将来の状態を安全側＝`false` に倒す
  // ホワイトリスト）とは問いが違う——あちらは「まだ確かめていない runner 由来の
  // 状態をどう解釈するか」、ここは「デーモン自身が既に確定させた2つの状態を
  // 上書きさせない」という話である。将来 `lost` / `stopped` 以外の終端状態が
  // 増えても、この関数の既定（`attached` → `sessionId` の順で見る）は変わらない
  // ——増えた状態をここに足し忘れても、危険側（`true`）に化けるとは限らない
  // （`attached` は新しい状態では通常 `false` に倒れているはずである）ので、
  // 未対応のまま放置しても即座に嘘をつくわけではない。ただし将来この関数を
  // 触る人は、新しい終端状態が「戻せないと確定している」ものなら、ここに
  // 足すのが正しい。
  if (record.job.status === 'lost' || record.job.status === 'stopped') return false;
  // runner にセッションが居るなら、そのまま送れる。
  if (record.attached) return true;
  // 繋がっていない像は「戻せるか」で決まる。session_id が無いものは戻る先が無い。
  // **「戻れなかった（`lost`）」と「戻る先が無い（session_id なし）」を潰しては
  // いない** — どちらなのかは `status` と `sessionId` が別々に持ったままで、
  // `live` が言うのは「話しかけられるか」だけである。
  return record.job.sessionId !== undefined;
}

/**
 * `live` に既定値を置かないのは、**省略した側が黙って「繋がっている」と名乗る**
 * からである。呼び出しを足す人は `live` のことを考えていないのが普通で、既定が
 * 肯定側にあると、考えなかったことが「繋がっている」という主張になって外へ出る
 * （実際に `list()` がそれで嘘をついた）。既定を `false` にすれば害は小さくなるが、
 * 今度は「繋がっているのに切れて見える」が黙って混ざる。**判断そのものを省略
 * させない**のが要点なので、引数を必須にして呼ぶ側に必ず書かせる。
 */
function summaryOf(record: ManagerRecord, live: boolean): ManagerSummary {
  const { job } = record;
  return {
    managerId: job.id,
    status: job.status,
    live,
    cwd: job.cwd ?? '',
    request: job.request ?? job.summary,
    startedAt: job.createdAt,
    updatedAt: job.updatedAt,
    waiting: [...record.waiting],
    ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
    ...(job.lastReport === undefined ? {} : { lastReport: job.lastReport }),
    // **`lastReport` と同じ行で運ぶ。** 片方だけを載せると、読む側は「報告が来た」
    // と「エラーで死んだ」を本文の文言で判定するしかなくなる（塞いだ穴がここで
    // 開き直る）。応答として終わった回では台帳側で消えているので、ここは台帳を
    // そのまま写すだけでよい。
    ...(job.lastFailure === undefined ? {} : { lastFailure: job.lastFailure }),
    ...(job.runnerId === undefined ? {} : { runnerId: job.runnerId }),
    ...(job.workspace === undefined ? {} : { workspace: job.workspace }),
  };
}
