import { randomUUID } from 'node:crypto';

import {
  journalEntryShape,
  noteBackgroundFailure,
  noteDroppedRecord,
  noteManagerIdCollision,
  noteUnreadableRecord,
  runnerEventShape,
} from './dropped-record.js';
import { excerptLine, renderListing } from './excerpt.js';
import {
  LEASE_TTL_MS,
  describeAmbiguousSighting,
  describeVerdict,
  grantLease,
  judgeLease,
  mayClaim,
  releaseLease,
  touchLease,
  type LeaseSighting,
} from './lease.js';
import { codeSpan } from './markdown-span.js';
import type { ProfileService } from './profile-service.js';
import { createRecentMap, type RecentMap } from './recent.js';
import { reportRunnerRevision, resolveBuildRevision } from './revision.js';
import type { RunnerRevisionReport } from './revision.js';
import {
  describeRunnerEntries,
  isFencedRunnerError,
  isRetryableRunnerError,
} from './runner-protocol.js';
import type {
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerExecutionResources,
  RunnerLiveness,
  RunnerProfileFingerprint,
  RunnerRegistry,
  RunnerRevisionStatus,
  RunnerWaiting,
} from './runner-protocol.js';
import { brief } from './runner.js';
import type {
  InboxEvent,
  Job,
  JobStatus,
  JournalEntryInput,
  TextMarkup,
  WorkspaceLocator,
} from './schema.js';
import type { Stores } from './store.js';
import {
  describeUsageNotice,
  mergeRateLimitFacts,
  usageTransitionOf,
  type RateLimitFacts,
} from './usage-limits.js';
import type { TokenRotatorObservation } from './token-rotator.js';
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
  /**
   * 宛先の器を、名簿が「名乗らなくなった」と判定した時刻（ISO8601）。判定して
   * いなければ**欄ごと消える**。
   *
   * **`live: false` の理由を1つだけ名指しする欄である。** `live` は「話しかけ
   * られるか」しか言わないので、`false` を見た側は「セッションが終わったのか」
   * 「宛先の器が消えたのか」を区別できない。区別できないと打つ手が決まらない
   * （起こし直すのか、器の側を見るのか）。
   *
   * **`status` は動かさない。** ここに出るのは「宛先の器が黙った」という名簿の
   * 判定であって、「この委譲が失われた」ではない — 黙っているのが器なのか経路
   * なのかは片側からは決められず、器の中でまだ走っている可能性が残る
   * （`RunnerRegistryOptions.onLost` の doc）。`lost` は resume を試して戻れ
   * なかったという**確かめた事実**に付く名前なので、ここでその名前を使わない。
   */
  runnerLostSince?: string;
  cwd: string;
  request: string;
  startedAt: string;
  updatedAt: string;
  sessionId?: string;
  lastReport?: string;
  /**
   * `lastReport` を**デーモンが受け取った時刻**（#358。`jobSchema.lastReportAt`
   * の写し）。
   *
   * **⚠️ 名前が意味を決める。** これは「デーモンが報告を受け取った時刻」で
   * あって、「マネージャーが報告を生成した時刻」でも「クローンのターンへ
   * 配られた時刻」でもない。前者は runner 側で包まれる前の話なのでデーモンは
   * 測っていない。後者はいまどのレコードにも無く、日誌（`#handle` が書く1行の
   * 書き込み時刻）を掘らないと取れない。**測っていない名前を付けない**
   * （AGENTS.md「取れない軸に0の行を作る」と同じ理由——ここは0ではなく
   * 「別の時点」を名乗ってしまう危険なので、doc で先に断っておく）。
   */
  lastReportAt?: string;
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
   * 貸し出し（`jobSchema.lease`）— **その宛先のどのプロセスが、いつまで握ると
   * 約束したか**（M5 PR4）。
   *
   * **判定は載せない。** 引き取ってよいかは時刻で答えが変わる（`judgeLease`）ので、
   * 一覧に焼くと読んだ瞬間から古びる。ここに出すのは材料だけで、判定は読む側が
   * その時刻で行う。**材料が出ていないと、引き取りが動かないのを見た人間とクローンは
   * 「忘れている」と「まだ握られていて待っている」を区別できない。**
   */
  lease?: NonNullable<Job['lease']>;
  /**
   * 返事待ちで止まっている件。
   *
   * **1本のマネージャーが同時に複数を待つことがある。** 1回のアシスタント応答で
   * 並列に呼ばれた道具は、それぞれ別の確認として同時に降りてくる。だから配列で持ち、
   * 回答は `requestId` で宛先を指定する。
   *
   * **`kind`（`'question'` / `'permission'`）も運ぶ（#334）。** 画面が質問と
   * 実行許可を区別して出し分けるための材料——種別は runner 側で既に決まって
   * いる（`RunnerWaiting` と同じ形）。
   *
   * **`askedAt` も同じく運ぶ。** 「runner がこの確認を受け取った時刻」1つに
   * 意味を固定してある（`RunnerWaiting.askedAt` の doc）。人間が見たとき、
   * 5分前の確認か4時間前の確認かで打つ手が変わる（#323）。
   */
  waiting: RunnerWaiting[];
}

/**
 * 「確認へ上がらずに止められた」件数（道具・層ごと）。
 *
 * **`status` では表せない。** 分類器か deny 規則がその場で拒否したとき、その仕事は
 * `running` のまま手が止まる — デーモンから見えるのは「拒否があった」という事実
 * だけで、**それで止まったのかどうかは観測していない**。だから状態の値は増やさず、
 * 状態に**添える**形で出す（`manager_list`）。
 */
export interface ManagerDenial {
  tool: string;
  count: number;
  /**
   * どちらの手が止まったか。**`undefined` は「マネージャーだった」ではなく
   * 「層が取れなかった」という第3の状態である。** `undefined` を `'manager'`
   * 側へ寄せないこと——寄せると、`via: 'result'`（SDK 曰く authoritative な
   * 記録。`agent_id` を持たないため層を判定できない）で拾った拒否が、実際は
   * 作業者のものでも黙ってマネージャーの拒否として数えられてしまう
   * （Issue #373、2026-08-24 コメント #5393921053 が指摘した実害と同じ形）。
   *
   * 材料は `runner.ts` の `#noteDenial` が読む SDK の `agent_id`
   * （`SDKPermissionDeniedMessage.agent_id`）で、`via: 'live'` のときにしか
   * 載らない。旧い runner（`actor` をまだ送ってこないデプロイのずれの窓）
   * からの応答も、同じ「取れていない」に自然に落ちる。
   */
  actor?: 'manager' | 'worker';
}

/**
 * `event.actor`（`RunnerEvent` の `tool_use` / `permission_denied` が運ぶ
 * `manager:<id>` / `worker:<id>:<agent>` の生の文字列）から、`ManagerDenial`
 * が持つ粗い層だけを取り出す。
 *
 * **`undefined` と、どちらの接頭辞にも一致しない文字列は同じ「取れていない」
 * として扱う。** 判定できない形を推測でどちらかへ倒さない（このファイルが
 * 繰り返し選んでいる規則——`ManagerDenial.actor` の doc と同じ）。
 */
function denialActorLayerOf(actor: string | undefined): 'manager' | 'worker' | undefined {
  if (actor === undefined) return undefined;
  if (actor.startsWith('worker:')) return 'worker';
  if (actor.startsWith('manager:')) return 'manager';
  return undefined;
}

/**
 * `#deniedOf` の帳面（`RecentMap<number>`）のキーを「道具＋層」で作る。
 *
 * **値の型（`number`）は変えない。** 道具名だけをキーにしていた形から、
 * 道具と層の組をキーにする形へ変えるだけで、`DENIED_TOOL_LIMIT` /
 * `onForget` の仕組みはそのまま使い回せる——ただし**上限は「道具の種類数」
 * ではなく「道具×層の組の種類数」に対して効くようになる**（同じ道具が
 * マネージャーと作業者の両方で拒否されると、2組として数える）。
 *
 * 区切りに `'::'` を使う——道具名（SDK のツール名 / MCP の
 * `mcp__<server>__<tool>`）にこの並びが現れることは無い（MCP の区切りは
 * `__` であって `::` ではない）。層が取れていない回は空文字ではなく
 * `'unresolved'` を置く——空文字だと、将来 `actor` の型が増えたときに
 * 「取れていない」と「その名前の層」が偶然衝突しうる。
 */
const DENIAL_KEY_SEPARATOR = '::';
const DENIAL_ACTOR_UNRESOLVED = 'unresolved';

function denialKey(tool: string, actor: 'manager' | 'worker' | undefined): string {
  return `${actor ?? DENIAL_ACTOR_UNRESOLVED}${DENIAL_KEY_SEPARATOR}${tool}`;
}

/** `denialKey` の逆変換。`onForget` が忘れた組を人間へ言うためだけに使う。 */
function decodeDenialKey(key: string): { tool: string; actor: 'manager' | 'worker' | undefined } {
  const separatorIndex = key.indexOf(DENIAL_KEY_SEPARATOR);
  if (separatorIndex === -1) return { tool: key, actor: undefined };
  const rawActor = key.slice(0, separatorIndex);
  const tool = key.slice(separatorIndex + DENIAL_KEY_SEPARATOR.length);
  return { tool, actor: rawActor === 'manager' || rawActor === 'worker' ? rawActor : undefined };
}

/**
 * `runner_list` の内訳に出るマネージャー1本ぶん（器ごとの内訳と `unassigned` で
 * 同じ形を使う）。
 *
 * **`live` を必ず持たせる。** `status`（ジョブ台帳の軸）だけを運ぶと、
 * `manager_list` が区別している「走行中」と「走行中だがセッション切断」が
 * `runner_list` の側でだけ潰れる——**同じ状態を2つの道具が別の字面で出す**
 * ことになり、読んだ側は「どちらが本当か」を判定できない。#540 はこの潰れ方を
 * 定期 tick の要約（`digest.ts`）で直したが、この一覧は直していなかった。
 * 字面を作るのは `describeManagerState`（`digest.ts`）1箇所だけで、そこは
 * `live` を要求する——だから材料の側にも必ず載せる。
 *
 * **省略可能（`live?`）にしないのは `summaryOf` の `live` と同じ理由である。**
 * 足す人は `live` のことを考えていないのが普通で、欠けたまま通ると
 * `describeManagerState` が「セッション不明」を出す——**取れているのに
 * 「取れていない」と名乗る**側へ黙って倒れる。値は `ManagerPool#list()` が
 * 既に計算済み（`isLive()`）なので、載せるのに追加の往復は要らない。
 */
export interface RunnerManagerEntry {
  managerId: string;
  status: JobStatus;
  /** このデーモンから話しかけられるか（`ManagerSummary.live` の写し）。 */
  live: boolean;
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
   * **いまこの宛先に応えているプロセス**（`RunnerEntry.instanceId` の写し）。
   *
   * `runnerId` は器を作り直しても同じなので、名前だけでは「さっき仕事を渡した
   * 相手と同じプロセスか」が言えない。クローンはこれを見て、**自分が起こした委譲が
   * 載っていた器がまだ同じプロセスかを確かめられる**（入れ替わっていれば、そこで
   * 走っていた委譲は失われている可能性がある）。
   *
   * **名乗らない runner では無い。** 無いことを「入れ替わっていない」と読まないこと。
   */
  instanceId?: string;
  /** そのプロセスをデーモンが**初めて見た時刻**。引き取りの猶予はここから数える。 */
  instanceSince?: string;
  /**
   * この器に紐づくマネージャー（`ManagerSummary.runnerId` が一致した分）。
   *
   * **ここで数えている本数はデーモンの台帳から見た数である。** 新しいマネージャー
   * をどこへ置くかの判断（資源による自動配置 `chooseByResources`）が使っている
   * 本数は、runner 自身が `/health` で名乗る別の値（`RunnerPlacementResources.
   * managers`）で、**この一覧とは別物であり、ずれうる。** 混ぜて「配置はこの数を
   * 見て決めている」と読まないこと。
   */
  managers: RunnerManagerEntry[];
  /** 配られている鍵の指紋。`fingerprints: true` を渡したときだけ載る（値は sha256）。 */
  credentials?: RunnerCredentialFingerprint[];
  /** 置かれている実行環境プロファイルの指紋。`fingerprints: true` を渡したときだけ載る。 */
  profile?: RunnerProfileFingerprint;
  /**
   * 実行環境の資源。`resources: true` を渡したときだけ載る（#315。`fingerprints`
   * と同じ opt-in の形——`ManagerPool.runners()` の doc を参照）。
   *
   * **いまここで使うのは `pids` だけ**（#315 案1「器の pids の合計を見せる」）。
   * `cpu` / `memory` も同じ形で乗ってくるが、`runner_list` の出力はまだ pids しか
   * 読まない——出す先は別に諮る。
   *
   * **3つの状態を、ここで潰さないこと**（`RunnerRevisionStatus` の `known` /
   * `unknown` / `unheard` と同じ作法）:
   *
   * 1. **読めた** — `resources.pids` が在る
   * 2. **runner に訊けなかった** — `resources` 自体が `undefined`
   *    （器が開いていない・`resources()` が失敗した・応答が無かった）
   * 3. **訊けたが pids が読めなかった** — `resources` は在るが `pids` が無い
   *    （cgroup を持たない器。ローカル開発など。フォールバック先が無いので
   *    `readExecutionResources` の doc のとおり欄ごと省略される）
   *
   * **2 と 3 を同じ文言に倒さないこと。** どちらも「pids が出せない」で終わるが、
   * 疑う先が違う——2 は接続・器の生死、3 は器の cgroup 構成である。
   */
  resources?: RunnerExecutionResources;
  /**
   * runner が名乗った版（コミット sha）。**3状態を区別する**
   * （`RunnerRevisionStatus`）——`known`（版が取れた）/ `unknown`（名乗ったが
   * runner が自分の版を知らない）/ `unheard`（名乗り自体をまだ聞けていない）。
   *
   * **`state`（`RunnerLiveness`）から導けない。** `state: 'lost'` でも直前の
   * `known` な版がそのまま残ることがある（`RunnerRevisionStatus` の doc）。
   *
   * **ここで新たに runner を叩かない。** `RunnerRegistry#entries()` が
   * heartbeat で既に拾っている値をそのまま出す——`fingerprints` のように
   * 「未接続」と「頼んで失敗」が同じ空の形へ潰れる穴を、ここでは増やさない。
   */
  revision: RunnerRevisionStatus;
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
  unassigned: RunnerManagerEntry[];
  /**
   * **デーモン自身の版。** `runners[].revision` と1回の読みで比較できるように、
   * 同じ応答の外側へ並べて出す——別々の場所に出すと、依頼者が手で突き合わせる
   * ことになり、突き合わせ忘れがそのまま見逃しになる。
   *
   * 自分のことなので取りに行く必要が無く（`resolveBuildRevision()` を直に呼ぶ）、
   * `known` / `unknown` の2状態で足りる（`unheard` は「自分の名乗りを自分が
   * 聞けていない」が意味を持たないので無い）。
   */
  daemonRevision: RunnerRevisionReport;
}

/**
 * runner→デーモンの脚（`Outbox` の滞留）を最後に観測できた値
 * （#358 案b・案b の第2段）。
 *
 * **これはキャッシュであって現在値ではない。** `RunnerPlacementResources` の
 * `pendingEvents` / `oldestPendingAt` は runner が `GET /health` で無条件に
 * 返している。デーモン側の入口は2つある。
 *
 * 1. **`runners({ resources: true })`**（＝クローンが `runner_list` を
 *    `resources: true` で明示的に呼んだとき）。`resources()` の応答から拾う
 *    （`Pool#runners` の該当箇所）。
 * 2. **10秒ごとの生存確認（`RunnerRegistry` の `#probe`）。** `identity()` を
 *    持つ runner については、この heartbeat が同じ2欄を読む（
 *    `RunnerClient.identity` の doc）ので、`runner_list` を一度も
 *    `resources: true` で呼んでいなくても warm しうる（第2段の本体）。
 *
 * **それでも「あるはずの runnerId がここに無い」ことは「滞留が0件」を意味
 * しない。** `identity()` を持たない runner（`LocalRunner`・古い器）は
 * heartbeat からは一切 warm せず、1のクローンの明示呼びを待つしかない
 * ——それを一度も呼んでいなければ、依然 cold のままである。「0件だった」
 * と「まだ一度も観測していない」のどちらかは、読む側が区別できるように
 * すること（`runnerBacklog()` の doc、`tools.ts` の `describeRunnerBacklog`
 * の doc）。
 *
 * **どちらの入口も、これを埋めるためだけの新しい往復を払わない。** 1は
 * `runners({ resources: true })` が既に払っている往復の結果を、2は
 * heartbeat が既に払っている往復（`identity()`）の結果を、それぞれ今まで
 * ただ捨てていた欄から拾って保存するだけである（#358 のコメント
 * 2026-08-27T00:26Z の判断: `manager_list` から自動で `resources()` を
 * 呼ぶ形は採らない。opt-in の判断がクローンから奪われる。north_star 禁止2。
 * この判断は変わっていない——2の heartbeat はもとから10秒ごとに走っている
 * ものへ乗せただけで、`manager_list` 側からは何も自動で呼んでいない）。
 */
export interface RunnerBacklogSnapshot {
  runnerId: string;
  /** `RunnerPlacementResources.pendingEvents` の写し。 */
  pendingEvents: number;
  /** `RunnerPlacementResources.oldestPendingAt` の写し。1件も無ければ省かれる。 */
  oldestPendingAt?: string;
  /** この値をいつ観測できたか（`runners({ resources: true })` を呼んだ時刻）。 */
  observedAt: string;
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
 *
 * **`abort()` は、この値によって「配るかどうか」も分ける（Issue #320）。**
 * `by === 'clone'` のときは日誌には残すが、クローンの受信箱へは配らない
 * （`abort()` 内の `if (by !== 'clone')` の doc に理由の全文がある）。要約:
 * クローンは `manager_stop` の戻り値として同じ情報を同じターンで既に受け
 * 取っており、配り直しは新しい情報を1文字も持たないのに、配るたびに
 * クローンのターンを1回消費する（実測: 7本畳んで7ターン）。**`by === 'human'`
 * は今までどおり配る** — 人間が止めた事実はクローンにとって外から来た
 * 出来事で、他に知る手段が無いため。
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
   * **既定では `resources()` を呼ばない。** この一覧のためにネットワーク往復を
   * 足さない——ここで数える本数は台帳から見えている分であって、配置が使う本数
   * （`RunnerPlacementResources.managers`）とは別物である（`RunnerOverview` の doc）。
   *
   * `fingerprints: true` を渡すと、開けている器について鍵とプロファイルの
   * 指紋も添える。**既定では出さない**——クローンの判断で「要らないものを文脈へ
   * 載せない」側に倒す。それでも出せる口を残すのは、north_star 禁止2 が
   * 「制限は方針で表し、方針は設定で開けられなければならない」と要求している
   * からである。人間は Web UI（`GET /runners`）で常に見られるので、クローンだけ
   * 永久に見えない形にはしない。
   *
   * `resources: true` も同じ形の opt-in である（#315「器の pids の合計が
   * どこからも見えない」の案1）。**渡されたときだけ `resources()` を呼ぶ——
   * 既定は変えない。** 上の「既定では呼ばない」はそのまま生きていて、ここが
   * 足したのは「明示的に頼まれたときの経路」1本だけである。出すのは pids
   * （cgroup の `pids.current` / `pids.max`。合計であって内訳ではない——
   * #315 の本題である内訳の特定にはこれは触れない）。開いていない器・
   * `resources()` が失敗した器は `RunnerOverview.resources` が `undefined` の
   * ままになる（「訊けなかった」）。開けたが `pids` を持たない器（cgroup が無い）
   * とは区別すること（`RunnerOverview.resources` の doc の3値）。
   */
  runners(options?: { fingerprints?: boolean; resources?: boolean }): Promise<RunnerFleetOverview>;
  /**
   * runner→デーモンの脚（`Outbox` の滞留）について、最後に観測できた値
   * （#358 案b・案b の第2段）。**ネットワークを一切叩かない**——直近の
   * `runners({ resources: true })` と、10秒ごとの heartbeat（`#probe`）が
   * それぞれ拾って保存しておいたものを合流させて読むだけである
   * （`RunnerBacklogSnapshot` の doc）。
   *
   * **`identity()` を持たない runner（`LocalRunner`・古い器）については、
   * 一度も `runners({ resources: true })` を呼んでいなければ出てこない。**
   * その runner の滞留が0件だからではなく、まだ観測していないからである
   * ——呼び出し側（`tools.ts` の `manager_list`）は「行が無い＝0件」と
   * 読まないこと。`identity()` を持つ runner は heartbeat が定期的に warm
   * するので、こちらは cold のまま留まりにくい（それでも「常に新しい」とは
   * 言えない——直近の heartbeat 周期のぶんは古い）。
   *
   * **省略可能（`?`）にしない。** 他のメンバと同じ非 optional である。
   *
   * 一度は `?` を付けた——`apps/daemon/src/openapi.ts` の
   * `buildOpenApiDocument()` が spec 生成のためだけに用意する `ManagerPool`
   * のスタブ（`throw` を返すだけの構造的な実装）へ1行足すのを避けるため
   * だった。**だがその形は、この道具が守っている区別そのものを壊す。**
   *
   * 省略可能にすると呼び出し側は `runnerBacklog?.() ?? []` と書くことになり、
   * **「この口を持たない実装」と「持っているが1件も観測していない」が同じ
   * `[]` に畳まれる。** どちらも「行が出ない」に落ちる——**「まだ観測して
   * いない」と「滞留0」を区別することが #358 の主題であり、呼び出し口の型で
   * それを潰しては意味が無い。** `${x:-0}` を禁じているのと同じ形である
   * （取れなかったことを「0 だった」に変えない。AGENTS.md「取れない軸に
   * 0 の行を作る」）。
   *
   * ⟹ スタブの側へ1行足すほうを選んだ。**スタブは spec 生成専用で走らない**
   * ので、実行時の振る舞いは何も変わらない。
   */
  runnerBacklog(): readonly RunnerBacklogSnapshot[];
  /** manager_id からセッションの生ログへ降りる（可観測性の最下段）。 */
  transcript(managerId: string): Promise<string | null>;
  /**
   * デーモン起動時に、走行中だったマネージャーを台帳と runner から拾い直す。
   * 戻り値は「中断されていて実際に resume した」分。
   */
  restore(): Promise<ManagerSummary[]>;
  /**
   * **その宛先の器が入れ替わったので、走っていた委譲を取り直す**（M5 PR4）。
   *
   * `restore()` とは拾う対象が違う。あちらは**台帳にしか無い**委譲（`#records` に
   * 像が無いもの）を拾う口で、走行中だった委譲は先頭で見送る。器が入れ替わったときに
   * 拾いたいのは**まさにその走行中だった分**なので、`restore()` を呼んでも1本も
   * 拾えない（`onSwap` を `restore()` だけに繋いだ版が実際にそうだった）。
   *
   * **引き取ってよいかの判定はこの先の関門（貸し出し期限）が持つ。** ここが約束
   * するのは「取り直しを試みる」までで、まだ持ち主が握っている委譲は挑み直しの梯子へ
   * 載るだけである。
   */
  reattachRunner(runnerId: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ManagerPoolOptions {
  /**
   * いま撒かれている認証トークンの身元（Issue #393 PR3）。**マネージャーの
   * セッションを起こす瞬間に1度だけ読む。**
   */
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
  /**
   * 枠の観測を回し手へ渡す口（Issue #393 PR3）。**このプールは回すかどうかを
   * 判断しない。**
   */
  onUsageObservation?: (observation: TokenRotatorObservation) => Promise<void>;
  /**
   * 名乗ってきた runner へ、いま撒いてある認証トークンを降ろす（Issue #393 PR3）。
   *
   * **プロファイル（`#pushProfile`）と同じ理由でここに要る** — runner は記憶
   * ストアを読めないので、器が作り直されたときに降ろすのはデーモンの責任である。
   *
   * **これが無いと、起動時の撒き直しが「そのとき繋がっていた runner」にしか
   * 届かない。** 後から上がってきた runner がどう走るかは、**器の環境変数に
   * 認証トークンが入っているかどうかで割れる**（`createCredentialStore` の
   * `seed`——既定 `process.env`——がその runner の器そのものだから）。入っていれば
   * （例: `compose.yaml` の `*shared-env` で runner にも同じ env を渡している
   * 構成）**器の環境変数へ戻り**、そこで起こしたマネージャーは古いトークンを
   * 使い続ける。入っていなければ（例: Railway の runner サービスに
   * `CLAUDE_CODE_OAUTH_TOKEN` を渡していない構成）**資格を1つも持たずに走る**
   * ——古いトークンで動くよりも重い壊れ方である。**どちらの場合も、その食い違い
   * や欠落はマネージャーの側からは見えない。**
   */
  syncRunnerToken?: (runner: RunnerClient) => Promise<void>;
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
  /**
   * いまの時刻（既定は `Date.now`）。**貸し出し期限の判定のために口を開けてある。**
   *
   * 期限は時刻そのものが答えを決めるので、渡せない形だと「猶予の中では奪わない」を
   * 確かめる試験が書けない（テストが書けない構造は、テストが無いのと同じである）。
   */
  now?: () => number;
  /**
   * 貸し出しの猶予（既定 `LEASE_TTL_MS`）。runner はこの長さで自己失効する。
   *
   * **能力の上限ではない**（north_star 禁止2 が禁じているのは仕事の回数・ターン数の
   * 制限であって、二重実行を止めるための期限ではない）。
   */
  leaseTtlMs?: number;
  /**
   * 新しい managerId を発行する（既定は `mgr-` に `randomUUID()` を続けたもの。
   * 切り詰めない — #238）。
   *
   * **`now` と同じ理由で口を開けてある。** `randomUUID` を差し替える前例は
   * この repo に無い（`vi.mock('node:crypto')` は使わない）ので、衝突を再現する
   * 試験はここを差し替えるしかない。テストが乱数に依存した判定を書かないため
   * であって、本番の既定を変えるためのものではない。
   */
  generateManagerId?: () => string;
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
  | 'busy'
  /**
   * **まだ前の器が握っている**（貸し出し期限が切れていない。M5 PR4）。**恒久ではない。**
   *
   * `no-session` と混ぜてはいけない — あちらは起こし直すしかないが、こちらは
   * **待てば通る。** 同じ文言にすると、クローンは待てば済む委譲を新しく起こし直し、
   * **同じ仕事が2本になる**（貸し出し期限が防ごうとしているものそのもの）。
   */
  | 'held-by-lease'
  /**
   * **`record.job.cwd` が記録に無く、resume 先の runner からも `workspacePath` を
   * 一度も聞けていない（#402）。**
   *
   * `cwd ?? runner.workspacePath` へそのまま通すと、`workspacePath` の既定値
   * `''`（`RunnerClient.workspacePathKnown` の doc）が `cwd` として組み立てられ、
   * runner 側の `cwd: z.string().min(1)` に「cwd の形が不正」として弾かれる——
   * 真因（workspacePath 未取得）がどこにも出ない。ここで区別できる形にして返す。
   *
   * **`no-session` とも `held-by-lease` とも違う。** `manager_send` に `cwd` を
   * 渡す口は無いので、送り直しでは直らない（`no-session` と同じく起こし直す
   * 以外に手が無い、が理由は別）。`held-by-lease` のように「待てば通る」とも
   * 言い切れない——`workspacePathKnown` は `HttpRunner` の生成時に呼ばれる
   * `hello()` 1回だけで決まり、その後は `ping()` / `identity()` / `resources()`
   * のどれも書き換えない設計（`apps/daemon/src/runner-client.ts` の該当箇所の
   * doc）ので、同じ runner インスタンスが繋がっている限り自然には解けない。
   */
  | 'workspace-path-unknown';

/** デーモン側が持つ1マネージャーの像（正本は JobStore）。 */
interface ManagerRecord {
  job: Job;
  waiting: RunnerWaiting[];
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
   * **一度でも処理した報告（`report`）の id（#206）。`asked` と同型。**
   *
   * `report` には `waiting` に相当する「いま待っている」像が無い——1本の
   * 報告は届いた瞬間に台帳・日誌・受信箱へ通り終える。だから `asked` のように
   * 「まだ解決していないものだけを見る」形は要らず、**見た id をそのまま
   * 覚えておいて、再送を弾く**だけでよい。
   *
   * **`event.reportId` が無い回（旧 runner）はここに載せない。** `case
   * 'report':` のガードを参照——載せないのは「冪等化を諦める」判断で、
   * 落とす判断ではない。
   *
   * 最初の `report` で作る。寿命と件数の蓋は `asked` と同じ理由
   * （`REPORTED_MEMORY_LIMIT`）。
   */
  reported?: RecentMap<true>;
  /**
   * **道具×層ごとの、確認へ上がらず止められた件数。**
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
   * - 覚えるのは**道具の名前と層（`denialKey`）の組**で、件数の蓋は
   *   `DENIED_TOOL_LIMIT`。溢れたら `onForget` が日誌へ残す（黙って数え直さない）。
   *   **層を分けて数える理由**は `ManagerDenial.actor` の doc を見ること
   *   （Issue #373 — マネージャー自身の拒否と作業者の拒否を同じ数へ畳まない）
   */
  denied?: RecentMap<number>;
  /**
   * **貸し出し期限を理由に引き取りを断った直近の1件**（M5 PR4）。
   *
   * 断ったことを呼び出し側へ返すためだけの覚えである。`#resume` の返り値は真偽値で、
   * それだけだと「session_id が無い」と「まだ持ち主が握っている」が同じ `false` に
   * なる — 前者は起こし直すしかないが、後者は**待てば通る**ので、報告を読む側の
   * 次の一手が変わる（AGENTS.md「判定できないという3つ目の状態を持つ」）。
   *
   * プロセス内の像にしか置かない（台帳には書かない）。断った事実そのものは日誌と
   * 受信箱に残るので、ここは次の一手を決めるための一時的な材料である。
   *
   * **`kind` を持つ（#200）。** かつては `claimableAt` の有無で「時間で解けるか」を
   * 見分けていたが、`claimableAt` が付くのは `LeaseVerdict` の `held` のときだけで、
   * **貸し出しを台帳へ書けなかったとき**（`LeaseVerdict` の枝ではない。下の
   * `#claimForResume` が自分で作る断り）も `claimableAt` を持たない。⟹
   * `claimableAt === undefined` は「併存（`ambiguous`）」と「台帳の書き込み失敗」を
   * 同じに扱ってしまい、書き込み失敗のときにも「人間が `ALTEROID_RUNNER_ID` 等を
   * 直すまで解けない」と言ってしまう（存在しない設定の誤りを読んだクローンが
   * 探しに行く）。`kind` はこの2つを取り違えないための専用の欄である。
   */
  leaseRefusal?: { detail: string; claimableAt?: number; kind: LeaseRefusalKind };
}

/**
 * `leaseRefusal.kind` の値。**`claimableAt` の有無から推測しない**（上の doc）。
 *
 * - `held` — `LeaseVerdict` の `held`。時間が経てば自動で引き取れる
 * - `ambiguous` — `LeaseVerdict` の `ambiguous`（#200）。時間では解けない。
 *   人間が `ALTEROID_RUNNER_ID` 等を直すまで解けない
 * - `persist-failed` — 貸し出しを台帳へ書けなかった。`LeaseVerdict` の枝では
 *   ない（`judgeLease` より後、`#claimForResume` が書き込みの失敗から自分で
 *   作る）。台帳の書き込みは一時的な障害であることが多く、`ALTEROID_RUNNER_ID`
 *   の問題ではない — `ambiguous` と同じ言い方をしないための区別である
 */
type LeaseRefusalKind = 'held' | 'ambiguous' | 'persist-failed';

/**
 * 「知らせ」（`#notifyRestored` / `#notifyUnresumable` / `#notifyResumeFallback`）が
 * 埋め込む「直近の報告」の抜粋の厚み（#252）。
 *
 * この3つはどれも「デーモンが再起動した」「runner の器が作り直された」「前の
 * セッションから戻せなかった」という**状態が変わった知らせ**であって「報告」では
 * ない。中身は `manager_report` でいつでも全文が読めるので、ここでは短い抜粋だけを
 * 添え、全文へは名指しで案内する。
 *
 * **値は `tools.ts` の `LIST_REPORT_EXCERPT`（240）に揃えてある** — 一覧に出す
 * 「直近の報告」の抜粋と同じ意味・同じ理由（一覧はタイトルと要旨だけ、詳細は明示的
 * な呼び出しへ回す）だからである。**定数そのものは import しない** — `tools.ts` は
 * `ManagerPool` 等の型を `manager.ts` から import しているので、逆方向の import は
 * 循環になる。`tools.ts` の `TRANSCRIPT_PAGE` が `REPORT_PAGE` と同じ値を別の定数
 * として持っているのと同じ形（意味が違えば、値が同じでも定数は分ける）。
 */
const NOTIFY_REPORT_EXCERPT = 240;

/**
 * `send()` が「複数の確認を同時に待っている」と断るときの、待ち一覧の抜粋の
 * 厚み（#409）。
 *
 * `record.waiting` は返事待ちの件数ぶん伸び、各要素の `summary` は自由文なので
 * 長さの見込みが立たない。`manager_send` の直接の返り値なのでページングを
 * 経由せず、ここが伸びれば黙って全部そのまま agent へ渡ることになる。
 */
const AMBIGUOUS_WAITING_EXCERPT = 400;

/** 1マネージャーぶんで覚えておく確認の件数。達したら**黙らずに日誌へ残す**。 */
const ASKED_MEMORY_LIMIT = 512;

/**
 * `#askedOf` が忘れた id の一覧を日誌へ書くときの厚み（#409）。
 *
 * `onForget` は最大 `ASKED_MEMORY_LIMIT` 件をまとめて渡しうるので、
 * `ids.join(", ")` をそのまま繋ぐと**件数に比例して伸びるのに上限も
 * 省略の合図も持たない列挙**になる。日誌は `journal_read` でクローンが
 * 読むので、これはエージェントへ返る側である。
 *
 * **⚠️ 兄弟の `REPORTED_FORGOTTEN_BUDGET`（下）とは締め方が違う** ——
 * こちらは `excerptLine` で**文字数**を締め、あちらは `renderListing` で
 * **件数**を積む。どちらも「切ったら言う」は満たすが、出る合図の形が違う。
 * **これは設計の判断ではなく、#206 と #409 が別々の枝で同時に書かれた
 * 結果である**（#409 のコメントに残してある）。揃えるなら `renderListing`
 * 側へ寄せるのが素直だが、ここでは倒していない。
 */
const ASKED_FORGOTTEN_EXCERPT = 400;

/**
 * 1マネージャーぶんで覚えておく報告（`report`）の件数（#206）。
 *
 * `report` は `ask` と違って「解決」で消える口が無い（`settled` に相当する
 * ものが無い）ので、`ASKED_MEMORY_LIMIT` と同じ値にしておく強い理由も無い。
 * 1本のセッションが吐く report の回数は ask とおおむね同じ桁（1ターンに
 * 高々数件）なので、まずは揃えておく——実測で偏りが分かったら値だけ分ける。
 */
const REPORTED_MEMORY_LIMIT = 512;

/**
 * `#reportedOf` が忘れた id の一覧を日誌へ書くときの予算（文字数、#409）。
 *
 * `onForget` は最大 `REPORTED_MEMORY_LIMIT` 件をまとめて渡しうるので、
 * `ids.join(", ")` をそのまま繋ぐと上限も省略の合図も無い列挙になる
 * （Issue #409 が塞いでいる形そのもの）。`excerpt.ts` の `renderListing` に
 * 寄せて、切ったら「何件省いたか」が必ず出るようにする。
 */
const REPORTED_FORGOTTEN_BUDGET = 2_000;

/**
 * 1マネージャーぶんで拒否を数える道具の種類。達したら**黙らずに日誌へ残す**。
 *
 * 道具の名前の種類なので、実際にはまず届かない（届いたら、それ自体が異常である）。
 */
const DENIED_TOOL_LIMIT = 64;

/** 何件目の拒否からクローンへ上げるか。以後は3倍ごと（3, 9, 27, 81…）。 */
const DENIED_ESCALATE_AT = 3;

/**
 * managerId の発行で、衝突を引き直す回数の上限（#238）。
 *
 * **非対称だから安全側へ倒す**（`lease.ts` の `mayClaim` の doc と同じ理由）。
 * 引き直しをここで打ち切って例外にしても、断られた側は `start()` を呼び直せば
 * 済む。誤って上書きすると、走行中の別の委譲の記録が**黙って**消える —
 * どちらへ倒すかは対称ではないので、疑わしい側（上書き）を止める。
 *
 * `randomUUID()` を切り詰めずに使う既定の発行器では、ここに達することは
 * まず無い（122 ビットの空間で複数回連続して同じ値を引く確率は無視できる）。
 * 達するとすれば、注入された発行器（テスト、または将来の別実装）が衝突を
 * 起こしやすい値しか返していないということであり、**その異常を上書きで
 * 隠さない。**
 */
const MAX_MANAGER_ID_ATTEMPTS = 5;

/**
 * 上限の文言を、種類ごとに何通り覚えておくか。
 *
 * **これは配達の制限ではない。** 覚えているのは「もうクローンへ配った文言」だけで、
 * 溢れて忘れた文言は次に届いたときに**もう一度配られる**（＝取りこぼす側ではなく
 * 配り直す側へ倒れる）。忘れたこと自体は `onForget` が日誌へ残す。
 *
 * 1つの種類（`reached` など）で 32 通りの別々の文言が出る状況は実機では起きて
 * いない。溢れるなら、それ自体が異常として日誌に出る。
 */
const USAGE_NOTICE_MEMORY_LIMIT = 32;

/**
 * 上限の文言について、この種類（`kind`）で覚えていること。
 *
 * **「観測した値」ではなく「配った事実」を持つ器である。** 名前も型もそう読める形に
 * してある — ここが `string`（最後に見た文言）だった頃の壊れ方は
 * `Pool` の `#usageNotices` の doc にある。
 */
interface UsageNoticeMemory {
  /** もうクローンへ配った文言（`notice.text` そのもの。言い換える前の SDK の原文）。 */
  delivered: RecentMap<true>;
  /**
   * 前回配ってから、配らずに畳んだ件数。
   *
   * **次にこの種類を配る1本の本文へ必ず載せて 0 に戻す。** 受信箱しか見ていない
   * 読み手には日誌の行が見えないので、ここを配る側へ出さないと「畳んだ」という
   * 事実そのものが観測から消える。
   */
  folded: number;
}

class Pool implements ManagerPool {
  readonly #stores: Stores;
  readonly #post: (event: InboxEvent) => void;
  readonly #runners: RunnerRegistry;
  readonly #profile: ProfileService | undefined;
  readonly #records = new Map<string, ManagerRecord>();
  /**
   * いまの時刻。**器の時計を直に読まない**（テストが判定の時刻を持てるようにする）。
   *
   * 貸し出し期限の判定は時刻そのものが答えを決めるので、時計を渡せない形にすると
   * 「猶予の中では奪わない」を確かめる試験が書けない — テストが書けない構造は、
   * テストが無いのと同じである。
   */
  readonly #now: () => number;
  /** 貸し出しの猶予。runner へ渡し、runner はこの長さで自己失効する。 */
  readonly #leaseTtlMs: number;
  /**
   * 新しい managerId を発行する。**器の乱数を直に読まない**（テストが衝突を
   * 再現できるようにする。`#now` と同じ理由）。
   */
  readonly #generateManagerId: () => string;
  /**
   * 直近の枠の事実（種類ごと）。**アカウント単位なのでマネージャーに紐づけない。**
   *
   * 走行中は `rate_limit_event` がターンの頭ごとに来るので、ここが最新になる。
   * 揮発してよい — デーモンを作り直したら、使い捨ての probe が取り直す。
   */
  readonly #tokenIdentity: (() => { tokenId: string; generation: number } | undefined) | undefined;
  readonly #syncRunnerToken: ((runner: RunnerClient) => Promise<void>) | undefined;
  readonly #onUsageObservation:
    ((observation: TokenRotatorObservation) => Promise<void>) | undefined;
  readonly #rateLimits = new Map<string, RateLimitFacts>();
  /**
   * `runnerBacklog()` が読む2つの由来のうち、`resources()` 側（#358 案b）。
   * runnerId → 最後に観測できた値（`RunnerBacklogSnapshot` の doc）。
   *
   * **もう1つの由来は `#runners.entries()`（案b の第2段）——こちらは
   * `Map` に保存しない。** `RunnerRegistry` の側が heartbeat のたびに
   * `RegistryEntry` へ直接書いているので（`runner-protocol.ts` の
   * `#noteInstance`）、Pool 側で二重に持つ必要が無い。`runnerBacklog()` は
   * 呼ばれた時点で両方から読み、観測時刻の新しいほうを採る。
   *
   * **このフィールドへ書くのは `runners()` が `options.resources` 付きで
   * 呼ばれ、runner から `resources` が実際に返ってきたときだけ。** ここへ
   * 書き込むためだけの新しい呼び出しは無い——`runners()` が既に払った往復の
   * 結果を捨てずに保存するだけである。
   *
   * `pendingEvents` が `undefined`（古い runner が欄自体を持たない・
   * `resources()` が失敗した）のときは書かない。0で埋めると、「滞留0」と
   * 「観測できていない」の区別がこの地図の中で最初から消える
   * （AGENTS.md「取れない軸に0の行を作る」）。
   *
   * **揮発してよい。** デーモンを作り直したら空になり、次に誰かが
   * `runner_list resources: true` を呼ぶまで、その runner の行は
   * `runnerBacklog()` に出ない。
   */
  readonly #runnerBacklog = new Map<string, RunnerBacklogSnapshot>();
  /**
   * **そのマネージャーのセッションが起きたときの**認証トークンの身元
   * （Issue #393 PR3）。managerId → 身元。
   *
   * **観測のたびに読み直さない。** 読み直すと、回した後に届いた「前のセッションの
   * 観測」が新しい身元を名乗り、世代の照合がそのまま素通しになる——**それは
   * 5本のマネージャーが同時に当たった回にプールを5個消費する、という
   * この照合が存在する理由そのものである。**
   *
   * **記録（`#records`）へ足さずに別の箱にしてあるのは、`#records.set` が5箇所
   * あるからである。** 1箇所忘れると、そのマネージャーの観測だけが身元を失う
   * ——しかもそれは「回りすぎる」形で出るので、テストでは気づきにくい。
   */
  readonly #tokenIdentities = new Map<string, { tokenId: string; generation: number }>();
  /**
   * 種類ごとに、**もうクローンへ配った上限の文言**と、配らずに畳んだ件数。
   *
   * **同じ知らせで受信箱を埋めないため**にある。通知はターンごとに繰り返し届きうる
   * ので、そのまま流すと本当に変わった1回が埋もれる。
   *
   * **「最後に見た文言」ではなく「配った文言の集合」を覚える。** 直す前はここが
   * `Map<kind, 最後の文言>` で、判定は「最後に見たものと文字列が違うか」だった。
   * 同じ種類で文言が2通り出る状況（別々の枠の英文が交互に届く）では、その判定は
   * **毎回「違う」と答える** — A→B→A→B のたびに配られ、クローンのターンが1本ずつ
   * 焼かれる。文字列の一致は出来事の同一性を表していないので、記憶する対象を
   * 「観測した値」から「配った事実」へ変える。
   *
   * **畳んだ分は黙って消さない。** 1件ごとに日誌へ残し、件数はその種類で次に配る
   * 1本の本文に必ず載る（{@link UsageNoticeMemory.folded}）。
   */
  readonly #usageNotices = new Map<string, UsageNoticeMemory>();
  /** 起動時の引き取りが走っている間だけ立つ。`#reattach` はこれを待つ。 */
  #restoring: Promise<void> | null = null;
  /**
   * 引き取りを1本ずつに並べる列（`restore()` が重なったときの順番待ち）。
   *
   * **落とさずに待たせる。** 「走っているから今回は要らない」と捨てると、捨てた回に
   * しか現れなかった委譲（直前に台帳へ書かれた分）が誰にも拾われない。
   */
  #restoreQueue: Promise<void> = Promise.resolve();
  /** 取り直しが走っている runner（同じ runner について重ねない）。 */
  readonly #reattaching = new Set<string>();
  /**
   * `#reattach` がいま降ろし直している最中の runner（`runnerId` → その降ろし
   * 直しの完了）。**`#connectTo` に「まだ降ろし切っていない」を教えるためだけ
   * の窓口。**
   *
   * `#connections`（繋ぎ済みの旗）とは別に持つ。`#reattach` が `#connections`
   * を直接書き換えると、`#connectTo` 自身の失敗時の後始末
   * （`this.#connections.delete(runner)`）が「いま入っているのが誰の Promise か」
   * を見ずに消すため、`#reattach` が新しく置いた分を古い接続の失敗が巻き添えで
   * 消しうる。ここを別に持てば、`#connectTo` は自分の旗をそのままに、
   * `#reattach` の降ろし直しだけを追加で待てる。
   */
  readonly #reattachPushes = new Map<string, Promise<void>>();
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
   * 併存（同じ `runnerId` を名乗る器が2台以上）を受信箱へ通知済みの `runnerId`
   * （#200）。**「入った」と「解けた」の両方をここ1つの状態から出す。**
   *
   * `record.leaseRefusal`（ジョブ単位）とは別に、`runnerId` 単位でここに持つ。
   * 理由: 併存の検出は2箇所にある——`#claimForResume`（ジョブの `record` に触れる）
   * と、`#reattach` が関門より前で行う早期検出（#390。併存を見つけた時点で
   * `record` に触れずに `return` する）。後者は `hello` のたびに走り、併存が
   * 続く限り `#claimForResume` を二度と呼ばない（誤解決した相手への副作用
   * （`#pushProfile` / `runner.list()`）を止めるための設計であり、それ自体は
   * 変えない）。ジョブ単位の状態だけで「解けた」を出そうとすると、この早期検出
   * 経路が見つけた併存は `#claimForResume` に一度も届かず、「解けた」を言う機会が
   * 無いまま残る。`runnerId` 単位でここに持てば、どちらの経路が先に見つけても
   * 同じ1つの状態を読み書きするので、検出した経路によらず「入った」は1回、
   * 「解けた」も1回だけ出る。
   *
   * **これが無いと沈黙の意味が確定しない。** 「入った」だけを遷移で出し「解けた」を
   * 出さない設計だと、併存が続いている間も自然に解けた後も同じ「その後は何も
   * 届かない」になり、読み手はどちらなのか受信箱からは区別できない（Issue #308
   * と同じ形の穴）。
   */
  readonly #ambiguousRunnersNotified = new Set<string>();
  /**
   * 繋ぎ済み（か、いま繋いでいる最中）の宛先。**旗は宛先ごとに持つ。**
   *
   * 弱参照なのは、名簿から外れた runner をここが握り続けないためである。
   */
  readonly #connections = new WeakMap<RunnerClient, Promise<void>>();
  /** 名簿の購読を解く（`stop` で外す。外し忘れると止めたプールが後から動く）。 */
  readonly #unsubscribe: () => void;
  #stopped = false;

  constructor({
    stores,
    post,
    runners,
    profile,
    now,
    leaseTtlMs,
    generateManagerId,
    tokenIdentity,
    onUsageObservation,
    syncRunnerToken,
  }: ManagerPoolOptions) {
    this.#stores = stores;
    this.#post = post;
    this.#runners = runners;
    this.#profile = profile;
    this.#now = now ?? (() => Date.now());
    this.#leaseTtlMs = leaseTtlMs ?? LEASE_TTL_MS;
    this.#generateManagerId = generateManagerId ?? (() => `mgr-${randomUUID()}`);
    this.#tokenIdentity = tokenIdentity;
    this.#onUsageObservation = onUsageObservation;
    this.#syncRunnerToken = syncRunnerToken;
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

  /**
   * 新しい managerId を発行する。**「いま作った乱数だから空いている」を仮定
   * せず、`#records` を引いて確かめる**（#238）。
   *
   * **`#records` にしか照合しない。** 台帳（`#stores.jobs`）を引かないのは
   * 意図した設計であって漏れではない — `start()` のこの手前は台帳を引かない
   * ことにしてある（下の `lease` を組む箇所の doc「台帳へ書けたことも条件に
   * しない」を見よ）。ここで台帳読みを足すと、台帳が読めないときに新規の
   * 委譲そのものが起こせなくなり、その既存の判断を裏返すことになる。
   * ⟹ **終わって `#records` から外れた id・台帳にしか残っていない id との
   * 衝突はここでは検出しない**（残る穴。PR 本文の「言えないこと」）。
   *
   * **他の4か所の `#records.set` には同じ検出を置かない。** あちらは
   * `job.id`（台帳・runner の名乗りから来た、既に存在する id）を使う復元経路で
   * あり、新しい乱数を作っていない。復元先の id と衝突するのは「同じ委譲を
   * 二重に持っている」という別の異常であって、ここが直す「乱数の衝突」とは
   * 種類が違う。ここに検出を足しても、復元経路の異常は捕まえない。
   */
  #claimManagerId(): string {
    for (let attempt = 1; attempt <= MAX_MANAGER_ID_ATTEMPTS; attempt++) {
      const candidate = this.#generateManagerId();
      if (!this.#records.has(candidate)) return candidate;
      // **上書きしない。跡だけ残して引き直す。** `#records` に既に居るという
      // ことは、それはいま作った乱数ではなく、いま走っている別の委譲の記録で
      // ある。`noteDroppedRecord` を流用しないのは、あれが「記録できません
      // でした」と書くからである（この状況は「記録できなかった」でも
      // 「読み出せなかった」でもない第三の状況）。
      noteManagerIdCollision(candidate, attempt);
    }
    // **黙って上書きするより、起こさないほうが安全側である**
    // （`lease.ts` の `mayClaim` の doc「非対称だから安全側へ倒す」と同じ理由）。
    throw new Error(
      `managerId の発行が ${MAX_MANAGER_ID_ATTEMPTS} 回連続で衝突したため、` +
        '委譲を起こすのを止めた（走行中の別の委譲の記録を上書きしないため）。',
    );
  }

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
    /*
     * **`cwd` を省いた依頼で、runner から `workspacePath` を一度も聞けていない
     * ときは、ここで断る（#402）。**
     *
     * ここで断らずに `input.cwd ?? runner.workspacePath` へそのまま通すと、
     * `HttpRunner` の既定値 `''`（一度も接続できていない段階からの値。
     * `RunnerClient.workspacePathKnown` の doc）が `cwd` として組み立てられ、
     * `runnerStartCommandSchema` の `cwd: z.string().min(1)`（`runner-protocol.ts`）
     * に「cwd の形が不正」として弾かれる。しかも `runner.start()` が投げた後は
     * `#claimManagerId()` が発行した `managerId` を `#records` へ書く前に失敗が
     * 起きるので、この委譲は台帳にも `#records` にも跡を残さず消える（`start()`
     * の `runner.start()` の doc「黙って失われる」）。
     *
     * ⟹ 真因（workspacePath 未取得）が「cwd の形」という別の顔で報告され、
     * しかもその報告さえ台帳に残らない。`#claimManagerId()` を呼ぶ前に区別できる
     * 理由で断れば、両方を避けられる——`managerId` を1つも消費せず、エラーが
     * 原因を名指しする。
     *
     * `input.cwd` が明示されていれば、runner の `workspacePath` を知らなくても
     * 起こせる（フォールバックを使わないので、この窓は関係ない）。
     */
    if (input.cwd === undefined && !runner.workspacePathKnown) {
      throw new Error(
        `runner（runnerId=${runner.runnerId}）から workspacePath をまだ一度も聞けていないため、` +
          'cwd を省いてマネージャーを起こせない（cwd の形が不正なのではない）。' +
          'cwd を明示して起こすか、runner が /health で workspacePath を名乗ってから起こすこと（#402）。',
      );
    }
    const managerId = this.#claimManagerId();
    const cwd = input.cwd ?? runner.workspacePath;
    const now = this.#now();
    const at = new Date(now).toISOString();

    /*
     * **新しい委譲の貸し出しは、関門を通さずに立てる。**
     *
     * `#claimForResume` が守っているのは「他のプロセスが握っている仕事を奪わない」
     * ことで、この `managerId` は `#claimManagerId` が `#records` に無いことを
     * 確かめてから返した値なので、握っている者が存在しない（#238 以前はここが
     * 「乱数だから」という確かめていない仮定だった）。
     * 台帳へ書けたことも条件にしない — 新規の委譲は台帳が書けなくても走らせる、
     * という既存の判断（`#persist`）をここで覆さない（奪う操作ではないので、
     * 書けないことで危うくなるものが無い）。
     */
    const lease = grantLease({
      previous: undefined,
      runnerId: runner.runnerId,
      ...(() => {
        const seen = this.#sighting(runner.runnerId);
        return seen.instanceId === undefined ? {} : { instanceId: seen.instanceId };
      })(),
      now,
      ttlMs: this.#leaseTtlMs,
    });

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
        // **確かめずに `runner-volume` と書かない。** デーモンからは、この器の
        // `/workspace` がボリュームなのか毎デプロイで消えるのかを知る手段が無い
        // （名乗りはパスしか運ばない）。断定すると台帳が**存在しない永続性**を
        // 主張し、しかも「復旧できる」と信じる方向へ嘘をつく。分からないのは
        // 永続性だけなので、`runnerId` と `path` は落とさない。
        workspace: {
          kind: 'unknown',
          runnerId: runner.runnerId,
          path: cwd,
          reason:
            '器の workspace がボリュームかどうかを runner が名乗らないので、' +
            '入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。',
        },
        lease,
      },
      waiting: [],
      attached: true,
    };
    this.#records.set(managerId, record);
    // **セッションが起きるこの瞬間の身元を捕まえる**（`#tokenIdentities` の doc）。
    this.#rememberTokenIdentity(managerId);

    // 委譲はノンブロッキング。起こして即返し、クローンは次の判断へ移る。
    try {
      await runner.start({
        managerId,
        request: input.request,
        cwd,
        lease: { fence: lease.fence, ttlMs: lease.ttlMs },
      });
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
    const silent = this.#silentRunners();
    return summaryOf(record, isLive(record, silent), lostSinceOf(record, silent));
  }

  /**
   * クローンからの一言。**宛先（`requestId`）か意思（`decision`）が在るときだけ**
   * 止まっている確認への回答として使い、それ以外は追加指示として流す
   * （architecture.md「会話に戻れる」）。
   *
   * **宛先を推測しない。** 1本のマネージャーが複数の確認を同時に待つことがあり、
   * そこで先頭に入れてしまうと、拒否のつもりの一言が別の質問の答えになる。
   * **待ちが1件のときも同じである** — かつてはそこだけ推測していて、宛先も意思も
   * 示していない普通の会話文が回答に化けていた（#313。`#choosePending` の doc）。
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
      return { outcome: 'unknown', detail: this.#runnerNotOpenDetail(record) };
    }

    const { decision, requestId } = options;
    const pending = this.#choosePending(record, requestId, decision);
    if (pending === 'ambiguous') {
      return {
        outcome: 'unknown',
        detail:
          `${managerId} は複数の確認を同時に待っている。requestId を指定して答えること: ` +
          excerptLine(
            record.waiting.map((item) => `${item.requestId}（${item.summary}）`).join(' / '),
            AMBIGUOUS_WAITING_EXCERPT,
          ),
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
      if (!answered.delivered) {
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
        /*
         * **runner.ts が確定した decision をそのまま書く（#322）。** ここで
         * `decision`（クローンが明示した値）や `inferDecision(message)` を
         * 独自に計算し直さない——`AskUserQuestion` は decision を一切見ず常に
         * allow だし、`decision` を省いた回は runner 側の `inferDecision` が
         * 決める。この2つを manager.ts 側で再現すると、Issue #322 が候補2
         * （`inferDecision` を呼び直す）を却下した理由（「runner.ts 側が変わった
         * ときに黙ってずれる」）をそのまま踏む。
         *
         * **`answered.decision` が無い回は `allow`/`deny` へ倒さない。**
         * ローリング再デプロイの窓では、まだこの変更前の runner が
         * `{ ok: true }` だけを返し、確定した値を報告できない——「allow
         * だった」でも「deny だった」でもない3つ目の状態なので、`[unknown]`
         * として区別する（`AGENTS.md`「取れない軸に0の行を作る」）。
         */
        answer:
          answered.decision === undefined
            ? `[unknown] ${message}`
            : `[${answered.decision}] ${message}`,
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
        /*
         * **言い方の持ち主は `resumeFailureDetail` 1つである。** 貸し出し期限で
         * 断られた回だけは、期限の根拠（誰が握っていて、いつから引き取れるか）が
         * 判定側にしか無いので、その1行を渡して言わせる。
         */
        return {
          outcome: 'unknown',
          detail: resumeFailureDetail(managerId, resumed, record.leaseRefusal),
        };
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

  /**
   * 名簿が「名乗らなくなった」と判定した器（`runnerId` → その判定が立った時刻）。
   *
   * **ここで新たに runner を叩かない。** `RunnerRegistry#entries()` が10秒ごとの
   * 生存確認で既に立てている判定をそのまま読むだけである（#543 が
   * `#runnerBacklog` で採ったのと同じ形。一覧を出すたびに往復を増やさない）。
   *
   * **`state === 'lost'` だけを採る（ホワイトリスト）。** 残る3つ
   * （`connecting` / `unreachable` / `unusable`）は「まだ一度も開けていない」側
   * で、`entry.client === null` のまま立つ状態である。委譲の宛先として台帳に
   * 書かれた `runnerId` は `select()` が選んだ後にしか付かない（＝一度は
   * `connected` になった器）ので、**確かめた判定だけを数えるほうへ倒してある。**
   * 数え漏らしたときに倒れる先は「今までどおり `live` を計算する」であって、
   * 「黙った器を話しかけられると名乗る」より悪くはならない。
   *
   * **`runnerId` を名乗れていない行は数えない。** `RunnerEntry.runnerId` は
   * 聞けたときだけ載る（`heardRunnerIdOf`）ので、無い行を数え入れると、
   * どの委譲に当たるのかを決められないまま `live` を倒すことになる。
   */
  #silentRunners(): ReadonlyMap<string, string> {
    const silent = new Map<string, string>();
    for (const entry of this.#runners.entries()) {
      if (entry.state !== 'lost') continue;
      if (entry.runnerId === undefined) continue;
      silent.set(entry.runnerId, entry.since);
    }
    return silent;
  }

  async list(): Promise<ManagerSummary[]> {
    await this.#ensureConnected();

    const silent = this.#silentRunners();
    const known = new Map<string, ManagerSummary>();
    for (const record of this.#records.values()) {
      known.set(
        record.job.id,
        summaryOf(record, isLive(record, silent), lostSinceOf(record, silent)),
      );
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
      known.set(
        job.id,
        summaryOf(fallback, isLive(fallback, silent), lostSinceOf(fallback, silent)),
      );
    }
    return [...known.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  denials(managerId: string): ManagerDenial[] {
    // 台帳へは降りない。**プロセス内の像にしか無い**ので、知らないものは
    // 「無い」ではなく「数えていない」— どちらも空配列だが、そう読めるように
    // 一覧側で「デーモンを作り直すと数え直しになる」と添えてある。
    const denied = this.#records.get(managerId)?.denied;
    if (denied === undefined) return [];
    // 鍵は `denialKey`（道具＋層）で作ってある。**`actor` が `undefined` の
    // ものだけ、そのキーを外向きの形からも省く**（`ManagerDenial.actor` の
    // doc と同じ——取れていないことを「その名前の層」として見せない）。
    return denied.entries().map(([key, count]) => {
      const { tool, actor } = decodeDenialKey(key);
      return actor === undefined ? { tool, count } : { tool, count, actor };
    });
  }

  async runners(
    options: { fingerprints?: boolean; resources?: boolean } = {},
  ): Promise<RunnerFleetOverview> {
    // `list()` が台帳とプロセス内の像を合流させ、`#ensureConnected` も済ませる。
    const managers = await this.list();
    const entries = this.#runners.entries();

    // **`runnerId` が無い分は、どの器にも混ぜず別枠へ。** 0 に畳むと「記録が無い
    // マネージャーは存在しない」と読める（AGENTS.md「取れない軸に0の行を作らない」）。
    const byRunner = new Map<string, RunnerManagerEntry[]>();
    const unassigned: RunnerManagerEntry[] = [];
    for (const manager of managers) {
      // **`live` をここで落とさない。** 材料はすぐ上の `list()` が既に計算して
      // 持っている（`isLive()`）——落とすと `runner_list` の側でだけ
      // 「走行中」と「走行中だがセッション切断」が潰れる（`RunnerManagerEntry` の doc）。
      const item: RunnerManagerEntry = {
        managerId: manager.managerId,
        status: manager.status,
        live: manager.live,
      };
      if (manager.runnerId === undefined) {
        unassigned.push(item);
        continue;
      }
      const bucket = byRunner.get(manager.runnerId);
      if (bucket) bucket.push(item);
      else byRunner.set(manager.runnerId, [item]);
    }

    // 指紋・資源は明示的に頼まれたときだけ聞きに行く（開けている器にしか聞けない）。
    // どちらも同じ `open`（開いている器の一覧）を材料にする——2度 `list()` を
    // 呼んで往復を増やさない。
    const open =
      options.fingerprints || options.resources
        ? new Map(
            (await this.#runners.list().catch(() => [])).map((runner) => [runner.runnerId, runner]),
          )
        : undefined;

    const runners = await Promise.all(
      entries.map(async (entry) => {
        const client = entry.runnerId === undefined ? undefined : open?.get(entry.runnerId);
        const [credentials, profile] =
          client === undefined || !options.fingerprints
            ? [undefined, undefined]
            : await Promise.all([
                client.credentials().catch(() => undefined),
                client.profile().catch(() => undefined),
              ]);
        // **`resources` 自体が `undefined` = 訊けなかった。** `resources` が在って
        // `pids` が無い = 訊けたが読めなかった。この2つを区別するために、失敗も
        // 「呼ばなかった」も同じ `undefined` へ潰す（`RunnerOverview.resources` の
        // doc の3値）。
        const resources =
          client === undefined || !options.resources
            ? undefined
            : ((await client.resources?.().catch(() => undefined)) ?? undefined);

        // #358 案b: `pendingEvents` / `oldestPendingAt` を `#runnerBacklog`
        // へ書く。**新しい往復ではない**——直上で払った往復（`options.resources`
        // が付いたときだけ通る）の結果を捨てずに保存するだけである
        // （`RunnerBacklogSnapshot` の doc）。`pendingEvents` が `undefined`
        // （古い runner・応答の形が壊れていた）のときは書かない — 0で
        // 埋めない（`#runnerBacklog` の doc）。
        if (entry.runnerId !== undefined && resources?.pendingEvents !== undefined) {
          this.#runnerBacklog.set(entry.runnerId, {
            runnerId: entry.runnerId,
            pendingEvents: resources.pendingEvents,
            ...(resources.oldestPendingAt === undefined
              ? {}
              : { oldestPendingAt: resources.oldestPendingAt }),
            observedAt: new Date(this.#now()).toISOString(),
          });
        }

        const overview: RunnerOverview = {
          label: entry.label,
          state: entry.state,
          since: entry.since,
          ...(entry.error === undefined ? {} : { error: entry.error }),
          ...(entry.runnerId === undefined ? {} : { runnerId: entry.runnerId }),
          ...(entry.workspacePath === undefined ? {} : { workspacePath: entry.workspacePath }),
          ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
          ...(entry.instanceSince === undefined ? {} : { instanceSince: entry.instanceSince }),
          managers: entry.runnerId === undefined ? [] : (byRunner.get(entry.runnerId) ?? []),
          ...(credentials === undefined ? {} : { credentials }),
          ...(profile === undefined ? {} : { profile }),
          ...(resources === undefined ? {} : { resources }),
          revision: entry.revision,
        };
        return overview;
      }),
    );

    // デーモン自身の版。**自分のことなので取りに行く必要が無い**——runner のように
    // ネットワーク越しに訊く経路が無く、`resolveBuildRevision()` を直に呼べば
    // 済む（`known` / `unknown` の2状態。取れなかったときはプレースホルダでは
    // なく `unknown` として出る）。
    const daemonRevision = reportRunnerRevision(resolveBuildRevision());

    return { runners, unassigned, daemonRevision };
  }

  /**
   * `ManagerPool.runnerBacklog` の実装（#358 案b・案b の第2段）。**ネットワークを
   * 一切叩かない** — `#runnerBacklog`（`resources()` 由来）と
   * `#runners.entries()`（heartbeat の `identity()` 由来。`RunnerRegistry` が
   * 既に持っている値を読むだけで、ここでも往復は増えない）を合流させて読む。
   *
   * **同じ `runnerId` に両方の観測があるなら、`observedAt` が新しいほうを採る。**
   * 両方とも `new Date(...).toISOString()`（UTC・`Z` 終端）で作っているので、
   * 文字列の辞書式比較がそのまま時系列の比較になる（`RunnerBacklogSnapshot` /
   * `RegistryEntry.pendingEventsObservedAt` のどちらも同じ形）。
   */
  runnerBacklog(): readonly RunnerBacklogSnapshot[] {
    const merged = new Map<string, RunnerBacklogSnapshot>(
      [...this.#runnerBacklog.values()].map((snapshot) => [snapshot.runnerId, snapshot]),
    );
    for (const entry of this.#runners.entries()) {
      // **`pendingEvents` が無ければ、この runner は heartbeat からは
      // 一度も warm していない**（`RunnerEntry.pendingEvents` の doc）。
      // `pendingEventsObservedAt` も必ず一緒に書かれる（`#noteInstance`）ので、
      // 片方だけ在ることは無いが、型は両方 optional なので両方確かめる。
      if (
        entry.runnerId === undefined ||
        entry.pendingEvents === undefined ||
        entry.pendingEventsObservedAt === undefined
      ) {
        continue;
      }
      const candidate: RunnerBacklogSnapshot = {
        runnerId: entry.runnerId,
        pendingEvents: entry.pendingEvents,
        ...(entry.oldestPendingAt === undefined ? {} : { oldestPendingAt: entry.oldestPendingAt }),
        observedAt: entry.pendingEventsObservedAt,
      };
      const existing = merged.get(entry.runnerId);
      // **新しいほうを採る。同点（同一 observedAt）は resources() 側を残す**
      // ——先に Map へ入れてあるので、`>` （厳密な超過）だけを入れ替え条件にする。
      if (existing === undefined || candidate.observedAt > existing.observedAt) {
        merged.set(entry.runnerId, candidate);
      }
    }
    return [...merged.values()].sort((a, b) => a.runnerId.localeCompare(b.runnerId));
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
    /*
     * **同時に2本走らせない（列に並べる）。**
     *
     * 呼ぶ契機が「runner が開けたとき」だけだった頃は重なりにくかったが、器の
     * 入れ替えも契機になった（`onSwap`）ので、短い間に何度も呼ばれうる。`#restoring`
     * は1本ぶんの旗しか持てないので、重ねると**後から来た方が旗を上書きし、
     * `#reattach` が「引き取りは終わった」と読んで同時に走る** — 同じ仕事を二本
     * 起こす経路がそこで開く。
     *
     * 待たせるだけで、落とさない（後から来た呼びも必ず1周する）。
     */
    const run = this.#restoreQueue.then(() => this.#restoreExclusive());
    this.#restoreQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async reattachRunner(runnerId: string): Promise<void> {
    // 中身は runner の名乗り（`hello`）と同じ1本である。**契機が増えても経路は
    // 増やさない** — 増やすと「どちらの経路で拾われたか」で振る舞いが変わりうる。
    await this.#reattach(runnerId);
  }

  async #restoreExclusive(): Promise<ManagerSummary[]> {
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
    // **生死を聞けなかった器を覚えておく。** 応答が無いことを「セッションが無い」と
    // 読むと、**生きている仕事を二重に起こす** — 下の `alive` に載らなかったジョブは
    // `running` / `waiting_human` なら実際に resume されるので、実は走り続けていた
    // マネージャーが2本になる（`gh pr create` のような取り返しのつかない操作が二度
    // 走る。roadmap M5 が fencing を移送より先に置いている理由そのもの）。
    //
    // **同じ歯止めは `#reattach` に逐語で在る**（「聞けなかったときは何もしない。
    // 応答が無いことを『セッションが無い』と読むと、生きている仕事を二重に起こす」）。
    // 同じクラスの同じ危険に対して、片方にだけ置かれていた。
    const unheard = new Set<string>();
    for (const runner of await this.#runners.list()) {
      const states = await runner.list().catch((error: unknown) => {
        unheard.add(runner.runnerId);
        // **黙って引き下がらない。** 聞けなかったことが跡に残らないと、後から
        // 「セッションが無かった」のか「聞けなかった」のかを誰も言えない
        // （`noteUnreadableRecord` の doc と同じ理由。読み出しの失敗を、無いことと
        // 畳まないための跡である）。
        noteUnreadableRecord('runner のセッション一覧', `runnerId=${runner.runnerId}`, error);
        return null;
      });
      if (states === null) continue;
      for (const state of states) {
        alive.set(state.managerId, { runner, state });
      }
    }

    const silent = this.#silentRunners();
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
        // 引き取ったセッションも、この瞬間の身元で観測を名乗る。
        this.#rememberTokenIdentity(job.id);
        await this.#persist(record);
        // 「runner の中で走り続けている」は `lost` にも `failed` にも言えない。
        if (attached) this.#notifyRestored(record, 'attached');
        resumed.push(summaryOf(record, isLive(record, silent), lostSinceOf(record, silent)));
        continue;
      }

      // **聞けなかった器のジョブは、ここでは触らない。** 「`alive` に居ない」は
      // 「セッションが無い」ではなく「**確かめられなかった**」である。宛先が
      // 書かれていないジョブは、どの器に居たのかをこの情報だけでは決められない
      // ので、聞けなかった器が1台でもあれば同じ扱いにする（安全側）。
      //
      // **`#records` へ載せる前に抜ける。** 載せずに帰れば、次の `restore()`
      // （runner が開くたびに `takeOver` から呼ばれる）が `#records.has` で
      // 弾かれずにもう一度拾い直す。**諦めではなく先送りである。**
      if (unheard.size > 0 && (job.runnerId === undefined || unheard.has(job.runnerId))) continue;

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
      // **1本が戻せなくても、残りを道連れにしない。** ここで抜けると、後ろに
      // 並んでいた仕事が誰にも拾われないまま `running` として残る。
      //
      // **この理由は発明ではない。** 同じクラスの走査を持つ `#reattach` の
      // ジョブループには、この対策と**同じ文言の理由**が既に置いてある。
      // **その理由がこちらに掛からない根拠は無い** — むしろこちらのほうが重い。
      // `#restoreJobs` はデーモンの起動時に**台帳の全ジョブ**を1本の走査で回すので、
      // 1本が投げると**その回の引き取りが丸ごと止まり**、後ろに並んだ委譲は
      // `#records` にすら載らないまま（＝プロセス内の像を持たないまま）台帳に
      // `running` で残る。呼び出し元（`apps/daemon/src/index.ts` の `takeOver()`）は
      // 例外を握り潰して空配列を返すので、跡はログ1行しか残らない。
      //
      // **投げうるのは `#resumeOnce` の中の実 I/O である。** `#resumeOnce` は
      // try/**finally** しか持たず、その先の `#resume` も `await runner.resume(...)`
      // を try の外で呼ぶ（HTTP の非2xx・時間切れ・経路断でそのまま投げる）。
      //
      // **分岐は `#reattach` の catch と同じ3つにしてある**（新しい方針を発明
      // しない）。違うのは「挑み直しの予約」の書き方だけで、あちらは runner 単位の
      // `retry` フラグを畳んでから予約するのに対し、こちらは同じ走査の
      // `held-by-lease` が既に使っている `#scheduleReattach` をその場で呼ぶ。
      try {
        const ok = await this.#resumeOnce(record, runner, nudge);
        if (ok !== 'resumed') {
          /*
           * **貸し出し期限で断られたのは「まだ」である。** 引き取りの契機は「runner が
           * 開けたとき」しか無いので、ここで黙って諦めると次の契機が永久に来ない
           * （台帳では走っているのに誰も走っていない仕事が残る）。挑み直しの梯子へ
           * 載せる — 梯子は間隔を伸ばすが**回数では諦めない**（`#scheduleReattach`）。
           *
           * 他の理由（`no-session` / `unreadable` / `busy` / `workspace-path-unknown`）
           * はここでは何もしない（それぞれ別の経路が持っている、または
           * `manager_send` からの送り直しでしか解けない）。
           */
          if (ok === 'held-by-lease') {
            // **判断として残す。** 「何もしなかった」は日誌から消えやすいが、
            // 引き取らなかったことは判断であって欠落ではない（根拠も一緒に残す）。
            await this.#journal({
              type: 'decision',
              decision: leaseRefusalDecision(job.id, record.leaseRefusal),
              grounds: record.leaseRefusal?.detail ?? '（根拠を取れなかった）',
            });
            this.#scheduleReattach(runner.runnerId);
          }
          continue;
        }
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
        resumed.push(summaryOf(record, isLive(record, silent), lostSinceOf(record, silent)));
      } catch (error) {
        if (isFencedRunnerError(error)) {
          /*
           * **世代で拒まれた（409）。これは「戻せなかった」ではない**（`#reattach` の
           * 同じ分岐と同じ理由）。runner が持っている世代のほうが新しい＝この委譲は
           * 自分より新しい世代の誰かが握っていて、そのセッションは生きている。
           * 下の枝（`lost` にして像から外す）へ落とすと、クローンが「戻せなかった」と
           * 読んで新しく起こし直し、**fencing の失敗経路から二重実行へ到達する。**
           *
           * だから状態は動かさず、挑み直しもしない。**その代わり必ず知らせる。**
           */
          await this.#journal({
            type: 'decision',
            decision: `[${job.id}] 起動時の引き取りを止めた（runner がより新しい世代を持っている＝別の誰かが握っている）`,
            grounds: String(error),
          });
          this.#post({
            type: 'manager_message',
            id: randomUUID(),
            at: new Date(this.#now()).toISOString(),
            managerId: job.id,
            kind: 'report',
            text:
              `${job.id} の起動時の引き取りが世代で拒まれました（409）。この委譲は**自分より新しい世代の誰かが握っています**。` +
              `終わったとは限らないので、**新しく起こし直さないでください** — ` +
              `台帳の貸し出しと runner の世代が食い違っています（デーモンが2つ走っているか、貸し出しの書き込みが落ちた可能性）。人間へ相談すること: ${String(error)}`,
          });
        } else if (isRetryableRunnerError(error)) {
          // **一時的なこけ方（起動直後・瞬断・5xx）。** 黙って引き下がると、
          // 次の契機（runner が開けたとき）が永久に来ないことがある。梯子へ載せる。
          this.#scheduleReattach(runner.runnerId);
        } else {
          // 挑み直さないと決めたので、**ジョブ側に覚える**（`#reattach` と同じ形）。
          // **この1本は `running` のままにしない** — resume を実際に試して戻れ
          // なかったので、`lost` はここでは**確かめた事実**である。
          this.#unresumable.add(job.id);
          record.job.status = 'lost';
          await this.#persist(record);
          this.#notifyUnresumable(record, error);
          this.#retire(job.id);
        }
      }
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
      return { outcome: 'unknown', detail: this.#runnerNotOpenDetail(record) };
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
      /*
       * **止まったと確かめた回だけ貸し出しを返す。** `not_stopped` / `unknown` では
       * 台帳を1文字も書かないのと同じ理由で、ここでも返さない（確かめていない停止で
       * 貸し出しを返すと、まだ走っているセッションを別の器が引き取れてしまう）。
       *
       * **⚠️ さらに「誰に確かめたか」を見る。** 止まったの判定は `#runnerOf` が引いた
       * 宛先に `list()` を聞き直して出しているが、`Registry#get` は同じ名前を名乗る器が
       * 2台あれば先に見つかった方を返す（線形一致）。**持ち主でない器に聞いて「無い」と
       * 言われただけ**の場合に貸し出しを返すと、走り続けている委譲を「止めた」と記録した
       * うえで、唯一の防御まで外すことになる。だから持ち主が応えていると言えるときだけ
       * 返す（判定できないときは返さない — 期限が来れば引き取れる）。
       */
      const holder = record.job.lease;
      if (holder !== undefined) {
        const seen = this.#sighting(holder.runnerId);
        const sameHolder = holder.instanceId !== undefined && seen.instanceId === holder.instanceId;
        if (sameHolder) record.job.lease = releaseLease(holder, this.#now());
      }
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
    // **`markup: 'none'` は、人間が打った自由記述 `reason` が実際にこの
    // `messageText` へ埋め込まれる回にだけ立てる。** 条件は3つ:
    //
    // - **`outcome === 'stopped'` のときだけ立てる。** `reason` が
    //   `messageText` へ前置されるのはこの枝だけで、`not_stopped` /
    //   `unknown` の文にはデーモンの定型文しか入らない。人間が `reason` を
    //   書いていても、その文字が1文字も入っていないメッセージに印を立てるのは
    //   嘘である — 印は「この text が Markdown として書かれていない」という
    //   **その text についての事実**を名乗るものだからである。
    //
    // - **`by === 'clone'` のときは立てない。** クローンの `reason`
    //   （`packages/core/src/tools.ts` の `manager_stop`）は AI が書いた自由
    //   記述で、今日と同じく Markdown として描いてよい。
    // - **`reason === undefined` のときも立てない。** 本文はデーモンの定型文
    //   だけで、人間が打った文字は1文字も入っていない。今日と同じ扱いでよい。
    // - **他の5つの `#post({ type: 'manager_message', … })` 呼び出し箇所
    //   （この関数の外。`abort()` 以外の場所にある）と `#emit()` の呼び出し
    //   元にはこの印を足さない。** ここは `reason` という「人間が Web UI /
    //   `DELETE /managers/:id` で自由に打った文字列」がそのまま埋め込まれる、
    //   数少ない箇所の1つである（issue #287 は範囲をこの1箇所に絞っている）。
    //
    // **`by === 'clone'` のときに `markup: 'markdown'` を立てないのは消極的な
    // 選択ではない。** 「まだ決めていない」を保存する積極的な選択である —
    // 挙動はどちらでも今日と同じ（既定で Markdown として描かれる）ので、選ぶ
    // 基準は挙動ではなく、この欄が後から読まれたときに何を主張するかである。
    // 将来もし既定が反転したら（「印が無ければ素で描く」へ）、`'markdown'` を
    // 立ててあった箇所だけが確かめていない推定を方針変更の外へ生き残らせて
    // しまう。`undefined` なら「ここは決めていない」が目に見える形で残る
    // （`textMarkupSchema` の doc、`packages/core/src/schema.ts`）。
    const markup: TextMarkup | undefined =
      outcome === 'stopped' && by === 'human' && reason !== undefined ? 'none' : undefined;
    // **`by === 'clone'` のときはここで #post しない（Issue #320）。**
    //
    // 日誌（上の `#journal`）はこれより前に、条件を問わず独立して既に済んで
    // いる——だから配らなくても「誰が止めたか」は日誌の1行として辿れる
    // （`manager.test.ts` の「クローンが止めたら、クローンが止めたと残る」が
    // それを固定している）。ここで省くのは**クローンの受信箱への配達**だけ。
    //
    // なぜクローン発だけ配らないか、理由は2つ。どちらも実機の実測で確かめた
    // ものであって推測ではない（Issue #320 のコメント、2026-08-23 観測）:
    //
    // 1. **新しい情報が無い。** クローンは `manager_stop` ツール
    //    （`packages/core/src/tools.ts`）の戻り値として、この `messageText`
    //    が言えることを**同じターンの中で同期的に**既に受け取っている——
    //    戻り値は `detail`（`who` / `reason` / `stopErrorNote` を含む）に加え、
    //    止めた後の状態（`after.status` / `live`）や `done` だった場合の
    //    但し書きまで返す。対して非同期の `messageText` はここで組み立てた
    //    `${managerId} を${who}が停止させました。理由: ${reason}` だけであり、
    //    **戻り値の真部分集合である**。読み手が同じ・ターンも同じ・情報も
    //    戻り値に含まれる以上、配る先に新しい事実は1文字も無い。
    // 2. **配る費用が本数に比例する。** 実測（2026-08-23）: 終了済み
    //    マネージャー7本を `manager_stop` で畳んだところ、台帳は1件も増え
    //    なかった（片付け済みの判定は効いている）のに、7件の停止の知らせが
    //    それぞれ独立したターンとしてクローンに届き、**きっかり7ターン**
    //    消費した（1本も欠けず、呼んだ順のまま）。`manager_message` は
    //    `#mergedHumanBatch` が常に `null` を返すぶん束ねられないので、
    //    件数がそのままターン数になる。クローンのターンは起きるたびに
    //    システムプロンプト（記憶の全文）を読み直すので、実費は「何もしない」
    //    ターンの数だけ確定的に発生する。
    //
    // **人間発（`by === 'human'`）は、今までどおり配る。** 人間がマネージャーを
    // 止めたことは、クローンにとって**外から来た出来事**である——クローンは
    // それを同期の戻り値からは知りようがなく（自分が呼んだ道具ではないので
    // 戻り値そのものが無い）、他に知る手段が無い。だからここだけは配達が
    // 唯一の経路であり、省くと「なぜ止まったか分からないマネージャー」を作る
    // （PRD「可観測性」）。
    //
    // **言えないこと:** 戻り値を読まずにターンを終えたクローンは、この停止を
    // 受信箱からは知れない。**それは戻り値を読まない場合の話であって、
    // `manager_stop` の説明文（`packages/core/src/tools.ts`）は「止めたあと
    // 本当に止まったかを確かめて返すので、返ってきた状態まで読むこと」を
    // 既にクローンへ要求している** — この省略は、その要求を前提にしたうえで
    // 初めて安全である。
    //
    // **`commitmentFor`（`packages/core/src/clone.ts`）は触っていない。**
    // 「`manager_message` は `kind` を問わず台帳に載る」契約はそのまま
    // 正しく残る——直したのは「そもそもクローン発の停止で知らせを作るか」
    // であって、「作られた知らせを台帳に載せるか」ではない
    // （`commitment.test.ts` の「マネージャーからの報告も台帳に載る」を
    // 反転させていない）。
    if (by !== 'clone') {
      this.#post({
        type: 'manager_message',
        id: randomUUID(),
        at: new Date().toISOString(),
        managerId,
        kind: 'report',
        text: messageText,
        ...(markup === undefined ? {} : { markup }),
      });
    }

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
   *
   * **繋ぎ済みでも、`#reattach` がいま鍵を降ろし直している最中なら、それも
   * 待ってから返す。** ここが無いと、器が入れ替わって `#reattach` が
   * `#pushAgentToken` を降ろし切る前に、委譲（`start()` 等）がこの runner を
   * 選べてしまう——runner はまだ自分の器の環境変数から起きた古い値のままで、
   * その委譲は古い資格で走り出す（`#pushAgentToken` の doc 「マネージャーの
   * 側からは見えない」）。
   */
  #connectTo(runner: RunnerClient): Promise<void> {
    const already = this.#connections.get(runner);
    if (already !== undefined) {
      const reattaching = this.#reattachPushes.get(runner.runnerId);
      return reattaching === undefined ? already : already.then(() => reattaching);
    }
    const opening = (async () => {
      // **落ち方は変えない。「どの合図で」だけを足す（#438 案D）。**
      //
      // この `.catch` は投げ直すので、今日と同じく未処理の拒否になって死ぬ。
      // **握り潰さないのは、死ぬ側のほうが復旧力が高いからである** —— 起動時の
      // `#restoreJobs` が `runner.list()` の実物から `waiting` ごと状態を作り直し、
      // lease は同じ runner インスタンスなら `same-holder` で TTL を待たずに
      // 引き取れる（`lease.ts`）。生き残ったまま `closed` を1件落とすと、
      // その経路は一度も起動せず、**lease は TTL まで誰も解放しない。**
      //
      // 見分けに載せるのは列挙値とこちらが発行した id だけ（`dropped-record.ts` の
      // 判定基準は「自由文かどうか」ではなく「**値を誰が決めるか**」）。`report` の
      // 本文・`ask` の要旨・`closed` の理由は外から来るので載せない。
      await runner.connect(
        (event) =>
          void this.#onEvent(event).catch((error: unknown) => {
            noteBackgroundFailure('runner からの合図の処理', runnerEventShape(event), error);
            throw error;
          }),
      );
      // **委譲を始める前に環境を整える。** ここを名乗り（`hello`）任せにすると、
      // 最初のマネージャーがプロファイルの届く前に走り出しうる。届いていない
      // ことは本人には見えないので、「たまに鍵が無い」という形で現れる。
      await this.#pushProfile(runner);
      // **認証トークンも同じ位置で降ろす。** プロファイルと同じ理由——名乗り
      // 任せにすると、最初のマネージャーが古いトークンで走り出しうる。
      await this.#pushAgentToken(runner);
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

      /*
       * **併存は、相手を解決した直後・関門より前に分かる。** `runnerId` の文字列
       * 一致（`this.#runners.get`）は名簿に同名の行が2つ以上あっても黙って
       * どちらか一方を返す——その時点で `runner` が指している相手は「本当の
       * 持ち主」だと確かめられていない。関門（`#claimForResume`）はこの後の
       * `#resume` の中で `#sighting` を使ってまさにこれを見て `ambiguous` を
       * 返すが、そこに着くまでに**関門より前の副作用**（`#pushProfile` と、
       * 下で `runner.list()` から作る `alive`）が誤解決した相手に対して走って
       * しまう（#390）。`#sighting` は関門と同じ判定材料
       * （`this.#runners.entries()` の重複カウント）を関門より前でも読めるので、
       * ここで先に確かめて、怪しい相手への副作用を止める。
       *
       * **関門を複製してはいない。** ここで見送っても `#claimForResume` は
       * 消えていない——`restore()` / `manager_send` からの引き取りは相変わらず
       * そこ1本を通る。ここは「関門へ進む前に、進んでよい状態かを覗く」だけで
       * あり、`mayClaim` の判定そのもの（許す/断る）はまだ何も下していない。
       *
       * **`held` と違って、この断りは時間で解けない**（`lease.ts` の
       * `ambiguous` の doc）。だから下の「遷移のときだけ書く」dedup
       * （`refusedBefore`）には乗せない——`hello` のたびに `#reattach` が
       * 走るので、併存が続く限りここも繰り返し届く。**初回だけ言う設計にすると、
       * 見逃した後・デーモン再起動後は永久に見えなくなる**（`apps/daemon/src/
       * runner-client.ts` の再接続ログが `#lastLoggedDelayMs` で同じ壊れ方を
       * している）。減らすのは「ジョブの本数ぶん立っていた断りの記録」であって、
       * 「併存が起きている」という合図そのものではない。
       */
      const sighting = this.#sighting(runnerId);
      if (sighting.duplicates !== undefined && sighting.duplicates > 1) {
        await this.#journal({
          type: 'decision',
          decision: `runnerId=${runnerId} の取り直しを見送った（併存を関門より前で検出。#pushProfile と runner.list() は誤解決した相手へ走らせていない）`,
          grounds: describeAmbiguousSighting(runnerId, sighting.duplicates),
        });
        /*
         * **受信箱にも知らせる（#200 段1後半）。** ここで `return` すると、この
         * `runnerId` に紐づくジョブは併存が続く限り `#claimForResume` へ二度と
         * 進まない（`#pushProfile` / `runner.list()` を誤解決した相手へ走らせない
         * ための設計であり、それ自体は変えない）。`#claimForResume` 側の通知
         * だけに任せると、実際に併存を検出する経路（runner の再接続＝`hello`）が
         * ここで折り返され続け、クローンへ一度も届かない。dedup は `runnerId`
         * 単位（`#ambiguousRunnersNotified`）を `#claimForResume` と共有するので、
         * どちらの経路が先に見つけても二重には出ない。
         *
         * ジョブの一覧は store から引く——`this.#records`（プロセス内の像）は
         * ここではまだこのジョブを持っていないことがある（例:
         * デーモン再起動後、最初の `hello` がここへ来る前に `restore()` が
         * 走っていない場合）。store の読みは `#pushProfile` / `runner.list()`
         * のような「誤解決した相手への副作用」ではないので、ここで読んでも
         * #390 が塞いだ穴には触れない。
         */
        const jobIds = (await this.#stores.jobs.listJobs().catch(() => []))
          .filter((job) => job.runnerId === runnerId)
          .map((job) => job.id);
        this.#noteAmbiguousSighting(runnerId, sighting.duplicates, jobIds);
        return;
      }
      if (this.#ambiguousRunnersNotified.has(runnerId)) {
        // **併存から戻った直後の1回だけ、ここに来る。** 通常はここに来ない
        // （`#ambiguousRunnersNotified` に載っているのは過去に通知したときだけ）
        // ので、store への余分な問い合わせを増やさない。
        const jobIds = (await this.#stores.jobs.listJobs().catch(() => []))
          .filter((job) => job.runnerId === runnerId)
          .map((job) => job.id);
        this.#noteAmbiguousResolved(runnerId, jobIds);
      }

      // **取り直しの前に環境を整える。** 器が入れ替わっていれば置いたものは
      // 消えているので、resume して走り出す前に降ろし直す（走り出してから
      // 降ろすと、その仕事の最初のコマンドだけが古い環境で走る）。
      //
      // **降ろし切るまで、委譲にもここを待たせる（#connectTo の doc）。**
      // `#connections`（繋ぎ済みの旗）はここでは触らない——`#connectTo` 自身の
      // 失敗時の後始末が「いま入っているのが誰の Promise か」を見ずに消すため、
      // ここで上書きすると古い接続の失敗がこの降ろし直しを巻き添えで消しうる。
      // 別の窓口（`#reattachPushes`）に置き、`#connectTo` にはそちらも
      // 見てもらう。
      const push = (async () => {
        await this.#pushProfile(runner);
        // **認証トークンも同じ位置で降ろす（Issue #393）。** 直上の理由がそのまま
        // 効く —— **器が入れ替わっていれば置いた鍵も消えている。** この経路にだけ
        // 無かったので、繋ぎ直してきた runner は`#connectTo`と違って鍵が降りず、
        // **器の環境変数（＝回す前のトークン）のまま走っていた。** しかもその
        // 食い違いは `#pushAgentToken` の doc が逐語で言うとおり
        // 「マネージャーの側からは見えない」。
        //
        // **「今日は実害が出にくい」を「要らない」と読まない。** 同じ `RunnerClient`
        // が生きていれば初回に降ろした鍵が runner のメモリに残っているので、
        // 表に出るのは**器を作り直した runner が繋ぎ直してきたとき**だけである
        // —— そしてそれは、この関数の doc が逐語で「runner の器だけが入れ替わると」
        // と書いている、**この経路がまさに拾いに来た場合そのもの**である。
        await this.#pushAgentToken(runner);
      })();
      this.#reattachPushes.set(runnerId, push);
      try {
        await push;
      } finally {
        // **自分が置いたものだけを消す。** 後から来た取り直し（`#reattachAgain`
        // 経由の再実行）が既に自分の分を新しく置いていたら、それを消さない。
        if (this.#reattachPushes.get(runnerId) === push) {
          this.#reattachPushes.delete(runnerId);
        }
      }

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
          // 断りが「新しく起きたこと」かを、挑む前の状態で覚えておく（下の日誌の条件）。
          const refusedBefore = record.leaseRefusal !== undefined;
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
          if (outcome === 'held-by-lease') {
            // **貸し出し期限で断られたのも「まだ」である。** 同じく予約して挑み直す。
            retry = true;
            /*
             * **待っていることを日誌に残す（この経路が本番である）。**
             *
             * 器の入れ替えで走るのはここであって `#restoreJobs` ではない
             * （あちらは像に載っている委譲を先頭で見送る）。ここに何も書かないと、
             * 「待っている」と「忘れている」が記録から区別できなくなる。
             *
             * **遷移のときだけ書く**（`onLost` が1回だけ知らせるのと同じ形）。
             * 梯子は最大30秒間隔で挑み直すので、毎回書くと1回の入れ替えで同じ行が
             * 何本も積まれ、日誌を読む側（クローンの日報・digest）で本当に1回だけ
             * 起きたことが埋もれる。
             */
            if (!refusedBefore) {
              await this.#journal({
                type: 'decision',
                decision: leaseRefusalDecision(job.id, record.leaseRefusal),
                grounds: record.leaseRefusal?.detail ?? '（根拠を取れなかった）',
              });
            }
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
          if (isFencedRunnerError(error)) {
            /*
             * **世代で拒まれた（409）。これは「戻せなかった」ではない。**
             *
             * runner が持っている世代のほうが新しい＝この委譲は**自分より新しい世代の
             * 誰かが握っている**（そのセッションは生きていて、動かしている者が居る）。
             * ここを下の枝（`lost` にして像から外す）へ落とすと、クローンが「戻せな
             * かった」と読んで新しく起こし直し、**fencing の失敗経路から二重実行へ
             * 到達する。**
             *
             * だから状態は動かさず、挑み直しもしない（同じ世代で投げ直しても同じ答えが
             * 返る）。**その代わり必ず知らせる** — 単一のデーモンで起きたなら、それは
             * 台帳の書き込みが落ちたか、もう1つのデーモンが走っているかのどちらかで、
             * どちらも人間が知る必要がある。
             */
            await this.#journal({
              type: 'decision',
              decision: `[${job.id}] 取り直しを止めた（runner がより新しい世代を持っている＝別の誰かが握っている）`,
              grounds: String(error),
            });
            this.#post({
              type: 'manager_message',
              id: randomUUID(),
              at: new Date(this.#now()).toISOString(),
              managerId: job.id,
              kind: 'report',
              text:
                `${job.id} の取り直しが世代で拒まれました（409）。この委譲は**自分より新しい世代の誰かが握っています**。` +
                `終わったとは限らないので、**新しく起こし直さないでください** — ` +
                `台帳の貸し出しと runner の世代が食い違っています（デーモンが2つ走っているか、貸し出しの書き込みが落ちた可能性）。人間へ相談すること: ${String(error)}`,
            });
          } else if (isRetryableRunnerError(error)) retry = true;
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
   * 「状態が変わった知らせ」に添える、直近の報告の抜粋と続きの取り方（#252）。
   *
   * `#notifyRestored` / `#notifyUnresumable` / `#notifyResumeFallback` の3つが
   * 共通で持っていた欠陥はここに寄せてある——「デーモンが再起動した」
   * 「runner の器が作り直された」「前のセッションから戻せなかった」という事実の
   * 知らせに、依頼文と直近の報告を**全文で**添えていた。
   *
   * **`依頼:` はここに無い。** 依頼文はクローン自身が書いたものなので、送り返す
   * 理由がそもそも無い（読みたければ `manager_report ... part=request` で取れる）。
   * **直近の報告は全文を持たず、`excerptLine` で切った短い抜粋だけを持つ**——
   * 中身は `manager_report` でいつでも読めるので、知らせの側に全文を持たせる
   * 必要が無い。
   *
   * `lastReport` が無ければ、その行ごと落とす（既存どおり）。続きの取り方の行は
   * `job.id` を実際に埋め込んだ形で、report と request の両方の取り方を書く——
   * 呼び出し元3つのうち `#notifyResumeFallback` には `依頼:` 行に相当するものが
   * 元から無いが、request も同じ `manager_report` から読めることに変わりはない
   * ので、案内はどの呼び出し元でも同じ1行で足りる。
   */
  #notifyExcerptLines(job: Job): string[] {
    return [
      job.lastReport === undefined
        ? ''
        : `直近の報告（抜粋）: ${excerptLine(job.lastReport, NOTIFY_REPORT_EXCERPT)}`,
      `続きを読むなら manager_report managerId=${job.id}（直近の報告の全文） / ` +
        `manager_report managerId=${job.id} part=request（依頼文）。`,
    ];
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
    // **日誌は呼び出し元に委ねない（#240）。** この関数は複数の経路から呼ばれ、
    // 呼び出し元が事前に `#journal` するかどうかは経路ごとに違う（例:
    // 世代衝突からの取り直し断念はしない、`session` 原因の resume 失敗はする）。
    // 「日誌に無い＝この経路を通っていない」を判別器として使えるようにするには、
    // `#post` する側が経路によらず必ず1本書く必要がある。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text:
        `[${job.id}] （戻せなかった）` +
        (cause === 'session'
          ? '前のセッションから戻せなかった（SDK に会話が残っていない）。'
          : 'runner の器が作り直されたが、前のセッションから戻せなかった。') +
        ` 理由: ${String(error)}`,
    });
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
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        ...this.#notifyExcerptLines(job),
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
        ...this.#notifyExcerptLines(job),
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
   * **名前に `absent` を使わない。** このファイルでは `'absent'` が
   * `ManagerAbortResult` の値（＝**そのマネージャーが台帳に居ない**。HTTP 404）
   * として意味を持っている。ここが答えているのは「宛先の runner がいま名簿に
   * 開いていない」であって**別の観測**なので、名前で寄せると、この関数を呼ぶ側が
   * まさに畳んではいけない2つを畳む向きへ押される（`abort()` は実際にそう
   * 畳んでいた）。
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
  #runnerNotOpenDetail(record: ManagerRecord): string {
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
    /*
     * 別の契機が取り直している最中。**理由は返り値で運ぶ**（`ResumeOutcome`）。
     *
     * かつてこの分岐は真偽値を返していたので、呼び手は「なぜ `false` なのか」を
     * `record.leaseRefusal`（貸し出しの断り）から推測するしかなく、**残っていた断りを
     * 読んで「待てば通る」と誤って言う**形になりえた。理由が型で運ばれるようになった
     * ので、その取り違えは構造ごと消えている（言い方の持ち主は
     * `resumeFailureDetail` 1つである）。
     */
    if (this.#resuming.has(id)) return 'busy';
    this.#resuming.add(id);
    try {
      return await this.#resume(record, runner, message);
    } finally {
      this.#resuming.delete(id);
    }
  }

  /**
   * 名簿から「**いまその宛先に応えているプロセス**」を引く（貸し出し判定の材料）。
   *
   * **同じ名前を名乗る器が2台以上開いているときは、instanceId を採らず台数を返す。**
   * `RunnerEntry` は label ごとなので同じ `runnerId` の行が2つ並びうる。そのとき
   * 「どちらの `instanceId` と突き合わせるか」を決める材料はここに無く、片方を
   * 選べば**話しかける相手（`Registry#get` の線形一致）と判定した相手が食い違い
   * うる** — 食い違ったまま `same-holder` と答えるのが一番危ない（奪っていない
   * つもりで奪う）。**だから instanceId は返さず、代わりに台数（`duplicates`）を
   * 返して `judgeLease` を `ambiguous` へ倒す**（#200）。
   *
   * `matches.length === 0`（名簿に居ない）は「一意でない」とは別なので、こちらは
   * 従来どおり `{ runnerId }` だけを返す — `judgeLease` はそのまま `undecidable`
   * 系の判定へ進む。
   *
   * roadmap M5 PR4 の申し送り「同じ `runner_id` を名乗る2台」は、ここでは
   * **解けてはいない** — 締め出された側を止める材料はまだ無い（#200 の設計提案
   * 「6. 塞げない部分」）。ここで変わったのは「材料を捨てて `undecidable` へ倒す」
   * から「材料（台数）を渡して `ambiguous` へ倒す」への切り替えである。
   */
  #sighting(runnerId: string): LeaseSighting {
    const matches = this.#runners.entries().filter((entry) => entry.runnerId === runnerId);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only === undefined) {
      return matches.length > 1 ? { runnerId, duplicates: matches.length } : { runnerId };
    }
    const since = only.instanceSince === undefined ? NaN : Date.parse(only.instanceSince);
    return {
      runnerId,
      ...(only.instanceId === undefined ? {} : { instanceId: only.instanceId }),
      ...(Number.isNaN(since) ? {} : { instanceSince: since }),
    };
  }

  /**
   * 併存が始まったことを、`runnerId` 単位の**遷移のときだけ**受信箱へ知らせる
   * （#200）。呼び出し元が2つある（`#claimForResume` / `#reattach` の早期検出）
   * ので、dedup は `#ambiguousRunnersNotified` の doc が説明する理由でここに
   * 集約してある。
   *
   * **文面を2箇所に散らさない。** 何が起きていて何をすれば直るかは
   * `describeAmbiguousSighting`（`lease.ts`）が既に持っている——`describeVerdict`
   * の `ambiguous` 枝もそれを呼ぶ。ここで別の説明を書くと、読んだ人間が「別の
   * 問題が2つ在る」と誤解する（`describeAmbiguousSighting` 自身の doc と同じ
   * 理由）。ここで足すのは、409（世代衝突）の前例と同じ「新しく起こし直すな」
   * という行動の指示だけである。
   *
   * `jobIds` が空なら（この runnerId に紐づくジョブがまだ1つも分からない）
   * 通知先（`manager_message.managerId`）が無いので見送り、**通知済みにも
   * しない** — 次にジョブが分かった機会にもう一度試せるようにするため。
   */
  #noteAmbiguousSighting(runnerId: string, duplicates: number, jobIds: readonly string[]): void {
    if (this.#ambiguousRunnersNotified.has(runnerId)) return;
    const managerId = jobIds[0];
    if (managerId === undefined) return;
    this.#ambiguousRunnersNotified.add(runnerId);
    // **日誌は呼び出し元に委ねない（#240）。** 呼び出し元は2つ（`hello` の
    // 併存検知 / `#claimForResume` の `mayClaim` 拒否）あり、どちらも `#post`
    // の前に `#journal` していない。経路によらず「知らせた」の跡を必ず1本残す。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${managerId}] ${describeAmbiguousSighting(runnerId, duplicates)}`,
    });
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date(this.#now()).toISOString(),
      managerId,
      kind: 'report',
      text:
        `${describeAmbiguousSighting(runnerId, duplicates)} ` +
        '**新しく起こし直さないこと** — 起こし直すと同じ仕事が2本になりえます。',
    });
  }

  /**
   * 併存が解けたことを知らせる。**これが無いと「入った」だけの片道になり、
   * 沈黙が「まだ併存している」のか「解けた」のかを区別しない**（#200。レビュー
   * で訂正 — Issue #308 と同じ形の穴になるところだった）。
   *
   * 通知済みでない（＝そもそも「入った」を言っていない）ときは何もしない。
   * `jobIds` が空のときは、通知済みの状態をまだ消さない——「解けた」と言える
   * 相手（`managerId`）が無いまま状態だけ消すと、後から本当にジョブが見つかった
   * ときに「解けた」を言う機会が失われる。
   */
  #noteAmbiguousResolved(runnerId: string, jobIds: readonly string[]): void {
    if (!this.#ambiguousRunnersNotified.has(runnerId)) return;
    const managerId = jobIds[0];
    if (managerId === undefined) return;
    this.#ambiguousRunnersNotified.delete(runnerId);
    // **日誌は呼び出し元に委ねない（#240）。** 呼び出し元は2つ（`hello` の
    // 併存解消検知 / `#claimForResume` の遷移検知）あり、どちらも `#post`
    // の前に `#journal` していない。経路によらず「知らせた」の跡を必ず1本残す。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `[${managerId}] runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。`,
    });
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date(this.#now()).toISOString(),
      managerId,
      kind: 'report',
      text: `runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。以後は自動で引き取ります。`,
    });
  }

  /**
   * 引き取り（と繋ぎ直し）の**唯一の関門**。貸し出しを見て、進んでよいかを決める。
   *
   * ## なぜ resume の中に置くか
   *
   * 引き取りの契機は3つある（起動時の `restore` / runner の `hello` による
   * `#reattach` / クローンの `manager_send`）。関門を契機ごとに置くと、**足し忘れた
   * 契機だけが素通しになる** — そしてどれが抜けているかは、二重実行が起きるまで
   * 誰にも見えない。`#resume` は3つとも必ず通る唯一の場所である。
   *
   * ## 断ったら「まだ」と言う（「駄目」ではない）
   *
   * 断るのは「持ち主がまだ握っている」ときだけで、それは待てば通る。呼び出し側は
   * 挑み直しの梯子（`#scheduleReattach`）へ載せる — **回数で諦めない**（諦めた先に
   * 残るのは、台帳では走っているのに誰も走っていない仕事である）。
   */
  async #claimForResume(record: ManagerRecord, runner: RunnerClient): Promise<boolean> {
    const now = this.#now();
    const verdict = judgeLease({
      lease: record.job.lease,
      now,
      answering: this.#sighting(runner.runnerId),
    });

    if (!mayClaim(verdict)) {
      /*
       * **`mayClaim` のホワイトリストが断る判定は `held` と `ambiguous` の2つ
       * だけである**（`lease.ts`: `unheld` / `released` / `same-holder` /
       * `expired` / `undecidable` は許される——`mayClaim` の doc）。将来
       * `LeaseVerdict` に判定が増えて未知のままここへ落ちても、`mayClaim` 自身の
       * 「名指ししなかった判定は断る」という非対称の安全側と同じ向きに倒す
       * ——`ambiguous` と同じ「時間では解けない」寄りの扱いにする（`held` だけを
       * 名指しし、それ以外は安全側）。
       */
      const kind: LeaseRefusalKind = verdict.kind === 'held' ? 'held' : 'ambiguous';
      record.leaseRefusal = {
        detail: describeVerdict(verdict),
        kind,
        ...(verdict.kind === 'held' ? { claimableAt: verdict.claimableAt } : {}),
      };
      if (kind === 'ambiguous') {
        const duplicates = verdict.kind === 'ambiguous' ? verdict.duplicates : 0;
        this.#noteAmbiguousSighting(runner.runnerId, duplicates, [record.job.id]);
      }
      return false;
    }
    // **併存から戻った遷移をここで捉える。** delete する前に「直前が併存だったか」
    // を見ておかないと、`#noteAmbiguousResolved` が「解けた」を出す機会が無くなる。
    if (record.leaseRefusal?.kind === 'ambiguous') {
      this.#noteAmbiguousResolved(runner.runnerId, [record.job.id]);
    }
    delete record.leaseRefusal;

    // 持ち主が自分（同じプロセス）なら、奪う話ではない。**世代を進めない** —
    // 進めると台帳の世代が runner の持つ世代より新しくなり、次の命令が拒まれる。
    if (verdict.kind === 'same-holder') {
      record.job.lease = touchLease(verdict.lease, now);
      return true;
    }

    const sighting = this.#sighting(runner.runnerId);
    const next = grantLease({
      previous: record.job.lease,
      runnerId: runner.runnerId,
      ...(sighting.instanceId === undefined ? {} : { instanceId: sighting.instanceId }),
      now,
      ttlMs: this.#leaseTtlMs,
    });

    /*
     * **書けたことを条件にする**（ここだけ `#persist` の best-effort に乗せない）。
     *
     * 貸し出しが台帳に載っていないと、次の引き取りは「貸し出しの記録が無い」＝
     * 誰も握っていないと読む。つまり**書けないまま走らせると、次の契機が同じ委譲を
     * 無条件で奪える状態**を作る。台帳が書けないことは委譲を止める理由にならない
     * （それが `#persist` の判断である）が、**奪う操作だけは書けたことを条件に
     * する**——`clone.ts` の「それでも書けなければ動かない」と同じ側に倒す。
     */
    const before = record.job.lease;
    const beforeUpdatedAt = record.job.updatedAt;
    record.job.lease = next;
    try {
      record.job.updatedAt = new Date(now).toISOString();
      await this.#stores.jobs.putJob(record.job);
    } catch (error) {
      // **像を書く前の姿へ戻す。** 貸し出しだけ戻して `updatedAt` を進めたままにすると、
      // 次に書けた回の台帳が「この時刻に何かを書いた」と言うのに中身が伴わない。
      record.job.lease = before;
      record.job.updatedAt = beforeUpdatedAt;
      record.leaseRefusal = {
        detail: `貸し出しを台帳へ書けなかったので引き取らない（書けないまま走らせると、次の契機が同じ委譲を無条件で奪える）: ${String(error)}`,
        // **`ambiguous` ではない。** `ALTEROID_RUNNER_ID` の設定は正しいままで、
        // 落ちたのは台帳への書き込みだけである（#200 測った事実3）。
        kind: 'persist-failed',
      };
      return false;
    }

    /*
     * **奪った回を記録する。** ここを書かないと、引き取りの記録は「見送った」側だけに
     * なり、**実際に奪った回と、その根拠が日誌のどこにも残らない。**
     *
     * とくに大事なのは2つの区別である:
     *
     * - `expired: 'drained'` — 器が古いプロセスを畳んだ**という約束**を根拠に奪った
     *   （約束が守られない構成では、この根拠は成り立たない。`decideAfterSwap` の doc）
     * - `undecidable` — 判定材料が無いまま奪った。**「奪っていない」とは言えていない**
     *
     * 両方とも「たまたま踏まなかった」側に落ちうるので、根拠つきで残す
     * （AGENTS.md「報告の形」）。
     */
    await this.#journal({
      type: 'decision',
      decision:
        `[${record.job.id}] 引き取った（貸し出しを世代 ${next.fence} で貸し直した` +
        `${next.instanceId === undefined ? '。応えているプロセスは未名乗り' : ` / instanceId=${next.instanceId}`}）`,
      grounds: describeVerdict(verdict),
    });
    return true;
  }

  async #resume(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
  ): Promise<ResumeOutcome> {
    const { sessionId, cwd, request, projectKey } = record.job;
    if (sessionId === undefined) return 'no-session';

    /*
     * **`cwd` を記録しておらず、runner からも `workspacePath` を一度も聞けて
     * いないなら、ここで断る（#402）。** `#claimForResume` / `#loadSession`
     * より前に見るのは、後段が空振りする（貸し出しを立てる・生ログを引く）前に
     * 分かる条件だからである——`ResumeOutcome.workspace-path-unknown` の doc。
     */
    if (cwd === undefined && !runner.workspacePathKnown) return 'workspace-path-unknown';

    // **貸し出しの関門はここ1つ。** 通らなければ resume そのものを出さない
    // （生きている器で走っている仕事を奪いに行かない）。
    if (!(await this.#claimForResume(record, runner))) return 'held-by-lease';

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
      // **世代と猶予を渡す。** これで runner は古い世代の命令を拒み、連絡が
      // 取れなくなったら自分でこのセッションを畳める（`lease.ts` の doc）。
      ...(record.job.lease === undefined
        ? {}
        : { lease: { fence: record.job.lease.fence, ttlMs: record.job.lease.ttlMs } }),
    });
    record.attached = true;
    record.job.runnerId = runner.runnerId;
    // **resume も「セッションが起きる瞬間」である**（`#tokenIdentities` の doc）。
    //
    // ここが抜けていた。`start` と、引き取りで**既に生きていた**セッション
    // （`restore` の living の枝）では覚えていたのに、**resume を出して起こし直した
    // セッションだけ身元を持たなかった。** 帰結は2つあり、どちらも静かである:
    //
    // 1. そのマネージャーの観測が `observedBy` を持たないので、**世代の照合が
    //    素通しになる**（同時に枠へ当たった回に、プールを人数分消費しうる）
    // 2. そのマネージャーの消費が台帳で**トークンの帰属を持たない**
    //    （#393 受け入れ基準6 が、引き取られた委譲についてだけ答えられない）
    //
    // **どちらも合計を変えないので、出力を見ても気づけない。**
    this.#rememberTokenIdentity(record.job.id);
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
        // **reportId で冪等に（#206）。** `ask` の `requestId`（直後の
        // `case 'ask':` の `#askedOf` を参照）と同型 — 同じ報告が二度届いても、
        // 台帳・日誌・クローンの受信箱のどれにも二度書かない。
        //
        // **旧 runner（`reportId` を送らない版）はここを素通りする。**
        // `reportId` は `runnerEventSchema` にこの変更で足した `.optional()`
        // の欄なので、無ければ「冪等化を諦める」——この分岐に入れず、これまで
        // どおり毎回処理する。**黙って捨てる（拒む）方は選んでいない**——
        // 旧 runner からの report を無条件に捨てると、この変更が入る前より
        // 悪い挙動（本物の報告が消える）になる。id が無ければ二重配達を
        // 見分けられないだけで、それはこの変更が入る前からの状態のままである。
        if (event.reportId !== undefined) {
          const reported = this.#reportedOf(record);
          if (reported.has(event.reportId)) return;
          reported.set(event.reportId, true);
        }
        record.job.lastReport = event.text;
        // **デーモンが受け取った時刻**（#358）。runner がこの報告を包んだ時刻
        // でも、クローンのターンへ入った時刻でもない — `lastReportAt` の doc
        // を参照。`lastFailure.at`（この少し下）と同じく、この境界を跨いだ
        // 瞬間として `new Date().toISOString()` を直接使う。
        record.job.lastReportAt = new Date().toISOString();
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
        // **`event.text` を包まずに渡す（issue #287）。**
        //
        // **書き手**: `runner.ts` の `reportText()` / `failedReportText()`
        // （`event.failure` の有無で呼び分け）が作る。前者はマネージャー自身の
        // 途中出力（`said`）＋ SDK の `result` 文言（時に runner 自身の
        // フォールバック定型文「（報告なし）」等を含む）、後者はさらに runner
        // 自身の定型文（「（このターンは応答を返さずに終わった: …）」）と SDK の
        // 失敗文言（`failure.text`）を重ねる——**書き手はマネージャー・SDK・
        // runner 自身の最大3人**で、デーモン（`manager.ts`）はどの経路でも
        // 書いていない。
        //
        // **なぜ包まないか（理由: 包む単位が無い）。** この連結は
        // `runner-protocol.ts` の境界を越える**前に** `runner.ts` の中で完了して
        // おり（`runnerEventSchema` の `report.text` は `z.string()` の1本）、
        // `manager.ts` が受け取る時点では複数の書き手の断片が既に混ざった1本の
        // 文字列である。どこからどこまでが誰の断片かという境目がここには
        // 残っていないので、`codeSpan()` で包む対象を選べない。**危ないから
        // 見送っているのではなく、この層には包む材料が無い。**
        //
        // **別の層でなら在りうる。** 包むとすれば連結する側
        // （`runner.ts` の `reportText()` / `failedReportText()`）で、SDK 由来の
        // 断片を先に `codeSpan()` へ通してから連結する形になる。`manager.ts` の
        // 中では覆らない。
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

        record.waiting.push({
          requestId: event.requestId,
          summary: event.summary,
          kind: event.kind,
          // **`askedAt` はここでは optional（`runnerEventSchema` の `ask` の
          // doc）。取れなければキーごと書かない** — `askedAt: undefined` を
          // 書くと JSON を通っても同じ形にはならないが、この境界を跨がない
          // 経路（同一プロセスのテスト・後段のオブジェクト比較）で意味が
          // ぶれるのを避ける。デーモン側で `new Date().toISOString()` は
          // 呼ばない（値の意味が経路によって変わる。`AGENTS.md`「取れない
          // 軸に0の行を作る」）。
          ...(event.askedAt === undefined ? {} : { askedAt: event.askedAt }),
        });
        record.job.status = 'waiting_human';
        await this.#persist(record);
        await this.#journal({
          type: 'escalation',
          question: event.summary,
          approvalId: event.requestId,
          managerId: event.managerId,
        });
        // **`markup: 'none'` は `kind === 'permission'` のときだけ立てる
        // （issue #287 の続き）。**
        //
        // 立てる理由: `event.summary` は runner.ts の `#onPermission` が
        // `` `${toolName} の実行許可: ${brief(input)}` `` の形で組み立てる
        // （`brief()` はツール呼び出し引数の JSON ダンプ）。**中身は道具の
        // 呼び出し引数であって、AI が文章として書いたものではない** —
        // バッククォートや `*` が入っていても、それは Markdown の記法として
        // 書かれたのではなく、たまたまその文字が引数に含まれていただけである。
        // `apps/web` の `commitments.tsx` はこの `text` を `<Markdown>` で
        // 描く（`manager_message` → `clone.ts` の `commitmentFor` →
        // `Commitment.body`）ので、印が無いと引数中のバッククォートが
        // `<code>` に食われて字面から消える。
        //
        // **⚠️ `kind === 'question'` では立てない。** そちらの `summary` は
        // `describeQuestions(input)` — **モデル自身が書いた質問文**である。
        // 「AI が書いたものは Markdown として描く」という既存の軸に乗る側で
        // あり、立てると質問文中の意図した Markdown 記法が素で出る。
        //
        // **これは `kind === 'permission'` の本文は Markdown ではない、を
        // デーモン側が runner の作りから推し量る形である。** 本文の中身は
        // 見ていない（`kind` という構造化された欄で分岐している）ので、
        // issue #287 が避けている「本文の先頭を読んで判定する」には当たら
        // ない。**⚠️ しかし runner がその文面を Markdown に変えたら、黙って
        // 外れる。** その外れを黙らせないための歯が
        // `runner-permission-summary-markup.test.ts` に在る —
        // `#onPermission` が組み立てる `summary` を、Markdown の特殊文字を
        // 含まない良性の入力でバイト単位固定し、誰かが定型文へ `` ` `` や
        // `**` を足した瞬間に落ちるようにしてある。
        //
        // **なぜ `runner.ts` 側で包まず、ここで印を立てるだけにするか。**
        // `summary`（＝この `#emit` の `text`）の読み手を数え上げると6面
        // あり、`<Markdown>` で描くのは `apps/web` の `commitments.tsx`
        // だけである。残り5面（`manager-detail.tsx` の
        // `PermissionWaitingRow` を含む）は素テキストで描いていて化けて
        // いない。**`runner.ts` 側で `brief(input)` をバッククォート等で
        // 包んで直すと、化けていない5面に記号が増える。** 印はこの1面
        // だけに効く。
        const markup: TextMarkup | undefined = event.kind === 'permission' ? 'none' : undefined;
        this.#emit(event.managerId, event.kind, event.summary, event.requestId, markup);
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
        //
        // **鍵は道具＋層。** 層を分けずに数えると、マネージャー自身の拒否と
        // 作業者の拒否が同じ数へ畳まれる（Issue #373、2026-08-24 コメント
        // #5393921053 が指摘した実害と同じ形）。`event.actor` が無い回
        // （`via: 'result'`。SDK 側に判定材料が無い）は「取れていない」層
        // として別枠で数える——マネージャー側へ黙って寄せない。
        const actorLayer = denialActorLayerOf(event.actor);
        const denied = this.#deniedOf(record);
        const key = denialKey(event.tool, actorLayer);
        const count = (denied.get(key) ?? 0) + 1;
        denied.set(key, count);

        // **escalation は道具ごとの合計で判定する（layer 別ではない）。**
        // 持ち主の指摘（PR #549 レビュー）: 「この層のこのループが繰り返して
        // いる」を知りたいなら層ごとが正しいが、**いまの escalation の目的は
        // それではない**——「クローンに1件も上がらないほど頻度を下げてしまう」
        // ことは #373 が守ろうとしている「止まっていることが見える」を裏切る。
        // 表示（`ManagerDenial`/`denialLine`）は層ごとのまま、escalation の
        // 判定材料だけを道具ごとの合計に戻す。
        //
        // **数字が嘘にならないこと。** 1件の拒否は必ずちょうど1つの
        // `(tool, actor)` の組を +1 する（同じ `event` が2つの組へ二重計上
        // されることは無い）ので、この合計も拒否1件ごとに必ず1ずつ増える。
        // `shouldEscalateDenial` の exact-equality（`step === count`）は
        // 「1ずつ増える数」を前提にしているので、そのまま渡してよい。
        const toolTotal = denied
          .entries()
          .reduce((sum, [k, v]) => (decodeDenialKey(k).tool === event.tool ? sum + v : sum), 0);

        // 理由・分類・モデルへの拒否文は3つとも `via: 'result'` では必ず欠け、
        // `via: 'live'` でも SDK が付けてこなければ欠ける
        // （`runner-protocol.ts` の doc）。**欠けているものは作り物を出さず、
        // そのキーごと省く。**
        const denialDetails = [
          event.reasonType === undefined ? undefined : `分類: ${event.reasonType}`,
          event.reason === undefined ? undefined : `理由: ${event.reason}`,
          event.message === undefined ? undefined : `モデルへの拒否文: ${event.message}`,
        ].filter((line): line is string => line !== undefined);
        const denialSuffix = denialDetails.length > 0 ? ` [${denialDetails.join(' / ')}]` : '';
        // **層の字面も日誌に残す。** `undefined`（取れていない）を「マネージャー」
        // へ読み替えない——journal_read で後から追う人が誤読しないように、
        // 3値のまま言う。
        const actorLabel =
          actorLayer === 'manager'
            ? 'マネージャー自身'
            : actorLayer === 'worker'
              ? '作業者'
              : 'どちらの層か不明';

        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `[${event.managerId}] ${event.tool} の実行が確認へ上がらずに止められた` +
            `（${actorLabel} / このマネージャーのこの組で ${count} 件目 / ` +
            `${event.via === 'live' ? '走行中の合図' : 'result の記録'}）: ` +
            `${brief(event.input)}${denialSuffix}`,
        });

        if (!shouldEscalateDenial(toolTotal)) return;
        // **Markdown として書かれていない2つの欄を、埋め込む直前に包む**（issue #287）。
        //
        // この本文はデーモンが**意図して Markdown で書いた**ものである（`**…**` と
        // `` `journal_read` `` を持つ）。そこへ Markdown ではない字面をそのまま
        // 補間していたので、**いま既に化けている**:
        //
        // **どう化けるかは実機のレンダラで測った**（`apps/web/app/components/markdown.tsx`
        // と同じ `react-markdown` ＋ `remark-gfm` ＋ `remark-breaks` の設定。観測
        // 2026-08-27。詳細は `markdown-span.ts` の doc）:
        //
        // - `brief(event.input)` はツール呼び出し引数の JSON ダンプで、Bash の引数が
        //   素で載る。**バッククォートを含む回は実際に化けた** ——
        //   `{"command":"echo `date` && rm -rf /"}` の `` `date` `` が本物の `<code>`
        //   になる。空白で挟まれた `_word_` や空白無しの `*word*` も `<em>` になる
        // - `event.tool` は SDK のツール名。**こちらは化けなかった** —— MCP の
        //   `mcp__<server>__<tool>` は、CommonMark がアンダースコアの強調を語中では
        //   発火させないのでそのまま残る（issue #287 のコメントは「いま既に化ける」と
        //   書いていたが、それは形からの推定で、実測すると外れていた）。**それでも
        //   包む**のは、この本文が既に `` `journal_read` `` を識別子として包んでいて、
        //   ツール名も同じ扱いにするのが揃うからと、`tool` が SDK の任意の字面である
        //   以上ここだけ素で通す理由が無いからである。**化けを直しているのではない**
        //
        // **これは `markup` を立てているのではない。** 1本の文字列に書き手が3人
        // （デーモン / SDK / マネージャー）居るこの本文に `markup` は立てられない
        // —— それは `schema.ts` の `textMarkupSchema` の doc が言うとおりで、覆らない。
        // ここでやっているのは印を立てることではなく、**混ざらないようにすること**
        // である（`markdown-span.ts` の doc）。
        //
        // **`denialSuffix` は包まない。** 中身は SDK が書いた prose（拒否理由・分類・
        // モデルへの拒否文）で、包むと等幅になり「文章」ではなく「コード」として
        // 描かれる。SDK の prose をどの面でどう描くかは表示の方針の話であり
        // （`apps/web/app/routes/reports.tsx` と issue #285 が面ごとに別の判断を
        // 書いている）、ここはその方針を決める場所ではない。**方針が決まれば覆る
        // 種類の見送りであって、「立てられない」とは別の理由である。**
        //
        // **日誌（上の `#journal`）は包まない。** あちらは別の文字列リテラルで、
        // Markdown で描かれる面ではない。包めば読み手に無いバッククォートが見える。
        // **層が取れているなら、クローンへの一文もその層だけを名指しする。**
        // 「マネージャーか作業者の手が止まっている可能性がある」という両論
        // 併記のままだと、クローンは誤った相手（例: マネージャー自身）へ
        // 指示を出しうる（Issue #373、2026-08-24 コメント #5393921053 が
        // 記録した実害）。取れていない回（`via: 'result'`）だけ、従来どおり
        // 両論を残す——分からないものを分かった顔で片方へ絞らない。
        const stuckWho =
          actorLayer === 'manager'
            ? 'マネージャー自身の手が止まっている可能性がある'
            : actorLayer === 'worker'
              ? '作業者の手が止まっている可能性がある'
              : 'マネージャーか作業者の手が止まっている可能性がある（どちらの層かはこの合図からは取れていない）';
        this.#emit(
          event.managerId,
          'report',
          `${codeSpan(event.tool)} の実行が確認へ上がらずに止められた（${actorLabel} / このマネージャーで ${toolTotal} 件目・道具ごとの合計）。` +
            'モデル分類器か deny 規則がその場で拒否しているので、**この確認はクローンには回ってきていない**。' +
            `${stuckWho}。` +
            `直近の入力: ${codeSpan(brief(event.input))}${denialSuffix}\n` +
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
        // **1回だけ引いて使い回す。** 2回引く形にすると、間に回し手が
        // `#tokenIdentities` を書き換えたときに「有無の判定」と「使う値」が
        // 別の世代を見る（有ると判定してから消える形は起きないが、逆は起きる）。
        const tokenIdentity = this.#tokenIdentities.get(event.managerId);
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
            // **そのマネージャーのセッションが起きた瞬間の身元**（`#tokenIdentities`）。
            // `#tokenIdentity?.()` を読み直さないのは、枠の観測と同じ理由である —
            // 回した後に届いた前のセッションぶんの消費が、新しいトークンに付く。
            //
            // **無いときは渡さない。** プールが空の器では毎回 undefined になる
            // ＝ 受け入れ基準7（既定の構成の挙動を1文字も変えない）。
            ...(tokenIdentity === undefined ? {} : { tokenId: tokenIdentity.tokenId }),
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
        //
        // **判定は文字列の一致ではなく「もう配ったか」で行う。** 理由と、直す前に
        // 何が起きていたかは `#usageNotices` の doc にある。
        // **回し手へ渡す。** これは runner が `classifyUsageNotice` に通した
        // 文言由来の通知である（`runner.ts` の `usage_notice`）。**受信箱の畳み
        // （下の `delivered`）より先に渡す** — あれはクローンへ同じ知らせを何度も
        // 配らないための仕組みであって、回し手の契機とは別の話である。畳みの後ろに
        // 置くと、2本目のマネージャーが同じ文言で当たった回に回し手が呼ばれない。
        await this.#observeForTokenRotation(event.managerId, { notice: event.notice });

        const text = describeUsageNotice(event.notice);
        const memory = this.#usageNoticeMemoryOf(event.notice.kind);
        if (memory.delivered.has(event.notice.text)) {
          // **畳んだことを記録に残す。** ここを `return` だけで済ませると、
          // 「同じ事象だから捨てた」が跡形も無くなり、後から「なぜ1回しか
          // 届いていないのか」を誰も辿れない（AGENTS.md「静かに失敗する道具」）。
          memory.folded += 1;
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `[${event.managerId}] （配達済みの知らせなので受信箱へは回さない。` +
              `この種類で ${memory.folded} 件目）${text}`,
          });
          return;
        }
        memory.delivered.set(event.notice.text, true);
        const folded = memory.folded;
        memory.folded = 0;
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}] ${text}`,
        });
        // **畳んだ件数を配る1本に必ず載せる。** 受信箱しか見ていない読み手からは
        // 日誌の行が見えないので、ここに書かないと「畳んだ」が観測から消える。
        this.#emit(
          event.managerId,
          'report',
          folded === 0
            ? text
            : `${text}\n（前にこの種類を知らせてから、配達済みの同じ文言を ` +
                `${folded} 件畳んでいる。全件は日誌に残っている。）`,
        );
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
        //
        // **覚えるのは重ねた形である（`mergeRateLimitFacts`）。** 届いた1件で丸ごと
        // 置き換えると、`status` を運んでいない観測が「もう `rejected` を知らせた」
        // という記憶を消し、次の同じ `rejected` が新しい遷移として**一字一句同じ
        // 文言でもう一度配られる**（あちらの doc に理由がある）。
        const previous = this.#rateLimits.get(event.facts.kind ?? '');
        const transition = usageTransitionOf(previous, event.facts);
        this.#rateLimits.set(event.facts.kind ?? '', mergeRateLimitFacts(previous, event.facts));
        if (transition === undefined) return;

        // **回し手へは事実と遷移で渡す**（通知の形へ仕立て直さない）。`rejected` は
        // 「その枠が尽きた」であって「仕事が止まった」ではないので、`reached` の
        // 形にして渡すと `overage_exhausted` の設定でも課金枠を使わずに回る
        // （Issue #393 追記1 の訂正）。
        await this.#observeForTokenRotation(event.managerId, {
          facts: this.#rateLimits.get(event.facts.kind ?? '') ?? event.facts,
          transition,
        });

        // 「移った」「追い返された」の**瞬間だけ**を知らせる（状態を毎回流さない）。
        //
        // **`event.facts.kind` と `overageDisabledReason` は SDK 由来の識別子である**
        // （`usage-limits.ts` の `rateLimitFactsSchema` では両方とも `z.enum` ではなく
        // `z.string()` — 境界が任意の字面を通す設計になっている。SDK の実際の値は
        // `five_hour` / `seven_day_opus` / `out_of_credits` のような snake_case で、
        // **いまはこれで化けることはない**。それでも素で通す理由が無いのは、PR #539
        // が `case 'permission_denied'` で `event.tool`（SDK のツール名）を包んだのと
        // 同じ理由——境界が任意の字面を許す以上、いま化けていないことは埋め込んで
        // よい理由にならない。**化けを直しているのではない。**
        //
        // **`kind` が無いときのフォールバック `'枠'` は包まない。** あれはデーモンが
        // 書いた日本語であって SDK の値ではない。包むと、デーモン自身の言葉が SDK の
        // 値の顔をする——この issue が問題にしているのと逆向きの混ざり方になる。
        // 包むのは値が実際に在るときだけ。
        //
        // **日誌（下の `#journal`）は包まない。** あちらは Markdown で描かれる面では
        // ないので、包むと読み手に無いバッククォートが見える。**受信箱（`#emit`）は
        // 包む**——こちらは `**強調**` を意図して持つ、デーモンが書いた Markdown の
        // 文へ SDK の値を埋め込む面である。
        //
        // 定型文を2回書き写すと片方だけ直る事故が起きるので、包み方
        // （`(s: string) => string`）を受け取って1本の組み立て関数にする。
        const build = (wrap: (s: string) => string): string => {
          const kind = event.facts.kind === undefined ? '枠' : wrap(event.facts.kind);
          const reason =
            event.facts.overageDisabledReason === undefined
              ? ''
              : `（課金枠が使えない理由: ${wrap(event.facts.overageDisabledReason)}）`;
          return transition === 'entered_overage'
            ? `枠を使い切って課金枠から引き始めた（${kind}）。**まだ動くが、この先で止まる。**${reason}`
            : `枠から追い返された（${kind}）。この枠ではもう通らない。${reason}`;
        };
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `[${event.managerId}] ${build((s) => s)}`,
        });
        this.#emit(event.managerId, 'report', build(codeSpan));
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
        /*
         * **自己失効は「終わった」ではない（M5 PR4）。**
         *
         * runner が「デーモンと連絡が取れないので貸し出し期限が切れた」と言って畳んだ
         * 場合、そのプロセスからは続けられないが、**仕事そのものはまだ owed である**
         * （生ログは預かってあるので別の器で続けられる）。ここで `event.status`
         * （`lost`）をそのまま台帳へ書くと、`#restoreJobs` は `lost` を引き取らず、
         * `#reattach` も `running` / `waiting_human` 以外を見送るので、
         * **二重実行を止めた代わりに誰も拾わない仕事ができる。**
         *
         * だから状態は動かさず、貸し出しだけ返して挑み直しの梯子へ載せる。**判定は
         * 構造化された印だけで行う**（`reason` の文字列一致で判定すると、マネージャーが
         * 同じ文を書いた回まで巻き込む — `sdk-failure.ts` と同じ理由）。
         */
        if (event.selfFenced === true) {
          record.waiting = [];
          record.attached = false;
          // **返すのは印を立てることで、消すことではない**（世代を残す。`lease.ts` の
          // `releaseLease` / `schema.ts` の `fence` の項）。
          if (record.job.lease !== undefined) {
            record.job.lease = releaseLease(record.job.lease, this.#now());
          }
          await this.#persist(record);
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `[${event.managerId}] 器が貸し出し期限で自分で畳んだ（自己失効）。` +
              `台帳の状態（${record.job.status}）は動かさず、別の器で続きを起こし直す: ${event.reason}`,
          });
          // **クローンへも知らせる。** 黙って止まったように見えるのが一番まずい
          // （引き取りが走るまでの間、この委譲は誰の手も動いていない）。
          this.#emit(
            event.managerId,
            'report',
            `器がデーモンと連絡を失い、貸し出し期限で自分で畳みました（自己失効）。` +
              `この委譲は終わっていません — 引き取りを自動で挑み直します: ${event.reason}`,
          );
          // **像から外さない**（終わっていない）。梯子へ載せて自分で挑み直す。
          if (record.job.runnerId !== undefined) this.#scheduleReattach(record.job.runnerId);
          return;
        }

        record.job.status = event.status;
        record.waiting = [];
        record.attached = false;
        /*
         * **貸し出しを返す。** `closed` は runner 側の `RunnerSession#finish()` を
         * 通った印なので、この委譲がもう走っていないことを**持ち主自身が言っている**
         * — 期限を待つ理由がここには無い（期限は「言ってもらえなかったとき」のための
         * ものである）。返さないと、器が行儀よく畳まれた後の引き取りが猶予のぶんだけ
         * 遅れる（能力を落とさずに済む場所で落とさない）。
         *
         * **消さずに印を立てる。** 消すと世代（`fence`）まで消え、返却の知らせが遅れて
         * 届いた場合に runner が覚えている世代より小さい世代を渡すことになる
         * （＝生きているセッションへの命令が拒まれ続ける。`schema.ts` の `fence` の項）。
         */
        if (record.job.lease !== undefined) {
          record.job.lease = releaseLease(record.job.lease, this.#now());
        }
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
            `古い ${ids.length} 件を忘れた: ${excerptLine(ids.join(', '), ASKED_FORGOTTEN_EXCERPT)}。` +
            'この id の確認が再送されると、新しい確認としてもう一度回る。',
        });
      },
    });
    record.asked = asked;
    return asked;
  }

  /**
   * 処理済みの報告（`report`）の帳面（#206）。無ければここで作る。`#askedOf`
   * と同型。
   *
   * 上限に達したら**黙って忘れない** — 忘れた id の `report` が再送されると、
   * それは新しい報告としてもう一度クローンへ回る。日誌に残っていなければ、
   * 「なぜ同じ報告が二度来たのか」を後から誰も辿れない。
   *
   * **`#askedOf` とは違い、忘れた id の列挙に上限を置いてある（#409）。**
   * `onForget` は最大 `REPORTED_MEMORY_LIMIT` 件を一度に渡しうるので、素直に
   * 繋ぐと件数に比例して伸びる列挙になる——`renderListing`（`excerpt.ts`）に
   * 通し、切ったら「何件省いたか」が必ず出るようにしてある。`#askedOf`（写し元）
   * 自体はこの変更で触っていない——そちらは #409 の担当範囲である。
   */
  #reportedOf(record: ManagerRecord): RecentMap<true> {
    const existing = record.reported;
    if (existing !== undefined) return existing;
    const managerId = record.job.id;
    const reported = createRecentMap<true>({
      limit: REPORTED_MEMORY_LIMIT,
      onForget: (ids) => {
        const listing = renderListing(ids, {
          budget: REPORTED_FORGOTTEN_BUDGET,
          omitted: ({ rest, shown, total }) =>
            `…ほか ${rest} 件省略（${total} 件中、古い順に ${shown} 件だけ出した）`,
        });
        void this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `[${managerId}] 処理済みの報告の記憶が上限（${REPORTED_MEMORY_LIMIT}件）に達したので、` +
            `古い ${ids.length} 件を忘れた: ${listing}。` +
            'この id の報告が再送されると、新しい報告としてもう一度回る。',
        });
      },
    });
    record.reported = reported;
    return reported;
  }

  /**
   * 拒否を数える帳面。無ければここで作る。
   *
   * 上限に達したら**黙って忘れない** — 忘れた道具の件数は 0 から数え直しになり、
   * 「もう何十回も止められている」という形が受信箱に出るまでの距離が伸びる。
   *
   * **鍵は `denialKey`（道具＋層）で、`onForget` へ渡るのはその生の鍵である。**
   * 人間・クローンへ言う段では `decodeDenialKey` で道具名へ戻す（生の鍵の
   * 区切り文字を journal の文面に漏らさないため）。
   */
  #deniedOf(record: ManagerRecord): RecentMap<number> {
    const existing = record.denied;
    if (existing !== undefined) return existing;
    const managerId = record.job.id;
    const denied = createRecentMap<number>({
      limit: DENIED_TOOL_LIMIT,
      onForget: (keys) => {
        const labels = keys.map((key) => {
          const { tool, actor } = decodeDenialKey(key);
          return actor === undefined ? tool : `${tool}（${actor}）`;
        });
        void this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `[${managerId}] 拒否の件数を覚えている道具×層の組が上限（${DENIED_TOOL_LIMIT}種）に` +
            `達したので、古い ${keys.length} 件を忘れた: ${labels.join(', ')}。` +
            'この組が次に止められたら 1 件目から数え直す（日誌には全件残っている）。',
        });
      },
    });
    record.denied = denied;
    return denied;
  }

  /**
   * 種類ごとの「配った文言」の帳面。無ければここで作る。
   *
   * **上限で忘れたら黙っていない**（`#askedOf` / `#deniedOf` と同じ形）— 忘れた
   * 文言が次に届けばもう一度配られるので、跡が無いと「なぜ同じ知らせが二度来たか」
   * を後から辿れない。ここは `managerId` を持たない（枠の事実はアカウント単位で、
   * どのマネージャーのターンで気づいたかは記憶の側の軸ではない）。
   */
  /**
   * 名乗ってきた runner へ、いま撒いてある認証トークンを降ろす。
   *
   * **失敗しても委譲は止めない**（`#pushProfile` と同じ）。ただし**黙って古い
   * トークンで走らせない** — 跡を残す。
   */
  async #pushAgentToken(runner: RunnerClient): Promise<void> {
    if (this.#stopped || this.#syncRunnerToken === undefined) return;
    try {
      await this.#syncRunnerToken(runner);
    } catch (error) {
      await this.#stores.journal
        .append({
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text: `${runner.runnerId} に認証トークンを降ろせなかった（この runner で起こすマネージャーは、器の環境変数に認証トークンが入っていればそれで走り、入っていなければ資格を1つも持たずに走る——どちらになるかは器の env 次第で、ここからは分からない）: ${String(error)}`,
        })
        .catch(() => undefined);
    }
  }

  /** そのマネージャーのセッションが起きた瞬間の身元を覚える。 */
  #rememberTokenIdentity(managerId: string): void {
    const identity = this.#tokenIdentity?.();
    if (identity === undefined) return;
    this.#tokenIdentities.set(managerId, identity);
  }

  /**
   * 枠の観測を回し手へ渡す（Issue #393 PR3）。**判断はしない。**
   *
   * **投げてもマネージャーの経路を壊さない。** 回せなかったことは枠に当たった
   * こととは別の失敗であり、後者の報告を前者で置き換えない。
   */
  async #observeForTokenRotation(
    managerId: string,
    observation: Omit<TokenRotatorObservation, 'observedBy'>,
  ): Promise<void> {
    if (this.#onUsageObservation === undefined) return;
    const observedBy = this.#tokenIdentities.get(managerId);
    try {
      await this.#onUsageObservation({
        ...observation,
        ...(observedBy === undefined ? {} : { observedBy }),
      });
    } catch (error) {
      noteDroppedRecord('認証トークンの切替', `manager ${managerId}`, error);
    }
  }

  #usageNoticeMemoryOf(kind: string): UsageNoticeMemory {
    const existing = this.#usageNotices.get(kind);
    if (existing !== undefined) return existing;
    const memory: UsageNoticeMemory = {
      delivered: createRecentMap<true>({
        limit: USAGE_NOTICE_MEMORY_LIMIT,
        onForget: (texts) => {
          void this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `配り終えた上限の文言の記憶（${kind}）が上限（${USAGE_NOTICE_MEMORY_LIMIT}通り）に` +
              `達したので、古い ${texts.length} 件を忘れた。この文言が次に届いたら` +
              'もう一度クローンへ配る。',
          });
        },
      }),
      folded: 0,
    };
    this.#usageNotices.set(kind, memory);
    return memory;
  }

  /**
   * この一言を「止まっている確認への回答」として消費してよいかを決める。
   *
   * **宛先（`requestId`）か意思（`decision`）のどちらかが在るときだけ消費する。**
   * どちらも無いものは回答ではなく追加指示として流す（`send` の doc「宛先を推測
   * しない」を、待ちが1件のときにも当てる）。かつては待ちが1件なら本文を見ずに
   * 先頭へ入れていたので、宛先も意思も示していない普通の会話文が
   * `inferDecision` に落ちて `allow` に化け、逆に「その件は少し待ってください」の
   * ような文が `deny` として道具の呼び出し元へ返っていた（#313）。
   *
   * **保守側へ倒すための関門ではない。** 意思が示されていれば従来どおり通す。
   * `requestId` だけを添えた回答は今までどおり `inferDecision` に落ちる
   * （`runner.ts` の `inferDecision` の doc がその読み取りの持ち主である）。
   */
  #choosePending(
    record: ManagerRecord,
    requestId: string | undefined,
    decision: ManagerDecision | undefined,
  ): { requestId: string; summary: string } | null | 'ambiguous' | 'gone' {
    if (requestId !== undefined) {
      return record.waiting.find((item) => item.requestId === requestId) ?? 'gone';
    }
    if (decision === undefined) return null;
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
    // **日誌は呼び出し元に委ねない（#240）。** `how === 'attached'` の呼び出し元
    // （`restore()` の attach 分岐）は `#post` の前に `#journal` していない —
    // `resumed` 側の呼び出し元（同じ関数内 / `#reattach`）はしているが、それは
    // 別の事実（「再開の指示を送った」）を書いているのであって、この関数が
    // 送る知らせ自体の跡ではない。経路によらず「送った」の跡を必ず1本残す。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text:
        how === 'attached'
          ? `[${job.id}] （走行中を確認）${head}。runner の中で走り続けている。`
          : `[${job.id}] （再開を知らせた）${head}。前のセッションから再開させた。`,
    });
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
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        ...this.#notifyExcerptLines(job),
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
    // **`markup` は呼び出し元が「立てられる」と確信できたときだけ渡す口。**
    // 既定は `undefined`（＝立てない）— `case 'ask'` 以外の呼び出し元は
    // これまでどおり何も渡さない（挙動は変わらない）。
    markup?: TextMarkup,
  ): void {
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId,
      kind,
      text,
      ...(requestId === undefined ? {} : { requestId }),
      // **取れない軸に値を作らない**（AGENTS.md 地雷表）。`markup` が
      // `undefined` のときはキーごと書かない — 上の `requestId` と同じ形
      // （`abort()` の `markup` の扱いにも揃えてある）。
      ...(markup === undefined ? {} : { markup }),
    });
  }

  async #persist(record: ManagerRecord): Promise<void> {
    record.job.updatedAt = new Date(this.#now()).toISOString();
    /*
     * **生存を確かめた時刻を、書くついでに進める（世代は進めない）。**
     *
     * 別のタイマーを立てないのは、立てれば「委譲1本につき1本のタイマー」が増える
     * うえに、進める条件（同じプロセスがまだ応えているか）を2箇所で判定することに
     * なるからである。台帳へ書く契機は委譲が動くたびに来るので、動いている委譲の
     * 期限はここで十分に前へ進む。
     *
     * **応えているプロセスが違うなら進めない。** 進めると、入れ替わった器の貸し出しが
     * 生き続け、引き取れる時刻が永久に来ない。
     */
    const lease = record.job.lease;
    // **返した貸し出しは進めない。** 進めると「返してある」のに期限が動き続け、
    // 記録として何を意味するのかが分からなくなる（引き取りの判定には効かないが、
    // 後から読む側は「まだ握っている」と読む）。
    if (lease !== undefined && lease.releasedAt === undefined) {
      const seen = this.#sighting(lease.runnerId);
      if (seen.instanceId !== undefined && seen.instanceId === lease.instanceId) {
        record.job.lease = touchLease(lease, this.#now());
      }
    }
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
 * `leaseRefusal.kind` を「時間で解けるか」の1行にする。
 *
 * **`leaseRefusalDecision` と `resumeFailureDetail` の共有ヘルパ**（#200）。
 * かつてはどちらも `claimableAt === undefined` で言い方を変えていたので、
 * 貸し出しを台帳へ書けなかっただけのとき（`ALTEROID_RUNNER_ID` の問題では
 * ない）にも「人間が `ALTEROID_RUNNER_ID` 等を直すまで解けない」と言って
 * いた（測った事実3）。`kind` で分けたことで、この関数が2箇所の言い方を
 * 揃えて持つ——ただし文言そのものはここでは1つに寄せない（呼び出し元の
 * 文脈が違う。下の doc）。
 *
 * **`never` チェックを持つ。** `LeaseRefusalKind` に値が増えたのに ここを
 * 直し忘れると、ビルド時に落ちる（AGENTS.md「型で塞いだ分岐にも実行時の
 * 歯を足す」）。
 */
function describeRefusalResolution(kind: LeaseRefusalKind): string {
  switch (kind) {
    case 'held':
      return '期限が切れたら自動で挑み直す';
    case 'ambiguous':
      return '時間では解けない（人間が ALTEROID_RUNNER_ID 等を直すまで解けない）。挑み直しは続ける';
    case 'persist-failed':
      return (
        '台帳の書き込みが一時的に失敗しただけで、ALTEROID_RUNNER_ID の問題ではない。' +
        '挑み直しは続ける'
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`未知の leaseRefusal.kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 貸し出し期限で引き取りを見送ったことを日誌へ残す1行。
 *
 * **`#restoreJobs`（起動時の引き取り）と `#reattach`（runner 入れ替え後の取り
 * 直し）の共有ヘルパ。** 同じ判断を2箇所に別々に書いていたので、直すときに
 * 片方だけ直る形になりえた（このヘルパを起こす前の姿がまさにそれだった —
 * どちらも逐語で同じ文字列を書いていた）。
 *
 * **`leaseRefusal.kind` で言い方を変える**（`describeRefusalResolution`）。
 * `held` なら「期限が切れたら自動で挑み直す」でよいが、`ambiguous` は時間では
 * 解けない（人間が `ALTEROID_RUNNER_ID` を直すまで解けない）——ここを
 * `claimableAt` の有無で判定していた版は、`persist-failed`（台帳の書き込み
 * 失敗。`ALTEROID_RUNNER_ID` の問題ではない）も同じ `ambiguous` 側の言い方に
 * 倒していた（#200 測った事実3）。
 */
function leaseRefusalDecision(
  jobId: string,
  leaseRefusal: { kind: LeaseRefusalKind } | undefined,
): string {
  const resolution =
    leaseRefusal === undefined
      ? '根拠を取れなかった。挑み直しは続ける'
      : describeRefusalResolution(leaseRefusal.kind);
  return `[${jobId}] 引き取りを見送った（貸し出しの関門。${resolution}）`;
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
  /**
   * 貸し出しの関門で断られたときの根拠（誰が握っていて、いつから引き取れるか）。
   *
   * **判定側にしか無い情報なので渡してもらう**（`judgeLease` の答えを
   * `describeVerdict` が1行にしたもの、および `claimableAt` の有無）。取れな
   * かったことを黙って埋めない。
   *
   * **`leaseRefusal.kind` で言い方を変える理由は `leaseRefusalDecision` と
   * 同じだが、ここはそれ以上に大事である。** これは `manager_send` の応答と
   * してクローンへ直接届く1行で、読んだ側はここに書かれた通りに行動する。
   * `held` を「期限が切れれば自動で引き取る」と言うのは正しいが、`ambiguous`
   * や `persist-failed` でも同じ文言を返すと、読んだ側は「待てば解ける」と
   * 誤って信じて待ち続ける（`persist-failed` は実際には解けうるが、
   * `ambiguous` は人間が `ALTEROID_RUNNER_ID` を直すまで解けない——両者を
   * 混ぜるとどちらの言い方も嘘になる。#200 測った事実3）。**「新しく起こし
   * 直さないこと」はどの `kind` でも必ず言う**（消すと二重実行の入口になる）。
   */
  leaseRefusal?: { detail: string; kind: LeaseRefusalKind },
): string {
  switch (outcome) {
    case 'held-by-lease': {
      const detail = leaseRefusal?.detail ?? '（根拠を取れなかった）';
      const resolution =
        leaseRefusal === undefined
          ? '根拠を取れなかった'
          : describeRefusalResolution(leaseRefusal.kind);
      return (
        `${managerId} はまだ前の器が握っている（貸し出しの関門）。**新しく起こし直さないこと** — ` +
        `起こし直すと同じ仕事が2本になる。${resolution}: ${detail}`
      );
    }
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
    case 'workspace-path-unknown':
      return (
        `${managerId} は cwd を記録しておらず、runner からも workspacePath を一度も聞けていない` +
        '（cwd の形が不正なのではない）。manager_send に cwd を渡す口は無いので、送り直しでは直らない。' +
        '新しく起こし直すと続きは失われる——起こし直す前に、この runner が workspacePath を' +
        '名乗れているか（別の runner への切り替えも含め）を確かめること。'
      );
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
/**
 * 宛先の器について名簿が立てた「黙った」判定を引く。**宛先が書かれていない委譲は
 * 引かない** — どの器に居たのかをこの情報だけでは決められない（`#restoreJobs` の
 * 「宛先が書かれていないジョブはここでは触らない」と同じ扱い）。
 */
function lostSinceOf(
  record: ManagerRecord,
  silentRunners: ReadonlyMap<string, string>,
): string | undefined {
  return record.job.runnerId === undefined ? undefined : silentRunners.get(record.job.runnerId);
}

function isLive(record: ManagerRecord, silentRunners: ReadonlyMap<string, string>): boolean {
  // **`lost` は何より先に見る。** 「繋がっている（`attached`）なら live」を先に
  // 置くと、両立しない組を出さないことが「両者が同時に立つ代入が無い」という
  // 追跡結果に頼ることになる。実際に立つ隙間がある — `#resume` は
  // `await runner.resume(...)` が返った直後に `record.attached = true` を書く
  // （受理と「戻れた」は別なので、これは楽観的な代入である）。その `await` の
  // 間に `resume_failed` が届いていると、イベント側が先に `status: 'lost'` と
  // `attached: false` を書き、その後で `#resume` が `attached` を `true` へ
  // 戻す — `lost` の像が `attached: true` で立つ。
  //
  // **⚠️ ここに書く例は古びる。** かつてこの位置には「起動時の引き取りは runner が
  // 名乗った状態をそのまま採りつつ `attached: true` を固定する（`#restoreJobs`）」
  // と書いてあったが、`#restoreJobs` の `attached` 判定は 2026-08-18 に
  // ブラックリストからホワイトリスト（`running` / `waiting_human` のときだけ
  // `true`）へ変わっており、その例はもう成り立たない。**例が古びたことと、
  // この判断（`lost` を `attached` より先に見る）が誤りであることは別である**
  // —— 判断のほうは上の別の隙間に対していまも効いている。
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
  // **宛先の器が黙ったなら、下の2つを見るまでもない。**
  //
  // ここから下の材料（`attached` / `sessionId`）は**どちらもイベント駆動でしか
  // 更新されない**。器が合図（`closed` / resume 失敗）を送らずに消えると
  // `attached` は `true` のまま残り、`isLive()` は「話しかけられる」と名乗り
  // 続ける。**器が消えた委譲を `running` から動かす経路がデーモンに無いこと**
  // （`tools.ts` の `describeManagerCounts` の doc）は `live` が補う前提で
  // 書かれていたが、**その `live` 自身が同じ材料しか見ていなかった** — 補うと
  // 名指しされていた層が、実際には補っていなかった。
  //
  // **足しているのは、デーモンが自分で既に確定させた判定だけである。** 名簿は
  // 10秒ごとの生存確認で黙った器を `state: 'lost'` にしており
  // （`runner-protocol.ts` の `#markSilent`。1回の取りこぼしでは動かさず
  // `HEARTBEAT_LOST_MS` を超えてから倒す）、その器は新しい委譲の宛先からも
  // 既に外れている（`RunnerRegistry#list()` の doc「`lost` は並ばない」）。
  // **置き先として数えない器に対して「話しかけられる」と名乗るほうが、そもそも
  // 食い違っていた。**
  //
  // **`status` は動かさない。** 黙っているのが器なのか経路なのかは片側からは
  // 決められないので、`lost`（＝resume を試して戻れなかったという確かめた事実）
  // をここで名乗らせることはしない。言えるのは「いま話しかけられない」だけで、
  // それはまさに `live` が言う内容である。
  if (record.job.runnerId !== undefined && silentRunners.has(record.job.runnerId)) return false;
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
function summaryOf(
  record: ManagerRecord,
  live: boolean,
  runnerLostSince: string | undefined,
): ManagerSummary {
  const { job } = record;
  return {
    managerId: job.id,
    status: job.status,
    live,
    // **`live` と同じ引数の作法で運ぶ（省略可能な引数にしない）。** 既定を置くと、
    // 足す人が考えなかったことが「宛先の器は黙っていない」という主張になって外へ出る。
    ...(runnerLostSince === undefined ? {} : { runnerLostSince }),
    cwd: job.cwd ?? '',
    request: job.request ?? job.summary,
    startedAt: job.createdAt,
    updatedAt: job.updatedAt,
    waiting: [...record.waiting],
    ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
    ...(job.lastReport === undefined ? {} : { lastReport: job.lastReport }),
    // **`lastReport` と対で運ぶ**（#358）。台帳をそのまま写すだけ——書き込みは
    // `#onEvent` の `case 'report'` の1箇所に閉じている。
    ...(job.lastReportAt === undefined ? {} : { lastReportAt: job.lastReportAt }),
    // **`lastReport` と同じ行で運ぶ。** 片方だけを載せると、読む側は「報告が来た」
    // と「エラーで死んだ」を本文の文言で判定するしかなくなる（塞いだ穴がここで
    // 開き直る）。応答として終わった回では台帳側で消えているので、ここは台帳を
    // そのまま写すだけでよい。
    ...(job.lastFailure === undefined ? {} : { lastFailure: job.lastFailure }),
    ...(job.runnerId === undefined ? {} : { runnerId: job.runnerId }),
    /*
     * **`unknown` を黙って落とさない。** 台帳が「永続性を確かめられなかった」と
     * 言っているとき、欄ごと消すと外からは**何も書かれていない**のと同じに見え、
     * 「取れなかった」という観測がそこで消える（AGENTS.md の地雷表と同じ形）。
     * 変種をそのまま写せば、値自身が `kind: 'unknown'` と `reason` で名乗る。
     */
    ...(job.workspace === undefined ? {} : { workspace: job.workspace }),
    /*
     * **貸し出しを台帳のまま写す**（M5 PR4）。
     *
     * `runnerId` が「どの宛先か」で、こちらは「その宛先の**どのプロセス**が、いつまで
     * 握っていると約束したか」である。これが外に出ていないと、引き取りが動かないのを
     * 見た人間とクローンは「忘れている」と「まだ握られていて待っている」を区別できず、
     * **待てば済む委譲を起こし直して同じ仕事を2本にする。**
     *
     * 判定そのものは出さない（`judgeLease` は時刻で答えが変わるので、一覧に焼くと
     * 読んだ瞬間から古びる）。**出すのは材料だけで、判定は読む側がその時刻でやる。**
     */
    ...(job.lease === undefined ? {} : { lease: job.lease }),
  };
}
