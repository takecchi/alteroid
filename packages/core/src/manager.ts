import { randomUUID } from 'node:crypto';

import { describeArchiveContinuityForJournal } from './archive-continuity.js';
import { DAEMON_RUNNER_REGISTRY_SOURCE } from './daemon-self-notice.js';
import { redactSecretsInText } from './denial-input-head.js';
import { denialInputAbsence, denialInputShape } from './denial-shape.js';
import {
  journalEntryShape,
  noteBackgroundFailure,
  noteDroppedRecord,
  noteManagerIdCollision,
  noteResumeAfterStopFoldFailed,
  noteRunnerFarewellGaveUp,
  noteUnreadableRecord,
  noteWithheldReportsDiscarded,
  reasonOf,
  runnerEventShape,
} from './dropped-record.js';
import { excerptLine, renderListing } from './excerpt.js';
import {
  EXCHANGE_KIND_DECISION_PREFIX,
  EXCHANGE_KIND_FAILURE_PREFIX,
  EXCHANGE_KIND_GAUGE_PREFIX,
  EXCHANGE_KIND_RECOVERY_PREFIX,
  EXCHANGE_KIND_REPLY_PREFIX,
  EXCHANGE_KIND_THINNING_PREFIX,
} from './exchange-kind.js';
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
import { classifyManagerActivity, describeManagerActivityForFlush } from './manager-activity.js';
import type { ManagerActivityInput } from './manager-activity.js';
import type { AgentPluginLoad } from './agent-events.js';
import { describePluginLoadForJournal } from './plugin-load-journal.js';
import { codeSpan } from './markdown-span.js';
import { JournalFoldWindow, foldedRunText } from './journal-fold.js';
import type { CredentialService } from './credential-service.js';
import type { McpServerService } from './mcp-server-service.js';
import type { PluginDistributionService } from './plugin-distribution-service.js';
import type { ProfileService } from './profile-service.js';
import { createRecentMap, type RecentMap } from './recent.js';
import { reportRunnerRevision, resolveBuildRevision } from './revision.js';
import type { RunnerRevisionReport } from './revision.js';
import {
  describeRunnerEntries,
  isFencedRunnerError,
  isRetryableRunnerError,
  isRunnerSpecificRefusal,
  listRunnerManagers,
  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  RUNNER_CAPABILITY_MANAGER_PEERS,
  RunnerHttpError,
  RunnerMcpServersUnsupportedError,
  RunnerPluginsUnsupportedError,
} from './runner-protocol.js';
import {
  classifyAutoFoldUnpushedWorkProbe,
  describeAutoFoldUnpushedWorkProbe,
  evaluateAutoFoldUnpushedWork,
  isPidsUnderPressure,
} from './manager-auto-fold.js';
import { isManagerFoldCandidate } from './manager-fold-candidate.js';
import {
  attachmentRefsOf,
  estimateAttachmentBodyBytes,
  ManagerAttachmentsRefusedError,
} from './manager-attachments.js';
import { readAttachmentLimits, type AttachmentLimits } from './attachment.js';
import {
  fetchManagerOutbox,
  rejectedFileOf,
  type ManagerReportFiles,
} from './manager-outbox-fetch.js';
import { runnerAttachmentBodyLimit } from './runner-attachments.js';
import type {
  RunnerAttachment,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  ScratchSweepItem,
  RunnerExecutionResources,
  RunnerLegState,
  RunnerManagerListing,
  RunnerManagerPeer,
  RunnerManagerPeerClosed,
  PidsSaturation,
  RunnerLiveness,
  RunnerMcpServersFingerprint,
  RunnerPlacementResources,
  RunnerProfileFingerprint,
  RunnerRegistry,
  RunnerRevisionStatus,
  RunnerWaiting,
  UnpushedWorkResult,
} from './runner-protocol.js';
import { brief, ONE_SHOT_ALLOW_TTL_MS } from './runner.js';
import type {
  InboxEvent,
  Job,
  JobStatus,
  JournalEntryInput,
  LastRescue,
  LastUnpushedWorkObservation,
  RescueRemoval,
  RescueWorktree,
  RescueRemovalFailureKind,
  RescueRemovalReason,
  TextMarkup,
  UnpushedWorkObservationSource,
  WorkspaceLocator,
} from './schema.js';
import { describeUnreadableManagerRow, type Stores } from './store.js';
import { pruneRescueLedger, rescueRemovalDue, syncTerminalMark } from './rescue-cleanup.js';
import { MAX_RESCUE_INTERVAL_MS } from './rescue-ref.js';
import { withCgroupEventsNote } from './cgroup-events.js';
import { withSystemErrorNote } from './system-error.js';
import {
  anyHintHasLossRisk,
  formatWorkspaceCloneHintLines,
  workspaceCloneHintsFrom,
  type WorkspaceCloneHint,
} from './workspace-swap-hints.js';
import { matchNoticeResetAgainstPool, type NoticeResetMatch } from './token-reset-match.js';
import {
  describeUsageNotice,
  limitRecoveryOf,
  mergeRateLimitFacts,
  rateLimitMemoryKey,
  usageTransitionOf,
  withRecoveryNote,
  type RateLimitFacts,
  type UsageLimitNotice,
} from './usage-limits.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { UsageRecordOrder, type UsageRecordTicket, usageDate } from './usage.js';

/**
 * SDK をここで動かさない: 同じ器で走らせるとマネージャーが `/proc/1/environ` から
 * デーモンの環境変数（記憶ストアの鍵）に届く。ツールを削って塞ぐのは禁止
 * （north_star 禁止2）なので実行環境を分ける。記録を書けるのは、鍵を持つデーモンだけ。
 */

export { MANAGER_MODEL, WORKER_MODEL, WORKER_AGENT_NAME, WITHHELD_ENV_KEYS } from './runner.js';

export interface ManagerStartInput {
  request: string;
  cwd?: string;
  /**
   * 指名した器が使えないとき**自動配置へは落とさない**（`RunnerRegistry#select` の doc）。
   * 配置の指名であって、本数の制限ではない。
   */
  runnerId?: string;
  /**
   * クローンはこの欄を書かない: 呼び出し元（`createCloneTools`）が `ToolContext.conversationId()`
   * から読んだ値をそのまま `Job.conversationId` へ写すだけ。
   */
  conversationId?: string;
  /**
   * 記憶・日誌には中身を写さない（日誌にはメタデータの参照だけ）。runner が
   * `manager-attachments` を名乗らなければ断る: 欄が黙って捨てられるため。
   */
  attachments?: RunnerAttachment[];
}

/**
 * 1つに畳まない: `'resume-failed'`（resume まで試して駄目）のほうが強い観測で、
 * `'unlisted'` は一覧に載っていなかっただけ。読み手の次の一手が違う。
 */
export type SessionMissingKind = 'resume-failed' | 'unlisted';

/**
 * `status` では表さない: `case 'report'` は `record.job.status = event.status;` を
 * `awaitingBackground` の分岐より前に実行するので、`status` は必ず `'done'` へ潰れ、
 * 「手が空いた」と「待って畳んだ」が台帳の軸で同じ顔になる。だから状態に添える。
 * `undefined` は「背景処理は無い」ではなく「そう名乗られていない」（古い runner）。
 * 在庫（`#withheldReports`）の写しで、デーモンを作り直すと消える。
 */
export interface ManagerAwaitingBackground {
  /** `withheldReports` と畳まない: 待っているタスクの数と握り潰した報告の本数は別の観測。 */
  tasks: number;
  withheldReports: number;
  /** 判定には使わない（診断用の写し）。 */
  breakdown: string;
  /**
   * `lastAt` ではなく最初に積んだ時刻。期限の判定そのものは載せない:
   * 時刻で答えが変わるものを一覧に焼かない。
   */
  since: string;
}

/**
 * `ManagerSummary.tokenGeneration` が `undefined` の理由。「欄ごと消える」だけでは、
 * 対処のある状態（`manager_stop` → `manager_start` で新しい鍵で起こし直す）に読み手が辿り着けない。
 *
 * - `'pool-not-wired'`: デプロイが世代を配線していない。このマネージャー固有ではなく、
 *   起こし直しでは直らない。
 * - `'not-yet-observed'`: このプロセスでまだセッションが「起きて」いない。始まれば埋まる。
 * - `'reattached-across-restart'`: 生きているセッションを引き取っただけで `#tokenIdentities`
 *   に記録が無い。唯一、対処がある（起こし直せば新しい鍵で記録し直す）。何を失うか・
 *   何を先に確かめるかはここに書き写さない: 字面の生成元は `usage-limits.ts` の
 *   `STALE_TOKEN_RESTART_ADVICE` 1箇所。
 *
 * `tokenGeneration` が定義されているときは欄ごと消える（取れない軸に0の行を作らない）。
 */
export type TokenGenerationUnknownReason =
  'pool-not-wired' | 'not-yet-observed' | 'reattached-across-restart';

export interface ManagerSummary {
  managerId: string;
  status: JobStatus;
  /**
   * `status: lost` と `live: true` は両立しない（`isLive()` が出さない）。
   *
   * `live: false` を「送っても届かない」と読み替えない: 器が黙ったことによる `false`
   * （`runnerLostSince` が立つ側）では `send()` が届いた実測がある。デーモン自身も
   * 「これは『いま開いた宛先が無い』という観測であって、戻せないことの証明ではない」
   * と名乗っている（`#runnerNotOpenDetail`）。逆に「送れば届く」でもない。
   * 実測と構造の根拠は `isLive()` の doc が持つ。
   */
  live: boolean;
  /**
   * `live: false` の理由を1つだけ名指しする欄。判定していなければ欄ごと消える。
   * `status` は動かさない: 黙っているのが器なのか経路なのかは片側から決められず、
   * 器の中でまだ走っている可能性が残る（`RunnerRegistryOptions.onLost` の doc）。
   * `lost` は resume を試して戻れなかったという確かめた事実の名前なので使わない。
   */
  runnerLostSince?: string;
  /**
   * `status: 'running'` のまま宛先の runner が名簿から entry ごと消えているときだけ立つ。
   * `runnerLostSince`（entry は残るが `lost`）とは材料が違い、排他でもない:
   * entry が消える前に必ず `lost` を経由するとは限らない。
   *
   * 時刻を持たない: 名簿は entry がいつ消えたかを記録していない。`…Since` の形で載せると
   * 読み手が消えた時刻として読むが、入れられるのは走り始めの近似だけで、取れない値を作ることになる。
   * 経過の目安が要る読み手は同じ行の `startedAt` を使う。
   *
   * `isLive()` の返り値は動かさない: entry が消えていても `sessionId` が残っていれば
   * `manager_send` は resume から入り直せることがある。
   */
  runnerVanished?: true;
  /**
   * 「居る」と言える事実（台帳に `runnerId`、名簿に entry で `lost` でない、`#runnerSessions()`
   * の一覧に載っている）が揃ったときだけ立てる。推測で立てない。ここで runner を叩かない
   * （生存確認が名簿へ立てた観測を同期に読むだけ）。`unreadableIds`（読めなかった委譲）は
   * 一覧に入らないので立たない: 「居る」と言い切れる材料が無い側へ倒す。
   * `status` も `live` も動かさない。古い観測は読み手が時刻を見て捨てる。
   */
  runnerListedAt?: string;
  /**
   * 応答した runner が一覧に載せなかった回だけに立てる。聞けなかった回は出さない:
   * 応答が無いことを「セッションが無い」と読むと、走っているマネージャーを
   * 「セッションが無い」と名乗ることになる（`#restoreJobs` / `#reattach` の歯止めと同じ）。
   *
   * `live` は落とさない: `sessionId` が残っていれば `manager_send` は resume から入り直せる。
   *
   * この欄は「この委譲が失われた」を意味しない。(1) 仕事の途中でセッションが失われた、
   * (2) 仕事が完遂した後にセッションが畳まれ、終端イベントだけが届かなかった、の
   * どちらもデーモンは台帳から区別できず、`lastReport` 空の `status: running` で残る。
   * (1) と決めつけると完遂済みの仕事を委譲し直すので、この欄を出す面は断りも一緒に出す
   * （`sendFailureDetail` の doc）。`status` は動かさない（`runnerLostSince` と同じ論法）。
   *
   * 立つ契機は3つ。1. `send()` が 404 を受け resume でも入り直せなかった回、
   * 2. `#reattach()` が一覧に居ないと判定し resume でも入り直せなかった回、
   * 3. 10秒ごとの生存確認が `GET /managers` で載っていないと観測した回（`Pool#noteMissingSessions`）。
   * 3つ目だけ新しい往復（heartbeat 1周につき1台1本。`RunnerClient.list` の doc）で、観測しかしない:
   * `attached` も `status` も動かさず resume も挑まないので、1・2 と違い「resume も駄目だった」
   * までは意味しない（`sessionMissingKind` が言い分ける）。`Pool#list` から自動で往復を払う
   * 形は禁止（north_star 禁止2）なので、往復は heartbeat の側にしか置かない。
   */
  sessionMissingSince?: string;
  /**
   * 2つを1つの ⚠ に畳まない: 次にやることが違う（`'resume-failed'` はもう話しかけられない。
   * `'unlisted'` は resume 未試行で `manager_send` で入り直せることがある）。
   * 格上げはするが格下げはしない: resume が駄目だった事実は、一覧に載っていない観測より強い。
   */
  sessionMissingKind?: SessionMissingKind;
  /**
   * `sessionMissingSince` が立っているときだけ載る。答えるのは「止まる直前の未 push 観測が
   * いま台帳に乗っているか」だけで、`true` なら `job.lastUnpushedWorkObservation` が
   * `source: 'shutdown'` かつ、いまの（失われた）セッションが置かれてから取られた。
   * `false` は観測が無い・`shutdown` でない・`runnerSessionSince` より前の3つを区別しない
   * （どれも「止まる直前の値だとは言えない」）。判定できない場合（`runnerSessionSince` が
   * 無い）もここへ倒す: 「不明」を「届いた」の側に倒さない。
   * `lastUnpushedWorkObservation` 自体は変えない（判定と生データを混ぜない）。
   */
  shutdownObservationArrivedAfterSwap?: boolean;
  /**
   * `probeTurnEnd` が生ログの末尾から見つけた、ターンが終わっているらしいという助言の
   * `timestamp`。デーモンが自分で計算した値で、台帳（`Job`）へは書かない（像が正本。
   * 再起動すれば消え、次のポーリングで計算し直す）。
   *
   * 判定ではない: 「報告が届いていない」の結論は持たず、読む側が `lastReportAt` と突き合わせる。
   * `turnEndReason` が在るのにこの欄が無い状態を「症状ではない」と読まない:
   * `timestamp` を持たない行では欠けうるが、その場合は比較できないだけ（既定は「分からない」）。
   *
   * 切らない・殺さない・止めない: `status` を動かさず、abort も貸し出し期限の短縮もしない。
   * `AskUserQuestion` が応答待ちで止まる形は射程外（末尾が `stop_reason: 'tool_use'` で
   * `probeTurnEnd` は「働いている最中」と読む）。
   */
  turnEndedAt?: string;
  /**
   * `turnEndedAt` と対で運ぶ。枠の壁（`stop_sequence`）と「ターンが終わったのに報告が
   * 届かない」は別の原因なので、読む側は混同しない。`turnEndedAt` は `timestamp` の無い行で
   * 単独で欠けうるので、「`turnEndedAt` が無い＝この欄も無い」ではない。
   */
  turnEndReason?: string;
  /**
   * 全文ではなく短い抜粋: 一覧・詳細の応答へそのまま載るため（`NOTIFY_REPORT_EXCERPT` と同じ理由）。
   * 消え方は `turnEndReason` と同じ。
   */
  turnEndTail?: string;
  /**
   * `probeToolUseStall` が見つけた行の `timestamp`。`timestamp` が無ければ欄ごと消える
   * （`undefined` を埋めない）。旗は `toolUseStallPending` のほうで、この欄が無くても
   * あちらが在れば観測は在る。時刻の閾値で判定しない: 矛盾の成立に経過時間は要らない。
   */
  toolUseStallAt?: string;
  /**
   * これだけでは症状ではない: `stop_reason: 'tool_use'` は道具を挟む途中経過でも普通に出る。
   * デーモンの `waiting` が空であることと突き合わせて初めて矛盾になり、その突き合わせは
   * 読む側が行う（`describeToolUseStall`）。`waiting` が非空なら確認は届いていて
   * クローンが未回答という正常な状態。切らない・殺さない・止めない。
   */
  toolUseStallPending?: PendingToolUse[];
  /**
   * `job.cwd` の写し。`cwdConfirmed` が立つ回は頼んだ値ではなく runner が実際に開いた値。
   * `cwdConfirmed` / `requestedCwd` は `start()` が返す回にだけ添い、後から読む一覧は
   * この欄（揃え直した後の値）だけを見る。
   */
  cwd: string;
  /**
   * `true` のときだけ載る。`undefined` は「古い runner で確認できなかった」で、`false` を
   * 書いて欠落を偽の値へ倒さない（取れない軸に0の行を作らない）。一覧には載せない:
   * 「いつ確認したか分からない確認済み」を持たせない。
   */
  cwdConfirmed?: true;
  requestedCwd?: string;
  request: string;
  startedAt: string;
  updatedAt: string;
  sessionId?: string;
  lastReport?: string;
  /**
   * デーモンが受け取った時刻であって、マネージャーが生成した時刻でも
   * クローンのターンへ配られた時刻でもない。測っていない名前を付けない（取れない軸に0の行を作らない）。
   */
  lastReportAt?: string;
  /**
   * 書いた瞬間は `record.job.status` の書き換え後の値（理由は `schema.ts` の `lastReportStatus` の doc）。
   * 「この報告は古い」の判定は `describeReportDrift` の役目で、ここは値を運ぶだけ。
   */
  lastReportStatus?: JobStatus;
  /**
   * `status` と混ぜない: 支出上限に当たった回もセッションは生きているので `status` は
   * `done` のまま（`schema.ts` の `lastFailure` の doc）。包んだ `lastReport` の本文の先頭を
   * 読んで失敗かどうかを判定させないため、要約にも載せる。
   */
  lastFailure?: NonNullable<Job['lastFailure']>;
  /**
   * `lastFailure` と軸が違い、どちらか一方だけが立つ（同じ欄に混ぜない）。見出しは
   * `lastFailure` と同じく「直近のターンの中身」へ倒す: `lastReport` は完遂した報告ではなく
   * 畳まれる前の途中経過。
   */
  lastUnreported?: NonNullable<Job['lastUnreported']>;
  /**
   * `lastReport` とは別の欄（`schema.ts` の doc）。`undefined` は「畳んだ本文が無い」と
   * 「まだ届いていない」のどちらもありうる。
   */
  lastFoldedTurn?: NonNullable<Job['lastFoldedTurn']>;
  /**
   * `lastFailure` と軸が違う: こちらはセッションそのものが `closed` として畳まれた
   * （`schema.ts` の `lastSystemError` の doc）。
   */
  lastSystemError?: NonNullable<Job['lastSystemError']>;
  /** `lastSystemError` と軸が違う（`schema.ts` の `lastCgroupEvents` の doc）。 */
  lastCgroupEvents?: NonNullable<Job['lastCgroupEvents']>;
  /**
   * `record.job.usageStoppedAt` を素通しにしない: `#usageStopped`（`Set`）が真の参照で、
   * Pool 側が `this.#usageStopped.has(managerId)` で門を通した値だけを引数で渡す。
   * 素通しだと `#clearUsageStoppedMark` が `Set` を先に下ろして台帳を非同期に下ろす窓で、
   * 要約だけが古い時刻を運ぶ。
   *
   * `lastFailure` とは別の軸で、重なりを許す（排他にしない）。走行中は `usage_notice` が
   * ターンの途中でも届くので `usageStoppedAt` だけが先に立ちうる。どちらか一方から
   * もう一方を推測しない。
   */
  usageStoppedAt?: string;
  runnerId?: string;
  workspace?: WorkspaceLocator;
  /**
   * 判定は載せない: 引き取ってよいかは時刻で答えが変わる（`judgeLease`）ので、一覧に焼くと
   * 読んだ瞬間から古びる。材料が無いと「忘れている」と「まだ握られていて待っている」を区別できない。
   */
  lease?: NonNullable<Job['lease']>;
  /**
   * 配列で持つ: 1回の応答で並列に呼ばれた道具は別の確認として同時に降りてくるので、
   * 回答は `requestId` で宛先を指定する。`kind` と `askedAt`（5分前か4時間前かで打つ手が変わる）も運ぶ。
   */
  waiting: RunnerWaiting[];
  /**
   * `undefined` は「そうではない」ではなく「そう名乗られていない」。`status` は動かさず状態に添える
   * （`runnerLostSince` と同じ作法）。字面にするのは `describeManagerState`（`digest.ts`）1箇所だけ。
   */
  awaitingBackground?: ManagerAwaitingBackground;
  /**
   * 材料は `#tokenIdentities`（daemon がこのセッションへ最後に実際に触れた瞬間に撒いていた世代）。
   * `ManagerPool#restore()` の living 枝（引き取るだけの経路）は含めない: セッションの env を
   * 更新しないので、含めると本物の食い違いがデーモンの再起動のたびに「一致」に化ける。
   * 未観測の構成では欄ごと消える（取れない軸に0の行を作らない）。
   *
   * 子プロセスの env の直接観測ではない: ターン境界に達しないまま古い鍵で走り続けていれば
   * この値も古いまま残るが、それは壊れているのではなく、この欄が名指ししたい状態そのもの。
   * プロセス内の Map なので再起動で消える。消えた理由は `tokenGenerationUnknownReason` が言う。
   */
  tokenGeneration?: number;
  /**
   * `tokenGeneration` が無ければこちらも無い（比べる相手が居ない判定を作らない）。
   * 一致・不一致の判定は焼かない（`lease` と同じ理由）。
   */
  activeTokenGeneration?: number;
  /** `tokenGeneration` が定義されているときは欄ごと消える（測れているのに理由を出さない）。 */
  tokenGenerationUnknownReason?: TokenGenerationUnknownReason;
  /**
   * `undefined` は「0 本」ではなく「分からない」（未聴取・古い runner）。往復は足さず名簿の観測を
   * 読むだけなので、少し古いことがある。
   */
  liveBackgroundTasks?: number;
  /**
   * `tokenGeneration` とは独立の材料: あちらは daemon のプロセス内記憶が前提で、こちらは
   * 429の文言と `TokenPoolStore` だけを見るので bookkeeping が無い場面でも判定できる。
   * 欄ごと消えるときを「世代ずれではない」へ倒さない（`undefined` は「健全」ではない）。
   * `usageStoppedAt` が下りる時点で一緒に消える: 古い判定が次の当たりに貼り付かないように。
   */
  resetTimeSkewMatch?: NoticeResetMatch;
  /** 台帳（`Job.lastUnpushedWorkObservation`）を写すだけ（`lastUnpushedWorkObservationSchema` の doc）。 */
  lastUnpushedWorkObservation?: LastUnpushedWorkObservation;
  lastRescue?: LastRescue;
}

/**
 * `null` へ畳まない: 3段のどこにも無かった（`missing`）と、退避はあったが本文を落とした
 * （`removed`）は別の事実。`archiveId` は退避から読めたときだけ載る（archive の外から来た
 * 本文に無い id を作らない）。`removed` は他の経路にも本文が無いときに限る（`transcript()` の doc）。
 * `unreadable` は台帳に行は在るが `jobSchema` に合わず読めない。`missing` に畳まない:
 * 壊れているだけで直せば読める行を「無い」として扱わせてしまう。台帳に行が無かった側
 * （`missing` になる側）にだけ見に行く。
 */
export type ManagerTranscript =
  | { readonly kind: 'body'; readonly body: string; readonly archiveId?: string }
  | {
      readonly kind: 'removed';
      readonly archiveId: string;
      readonly removedAt: string;
      readonly bytes: number;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly detail: string };

/**
 * `undefined` へ畳まない: `unavailable` は「確かめられなかった」ことそのもので、
 * 0 と混ぜない（取れない軸に0の行を作らない）。`reason` は人間・クローンが読む文言に
 * 直接使うので、機微を含まない範囲で短く書く。
 */
export type ManagerUnpushedWork =
  | { readonly kind: 'ok'; readonly result: UnpushedWorkResult }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * 変換ロジックを複数の書き込み元で手で合わせないための1箇所。`source` は呼び出し元が
 * 明示する: 省けば「不明」のまま台帳へ残り、ここでは推測で埋めない。
 * 「確かめきれなかった」4欄は `outcome.result` にあればそのまま写し、無ければ省く。
 * `unreadableDirSample` だけは写さない: 絶対パスを含みうるため（`cwd` を出さないのと同じ理由）。
 */
function unpushedWorkObservationOf(
  outcome: ManagerUnpushedWork,
  at: string,
  source: UnpushedWorkObservationSource | undefined,
): LastUnpushedWorkObservation {
  return outcome.kind === 'ok'
    ? {
        kind: 'observed',
        at,
        ...(source === undefined ? {} : { source }),
        // 出してよい範囲を継ぐ（`observedWorktreeBranchSchema` の doc）。
        // 件数は「出してよい範囲」の内側なので写す。
        cwd: outcome.result.cwd,
        worktrees: outcome.result.worktrees.map((worktree) => ({
          relativePath: worktree.relativePath,
          branch: worktree.branch,
          ...(worktree.remoteOrigin === undefined ? {} : { remoteOrigin: worktree.remoteOrigin }),
          ...(worktree.unpushedCommitCount === undefined
            ? {}
            : { unpushedCommitCount: worktree.unpushedCommitCount }),
          ...(worktree.unpushedCommitCountUnknown === undefined
            ? {}
            : { unpushedCommitCountUnknown: worktree.unpushedCommitCountUnknown }),
          ...(worktree.uncommittedChangeCount === undefined
            ? {}
            : { uncommittedChangeCount: worktree.uncommittedChangeCount }),
          ...(worktree.uncommittedChangeCountUnknown === undefined
            ? {}
            : { uncommittedChangeCountUnknown: worktree.uncommittedChangeCountUnknown }),
        })),
        ...(outcome.result.truncatedAtCount === undefined
          ? {}
          : { truncatedAtCount: outcome.result.truncatedAtCount }),
        ...(outcome.result.stoppedEarly === undefined
          ? {}
          : { stoppedEarly: outcome.result.stoppedEarly }),
        ...(outcome.result.scratchRootsUnknown === undefined
          ? {}
          : { scratchRootsUnknown: outcome.result.scratchRootsUnknown }),
        ...(outcome.result.unreadableDirCount === undefined
          ? {}
          : { unreadableDirCount: outcome.result.unreadableDirCount }),
      }
    : {
        kind: 'unavailable',
        at,
        ...(source === undefined ? {} : { source }),
        reason: outcome.reason,
      };
}

export function mergeRescue(
  previous: LastRescue | undefined,
  incoming: LastRescue['worktrees'],
  at: string,
): LastRescue {
  const byPath = new Map((previous?.worktrees ?? []).map((w) => [w.relativePath, w]));
  for (const tree of incoming) {
    const before = byPath.get(tree.relativePath);
    // `pushed.removal` はデーモンが書くので runner の `pushed` には無い。同じ退避 commit の
    // あいだだけ引き継ぐ（commit が変われば新しい退避で、消した印を新しい ref に付けない）。
    const carried: Partial<NonNullable<RescueWorktree['pushed']>> =
      tree.pushed !== undefined &&
      before?.pushed !== undefined &&
      before.pushed.commit === tree.pushed.commit &&
      before.pushed.ref === tree.pushed.ref &&
      tree.pushed.removal === undefined &&
      before.pushed.removal !== undefined
        ? { removal: before.pushed.removal }
        : {};
    byPath.set(tree.relativePath, {
      ...tree,
      ...(tree.pushed === undefined && before?.pushed !== undefined
        ? { pushed: before.pushed }
        : tree.pushed === undefined
          ? {}
          : { pushed: { ...tree.pushed, ...carried } }),
    });
  }
  return {
    at,
    worktrees: [...byPath.values()],
    ...(previous?.terminal === undefined ? {} : { terminal: previous.terminal }),
  };
}

/** 同点は勝たせる: `existing.at` が厳密に新しいときだけ弾く。 */
function isUnpushedWorkObservationAtLeastAsNewAs(
  candidate: LastUnpushedWorkObservation,
  existing: LastUnpushedWorkObservation | undefined,
): boolean {
  return existing === undefined || !(existing.at > candidate.at);
}

/**
 * `status` では表さない: 分類器か deny 規則がその場で拒否した仕事は `running` のまま手が止まり、
 * デーモンから見えるのは「拒否があった」事実だけで、それで止まったのかは観測していない。
 * だから状態の値は増やさず、状態に添える（`manager_list`）。
 */
export interface ManagerDenial {
  tool: string;
  count: number;
  /**
   * `undefined` は「マネージャーだった」ではなく「層が取れなかった」という第3の状態。
   * `'manager'` 側へ寄せない: `via: 'result'`（`agent_id` を持たないため層を判定できない）で
   * 拾った作業者の拒否が、黙ってマネージャーの拒否として数えられる。
   * 材料は SDK の `agent_id` で `via: 'live'` のときにしか載らない。`actor` を送らない旧い runner も
   * 同じ「取れていない」に落ちる。
   */
  actor?: 'manager' | 'worker';
  /**
   * 「止められた後に委譲が進んだか」を読む材料（{@link describeDenialFollowUp}）。
   * 無いことは「取れていない」であって「古い」ではない。
   */
  lastAt?: string;
  /**
   * 最新1件だけ。journal に既に残っている値を別の口からも届けるだけ（`deniedLastReason` の doc）。
   * 取れていない欄はキーごと省く（`denialSuffix` と同じ規則）。分類器・deny 規則の判定根拠ではなく
   * SDK が返した prose なので、`reason` の文字列を解釈して分類し直さない。
   * `/managers` へは流さない（`managerDenialSchema` が宣言していないので `.parse()` が落とす）。
   */
  reasonType?: string;
  reason?: string;
  message?: string;
  /**
   * 出所が `reasonType` とは違う: runner の `#onPreToolUse` が拒否より前に見た入力を伏せて切ったもの
   * （伏せ字済み・最大160字）。取れていない欄はキーごと省き、欠けた理由は読み分けられない。
   * `/managers` へは流さない（`reasonType` と同じ判断）。
   */
  inputHead?: string;
}

/**
 * 時刻の取れていない拒否が1件でも在れば判定できない: どちらへも畳まない（判定できないという
 * 3つ目の状態を持つ）。報告が届いたことは止められた道具を別の手で越えたことを意味しないので、
 * 文面もそこで止める。`status` の値は増やさない。
 */
export function describeDenialFollowUp(
  denials: readonly Pick<ManagerDenial, 'lastAt'>[],
  lastReportAt: string | undefined,
): string | null {
  if (denials.length === 0) return null;
  const times = denials.map((denial) => denial.lastAt);
  if (times.some((time) => time === undefined)) {
    return '最後に止められた時刻が取れていない拒否が在るので、止められた後に報告が届いたかは判定できない';
  }
  const latest = (times as string[]).reduce((a, b) => (a > b ? a : b));
  if (lastReportAt !== undefined && lastReportAt > latest) {
    return (
      `最後に止められた（${latest}）後にも報告が届いている（${lastReportAt}）。` +
      '止められた道具を別の手で越えたかまでは見ていない'
    );
  }
  return `最後に止められた（${latest}）後の報告はまだ届いていない`;
}

/** どちらの接頭辞にも一致しない文字列は推測でどちらかへ倒さず「取れていない」とする（`ManagerDenial.actor` の doc）。 */
function denialActorLayerOf(actor: string | undefined): 'manager' | 'worker' | undefined {
  if (actor === undefined) return undefined;
  if (actor.startsWith('worker:')) return 'worker';
  if (actor.startsWith('manager:')) return 'manager';
  return undefined;
}

/**
 * 区切りに `'::'` を使う: 道具名（MCP は `mcp__<server>__<tool>`）にこの並びは現れない。
 * 層が取れていない回は空文字ではなく `'unresolved'`: 空文字だと将来 `actor` の型が増えたとき
 * 「取れていない」と「その名前の層」が衝突しうる。上限は道具×層の組の種類数に効く。
 */
const DENIAL_KEY_SEPARATOR = '::';
const DENIAL_ACTOR_UNRESOLVED = 'unresolved';

function denialKey(tool: string, actor: 'manager' | 'worker' | undefined): string {
  return `${actor ?? DENIAL_ACTOR_UNRESOLVED}${DENIAL_KEY_SEPARATOR}${tool}`;
}

function decodeDenialKey(key: string): { tool: string; actor: 'manager' | 'worker' | undefined } {
  const separatorIndex = key.indexOf(DENIAL_KEY_SEPARATOR);
  if (separatorIndex === -1) return { tool: key, actor: undefined };
  const rawActor = key.slice(0, separatorIndex);
  const tool = key.slice(separatorIndex + DENIAL_KEY_SEPARATOR.length);
  return { tool, actor: rawActor === 'manager' || rawActor === 'worker' ? rawActor : undefined };
}

/**
 * `inputHead` は journal へは書かない（`case 'permission_denied':` の doc）。
 * 取れていない欄はキーごと持たない: 作り物を出さない。
 */
interface DenialReasonSnapshot {
  reasonType?: string;
  reason?: string;
  message?: string;
  inputHead?: string;
}

/**
 * `deniedAt` を持つ理由: `denialKey` は道具×層の組でしかなく、新しい拒否で上書きされても
 * 鍵は変わらない。照合用に古い `deniedAt` を残し、一致しなければ新しいエピソードとして
 * `stage` を 0 から数え直す（同じ鍵が再び長く止まったら新しい注意に値する）。
 */
interface DenialRenotifyState {
  readonly deniedAt: string;
  /** `DENIAL_RENOTIFY_DELAYS_MS.length` に達したらそれ以上は出さない（出し切りは日誌に1行残す）。 */
  stage: number;
}

/**
 * 1件も欄が無ければ `undefined`: 空オブジェクトだと「観測したが空だった」と
 * 「観測していない」が区別できなくなる。
 */
function denialReasonSnapshotOf(event: {
  reasonType?: string;
  reason?: string;
  message?: string;
  inputHead?: string;
}): DenialReasonSnapshot | undefined {
  const snapshot: DenialReasonSnapshot = {
    ...(event.reasonType === undefined ? {} : { reasonType: event.reasonType }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.message === undefined ? {} : { message: event.message }),
    ...(event.inputHead === undefined ? {} : { inputHead: event.inputHead }),
  };
  return Object.keys(snapshot).length === 0 ? undefined : snapshot;
}

/**
 * シェル構文は解析しない（`inspectBashCommand` のような分類器にしない）。誤検出
 * （`echo 'git push しました'`）は許容する: 起こすのは読み取りだけの `#observeUnpushedWorkOnce`
 * で余分に1回観測するだけ、見逃すと報告より前に落ちた委譲の枝名が台帳に残らない。
 * `&&` や `;` で連結されたコマンドの中も拾う。
 */
function bashCommandLooksLikeGitPush(command: string): boolean {
  return /\bgit\s+push\b/.test(command);
}

/**
 * `bashCommandLooksLikeGitPush` と同じ考え方（分類器にせず、見逃しを避ける）。
 * 完全ではない: `git branch -c` / `-m` や `-qb` のような結合短縮フラグは拾わない。
 * `git worktree add` は置き場所によらず観測を呼ぶが、`findGitDirs` は `job.cwd` から下方向にしか
 * 潜らないので、cwd の外（兄弟ディレクトリ）に置いた作業ツリーは観測に載らない。
 */
function bashCommandLooksLikeGitBranchCreate(command: string): boolean {
  return (
    /\bgit\s+checkout\s+-[bB]\b/.test(command) ||
    /\bgit\s+switch\s+-[cC]\b/.test(command) ||
    /\bgit\s+worktree\s+add\b/.test(command) ||
    /\bgit\s+branch\s+(?!-)\S/.test(command)
  );
}

/**
 * `live` を必ず持たせ、省略可能（`live?`）にしない（`summaryOf` の `live` と同じ理由）:
 * `status` だけだと `manager_list` が区別する「走行中」と「走行中だがセッション切断」が
 * `runner_list` でだけ潰れ、同じ状態を2つの道具が別の字面で出す。字面を作る
 * `describeManagerState`（`digest.ts`）が `live` を要求し、欠けたまま通ると
 * 取れているのに「セッション不明」と名乗る側へ黙って倒れる。
 */
export interface RunnerManagerEntry {
  managerId: string;
  status: JobStatus;
  live: boolean;
  /**
   * `live` と同じ理由でここにも運ぶ（運ばないと「手が空いた」と「背景処理を待っている」が
   * `runner_list` でだけ潰れる）。`live` と違って省略可能: 握り潰しが在るときだけ立つ印なので
   * `undefined` が正常。
   */
  awaitingBackground?: ManagerAwaitingBackground;
  /** 同じ理由でここにも運ぶ（運ばないと `manager_list` の ⚠ が `runner_list` で見えない）。省略可能。 */
  tokenGeneration?: number;
  activeTokenGeneration?: number;
  /** 同じ理由でここにも運ぶ（運ばないと3つの理由が `runner_list` でだけ「欄が消える」に潰れる）。 */
  tokenGenerationUnknownReason?: TokenGenerationUnknownReason;
}

/** プロセス内の記憶で、デーモンを作り直せば消える（押し込みは繋ぎ直しのたびにやり直す）。 */
export interface RunnerPushOutcome {
  status: 'ok' | 'failed';
  at: string;
  /** 失敗の理由（原文。言い換えない）。 */
  error?: string;
}

/**
 * 3つの押し込みは互いに独立して落ちる（`#pushCredentials` の doc）ので1つの状態へ畳まない:
 * 「どれが原因か」が見えなくなる。まだ試みていない欄は省き、`undefined` を「成功した」の
 * 既定値で埋めない（取れない軸に0の行を作らない）。
 */
export interface RunnerPushHealth {
  profile?: RunnerPushOutcome;
  credentials?: RunnerPushOutcome;
  agentToken?: RunnerPushOutcome;
  /** 口を持たない古い runner へは `failed` で記録するが、挑み直しには数えない（`RunnerMcpServersUnsupportedError` の doc）。 */
  mcpServers?: RunnerPushOutcome;
  /** 口を持たない古い runner へは `failed` で記録するが、挑み直しには数えない（`RunnerPluginsUnsupportedError` の doc）。 */
  plugins?: RunnerPushOutcome;
}

/**
 * マネージャー1本ぶんの観測で、作業者の分ではない（SDK は作業者ごとの結果を知らせない）。
 * 同じ runner の別のマネージャーが後から上書きしうるので `managerId` を名乗る。
 * `at` は daemon が `session` を受けた時刻で、init が出た時刻そのものではない。
 */
export interface RunnerPluginLoadObservation {
  at: string;
  managerId: string;
  pluginLoad: AgentPluginLoad;
}

/**
 * `status` から `state` を逆算しない: `unheard`（繋がっていないので聞いていない）は
 * `#runners.list()` がいまどの器を返すかという実装の都合に依存する（`RunnerRevisionStatus` の doc）。
 * `asked` は中身が0件・値が無しでもこれ。`failed` の理由は `reasonOf` で1行に畳む。
 * `GET /runners`（`runnerProbeSchema`）と意味を揃える。
 */
export type RunnerFingerprintProbe =
  { status: 'asked' } | { status: 'unheard' } | { status: 'failed'; error: string };

/**
 * `unsupported`（呼べる口が無い）を `failed`（呼んだが RPC が落ちた）と潰さない:
 * 鍵を配り直せば直る故障と、runner を上げないと直らない故障が同じ文言に見える。
 * `client.mcpServers` は `RunnerClient` の任意メソッド。
 */
export type RunnerMcpServersProbe = RunnerFingerprintProbe | { status: 'unsupported' };

/**
 * 疑う先が違うので潰さない: `unheard` は接続、`failed` は器の RPC、`unsupported` は runner の版。
 * `asked` で `resources` が `undefined` のままでも、応答が資源を名乗らなかっただけで失敗ではない。
 */
export type RunnerResourcesProbe = RunnerMcpServersProbe;

/**
 * `state` は6値のまま渡し `connected` へ畳まない: `unreachable` / `unusable` / `lost` / `vacating` の
 * 違いは、クローンが「これ以上起こさない」「新しい仕事は置けない」を判断する材料そのもの。
 */
export interface RunnerOverview {
  label: string;
  state: RunnerLiveness;
  since: string;
  error?: string;
  runnerId?: string;
  workspacePath?: string;
  /**
   * `runnerId` は器を作り直しても同じなので、これで「起こした委譲が載っていた器がまだ同じプロセスか」を確かめる。
   * 名乗らない runner では無い。無いことを「入れ替わっていない」と読まない。
   */
  instanceId?: string;
  /** 引き取りの猶予はここから数える。 */
  instanceSince?: string;
  /**
   * ここで数える本数はデーモンの台帳から見た数。自動配置（`chooseByResources`）が使う
   * runner の `/health` の本数（`RunnerPlacementResources.managers`）とは別物でずれうる。
   * 混ぜて「配置はこの数を見て決めている」と読まない。
   */
  managers: RunnerManagerEntry[];
  /**
   * 空であることだけを見ない: 叩けなかったときも欄ごと省かれるので、「鍵が配られていない」と
   * 読んでよいのは `credentialsProbe.status === 'asked'` かつ空のときだけ。
   */
  credentials?: RunnerCredentialFingerprint[];
  credentialsProbe?: RunnerFingerprintProbe;
  /** 無いことだけを見ない: 「置いていない」と読んでよいのは `profileProbe.status === 'asked'` かつ無しのときだけ。 */
  profile?: RunnerProfileFingerprint;
  profileProbe?: RunnerFingerprintProbe;
  /**
   * 値は運ばない。無いことだけを見ない: `asked` かつ無しなら「置いていない」、`unsupported` なら
   * 「口を持たない（古い runner）」、`unheard`/`failed` なら「訊けなかった」。
   */
  mcpServers?: RunnerMcpServersFingerprint;
  mcpServersProbe?: RunnerMcpServersProbe;
  /**
   * 潰さない3状態: 読めた／runner に訊けなかった（`resources` 自体が `undefined`。理由は
   * `resourcesProbe` が持つ）／訊けたが pids が読めなかった（cgroup を持たない器。欄ごと省略）。
   * 2 と 3 を同じ文言に倒さない: 疑う先が違う（2 は接続・器の生死、3 は cgroup 構成）。
   */
  resources?: RunnerExecutionResources;
  /** `resources` が無い理由（`unheard` / `failed` / `unsupported`）を持つ。 */
  resourcesProbe?: RunnerResourcesProbe;
  /**
   * 無ければ欄ごと無い: 「飽和ではない」とは言わない（材料が無いだけ）。窓の内側の印は
   * デーモンのメモリにあるので `resources` の要否に関わらず載り、`at-limit` は現在値が取れたときだけ足される。
   */
  pidsSaturation?: PidsSaturation;
  /**
   * `state` から導けない: `lost` でも直前の `known` な版が残ることがある（`RunnerRevisionStatus` の doc）。
   * ここで新たに runner を叩かない（`fingerprints` のように「未接続」と「頼んで失敗」が潰れる穴を増やさない）。
   */
  revision: RunnerRevisionStatus;
  /** `fingerprints: true` の要否と無関係に常に載る。新しい往復は払わず、プロセス内の記憶を読むだけ。 */
  pushHealth?: RunnerPushHealth;
  /**
   * 2状態を混ぜない: `named`（`peers` が空なら開いている peer は無い）／`unknown`（名乗らない旧い
   * runner・名乗り未受信・runnerId 無し）。`unknown` を「頼めない」と既定値で埋めない。
   * 新しい往復は払わず名乗りの記憶を読むだけ。
   */
  managerPeers?: RunnerManagerPeers;
}

export type RunnerManagerPeers =
  | { status: 'named'; peers: RunnerManagerPeer[]; closed?: RunnerManagerPeerClosed[] }
  | { status: 'unknown' };

export interface RunnerFleetOverview {
  runners: RunnerOverview[];
  /**
   * どの器の内訳にも混ぜず、0 に畳まず、別枠へ出す（取れない軸に 0 の行を作らない）:
   * 混ぜれば器の本数が水増しされ、捨てれば「マネージャーは全部どこかの器に居る」という
   * 誤った前提を実装が持つ。
   */
  unassigned: RunnerManagerEntry[];
  /**
   * `runners[].revision` と1回の読みで比較できるよう同じ応答の外側へ並べる（別々に出すと突き合わせ忘れが
   * そのまま見逃しになる）。自分のことなので `unheard` は無い。
   */
  daemonRevision: RunnerRevisionReport;
  /**
   * `resources: true` で、どれかの runner の pids が逼迫していた（{@link isPidsUnderPressure}）ときだけ
   * 計算し、逼迫していなければ欄ごと省く（0件と「見なかった」を区別する）。
   * 同じ呼び出しの `runners[].managers` は resources を聞く前に確定しているので、ここで畳んだ分を
   * 反映していないことがある。「実際に何をしたか」の唯一の正しい情報源はこの欄。
   */
  autoFolded?: readonly AutoFoldOutcome[];
}

/**
 * - `'blocked-unpushed-work'`: 未 push の安全弁（{@link evaluateAutoFoldUnpushedWork}）が見送った
 * - `'raced'`: 畳む直前に読み直したら既に `done` ではなかったので、安全側に倒して何もしなかった
 * - `'skipped-concurrent'`: 2つの契機のもう一方が同じ委譲を処理中（`#autoFoldInFlight` の doc）。
 *   「判定できない」ではなく、安全弁の見送りとは別の理由として扱う
 */
export interface AutoFoldOutcome {
  readonly managerId: string;
  readonly runnerId: string;
  readonly outcome:
    'folded' | 'blocked-unpushed-work' | 'raced' | 'skipped-concurrent' | 'not-stopped' | 'unknown';
  readonly detail: string;
}

/**
 * キャッシュであって現在値ではない。「あるはずの runnerId がここに無い」ことは「滞留が0件」を
 * 意味しない: `identity()` を持たない runner（`LocalRunner`・古い器）は heartbeat からは warm せず、
 * `runners({ resources: true })` を一度も呼んでいなければ cold のまま。「0件だった」と「まだ観測していない」を
 * 読む側が区別できるようにする（`runnerBacklog()` の doc）。
 * どちらの入口も、これを埋めるためだけの新しい往復を払わない（`manager_list` から自動で `resources()` を
 * 呼ぶと opt-in の判断がクローンから奪われる。north_star 禁止2）。
 */
export interface RunnerBacklogSnapshot {
  runnerId: string;
  pendingEvents: number;
  /** 1件も無ければ省かれる。 */
  oldestPendingAt?: string;
  observedAt: string;
  /**
   * 観測したのと同じ応答から拾った instanceId。判定結果ではなく {@link instanceSwapped} を導く材料で、
   * 比べるのは時刻ではなく instanceId そのもの。
   */
  instanceIdAtObservation?: string;
  /**
   * 時刻の大小比較（`instanceSince > observedAt`）にしない: `#noteInstance` は instanceId を
   * 初めて聞いた初回にも `instanceSince` を立てるので、観測がそれより前だと入れ替わっていないのに
   * 「もう来ない」が出る（偽陽性）。「もう来ない」は回収を諦める側へ倒す唯一の状態で、偽陽性の代償が大きい。
   * `Outbox` はプロセスのメモリだけなので、器が入れ替われば観測した滞留は二度と配られない。
   * `undefined` は「判定できない」: どちらか一方でも取れていなければ `false` へ倒さない。
   */
  instanceSwapped?: boolean;
  /** `observedAt` とは時制が違い、呼んだいまの値（キャッシュせず毎回読み直す）。取れない実装では省かれる。 */
  legState?: RunnerLegState;
}

export type ManagerDecision = 'allow' | 'deny';

/**
 * 「届けた」を4値以上で言う（`ManagerAbortResult` と同じ形: `outcome` だけを見ると嘘を受け取る）。
 *
 * | 値 | 意味 | HTTP |
 * | --- | --- | --- |
 * | `'answered'` | 止まっていた確認を解いた | 200 |
 * | `'delivered'` | 追加指示として届けた（runner にセッションが無くて resume から入り直した回も含む。`detail` がそう言う） | 200 |
 * | `'session_missing'` | runner がこの委譲のセッションを持っておらず、resume でも入り直せなかった。そのものは居る | 200 |
 * | `'unknown'` | 届けられたか確かめられなかった（宛先の runner が名簿に開いていない・待ちの宛先が決められない・引き取り中 など） | `'unknown'` のみ 404 |
 * | `'unreadable'` | 台帳に行は在るが読めない形で入っている。送っていない。`'unknown'`（居ない）と分ける | 409 |
 * | `'declined'` | 世代が食い違う done の委譲を畳んで新しい鍵で起こし直したいが、畳めない（背景処理・確認待ちが残っている・それらが分からない・畳めたと確かめられない）ので、畳まず、旧セッションへも送らなかった。そのものは居る | 200 |
 *
 * `'session_missing'` を `'unknown'` へ畳まない: `app.ts` が 404 を返し、`ManagerAbortResult` の doc が
 * 否定した形（待てば直る状態を 404 という機械可読な終端で返す）に戻る。`sessionId` が残っていれば
 * もう一度 resume を試せる。404 は「そんなものは無い」としてしか読めず、読み手の解釈で救われない。
 * `RunnerClient.send` が `Promise<boolean>` なのは、`LocalRunner` が例外を投げず、セッションが
 * 無くても常に `'delivered'` になるのを防ぐため（`#sendDetectingMissingSession` が戻り値も読む）。
 */
export interface ManagerSendResult {
  outcome: 'answered' | 'delivered' | 'session_missing' | 'unknown' | 'unreadable' | 'declined';
  detail: string;
}

export interface ManagerSendOptions {
  decision?: ManagerDecision;
  /** どの確認への回答か。複数を待っているときは省略できない。 */
  requestId?: string;
  /**
   * 確認への回答（`requestId` / `decision`）には載せられない（回答の口は本文しか運ばない）ので、
   * 回答として扱われる回に添付があれば、何も送らずに断る。
   */
  attachments?: RunnerAttachment[];
}

/**
 * 記録が嘘をつかないためだけの値で、止まり方は誰が押しても同じ（1本の道を通る）。
 * `by === 'clone'` は日誌に残すがクローンの受信箱へは配らない: 同じ情報を `manager_stop` の戻り値で
 * 同じターンに既に受け取っており、配り直しは新しい情報を持たずにクローンのターンを消費する
 * （理由の全文は `abort()` 内の `if (by !== 'clone')` の doc）。`'human'` と、デーモン自身が
 * pids 逼迫で畳んだ `'auto-fold'` は外から来た出来事でクローンに他に知る手段が無いので配る。
 */
export type ManagerStopActor = 'human' | 'clone' | 'auto-fold';

/**
 * 「止めた」を、成功 / 明確な失敗 / 不明 / そのものが居ない / 読めない で言う。
 * 判定を `sessionGone` に逃がして `outcome` を常に `'stopped'` にすると、`outcome` だけを見る面が
 * 「止まった」という嘘を受け取る。
 *
 * | 値 | 意味 | 台帳への書き込み | HTTP |
 * | --- | --- | --- | --- |
 * | `'stopped'` | `sessionGone === true`。止まったと確かめた | `status: 'stopped'` へ、`waiting`/`attached` を畳んで `#retire` | 200 |
 * | `'not_stopped'` | `sessionGone === false`。止まっていないと確かめた（明確な失敗） | 何も書かない | 200 |
 * | `'unknown'` | 確かめられなかった（`runner.list()` が答えない／`runner.stop()` が期限切れ／宛先の runner が名簿に開いていない） | 何も書かない | 200 |
 * | `'absent'` | そのマネージャーが台帳に居ない | — | 404 |
 * | `'unreadable'` | 台帳に行は在るが読めない形で入っている。止めていない。行は書き換えていない | 何も書かない | 409 |
 *
 * `'unreadable'` を `'absent'` に畳まない: 直せば読める行を消えたものとして扱わせる。
 * `'absent'` に「宛先の runner が居ない」を含めない: 宛先が開いていないだけのマネージャーは存在し、
 * 「開いていない」は `unreachable`（再試行は予約済み）を含むので、待てば直る状態を 404 という
 * 機械可読な終端で返すことになる。404 は「そんなものは無い」としてしか読めず、文言と違って
 * 読み手の解釈で救われない。その場合は `'unknown'`（200）。
 */
export interface ManagerAbortResult {
  outcome: 'stopped' | 'not_stopped' | 'unknown' | 'absent' | 'unreadable';
  detail: string;
  /**
   * 止まったことを runner のセッション一覧から消えたことで確かめた結果。`undefined` は確かめられなかった。
   * 「停止を受理した」と「止まった」は別の観測: `runner.stop()` は該当のセッションが手元に無ければ
   * 黙って何もしないので、受理だけを見て「止まった」と言うと走り続けているマネージャーを止めたことにしてしまう。
   * 外向きの面が読むのは `outcome` で、ここは根拠として残す。
   */
  sessionGone?: boolean;
}

/**
 * `vacate()` が停止の握手を飛ばした理由。`runner_unreadable` は名簿に居ない回（`null`）とは別
 * （居ないなら握手する相手が無い）。
 */
export type VacateHandshakeSkipReason = 'runner_unreadable' | 'jobs_unreadable';

/**
 * `handshakeSkipped` は握手を飛ばした回にだけ載る: 空の値を載せると「飛ばさなかった」と
 * 「言っていない」が区別できなくなる。飛ばしたときは貸し出しを返していないので、呼び直せば
 * 握手をやり直す。`'vacating'` は立てて `relocateFrom` も呼んでいる（飛ばしたのは握手だけ）。
 */
export interface VacateResult {
  handshakeSkipped?: {
    reason: VacateHandshakeSkipReason;
    /** 何を読めなかったために何をしなかったか。 */
    message: string;
    /** 常に `true`（欄の形を固定するための印）。 */
    retry: true;
  };
}

export interface ManagerPool {
  start(input: ManagerStartInput): Promise<ManagerSummary>;
  send(
    managerId: string,
    message: string,
    options?: ManagerSendOptions,
  ): Promise<ManagerSendResult>;
  /**
   * クローンも同じここを通る（`manager_stop`）。人間に出来てクローンに出来ないことを作らない
   * （north_star 禁止1）。違うのは `by` に残る名前だけで、止まり方は変えない: 停止が2種類あると
   * 見えている状態が食い違う。人間が直接止められること自体が要件。
   */
  abort(managerId: string, reason?: string, by?: ManagerStopActor): Promise<ManagerAbortResult>;
  list(): Promise<ManagerSummary[]>;
  /**
   * `ManagerSummary` には載せない: デーモンのプロセス内の像で、台帳には無い（器を作り直せば数え直し）。
   * 台帳から作る `ManagerSummary` を汚さずに、読む側が状態へ添えられる。
   */
  denials(managerId: string): ManagerDenial[];
  /**
   * 数え上げの持ち主を1か所にするためここへ置く（`ToolContext` に `RunnerRegistry` を足さない）:
   * 器ごとの本数は名簿と台帳の両方が要り、`ManagerPool` が両方を持つ唯一の場所。
   * 既定では `resources()` を呼ばない（この一覧のために往復を足さない。ここで数える本数は
   * 台帳から見える分で、配置が使う本数とは別物）。`fingerprints` / `resources` は opt-in:
   * 既定では出さず（要らないものを文脈へ載せない）、north_star 禁止2 のため出せる口は残す。
   * `resources()` が無い理由は `RunnerOverview.resourcesProbe` が分けて持つ。
   */
  runners(options?: { fingerprints?: boolean; resources?: boolean }): Promise<RunnerFleetOverview>;
  /**
   * `GET /runners` は `runners()` とは別の経路で一覧を組むので、数え上げの持ち主を増やさないため
   * `runners()` と同じ `#pushHealth` を返すだけの薄い口を置く。
   */
  pushHealthOf(runnerId: string): RunnerPushHealth | undefined;
  /**
   * `GET /runners` が `pushHealthOf` と同じ理由で経由する。省略可能: 実装しないプールでは呼び出し側が
   * 「観測なし」に倒す。`undefined` は「読み込みに失敗した」とも「0件」とも読まない。
   */
  pluginLoadOf?(runnerId: string): RunnerPluginLoadObservation | undefined;
  /** `pushHealthOf` と同じ理由で `GET /runners` が経由する。省略可能: 実装しないプールでは呼び出し側が `unknown` に倒す。 */
  managerPeersOf?(runnerId: string | undefined): RunnerManagerPeers;
  /**
   * ネットワークを叩かない（`RunnerBacklogSnapshot` の doc）。`identity()` を持たない runner は
   * 観測していなければ出てこない: 滞留が0件だからではないので、呼び出し側は「行が無い＝0件」と読まない。
   *
   * 省略可能（`?`）にしない: `runnerBacklog?.() ?? []` と書かせると「この口を持たない実装」と
   * 「1件も観測していない」が同じ `[]` に畳まれ、「まだ観測していない」と「滞留0」を区別する
   * 目的が呼び出し口の型で潰れる。`openapi.ts` の spec 生成専用スタブの側へ1行足す。
   */
  runnerBacklog(): readonly RunnerBacklogSnapshot[];
  /**
   * 走行中の像（`#records`）に在ればそれを返し（追加のI/Oは無い）、無ければ台帳（job store）まで降りる
   * （`#retire()` が像を消す done/lost/failed/stopped がここに当たる。
   * `grep -Fn -- '  #retire(managerId: string): void {' packages/core/src/manager.ts`）。
   * 主目的の `manager_transcript` の言い分けは、委譲が既に `#retire()` 済みの場面で使われるので、
   * `#records` だけを見ると言い分けが要る場面でだけ `undefined` になる。
   * runner への往復は払わない。像にも台帳にも無いときは `undefined`。
   */
  runnerIdOf(managerId: string): Promise<string | undefined>;
  /**
   * 無ければ `undefined`。ネットワークは叩かない（名簿のメモリを読むだけ）。省略可能なのは
   * `runnerHasCapability` と同じ理由で、持たないプールは「材料なし」と読む。
   */
  runnerPidsSaturation?(runnerId: string): PidsSaturation | undefined;
  /**
   * 名乗りを受けていない・欄を送らない旧い runner は `false`（持つと仮定しない）。省略可能なのは
   * テストの偽のプールのためで、持たないプールは「確かめられない」＝ `false` と読む。
   */
  runnerHasCapability?(runnerId: string, capability: string): boolean;
  /**
   * 表示用。名乗りを受けていない・欄を送らない旧い runner は `undefined`（不明。既定の帯で埋めない）。
   * 片方だけ名乗られたら、名乗られた側だけ持つ。
   */
  runnerReportedModels?(runnerId: string): { manager?: string; worker?: string } | undefined;
  /** 表示用。`undefined` は不明で、`[]` の「何も置かれていない」とは別。 */
  runnerReportedAnthropicRoute?(runnerId: string): readonly string[] | undefined;
  /**
   * 新しい往復・周期処理は無い: `#place` が既に払った `resources()` の応答を使う（判定・実行は
   * `#autoFoldIdleOnRunnerIfUnderPressure` と共有し、ロジックを2つに増やさない）。
   * `manager_start` の応答を待たせない（`void` で切り離す）: 配置の点数計算は終わっていて、
   * 畳んだ分の pids は今回の配置に反映されないのに、`unpushedWork()` の往復ぶん配置が遅くなる。
   * 省略可能なのは `runnerHasCapability?` と同じ理由。
   */
  autoFoldOnPlacementPressure?(
    runnerId: string,
    pids: { readonly current: number; readonly max: number },
  ): void;
  /** manager_id からセッションの生ログへ降りる（可観測性の最下段）。 */
  transcript(managerId: string): Promise<ManagerTranscript>;
  /**
   * このメソッド自体は例外を投げない: runner が答えなかった・この口を持たない・像を持っていない、
   * どの理由でも `{ kind: 'unavailable', reason }` を返す（呼び出し元が止まってはいけない）。
   * 呼び出し元は「確かめられなかった」として扱い、0 とは混ぜない。`manager_list` からは呼ばない
   * （一覧のために自動で往復を足さない。`runners()` の doc と同じ理由）。
   * `force: true` の `abort()` も呼ぶ: 決めたのは「止めるかどうか」であって「どこを見ればよいか」ではなく、
   * 台帳にその記録を残す価値を取った。
   *
   * 省略可能（`?`）にしない（`runnerBacklog()` の doc と同じ理由）。`options.source` は台帳に残す観測へ
   * 呼び出し元自身の経路を刻むが `.optional()` のまま残す（外部実装・spec 生成用スタブを壊さないため）。
   * 省いた観測は「不明」のままで、0件や偽の経路名を作らない。内部の呼び出し元は全員明示する。
   */
  unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal; source?: UnpushedWorkObservationSource },
  ): Promise<ManagerUnpushedWork>;
  /**
   * 走行中の委譲の生ログを消せないようにする唯一の判定所: `DELETE /archive/:id` と `archive_remove` の
   * 両方がここを通る（2箇所に同じ判定を書くと片方だけ直る）。
   * `done` を「終わった」の判定に使わない: `'done'` は `#finish('done', ...)`（＝畳まれた）と、
   * `#finish` を通らずに `#status` だけを `'done'` にして `#records` に生き残る経路の両方から付き、
   * この一覧はどちらの `done` かを区別する材料を持たない（逐語は
   * `grep -Fn -- 'どちらの `done` かを区別する材料を持たない' packages/core/src/manager.ts`）。
   * だから `#status` を一切見ず、`#records` に居るかどうかだけで決める。ネットワークは叩かない。
   */
  runningManagerOwning(archiveId: string): string | undefined;
  /**
   * `runningManagerOwning` と同じ走査で、保護を `job.archiveIds` の末尾1本だけに狭めた版。
   *
   * `archiveIds` は古い順に push され（`grep -Fn -- 'record.job.archiveIds = [...(record.job.archiveIds ?? []), write.id];' packages/core/src/manager.ts`）、
   * `transcript()` は新しい順に辿って最初に見つかった本文を返す
   * （`grep -Fn -- 'for (const id of [...(job.archiveIds ?? [])].reverse())' packages/core/src/manager.ts`）。
   * 走行中の委譲にとって意味を持つのは末尾の1本だけで、古い写しは `continuity === 'continues'` の鎖で
   * その1本に含まれる。`runningManagerOwning` は古い写しまで保護するので、自動の畳み
   * （`archive-folder.ts`）が1件も前へ進めなかった。末尾でない一致は無視する。
   *
   * 使ってよいのは `guardArchiveRemoval` の `requireContainment` が `true` のときだけ
   * （`selectArchiveRemovalTargets` の「含有の証明」の上にしか成り立たない）。省略可能なのは
   * この機能を使わない既存のスタブを書き換えずに済ませるためで、`guardArchiveRemoval` は
   * このメソッドを持たない像に当たったら安全側（広い保護）へ倒す。ネットワークは叩かない。
   */
  runningManagerPinning?(archiveId: string): string | undefined;
  /**
   * デーモン起動時に、走行中だったマネージャーを台帳と runner から拾い直す。
   * 戻り値は「中断されていて実際に resume した」分。
   */
  restore(): Promise<ManagerSummary[]>;
  /**
   * `restore()` では届かない: あちらは像に無い委譲だけを拾い（`#restoreJobs` の先頭が
   * `if (this.#records.has(job.id)) continue;`）、resume するのは台帳が `running` /
   * `waiting_human` の分だけ。枠で止まった委譲はデーモンが走り続けているので像が在り、
   * 台帳には `done` / `failed` / `lost` で残るのでどちらの条件からも外れる。
   * 鍵を撒くだけでは足りない: `#reopenForTokenRotation` が保つのは会話であって仕事ではなく、
   * 開き直したセッションは誰かが話しかけるまで何もしない。ここが投げる一言がその「話しかける」。
   * `parked` では呼ばない（撒いた鍵はまだ通らず、起こしても同じところで止まる）。
   */
  resumeStoppedByUsage(): Promise<string[]>;
  /**
   * `restore()` とは拾う対象が違う: あちらは像の無い委譲を拾い、走行中だった委譲は先頭で見送る。
   * 器が入れ替わったときに拾いたいのはまさにその走行中だった分。引き取ってよいかの判定は
   * 貸し出し期限の関門が持ち、ここが約束するのは「取り直しを試みる」まで。
   */
  reattachRunner(runnerId: string): Promise<void>;
  /**
   * 契機は2つ（`lost` と、意図して空けた `vacating`）なので引数名は `runnerId`: 運ぶのは
   * 「その宛先からは動かしてよい」という事実であって、黙ったことの証明ではない。
   * 新しい梯子は作らない: `#reattach` の既存の予約（`#scheduleReattach`）に乗る。貸し出しがまだ
   * 生きていれば断られ、期限が切れてから移る。
   */
  relocateFrom(runnerId: string): void;
  /**
   * HTTP の面（`POST /runners/vacate`）が呼ぶ唯一の受け口。順序そのものが要点なので入れ替えない:
   *
   * 1. まず名簿へ `'vacating'` を立てる。後にすると `list()` / `select()` がこの宛先を置き先として
   *    返し続け、セッションを止めて貸し出しを返した直後の窓に新しい委譲が置かれて drain が終わらない。
   * 2. 載っている委譲に「確かめた停止」の握手（`#confirmStoppedAndReleaseLease`）をする。
   *    `status` を `'stopped'` にせず `#retire` も呼ばない: drain は終わらせるのではなく移すためで、
   *    終端にすると `#reattach()` の `status !== 'running' && status !== 'waiting_human'` の関門に
   *    引っかかり二度と移送されない。握手の直前に `unpushedWork()` を1回取る（生きて答えられる最後の
   *    機会。失敗しても握手の判定は変えない）。日常の Railway redeploy は `vacate()` を通らないので
   *    この観測は効かない。
   * 3. `relocateFrom(runnerId)` を呼ぶ。貸し出しを先に返してあるので期限を待たずに移る。
   *
   * 1 を先にする側だけが回復不能な窓を作らない: 途中で失敗しても `#shouldRelocateFrom` が真のままで
   * 移送は続き、貸し出しの関門が二重実行を止める。握手を飛ばした回は `handshakeSkipped` で言い、
   * 「居ない／無い」とみなして進まない（貸し出しは返しておらず、呼び直せば握手をやり直す）。
   */
  vacate(runnerId: string): Promise<VacateResult>;
  /**
   * 知らせるだけ: `status` は動かさず、abort もしない、貸し出し期限も縮めない。判定
   * （報告が届いていないか）は読む側が `lastReportAt` と突き合わせる。費用の門はあるが判定の門は無い
   * （絞るのは生ログを読むコストを払わないため）。1件の失敗で残りを止めない: ここで投げると
   * 呼び出し元（デーモンのポーラー）のループごと止まり、以後の全マネージャーの助言が更新されなくなる。
   */
  probeTurnEnds(): Promise<void>;
  /**
   * 握り潰した「背景処理の完了待ちで畳んだ報告」の逃げ道（`case 'report'` の
   * `event.awaitingBackground` の doc）。握り潰すのは「後で必ず配る」であって「捨てる」ではない:
   * 次の本物の報告が `#emit()` を通るときに上書きされるが、それが来なかった場合に、`lastAt` から
   * `WITHHELD_REPORT_FLUSH_MS` 経った積みをクローンへ配って帳面を空にする。
   * `probeTurnEnds` の中には入れない（あちらは費用の門を持つ別の関心事）。
   * 1件の失敗で残りを止めない。
   */
  flushWithheldReports(): Promise<void>;
  /**
   * 借り（`#usageWakeOwed`）だけが立って返らなくなった枠停止の委譲を、`probeTurnEnds()` の助言で起こす。
   * `probeTurnEnds` の「切らない・殺さない・止めない」は破らない: 判定して切るのは探り自身で、
   * `turnEndedAt` と `lastReportAt` を突き合わせて一言送るのは読み手。`status` も貸し出しも動かさない。
   *
   * 4条件（借りが立つ・`#usageStopped`・`status === 'running'`・`turnEndedAt` が `lastReportAt` より後）が
   * 全部揃ったときだけ発火する: 1つでも外すと走っている委譲を死んだと見なして1ターン焼く。
   * `turnEndedAt` が無いのは「終わっていない」ではなく「判定できない」。回数上限は置かず、
   * 借りを挑む前に下ろして毎分掃き続けない。`probeTurnEnds()` より後に呼ぶ（同じ回の値を読むため）。
   * 1件の失敗で残りを止めない。
   */
  settleStalledUsageWakes(): Promise<string[]>;
  /**
   * 分類器の拒否（`case 'permission_denied'`）から `DENIAL_RENOTIFY_DELAYS_MS` 経っても動きが無い委譲へ、
   * もう一度知らせる。「進んだ」は `lastReportAt` / `lastToolSettledAt` が拒否より後であることだけで見る:
   * `PostToolUseFailure` は型付きの欄が無く、本文を嗅ぐと `case 'note'` の「欄で判定し、本文を嗅がない」を破る。
   *
   * 委譲ごとの `waiting_human` で見送らない: 無関係な未決の確認が1件あるだけで別の拒否の知らせ直しまで止まる。
   * 見送るのは、この拒否自身の `toolUseId` と同じ `requestId` の確認が `record.waiting` に在る回だけ。
   * 数える単位は拒否1件（`deniedLastAt`）で、新しい拒否は数え直す。出し切ったら日誌へ1行残す。
   * タイマーはデーモンに置く（runner は畳まれるたびに消える）。帳面はプロセス内の像なので再作成で消える。
   * 1件の失敗で残りを止めない。
   */
  renotifyStalledDenials(): Promise<void>;
  /**
   * 退避 ref（`refs/alteroid-rescue/…`）の後始末を1周する。省略できる（`unpushedWork` の口と同じ）。
   * 台帳（`Job.lastRescue`）に無い ref は触らない（孤児を消さない）。消した印は `pushed.removal` に残し、
   * `pushed` は消さない。走査の間隔はここで空ける（全委譲の台帳を読むので毎分は撃たない）。
   * 1件の失敗で残りを止めない。
   */
  sweepRescueRefs?(): Promise<void>;
  /**
   * 合流窓（`#synthesizedNotices`）に残った積みは必ず flush する: 窓の中で止まると `setTimeout` が
   * 二度と発火せず失われる（`#queueSynthesizedNotice` / `#flushSynthesizedNotices` の doc）。
   * `shutting_down` を名乗った runner だけ、最後の出来事を受け取り切るまで待つ（{@link ManagerPoolStopOptions}）。
   */
  stop(options?: ManagerPoolStopOptions): Promise<void>;
}

/**
 * `stop()` が `shutting_down` の runner を待つ上限の既定（ms）。デーモンの forced exit（SIGTERM から 55 秒）の
 * 内側に収める: 待ったあとに台帳の書き込み待ちと `storage.close()` が残るので 55 秒には届かせない。
 */
export const RUNNER_FAREWELL_WAIT_MS = 45_000;

export interface ManagerPoolStopOptions {
  /**
   * `shutting_down` を名乗った runner を待つ**絶対の締切**（`now()` と同じ時計の ms）。
   * 省略すると `stop()` の呼び出し時刻から {@link RUNNER_FAREWELL_WAIT_MS}。
   * 達したら待つのをやめて閉じる側に倒し、受け取れなかったものを1行残す。
   */
  farewellDeadlineAt?: number;
}

/**
 * `archive_remove` / `archive_remove_many` / `DELETE /archive/:id` が実際に
 * 消してよいかの、唯一の判定所。
 *
 * 既定は拒否だが override で開けられる: 走行中の退避を守るのは方針であって能力の削除ではなく、
 * 方針は設定で開けられなければならない（`grep -Fn -- '追加制限禁止' docs/north_star.md`）。
 * `overrideReason` は真偽値にしない: `override: true` で理由が空、という組が型の上で成立してしまう。
 * 理由の記録は呼び出し側の仕事で、ここは `allowed-with-override` に `managerId` と `reason` を載せるだけ。
 *
 * override を持つのは単発の口（`archive_remove` / `DELETE /archive/:id`）だけで、一括の口は
 * `undefined` を渡す（逐語は `grep -Fn -- 'guardArchiveRemoval(context.managers, target.id, undefined' packages/core/src/tools.ts`）:
 * 理由1本で全件を開けると「どの1件をなぜ開けたか」が記録から消える。一括だから速い経路を別に引かない:
 * 引いた瞬間に退避を守る方針が片方の口からだけ消える。
 *
 * `requireContainment: true` のときだけ、保護を `runningManagerOwning`（`archiveIds` 全件）から
 * `runningManagerPinning`（末尾1本）へ狭める。含有の証明（`archive-prune.ts` の `selectArchiveRemovalTargets`）が
 * 前提で、`false` / `undefined` で狭めると証明の無い行を走行中の委譲から奪う。
 * `runningManagerPinning` を持たない像は安全側（広い保護）へ倒す。
 */
export type ArchiveRemovalGuard =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'allowed-with-override'; readonly managerId: string; readonly reason: string }
  | { readonly kind: 'denied'; readonly managerId: string }
  /** `managers` 自体が無い（配線されていない場面）。安全側に倒して拒否する。 */
  | { readonly kind: 'unknown' };

export function guardArchiveRemoval(
  managers: Pick<ManagerPool, 'runningManagerOwning' | 'runningManagerPinning'> | undefined,
  archiveId: string,
  overrideReason: string | undefined,
  requireContainment?: boolean,
): ArchiveRemovalGuard {
  if (managers === undefined) return { kind: 'unknown' };
  // `??` で繋がない: `runningManagerPinning` が `undefined`（末尾に無い）を返したときに
  // `runningManagerOwning` へ fallback すると、狭めた意味が消える。
  const managerId =
    requireContainment === true && managers.runningManagerPinning !== undefined
      ? managers.runningManagerPinning(archiveId)
      : managers.runningManagerOwning(archiveId);
  if (managerId === undefined) return { kind: 'allowed' };
  const reason = overrideReason?.trim();
  if (reason !== undefined && reason.length > 0) {
    return { kind: 'allowed-with-override', managerId, reason };
  }
  return { kind: 'denied', managerId };
}

/**
 * workspace の運用選択。方針であって能力の制限ではないので設定で切り替わる
 * （選ばれなかった分岐を削らない。north_star 禁止2）。
 */
export type WorkspacePolicy =
  | { kind: 'runner-volume' }
  | { kind: 'shared-volume' }
  | { kind: 'git'; repository: string; ref: string }
  /** 理由を必ず持つ: 理由の無い「分からない」は値と同じ（取れない軸に 0 の行を作る）。 */
  | { kind: 'unknown'; reason: string };

/** `ALTEROID_WORKSPACE_KIND` を読む。 */
export const WORKSPACE_KIND_ENV_KEY = 'ALTEROID_WORKSPACE_KIND';
/** `=git` のときだけ要る。 */
export const WORKSPACE_REPOSITORY_ENV_KEY = 'ALTEROID_WORKSPACE_REPOSITORY';
/** `=git` のときの ref。省略時は `main`。 */
export const WORKSPACE_REF_ENV_KEY = 'ALTEROID_WORKSPACE_REF';

/** デーモンからは `/workspace` がボリュームか毎デプロイで消えるのかを知る手段が無い。運用者が明示しない限り `unknown`。 */
const UNVERIFIED_WORKSPACE_REASON =
  '器の workspace がボリュームかどうかを runner が名乗らないので、' +
  '入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。';

/**
 * `ALTEROID_WORKSPACE_PATH` は作らない: `shared-volume` のパスは委譲の `cwd` を使う。別の env に書かせると
 * 実際に作業している場所と食い違いうる。
 * 読めない設定は `runner-volume` へ倒さない: 存在しない永続性を台帳が主張することになる
 * （`schema.ts` の `WorkspaceLocator`）。倒す先は理由つきの `unknown`（行に残るので後から読む人に届く）。
 */
function workspaceLocatorFrom(
  policy: WorkspacePolicy,
  runnerId: string,
  cwd: string,
): WorkspaceLocator {
  switch (policy.kind) {
    case 'runner-volume':
      return { kind: 'runner-volume', runnerId, path: cwd };
    case 'shared-volume':
      return { kind: 'shared-volume', path: cwd };
    case 'git':
      return { kind: 'git', repository: policy.repository, ref: policy.ref };
    case 'unknown':
      return { kind: 'unknown', runnerId, path: cwd, reason: policy.reason };
    default: {
      const exhaustive: never = policy;
      throw new Error(`未知の WorkspacePolicy: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 移送で `runner-volume` を `unknown` へ落とすときの理由。 */
const RELOCATED_WORKSPACE_REASON =
  '別の runner へ移送した。移送で workspace の中身は運ばれていない（元の runner の volume に在った作業は、' +
  '移送先には無い）ので、移送先の volume に残ると言えない。';

/**
 * 別の runner へ移した後の locator。`runner-volume` は `unknown` へ落とす: 移送先へ付け替えると
 * 運ばれていない作業が移送先の volume に在ると主張し、元のまま残すと落ちた器を指し続ける。
 * `shared-volume` / `git` は `runnerId` を持たないので変えない。
 */
function workspaceAfterRelocation(
  workspace: WorkspaceLocator | undefined,
  toRunnerId: string,
): WorkspaceLocator | undefined {
  if (workspace === undefined) return undefined;
  switch (workspace.kind) {
    case 'unknown':
      return { ...workspace, runnerId: toRunnerId };
    case 'runner-volume':
      return {
        kind: 'unknown',
        runnerId: toRunnerId,
        path: workspace.path,
        reason: RELOCATED_WORKSPACE_REASON,
      };
    default:
      return workspace;
  }
}

/** userinfo がアカウント名（`git@` 等）で、秘密ではない慣習の scheme。 */
const WORKSPACE_REPOSITORY_USERNAME_ONLY_PROTOCOLS: ReadonlySet<string> = new Set([
  'ssh:',
  'git+ssh:',
  'ssh+git:',
  'sftp:',
  'git:',
  'rsync:',
]);

/**
 * ssh 系 scheme の **パスワードの無い** userinfo（`ssh://git@host/…`）はアカウント名なので落とさない。
 * URL として読めない形は安全側に倒し、URL の解釈では落とせない資格を字面の伏せ字に任せる。
 */
function redactWorkspaceRepository(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return redactSecretsInText(raw, undefined);
  }
  if (parsed.host === '') return redactSecretsInText(raw, undefined);
  const keepUsername =
    parsed.password === '' && WORKSPACE_REPOSITORY_USERNAME_ONLY_PROTOCOLS.has(parsed.protocol);
  const hasCredential = keepUsername ? false : parsed.username !== '' || parsed.password !== '';
  if (!hasCredential && parsed.search === '' && parsed.hash === '') {
    return redactSecretsInText(raw, undefined);
  }
  if (!keepUsername) parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return redactSecretsInText(parsed.toString(), undefined);
}

export function resolveWorkspacePolicy(env: NodeJS.ProcessEnv = process.env): WorkspacePolicy {
  const kindRaw = env[WORKSPACE_KIND_ENV_KEY];
  const kind = kindRaw === undefined ? '' : kindRaw.trim();

  if (kind.length === 0) {
    return { kind: 'unknown', reason: UNVERIFIED_WORKSPACE_REASON };
  }
  if (kind === 'runner-volume') {
    return { kind: 'runner-volume' };
  }
  if (kind === 'shared-volume') {
    return { kind: 'shared-volume' };
  }
  if (kind === 'git') {
    const repositoryRaw = env[WORKSPACE_REPOSITORY_ENV_KEY];
    const repositoryTrimmed = repositoryRaw === undefined ? '' : repositoryRaw.trim();
    if (repositoryTrimmed.length === 0) {
      return {
        kind: 'unknown',
        reason:
          `${WORKSPACE_KIND_ENV_KEY}=git だが ${WORKSPACE_REPOSITORY_ENV_KEY} が無いので、` +
          '運用選択を決められない。',
      };
    }
    const refRaw = env[WORKSPACE_REF_ENV_KEY];
    const ref = refRaw === undefined ? '' : refRaw.trim();
    const repository = redactWorkspaceRepository(repositoryTrimmed);
    return { kind: 'git', repository, ref: ref.length === 0 ? 'main' : ref };
  }
  return {
    kind: 'unknown',
    reason: `${WORKSPACE_KIND_ENV_KEY}=${kind} は読めない（runner-volume / shared-volume / git のどれか）。`,
  };
}

/** 日誌には書かれず、稼働の地図のメモリへだけ渡る。 */
export type WorkerToolEvent = Extract<RunnerEvent, { type: 'tool_running' | 'tool_end' }>;

/** **どちらも投げない**（失敗は持ち主の側が日誌に残す）。 */
export interface CodexAuthRunnerSync {
  syncRunner(runner: RunnerClient): Promise<void>;
  onRunnerNotice(
    event: Extract<RunnerEvent, { type: 'codex_auth' }>,
    runnerId: string,
    runner: RunnerClient | null,
  ): Promise<void>;
}

export interface ManagerPoolOptions {
  /** **マネージャーのセッションを起こす瞬間に1度だけ読む。** */
  tokenIdentity?: () => { tokenId: string; generation: number; fingerprint?: string } | undefined;
  /** **このプールは回すかどうかを判断しない。** */
  onUsageObservation?: (observation: TokenRotatorObservation) => Promise<void>;
  /**
   * runner は記憶ストアを読めないので、器が作り直されたときに降ろすのはデーモンの責任である。
   * これが無いと、後から上がってきた runner は古いトークンで走るか資格を持たずに走り、
   * その食い違いはマネージャーの側からは見えない。
   */
  syncRunnerToken?: (runner: RunnerClient) => Promise<void>;
  /** **日誌には書かない**。例外は握りつぶす（観測のための口で、イベント処理を止めない）。 */
  onWorkerToolEvent?: (event: WorkerToolEvent) => void;
  stores: Stores;
  post: (event: InboxEvent) => void;
  runners: RunnerRegistry;
  /**
   * **降ろし直しもここを通す。** 更新（`apply`）と同じ列に入れないと、更新の最中に古い本文を読んで
   * 新しい本文を上書きする。
   */
  profile?: ProfileService;
  /** runner は記憶ストアを読めないので、器が作り直されたときに降ろすのはデーモンの責任である。 */
  credentials?: CredentialService;
  /** runner は記憶ストアを読めないので、器が作り直されたときに降ろすのはデーモンの責任である。 */
  mcpServers?: McpServerService;
  /** runner は受けた plugin をメモリにしか持たないので、名乗りのたびに降ろし直すのはデーモンの責任である。 */
  plugins?: PluginDistributionService;
  /** runner は記憶ストアを読めないので、器が作り直されたときに降ろすのはデーモンの責任である。 */
  codexAuth?: CodexAuthRunnerSync;
  /** 期限は時刻そのものが答えを決めるので、渡せないと「猶予の中では奪わない」を確かめる試験が書けない。 */
  now?: () => number;
  /** **能力の上限ではない**（二重実行を止めるための期限であって、仕事の回数・ターン数の制限ではない）。 */
  leaseTtlMs?: number;
  /** `vi.mock('node:crypto')` は使わないので、衝突を再現する試験はここを差し替えるしかない。 */
  generateManagerId?: () => string;
  workspace?: WorkspacePolicy;
  withheldReportFlushMs?: number;
  synthesizedNoticeWindowMs?: number;
  attachmentLimits?: AttachmentLimits;
  outboxFetchFileTimeoutMs?: number;
  outboxFetchTotalTimeoutMs?: number;
}

export function createManagerPool(options: ManagerPoolOptions): ManagerPool {
  return new Pool(options);
}

/** **能力の上限ではなく、混雑を作らないための間隔である。** 頭打ちは、器が長く戻らないときに秒間何度も叩かないため。 */
const REATTACH_RETRY_BASE_MS = 1_000;
const REATTACH_RETRY_MAX_MS = 30_000;

/**
 * `busy` を予約に載せっぱなしにすると、別の契機の resume が延々と続く間、梯子が回り続ける。
 * 数えは **runner 単位の梯子を借りるがジョブ単位** なので、同じ runner の別の委譲の `busy` が梯子を延命しない。
 */
const REATTACH_BUSY_MAX_RETRIES = 5;

/** **能力の上限ではなく、混雑を作らないための間隔である。** 繋がったままの runner へ繋ぎ直しを待たずに挑み直す梯子。 */
const PUSH_RETRY_BASE_MS = 2_000;
const PUSH_RETRY_MAX_MS = 60_000;

/**
 * 既定の `JOURNAL_FOLD_IDLE_GAP_MS`（60秒）は使えない: 挑み直しは `PUSH_RETRY_MAX_MS`（60秒）で頭打ちなので、
 * 定常の空きが60秒を少し超え、毎回「途切れた」と判定されて何も畳まれない。
 */
export const PUSH_FAILURE_FOLD_IDLE_GAP_MS = PUSH_RETRY_MAX_MS * 2;

/** 既定（5分）だと60秒間隔の反復は5件ごとに要約が出て、行数が 1/5 にしかならない。 */
export const PUSH_FAILURE_FOLD_MAX_SPAN_MS = 30 * 60_000;

/**
 * `tools.ts` の `MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS` と同じ値だが共有しない: `tools.ts` が
 * `manager.ts` を import する向きを逆にしないため。実測に基づく値ではない。
 * 待たない（fire-and-forget）のに上限を置くのは、応答が永久に返らないと
 * `#unpushedWorkObservationInFlight` の印が残り、その委譲について以降1本も投げられなくなるため。
 */
const UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS = 5_000;

/** 実測の根拠は無い（「大きく、無限ではない」だけ）。 */
const AUTO_FOLD_SKIP_JOURNAL_TRACKING_LIMIT = 500;

/**
 * **FIFO であって LRU ではない**（既存の鍵への再 `set` は挿入順を動かさない）。
 * `runner-subagent-stop-state.ts` の同名の関数とは共有しない: 同じ形の枝刈りが独立して複数在ってよい。
 */
function pruneOldestEntries<V>(map: Map<string, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * **`unknown[] | null` にしない。** `null` だと「預かっていない」と「読みに行って失敗した」が同じ値になり、
 * 一時的に読めなかっただけの委譲が `lost` で終端して、クローンに存在の否定が届く。
 */
type SessionMaterial =
  | { kind: 'loaded'; entries: unknown[] }
  /** 預かっていない（store が無い / `projectKey` が無い / 引いたが空だった）。 */
  | { kind: 'absent' }
  /** **引きに行って失敗した。** 待てば直りうるので、恒久の結論に変えない。 */
  | { kind: 'unreadable' };

/**
 * **`boolean` にしない。** `false` は「戻る先が無い」の意味で使われ、`send()` はそれを「新しく起こし直すこと」と
 * 報告する。読めなかっただけのときに同じ言葉を出すと、一時を恒久として報告し、起こし直すという誤った行動まで
 * 指示する（続きが失われる）。
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
   * **まだ前の器が握っている。恒久ではない。** `no-session` と混ぜてはいけない: 待てば通る委譲を
   * 新しく起こし直すと同じ仕事が2本になる。
   */
  | 'held-by-lease'
  /**
   * `record.job.cwd` が無く、runner からも `workspacePath` を一度も聞けていない。`workspacePath` の既定値 `''` を
   * そのまま `cwd` にすると runner 側に「cwd の形が不正」として弾かれ、真因がどこにも出ない。
   * `workspacePathKnown` は生成時の `hello()` 1回で決まるので、待っても自然には解けない。
   */
  | 'workspace-path-unknown'
  /**
   * `abort()` が止めたと確かめた委譲に、別の契機が同時に resume を進めていた回。止めた側の判断を優先する。
   * `resumeFailureDetail` は「新しく起こし直すこと」と言わない（止まったままでよい）。**恒久である。**
   * resume を挑むかどうかは `send()` の `!attached` 分岐に任せ、ここでは何も予約しない。
   */
  | 'stopped-meanwhile';

function isSessionScopedEvent(
  event: RunnerEvent,
): event is Extract<RunnerEvent, { type: 'closed' | 'session' | 'report' | 'ask' | 'settled' }> {
  return (
    event.type === 'closed' ||
    event.type === 'session' ||
    event.type === 'report' ||
    event.type === 'ask' ||
    event.type === 'settled'
  );
}

interface ManagerRecord {
  job: Job;
  waiting: RunnerWaiting[];
  attached: boolean;
  /**
   * **メモリだけで持つ**（台帳へは書かない）。`undefined` は「追っていない」であって「世代が無い」ではない。
   * **resume を出している最中**も立てない: 応答を受け取れなかった resume は受理されたか分からないので、
   * 古い値を残して新しいセッションの出来事を捨てる側へ倒さない。
   */
  sessionGeneration?: string;
  /**
   * **プロセス内の像にしか置かない**（`Job` へは書かない）。デーモンを作り直したら観測し直しから始まり、
   * 失っても嘘は残らない（「まだ観測していない」へ戻るだけで、「セッションが在る」と名乗らない）。
   * 10秒ごとの生存確認の観測は `attached` も `status` も動かさず resume も挑まない（10秒ごとに全台へ resume を撃つことになる）。
   */
  sessionMissingSince?: string;
  /** `sessionMissingSince` と対で立ち、対で消える。 */
  sessionMissingKind?: SessionMissingKind;
  /**
   * 「置いた時刻」ではなく「置けたと確かめた時刻」。`start` を投げてから runner が答えるまでの窓に当たった
   * 観測は「まだ載っていない」という正しい答えを返すので、**この時刻より古い観測は使わない**
   * （使うと、たったいま起こした委譲に ⚠ が付く）。
   * **プロセス内の像にしか置かない**。
   */
  runnerSessionSince?: string;
  /**
   * **プロセス内の像にしか置かない**（`Job` へは書かない）。次のポーリング（`ManagerPool#probeTurnEnds`）が
   * 計算し直すので、失っても嘘は残らない。
   */
  turnEndedAt?: string;
  turnEndReason?: string;
  turnEndTail?: string;
  /**
   * **プロセス内の像にしか置かない**（`Job` へは書かない）。次のポーリング（`ManagerPool#probeTurnEnds`）が
   * 計算し直すので、失っても嘘は残らない。
   */
  toolUseStallAt?: string;
  toolUseStallPending?: PendingToolUse[];
  /**
   * `waiting` は「いま待っている」ものしか持たない。それだけで重複を見ると、解けた後に届いた同じ `ask` が
   * 新しい待ちとして積まれ、クローンへ二度目が届く。**重複の抑止であって、経路の短絡ではない**:
   * ここで答えを決めず、知らない確認は全部クローンへ回す。
   */
  asked?: RecentMap<true>;
  /**
   * `asked` と同型。**`event.reportId` が無い回（旧 runner）は載せない**——冪等化を諦める判断で、
   * 落とす判断ではない（`case 'report':` のガード）。
   */
  reported?: RecentMap<true>;
  /**
   * **プロセス内の像にだけ載せる**（`Job` には書かない）。デーモンを作り直したら数え直しから始まる
   * （拒否が続いていればすぐ閾値に届くし、止まっていれば黙るのが正しい）。
   * 溢れたら `onForget` が日誌へ残す（黙って数え直さない）。
   * **層を分けて数える理由**は `ManagerDenial.actor` の doc を見ること（マネージャー自身の拒否と作業者の拒否を同じ数へ畳まない）。
   */
  denied?: RecentMap<number>;
  /** `denied` が上限で忘れた鍵は、ここからも同時に消す（`#deniedOf` の `onForget`。以下の `denied` 鍵の帳面も同じ）。 */
  deniedLastAt?: Map<string, string>;
  /**
   * **HTTP の `/managers` へは流さない。** `apps/daemon/src/openapi.ts` の `managerDenialSchema` はこの3欄を
   * 宣言していないので `.parse()` が黙って落とす（意図した線引き。詳細は `ManagerDenial` の doc）。
   */
  deniedLastReason?: Map<string, DenialReasonSnapshot>;
  /**
   * `renotifyStalledDenials()` の突き合わせ材料。`record.waiting[].requestId` と一致する確認だけがこの拒否自身のもので、
   * 一致しない確認は `waiting_human` でも見送る理由にならない。
   */
  deniedLastRequestId?: Map<string, string>;
  /**
   * `renotifyStalledDenials()` の「拒否の後に進んだか」の判定材料。
   * **`PostToolUseFailure` は見ていない**: 型付きの欄を持たない `note` としてしか届かず、文字列を嗅ぐと
   * `case 'note'` の規則（欄で判定し、文字列で本文を嗅がない）を破る。層は問わない（止まっているかは委譲全体の話）。
   */
  lastToolSettledAt?: string;
  /**
   * **同じ鍵に新しい拒否が来て `deniedLastAt` が進んだら、これは古いエピソードの記録になる**
   * （`deniedAt` の不一致を見て数え直す）。デーモンを作り直したら「まだ知らせていない」から始まる。
   */
  deniedRenotify?: Map<string, DenialRenotifyState>;
  /**
   * `#choosePending` が使う。`requestId` 無しの `decision` が、知らせ直しとは無関係に待っていた確認へ
   * 「待ちが1件ならそこへ当てる」規則で誤って当たらないよう、直近の知らせ直しより前の確認には当てない。
   */
  lastDenialRenotify?: { readonly at: string; readonly key: string };
  /**
   * 呼び出し側へ返すためだけの覚え。`#resume` の返り値が真偽値だと「session_id が無い」と「まだ持ち主が握っている」が
   * 同じ `false` になり、後者は待てば通るのに起こし直させてしまう。プロセス内の像にしか置かない。
   * **`kind` を持つ**: `claimableAt` の有無で見分けると、`ambiguous` と「台帳の書き込み失敗」を同じに扱い、
   * 書き込み失敗でも「`ALTEROID_RUNNER_ID` 等を直すまで解けない」と言ってしまう。
   */
  leaseRefusal?: { detail: string; claimableAt?: number; kind: LeaseRefusalKind };
  /**
   * `#resume()` は応答が返るまで倒れたかどうかを知らないので、呼び出し元が resume より前に組み立てる
   * 「移送の一言」へ直接混ぜられない。その橋渡し。**プロセス内の像にしか置かない**。
   * 倒れなかった回・応答が `cwd` を持たない回（古い runner）は触らない: 「未確認」を前回の通知で埋めない。
   */
  cwdSwapNotice?: { readonly requested: string; readonly actual: string };
  /**
   * living 枝はセッションの env を更新しないので、`#tokenIdentities` は触れるまで空のままである。
   * この印はその空白の理由を `tokenGenerationUnknownReason` へ渡すためだけに在る。**プロセス内の像にしか置かない**。
   */
  reattachedAcrossRestart?: true;
  /**
   * `abort()` が止めたと確かめた回だけ立てる（`not_stopped` / `unknown` では立てない: 確かめていない停止を確定させない）。
   * `abort()` の後に `send()` の resume が成功する順序は、台帳の読み直しでは間に合わない（resume は実 I/O）。
   * 印が立った後に resume 側が `record.attached` / `job.status` を書き換えることはない。**プロセス内の像にしか置かない**。
   */
  stopConfirmedAt?: string;
}

/**
 * **`claimableAt` の有無から推測しない。**
 * - `held` — 時間が経てば自動で引き取れる
 * - `ambiguous` — 時間では解けない。人間が `ALTEROID_RUNNER_ID` 等を直すまで解けない
 * - `persist-failed` — 貸し出しを台帳へ書けなかった。一時的な障害であることが多く、`ALTEROID_RUNNER_ID` の問題ではない
 */
type LeaseRefusalKind = 'held' | 'ambiguous' | 'persist-failed';

/** 生ログは MB 級になりうるので、全行を `JSON.parse` しない。 */
const TURN_END_PROBE_CHARS = 200_000;

const TURN_END_TAIL_EXCERPT = 400;

/**
 * **費用の門であって判定の閾値ではない。** ここで弾かれても「症状ではない」とは言えず（まだ引いていないだけ）、
 * 通っても「症状である」とは言わない（`probeTurnEnd` が改めて計算する）。
 */
const TURN_END_PROBE_QUIET_MS = 10 * 60_000;

const TURN_END_PROBE_BACKOFF_MS = 60_000;

/** 旗が立っている相手のほうを長くする: 生ログの末尾が動かない限り助言は変わらない。 */
const TURN_END_PROBE_BACKOFF_FLAGGED_MS = 5 * 60_000;

/**
 * **判定ではない。** 事実（見つかった行の `timestamp` / `stop_reason` / 本文の末尾）だけを持ち、
 * 「報告が届いていない」「止まっている」という結論は持たない。
 */
export interface TurnEndProbe {
  /** 無ければ `undefined`（古い形式は省略しうる）。 */
  timestamp: string | undefined;
  stopReason: string;
  /** 無ければ空文字。 */
  tail: string;
}

/**
 * **`tools.ts` の `rawAssistantText` と中身はほぼ同じだが、意図的に別関数にしてある。**
 * 統合すると2つの探りが結合し、片方の規則を直したときにもう片方が黙って追随する。
 */
function turnEndBodyOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * **何も切らない・殺さない・止めない純関数**: 呼び出し側が結果で `status` を書き換えたり委譲を abort したりしない。
 *
 * **`tools.ts` の `probeLastAssistantUtterance` を流用しない。** あちらは本文が空の行を飛ばすので、
 * 思考だけ・道具だけの行を読み飛ばして1つ前のターンの `end_turn` まで遡り、働いている最中を終わりと誤る
 * （生ログの再生で `end_turn` と言う68時点のうち37が偽陽性）。こちらは最初に見つかった assistant 行を無条件に答えとする。
 * `stop_reason` が文字列でなければ `undefined`（分からないものを症状に化けさせない）。
 */
export function probeTurnEnd(transcript: string): TurnEndProbe | undefined {
  const truncated = transcript.length > TURN_END_PROBE_CHARS;
  const window = truncated ? transcript.slice(-TURN_END_PROBE_CHARS) : transcript;
  const rawLines = window.split('\n');
  const lines = truncated ? rawLines.slice(1) : rawLines;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; stop_reason?: unknown };
    };
    if (record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;

    // **本文の有無でここを飛ばさない。**
    const stopReason = record.message?.stop_reason;
    if (typeof stopReason !== 'string') return undefined;
    if (stopReason === 'tool_use') return undefined;

    const body = turnEndBodyOf(record.message?.content);
    return {
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      stopReason,
      tail: body.length > TURN_END_TAIL_EXCERPT ? body.slice(-TURN_END_TAIL_EXCERPT) : body,
    };
  }
  return undefined;
}

/**
 * 生ログの値をそのまま写すだけ。`name` は文字列でない形がありうるので `optional`:
 * 「不明」のような文字列を作って埋めない（取れない軸に0の行を作らない）。
 */
export interface PendingToolUse {
  id: string;
  name?: string;
}

/**
 * **判定ではない。時刻の閾値も持たない。** 「止まっている」という結論は持たず、読む側
 * （`tools.ts` の `describeToolUseStall`）が `record.waiting` と突き合わせて出す。
 */
export interface ToolUseStallProbe {
  /** **この値で経過時間を計算しない。** 何分経ったかを判定するのは人間である。 */
  timestamp: string | undefined;
  /** **必ず1件以上**（0件なら `probeToolUseStall` は `undefined` を返す）。 */
  pending: PendingToolUse[];
}

/** **`id` が文字列でないブロックは落とす。** 突き合わせの鍵が無いものを「応答が来ていない」と言うと、鍵の無さが症状に化ける。 */
function toolUsesOf(content: unknown): PendingToolUse[] {
  if (!Array.isArray(content)) return [];
  const found: PendingToolUse[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typed.type !== 'tool_use') continue;
    if (typeof typed.id !== 'string') continue;
    found.push({
      id: typed.id,
      ...(typeof typed.name === 'string' ? { name: typed.name } : {}),
    });
  }
  return found;
}

/**
 * **行の `type` も `isSidechain` も見ない。** 突き合わせは `id` で行うので、絞ると
 * 「応答は在るのに拾えなかった」偽陽性が増える。拾い漏らさない側へ倒す。
 */
function collectToolResultIds(content: unknown, sink: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: unknown; tool_use_id?: unknown };
    if (typed.type !== 'tool_result') continue;
    if (typeof typed.tool_use_id !== 'string') continue;
    sink.add(typed.tool_use_id);
  }
}

/**
 * **何も切らない・殺さない・止めない純関数。** `probeTurnEnd` と同じ行を見て重ならない範囲を担当する
 * ので、2つの探りは同時には立たない。`stop_reason: 'tool_use'` だけでは何も決まらないので、
 * 対応する `tool_result` が無いことまでを事実として返し、`record.waiting` との突き合わせは `describeToolUseStall` が行う。
 *
 * **時刻の閾値を置かない**: 閾値を置くとそれより短い窓の症状が出力から消える。
 *
 * **「道具を回しているなら、その応答を待っているのはデーモンのはず」という前提は、確認が `canUseTool` を通る道具にしか成り立たない。**
 * 既定の `permissionMode: 'auto'` では `Bash`・前景の `Agent`・`WebFetch` などは `canUseTool` を通らず、
 * `record.waiting` が空でも矛盾ではない（ただ実行中）。この関数は生の事実だけを返し、分岐は読む側
 * （`manager-activity.ts` の `classifyManagerActivity`、`isDaemonAnsweredTool`）が持つ。
 *
 * 「前の行」の `tool_result` は別の（済んだ）呼び出しへの応答なので、採用した行より後ろだけを見る。
 */
export function probeToolUseStall(transcript: string): ToolUseStallProbe | undefined {
  const truncated = transcript.length > TURN_END_PROBE_CHARS;
  const window = truncated ? transcript.slice(-TURN_END_PROBE_CHARS) : transcript;
  const rawLines = window.split('\n');
  const lines = truncated ? rawLines.slice(1) : rawLines;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; stop_reason?: unknown };
    };
    if (record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;

    if (record.message?.stop_reason !== 'tool_use') return undefined;

    const pending = toolUsesOf(record.message?.content);
    if (pending.length === 0) return undefined;

    const answered = new Set<string>();
    for (let after = index + 1; after < lines.length; after += 1) {
      const laterLine = lines[after]!.trim();
      if (laterLine.length === 0) continue;
      let laterEntry: unknown;
      try {
        laterEntry = JSON.parse(laterLine);
      } catch {
        continue;
      }
      const later = laterEntry as { message?: { content?: unknown } };
      collectToolResultIds(later.message?.content, answered);
    }

    const unanswered = pending.filter((item) => !answered.has(item.id));
    if (unanswered.length === 0) return undefined;

    return {
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      pending: unanswered,
    };
  }
  return undefined;
}

/** `tools.ts` の `LIST_REPORT_EXCERPT`（240）に揃えるが import しない: `tools.ts` が `manager.ts` を import しているので循環になる。 */
const NOTIFY_REPORT_EXCERPT = 240;

/** `manager_send` の直接の返り値でページングを経由せず、`summary` は自由文なので、ここが伸びると全部そのまま agent へ渡る。 */
const AMBIGUOUS_WAITING_EXCERPT = 400;

const ASKED_MEMORY_LIMIT = 512;

/**
 * `onForget` は最大 `ASKED_MEMORY_LIMIT` 件をまとめて渡しうるので、`ids.join(", ")` をそのまま繋ぐと
 * 件数に比例して伸びるのに上限も省略の合図も持たない列挙になる。
 * 兄弟の `REPORTED_FORGOTTEN_BUDGET` とは締め方が違う（こちらは文字数、あちらは件数）が、設計の判断ではない。
 */
const ASKED_FORGOTTEN_EXCERPT = 400;

/** `report` は「解決」で消える口が無いので `ASKED_MEMORY_LIMIT` と揃える強い理由は無い（実測で偏りが分かったら値だけ分ける）。 */
const REPORTED_MEMORY_LIMIT = 512;

/** 上限も省略の合図も無い列挙にしない: `renderListing` に寄せて、切ったら「何件省いたか」が必ず出るようにする。 */
const REPORTED_FORGOTTEN_BUDGET = 2_000;

/** 道具の名前の種類なので、実際にはまず届かない（届いたら、それ自体が異常である）。 */
const DENIED_TOOL_LIMIT = 64;

/**
 * 1 から始める。拒否の重要度は繰り返し回数と相関せず、一度きりで取り返しのつかない行為ほど繰り返されない
 * ので、3 から数えると件数が 1 で止まって永久に上がらない。
 * 刻み（3倍ごと）は動かさない: 「N 件で N 通」にすると受信箱が埋まりクローンの判断が雑音で鈍る。
 */
const DENIED_ESCALATE_AT = 1;

/**
 * **この合図には答える先が無い。** 分類器・deny 規則の拒否は `canUseTool` を経由しないので `requestId` が生まれず
 * `record.waiting` にも載らないが、`manager_send` は `requestId` 無しの `decision` を、待ちがちょうど1件なら
 * 黙ってその1件へ当てる（`#choosePending`）。答え方を書かないと、同じマネージャーが別に待っている無関係の確認を許可してしまう。
 * 分類器の判定には触らず、既に在る口（追加指示）を指すだけにする。
 * Markdown の記号を散文に混ぜない（識別子だけをバッククォートで包む）。
 */
const DENIAL_REPLY_ROUTE =
  '\n答え方: この拒否には `requestId` が無く、許可として答える口は無い。' +
  '`manager_send` に `decision` を付けて送らないこと' +
  '（`requestId` 無しの `decision` は、このマネージャーが別に待っている確認へ回答として当たりうる）。' +
  '別の形でやり直させるなら、`decision` 無しの追加指示として送る。' +
  '作業者の拒否なら、その作業者へ伝えるようマネージャーに頼む（`manager_send` の届け先はマネージャーである）。';

/**
 * 疑わしい側（上書き）を止める: 引き直しを打ち切って例外にしても `start()` を呼び直せば済むが、
 * 誤って上書きすると走行中の別の委譲の記録が黙って消える（`lease.ts` の `mayClaim` と同じ非対称）。
 * 達するのは注入された発行器が衝突しやすい値しか返さないときだけで、その異常を上書きで隠さない。
 */
const MAX_MANAGER_ID_ATTEMPTS = 5;

const HELLO_WAIT_MS = 5_000;
const HELLO_POLL_MS = 50;

/**
 * **配達の制限ではない。** 溢れて忘れた文言は次に届いたときにもう一度配られる（取りこぼす側ではなく配り直す側へ倒れる）。
 * 忘れたこと自体は `onForget` が日誌へ残す。
 */
const USAGE_NOTICE_MEMORY_LIMIT = 32;

/** **「観測した値」ではなく「配った事実」を持つ器である。** `string`（最後に見た文言）だった頃の壊れ方は `Pool` の `#usageNotices` の doc にある。 */
interface UsageNoticeMemory {
  /** `notice.text` そのもの（言い換える前の SDK の原文）。 */
  delivered: RecentMap<true>;
  /**
   * **次にこの種類を配る1本の本文へ必ず載せて 0 に戻す。** 受信箱しか見ていない読み手には日誌の行が見えないので、
   * 載せないと「畳んだ」という事実が観測から消える。
   */
  folded: number;
  /**
   * **集計専用で、畳みの判定には使わない**（畳み鍵は `(kind, text)`）。`folded` だけだと、同じ managerId が
   * 100 回当たったのか100本が1回ずつ当たったのか見分けがつかない。`folded` と同じタイミングで空へ戻す。
   */
  foldedManagers: Set<string>;
}

/**
 * **在庫（in-memory）であって記録ではない。** デーモンが再起動すると消えるが、`case 'report'` が積む前に必ず
 * `type: 'decision'` の日誌を1件書くので日誌の側は残る。
 */
interface WithheldReportMemory {
  /** 次の本物の報告・`flushWithheldReports()`・`closed` で配って0へ戻る。 */
  count: number;
  firstAt: string;
  /** `flushWithheldReports()` の期限判定はここを見る。 */
  lastAt: string;
  lastText: string;
  breakdown: string;
  /** **`count`（積んだ報告の本数）とは別物で、1つに畳まない。** 前者は配り直しの話、後者は待ち時間の話で、読み手の次の一手が違う。 */
  taskCount: number;
  /**
   * 経過時間の出所にしない（いつから待っているかは `firstAt` だけが持つ）。
   * `#withholdBackgroundReport` はこの欄を持ち越す: 持ち越さないと印が消えて「エピソードにつき1本だけ」が壊れる。
   */
  flushedAt?: string;
}

/**
 * **なぜ30分か。** 背景処理は `pnpm test` で4分・作業者の委譲で10分規模が普通にある。
 * 短いと、正常に完了を待っているだけの積みまで「配っていない」と急かして握り潰しの意味が消える。
 * 長いと、次のターンが本当に来ない回で最終報告相当の知らせが30分近く寝る。
 */
const WITHHELD_REPORT_FLUSH_MS = 30 * 60_000;

/**
 * **配列の長さがそのまま知らせ直しの上限回数（2回）を兼ねる。**
 * 1回目は `ONE_SHOT_ALLOW_TTL_MS`（1回だけの許可の寿命と同じ桁）、2回目は `WITHHELD_REPORT_FLUSH_MS` と同じ値だが、
 * 参照で結びつけない: 別の関心事の期限なので、あちらの env を差し替えてもこちらは動かさない。
 * ここが数えるのは新設した通知の回数であって、道具の実行回数でもターン数でもない（暴走を機械的に止めるものではない）。
 */
const DENIAL_RENOTIFY_DELAYS_MS: readonly number[] = [
  ONE_SHOT_ALLOW_TTL_MS,
  WITHHELD_REPORT_FLUSH_MS,
];

/**
 * `renotifyStalledDenials` の「進んだか」の判定専用。同じ精度・同じタイムゾーン（`toISOString()`）で書かれた
 * 値どうしなので文字列比較が時刻の比較と一致する（`describeDenialFollowUp` と同じ前提）。
 */
function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

/** 30分が妥当かをまだ観測していないので、コード変更＋デプロイを待たずに済むよう口だけ開けてある。既定は動かさない。 */
export const WITHHELD_REPORT_FLUSH_MS_ENV_KEY = 'ALTEROID_WITHHELD_REPORT_FLUSH_MS';

/** **2箇所（数値として読めない／0以下）から呼ぶので定数に寄せる**: 書き写すと片方だけ直る形になる。 */
const WITHHELD_FLUSH_MS_UNREADABLE_WHAT = '握り潰しの配り直しの期限の設定';

/**
 * どの経路でも既定へ倒すが、「置かなかった」（未設定・空）は跡を出さず、「置いたのに読めなかった」
 * （数値でない・0以下）は跡を残す。跡が無いと、置いたのに効いていないことが置いた本人から見えない。
 * 正常な状態にまで鳴らすと跡がノイズで埋まる。
 * `noteDroppedRecord` ではなく `noteUnreadableRecord` を呼ぶ: 前者は「記録できませんでした」と書き、
 * 読み出しの失敗の跡が何が起きたかを取り違えさせる。**値そのものは跡に載せない**（env は器の外から来る任意の文字列）。
 */
export function resolveWithheldReportFlushMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WITHHELD_REPORT_FLUSH_MS_ENV_KEY];
  if (raw === undefined) return WITHHELD_REPORT_FLUSH_MS;
  // **未設定と空は同じ「指定しない」である。** `Number('') === 0` 経由で `parsed <= 0` へ落とすと、
  // 置かなかっただけの人に向かって「読めなかった」と鳴る。
  const trimmed = raw.trim();
  if (trimmed === '') return WITHHELD_REPORT_FLUSH_MS;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    noteUnreadableRecord(
      WITHHELD_FLUSH_MS_UNREADABLE_WHAT,
      `${WITHHELD_REPORT_FLUSH_MS_ENV_KEY} chars=${String(trimmed.length)}`,
      new Error(`数値として読めない。既定の ${String(WITHHELD_REPORT_FLUSH_MS)}ms で走る`),
    );
    return WITHHELD_REPORT_FLUSH_MS;
  }
  if (parsed <= 0) {
    noteUnreadableRecord(
      WITHHELD_FLUSH_MS_UNREADABLE_WHAT,
      `${WITHHELD_REPORT_FLUSH_MS_ENV_KEY} chars=${String(trimmed.length)}`,
      new Error(`0 以下は期限にならない。既定の ${String(WITHHELD_REPORT_FLUSH_MS)}ms で走る`),
    );
    return WITHHELD_REPORT_FLUSH_MS;
  }
  return parsed;
}

const WITHHELD_REPORT_EXCERPT = 240;

/**
 * `Pool` の帳面は真の private field で外から壊れた値を注入できないので、判定だけを外へ出してある。
 * **`lastAt` が読めない（`NaN`）ときは期限切れとして「配る」側へ倒す**: 同じ知らせが1回多く付くのは許容し、
 * 在庫に永久に残って二度と配られないのは許さない。
 */
export function withheldReportOverdue(lastAt: string, now: number, flushMs: number): boolean {
  const parsed = Date.parse(lastAt);
  return Number.isNaN(parsed) || now - parsed >= flushMs;
}

/**
 * **見るのは `firstAt` の1つだけ**: `flushedAt` を経過を測る材料にすると、経過時間の出所が2つになり、どちらを信じるかという問いが生まれる。
 * **`firstAt` が読めない・未来を指している（経過が負）ときは、経過を捏造しない**: 0分のような「それらしい値」を作らず、
 * 読めないことそのものを出力へ書く（取れない軸に0の行を作らない）。
 * `manager-activity.ts` の `formatMinutesAgo` は private で呼べず、日をまたぐ丸めも要らないので別に持つ。
 */
export function describeBackgroundWaitElapsed(firstAt: string, now: number): string {
  const parsed = Date.parse(firstAt);
  if (Number.isNaN(parsed)) {
    return `この委譲は、背景処理待ちのまま（最初の時刻 ${firstAt} が読めないため、経過時間は不明）。`;
  }
  const elapsedMs = now - parsed;
  if (elapsedMs < 0) {
    return (
      `この委譲は、背景処理待ちのまま（最初 ${firstAt} が現在より未来のため、` +
      '経過時間は不明）。'
    );
  }
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const durationText =
    hours < 1 ? `${String(minutes)}分` : `${String(hours)}時間${String(minutes)}分`;
  return `この委譲は${durationText}、背景処理待ちのまま（最初 ${firstAt}）。`;
}

/**
 * **`string` にしてあるのは、`runner-protocol.ts` の `report.synthesized` と同じ語彙を共有するため**:
 * 版のずれで知らない族の名前が届いても型では落ちず、{@link describeSynthesizedNoticeLabel} の未知語フォールバックで吸収する。
 * 日誌の内訳と見出しにだけ使い、畳む判定には使わない（時刻の窓だけで行う）。
 */
type SynthesizedNoticeLabel = string;

/**
 * - `'seen'` — `closed(done)` は報告の後の idle の終わりで、知らせない
 * - `'none'` — 一度も受け取っていない。報告無しで終わった
 * - `'unknown'` — 判定できない。**知らせる側へ倒す**（黙って無音へ倒さない）。
 *   (1) `Job.runnerSessionSince` が無い（この欄を書く前の古い行）——`lastReportAt` が在っても、いまのセッションのものとは言えない
 *   (2) どちらかが日時として読めない（`jobSchema.lastReportAt` は `z.string()` で、形を保証していない）
 *
 * 同じセッションの中で report の後に別のターンが始まり、そのターンだけが report 無しで閉じた回も拾うため、
 * `Job.turnStartedAt` との遅いほうを境にする。
 */
function reportSeenInSession(
  lastReportAt: string | undefined,
  runnerSessionSince: string | undefined,
  turnStartedAt?: string | undefined,
): 'seen' | 'none' | 'unknown' {
  if (lastReportAt === undefined) return 'none';
  // セッションの始まりとターンの始まりの遅いほうを境にする: 同じセッションの2ターン目が report 無しで閉じた回を、1ターン目の report で「受け取った」と読まないため。
  const since = laterIso(runnerSessionSince, turnStartedAt);
  if (since === undefined) return 'unknown';
  const reportMs = Date.parse(lastReportAt);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(reportMs) || Number.isNaN(sinceMs)) return 'unknown';
  return reportMs >= sinceMs ? 'seen' : 'none';
}

/** **網羅ではない**: `report.synthesized` は `z.string()` なので、ここに無い値が届くことがある。 */
const KNOWN_SYNTHESIZED_NOTICE_LABELS: Record<string, string> = {
  rate_limit: '枠の遷移（追い返された／課金枠へ入った）',
  usage_notice: '利用上限の通知',
  closed_failed: 'セッションが落ちた',
  closed_done_silent: 'report を出さないまま閉じた（done）',
  turn_failed: '応答を返さずに終わったターンの報告',
  resume_fallback: '器の入れ替えで前のセッションへ戻れず、生ログから作り直して続けた',
  resume_failed: '器の入れ替えで前のセッションへ戻れず、再開そのものに失敗した',
};

/**
 * **未知の族は素の値をそのまま返す。** 落とさず表示することが「版がずれている」という事実の唯一の跡になる
 * （例外を投げる・既定の1語へ潰すとその跡が消える）。
 */
function describeSynthesizedNoticeLabel(label: SynthesizedNoticeLabel): string {
  return KNOWN_SYNTHESIZED_NOTICE_LABELS[label] ?? label;
}

/**
 * **完全な重複（族も本文もバイト単位で同一）だけ1件へ寄せて数だけ持つ**（情報が失われないから畳んでよい）。
 * **本文が1バイトでも違えば別の断片として残す**（代表を選べない）。
 * **通数そのものは捨てない**: 「4通が3通に減ったのか、1回が3回に増えたのか」を区別する材料になる。
 */
interface SynthesizedNoticeFragment {
  label: SynthesizedNoticeLabel;
  text: string;
  /** 1以上。 */
  count: number;
}

interface SynthesizedNoticeWindow {
  /** **到着順のまま持つ（並べ替えない）。** */
  fragments: SynthesizedNoticeFragment[];
  /** flush で必ず `clearTimeout`。 */
  timer: ReturnType<typeof setTimeout>;
  /**
   * 観測用の記録だけで、畳み込みの鍵・判定・配り方には使わない。
   * 1件だけの窓は「合流しなかった」として日誌へ書かない（0件という値を作らず、行自体を出さない）。
   */
  arrivedAt: number[];
}

/**
 * **「連続するかぎり畳む」ための記憶であって、上限ではない。** 合流窓（既定3000ms）の中の畳み込みは窓が閉じると消えるので、
 * 429 のように同じ失敗が何分も繰り返されると同じ本文が窓の数だけ受信箱へ積まれ、クローンの文脈窓を埋める。
 *
 * **黙らせるのではない。1件目は必ず配る**（枠で落ちたことはクローンが知らなければならない）。消すのは2件目以降の
 * 完全な重複だけで、件数は日誌の1束1行と次に配る `manager_message` の末尾の1行（`#deliver`）に残る。
 * **窓を広げて解く道は採らない**: 広げると無関係な出来事が混ざる。こちらはバイト単位で同一の束だけを扱うので時間の窓が要らない。
 *
 * **実際に読み書きするのは `turn_failed` 単独の束だけ**（{@link isCrossWindowStreakEligible}）。
 * `rate_limit` / `usage_notice` は別の専用の記憶で「配る価値があるか」を判定済みなので、
 * 文字列一致を掛けると状態ベースの判定を上書きして壊れる。
 */
interface SynthesizedNoticeStreak {
  signature: string;
  /** 束の数。 */
  suppressed: number;
  /** **通数**の総和（束の数ではない）。 */
  suppressedArrived: number;
  /** `suppressed === 0` のあいだは持たない。 */
  firstAt?: string;
  lastAt?: string;
}

/**
 * **`count` は入れない。** 入れると「同文が3通の束」と「同文が1通の束」が別物になり、通数が回によって違う枠落ちでは畳めなくなる。
 * 通数は `suppressedArrived` の側で保存する。**正規化も切り詰めもしない**（1バイトでも違えば別のことを言っている側へ倒す）。
 */
export function synthesizedNoticeSignature(
  fragments: readonly SynthesizedNoticeFragment[],
): string {
  return JSON.stringify(fragments.map((fragment) => [fragment.label, fragment.text]));
}

/**
 * **窓をまたいだ抑制の対象を `turn_failed` 単独の束に絞る。**
 * `rate_limit` と `usage_notice` は専用の記憶（`usageTransitionOf` / `#usageNoticeMemoryOf().delivered`）で
 * 状態に基づいて「配る価値があるか」を判定済みで、文字列一致の抑制を重ねると、文字列は同一でも
 * 意味的には新しい出来事（rejected → allowed → rejected）を握りつぶして壊れる。
 * `resume_fallback` / `resume_failed` / `closed_failed` は広げない: 窓をまたいだ抑制が要るという実測が無く、
 * 要ると分かってから広げる。混ざった束も対象にしない。
 */
function isCrossWindowStreakEligible(fragments: readonly SynthesizedNoticeFragment[]): boolean {
  return fragments.length === 1 && fragments[0]?.label === 'turn_failed';
}

/**
 * 広ければ良い値ではない: 広すぎると無関係な束を1件にまとめて情報が混ざる（狭すぎは畳めないだけで情報は消えない）。
 * 窓の役目は一度に吐かれた束を捕まえることで、離れて届いたものを繋ぐことではない。
 * 実測の最大間隔に合わせて数十秒の桁へ広げない。既定は実測の最大の列（1,682ms）に余裕を持たせた値で、
 * 原理から出た値ではない（だから環境変数で差し替えられる）。窓が割れても畳める件数が減るだけでデータは失われない。
 * 「最大でこれだけ待つ」であって「この間隔で配る」ではない（`#emit` が窓の満了を待たずに配り切る）。
 */
const SYNTHESIZED_NOTICE_WINDOW_MS = 3_000;

export const SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY = 'ALTEROID_SYNTHESIZED_NOTICE_WINDOW_MS';

/** 2箇所（数値として読めない／0以下）から呼ぶので定数に寄せる。 */
const SYNTHESIZED_NOTICE_WINDOW_MS_UNREADABLE_WHAT = '機構合成の知らせをまとめる窓の長さの設定';

/** `resolveWithheldReportFlushMs` と同じ形（跡の出し方・値そのものを載せないことも同じ理由）。 */
export function resolveSynthesizedNoticeWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY];
  if (raw === undefined) return SYNTHESIZED_NOTICE_WINDOW_MS;
  const trimmed = raw.trim();
  if (trimmed === '') return SYNTHESIZED_NOTICE_WINDOW_MS;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    noteUnreadableRecord(
      SYNTHESIZED_NOTICE_WINDOW_MS_UNREADABLE_WHAT,
      `${SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY} chars=${String(trimmed.length)}`,
      new Error(`数値として読めない。既定の ${String(SYNTHESIZED_NOTICE_WINDOW_MS)}ms で走る`),
    );
    return SYNTHESIZED_NOTICE_WINDOW_MS;
  }
  if (parsed <= 0) {
    noteUnreadableRecord(
      SYNTHESIZED_NOTICE_WINDOW_MS_UNREADABLE_WHAT,
      `${SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY} chars=${String(trimmed.length)}`,
      new Error(`0 以下は期限にならない。既定の ${String(SYNTHESIZED_NOTICE_WINDOW_MS)}ms で走る`),
    );
    return SYNTHESIZED_NOTICE_WINDOW_MS;
  }
  // **上限で挟む。運用の上限ではなく、タイマーの仕様の範囲を守るためのもの**——`setTimeout` は
  // 2^31-1 ms を超える値を 1ms へ倒し、窓が効かなくなる。
  return Math.min(MAX_RESCUE_INTERVAL_MS, parsed);
}

/**
 * **要約も間引きもしない。ただ1つの例外は完全な重複**（本文が1バイトでも違えば寄せない）。族ごとに断片は違うことを
 * 答えているので、全文を到着順のまま連結する。
 * **1件のときは前置きを付けない**（いちばん多い「1件だけ」の本文に断り書きが載る形にしない。`clone.ts` の `#mergedHumanBatch` と同じ）。
 * 到着順は実測であって保証ではないので、断片ごとに `label` を見出しに出して境目を見つけられるようにする。
 */
export function mergeSynthesizedNoticeFragments(fragments: readonly SynthesizedNoticeFragment[]): {
  text: string;
  breakdown: string;
  /** **実際に届いた通数**（断片の本数ではない）。 */
  arrived: number;
} {
  const arrived = fragments.reduce((sum, fragment) => sum + fragment.count, 0);
  const describe = (fragment: SynthesizedNoticeFragment): string =>
    `${describeSynthesizedNoticeLabel(fragment.label)}${
      fragment.count > 1 ? ` ×${String(fragment.count)}` : ''
    }`;
  const first = fragments[0];
  // 断片の本数ではなく通数で見る: 同文が3通なら断片は1本だが、3通あったことは情報である。
  if (arrived <= 1) {
    return {
      text: first?.text ?? '',
      breakdown: first === undefined ? '' : describe(first),
      arrived,
    };
  }
  const breakdown = fragments.map(describe).join('、');
  const folded = arrived - fragments.length;
  const header =
    `（1つの出来事について ${String(arrived)} 件の知らせをまとめた` +
    (folded === 0 ? '' : `。うち同文の重複 ${String(folded)} 件は数だけ残して畳んだ`) +
    '）';
  const body = fragments
    .map(
      (fragment, i) =>
        `--- ${String(i + 1)}/${String(fragments.length)}（${describe(fragment)}） ---\n${fragment.text}`,
    )
    .join('\n\n');
  return { text: `${header}\n\n${body}`, breakdown, arrived };
}

/**
 * **1件しか無いときは `undefined` を返す**: 合流しなかったことは0件という値ではなく行が無いことで表す（取れない軸に0の行を作らない）。
 * **畳み込みの判定にも配り方にも使わない**（日誌へ書く計器だけの入力）。
 */
export function synthesizedNoticeArrivalIntervals(
  arrivedAt: readonly number[],
): { count: number; maxIntervalMs: number; minIntervalMs: number } | undefined {
  if (arrivedAt.length <= 1) return undefined;
  let maxIntervalMs = -Infinity;
  let minIntervalMs = Infinity;
  for (let i = 1; i < arrivedAt.length; i += 1) {
    const interval = (arrivedAt[i] ?? 0) - (arrivedAt[i - 1] ?? 0);
    if (interval > maxIntervalMs) maxIntervalMs = interval;
    if (interval < minIntervalMs) minIntervalMs = interval;
  }
  return { count: arrivedAt.length, maxIntervalMs, minIntervalMs };
}

/**
 * **`.catch(() => undefined)` で握り潰さない。** 「頼まれていない」「聞けなかった」「聞いたが失敗した」を
 * 同じ `undefined` へ潰さないよう `probe` を必ず併せて返し、呼び出し側が判断を省略できないようにする。
 */
async function probeRunnerFingerprint<T>(
  client: RunnerClient | undefined,
  fingerprints: boolean | undefined,
  fetch: (client: RunnerClient) => Promise<T>,
): Promise<{ value: T | undefined; probe: RunnerFingerprintProbe | undefined }> {
  if (!fingerprints) return { value: undefined, probe: undefined };
  if (client === undefined) return { value: undefined, probe: { status: 'unheard' } };
  try {
    return { value: await fetch(client), probe: { status: 'asked' } };
  } catch (error) {
    return { value: undefined, probe: { status: 'failed', error: reasonOf(error) } };
  }
}

/**
 * **`probeRunnerFingerprint` と分けたのは `unsupported` という4つ目の状態を持つから**: 呼べる口が無いことと、
 * 呼んだが RPC が落ちたことを混ぜない。
 */
async function probeRunnerMcpServersFingerprint(
  client: RunnerClient | undefined,
  fingerprints: boolean | undefined,
): Promise<{
  value: RunnerMcpServersFingerprint | undefined;
  probe: RunnerMcpServersProbe | undefined;
}> {
  if (!fingerprints) return { value: undefined, probe: undefined };
  if (client === undefined) return { value: undefined, probe: { status: 'unheard' } };
  if (client.mcpServers === undefined)
    return { value: undefined, probe: { status: 'unsupported' } };
  try {
    return { value: await client.mcpServers(), probe: { status: 'asked' } };
  } catch (error) {
    return { value: undefined, probe: { status: 'failed', error: reasonOf(error) } };
  }
}

/** `.catch(() => undefined)` で「繋がっていない」「失敗した」「口を持たない古い runner」を同じ `undefined` に潰さない。 */
async function probeRunnerResources(
  client: RunnerClient | undefined,
  resources: boolean | undefined,
): Promise<{
  value: RunnerPlacementResources | undefined;
  probe: RunnerResourcesProbe | undefined;
}> {
  if (!resources) return { value: undefined, probe: undefined };
  if (client === undefined) return { value: undefined, probe: { status: 'unheard' } };
  if (client.resources === undefined) return { value: undefined, probe: { status: 'unsupported' } };
  try {
    return { value: (await client.resources()) ?? undefined, probe: { status: 'asked' } };
  } catch (error) {
    return { value: undefined, probe: { status: 'failed', error: reasonOf(error) } };
  }
}

/** 台帳の全委譲を読むので毎分は撃たない。 */
const RESCUE_SWEEP_INTERVAL_MS = 10 * 60_000;
/** HTTP の期限 60 秒の内側。 */
const RESCUE_DELETE_DEADLINE_MS = 55_000;
const RESCUE_SWEEP_MAX_DELETES = 20;
const RESCUE_SWEEP_BUDGET_MS = 5 * 60_000;
const RESCUE_REMOVAL_REASON_JOURNAL: Record<RescueRemovalReason, string> = {
  landed: '内容がもう origin の枝に入っているため',
  done: '委譲が done のまま猶予（7日）を過ぎたため',
  failed: '委譲が failed のまま猶予（14日）を過ぎたため',
  stopped: '委譲が stopped のまま猶予（14日）を過ぎたため',
};

/** `work` が拒否で終わっても true（失敗は別の経路が跡を残す）。**待ちのタイマーは必ず畳む**（残すとプロセスが終わらない）。 */
async function settledWithin(work: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (work === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true as const,
        () => true as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class Pool implements ManagerPool {
  readonly #stores: Stores;
  readonly #post: (event: InboxEvent) => void;
  readonly #runners: RunnerRegistry;
  readonly #profile: ProfileService | undefined;
  readonly #credentials: CredentialService | undefined;
  readonly #mcpServers: McpServerService | undefined;
  readonly #codexAuth: CodexAuthRunnerSync | undefined;
  /** **挑み直しの予約から外すためだけに持つ**（`#settlePushRetry`）。名乗り直しのたびに `#pushMcpServers` がもう一度試す。 */
  readonly #mcpServersUnsupported = new Set<string>();
  readonly #plugins: PluginDistributionService | undefined;
  readonly #pluginsUnsupported = new Set<string>();
  readonly #records = new Map<string, ManagerRecord>();
  /** **器の時計を直に読まない**（時計を渡せないと「猶予の中では奪わない」を確かめる試験が書けない）。 */
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  /** 構築時に一度だけ確定し、以後 `process.env` を読み直さない（`#leaseTtlMs` と同じ形）。 */
  readonly #withheldReportFlushMs: number;
  /** 構築時に一度だけ確定し、以後 `process.env` を読み直さない。 */
  readonly #synthesizedNoticeWindowMs: number;
  /** **器の乱数を直に読まない**（テストが衝突を再現できるようにする。`#now` と同じ理由）。 */
  readonly #generateManagerId: () => string;
  /** **`start` のたびに `process.env` を読み直さない**: 起動時に1度だけ解決して保持する。 */
  readonly #workspace: WorkspacePolicy;
  /**
   * **鍵は「トークンの身元 × 枠の種類」である**（{@link rateLimitMemoryKey}）。「アカウント単位だからマネージャーに紐づけない」
   * と鍵を `kind` だけにすると、トークンのプールの別々のアカウントの事実が同じ欄を踏み合う。
   * 同じトークンで走る委譲は何本在っても同じ欄を共有する。
   * **揮発する**（書き手は `case 'rate_limit'` だけで、probe は書かない）ので、デーモンが入れ替わると
   * 「もうクローンへ知らせた」という記憶は消える。そこは塞いでいない（塞ぐなら台帳への写しが要る）。
   */
  readonly #tokenIdentity:
    (() => { tokenId: string; generation: number; fingerprint?: string } | undefined) | undefined;
  readonly #syncRunnerToken: ((runner: RunnerClient) => Promise<void>) | undefined;
  readonly #onWorkerToolEvent: ((event: WorkerToolEvent) => void) | undefined;
  readonly #onUsageObservation:
    ((observation: TokenRotatorObservation) => Promise<void>) | undefined;
  readonly #rateLimits = new Map<string, RateLimitFacts>();
  /**
   * `lastManagerId` はこの壁の遷移を最後に `#journal` へ書いた managerId。同じ managerId の連打は「跨いだ」に数えない
   * （そちらは {@link Pool.#rateLimitJournalFoldFor} が間引く）。
   * **畳むたびに1行書かない**: 同じ壁に短い間隔で何度も当たる状況を「マネージャーの数」という軸で作り直してしまうので、
   * 次の遷移が定まった回に `folded` を1行にまとめて吐き出す。
   * 集計専用で、`usageTransitionOf` の判定にも配る本文にも使わない。
   */
  readonly #rateLimitCrossFold = new Map<string, { lastManagerId: string; folded: Set<string> }>();
  /**
   * **本数が前回と同じなら書かない**（`list()` は毎ターンの状況の節・日報などからも呼ばれ、書くと膨らむ）。
   * 0本になった runnerId は外す（0本の行は書かない: 取れない軸に0の行を作らない）。
   * `isLive()` の返り値にも `status` の遷移にも触れない、測るだけの段。
   */
  readonly #vanishedRunnerGaugeLastCount = new Map<string, number>();
  /**
   * **鍵が無いことは「まだ名乗りを受けていない」、空集合は「名乗ったが何も持たない（旧い runner）」**
   * ——どちらも能力を持たないものとして扱う。
   */
  readonly #runnerCapabilities = new Map<string, ReadonlySet<string>>();
  /** どちらも送らない旧い runner の hello では鍵を消す（持ち越さない）。 */
  readonly #runnerModels = new Map<string, { manager?: string; worker?: string }>();
  /** 名乗らない旧い runner は持たない。 */
  readonly #runnerAnthropicRoutes = new Map<string, readonly string[]>();
  /** 名乗らない器は持たない。 */
  readonly #runnerAttachmentBodyLimits = new Map<string, number>();
  /** 名乗らない器は持たない。 */
  readonly #runnerManagerPeers = new Map<string, readonly RunnerManagerPeer[]>();
  /** 名乗らない器は持たない。 */
  readonly #runnerManagerPeersClosed = new Map<string, readonly RunnerManagerPeerClosed[]>();
  /**
   * `#rateLimits` はアカウント単位の事実で、誰が止まったかを言わない。鍵が通る状態へ戻ったときに起こし直す相手を決めるには、
   * どの委譲がそれで止まったかが要る。
   * **台帳（`Job.usageStoppedAt`）にも写しを持つ**: 「揮発してよい」とすると、デーモンが入れ替わった後の
   * `done` / `failed` / `lost` の委譲は、クローンが気づいて `manager_send` で起こさない限り次の鍵の回転でも二度と拾われない
   * （`#restoreJobs` の続きへ戻す対象は `running` / `waiting_human` だけ）。`Set` が真の参照で、台帳側はデーモンの寿命を跨ぐための写し。
   * 下ろす箇所（`#clearUsageStoppedMark`）は両方を同じタイミングで下ろす。
   */
  readonly #usageStopped = new Set<string>();
  /**
   * **「鍵が通る状態に戻った」と言われた時点でまだ走っていた委譲**の借り。
   * 鍵を回す契機はたいていその委譲自身の `usage_notice` で、回し手が `resumeStoppedByUsage()` を呼ぶ瞬間には
   * まだ `report` が届いていないことがあり、そこで印を捨てると次の契機が来ずその委譲は永久に止まる。
   * 回った時点で古い鍵で走っていた委譲はこれから枠に落ちうるので、走っているものは全部借りに載せ、枠で終わったものだけを起こす。
   * ターンが終われば必ず消える。
   */
  readonly #usageWakeOwed = new Set<string>();
  /**
   * `runners()` が `options.resources` 付きで呼ばれ、`resources` が実際に返ってきたときだけ書く
   * （もう1つの由来 `#runners.entries()` は Pool 側で二重に持たない）。
   * `pendingEvents` が `undefined` のときは書かない: 0で埋めると「滞留0」と「観測できていない」の区別が消える。
   * **揮発してよい。**
   */
  readonly #runnerBacklog = new Map<string, RunnerBacklogSnapshot>();
  /**
   * **観測のたびに読み直さない。** 読み直すと、回した後に届いた「前のセッションの観測」が新しい身元を名乗り、
   * 世代の照合がそのまま素通しになる（5本のマネージャーが同時に当たった回にプールを5個消費する、というこの照合が存在する理由そのもの）。
   * **記録（`#records`）へ足さずに別の箱にしてあるのは、`#records.set` が5箇所あるから**: 1箇所忘れるとそのマネージャーの
   * 観測だけが身元を失い、それは「回りすぎる」形で出るのでテストでは気づきにくい。
   * 「この委譲が抱えている鍵の世代」の材料にもなるが、env の直接観測ではない（daemon は runner の子プロセスの env を覗けない）。
   * ターンの境界に一度も達しないまま古い鍵で走り続ける委譲はここも古いままで、それは欠陥ではなくこの欄の存在理由そのもの。
   */
  readonly #tokenIdentities = new Map<string, { tokenId: string; generation: number }>();
  /**
   * 429の文言の resets 時刻をプールの各鍵の cooldownUntil と突き合わせた結果（{@link ManagerSummary.resetTimeSkewMatch}）。
   * `#tokenIdentities` とは別の材料源（`reached` のたびに DB を読み直す）なので、あちらが空でも埋まりうる。
   * 枠で止まった印と寿命を揃えて下ろす: 古い判定が次の当たりに貼り付かないように。
   * 台帳には写さない: 起こし直す対象を覚える印ではなく計器で、次の `reached` で作り直せる。
   */
  readonly #resetTimeSkewMatches = new Map<string, NoticeResetMatch>();
  /**
   * 種類ごとの、もうクローンへ配った上限の文言と、配らずに畳んだ件数。
   * 「最後に見た文言」ではなく「配った文言の集合」を覚える: 文言が2通り交互に届くと（A→B→A→B）
   * 毎回「違う」と判定されて、クローンのターンが1本ずつ焼かれる。
   * 畳んだ分は黙って消さず、日誌へ1件ずつ残し、件数は次に配る本文に載せる（{@link UsageNoticeMemory.folded}）。
   */
  readonly #usageNotices = new Map<string, UsageNoticeMemory>();
  /**
   * 握り潰した「背景処理の完了待ちで畳んだ報告」の在庫（{@link WithheldReportMemory}）。
   * `#emit()` が次に配る `text` の末尾へ1行足して空にする: 日誌は引きに行かないと気づけず、
   * 握り潰しすぎて本物の報告を消していないかをクローンが確かめる手段が要る。
   */
  readonly #withheldReports = new Map<string, WithheldReportMemory>();
  /**
   * 機構が合成した知らせの合流窓（{@link SynthesizedNoticeWindow}）。`#withheldReports` とは別物:
   * あちらは時間の上限まで保持する在庫、こちらは短い窓だけ保持して必ず1本にまとめて配る。
   * `#emit()` は呼ばれるたびに全 managerId ぶんを先に flush する（`docs/architecture.md`「順序は並べ替えない」）:
   * 畳めない出来事が先に受信箱へ入って到着順が崩れるのを防ぐ。
   */
  readonly #synthesizedNotices = new Map<string, SynthesizedNoticeWindow>();
  /**
   * 窓をまたいで同文を畳むための、もう配った束の署名（{@link SynthesizedNoticeStreak}）。
   * 窓が閉じても消えず、別の `manager_message` を配った時点で消える（`#deliver`）。
   * 委譲1本につき1件で、終端すれば `#retire()` が外すので上限が要らない。タイマーは持たない。
   */
  readonly #synthesizedNoticeStreaks = new Map<string, SynthesizedNoticeStreak>();
  /**
   * `#observeUnpushedWorkOnce` の多重投げ止め。トリガー（`report` 終わり・`git push` 検出）を問わず
   * 1つの Set を共有する: 待たずに投げるので、短い間隔で続くと runner への往復が同じ委譲へ積み上がる。
   * 揮発してよい（1本ずつを守るだけの印で、台帳に写す状態ではない）。
   */
  readonly #unpushedWorkObservationInFlight = new Set<string>();
  /**
   * 枠の遷移を日誌へ書くときの畳み込み（{@link JournalFoldWindow}）。受信箱の畳み
   * （{@link SynthesizedNoticeStreak}）とは別物で、日誌の行だけを畳み、配る側の判定は変えない。
   * managerId ごとに1本持つ: 窓を共有すると別の委譲の合図が交互に来て連なりが切れ、どちらも畳まれない。
   * 終端すれば `#retire()` が畳み残しを吐き出してから外す。
   */
  readonly #rateLimitJournalFolds = new Map<string, JournalFoldWindow>();
  /**
   * `JournalFoldWindow`（時間窓）は使わない: 契機の間隔に保証が無く、時間窓に意味のある長さを与えられない。
   * **`Job.updatedAt` ではなく `lastReportAt` を使う**: 安全弁自身が呼ぶ `unpushedWork()` → `#persist()` が
   * `updatedAt` を進めるので、2回目の評価で必ず「変わった」と誤判定する。
   */
  readonly #autoFoldSkipJournalWritten = new Map<
    string,
    { readonly lastReportAt: string | undefined; readonly reasonKey: string }
  >();
  /**
   * `runnerId` 単位にしない: 同じ runner 上の別の候補まで待たせ、無関係な委譲の畳みが遅れる。
   * 重なった回は黙って飛ばし（`'skipped-concurrent'`）、日誌は積まない: 状態が読めないのではなく他方が判定中なだけで、
   * 「畳まない側へ倒す」理由には数えない。
   * `#autoFoldOne` の「競合の再確認」は判定から `abort()` までの間しか見ておらず、並行する2実行は塞げない。
   */
  readonly #autoFoldInFlight = new Set<string>();
  #restoring: Promise<void> | null = null;
  /**
   * **落とさずに待たせる。** 「走っているから今回は要らない」と捨てると、捨てた回に
   * しか現れなかった委譲（直前に台帳へ書かれた分）が誰にも拾われない。
   */
  #restoreQueue: Promise<void> = Promise.resolve();
  readonly #reattaching = new Set<string>();
  /**
   * `#connections` とは別に持つ: `#reattach` が直接書き換えると、`#connectTo` 自身の失敗時の後始末
   * （`this.#connections.delete(runner)`）が誰の Promise かを見ずに消し、新しく置いた分を古い接続の失敗が巻き添えで消しうる。
   */
  readonly #reattachPushes = new Map<string, Promise<void>>();
  /** **捨てずに、終わってからもう一度回す。** */
  readonly #reattachAgain = new Set<string>();
  readonly #reattachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reattachDelays = new Map<string, number>();
  readonly #reattachBusyRetries = new Map<string, number>();
  readonly #resuming = new Set<string>();
  /**
   * 永続化しない: 試すのを止める印ではなく（断った runner も `hello` のたびに試される）、
   * 再起動後に候補を1巡し直すのは妥当で、無限には試さない。
   */
  readonly #relocationRefusals = new Map<string, Set<string>>();
  /**
   * `case 'closed'` の「移った後の古い出来事を捨てる」判定は `job.runnerId` が移送先へ書き換わるまで効かず、
   * その窓に元の runner の遅れた `closed(lost)` が届くと台帳が `lost` になり、移送先が persist されない。
   * `#resuming` を流用しない: 移送先を知る材料が無い。
   */
  readonly #relocatingTo = new Map<string, string>();
  /**
   * `#relocatingTo` に同じ runnerId を立てない: あちらは受理されたら処理し直し・受理されなければ捨てるが、
   * 同じ runner への復帰ではその向きが逆（受理されたら古いセッションの `closed` を捨て、失敗したら `lost` にする）で、
   * 同じ値を立てると失敗した回の `closed(lost)` を捨てる。預かる列と閉じ方だけを共有する。
   *
   * 預かるのは `closed` と `report` だけ（`session` / `ask` / `settled` は預けない）: それらは預けて遅らせても得るものが無く、
   * 受理の後まで遅らせると新しいセッションの `ask` を待たせる。`closed` には世代の識別子が無いので、窓の間に届いたものは古い世代と読む。
   * `report` を預ける理由: その場で処理すると `lastReportAt` が resume の応答の前の時刻になり、
   * あとの `closed(done)` で「このセッションで report を受け取っていない」と誤る。
   */
  readonly #sameRunnerResumeWindow = new Map<string, string>();
  /**
   * 捨てずに預かる: 移送が受理されれば古い世代として日誌にだけ残し、失敗したなら（元の runner の出来事は事実のまま）
   * 届いた順に `#onEvent` で処理し直す。
   */
  readonly #deferredEvents = new Map<
    string,
    {
      event: Extract<RunnerEvent, { type: 'closed' | 'session' | 'report' | 'ask' | 'settled' }>;
      fromRunnerId: string;
    }[]
  >();
  readonly #resumedIntoLiveProcess = new Set<string>();
  /**
   * `retry` は runner 単位、この判定はジョブ単位: 覚えておかないと「挑み直さない」と決めたジョブが毎回巻き込まれて再送され、
   * 同じ障害通知がクローンの受信箱に積み上がる。
   * 人間とクローンの明示的な経路は塞がない（`manager_send` の resume はここを見ない）。
   */
  readonly #unresumable = new Set<string>();
  /**
   * `record.leaseRefusal`（ジョブ単位）ではなく `runnerId` 単位で持つ: 併存の検出は `#claimForResume` と、
   * `record` に触れずに抜ける `#reattach` の早期検出の2箇所にあり、後者が見つけた併存は `#claimForResume` に届かず
   * 「解けた」を言う機会が無いまま残る。1つの状態にすれば、どちらの経路でも「入った」「解けた」が1回ずつ出る。
   * 「解けた」を出さないと、併存が続いているのか解けたのか、受信箱の沈黙からは区別できない。
   */
  readonly #ambiguousRunnersNotified = new Set<string>();
  /** 弱参照なのは、名簿から外れた runner をここが握り続けないため。 */
  readonly #connections = new WeakMap<RunnerClient, Promise<void>>();
  readonly #pushHealth = new Map<string, RunnerPushHealth>();
  /** 消さない: 器が入れ替わっても次の `session` が上書きし、`at` が観測の古さを名乗る。 */
  readonly #pluginLoad = new Map<string, RunnerPluginLoadObservation>();
  readonly #pluginLoadDigests = new Map<string, string>();
  /** `#reattachTimers` とは別: あちらは繋ぎ直し（`hello` を待つ）で、こちらは繋がったままの runner へ自分から挑み直す。 */
  readonly #pushRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #unsubscribeDirectPushes: (() => void)[] = [];
  readonly #pushRetryDelays = new Map<string, number>();
  readonly #pushFailureFolds = new Map<string, JournalFoldWindow>();
  /** 費用の門のバックオフにしか使わない: ここに載ったこと自体は「症状である」を意味しない。 */
  readonly #turnEndProbedAt = new Map<string, number>();
  readonly #unsubscribe: () => void;
  #stopped = false;
  readonly #eventsInFlight = new Set<Promise<unknown>>();

  /**
   * 後から届いた同じ委譲の `settled` / `closed` などはこれが終わるまで処理を始めない:
   * `#onEvent` は並行に走るので、さもないと後続が報告を追い越し、クローンへは「終わった」の後に報告が届く。
   */
  readonly #reportFetchGates = new Map<string, Promise<void>>();
  readonly #attachmentLimits: AttachmentLimits | undefined;
  readonly #outboxFetchFileTimeoutMs: number | undefined;
  readonly #outboxFetchTotalTimeoutMs: number | undefined;

  readonly #usageOrder = new UsageRecordOrder();

  /** 名乗っていない runner（旧 runner）は `stop()` が一切待たない。新しい器の `hello` が来たら消す（古い名乗りで新しい器を待たない）。 */
  readonly #farewellRunners = new Set<string>();
  #rescueSweeping = false;
  #rescueSweptAt: number | undefined;

  constructor({
    stores,
    post,
    runners,
    profile,
    credentials,
    mcpServers,
    plugins,
    codexAuth,
    now,
    leaseTtlMs,
    withheldReportFlushMs,
    synthesizedNoticeWindowMs,
    generateManagerId,
    tokenIdentity,
    onUsageObservation,
    syncRunnerToken,
    onWorkerToolEvent,
    workspace,
    attachmentLimits,
    outboxFetchFileTimeoutMs,
    outboxFetchTotalTimeoutMs,
  }: ManagerPoolOptions) {
    this.#attachmentLimits = attachmentLimits;
    this.#outboxFetchFileTimeoutMs = outboxFetchFileTimeoutMs;
    this.#outboxFetchTotalTimeoutMs = outboxFetchTotalTimeoutMs;
    this.#onWorkerToolEvent = onWorkerToolEvent;
    this.#stores = stores;
    this.#post = post;
    this.#runners = runners;
    this.#profile = profile;
    this.#credentials = credentials;
    this.#mcpServers = mcpServers;
    this.#plugins = plugins;
    this.#codexAuth = codexAuth;
    for (const unsubscribe of [
      profile?.onPushed?.((results) => this.#recordDirectPushResults('profile', results)),
      mcpServers?.onPushed?.((results) => this.#recordDirectPushResults('mcpServers', results)),
      credentials?.onPushed?.((results) => this.#recordDirectPushResults('credentials', results)),
      plugins?.onPushed?.((results) => this.#recordDirectPushResults('plugins', results)),
    ]) {
      if (unsubscribe !== undefined) this.#unsubscribeDirectPushes.push(unsubscribe);
    }
    this.#now = now ?? (() => Date.now());
    this.#leaseTtlMs = leaseTtlMs ?? LEASE_TTL_MS;
    this.#withheldReportFlushMs = withheldReportFlushMs ?? resolveWithheldReportFlushMs();
    this.#synthesizedNoticeWindowMs =
      synthesizedNoticeWindowMs ?? resolveSynthesizedNoticeWindowMs();
    this.#generateManagerId = generateManagerId ?? (() => `mgr-${randomUUID()}`);
    this.#workspace = workspace ?? resolveWorkspacePolicy();
    this.#tokenIdentity = tokenIdentity;
    this.#onUsageObservation = onUsageObservation;
    this.#syncRunnerToken = syncRunnerToken;
    // 起動時にしか受け口を開かないと、後から名簿に載った runner は永久に無言のままになる。
    this.#unsubscribe = runners.subscribe((runner) => {
      if (this.#stopped) return;
      void this.#connectTo(runner).catch(() => undefined);
    });
  }

  // -------------------------------------------------------------------------
  // 委譲
  // -------------------------------------------------------------------------

  /**
   * `#records` にしか照合しない（台帳 `#stores.jobs` は引かない）: 台帳読みを足すと、台帳が読めないときに
   * 新規の委譲そのものが起こせなくなる。終わって `#records` から外れた id・台帳にしか残っていない id との衝突は検出しない。
   * 他の `#records.set`（復元経路）には同じ検出を置かない: 新しい乱数ではなく既存の `job.id` を使うので、種類の違う異常である。
   */
  #claimManagerId(): string {
    for (let attempt = 1; attempt <= MAX_MANAGER_ID_ATTEMPTS; attempt++) {
      const candidate = this.#generateManagerId();
      if (!this.#records.has(candidate)) return candidate;
      // 上書きしない。`noteDroppedRecord` を流用しない: あれは「記録できませんでした」と書くが、この状況はそれではない。
      noteManagerIdCollision(candidate, attempt);
    }
    // 黙って上書きするより、起こさないほうが安全側である。
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
    // best-effort にしない: 受け口の開いていない runner でマネージャーが走り出し、報告も許可確認も誰にも届かない。
    await this.#connectTo(runner);
    const startAttachments = input.attachments ?? [];
    if (startAttachments.length > 0) {
      const refused = await this.#attachmentsRefusal(runner, startAttachments, input.request);
      if (refused !== undefined) throw new ManagerAttachmentsRefusedError(refused);
    }
    // `cwd` を省いて `workspacePath` が未取得のまま `input.cwd ?? runner.workspacePath` へ通すと、既定値 `''` が
    // `runnerStartCommandSchema` に「cwd の形が不正」と弾かれ、真因が別の顔で報告されて台帳にも跡が残らない。
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

    // 新しい委譲の貸し出しは、`#claimForResume` の関門を通さない: 握っている者が存在せず、奪う操作ではない。
    // 台帳へ書けたことも条件にしない（新規の委譲は台帳が書けなくても走らせる）。
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
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        summary: brief({ request: input.request }),
        request: input.request,
        cwd,
        runnerId: runner.runnerId,
        // 確かめずに `runner-volume` と書かない: デーモンからは `/workspace` が永続かを知る手段が無く、
        // 断定すると台帳が存在しない永続性を主張して「復旧できる」と誤らせる。運用者が
        // `ALTEROID_WORKSPACE_KIND` で明示した場合だけ名乗る（`resolveWorkspacePolicy`）。
        workspace: workspaceLocatorFrom(this.#workspace, runner.runnerId, cwd),
        lease,
      },
      waiting: [],
      attached: true,
    };
    this.#records.set(managerId, record);
    this.#rememberTokenIdentity(managerId);

    let started: { cwd?: string; sessionGeneration?: string };
    try {
      started = await runner.start({
        managerId,
        request: input.request,
        cwd,
        lease: { fence: lease.fence, ttlMs: lease.ttlMs },
        ...(startAttachments.length === 0 ? {} : { attachments: startAttachments }),
      });
    } catch (error) {
      // 起こせなかったものを一覧に残さない: 「走っている」と見えて、誰も読まない相手へ指示を送り続けることになる。
      this.#records.delete(managerId);
      throw error;
    }
    this.#noteRunnerSessionSince(record);
    if (started.sessionGeneration !== undefined && started.sessionGeneration.length > 0) {
      record.sessionGeneration = started.sessionGeneration;
    }
    // 古い runner は `started.cwd` を返さないことがあり、そのときは何もしない（頼んだ値で「確認済み」を埋めない）。
    let cwdConfirmed: true | undefined;
    let requestedCwd: string | undefined;
    if (started.cwd !== undefined) {
      cwdConfirmed = true;
      if (started.cwd !== cwd) {
        requestedCwd = cwd;
        record.job.cwd = started.cwd;
        record.job.workspace = workspaceLocatorFrom(this.#workspace, runner.runnerId, started.cwd);
      }
    }
    // 名簿を引き直さず、この回に貸し出しを立てた相手を写す。`undefined` で上書きしない: 一度名乗った器の値まで消えて以後判定できなくなる。
    if (lease.instanceId !== undefined) record.job.sessionInstanceId = lease.instanceId;

    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      managerId,
      text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] ${input.request}`,
      ...(startAttachments.length === 0 ? {} : { attachments: attachmentRefsOf(startAttachments) }),
    });
    const silent = this.#silentRunners();
    const registeredRunnerIds = this.#registeredRunnerIds();
    const summary = summaryOf(
      record,
      isLive(record, silent),
      lostSinceOf(record, silent),
      vanishedOf(record, registeredRunnerIds),
      record.sessionMissingSince,
      record.turnEndedAt,
      record.turnEndReason,
      record.turnEndTail,
      record.toolUseStallAt,
      record.toolUseStallPending,
      this.#awaitingBackgroundOf(record.job.id),
      this.#tokenIdentities.get(record.job.id)?.generation,
      this.#tokenIdentity?.()?.generation,
      this.#tokenIdentity !== undefined,
      this.#resetTimeSkewMatches.get(record.job.id),
      // `record.job.usageStoppedAt` を直接渡さない: `ManagerSummary.usageStoppedAt` の doc のとおり門を通す。
      this.#usageStopped.has(record.job.id) ? record.job.usageStoppedAt : undefined,
      runnerListedAtOf(record.job, silent, this.#runnerSessions()),
    );
    // `summaryOf` へは混ぜない: `cwdConfirmed` / `requestedCwd` は起こした回にしか意味が無く、
    // 引数を増やすと他の全呼び出し元が「該当なし」を渡す羽目になる。
    return {
      ...summary,
      ...(cwdConfirmed === undefined ? {} : { cwdConfirmed }),
      ...(requestedCwd === undefined ? {} : { requestedCwd }),
    };
  }

  /**
   * クローンからの一言。宛先（`requestId`）か意思（`decision`）が在るときだけ止まっている確認への回答として使い、
   * それ以外は追加指示として流す。
   *
   * **宛先を推測しない。** 1本のマネージャーが複数の確認を同時に待つことがあり、
   * そこで先頭に入れてしまうと、拒否のつもりの一言が別の質問の答えになる。
   * 待ちが1件のときも同じである（`#choosePending` の doc）。
   */
  async send(
    managerId: string,
    message: string,
    options: ManagerSendOptions = {},
  ): Promise<ManagerSendResult> {
    await this.#ensureConnected();

    const record = this.#records.get(managerId) ?? (await this.#load(managerId));
    if (!record) {
      // 読めない形で在る行は「居ない」と言わない。
      const unreadable = await this.#unreadableRowDetail(managerId);
      if (unreadable !== undefined) {
        return { outcome: 'unreadable', detail: `${unreadable}送っていない。` };
      }
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
    if (pending === 'renotify-pending') {
      // `record.waiting.length === 1` は保証済み（`#choosePending` がその枝でだけこの値を返す）。
      const only = record.waiting[0];
      const last = record.lastDenialRenotify;
      const { tool, actor } =
        last === undefined ? { tool: undefined, actor: undefined } : decodeDenialKey(last.key);
      const actorLabel =
        actor === 'manager'
          ? 'マネージャー自身'
          : actor === 'worker'
            ? '作業者'
            : 'どちらの層か不明';
      return {
        outcome: 'unknown',
        detail:
          `${managerId} には直前に${tool === undefined ? '' : ` ${codeSpan(tool)}（${actorLabel}）の`}拒否の` +
          '知らせ直しが届いている。requestId の無い decision は、いま待っている確認' +
          `（requestId: ${codeSpan(only?.requestId ?? '')}）へ黙って当てない——それが知らせ直しへの` +
          '返答のつもりでも、この確認とは無関係かもしれない。答えるなら requestId を明示すること。',
      };
    }

    const sendAttachments = options.attachments ?? [];
    if (pending && sendAttachments.length > 0) {
      return {
        outcome: 'unknown',
        detail:
          '確認への回答（requestId / decision を付けた送信）には添付を載せられない。' +
          '何も送っていない。回答は添付なしで送り、添付は追加指示として別に送ること。',
      };
    }
    if (!pending && sendAttachments.length > 0) {
      const refused = await this.#attachmentsRefusal(runner, sendAttachments, message);
      if (refused !== undefined)
        return { outcome: 'unknown', detail: `${refused}（何も送っていない）` };
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
      await this.#journal({
        type: 'escalation',
        question: pending.summary,
        approvalId: pending.requestId,
        managerId,
        answeredAt: new Date().toISOString(),
        /*
         * runner.ts が確定した decision をそのまま書く。`decision` や `inferDecision(message)` を
         * ここで計算し直さない: runner.ts 側が変わったときに黙ってずれる。
         * `answered.decision` が無い回（変更前の runner）は `allow`/`deny` へ倒さず `[unknown]` で区別する。
         * `'unreadable'` は `[unreadable]` のまま残し、`allow`/`deny`/`unknown` へ畳まない。
         */
        answer:
          answered.decision === undefined
            ? `[unknown] ${message}`
            : `[${answered.decision}] ${message}`,
      });
      return {
        outcome: 'answered',
        // `decideAnswer` が SDK へ返す値では `unreadable` も `deny` に畳まれて区別できないので、その手前の `answered.decision` を見る。
        detail:
          answered.decision === 'unreadable'
            ? `${pending.summary} への回答が読み取れず、安全側で拒否した` +
              `（decision が無く、承認とも拒否とも読めなかった）。` +
              `許可するなら decision: 'allow' を付けて答え直すこと。`
            : `${pending.summary} に回答した。`,
      };
    }

    // 認証トークンの世代が食い違った done の委譲は旧セッションへ流さない: 旧プロセスの env は起動時に凍っていて、
    // 鍵が回った後も古い鍵で走り、また枠に当たる。
    let fingerprintMatched = false;
    // 届ける前に取る: 届いた直後に来た report を「ターンの前」と読まないため
    const turnStartedAt = new Date(this.#now()).toISOString();
    if (record.job.status === 'done') {
      const folded = await this.#foldStaleTokenSession(record, runner, managerId);
      if (folded.declined !== undefined) return folded.declined;
      fingerprintMatched = folded.fingerprintMatched === true;
    }

    // `attached` を信じ切らない: イベント駆動でしか更新されず、`closed` / resume 失敗の合図が届かなかった窓では
    // `true` のまま嘘になる。404 を例外のまま `send()` から貫通させると、どの `outcome` にもならず人間は 500 を受け取る。
    let attached = record.attached;
    let reentered = false;
    if (attached) {
      const missing = await this.#sendDetectingMissingSession(
        runner,
        managerId,
        message,
        sendAttachments,
      );
      if (missing) {
        record.attached = false;
        record.sessionMissingSince ??= new Date(this.#now()).toISOString();
        // 由来は上書きする（生存確認が先に置いた `unlisted` より強い観測）が、時刻は `??=` のまま: 最初に気づいた時刻を動かさない。
        record.sessionMissingKind = 'resume-failed';
        await this.#persist(record);
        attached = false;
      }
    }

    // 直前に 404 で訂正した相手も同じここを通す: 別経路を作ると、同じ session を二本起こさないための歯止めが片方にだけ効く。
    if (!attached) {
      // `sessionMissingSince` が立っている回は「持っていない」と確かめてあるので、失敗は `'unknown'` ではない。
      const missing = record.sessionMissingSince !== undefined;
      // 器の入れ替えで取り直している最中に重ねない（同じ session を二本起こす）。「戻れない」とは別の理由なので別のことを言う。
      if (this.#resuming.has(managerId)) {
        return {
          outcome: missing ? 'session_missing' : 'unknown',
          detail: sendFailureDetail(managerId, resumeFailureDetail(managerId, 'busy'), missing),
        };
      }
      /*
       * 器の入れ替わりの1行は、`status` で分岐せず resume から入り直す全委譲に同じ判定を当てる:
       * `running` / `waiting_human` は `#reattach` が告げた時点で `#claimForResume` が貸し出しを貸し直すので、二重には告げない。
       * 判定は `#resumeOnce` より前に置く: 貸し直した後に読むと「入れ替わっていない」としか見えない。
       * 告げたことをここで「告げた」と記録しない: 記録が進むのは `#resume` が `runner.resume()` の戻りまで届いた回だけで、
       * resume が失敗した回に進めると、届いていない1行を「届いた」と数えて二度と告げられなくなる。
       */
      const swapped = this.#runnerSwappedSinceSession(record, runner);
      const resumed = await this.#resumeOnce(
        record,
        runner,
        swapped
          ? `${runnerSwapNudge(
              record.job.workspace,
              record.job.lastUnpushedWorkObservation,
              record.job.lastRescue,
            )}\n\n${message}`
          : message,
        sendAttachments,
      );
      if (resumed !== 'resumed') {
        /*
         * `stopped-meanwhile` は `abort()` と同時に走って `#resume` が畳み直した回で、セッションが無いことは確かめてある:
         * `missing` に頼らず直接 `session_missing` を選び、`delivered` を返さない（止められた委譲を「届いた」と言わない）。
         * `sendFailureDetail` の前置きも付けない: 404 で訂正した回と事実の出所が違う（自分で畳んだ）。
         */
        if (resumed === 'stopped-meanwhile') {
          return {
            outcome: 'session_missing',
            detail: resumeFailureDetail(managerId, resumed, record.leaseRefusal),
          };
        }
        /*
         * `session_missing` を `'unknown'` へ畳まない（`ManagerSendResult` の doc の表）: 畳むと `app.ts` が 404 を返し、
         * 「そのものは無い」としか読めなくなるが、台帳には在り、`sessionId` が残っていればもう一度 resume を試せる。
         */
        return {
          outcome: missing ? 'session_missing' : 'unknown',
          detail: sendFailureDetail(
            managerId,
            resumeFailureDetail(managerId, resumed, record.leaseRefusal),
            missing,
          ),
        };
      }
      if (missing) {
        record.sessionMissingSince = undefined;
        // 由来も一緒に消す: 片方だけ残すと、時刻の無い由来が一覧の字面に出る。
        record.sessionMissingKind = undefined;
        reentered = true;
      }
      // `#resume` は短絡した回に世代を書かないので、指紋で確かめられた回はここで追いつかせる。
      if (fingerprintMatched) {
        this.#rememberTokenIdentity(managerId);
        this.#resumedIntoLiveProcess.delete(managerId);
      }
    }

    /*
     * 台帳へ `running` を書く直前にもう一度 `stopConfirmedAt` を見る: `#resume` の2つのチェックポイントを通った後でも、
     * `send()` へ戻るまでの `await` の間に `abort()` が印を立てうる。畳み直しは `abort()` と同じ
     * `#confirmStoppedAndReleaseLease` を使う。
     */
    if (record.stopConfirmedAt !== undefined) {
      const { outcome: foldOutcome } = await this.#confirmStoppedAndReleaseLease(
        record,
        runner,
        managerId,
      );
      if (foldOutcome === 'stopped') {
        await this.#persist(record);
      } else {
        noteResumeAfterStopFoldFailed(managerId, foldOutcome);
      }
      return {
        outcome: 'session_missing',
        detail: resumeFailureDetail(managerId, 'stopped-meanwhile', record.leaseRefusal),
      };
    }

    record.job.status = 'running';
    record.job.turnStartedAt = laterIso(record.job.turnStartedAt, turnStartedAt);
    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      managerId,
      text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] ${message}`,
      // 中身は日誌へ書かない（参照のメタデータだけ）。
      ...(sendAttachments.length === 0 ? {} : { attachments: attachmentRefsOf(sendAttachments) }),
    });
    return {
      outcome: 'delivered',
      // 台帳を直したことは黙らず呼び手へ言う: 届き方が違うと、続けて送る側は器が入れ替わった後の文脈で走っていると知る必要がある。
      detail:
        // 短絡した回は、新しい SDK を起こしておらず旧プロセス（起動時の鍵が凍っている）へ届いたと言う。
        !attached && this.#resumedIntoLiveProcess.has(managerId)
          ? '追加指示として届けた（生きた旧プロセスへ流した。新しい SDK は起こしていない。' +
            'その鍵が現役かどうかは確かめていないので、この委譲の認証トークンの世代は「分からない」のままにしてある）。'
          : reentered
            ? '追加指示として届けた（runner にこの委譲のセッションが無かったので、resume から入り直した）。'
            : '追加指示として届けた。',
    };
  }

  /**
   * 畳むのは「失うものが無い」と分かったときだけで、1つでも欠けていれば断る（`declined`）: 畳むと SDK 子プロセスごと
   * 確認待ち（`canUseTool`）と起こしっぱなしの背景処理が道連れになる。古い鍵のまま流し込むこともしない。
   *
   * - 背景処理は runner の応答の `liveBackgroundTasks` だけが材料: `report.awaitingBackground` は失敗で終わった回
   *   （枠で終わった回）には立たない。欄が無い（古い runner）ときは「分からない」として断る（0 と読むと背景処理を黙って殺す）。
   * - `sessionId` が無いまま畳むと会話が切れる。
   *
   * 順序に依存している（`runner-stop-finish-order.test.ts` が固定）: `runner.stop()` は子プロセスを閉じた後に生ログを送り出し、
   * 未報告の本文を flush してから `onClosed` する。一覧から消えたと確かめられなければ resume しない（二重に起こさない）。
   * `attached` を false にするが貸し出しは返さない: `abort()` を流用しない（`stopConfirmedAt` を立てて `#resume` に resume を断らせる）。
   */
  async #foldStaleTokenSession(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
  ): Promise<{ declined?: ManagerSendResult; fingerprintMatched?: true }> {
    const held = this.#tokenIdentities.get(managerId)?.generation;
    const identity = this.#tokenIdentity?.();
    const active = identity?.generation;
    const activeFingerprint = identity?.fingerprint;

    // 一覧の ⚠ と同じ判定（`tokenGenerationMismatched`）を使う。ここで別の式を書かない。
    if (record.attached) {
      if (
        !tokenGenerationMismatched({ tokenGeneration: held, activeTokenGeneration: active }) ||
        held === undefined ||
        active === undefined
      ) {
        return {};
      }
    } else {
      // 台帳が「繋がっていない」done は、まず10秒ごとの生存確認の観測で見る: 普段の経路で `runner.list()` を増やさない
      // （`manager-lease.test.ts` が固定）。観測は最大10秒古いので、食い違いのときだけ下で取り直して確かめる。
      // 指紋が分からないときは断らず流し、世代は書かない。
      const observed = this.#observedTokenFingerprint(record.job.runnerId, managerId);
      if (observed === undefined || activeFingerprint === undefined) return {};
      if (observed === activeFingerprint) return { fingerprintMatched: true };
    }

    let listing: RunnerManagerListing;
    try {
      listing = await listRunnerManagers(runner);
    } catch (error) {
      if (!record.attached) return {};
      return {
        declined: {
          outcome: 'declined',
          detail:
            `${managerId} は認証トークンの世代が食い違っている（世代 ${String(held)} を抱えたまま、` +
            `現役は世代 ${String(active)}）が、runner の状態を読めなかった（${reasonOf(error)}）ため、` +
            '背景処理や確認待ちが残っているか分からない。畳んでいないし、古い鍵のセッションへも送っていない。' +
            '少し置いてから送り直すこと。',
        },
      };
    }
    const state = listing.states.find((entry) => entry.managerId === managerId);
    if (state === undefined) {
      if (!listing.unreadableIds.includes(managerId)) return {};
      // 読めない形で在るなら「居る」側に数える: 数えずに通すと旧セッションへ送りうる。
      if (!record.attached) return {};
      return {
        declined: {
          outcome: 'declined',
          detail:
            `${managerId} は認証トークンの世代が食い違っているが、runner が返した状態が読めず、` +
            '背景処理や確認待ちが残っているか分からない。送っていない。',
        },
      };
    }

    // 台帳が「繋がっていない」のに旧プロセスが生きている回は、世代が再起動で失われているので鍵の指紋で比べる。
    // 読めないときは断らず流す（再起動後の done へ送れなくなるのは能力の削除になる）。
    let staleness: string;
    if (record.attached) {
      staleness =
        `認証トークンの世代が食い違っている（世代 ${String(held)} を抱えたまま、` +
        `現役は世代 ${String(active)}）`;
    } else {
      const sessionFingerprint = state.tokenFingerprint;
      if (sessionFingerprint === undefined || activeFingerprint === undefined) return {};
      if (sessionFingerprint === activeFingerprint) return { fingerprintMatched: true };
      // 出してよいのは指紋だけ（sha256 の先頭12桁）。鍵の値は出さない。
      staleness =
        '生きている旧セッションが起動時に掴んだ鍵の指紋が現役と食い違っている' +
        `（セッション ${sessionFingerprint} / 現役 ${activeFingerprint}）`;
    }

    const blockers: string[] = [];
    const waitingCount = Math.max(state.waiting.length, record.waiting.length);
    if (waitingCount > 0) blockers.push(`確認待ちが ${String(waitingCount)} 件残っている`);
    if (state.liveBackgroundTasks === undefined) {
      blockers.push(
        '起こしっぱなしの背景処理が残っているか分からない（この runner の版は本数を返さない）',
      );
    } else if (state.liveBackgroundTasks > 0) {
      blockers.push(`起こしっぱなしの背景処理が ${String(state.liveBackgroundTasks)} 本残っている`);
    }
    if (record.job.sessionId === undefined) {
      blockers.push('会話を引き継ぐ sessionId が無い（畳むと会話が切れる）');
    }
    if (!record.attached && state.status === 'running') {
      blockers.push('runner のセッションはいまターンが走っている（畳むと走っている仕事を失う）');
    }
    if (blockers.length > 0) {
      return {
        declined: {
          outcome: 'declined',
          detail:
            `${managerId} は${staleness}。古い鍵のセッションへ流すとまた枠に当たるので、` +
            '畳んで新しい鍵で起こし直したいが、畳めない理由が残っている: ' +
            `${blockers.join('。')}。畳んでいないし、送ってもいない。` +
            '取れる手: (1) 背景処理・確認待ちが終わるのを待ってから送り直す。' +
            '(2) 残っているものを捨ててよいなら manager_stop → manager_start で後継を起こす' +
            '（manager_stop は残っている仕事ごと畳む）。',
        },
      };
    }

    // best-effort: 失敗しても畳みの判断は変えない。
    await this.unpushedWork(managerId, {
      signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
      source: 'stop',
    }).catch(() => undefined);

    let stopError: unknown;
    try {
      await runner.stop(managerId);
    } catch (error) {
      stopError = error;
    }
    // 読めなかった委譲は居る側に数える（`abort()` と同じ）。
    const gone = await listRunnerManagers(runner)
      .then(
        ({ states, unreadableIds }) =>
          !states.some((entry) => entry.managerId === managerId) &&
          !unreadableIds.includes(managerId),
      )
      .catch(() => undefined);
    if (gone !== true) {
      return {
        declined: {
          outcome: 'declined',
          detail:
            `${managerId} の旧セッションを畳めたと確かめられなかった` +
            `（${gone === false ? 'runner の一覧にまだ残っている' : '一覧を読めなかった'}` +
            `${stopError === undefined ? '' : `。runner.stop() が例外を投げた: ${reasonOf(stopError)}`}）。` +
            '二重に起こさないので resume していないし、送ってもいない。少し置いてから送り直すこと。',
        },
      };
    }

    record.attached = false;
    await this.#journal({
      type: 'decision',
      decision: `[${managerId}] done の委譲を、畳んで新しい鍵で起こし直す（${staleness}）`,
      grounds:
        `managerId=${managerId} liveBackgroundTasks=0 確認待ち=0` +
        '（#2851 / #2877。旧セッションへ流すと古い鍵のまま走る）',
    });
    return {};
  }

  /**
   * `RunnerHttpError` の 404 だけを捕まえ、それ以外は投げる: 5xx・接続断・fencing の 409 は待てば直るか別の手当てが要るもので、
   * 「セッションが無い」とは別の事実である。広く捕まえると resume を試みる条件が「runner が答えなかったとき」まで広がり、
   * 生きている仕事を二重に起こす。
   * `false` の戻り値も読む: `LocalRunner` はセッション不在でも例外を投げないので、読まないと `outcome: 'delivered'` を返してしまう。
   */
  async #sendDetectingMissingSession(
    runner: RunnerClient,
    managerId: string,
    message: string,
    attachments: RunnerAttachment[] = [],
  ): Promise<boolean> {
    try {
      const delivered =
        attachments.length === 0
          ? await runner.send(managerId, message)
          : await runner.send(managerId, message, attachments);
      return !delivered;
    } catch (error) {
      if (error instanceof RunnerHttpError && error.status === 404) return true;
      throw error;
    }
  }

  /**
   * ここで新たに runner を叩かない: `RunnerRegistry#entries()` が10秒ごとの生存確認で立てた判定を読むだけで、一覧を出すたびに往復を増やさない。
   *
   * `state === 'lost'` だけを採る（ホワイトリスト）: `connecting` / `unreachable` / `unusable` は「まだ一度も開けていない」側で、
   * 数え漏らしても「今までどおり `live` を計算する」に倒れるだけである。
   * `vacating` も数えない: 黙ったのではなく空けると決めた結果で、名乗り自体は続いている。
   * `runnerId` を名乗れていない行も数えない: どの委譲に当たるか決められないまま `live` を倒すことになる。
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

  /**
   * `#silentRunners()` とは見ている軸が違う: あちらは `state === 'lost'` だけを拾い、こちらは state を問わず entry の有無だけを見る
   * （entry がまるごと消えている runnerId を見分けるため）。runner は叩かず、名簿の観測を同期に読むだけ。
   *
   * 名乗っていない entry が1本でも在れば `null`（判定できない）を返す: 起動し直した直後は最初の `#open()` が成功するまで
   * entry は `runnerId` を持たず、読み飛ばすと数秒後に繋がる runner の委譲まで全部「名簿から消えた」と出る。
   * 偽の「消えた」より黙っているほうが安全側で、本当に消えていれば後の呼びで立つ（呼ぶ側は `null` なら印も計器も立てない）。
   * 代償として、名乗らない runner（古い器）が常駐する構成ではこの判定は常に「判定できない」になる。
   */
  #registeredRunnerIds(): ReadonlySet<string> | null {
    const ids = new Set<string>();
    for (const entry of this.#runners.entries()) {
      if (entry.runnerId === undefined) return null;
      ids.add(entry.runnerId);
    }
    return ids;
  }

  /**
   * runner は叩かず、名簿に既に立っている観測を同期に読むだけ（往復を払うのは heartbeat の側）。
   *
   * 同じ `runnerId` の行が複数在るときは和を採る（畳まれつつある旧い器と新しい器が並びうる）: どれか1台でも「抱えている」と答えたなら
   * 抱えている側へ倒す。片方の空の答えで「セッションが消えた」と名乗ると、まだ生きている器を持つ委譲に ⚠ が付く。
   * 聞けていない行（`sessions` が無い）は数に入れない。
   */
  #runnerSessions(): ReadonlyMap<string, { ids: ReadonlySet<string>; observedAt: string }> {
    const seen = new Map<string, { ids: Set<string>; observedAt: string }>();
    for (const entry of this.#runners.entries()) {
      if (entry.runnerId === undefined) continue;
      if (entry.sessions === undefined || entry.sessionsObservedAt === undefined) continue;
      const before = seen.get(entry.runnerId);
      if (before === undefined) {
        seen.set(entry.runnerId, {
          ids: new Set(entry.sessions),
          observedAt: entry.sessionsObservedAt,
        });
        continue;
      }
      for (const id of entry.sessions) before.ids.add(id);
      if (entry.sessionsObservedAt.localeCompare(before.observedAt) > 0) {
        before.observedAt = entry.sessionsObservedAt;
      }
    }
    return seen;
  }

  /**
   * 観測しかしない: `attached` も `status` も動かさず、resume も挑まない（挑めば10秒ごとに全台へ resume を撃つことになる）。
   * `running` / `waiting_human` だけを見る: `done` は待機で runner がセッションを畳んでいるのが正常な回もあり、
   * ⚠ を付けると起動のたびに終わった委譲へ警告が並んで本当に困っている1本が埋もれる。
   * その委譲がその器に置かれる前の観測（`runnerSessionSince`）は使わない: `start` から応答までの窓の「まだ載っていない」を「消えた」と読まない。
   */
  #noteMissingSessions(): void {
    const sessions = this.#runnerSessions();
    if (sessions.size === 0) return;
    for (const record of this.#records.values()) {
      const runnerId = record.job.runnerId;
      if (runnerId === undefined) continue;
      const status = record.job.status;
      if (status !== 'running' && status !== 'waiting_human') continue;
      const observed = sessions.get(runnerId);
      if (observed === undefined) continue;
      const since = record.runnerSessionSince ?? record.job.createdAt;
      if (observed.observedAt.localeCompare(since) <= 0) continue;
      if (observed.ids.has(record.job.id)) {
        // 新しい観測でだけ消す: `send()` が直前に置いた印を、それより古い一覧で消さないため。
        if (
          record.sessionMissingSince !== undefined &&
          observed.observedAt.localeCompare(record.sessionMissingSince) > 0
        ) {
          record.sessionMissingSince = undefined;
          record.sessionMissingKind = undefined;
        }
        continue;
      }
      // 由来は格下げしない: 既に印が在るなら `send()` / `#reattach()` が resume まで試した結果かもしれず、ここが名乗れるのは「名簿に載っていなかった」まで。
      if (record.sessionMissingSince === undefined) {
        record.sessionMissingSince = observed.observedAt;
        record.sessionMissingKind = 'unlisted';
      }
    }
  }

  /** 聞けていない・欄を返さない runner のときは `undefined`（「分からない」）。 */
  #observedTokenFingerprint(runnerId: string | undefined, managerId: string): string | undefined {
    if (runnerId === undefined) return undefined;
    for (const entry of this.#runners.entries()) {
      if (entry.runnerId !== runnerId) continue;
      const fingerprints = entry.sessionTokenFingerprints;
      if (fingerprints !== undefined && Object.hasOwn(fingerprints, managerId)) {
        return fingerprints[managerId];
      }
    }
    return undefined;
  }

  /** 聞けていない・欄を返さない runner のときは `undefined`（0 ではない）。 */
  #observedBackgroundTasks(runnerId: string | undefined, managerId: string): number | undefined {
    if (runnerId === undefined) return undefined;
    for (const entry of this.#runners.entries()) {
      if (entry.runnerId !== runnerId) continue;
      const tasks = entry.sessionBackgroundTasks;
      if (tasks !== undefined && Object.hasOwn(tasks, managerId)) return tasks[managerId];
    }
    return undefined;
  }

  async list(): Promise<ManagerSummary[]> {
    await this.#ensureConnected();

    // 名簿・現役の世代は1回だけ引いて使い回す: 一覧を作っている間に動いても、同じ応答の中では全件を同じ像で比べる
    // （1本ずつ `this.#tokenIdentity?.()` を呼び直すと、回転が割り込んだとき一部だけ新しい現役と比べることになる）。
    this.#noteMissingSessions();
    const silent = this.#silentRunners();
    const runnerSessions = this.#runnerSessions();
    // 一覧を作っている間に名簿が動いても、同じ応答の中では全件を同じ像で比べる: 1回だけ引き、呼び出しごとに読み直さない。
    const registeredRunnerIds = this.#registeredRunnerIds();
    const activeTokenGeneration = this.#tokenIdentity?.()?.generation;
    const tokenGenerationPoolWired = this.#tokenIdentity !== undefined;
    const known = new Map<string, ManagerSummary>();
    for (const record of this.#records.values()) {
      known.set(
        record.job.id,
        summaryOf(
          record,
          isLive(record, silent),
          lostSinceOf(record, silent),
          vanishedOf(record, registeredRunnerIds),
          record.sessionMissingSince,
          record.turnEndedAt,
          record.turnEndReason,
          record.turnEndTail,
          record.toolUseStallAt,
          record.toolUseStallPending,
          this.#awaitingBackgroundOf(record.job.id),
          this.#tokenIdentities.get(record.job.id)?.generation,
          activeTokenGeneration,
          tokenGenerationPoolWired,
          this.#resetTimeSkewMatches.get(record.job.id),
          // `ManagerSummary.usageStoppedAt` の doc のとおり門を通す。
          this.#usageStopped.has(record.job.id) ? record.job.usageStoppedAt : undefined,
          runnerListedAtOf(record.job, silent, runnerSessions),
        ),
      );
    }
    // `live: false` を決め打ちしない: `#retire` が `#records` から外した後の「台帳にしか無い」は
    // 「runner に宛先が無い」とは限らず、決め打つと外した瞬間に `live: true` だった委譲が `false` へ化ける。
    for (const job of await this.#stores.jobs.listJobs()) {
      if (known.has(job.id)) continue;
      const fallback: ManagerRecord = { job, waiting: [], attached: false };
      known.set(
        job.id,
        summaryOf(
          fallback,
          isLive(fallback, silent),
          lostSinceOf(fallback, silent),
          vanishedOf(fallback, registeredRunnerIds),
          fallback.sessionMissingSince,
          fallback.turnEndedAt,
          fallback.turnEndReason,
          fallback.turnEndTail,
          fallback.toolUseStallAt,
          fallback.toolUseStallPending,
          this.#awaitingBackgroundOf(job.id),
          this.#tokenIdentities.get(job.id)?.generation,
          activeTokenGeneration,
          tokenGenerationPoolWired,
          this.#resetTimeSkewMatches.get(job.id),
          // `ManagerSummary.usageStoppedAt` の doc のとおり門を通す。
          this.#usageStopped.has(job.id) ? job.usageStoppedAt : undefined,
          runnerListedAtOf(job, silent, runnerSessions),
        ),
      );
    }
    // 聞けていない委譲には欄を作らない（0 を捏造しない）。
    for (const record of this.#records.values()) {
      const tasks = this.#observedBackgroundTasks(record.job.runnerId, record.job.id);
      const summary = known.get(record.job.id);
      if (tasks !== undefined && summary !== undefined) {
        known.set(record.job.id, { ...summary, liveBackgroundTasks: tasks });
      }
    }
    const summaries = [...known.values()];
    // `isLive()` にも `status` にも触れない独立した計器。新しい tick は足さずここへ載せ、書く頻度は `#noteVanishedRunnerGauge` が絞る。
    await this.#noteVanishedRunnerGauge(summaries, registeredRunnerIds);
    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * 本数が同じなら書かない: `list()` は毎ターンの状況の節からも呼ばれ、呼ばれるたびに書くと日誌が膨らむ。
   * 0本に戻った runnerId は書かずに Map から外す（取れない軸に0の行を作らない）。
   *
   * 関数全体を try/catch で包む: `#journal()` の失敗は内部で飲まれるが、`#journal` を呼ぶ前の計算が投げると `list()` まで素通りして落ちる。
   * 測るだけの段が読む側の挙動を変えてはいけない。握り潰すだけでなく `noteDroppedRecord` で跡は残す。
   * `#journal` は `void` にして待たない: この計器の書き込みの遅さ・失敗で `list()` を止めない。
   */
  async #noteVanishedRunnerGauge(
    summaries: readonly ManagerSummary[],
    registeredRunnerIds: ReadonlySet<string> | null,
  ): Promise<void> {
    // 判定できない回は何も書かず、前回の本数も動かさない（次に判定できた回に、いまの記憶のまま比べる）。
    if (registeredRunnerIds === null) return;
    try {
      const backlog = vanishedRunnerBacklog(summaries, registeredRunnerIds);
      for (const runnerId of this.#vanishedRunnerGaugeLastCount.keys()) {
        if (!backlog.has(runnerId)) this.#vanishedRunnerGaugeLastCount.delete(runnerId);
      }
      for (const [runnerId, entry] of backlog) {
        if (this.#vanishedRunnerGaugeLastCount.get(runnerId) === entry.count) continue;
        void this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `${EXCHANGE_KIND_GAUGE_PREFIX}${describeVanishedRunnerBacklogLine(runnerId, entry, this.#now())}`,
        });
        this.#vanishedRunnerGaugeLastCount.set(runnerId, entry.count);
      }
    } catch (error) {
      noteDroppedRecord('running のまま entry ごと消えた runner の計器', '', error);
    }
  }

  denials(managerId: string): ManagerDenial[] {
    // 台帳へは降りない: プロセス内の像にしか無いので、知らないものは「無い」ではなく「数えていない」。
    const record = this.#records.get(managerId);
    const denied = record?.denied;
    if (denied === undefined) return [];
    // `actor` が `undefined` のものだけ外向きの形から省く（`ManagerDenial.actor` の doc）: 取れていないことを「その名前の層」として見せない。
    return denied.entries().map(([key, count]) => {
      const { tool, actor } = decodeDenialKey(key);
      const lastAt = record?.deniedLastAt?.get(key);
      const reason = record?.deniedLastReason?.get(key);
      return {
        tool,
        count,
        ...(actor === undefined ? {} : { actor }),
        ...(lastAt === undefined ? {} : { lastAt }),
        ...(reason?.reasonType === undefined ? {} : { reasonType: reason.reasonType }),
        ...(reason?.reason === undefined ? {} : { reason: reason.reason }),
        ...(reason?.message === undefined ? {} : { message: reason.message }),
        ...(reason?.inputHead === undefined ? {} : { inputHead: reason.inputHead }),
      };
    });
  }

  pushHealthOf(runnerId: string): RunnerPushHealth | undefined {
    return this.#pushHealth.get(runnerId);
  }

  pluginLoadOf(runnerId: string): RunnerPluginLoadObservation | undefined {
    return this.#pluginLoad.get(runnerId);
  }

  async runners(
    options: { fingerprints?: boolean; resources?: boolean } = {},
  ): Promise<RunnerFleetOverview> {
    const managers = await this.list();
    const entries = this.#runners.entries();

    // `runnerId` が無い分はどの器にも混ぜず別枠へ: 0 に畳むと「記録が無いマネージャーは存在しない」と読める。
    const byRunner = new Map<string, RunnerManagerEntry[]>();
    const unassigned: RunnerManagerEntry[] = [];
    for (const manager of managers) {
      // `live` を落とさない: 落とすと `runner_list` の側でだけ「走行中」と「走行中だがセッション切断」が潰れる（`RunnerManagerEntry` の doc）。
      const item: RunnerManagerEntry = {
        managerId: manager.managerId,
        status: manager.status,
        live: manager.live,
        ...(manager.awaitingBackground === undefined
          ? {}
          : { awaitingBackground: manager.awaitingBackground }),
        ...(manager.tokenGeneration === undefined
          ? {}
          : { tokenGeneration: manager.tokenGeneration }),
        ...(manager.activeTokenGeneration === undefined
          ? {}
          : { activeTokenGeneration: manager.activeTokenGeneration }),
        ...(manager.tokenGenerationUnknownReason === undefined
          ? {}
          : { tokenGenerationUnknownReason: manager.tokenGenerationUnknownReason }),
      };
      if (manager.runnerId === undefined) {
        unassigned.push(item);
        continue;
      }
      const bucket = byRunner.get(manager.runnerId);
      if (bucket) bucket.push(item);
      else byRunner.set(manager.runnerId, [item]);
    }

    // 指紋・資源は明示的に頼まれたときだけ聞きに行く。同じ `open` を材料にして往復を増やさない。
    const open =
      options.fingerprints || options.resources
        ? new Map(
            (await this.#runners.list().catch(() => [])).map((runner) => [runner.runnerId, runner]),
          )
        : undefined;

    const placed = await Promise.all(
      entries.map(async (entry) => {
        const client = entry.runnerId === undefined ? undefined : open?.get(entry.runnerId);
        const pushHealth =
          entry.runnerId === undefined ? undefined : this.#pushHealth.get(entry.runnerId);
        // `probe` を必ず併せて返す: 「頼まれていない」「聞けなかった」「聞いたが失敗した」を同じ `undefined` に潰さない。
        const [credentialsProbed, profileProbed, mcpServersProbed] = await Promise.all([
          probeRunnerFingerprint(client, options.fingerprints, (c) => c.credentials()),
          probeRunnerFingerprint(client, options.fingerprints, (c) => c.profile()),
          probeRunnerMcpServersFingerprint(client, options.fingerprints),
        ]);
        const credentials = credentialsProbed.value;
        const profile = profileProbed.value;
        const mcpServers = mcpServersProbed.value;
        // 訊けなかった理由は `resourcesProbe` が持つ（失敗・「繋がっていない」・「口を持たない」を `undefined` に潰さない）。
        const resourcesProbed = await probeRunnerResources(client, options.resources);
        const resources = resourcesProbed.value;

        // `pendingEvents` が `undefined`（古い runner・応答の形が壊れていた）のときは書かない: 0 で埋めない。
        if (entry.runnerId !== undefined && resources?.pendingEvents !== undefined) {
          this.#runnerBacklog.set(entry.runnerId, {
            runnerId: entry.runnerId,
            pendingEvents: resources.pendingEvents,
            ...(resources.oldestPendingAt === undefined
              ? {}
              : { oldestPendingAt: resources.oldestPendingAt }),
            observedAt: new Date(this.#now()).toISOString(),
            // `resources()` は instanceId を運ばないので、名簿がいま知っている値を観測時点のものとして凍結する。
            ...(entry.instanceId === undefined
              ? {}
              : { instanceIdAtObservation: entry.instanceId }),
          });
        }

        const pidsSaturation =
          entry.runnerId === undefined
            ? undefined
            : this.#runners.pidsSaturationOf?.(entry.runnerId, resources?.pids);

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
          ...(credentialsProbed.probe === undefined
            ? {}
            : { credentialsProbe: credentialsProbed.probe }),
          ...(profile === undefined ? {} : { profile }),
          ...(profileProbed.probe === undefined ? {} : { profileProbe: profileProbed.probe }),
          ...(mcpServers === undefined ? {} : { mcpServers }),
          ...(mcpServersProbed.probe === undefined
            ? {}
            : { mcpServersProbe: mcpServersProbed.probe }),
          ...(resources === undefined ? {} : { resources }),
          ...(resourcesProbed.probe === undefined ? {} : { resourcesProbe: resourcesProbed.probe }),
          ...(pidsSaturation === undefined ? {} : { pidsSaturation }),
          revision: entry.revision,
          // `fingerprints` の要否を見ない: 往復を払わない（記憶を読むだけ）ので opt-in にする理由が無い。
          ...(pushHealth === undefined ? {} : { pushHealth }),
          managerPeers: this.managerPeersOf(entry.runnerId),
        };

        // `undefined`（pids を見ていない）と `[]`（見たが候補が無かった・全部見送った）を混ぜない:
        // `autoFolded.length===0` で測ると「逼迫していたが候補が0件」と「逼迫を見なかった」が同じ形に潰れる。
        const autoFolded: AutoFoldOutcome[] | undefined =
          entry.runnerId !== undefined && resources?.pids !== undefined
            ? await this.#autoFoldIdleOnRunnerIfUnderPressure(
                entry.runnerId,
                resources.pids,
                managers,
              )
            : undefined;

        return { overview, autoFolded };
      }),
    );
    const runners = placed.map((p) => p.overview);
    // 全台が `undefined` のときだけ欄そのものを省く（見なかった／見て0件／見て畳んだ・見送った、の3値を潰さない）。
    const autoFoldedChecked = placed.some((p) => p.autoFolded !== undefined);
    const autoFolded = placed.flatMap((p) => p.autoFolded ?? []);

    const daemonRevision = reportRunnerRevision(resolveBuildRevision());

    return {
      runners,
      unassigned,
      daemonRevision,
      ...(autoFoldedChecked ? { autoFolded } : {}),
    };
  }

  /**
   * 逼迫していなければ `managers` を1回も読まず `undefined` を返す。`undefined`（見ていない）と `[]`（見たが0件）を区別する。
   * 呼び出し元（`runners()` と `autoFoldOnPlacementPressure`）の判定・実行はここ1つで共有し、2つに増やさない。
   */
  async #autoFoldIdleOnRunnerIfUnderPressure(
    runnerId: string,
    pids: { readonly current: number; readonly max: number },
    managers: readonly ManagerSummary[],
  ): Promise<AutoFoldOutcome[] | undefined> {
    if (!isPidsUnderPressure(pids)) return undefined;

    const now = new Date(this.#now());
    const capabilityConfirmed = this.runnerHasCapability(
      runnerId,
      RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
    );
    const outcomes: AutoFoldOutcome[] = [];
    for (const manager of managers) {
      if (manager.runnerId !== runnerId) continue;
      const isCandidate = isManagerFoldCandidate(
        {
          status: manager.status,
          hasAwaitingBackgroundSignal: manager.awaitingBackground !== undefined,
          awaitingBackgroundSignalVersionConfirmed: capabilityConfirmed,
          // `managerActivityInputOf`（`tools.ts`）と同じ field 選択を import せずここでも行う: 循環 import を避けるため。
          activityKind: classifyManagerActivity({
            turnEndReason: manager.turnEndReason,
            turnEndedAt: manager.turnEndedAt,
            lastReportAt: manager.lastReportAt,
            toolUseStallPending: manager.toolUseStallPending,
            waitingCount: manager.waiting.length,
          }),
          lastTurnEndedAt: manager.updatedAt,
        },
        now,
      );
      if (!isCandidate) continue;
      outcomes.push(
        await this.#autoFoldOne(manager.managerId, runnerId, pids, manager.lastReportAt),
      );
    }
    return outcomes;
  }

  /**
   * 0. **同じ委譲の二重実行の壁。** 2つの契機（`runner_list resources:true` /
   *    `manager_start` の自動配置）が同じ委譲を同時に候補として拾うと、
   *    ここが並行に2回走りうる——1の「競合の再確認」は判定してからここに
   *    来るまでの窓しか見ておらず、**同時に2つの実行が両方ともその窓を
   *    通り抜ける**形までは塞がない。だから最初（どの `await` より前）に
   *    `#autoFoldInFlight` を確認・設置する（`#autoFoldInFlight` の doc）。
   *    既に入っていれば `'skipped-concurrent'` で即座に戻り、日誌には残さない
   *    ——「判定できない」ではなく「他方が処理中」なので、未pushの安全弁と
   *    同じ理由の見送りには数えない。
   * 1. **競合の再確認。** 候補と判定してからここに来るまでの間（同じ呼び出し
   *    内の他の委譲の await を挟む）に、誰か・何かが先にこの委譲へ触れて
   *    `status` が `done` でなくなっているかもしれない。読み直して違って
   *    いたら、安全側に倒して何もしない（`'raced'`）。
   * 2. **未 push の安全弁**（`evaluateAutoFoldUnpushedWork`）。`'blocked'` なら
   *    畳まず、日誌に見送った理由を残す。**ただし同じ委譲・同じ理由の見送りを
   *    繰り返し書かない**（Issue #1394 の留保。`candidateLastReportAt` の doc）。
   *
   * @param candidateLastReportAt 呼び出し元（段⑤の候補判定）が読んだ時点の
   *   `ManagerSummary.lastReportAt`。**`fresh.updatedAt`（`Job.updatedAt`）
   *   ではなくこちらを「委譲が新しいターンを回したか」の鍵にする。** 理由は
   *   実測——`unpushedWork()` は呼ぶたびに `#recordUnpushedWorkObservation` →
   *   `#persist()` を経由し、`#persist()` は無条件に `record.job.updatedAt` を
   *   「いま」へ進める（`#persist` の doc）。**この安全弁自身がすぐ下で
   *   `unpushedWork()` を呼ぶので、`Job.updatedAt` は「新しいターンを回したか」
   *   ではなく「直前にこの安全弁を評価したか」を表してしまい、鍵として使うと
   *   毎回「変わった」と誤判定して重複除去が機能しない**（実測: 同じ委譲へ
   *   `runners({resources:true})` を続けて2回呼ぶだけで `Job.updatedAt` が
   *   動き、かつ経過時間の起点も一緒に動くので段⑤の候補判定自体が2回目には
   *   落ちる——`manager.test.ts` の変異観測で見つかった）。**`lastReportAt`
   *   は `case 'report'`（本物の新しいターン）でしか書き換わらない**
   *   （書き込み箇所は1つだけ。`grep -Fn -- 'record.job.lastReportAt = new Date' packages/core/src/manager.ts`）
   *   ので、この安全弁の実行そのものには汚染されない。
   */
  async #autoFoldOne(
    managerId: string,
    runnerId: string,
    pids: { readonly current: number; readonly max: number },
    candidateLastReportAt: string | undefined,
  ): Promise<AutoFoldOutcome> {
    const pidsNote = `pids ${String(pids.current)}/${String(pids.max)}`;

    // 鍵の確認と設置の間に `await` を挟まない: 挟むと二重実行の壁にならない。
    if (this.#autoFoldInFlight.has(managerId)) {
      return {
        managerId,
        runnerId,
        outcome: 'skipped-concurrent',
        detail:
          'この委譲は、もう一方の契機（runner_list resources:true / manager_start の自動配置）が' +
          '同時に処理中だったので、この回は見送った（二重に abort() を呼ばないため。' +
          '判定できなかったわけではない）。',
      };
    }
    this.#autoFoldInFlight.add(managerId);
    try {
      const fresh = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
      if (fresh === undefined || fresh.status !== 'done') {
        return {
          managerId,
          runnerId,
          outcome: 'raced',
          detail: `候補と判定した後、実際に畳む前に状態を読み直したら done ではなくなっていた（${
            fresh === undefined ? '台帳から消えている' : `いまは ${fresh.status}`
          }）。安全側に倒して何もしなかった。`,
        };
      }

      const unpushed = await this.unpushedWork(managerId, {
        // 新しい定数を増やさず `UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS` を使い回す: `case 'report'` の観測と同じ理由で足りるため。
        source: 'auto-fold',
        signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
      }).catch((error: unknown): ManagerUnpushedWork => ({
        kind: 'unavailable',
        reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
      }));
      const verdict = evaluateAutoFoldUnpushedWork(unpushed);
      if (verdict !== 'clear') {
        const reason = describeAutoFoldUnpushedWorkProbe(unpushed);
        // 同じ委譲・同じ理由の見送りを日誌へ積み続けない。鍵に表示用の `reason` 本文は使わない: 文言だけ直っても別の理由と誤読するため。
        const reasonKey = classifyAutoFoldUnpushedWorkProbe(unpushed);
        const memoKey = { lastReportAt: candidateLastReportAt, reasonKey };
        const previous = this.#autoFoldSkipJournalWritten.get(managerId);
        const unchanged =
          previous !== undefined &&
          previous.lastReportAt === memoKey.lastReportAt &&
          previous.reasonKey === memoKey.reasonKey;
        if (!unchanged) {
          await this.#journal({
            type: 'decision',
            decision:
              `[auto-fold-skip] ${managerId} は pids 逼迫（runner=${runnerId}、${pidsNote}）で` +
              `畳む候補だったが、畳まなかった: ${reason}。`,
            grounds: 'デーモンの自動畳み（Issue #1394 段④⑥）: 未pushの安全弁が clear ではなかった',
          });
          this.#autoFoldSkipJournalWritten.set(managerId, memoKey);
          pruneOldestEntries(
            this.#autoFoldSkipJournalWritten,
            AUTO_FOLD_SKIP_JOURNAL_TRACKING_LIMIT,
          );
        }
        return {
          managerId,
          runnerId,
          outcome: 'blocked-unpushed-work',
          detail: reason,
        };
      }

      await this.#journal({
        type: 'decision',
        decision:
          `[auto-fold] ${managerId} を pids 逼迫（runner=${runnerId}、${pidsNote}）を理由に自動で畳む` +
          '（手が空いている・背景処理待ちの印なし・未pushの作業なし、のすべてを満たした）。',
        grounds:
          'デーモンの自動畳み（Issue #1394 段④⑥⑦）: pidsが上限の80%以上・段⑤の畳む候補の5条件・' +
          '未push安全弁のすべてを満たした',
      });

      const result = await this.abort(
        managerId,
        `pids 逼迫（${pidsNote}）を受けてデーモンが自動で畳んだ`,
        'auto-fold',
      );
      return {
        managerId,
        runnerId,
        outcome:
          result.outcome === 'stopped'
            ? 'folded'
            : result.outcome === 'not_stopped'
              ? 'not-stopped'
              : 'unknown',
        detail: result.detail,
      };
    } finally {
      this.#autoFoldInFlight.delete(managerId);
    }
  }

  /** ネットワークを叩かない: 往復を増やさず、既に持っている観測だけを合流させる。 */
  runnerBacklog(): readonly RunnerBacklogSnapshot[] {
    const liveEntries = this.#runners.entries();
    const merged = new Map<string, RunnerBacklogSnapshot>(
      [...this.#runnerBacklog.values()].map((snapshot) => [snapshot.runnerId, snapshot]),
    );
    for (const entry of liveEntries) {
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
        ...(entry.pendingEventsInstanceId === undefined
          ? {}
          : { instanceIdAtObservation: entry.pendingEventsInstanceId }),
      };
      const existing = merged.get(entry.runnerId);
      // 同点は resources() 側を残す: `>`（厳密な超過）だけを入れ替え条件にする。
      if (existing === undefined || candidate.observedAt > existing.observedAt) {
        merged.set(entry.runnerId, candidate);
      }
    }
    const liveByRunnerId = new Map(
      liveEntries.flatMap((entry) =>
        entry.runnerId === undefined ? [] : [[entry.runnerId, entry] as const],
      ),
    );
    return [...merged.values()]
      .map((snapshot): RunnerBacklogSnapshot => {
        const live = liveByRunnerId.get(snapshot.runnerId);
        return {
          ...snapshot,
          ...(live?.legState === undefined ? {} : { legState: live.legState }),
          // 時刻の大小で比べない: 初回観測を入れ替えと誤読するため instanceId を直接比べる。
          ...(snapshot.instanceIdAtObservation === undefined || live?.instanceId === undefined
            ? {}
            : { instanceSwapped: snapshot.instanceIdAtObservation !== live.instanceId }),
        };
      })
      .sort((a, b) => a.runnerId.localeCompare(b.runnerId));
  }

  /** 名乗らない版（旧い runner）は `attachments` 欄を黙って捨てて 200 を返すので、送らずに断る。 */
  async #attachmentsRefusal(
    runner: RunnerClient,
    attachments: readonly RunnerAttachment[],
    text: string,
  ): Promise<string | undefined> {
    await this.#awaitHello(runner.runnerId);
    if (this.runnerHasCapability(runner.runnerId, RUNNER_CAPABILITY_MANAGER_ATTACHMENTS)) {
      const named = this.#runnerAttachmentBodyLimits.get(runner.runnerId);
      const limit = named ?? runnerAttachmentBodyLimit(readAttachmentLimits().limits);
      const estimate = estimateAttachmentBodyBytes(attachments, text);
      if (estimate > limit) {
        return (
          `添付を載せた本文の見積もり ${estimate} バイトが、runner（runnerId=${runner.runnerId}）の上限 ` +
          `${limit} バイトを超える（${named === undefined ? '上限を名乗らない版なので、デーモン側の既定値' : 'runner が名乗った値'}）。` +
          '添付を減らすか、小さくして送り直すこと'
        );
      }
      return undefined;
    }
    return (
      `runner（runnerId=${runner.runnerId}）は担い手への添付の受け渡しを名乗っていない` +
      '（旧い版か、名乗りをまだ受けていない）。添付は黙って捨てられるので送らない'
    );
  }

  /** {@link RunnerOverview.managerPeers}。名乗りの記憶を読むだけで、runner へは訊きに行かない。 */
  managerPeersOf(runnerId: string | undefined): RunnerManagerPeers {
    if (runnerId === undefined) return { status: 'unknown' };
    if (!this.runnerHasCapability(runnerId, RUNNER_CAPABILITY_MANAGER_PEERS)) {
      return { status: 'unknown' };
    }
    const peers = this.#runnerManagerPeers.get(runnerId) ?? [];
    const closed = this.#runnerManagerPeersClosed.get(runnerId);
    return {
      status: 'named',
      peers: peers.map((peer) => ({
        provider: peer.provider,
        ...(peer.models === undefined ? {} : { models: [...peer.models] }),
      })),
      ...(closed === undefined
        ? {}
        : { closed: closed.map((entry) => ({ provider: entry.provider, reason: entry.reason })) }),
    };
  }

  /** hello と `manager_peers` の名乗りを丸ごと置き換える（送られなかった欄は消す。持ち越さない）。 */
  #setRunnerManagerPeers(
    runnerId: string,
    peers: readonly RunnerManagerPeer[] | undefined,
    closed: readonly RunnerManagerPeerClosed[] | undefined,
  ): void {
    if (peers === undefined || peers.length === 0) this.#runnerManagerPeers.delete(runnerId);
    else this.#runnerManagerPeers.set(runnerId, peers);
    if (closed === undefined || closed.length === 0)
      this.#runnerManagerPeersClosed.delete(runnerId);
    else this.#runnerManagerPeersClosed.set(runnerId, closed);
  }

  runnerHasCapability(runnerId: string, capability: string): boolean {
    return this.#runnerCapabilities.get(runnerId)?.has(capability) ?? false;
  }

  /** `hello` を受けるまで少し待つ（`connect` は `hello` を待たずに返る）。受けていれば true。 */
  async #awaitHello(runnerId: string): Promise<boolean> {
    for (
      let waited = 0;
      !this.#runnerCapabilities.has(runnerId) && waited < HELLO_WAIT_MS;
      waited += HELLO_POLL_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, HELLO_POLL_MS));
    }
    return this.#runnerCapabilities.has(runnerId);
  }

  runnerReportedModels(runnerId: string): { manager?: string; worker?: string } | undefined {
    return this.#runnerModels.get(runnerId);
  }

  runnerReportedAnthropicRoute(runnerId: string): readonly string[] | undefined {
    return this.#runnerAnthropicRoutes.get(runnerId);
  }

  /**
   * 門をここでも先に通す: 逼迫していない大半の回で `this.list()` の読み取りを払わないため。
   * 戻り値を待たない: 配置（`#place`）の応答を畳み終わるまで待たせないため。再試行はしない。
   */
  autoFoldOnPlacementPressure(
    runnerId: string,
    pids: { readonly current: number; readonly max: number },
  ): void {
    if (!isPidsUnderPressure(pids)) return;
    void this.list()
      .then((managers) => this.#autoFoldIdleOnRunnerIfUnderPressure(runnerId, pids, managers))
      .catch((error: unknown) => {
        void this.#journal({
          type: 'decision',
          decision:
            `[auto-fold-skip] runner=${runnerId} の配置契機（manager_start の自動配置）で` +
            `畳み処理そのものが例外で落ち、判定できなかった: ${reasonOf(error)}`,
          grounds:
            'デーモンの自動畳み（Issue #1394 の2つ目の契機。manager_start の配置経由）: ' +
            '例外により判定不能（判定できないときは畳まない側へ倒す）',
        });
      });
  }

  runnerPidsSaturation(runnerId: string): PidsSaturation | undefined {
    return this.#runners.pidsSaturationOf?.(runnerId);
  }

  async runnerIdOf(managerId: string): Promise<string | undefined> {
    const record = this.#records.get(managerId);
    // 像が `runnerId` を持たなくても、それが正しい「いまの」値なので台帳へ降りて上書きしない。
    if (record !== undefined) return record.job.runnerId;
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    return job?.runnerId;
  }

  async transcript(managerId: string): Promise<ManagerTranscript> {
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    if (!job) {
      // 読めない形で在る行は `missing`（＝居ない）にしない。
      const unreadable = await this.#unreadableRowDetail(managerId);
      return unreadable === undefined
        ? { kind: 'missing' }
        : { kind: 'unreadable', detail: unreadable };
    }

    const record = this.#records.get(managerId);
    if (record) {
      const runner = await this.#runnerOf(record);
      const live = await runner?.transcript(managerId).catch(() => null);
      if (live !== null && live !== undefined && live.length > 0)
        return { kind: 'body', body: live };
    }

    // 「消された」を単に飛ばさない: どこにも本文が無かったとき、missing と見分けが付かない `null` へ畳まず詳細を返すため。
    let removed: { archiveId: string; removedAt: string; bytes: number } | undefined;
    for (const id of [...(job.archiveIds ?? [])].reverse()) {
      const result = await this.#stores.archive.read(id);
      if (result.kind === 'body') return { kind: 'body', body: result.body, archiveId: id };
      if (result.kind === 'removed' && removed === undefined) {
        removed = { archiveId: id, removedAt: result.removedAt, bytes: result.bytes };
      }
    }

    const fromSessionStore = await this.#fromSessionStore(job);
    if (fromSessionStore !== null) return { kind: 'body', body: fromSessionStore };

    // 本文が残る他の経路のほうが有用なので、`removed` は最後まで返さない。
    return removed !== undefined ? { kind: 'removed', ...removed } : { kind: 'missing' };
  }

  async unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal; source?: UnpushedWorkObservationSource },
  ): Promise<ManagerUnpushedWork> {
    // 像が無いときは台帳へ降りて再構築せず、台帳へも書かない: 書く相手（`record.job`）が無く、再構築の費用が釣り合わない稀な競合のため。
    const record = this.#records.get(managerId);
    if (record === undefined) {
      return { kind: 'unavailable', reason: 'この委譲はいま像を持っていない（走行中ではない）。' };
    }
    // 観測の時刻は問い合わせる前に取る: 後で取ると遅れて返った観測がいつも新しくなり、上書きガードが働かない。
    const observedAt = new Date(this.#now()).toISOString();
    const outcome = await this.#probeUnpushedWork(managerId, record, options);
    await this.#recordUnpushedWorkObservation(record, outcome, options?.source, observedAt);
    return outcome;
  }

  /** `unpushedWork()` の実際の調べもの（台帳への書き込みは呼び出し元が持つ）。 */
  async #probeUnpushedWork(
    managerId: string,
    record: ManagerRecord,
    options?: { signal?: AbortSignal },
  ): Promise<ManagerUnpushedWork> {
    const runner = await this.#runnerOf(record);
    if (runner === null) {
      return { kind: 'unavailable', reason: '宛先の runner がいま開いていない。' };
    }
    if (runner.unpushedWork === undefined) {
      return {
        kind: 'unavailable',
        reason: 'この runner はこの口を持たない（古い版、またはテストの偽物）。',
      };
    }
    try {
      const result = await runner.unpushedWork(managerId, options);
      if (result === undefined) {
        return {
          kind: 'unavailable',
          reason: 'runner が答えなかった（セッションが無い・期限切れ・古い版のいずれか）。',
        };
      }
      return { kind: 'ok', result };
    } catch (error) {
      return { kind: 'unavailable', reason: `runner への問い合わせが失敗した: ${reasonOf(error)}` };
    }
  }

  /**
   * 古い観測で上書きしない: `report` / `tool_use` の fire-and-forget と `closed` / `shutdown_unpushed_work` の
   * 書き込みは非同期に競走し、どちらが先に着いても新しいほうが勝つ必要があるため。
   * `source` は比較に加えない: 経路が偉いからという理由で古い観測を残さない。
   */
  async #recordUnpushedWorkObservation(
    record: ManagerRecord,
    outcome: ManagerUnpushedWork,
    source: UnpushedWorkObservationSource | undefined,
    observedAt?: string,
  ): Promise<void> {
    const at = observedAt ?? new Date(this.#now()).toISOString();
    const observation = unpushedWorkObservationOf(outcome, at, source);
    if (
      !isUnpushedWorkObservationAtLeastAsNewAs(observation, record.job.lastUnpushedWorkObservation)
    ) {
      return;
    }
    record.job.lastUnpushedWorkObservation = observation;
    await this.#persist(record);
  }

  /**
   * 待たない（`void` で切り離す）: `unpushedWork()` は runner への HTTP 往復を含み、待つと報告の配達や日誌の書き込みにその時間が乗るため。
   * `.catch()` を添える: 設計が崩れても、呼び出し元を巻き添えにしないことをこの関数の形で保証する。
   */
  #observeUnpushedWorkOnce(managerId: string, source: 'report' | 'tool_use'): void {
    if (this.#unpushedWorkObservationInFlight.has(managerId)) return;
    this.#unpushedWorkObservationInFlight.add(managerId);
    void this.unpushedWork(managerId, {
      signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
      source,
    })
      .catch(() => undefined)
      .finally(() => {
        this.#unpushedWorkObservationInFlight.delete(managerId);
      });
  }

  runningManagerOwning(archiveId: string): string | undefined {
    // 台帳へは降りない: `#retire()` 済みの委譲はもう走っておらず、保護が要らないため。
    for (const record of this.#records.values()) {
      if ((record.job.archiveIds ?? []).includes(archiveId)) return record.job.id;
    }
    return undefined;
  }

  runningManagerPinning(archiveId: string): string | undefined {
    // 末尾だけを保護する: それより古い写しは末尾に含まれるので要らない。
    for (const record of this.#records.values()) {
      if ((record.job.archiveIds ?? []).at(-1) === archiveId) return record.job.id;
    }
    return undefined;
  }

  /**
   * 対象の門は費用の門であって判定の門ではない: 絞られた側を「症状ではない」とは言わない。
   * 1件の失敗でループを止めない。
   */
  async probeTurnEnds(): Promise<void> {
    const now = this.#now();
    for (const record of this.#records.values()) {
      try {
        if (record.job.status !== 'running') continue;
        const updatedAt = Date.parse(record.job.updatedAt);
        if (!Number.isNaN(updatedAt) && now - updatedAt < TURN_END_PROBE_QUIET_MS) continue;

        const managerId = record.job.id;
        const lastProbedAt = this.#turnEndProbedAt.get(managerId);
        const backoffMs =
          record.turnEndedAt === undefined
            ? TURN_END_PROBE_BACKOFF_MS
            : TURN_END_PROBE_BACKOFF_FLAGGED_MS;
        if (lastProbedAt !== undefined && now - lastProbedAt < backoffMs) continue;

        this.#turnEndProbedAt.set(managerId, now);
        await this.#probeTurnEndOf(record);
      } catch {
        // 1件の失敗で残りを止めない。古い助言が残るのは「揮発してよい」側の代償。
      }
    }
  }

  /** `record` が無いときは「観測が無い」として渡す: `'unknown'` に落ち、`'active'`（進んでいる）へは倒れない。 */
  #activityInputOfRecord(record: ManagerRecord | undefined): ManagerActivityInput {
    if (record === undefined) return { waitingCount: 0 };
    return {
      turnEndReason: record.turnEndReason,
      turnEndedAt: record.turnEndedAt,
      lastReportAt: record.job.lastReportAt,
      toolUseStallPending: record.toolUseStallPending,
      waitingCount: record.waiting.length,
    };
  }

  /**
   * エピソードにつき1本だけ配る: 在庫ごと `delete` すると周期のたびに同じ合図が立ち直るため。
   * 配らない回も畳まない（次の本物の報告か `case 'closed'` で件数ごと配る）。
   * 判定が変わったときの立て直しや、基準を `lastAt` から `firstAt` へ変えることはしない:
   * 変化は `manager_list` で読め、後者は別の面の話のため。
   */
  async flushWithheldReports(): Promise<void> {
    const now = this.#now();
    for (const [managerId, memory] of [...this.#withheldReports.entries()]) {
      try {
        if (memory.flushedAt !== undefined) continue;
        if (memory.count === 0) continue;
        if (!withheldReportOverdue(memory.lastAt, now, this.#withheldReportFlushMs)) continue;
        const activity = classifyManagerActivity(
          this.#activityInputOfRecord(this.#records.get(managerId)),
        );
        this.#emit(
          managerId,
          'report',
          `[${managerId}] 背景処理の完了待ちで畳んだ報告が、次のターンの完了を` +
            `${String(Math.round(this.#withheldReportFlushMs / 60_000))}分待っても届かなかった。` +
            'まとめて配る。' +
            describeBackgroundWaitElapsed(memory.firstAt, now) +
            describeManagerActivityForFlush(activity),
          undefined,
          undefined,
          'flush',
        );
      } catch {
        // 1件の失敗で残りを止めない。
      }
    }
  }

  /**
   * 2つの探りの間で調停を書かない: 同じ行を見て両方が同時に立つことは無く、それぞれが自分の欄だけを見る。
   * 読めない・解析できないときは欄を `undefined` に戻す: 分からないものを症状に化けさせない。
   */
  async #probeTurnEndOf(record: ManagerRecord): Promise<void> {
    // `removed` / `missing` は「探る本文が無い」として扱う: tombstone の事実を助言に反映する意味は無い。
    let transcript: string | null;
    try {
      const result = await this.transcript(record.job.id);
      transcript = result.kind === 'body' ? result.body : null;
    } catch {
      transcript = null;
    }
    if (transcript === null || transcript.length === 0) {
      delete record.turnEndedAt;
      delete record.turnEndReason;
      delete record.turnEndTail;
      delete record.toolUseStallAt;
      delete record.toolUseStallPending;
      return;
    }

    const probe = probeTurnEnd(transcript);
    if (probe === undefined) {
      delete record.turnEndedAt;
      delete record.turnEndReason;
      delete record.turnEndTail;
    } else {
      if (probe.timestamp === undefined) {
        delete record.turnEndedAt;
      } else {
        record.turnEndedAt = probe.timestamp;
      }
      record.turnEndReason = probe.stopReason;
      record.turnEndTail = probe.tail;
    }

    const stall = probeToolUseStall(transcript);
    if (stall === undefined) {
      delete record.toolUseStallAt;
      delete record.toolUseStallPending;
      return;
    }
    if (stall.timestamp === undefined) {
      delete record.toolUseStallAt;
    } else {
      record.toolUseStallAt = stall.timestamp;
    }
    record.toolUseStallPending = stall.pending;
  }

  /** runner ごと作り直されていたら実際に resume する: 「話しかけられるまで止めておく」は人間の不在で仕事が止まらないという要件に反する。 */
  async restore(): Promise<ManagerSummary[]> {
    // 同時に2本走らせず列に並べる: `#restoring` は1本ぶんの旗しか持てず、重ねると後の呼びが旗を上書きして `#reattach` が同時に走り、同じ仕事を二本起こす。
    const run = this.#restoreQueue.then(() => this.#restoreExclusive());
    this.#restoreQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async resumeStoppedByUsage(): Promise<string[]> {
    if (this.#stopped) return [];
    // 印が立っていないものも借りに載せる: 古い鍵で走っていた委譲はこれから枠に落ちうるが、回転は既に終わっていて鍵の側からの契機は二度と来ない。台帳には降りない: 台帳にしか無い委譲は `restore()` が拾う。
    for (const [managerId, record] of this.#records) {
      const status = record.job.status;
      if (status === 'running' || status === 'waiting_human') this.#usageWakeOwed.add(managerId);
    }

    const nudged: string[] = [];
    for (const managerId of [...this.#usageStopped]) {
      if (this.#stopped) break;
      const outcome = await this.#nudgeForUsageRotation(managerId);
      if (outcome === 'still-running') continue;
      // `'skipped'`（届かなかった）の印を下ろさない: 空振りで印を失うと、次に拾われるには新しい `usage_notice` が要り、それにはその委譲自身が起きる必要があって、クローンが手で `manager_send` を打つまで戻らなくなる。
      // 回数上限・時間間隔は置かない: 戻れない委譲は `resume_failed` で印ごと畳まれ、鍵の回転は枠の単位で決まるので暴走せず、実測なしに数を決めない。
      if (outcome === 'skipped') continue;
      await this.#clearUsageStoppedMark(managerId);
      this.#usageWakeOwed.delete(managerId);
      if (outcome === 'nudged') nudged.push(managerId);
    }
    return nudged;
  }

  async settleStalledUsageWakes(): Promise<string[]> {
    if (this.#stopped) return [];
    const nudged: string[] = [];
    // `#usageWakeOwed` ではなく `#records` を起点に走査する: 借りの managerId は `abort()` / `#retire()` で `#records` から先に消えうる。
    for (const [managerId, record] of [...this.#records]) {
      if (this.#stopped) break;
      try {
        // 条件1: 借りが立っている（鍵が戻ったと回し手が言った時点でまだ走っていた）。
        if (!this.#usageWakeOwed.has(managerId)) continue;
        // 条件2: 枠で止まったことが分かっている（一般の停滞検知にしない門）。
        if (!this.#usageStopped.has(managerId)) continue;
        // 条件3: `waiting_human` は含めない: 待っているのは枠ではなく人間の回答。
        if (record.job.status !== 'running') continue;
        // 条件4: 「分からない」を症状へ倒さない（`turnEndedAt` が無ければ発火しない）。
        if (record.turnEndedAt === undefined) continue;
        const turnEndedAt = Date.parse(record.turnEndedAt);
        if (Number.isNaN(turnEndedAt)) continue;
        if (record.job.lastReportAt !== undefined) {
          const lastReportAt = Date.parse(record.job.lastReportAt);
          if (Number.isNaN(lastReportAt)) continue;
          if (turnEndedAt <= lastReportAt) continue;
        }

        // 借りは挑む前に下ろす: 同じ委譲を毎分掃き続けないため。
        this.#usageWakeOwed.delete(managerId);
        const outcome = await this.#nudgeForUsageRotation(managerId, { allowRunning: true });
        // `#settleUsageWake` / `resumeStoppedByUsage()` と同じ規則: `skipped`（届かなかった）は印を残して次の回転に拾い直させる。
        if (outcome === 'nudged' || outcome === 'gone') {
          await this.#clearUsageStoppedMark(managerId);
        }
        if (outcome === 'nudged') nudged.push(managerId);
      } catch (error) {
        // 1件の失敗で残りを止めないが、黙って握らない: 起きないはずの例外が跡に残らないと、掃きが動いていない回と「対象が無かった」回が見分けられない。
        noteDroppedRecord('枠で止まった借りの清算', `managerId=${managerId}`, error);
      }
    }
    return nudged;
  }

  async sweepRescueRefs(): Promise<void> {
    if (this.#stopped || this.#rescueSweeping) return;
    const startedAt = this.#now();
    if (
      this.#rescueSweptAt !== undefined &&
      startedAt - this.#rescueSweptAt < RESCUE_SWEEP_INTERVAL_MS
    ) {
      return;
    }
    this.#rescueSweeping = true;
    try {
      let jobs: Job[];
      try {
        jobs = await this.#stores.jobs.listJobs();
      } catch (error) {
        noteDroppedRecord('退避 ref の後始末', '台帳を読めなかった', error);
        return;
      }
      this.#rescueSweptAt = startedAt;
      // 1回あたりの上限（本数と時間）。GitHub 障害の初回などで削除が溜まっていても、
      // 残りは次の回へ回す。
      const budget = {
        deletesLeft: RESCUE_SWEEP_MAX_DELETES,
        until: startedAt + RESCUE_SWEEP_BUDGET_MS,
      };
      for (const job of jobs) {
        if (this.#stopped || budget.deletesLeft <= 0 || this.#now() >= budget.until) break;
        if (job.lastRescue === undefined) continue;
        try {
          await this.#sweepRescueOf(job.id, job, budget);
        } catch (error) {
          noteDroppedRecord('退避 ref の後始末', `managerId=${job.id}`, error);
        }
      }
    } finally {
      this.#rescueSweeping = false;
    }
  }

  async #sweepRescueOf(
    managerId: string,
    listed: Job,
    budget: { deletesLeft: number; until: number },
  ): Promise<void> {
    // 生きた像が在るなら、そちらが正（書き戻しで台帳を上書きされないため）。
    const record = this.#records.get(managerId);
    const job = record?.job ?? listed;
    let rescue = job.lastRescue;
    if (rescue === undefined) return;
    // 終端を初めて見た時刻を台帳に残す（猶予の起点。`rescue-cleanup.ts`）。変わらなければ書かない。
    const nowIso = new Date(this.#now()).toISOString();
    const marked = syncTerminalMark(job.status, rescue, nowIso);
    if (marked !== null) {
      const wrote = await this.#updateRescueLedger(
        managerId,
        (current) => syncTerminalMark(job.status, current, nowIso),
        false,
        rescue,
      );
      if (!wrote) return;
      rescue = marked;
    }
    const now = this.#now();
    for (const tree of rescue.worktrees) {
      if (this.#stopped || budget.deletesLeft <= 0 || this.#now() >= budget.until) return;
      const reason = rescueRemovalDue(job.status, rescue, tree, now);
      const pushed = tree.pushed;
      if (reason === undefined || pushed === undefined) continue;
      budget.deletesLeft -= 1;
      const outcome = await this.#deleteRescueRefVia(job, pushed);
      const at = new Date(this.#now()).toISOString();
      const attempts = outcome.ok
        ? undefined
        : (pushed.removal?.failureKind === undefined ? 0 : (pushed.removal.attempts ?? 1)) + 1;
      const removal: RescueRemoval = outcome.ok
        ? { at, reason }
        : {
            at,
            reason,
            failureKind: outcome.kind,
            ...(attempts === undefined ? {} : { attempts }),
          };
      const applied = await this.#updateRescueLedger(managerId, (current) => {
        const index = current.worktrees.findIndex(
          (w) =>
            w.relativePath === tree.relativePath &&
            w.pushed?.commit === pushed.commit &&
            w.pushed.ref === pushed.ref,
        );
        const target = current.worktrees[index];
        if (index < 0 || target?.pushed === undefined) return null;
        const worktrees = [...current.worktrees];
        worktrees[index] = { ...target, pushed: { ...target.pushed, removal } };
        return { ...current, worktrees };
      });
      if (!applied) continue;
      // 日誌。消した回は必ず。消せなかった回は初回と分類が変わった回だけ（再試行のたびに積まない）。
      if (outcome.ok) {
        await this.#journal({
          type: 'decision',
          decision: `退避 ref ${pushed.ref} を origin から消した（${RESCUE_REMOVAL_REASON_JOURNAL[reason]}）。`,
          grounds:
            `作業ツリー ${tree.relativePath}、退避 commit ${pushed.commit.slice(0, 8)}。` +
            (outcome.alreadyGone ? '消そうとしたときには既に無かった。' : '') +
            '台帳の pushed は残し、消した時刻と理由を removal に付けた。',
        });
      } else if (pushed.removal?.failureKind !== outcome.kind) {
        await this.#journal({
          type: 'decision',
          decision: `退避 ref ${pushed.ref} を消せなかった（${outcome.kind}）。`,
          grounds:
            `理由の分類のみ記録（${RESCUE_REMOVAL_REASON_JOURNAL[reason]}ので消そうとした）。` +
            '間隔を空けて再試行する。台帳の pushed.removal に回数が残る。',
        });
      }
    }
    // 台帳から、もう要らない作業ツリーの項目を落とす（C3）。**先に同期で評価し、変わるときだけ
    // 書く**（変わらない委譲へ10分ごとに UPDATE を打たない）。
    await this.#updateRescueLedger(
      managerId,
      (current) => pruneRescueLedger(job.status, current, this.#now()),
      true,
      job.lastRescue,
    );
  }

  /**
   * 台帳の `lastRescue` を書き換える。`mutate` は同期で、`null` は「変えない」、
   * `undefined` は「欄ごと外す」（`allowRemove` のときだけ）。変えたら `true`。
   * 生きた像（`#records`）が在るならそちらを書いて `#persist`、無ければ台帳を
   * 排他区間の中で読み直して書く（`updateJob`）。
   */
  async #updateRescueLedger(
    managerId: string,
    mutate: (current: LastRescue) => LastRescue | undefined | null,
    allowRemove = false,
    snapshot?: LastRescue,
  ): Promise<boolean> {
    const record = this.#records.get(managerId);
    if (record !== undefined) {
      const current = record.job.lastRescue;
      if (current === undefined) return false;
      const next = mutate(current);
      if (next === null || (next === undefined && !allowRemove)) return false;
      if (next === undefined) delete record.job.lastRescue;
      else record.job.lastRescue = next;
      await this.#persist(record);
      return true;
    }
    // 手元の像で「変わらない」と分かるなら、台帳を開かない（行ロック・キャッシュ無効化を避ける）。
    if (snapshot !== undefined) {
      const probe = mutate(snapshot);
      if (probe === null || (probe === undefined && !allowRemove)) return false;
    }
    let changed = false;
    await this.#stores.jobs.updateJob(managerId, (current) => {
      if (current.lastRescue === undefined) return current;
      const next = mutate(current.lastRescue);
      if (next === null || (next === undefined && !allowRemove)) return current;
      changed = true;
      if (next !== undefined) return { ...current, lastRescue: next };
      const rest = { ...current };
      delete rest.lastRescue;
      return rest;
    });
    return changed;
  }

  /**
   * runner の `deleteRescueRef` で撃つ。宛先は委譲の runner、無ければ（器が入れ替わった・
   * 古い）名簿に開いている別の runner——資格は器ごとに降りているので、どれも消せる。
   * **口を持たない・答えない・投げる runner に「消した」を書かせない**（`failed` へ倒す）。
   */
  async #deleteRescueRefVia(
    job: Job,
    pushed: NonNullable<RescueWorktree['pushed']>,
  ): Promise<{ ok: true; alreadyGone: boolean } | { ok: false; kind: RescueRemovalFailureKind }> {
    if (pushed.remote === undefined) return { ok: false, kind: 'no-remote' };
    const primary = await this.#runnerOf({ job, waiting: [], attached: false });
    const open = await this.#runners.list().catch(() => []);
    const seen = new Set<string>();
    const candidates = [primary, ...open].filter((candidate): candidate is RunnerClient => {
      if (candidate === null || candidate.deleteRescueRef === undefined) return false;
      if (seen.has(candidate.runnerId)) return false;
      seen.add(candidate.runnerId);
      return true;
    });
    if (candidates.length === 0) return { ok: false, kind: 'no-runner' };
    // 旧 runner が混在するとき（口が 404 → `other`）は次の runner へ進む。`auth` / `moved` /
    // `network` / `timeout` は他の runner でも同じ結果になるか、別の runner が消してはいけない
    // もの（lease）なので、そこで止める。
    let last: RescueRemovalFailureKind = 'no-runner';
    for (const runner of candidates) {
      try {
        const result = await runner.deleteRescueRef?.(
          { remote: pushed.remote, ref: pushed.ref, commit: pushed.commit },
          { signal: AbortSignal.timeout(RESCUE_DELETE_DEADLINE_MS) },
        );
        if (result === undefined) continue;
        if (result.outcome === 'removed') return { ok: true, alreadyGone: result.alreadyGone };
        last = result.kind;
        if (result.kind !== 'other') break;
      } catch {
        last = 'other';
      }
    }
    return { ok: false, kind: last };
  }

  async renotifyStalledDenials(): Promise<void> {
    if (this.#stopped) return;
    const now = this.#now();
    for (const [managerId, record] of [...this.#records]) {
      if (this.#stopped) break;
      // `waiting_human` を丸ごと弾かない: 無関係な未決の確認が1件あるだけで無関係な拒否まで巻き添えになるため、判定は拒否1件ごとに行う。
      const deniedLastAt = record.deniedLastAt;
      if (deniedLastAt === undefined || deniedLastAt.size === 0) continue;
      for (const [key, deniedAt] of [...deniedLastAt]) {
        try {
          this.#renotifyStalledDenial(managerId, record, key, deniedAt, now);
        } catch (error) {
          noteDroppedRecord('止まった拒否の知らせ直し', `managerId=${managerId}・鍵=${key}`, error);
        }
      }
    }
  }

  #renotifyStalledDenial(
    managerId: string,
    record: ManagerRecord,
    key: string,
    deniedAt: string,
    now: number,
  ): void {
    const deniedAtMs = Date.parse(deniedAt);
    // 読めない時刻は症状として扱わない（判定できないという3つ目の状態）。
    if (Number.isNaN(deniedAtMs)) return;

    // `job.status === 'waiting_human'` を代理指標にしない: この拒否自身の `requestId` を持つ未決の確認があるときだけ見送る。無関係な確認が未決でも知らせ直しを止める理由にならない。
    const ownRequestId = record.deniedLastRequestId?.get(key);
    if (
      ownRequestId !== undefined &&
      record.waiting.some((item) => item.requestId === ownRequestId)
    ) {
      return;
    }

    const progressedAt = laterIso(record.job.lastReportAt, record.lastToolSettledAt);
    if (progressedAt !== undefined && progressedAt > deniedAt) {
      record.deniedRenotify?.delete(key);
      return;
    }

    // 同じ鍵に新しい拒否が来ていたら古いエピソードの帳面は使わない: 新しい拒否は新しい注意に値する。
    const existing = record.deniedRenotify?.get(key);
    const stage = existing?.deniedAt === deniedAt ? existing.stage : 0;
    const delayMs = DENIAL_RENOTIFY_DELAYS_MS[stage];
    if (delayMs === undefined) return; // 出し切って黙っている（stage が上限に達した）

    const dueAt = deniedAtMs + delayMs;
    if (now < dueAt) return; // まだこの段の時間に達していない

    const nextStage = stage + 1;
    (record.deniedRenotify ??= new Map()).set(key, { deniedAt, stage: nextStage });
    // 実際に配る直前に更新する: `#choosePending` が読むのは届いた知らせ直しであって、知らせ直そうとした事実ではない。
    record.lastDenialRenotify = { at: new Date(now).toISOString(), key };

    const { tool, actor } = decodeDenialKey(key);
    const actorLabel =
      actor === 'manager' ? 'マネージャー自身' : actor === 'worker' ? '作業者' : 'どちらの層か不明';
    const reason = record.deniedLastReason?.get(key);
    const elapsedMinutes = Math.round((now - deniedAtMs) / 60_000);

    this.#emit(
      managerId,
      'report',
      `[${managerId}] ${codeSpan(tool)} の拒否（${actorLabel}）から${String(elapsedMinutes)}分、` +
        `動きが無い（知らせ直し ${String(nextStage)}/${String(DENIAL_RENOTIFY_DELAYS_MS.length)} 回目。` +
        'issue #1105 C）。' +
        (reason?.inputHead === undefined
          ? ''
          : `\n拒否より前に見た入力の先頭（伏せ字・最大160字）: ${codeSpan(reason.inputHead)}`) +
        DENIAL_REPLY_ROUTE +
        '\n全件は日誌に残っている（`journal_read` で辿れる）。',
    );

    if (nextStage === DENIAL_RENOTIFY_DELAYS_MS.length) {
      void this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text:
          `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] ${tool} の拒否（${actorLabel}）の知らせ直しを` +
          `${String(nextStage)}回とも出したので、これ以上は黙る（issue #1105 C）。`,
      });
    }
  }

  /**
   * 印と借りは呼び出し側が下ろす: 呼び出し元によって下ろす条件が違う。
   * `'gone'`（台帳に居ない・`stopped`）は下ろしてよいが、`'skipped'`（届かなかった）は残す: 下ろすと次の鍵の回転でも二度と拾われない。
   * ホワイトリストで書く（`!== 'running' && …` の形にしない）: 状態が増えたとき既定が「起こす」＝1ターン焼く側へ倒れるのを避ける。
   * `allowRunning` が真でも `waiting_human` は通さない: 待っているのは枠ではなく人間の回答。
   * 投げない: 走査の途中で投げると、後ろに並んだ委譲が誰にも起こされないまま残る。
   */
  async #nudgeForUsageRotation(
    managerId: string,
    options?: { readonly allowRunning?: boolean },
  ): Promise<'nudged' | 'still-running' | 'gone' | 'skipped'> {
    try {
      const record = this.#records.get(managerId) ?? (await this.#load(managerId));
      if (record === null) return 'gone';
      const status = record.job.status;
      const allowRunning = options?.allowRunning === true;
      if (status === 'waiting_human') return 'still-running';
      if (status === 'running' && !allowRunning) return 'still-running';
      if (status !== 'running' && status !== 'done' && status !== 'failed' && status !== 'lost') {
        await this.#journal({
          type: 'decision',
          decision:
            `[${managerId}] 認証トークンが通る状態へ戻ったが、この委譲は起こし直さない` +
            `（status=${status}）。`,
          grounds: '人間・クローンが止めた委譲を、鍵が戻ったことを理由に甦らせない。',
        });
        return 'gone';
      }
      // 新しい経路を作らず `send()` に相乗りする: どちらの道でも会話は続き、最初からやり直しにならない。
      const result = await this.send(managerId, usageRotationNudge());
      if (result.outcome === 'delivered' || result.outcome === 'answered') return 'nudged';
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}[${managerId}] 認証トークンが通る状態へ戻ったので続きを促したが、届かなかった` +
          `（outcome=${result.outcome}）: ${result.detail}`,
      });
      return 'skipped';
    } catch (error) {
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'outbound',
        text:
          `${EXCHANGE_KIND_FAILURE_PREFIX}[${managerId}] 認証トークンが通る状態へ戻ったので続きを促したが、落ちた: ` +
          reasonOf(error),
      });
      return 'skipped';
    }
  }

  async #settleUsageWake(managerId: string, stoppedByUsage: boolean): Promise<void> {
    if (!this.#usageWakeOwed.has(managerId)) return;
    // 枠で止まったのでなければ借りだけ下ろす: 自力で終えたターンへ一言を投げると、1ターン焼いたうえに会話へ嘘の文脈が入る。
    if (!stoppedByUsage) {
      this.#usageWakeOwed.delete(managerId);
      return;
    }
    this.#usageWakeOwed.delete(managerId);
    // 印は起こせたと分かってから下ろす: 起こす前に下ろすと、空振りで印が消えて次の鍵の回転でも拾われなくなる。
    const outcome = await this.#nudgeForUsageRotation(managerId);
    if (outcome === 'skipped' || outcome === 'still-running') return;
    await this.#clearUsageStoppedMark(managerId);
  }

  /**
   * 材料は `#tokenIdentity`（プロセス内記憶）ではなく `this.#stores.tokens`（DB 正本）から読む: `tokenGeneration` が `undefined` の場面でも独立に判定できるようにするため。
   * 呼ぶ位置は `case 'usage_notice'` の最後: `await` を足すと並行に走る `report` との勝ち負けが変わり、配達の順が動く。読み取り専用の計器は配達の臨界路の後ろへ置く。
   * 失敗しても投げない: `undefined` は「世代ずれではない」ではなく「判定できなかった」。
   */
  async #rememberResetTimeSkew(event: {
    managerId: string;
    notice: UsageLimitNotice;
  }): Promise<void> {
    if (event.notice.kind !== 'reached') return;
    try {
      const [active, pool] = await Promise.all([
        this.#stores.tokens.readActive(),
        this.#stores.tokens.list(),
      ]);
      const match = matchNoticeResetAgainstPool(event.notice.text, active?.tokenId, pool, {
        at: this.#now(),
      });
      if (match === undefined) {
        this.#resetTimeSkewMatches.delete(event.managerId);
      } else {
        this.#resetTimeSkewMatches.set(event.managerId, match);
      }
    } catch (error) {
      noteDroppedRecord('resets時刻の突き合わせ', `managerId=${event.managerId}`, error);
    }
  }

  /**
   * `Set` と台帳の写しを1本で下ろす: 手書きで散らすと片方だけ消し忘れる食い違いが起きる。
   * `case 'report'` の自力完走の枝は呼ばない: 直後の `#persist(record)` に乗せて二重書きを避ける。
   * 投げない: 呼び出し元の後片付け（`#retire()` など）が走らないまま終わるため。
   */
  async #clearUsageStoppedMark(managerId: string): Promise<void> {
    this.#usageStopped.delete(managerId);
    // `#resetTimeSkewMatches` も同じ寿命で下ろす: 古い判定が次の当たりに貼り付かないように。
    this.#resetTimeSkewMatches.delete(managerId);
    try {
      const record = this.#records.get(managerId) ?? (await this.#load(managerId));
      if (record === null) return;
      if (record.job.usageStoppedAt === undefined) return;
      delete record.job.usageStoppedAt;
      await this.#persist(record);
    } catch (error) {
      noteDroppedRecord('枠で止まった印の解除', `managerId=${managerId}`, error);
    }
  }

  async reattachRunner(runnerId: string): Promise<void> {
    // 契機が増えても経路を増やさない: 「どちらの経路で拾われたか」で振る舞いが変わりうる。
    await this.#reattach(runnerId);
  }

  relocateFrom(runnerId: string): void {
    if (this.#stopped) return;
    // 新しい梯子は作らない: 貸し出しが生きていれば `#reattach` が断って `#scheduleReattach` の梯子に乗る。
    const targets = new Set(
      this.#runners
        .entries()
        .filter((entry) => entry.runnerId !== undefined && entry.runnerId !== runnerId)
        .filter((entry) => entry.state === 'connected')
        .map((entry) => entry.runnerId as string),
    );
    for (const target of targets) void this.#reattach(target);
  }

  async vacate(runnerId: string): Promise<VacateResult> {
    if (this.#stopped) return {};
    let result: VacateResult = {};

    // 先に立てる: 後にすると、貸し出しを返した直後の窓に新しい委譲が置かれ、drain が終わらなくなる。
    this.#runners.vacate(runnerId);

    // ジョブの一覧は台帳から引く: `#records`（プロセス内の像）はまだこのジョブを持っていないことがある。
    // 名簿を読めなかった回を「runner が名簿に居ない」とみなさない: 読めなかった回は握手も貸し出しの返却もせず、飛ばしたことを日誌と戻り値に残す。
    const runner: RunnerClient | null | 'unreadable' = await this.#runners
      .get(runnerId)
      .catch(async (error: unknown) => {
        await this.#journal({
          type: 'decision',
          decision: `runnerId=${runnerId} の vacate で、runner の名簿を読めなかったので、載っている委譲への確かめた停止の握手を飛ばした（貸し出しは返していない。vacate を呼び直すと握手をやり直す）`,
          grounds:
            `読めなかった原因: ${reasonOf(error)}。` +
            '名簿を読めなかったことは「runner が名簿に居ない」ではない（この回は握手を判定していない）。',
        });
        return 'unreadable' as const;
      });
    if (runner === 'unreadable') {
      result = {
        handshakeSkipped: {
          reason: 'runner_unreadable',
          message:
            `runnerId=${runnerId} の名簿を読めなかったので、載っている委譲への確かめた停止の握手を飛ばした` +
            '（貸し出しは返していない）。vacate を呼び直すと握手をやり直す。',
          retry: true,
        },
      };
    } else if (runner !== null && !this.#stopped) {
      // 一覧を読めなかった回を「載っている委譲が無い」とみなさない: 握手も貸し出しの返却も `attached` の書き込みもせず、飛ばしたことを日誌に残す。
      const jobs = await this.#listJobsOrNote(
        `runnerId=${runnerId} の vacate で、載っている委譲への確かめた停止の握手を飛ばした（貸し出しは返していない。vacate を呼び直すと握手をやり直す）`,
      );
      if (jobs === null) {
        result = {
          handshakeSkipped: {
            reason: 'jobs_unreadable',
            message:
              `台帳の委譲の一覧を読めなかったので、runnerId=${runnerId} の載っている委譲への確かめた停止の握手を飛ばした` +
              '（貸し出しは返していない）。vacate を呼び直すと握手をやり直す。',
            retry: true,
          },
        };
      }
      for (const job of jobs ?? []) {
        if (this.#stopped) break;
        if (job.runnerId !== runnerId) continue;
        const known = this.#records.get(job.id);
        const status = known?.job.status ?? job.status;
        if (status !== 'running' && status !== 'waiting_human') continue;
        const record = known ?? (await this.#load(job.id));
        if (record === null) continue;
        // `runner.stop()` の直前に1回取る: 生きて答えられる最後の機会。新しい outbox イベントは足さない: 喪失の窓を持つため、台帳へ直接書く既存の経路に乗る。
        // `.catch()` を添える: 観測の失敗が `#confirmStoppedAndReleaseLease` の判定を巻き添えにしないことをここの形で保証する。
        await this.unpushedWork(job.id, {
          signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
          source: 'vacate',
        }).catch(() => undefined);
        const { outcome } = await this.#confirmStoppedAndReleaseLease(record, runner, job.id);
        // `record.job.status` を書かず `#retire` も呼ばない: drain は移すためで、終端にすると `#reattach()` の関門に引っかかり二度と移送されない。
        // 貸し出しの解放は永続化する: しないと `#reattach` が期限切れまで移送を待つ。`sessionMissingKind` は立てない: 意図して止めたのであって resume に失敗したのではない。
        // await の間に別の runner へ移っていたら触らない: 「元の runner の一覧に居ない」は「移った」であり、動いている委譲に `attached = false` を書くことになる。
        if (outcome === 'stopped' && record.job.runnerId === runnerId) {
          record.attached = false;
          await this.#persist(record);
        }
      }
    }

    this.relocateFrom(runnerId);
    return result;
  }

  async #restoreExclusive(): Promise<ManagerSummary[]> {
    // await を挟む前に立てる: 同一プロセスの runner は `connect()` の中で同期的に名乗るので、遅れると `#reattach` が引き取りと同時に走り、同じ仕事を二重に起こす。
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

    const alive = new Map<
      string,
      { runner: RunnerClient; state: Awaited<ReturnType<RunnerClient['list']>>[number] }
    >();
    // 生死を聞けなかった器を覚える: 応答が無いことを「セッションが無い」と読むと、生きている仕事を二重に起こし、`gh pr create` のような取り返しのつかない操作が二度走る。
    const unheard = new Set<string>();
    // 状態は読めなかったが runner に居る委譲: 「居ない」と畳むと、まだ走っている委譲を resume し、待っていた確認を捨てる。
    const unreadable = new Map<string, RunnerClient>();
    for (const runner of await this.#runners.list()) {
      const listing = await listRunnerManagers(runner).catch((error: unknown) => {
        unheard.add(runner.runnerId);
        // 黙って引き下がらない: 跡が無いと「セッションが無かった」のか「聞けなかった」のかを誰も言えない。
        noteUnreadableRecord('runner のセッション一覧', `runnerId=${runner.runnerId}`, error);
        return null;
      });
      if (listing === null) continue;
      for (const state of listing.states) {
        alive.set(state.managerId, { runner, state });
      }
      for (const managerId of listing.unreadableIds) unreadable.set(managerId, runner);
    }

    const silent = this.#silentRunners();
    const registeredRunnerIds = this.#registeredRunnerIds();
    const resumed: ManagerSummary[] = [];
    for (const job of await this.#stores.jobs.listJobs()) {
      if (this.#records.has(job.id)) continue;

      // 下で `continue` される `lost` より前に置く: 印を組み直さないと `resumeStoppedByUsage()` が `lost` の委譲を回転の対象にすら入れない。
      if (job.usageStoppedAt !== undefined) this.#usageStopped.add(job.id);

      // 状態を読めなかったが runner に居る委譲は resume せずに引き取る: 生きているとしか読めない状態を名指しできないので `attached: false`（話しかけたら `host.resume()` が生きたセッションへ流して短絡する）。待ちは持ち越さず、`status` は台帳の値のまま。
      const unreadableOn = alive.has(job.id) ? undefined : unreadable.get(job.id);
      if (unreadableOn !== undefined) {
        const record: ManagerRecord = {
          job: { ...job, runnerId: unreadableOn.runnerId },
          waiting: [],
          attached: false,
          reattachedAcrossRestart: true,
        };
        this.#records.set(job.id, record);
        await this.#persist(record);
        continue;
      }

      const living = alive.get(job.id);
      if (living) {
        // `attached: true` を固定しない: runner が畳まれた `lost` / `failed` を名乗ることがあり、畳まれたセッションへの `push` は黙って捨てられるのに、届いたことにして台帳の終端状態を `running` へ巻き戻す。
        // `done` も同じ隙間を持つが、この一覧（`RunnerManagerState`）はどちらの `done` かを区別する材料を持たない。
        // だからホワイトリストで書く: ブラックリストに `done` を足す形は、状態が増えたとき既定が `attached: true`（危険側）へ倒れる。
        // 安全側に倒しても代償は無い: 待機している `done` は resume 扱いになるが、`host.resume()` が生きたセッションへ `push` して短絡する。
        const attached =
          living.state.status === 'running' || living.state.status === 'waiting_human';
        // 台帳の `cwd` を runner が実際に開いているセッションの値へ揃える: 頼んだだけの古い値を持ち越すと、`manager_list` / Web UI が実際と違う `cwd` を名乗り続ける。
        const record: ManagerRecord = {
          job: {
            ...job,
            status: living.state.status,
            runnerId: living.runner.runnerId,
            cwd: living.state.cwd,
            workspace: workspaceLocatorFrom(
              this.#workspace,
              living.runner.runnerId,
              living.state.cwd,
            ),
            ...(living.state.sessionId === undefined ? {} : { sessionId: living.state.sessionId }),
          },
          waiting: living.state.waiting,
          attached,
          reattachedAcrossRestart: true,
        };
        this.#records.set(job.id, record);
        // `#rememberTokenIdentity(job.id)` を呼ばない: 引き取っただけでセッションの env は古い世代の鍵のままなので、観測しただけの現役の世代を書くと本物の食い違いが「一致」に化ける。
        // 記録が無いままにする: 嘘の「一致」より、取れない軸に0の行を作らず正直に「材料が無い」を選ぶ。理由は `reattachedAcrossRestart` で名乗る。
        await this.#persist(record);
        if (attached) this.#notifyRestored(record, 'attached');
        resumed.push(
          summaryOf(
            record,
            isLive(record, silent),
            lostSinceOf(record, silent),
            vanishedOf(record, registeredRunnerIds),
            record.sessionMissingSince,
            record.turnEndedAt,
            record.turnEndReason,
            record.turnEndTail,
            record.toolUseStallAt,
            record.toolUseStallPending,
            this.#awaitingBackgroundOf(record.job.id),
            this.#tokenIdentities.get(record.job.id)?.generation,
            this.#tokenIdentity?.()?.generation,
            this.#tokenIdentity !== undefined,
            this.#resetTimeSkewMatches.get(record.job.id),
            this.#usageStopped.has(record.job.id) ? record.job.usageStoppedAt : undefined,
            undefined,
          ),
        );
        continue;
      }

      // 聞けなかった器のジョブは触らず、`#records` へ載せる前に抜ける: 「`alive` に居ない」は「確かめられなかった」であり、載せなければ次の `restore()` が拾い直す。宛先の無いジョブは聞けなかった器が1台でもあれば同じ扱いにする。
      if (unheard.size > 0 && (job.runnerId === undefined || unheard.has(job.runnerId))) continue;

      if (job.sessionId === undefined) continue;

      // 戻せないものを「居る」ことにしない: `#records` へ載せると `list()` が `live: true` で見せ、腐った session_id しか持たない相手に話しかければ続くように見える。
      if (job.status === 'lost') continue;

      // 古い写し（ループ先頭の `job`）で resume を決めない: 待っている間に `abort()` が `stopped` を書いて `#retire` していると、`stopped` を `running` で上書きして起こし直す。resume しうる写しだけ像を載せる直前に読み直し、`await` の間に像が載りうるので読んだ後にもう一度 `#records` を見る。
      const resumable = job.status === 'running' || job.status === 'waiting_human';
      const fresh = resumable ? ((await this.#latestJobOf(job.id)) ?? job) : job;
      if (resumable && this.#records.has(job.id)) continue;
      if (fresh.status === 'lost') continue;

      const record: ManagerRecord = { job: { ...fresh }, waiting: [], attached: false };
      this.#records.set(job.id, record);

      if (fresh.status !== 'running' && fresh.status !== 'waiting_human') continue;

      const runner = await this.#runnerOf(record);
      if (!runner) continue;

      // cause は `'runner'`: runner がセッションを知らないのは器の入れ替わり（作業ツリーが消えている）と区別できず、`'daemon'` だと枝名の clone 案内と「コミット前の変更は失われている」が出ない。
      const nudge = restartNudge(
        fresh.status,
        'runner',
        fresh.workspace,
        fresh.lastUnpushedWorkObservation,
      );
      // 1本が戻せなくても残りを道連れにしない: 投げると走査が止まり、後ろに並んだ委譲は `#records` にすら載らないまま台帳に `running` で残る（呼び出し元は例外を握り潰すので跡はログ1行だけ）。`#resumeOnce` の中の実 I/O は投げうる。
      // 同じ runner への resume が飛んでいる間は `closed` を預ける窓を立て、どの抜け方でも必ず1回閉じる。
      let windowOpen = false;
      let windowMoved = false;
      try {
        // 別の契機が resume 中なら窓は持たない: そちらの窓を壊さない。
        if (!this.#resuming.has(job.id)) {
          this.#sameRunnerResumeWindow.set(job.id, runner.runnerId);
          windowOpen = true;
        }
        let ok: ResumeOutcome;
        try {
          ok = await this.#resumeOnce(record, runner, nudge);
        } catch (resumeError) {
          if (windowOpen) {
            windowOpen = false;
            await this.#endRelocationWindow(job.id, false);
          }
          throw resumeError;
        }
        // 受理された回は `running` を persist した後に閉じる: 処理し直した結果を後から上書きしないため。
        if (windowOpen) {
          if (ok === 'resumed') {
            windowMoved = true;
          } else {
            windowOpen = false;
            await this.#endRelocationWindow(job.id, false);
          }
        }
        if (ok !== 'resumed') {
          // 貸し出し期限で断られたのは「まだ」: 黙って諦めると次の契機が永久に来ない（台帳では走っているのに誰も走っていない仕事が残る）ので、回数では諦めない梯子へ載せる。他の理由はここでは何もしない。
          if (ok === 'held-by-lease') {
            await this.#journal({
              type: 'decision',
              decision: leaseRefusalDecision(job.id, record.leaseRefusal),
              grounds: record.leaseRefusal?.detail ?? '（根拠を取れなかった）',
            });
            this.#scheduleReattach(runner.runnerId);
          }
          continue;
        }
        // `#resumeOnce` から戻った直後、他の await を挟む前に読む: `#resuming` の関門は既に外れており、await の隙間に別の契機が新しい resume を仕掛けて `record.cwdSwapNotice` を上書きしうる。
        const swapNotice = cwdSwapNoticeClause(record);
        // 受理は「戻れた」ではない: 失敗は SSE で追いかけてくるので、無条件に上書きすると書いたばかりの終端状態が `running` へ巻き戻る。
        if (record.job.status === 'lost') {
          if (windowOpen) {
            windowOpen = false;
            await this.#endRelocationWindow(job.id, windowMoved);
          }
          continue;
        }
        record.job.status = 'running';
        await this.#persist(record);
        // `runner.send()` の失敗は無視する: 本体の resume は成功しており、この一言が届かなくても致命ではない。
        if (swapNotice !== undefined) {
          await runner.send(job.id, swapNotice).catch(() => undefined);
        }
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'outbound',
          text:
            `${EXCHANGE_KIND_RECOVERY_PREFIX}[${job.id}] （再起動後の再開）${nudge}` +
            (swapNotice === undefined ? '' : ` ${swapNotice}`),
        });
        this.#notifyRestored(record, 'resumed', 'runner');
        resumed.push(
          summaryOf(
            record,
            isLive(record, silent),
            lostSinceOf(record, silent),
            vanishedOf(record, registeredRunnerIds),
            record.sessionMissingSince,
            record.turnEndedAt,
            record.turnEndReason,
            record.turnEndTail,
            record.toolUseStallAt,
            record.toolUseStallPending,
            this.#awaitingBackgroundOf(record.job.id),
            this.#tokenIdentities.get(record.job.id)?.generation,
            this.#tokenIdentity?.()?.generation,
            this.#tokenIdentity !== undefined,
            this.#resetTimeSkewMatches.get(record.job.id),
            this.#usageStopped.has(record.job.id) ? record.job.usageStoppedAt : undefined,
            undefined,
          ),
        );
        if (windowOpen) {
          windowOpen = false;
          await this.#endRelocationWindow(job.id, windowMoved);
        }
      } catch (error) {
        if (windowOpen) {
          await this.#endRelocationWindow(job.id, windowMoved);
        }
        if (isFencedRunnerError(error)) {
          // 世代で拒まれた（409）は「戻せなかった」ではない: `lost` にして像から外すと、クローンが新しく起こし直し、fencing の失敗経路から二重実行へ到達する。状態は動かさず挑み直さず、必ず知らせる。
          await this.#journal({
            type: 'decision',
            decision: `[${job.id}] 起動時の引き取りを止めた（runner がより新しい世代を持っている＝別の誰かが握っている）`,
            grounds: reasonOf(error),
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
              `台帳の貸し出しと runner の世代が食い違っています（デーモンが2つ走っているか、貸し出しの書き込みが落ちた可能性）。人間へ相談すること: ${reasonOf(error)}`,
            ...this.#statusAtDelivery(job.id),
          });
        } else if (isRetryableRunnerError(error)) {
          // 一時的なこけ方は黙って引き下がらない: 次の契機が永久に来ないことがあるので梯子へ載せる。
          this.#scheduleReattach(runner.runnerId);
        } else {
          // `running` のままにしない: resume を実際に試して戻れなかったので、`lost` は確かめた事実。
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

  /**
   * `abort()` と drain（`vacate()`）で判定を2箇所に持たない: 複製すると片方だけ直る不整合を作る。
   * 状態の書き込み（`'stopped'`・`#retire`・`record.attached`）は呼び出し元が決める: `vacate()` は移すためで、終端にすると `#reattach()` の関門に引っかかり二度と移送されない。
   * 貸し出しは引き取ってよいと言える判定のときだけ返す: 持ち主でない器に聞いて「無い」と言われただけで返すと、走り続けている委譲の唯一の防御まで外れる。判定は `judgeLease` / `mayClaim` に任せ、書き直さない。
   */
  async #confirmStoppedAndReleaseLease(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
  ): Promise<{
    outcome: 'stopped' | 'not_stopped' | 'unknown';
    stopError: unknown;
    sessionGone: boolean | undefined;
  }> {
    let stopError: unknown;
    try {
      await runner.stop(managerId);
    } catch (error) {
      stopError = error;
    }

    // 「受理した」で終わらせない: `runner.stop()` は該当セッションが無ければ黙って何もしないので、戻り値だけで「止まった」と言うと走り続けているものを止めたことにする。訊けなかったときは成功にせず undefined のまま返す。
    // `stop()` が投げていても探りは行う: 「消えた」と答えるなら止まったと言い切ってよい。状態を読めなかった委譲も「居る」側に数える: 「消えた」と読むと貸し出しを返し、別の器が引き取れる。
    const sessionGone = await listRunnerManagers(runner)
      .then(
        ({ states, unreadableIds }) =>
          !states.some((session) => session.managerId === managerId) &&
          !unreadableIds.includes(managerId),
      )
      .catch(() => undefined);

    const outcome: 'stopped' | 'not_stopped' | 'unknown' =
      sessionGone === true ? 'stopped' : sessionGone === false ? 'not_stopped' : 'unknown';

    if (outcome === 'stopped') {
      // 止まったと確かめた回だけ貸し出しを返す: `not_stopped` / `unknown` で返すと、まだ走っているセッションを別の器が引き取れる。
      const holder = record.job.lease;
      // 止めて確かめた runner 自身が握る貸し出しだけを返す: await の間に別の runner が引き取っていると `record.job.lease` は新しい runner のもので、返すと二重実行の芽になる。
      if (holder !== undefined && holder.runnerId === runner.runnerId) {
        // 判定を2値へ潰さず `judgeLease` に委ねる: 名乗らない runner では `holder.instanceId` が常に `undefined` で、`undecidable` が「返さない」側へ黙って倒れ、確かめた停止なのに貸し出しが解放されなかった。同じ判定を `#claimForResume` の関門と2つの式で書かない。
        const now = this.#now();
        const verdict = judgeLease({
          lease: holder,
          now,
          answering: this.#sighting(holder.runnerId),
        });
        if (mayClaim(verdict)) record.job.lease = releaseLease(holder, now);
      }
    }

    return { outcome, stopError, sessionGone };
  }

  async abort(
    managerId: string,
    reason?: string,
    by: ManagerStopActor = 'human',
  ): Promise<ManagerAbortResult> {
    await this.#ensureConnected();

    const who =
      by === 'clone' ? 'クローン' : by === 'auto-fold' ? 'デーモン（pids逼迫の自動畳み）' : '人間';

    const record = this.#records.get(managerId) ?? (await this.#load(managerId));
    if (!record) {
      // 読めない形で在る行は「居ない」と言わない。
      const unreadable = await this.#unreadableRowDetail(managerId);
      if (unreadable !== undefined) {
        return {
          outcome: 'unreadable',
          detail: `${unreadable}止めていない。行は書き換えていない。`,
        };
      }
      return { outcome: 'absent', detail: `${managerId} というマネージャーは居ない。` };
    }

    const runner = await this.#runnerOf(record);
    if (!runner) {
      // `'absent'` を返さない: マネージャーは存在し、宛先がいま開いていないだけで、`app.ts` が 404 にすると一時的な状態が「そんなものは無い」という終端になる。言い方は `send()` と同じものを使う: 同じ観測に2つの言い方を持たせると片方だけが直る。
      return { outcome: 'unknown', detail: this.#runnerNotOpenDetail(record) };
    }

    // 止めた意思を確かめる前に先に立てる: await の間に別の契機（`send()` や別 runner の `#reattach`）が同じ `ManagerRecord` で resume を進めると、走り続ける委譲を「止まった」と言う事故になる。台帳は `outcome === 'stopped'` を確かめてからしか書かない: これは意思の共有であって確定の記録ではない。
    record.stopConfirmedAt = new Date(this.#now()).toISOString();
    // await の前の宛先を覚えておく: await の後にこれと食い違えば、委譲は別の runner へ移っている。
    const runnerIdBeforeConfirm = record.job.runnerId;

    // `by` で条件分けせず全員に `runner.stop()` の直前の観測を取る: `'auto-fold'` の安全弁より「止める直前」に近く、新しいほうが上書きガードで勝つ。runner 側の best-effort な先取りを増やさず、生きて往復できるここで同期に取る。`.catch()` は観測の失敗で判定を巻き添えにしないため。
    await this.unpushedWork(managerId, {
      signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
      source: 'stop',
    }).catch(() => undefined);

    // `runner.stop()` が投げても abort() ごと reject させない: 日誌もクローンへの通知も状態の更新も残らず 500 になり、「止めた事実は日誌に残る」約束がいちばん要る場面で消える。権威は `sessionGone` の探りに置く（stop の RPC が返らなくても止まっていることがある）。
    let { outcome, stopError, sessionGone } = await this.#confirmStoppedAndReleaseLease(
      record,
      runner,
      managerId,
    );

    // 二重の網: 印を立てる前の await の間に `#reattach` が resume を終えていれば印では塞げないので、戻った直後に宛先の食い違いを見る。新しい持ち主に任せず止めた意思を優先し、確かめられなければ「台帳を書かない」側へ合流させる。
    if (outcome === 'stopped' && record.job.runnerId !== runnerIdBeforeConfirm) {
      const movedRunner = await this.#runnerOf(record);
      if (movedRunner === null) {
        outcome = 'unknown';
        stopError = undefined;
        sessionGone = undefined;
      } else {
        const moved = await this.#confirmStoppedAndReleaseLease(record, movedRunner, managerId);
        outcome = moved.outcome;
        stopError = moved.stopError;
        sessionGone = moved.sessionGone;
      }
    }

    if (outcome !== 'stopped') {
      // 印だけが確かめられた事実に追いつかないまま残らないよう下ろす。
      delete record.stopConfirmedAt;
    }

    // `#retire()` で `#withheldReports` のエントリが消えるので、読むのは必ずその前。中身（`lastText`）は載せない（R4）: 「止めた後は受信箱へ回さない」を覆さず、「積みが在った」事実の告知だけにする。
    let withheldNote = '';
    if (outcome === 'stopped') {
      record.waiting = [];
      record.attached = false;
      record.job.status = 'stopped';
      await this.#persist(record);
      const withheld = this.#withheldReports.get(managerId);
      // `count > 0` を条件にする: フラッシュ済みの在庫が残っていると、`withheld !== undefined` だけでは「報告を 0 本抱えたまま止まった」という嘘の1行が出る。
      if (withheld !== undefined && withheld.count > 0) {
        withheldNote =
          ` このマネージャーは、背景処理の完了待ちで畳んだ報告を ${String(withheld.count)} ` +
          `本抱えたまま止まった（最初 ${withheld.firstAt} / 最後 ${withheld.lastAt}）。` +
          'もう配られない（R4「止めた後は受信箱へ回さない」）。全文は日誌に在る（`journal_read`）。';
      }
      this.#retire(managerId);
    }
    // `'not_stopped'` / `'unknown'` のときは台帳を書かない: 生きているかもしれないマネージャーの `waiting` を畳まず、確かめていない状態を確定させない。「止めた」と言えるのは止まったと確かめたときだけ。

    const stopErrorNote =
      stopError === undefined ? '' : `（runner.stop() が例外を投げた: ${reasonOf(stopError)}）`;
    const attemptedBase =
      reason === undefined ? `${who}が停止を試みた。` : `${who}が停止を試みた: ${reason}`;
    const stoppedBase =
      reason === undefined ? `${who}が停止させた。` : `${who}が停止させた: ${reason}`;
    const detail =
      outcome === 'stopped'
        ? `${stoppedBase}${stopErrorNote}${withheldNote}`
        : outcome === 'not_stopped'
          ? `${attemptedBase}runner には ${managerId} のセッションがまだ残っている。止まっていない。${stopErrorNote}`
          : `${attemptedBase}runner に確認が取れず、止まったかは未確認。${stopErrorNote}`;
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      // `（停止）` はそのまま残す: テストが固定している。`[outcome=...]` は文の解釈なしに grep で数えられるようにする。
      text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] （停止）[outcome=${outcome}] ${detail}`,
    });
    // outcome ごとに言い分ける: 止まっていないのに「停止させました」と言うと、クローンは止まったつもりで次の判断へ進む。
    const messageText =
      outcome === 'stopped'
        ? `${managerId} を${who}が停止させました。${reason === undefined ? '' : `理由: ${reason}`}${withheldNote}`
        : outcome === 'not_stopped'
          ? `${managerId} を${who}が止めようとしましたが、まだ止まっていません` +
            `（runner にセッションが残っています）。`
          : `${managerId} を${who}が止めようとしましたが、止まったかどうか確認が取れませんでした。`;
    // `markup: 'none'` は人間が打った `reason` が実際に `messageText` へ入る回（`outcome === 'stopped'` の人間発）だけに立てる: 文字が1文字も入っていないメッセージに印を立てるのは、その text についての嘘になる。他の `#post` 呼び出し箇所には足さない。
    // クローン発に `markup: 'markdown'` を立てない: 「まだ決めていない」を `undefined` で残さないと、将来既定が反転したとき、確かめていない推定が方針変更の外へ生き残る。
    const markup: TextMarkup | undefined =
      outcome === 'stopped' && by === 'human' && reason !== undefined ? 'none' : undefined;
    // クローン発の停止は受信箱へ配らない: `manager_stop` の戻り値で同じターンに同期的に受け取る内容の真部分集合で新しい事実が無く、`manager_message` は束ねられないので、停止1本ごとにクローンのターン（システムプロンプトの読み直し）を1回焼く。日誌には条件を問わず残る。
    // 人間発は配る: クローンには戻り値が無く、他に知る手段が無い。
    if (by !== 'clone') {
      this.#post({
        type: 'manager_message',
        id: randomUUID(),
        at: new Date().toISOString(),
        managerId,
        kind: 'report',
        text: messageText,
        ...(markup === undefined ? {} : { markup }),
        ...this.#statusAtDelivery(managerId),
      });
    }

    return { outcome, detail, ...(sessionGone === undefined ? {} : { sessionGone }) };
  }

  async stop(options?: ManagerPoolStopOptions): Promise<void> {
    // 締切の既定は待つ相手が居るときだけ時計を読んで決める: 待たない stop に時計を読む新しい口を増やさない。
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribeDirectPushes.splice(0)) unsubscribe();
    // 窓の中でデーモンが落ちると積んだ知らせが失われるので、ここで flush する（`setTimeout` は二度と発火しない）。
    this.#flushSynthesizedNotices();
    // 日誌の畳み込みも吐き出す: こちらは日誌のどこにも書かれていない記録そのものを失い、`#retire()` を通らずに止まると畳んだ2件目以降が丸ごと消える。
    this.#flushRateLimitJournalFolds();
    this.#flushPushFailureFolds();
    this.#unsubscribe();
    for (const timer of this.#reattachTimers.values()) clearTimeout(timer);
    this.#reattachTimers.clear();
    this.#reattachDelays.clear();
    this.#reattachBusyRetries.clear();
    for (const timer of this.#pushRetryTimers.values()) clearTimeout(timer);
    this.#pushRetryTimers.clear();
    this.#pushRetryDelays.clear();
    this.#unresumable.clear();
    // 閉じる前に受け取る: `runner.close()` が SSE を自分で切るので、待つならこの手前でなければ効かない。
    await this.#awaitRunnerFarewells(options?.farewellDeadlineAt);
    // runner のマネージャーは止めない: デーモンの都合で人の仕事を殺さない。
    for (const runner of await this.#runners.list().catch(() => [])) {
      await runner.close().catch(() => undefined);
    }
    this.#records.clear();
  }

  /** 締切に達したら待つのをやめる（閉じる側に倒す）。runner は互いに独立に待つ: 1台の遅れが他を待たせない。 */
  async #awaitRunnerFarewells(farewellDeadlineAt: number | undefined): Promise<void> {
    if (this.#farewellRunners.size === 0) return;
    const deadlineAt = farewellDeadlineAt ?? this.#now() + RUNNER_FAREWELL_WAIT_MS;
    const runners = (await this.#runners.list().catch(() => [])).filter(
      (runner) => this.#farewellRunners.has(runner.runnerId) && runner.awaitStreamEnd !== undefined,
    );
    await Promise.all(
      runners.map(async (runner) => {
        const remaining = (): number => Math.max(0, deadlineAt - this.#now());
        const streamEnded = await settledWithin(runner.awaitStreamEnd?.(), remaining());
        const eventsSettled =
          streamEnded && (await settledWithin(this.#settleEventsInFlight(), remaining()));
        if (streamEnded && eventsSettled) return;
        const managerIds = [...this.#records.values()]
          .filter((record) => record.job.runnerId === runner.runnerId)
          .map((record) => record.job.id);
        noteRunnerFarewellGaveUp(
          runner.runnerId,
          streamEnded ? 'events-unsettled' : 'stream-open',
          managerIds,
        );
      }),
    );
  }

  async #settleEventsInFlight(): Promise<void> {
    while (this.#eventsInFlight.size > 0) {
      await Promise.allSettled([...this.#eventsInFlight]);
    }
  }

  // -------------------------------------------------------------------------
  // runner との配線
  // -------------------------------------------------------------------------

  /**
   * runner が自分で取りに行く形にしない: 取りに行けるなら runner に記憶ストアの鍵があることになる（AGENTS.md「runner に記憶ストアの鍵を足さないこと」）。
   * 失敗しても委譲は止めないが、降りていないことは日誌に残す: 黙って古い環境で走ると「鍵が届いていない」のか「権限が足りない」のかを切り分けられない。
   */
  async #pushProfile(runner: RunnerClient): Promise<void> {
    if (this.#stopped || this.#profile === undefined) return;
    const runnerId = runner.runnerId;
    try {
      // 更新と同じ列に入れる: 直に読んで直に書くと、更新の最中に古い本文で上書きしうる。
      const result = await this.#profile.syncRunner(runner);
      if (result === null || result.ok) {
        this.#notePushOutcome(runnerId, 'profile', { status: 'ok', at: this.#nowIso() });
        return;
      }

      this.#notePushOutcome(runnerId, 'profile', {
        status: 'failed',
        at: this.#nowIso(),
        error: result.error ?? '理由不明',
      });
      // `result.output` は日誌へ書かず長さだけを書く: 生の stderr にはシェルが返した行や echo から鍵の値そのものが乗りうり、日誌は永続でクローンも人間も後から読む。
      const outputChars = result.output?.length ?? 0;
      await this.#journalPushFailure(
        runnerId,
        'profile',
        `${runnerId} に実行環境プロファイルを置けなかった（前のものが残っている）: ` +
          `${result.error ?? '理由不明'}` +
          (outputChars === 0
            ? ''
            : `（プロファイルの出力 ${outputChars} 文字は記録しない——鍵の値が入りうる。` +
              '出力は profile_write / PUT /profile で書き直したときの応答で読める）'),
      );
    } catch (error) {
      // `this.#journal` を経由し、直に `this.#stores.journal.append` を呼ばない: 日誌 append の失敗をプロファイル配布の失敗として書いてしまうため。投げ直さない: 委譲経路を日誌の失敗で止めず、応答を受け取って判断し直す相手がここには居ない（tools.ts の `appendJournalOrThrow` とは非対称）。
      this.#notePushOutcome(runnerId, 'profile', {
        status: 'failed',
        at: this.#nowIso(),
        error: reasonOf(error),
      });
      await this.#journalPushFailure(
        runnerId,
        'profile',
        `${runnerId} へ実行環境プロファイルを降ろせなかった: ${reasonOf(error)}`,
      );
    }
  }

  /** プロファイルと別の呼びにする: 1つにまとめると、プロファイルの評価が落ちた器へは無関係な鍵まで降りない。 */
  async #pushCredentials(runner: RunnerClient): Promise<void> {
    if (this.#stopped || this.#credentials === undefined) return;
    const runnerId = runner.runnerId;
    try {
      await this.#credentials.syncRunner(runner);
      this.#notePushOutcome(runnerId, 'credentials', { status: 'ok', at: this.#nowIso() });
    } catch (error) {
      this.#notePushOutcome(runnerId, 'credentials', {
        status: 'failed',
        at: this.#nowIso(),
        error: reasonOf(error),
      });
      await this.#journalPushFailure(
        runnerId,
        'credentials',
        `${runnerId} へマネージャーの環境変数を降ろせなかった（この runner で起こすマネージャーは、器の環境変数に在るものだけで走る）: ${reasonOf(error)}`,
      );
    }
  }

  /**
   * 別の呼びにする: 片方が落ちても片方は降りるべき。
   * 日誌には値を書かない: 失敗の理由は runner の文言をそのまま運ぶが、`parseMcpServers` が値を載せない形で作っている。
   * 古い runner（口を持たない）は挑み直しに数えない（`#mcpServersUnsupported`）。
   */
  async #pushMcpServers(runner: RunnerClient): Promise<void> {
    if (this.#stopped || this.#mcpServers === undefined) return;
    const runnerId = runner.runnerId;
    try {
      await this.#mcpServers.syncRunner(runner);
      this.#mcpServersUnsupported.delete(runnerId);
      this.#notePushOutcome(runnerId, 'mcpServers', { status: 'ok', at: this.#nowIso() });
    } catch (error) {
      const unsupported = error instanceof RunnerMcpServersUnsupportedError;
      if (unsupported) this.#mcpServersUnsupported.add(runnerId);
      else this.#mcpServersUnsupported.delete(runnerId);
      this.#notePushOutcome(runnerId, 'mcpServers', {
        status: 'failed',
        at: this.#nowIso(),
        error: reasonOf(error),
      });
      await this.#journalPushFailure(
        runnerId,
        'mcpServers',
        `${runnerId} へ MCP サーバの登録を降ろせなかった（この runner で起こすマネージャー・作業者は、記憶ストアの登録を持たずに走る）: ${reasonOf(error)}`,
      );
    }
  }

  /**
   * 日誌には files の中身を書かない（名前と runner の失敗理由だけ）。
   * 古い runner（口を持たない）は挑み直しに数えない（`#pluginsUnsupported`）。
   */
  async #pushPlugins(runner: RunnerClient): Promise<void> {
    if (this.#stopped || this.#plugins === undefined) return;
    const runnerId = runner.runnerId;
    try {
      await this.#plugins.syncRunner(runner);
      this.#pluginsUnsupported.delete(runnerId);
      this.#notePushOutcome(runnerId, 'plugins', { status: 'ok', at: this.#nowIso() });
    } catch (error) {
      const unsupported = error instanceof RunnerPluginsUnsupportedError;
      if (unsupported) this.#pluginsUnsupported.add(runnerId);
      else this.#pluginsUnsupported.delete(runnerId);
      this.#notePushOutcome(runnerId, 'plugins', {
        status: 'failed',
        at: this.#nowIso(),
        error: reasonOf(error),
      });
      await this.#journalPushFailure(
        runnerId,
        'plugins',
        `${runnerId} へ plugin を降ろせなかった（この runner で起こすマネージャー・作業者は、記憶ストアの plugin を持たずに走る）: ${reasonOf(error)}`,
      );
    }
  }

  /**
   * 一度きりにしない: 「もう繋いだ」を1つの旗で持つと、後から載った runner の報告も許可確認も永久に届かない。旗は宛先ごとに持つ。
   * 転んだ1台に他を道連れにさせない。選んだ相手に繋がっているかどうかは `start` が別に確かめる。
   */
  async #ensureConnected(): Promise<void> {
    if (this.#stopped) return;
    const runners = await this.#runners.list().catch(() => []);
    await Promise.all(runners.map((runner) => this.#connectTo(runner).catch(() => undefined)));
  }

  /**
   * 同じ宛先へ多重に繋ぎに行かない: 同じ runner に SSE が何本も張られ、同じイベントが二重に記録される。
   * 失敗は覚えない: 瞬断で1度こけた runner に二度と繋がらなくなる。
   * 繋ぎ済みでも `#reattach` が鍵を降ろし直している最中なら待ってから返す: さもないと委譲が古い値のまま古い資格で走り出す。
   */
  #connectTo(runner: RunnerClient): Promise<void> {
    const already = this.#connections.get(runner);
    if (already !== undefined) {
      const reattaching = this.#reattachPushes.get(runner.runnerId);
      return reattaching === undefined ? already : already.then(() => reattaching);
    }
    const opening = (async () => {
      // 握り潰さず投げ直して未処理の拒否で死ぬ: 死ぬ側のほうが復旧力が高い（`#restoreJobs` が状態を作り直し、lease は `same-holder` で TTL を待たず引き取れる）が、`closed` を1件落として生き残ると lease は TTL まで誰も解放しない。見分けには列挙値とこちらが発行した id だけを載せ、外から来る本文・要旨・理由は載せない。
      await runner.connect((event) => {
        // Promise を捨てない: `stop()` が終わりを待てるよう追う。
        const running = this.#onEvent(event, runner.runnerId).catch((error: unknown) => {
          noteBackgroundFailure('runner からの合図の処理', runnerEventShape(event), error);
          throw error;
        });
        // 追跡用の枝は拒否を握る: `stop()` の待ちは成否を問わない。
        const tracked: Promise<void> = running.then(
          () => undefined,
          () => undefined,
        );
        this.#eventsInFlight.add(tracked);
        // この枝に `.catch` を付けない: 付けると、跡を残したうえで未処理の拒否になって死ぬはずの失敗が黙って消える。
        void running.finally(() => {
          this.#eventsInFlight.delete(tracked);
        });
      });
      // 委譲を始める前に環境を整える: 名乗り（`hello`）任せにすると、最初のマネージャーが届く前に走り出し、「たまに鍵が無い」という形で現れる。器が作り直されていれば置いたものは消えている。
      await this.#pushProfile(runner);
      await this.#pushCredentials(runner);
      await this.#pushMcpServers(runner);
      await this.#pushPlugins(runner);
      // 失敗は相手の側が日誌に残す。
      await this.#codexAuth?.syncRunner(runner).catch(() => undefined);
      await this.#pushAgentToken(runner);
      this.#settlePushRetry(runner.runnerId);
    })().catch((error: unknown) => {
      this.#connections.delete(runner);
      throw error;
    });
    this.#connections.set(runner, opening);
    return opening;
  }

  /**
   * 引き取りの契機をデーモンの起動時だけにしない: runner の器だけが入れ替わると、台帳は `running` のまま runner の中にセッションは無く、クローンが `manager_send` するまで永久に止まる。
   * 生死は台帳ではなく runner に聞く。
   */
  async #reattach(runnerId: string, viaLadder = false): Promise<void> {
    if (this.#stopped) return;
    // 重なった名乗りを捨てない: 処理中に器が入れ替わった場合、return するだけだとその入れ替えが誰にも見られないまま終わる。
    if (this.#reattaching.has(runnerId)) {
      this.#reattachAgain.add(runnerId);
      return;
    }
    this.#reattaching.add(runnerId);
    let retry = false;
    try {
      // 起動時の引き取りと重ならせない: 両方が同じ `list()` を見てから動くと、同じ仕事を二本起こす。
      await this.#restoring;
      if (this.#stopped) return;

      // 名簿を引けなかったのは一時障害だが、居ないと答えられたのは別: その runner は戻ってこないので挑み直しても同じ答えしか返らない。
      const runner = await this.#runners.get(runnerId).catch(() => {
        retry = true;
        return null;
      });
      if (runner === null) return;

      // 併存は関門より前に確かめる: `this.#runners.get` は同名の行が2つ以上あっても黙って一方を返すので、関門（`#claimForResume`）に着く前に `#pushProfile` と `runner.list()` が誤解決した相手へ走ってしまう。関門は複製せず、進んでよい状態かを覗くだけ。
      // この断りは `held` と違って時間で解けないので「遷移のときだけ書く」dedup（`refusedBefore`）には乗せない: 初回だけ言うと、見逃した後・デーモン再起動後は永久に見えなくなる。
      const sighting = this.#sighting(runnerId);
      if (sighting.duplicates !== undefined && sighting.duplicates > 1) {
        // 梯子を予約する: 残さないと、解けた後に取り直す契機は `hello` しか無く、来なければ委譲は `running` のまま誰にも拾われない。時間で解けるとは限らないので間隔は上限に固定する。`viaLadder` の回は併存の日誌・知らせを出し直さない: 梯子が回るたびに積まれる。
        retry = true;
        this.#reattachDelays.set(runnerId, REATTACH_RETRY_MAX_MS);
        if (viaLadder) {
          await this.#refuseRelocationsBeforeGate(runnerId, sighting.duplicates);
          return;
        }
        await this.#journal({
          type: 'decision',
          decision: `runnerId=${runnerId} の取り直しを見送った（併存を関門より前で検出。#pushProfile と runner.list() は誤解決した相手へ走らせていない）`,
          grounds: describeAmbiguousSighting(runnerId, sighting.duplicates),
        });
        // 受信箱にもここで知らせる: `#claimForResume` 側の通知だけに任せると、併存を検出する経路（`hello`）がここで折り返され続け、クローンへ一度も届かない。dedup は `#ambiguousRunnersNotified` を共有するので二重には出ない。
        // ジョブの一覧は store から引く: `this.#records`（プロセス内の像）はまだこのジョブを持っていないことがある。
        // 一覧を読めなかった回を「紐づく委譲が無い」とみなさない: `#noteAmbiguousSighting` を呼ばなければ通知済みにもならず、次の `hello` で再挑戦できる。見送ったことは日誌に残す。
        const listed = await this.#listJobsOrNote(
          `runnerId=${runnerId} の併存の通知を見送った（通知済みにはしていない。次の hello で再挑戦する）`,
        );
        if (listed !== null) {
          const jobIds = listed.filter((job) => job.runnerId === runnerId).map((job) => job.id);
          this.#noteAmbiguousSighting(runnerId, sighting.duplicates, jobIds);
        }
        // この runner を移送先の候補として数えていたジョブには、見送りを断りとして流す: runner 単位の `return` なので、ジョブのループには届かない。
        await this.#refuseRelocationsBeforeGate(runnerId, sighting.duplicates);
        return;
      }
      if (this.#ambiguousRunnersNotified.has(runnerId)) {
        // 読めなかった回は「解けた」を言わず通知済みのまま残し、次に読めた回に言う。
        const listed = await this.#listJobsOrNote(
          `runnerId=${runnerId} の併存が解けた通知を見送った（通知済みの印は残している。次に読めた回に言う）`,
        );
        if (listed !== null) {
          this.#noteAmbiguousResolved(
            runnerId,
            listed.filter((job) => job.runnerId === runnerId).map((job) => job.id),
          );
        }
      }

      // 取り直しの前に環境を整える: 走り出してから降ろすと、その仕事の最初のコマンドだけが古い環境で走る。降ろし切るまで委譲にも待たせる。
      // `#connections` は触らず別の窓口（`#reattachPushes`）に置く: `#connectTo` の失敗時の後始末が誰の Promise かを見ずに消すため、上書きすると古い接続の失敗がこの降ろし直しを巻き添えで消しうる。
      const push = (async () => {
        // 繋ぎ直してきた runner は器ごと入れ替わっていることがあり、置いた鍵とプロファイルは消えているので降ろし直す。
        await this.#pushProfile(runner);
        await this.#pushCredentials(runner);
        await this.#pushMcpServers(runner);
        await this.#pushPlugins(runner);
        await this.#codexAuth?.syncRunner(runner).catch(() => undefined);
        // 認証トークンを降ろし忘れない: 器が入れ替わっていれば置いた鍵も消えており、器の環境変数（＝回す前のトークン）のまま走るのに、その食い違いは `#pushAgentToken` の doc が言うとおり「マネージャーの側からは見えない」。「実害が出にくい」を「要らない」と読まない。
        await this.#pushAgentToken(runner);
        this.#settlePushRetry(runnerId);
      })();
      this.#reattachPushes.set(runnerId, push);
      try {
        await push;
      } finally {
        // 自分が置いたものだけを消す: 後から来た再実行が新しく置いた分を消さない。
        if (this.#reattachPushes.get(runnerId) === push) {
          this.#reattachPushes.delete(runnerId);
        }
      }

      // 台帳を先に、runner を後に読む: 逆にすると、隙間で起こされた委譲が「runner に居ないのに台帳には居る」と見えて、走り出したばかりの仕事を死んだものとして起こし直す。読めなかった回は予約して挑み直すが、黙らない。
      const jobs = await this.#listJobsOrNote(
        `runnerId=${runnerId} の取り直しを進めなかった（居ない委譲を起こすことも、居る委譲を死んだと読むこともしていない。予約して挑み直す）`,
      );
      if (jobs === null) retry = true;
      if (jobs === null || this.#stopped) return;

      // 聞けなかったときは何もしない。応答が無いことを「セッションが無い」と読むと、生きている仕事を二重に起こす。ただし黙って引き下がらず予約する: SSE が安定していれば次の名乗りは来ないので、帰ると生死確認の段階に恒久停止が残る。
      const listing = await listRunnerManagers(runner).catch(() => {
        retry = true;
        return null;
      });
      if (listing === null || this.#stopped) return;
      // 状態を読めなかった委譲も「居る」側に数える: 居ないと読むと、まだ走っているものを resume し、待っていた確認まで捨てる。
      const alive = new Set([
        ...listing.states.map((state) => state.managerId),
        ...listing.unreadableIds,
      ]);

      for (const job of jobs) {
        if (alive.has(job.id)) {
          this.#reattachBusyRetries.delete(job.id);
          continue;
        }
        if (this.#stopped) continue;
        // 宛先が書かれていない古いジョブは触らない: どの runner の器が入れ替わったのかを決められない（起動時の `restore` が `runner_id` を書く）。
        if (job.runnerId === undefined) continue;
        const relocating = job.runnerId !== runnerId;
        // 移送してよいのは記録された宛先が `lost` または `vacating` のときだけ: `unreachable`（まだ開けていない）は抱えている仕事が無く、名簿に行が無い（＝確かめられていない）ときは移送しない。
        if (relocating && !this.#shouldRelocateFrom(job.runnerId)) continue;

        // 一度「挑み直さない」と決めたものは自動では二度と触らない: 抜かすと、同じ runner の別ジョブの予約のたびに無意味な resume と同じ通知が繰り返される。
        if (this.#unresumable.has(job.id)) continue;

        // 古い写し（ループ先頭の `job`）の宛先で像へ書かない: `#reattaching` は runner ごとの直列化なので、待っている間に別の runner の取り直しが移送を終えていると、移送先で健全に走る像へ `attached = false`・`waiting = []` と「resume に失敗した」観測を書いてしまう。判定は読み直しの後・像への最初の書き込みの前に置く。自分の runner の委譲（`!relocating`）は宛先が変わらないので飛ばさない。
        const fresh =
          this.#records.get(job.id) === undefined
            ? ((await this.#latestJobOf(job.id)) ?? job)
            : job;
        // 読み直しの `await` の間に像が載ることもあるので、読んだ後にもう一度 `#records` を見る。
        const known = this.#records.get(job.id);
        if ((known?.job.runnerId ?? fresh.runnerId) !== job.runnerId) continue;

        if (known) known.attached = false;

        // 印は resume を挑む直前に置き、戻れたときに消す: `#resumeOnce` が投げる回も「戻れなかった」側へ落ち、この節を抜けて印が立っている ⟺ resume が成功しなかった、が成り立つ。
        const missingAt = new Date(this.#now()).toISOString();

        // 手を動かしている最中だったものだけ戻す: `done` は死ではなく待機で、起こすと開いたままの窓を勝手に閉じる。判定より前に `#records` へ載せない: 終わった仕事まで `live: true` で見せ、話しかけると必ず失敗する相手が生まれる。
        // 古い写し（ループ先頭の `job`）で判定しない: 待っている間に `abort()` が `stopped` を書いて `#retire` していると、`stopped` を `running` で上書きして起こし直す。`known` が無いときは読み直した `fresh` で判定し、record も同じ行から作る。
        const current = this.#records.get(job.id) ?? known;
        const status = current?.job.status ?? fresh.status;
        if (status !== 'running' && status !== 'waiting_human') continue;

        const record = current ?? { job: { ...fresh }, waiting: [], attached: false };
        this.#records.set(job.id, record);
        record.attached = false;
        // 待っていた確認を持ち越さない: 新しい器はその request_id を知らず、残すと以後の `manager_send` が死んだ確認への回答として横取りされ、誰からも届かないマネージャーになる。
        record.waiting = [];

        // 1本が戻せなくても残りを道連れにしない。移送の窓はどの抜け方でも必ず1回閉じる（`#endRelocationWindow`）。
        let windowOpen = false;
        let windowMoved = false;
        try {
          const cause: RestartCause = relocating ? 'relocated' : 'runner';
          const message = restartNudge(
            status,
            cause,
            record.job.workspace,
            record.job.lastUnpushedWorkObservation,
            record.job.lastRescue,
          );
          const refusedBefore = record.leaseRefusal !== undefined;
          record.sessionMissingSince ??= missingAt;
          // 由来を上書きする（格上げ）: ここを抜けて印が残っている ⟺ resume でも入り直せなかった。
          record.sessionMissingKind = 'resume-failed';
          // 別の契機が resume 中なら窓は持たない: そちらの窓を壊さない。同じ runner への復帰は `closed` だけを預ける別の窓を持つ。
          const ownsWindow = !this.#resuming.has(job.id);
          if (ownsWindow) {
            if (relocating) this.#relocatingTo.set(job.id, runnerId);
            else this.#sameRunnerResumeWindow.set(job.id, runnerId);
            windowOpen = true;
          }
          let outcome: ResumeOutcome;
          try {
            outcome = await this.#resumeOnce(record, runner, message);
          } catch (resumeError) {
            if (windowOpen) {
              windowOpen = false;
              await this.#endRelocationWindow(job.id, false);
            }
            throw resumeError;
          }
          // 受理された回は台帳を `running` へ戻して persist した後に閉じる: 移送先自身の出来事（closed(failed) や ask）を処理し直した結果を、後から `running` で上書きしないため。
          if (windowOpen) {
            if (outcome === 'resumed') {
              windowMoved = true;
            } else {
              windowOpen = false;
              await this.#endRelocationWindow(job.id, false);
            }
          }
          // 引けなかっただけなら `continue` で済ませず予約して挑み直す: 次の名乗り（`hello`）は SSE が繋がったときにしか来ず、永久に来ないことがある。
          if (outcome === 'busy') {
            // 別の契機が resume 中でそちらが失敗すると誰も取り直さないので梯子に載せるが、委譲ごとに `REATTACH_BUSY_MAX_RETRIES` 回で打ち切る: 相手の resume が終わらない限り毎回 busy に当たる。打ち切った委譲は `retry` を立てず、梯子を延命しない。
            const tried = this.#reattachBusyRetries.get(job.id) ?? 0;
            if (tried < REATTACH_BUSY_MAX_RETRIES) {
              this.#reattachBusyRetries.set(job.id, tried + 1);
              retry = true;
            } else {
              this.#reattachBusyRetries.delete(job.id);
              await this.#journal({
                type: 'decision',
                decision: `[${job.id}] 取り直しの予約を止めた（別の契機の resume が ${REATTACH_BUSY_MAX_RETRIES} 回の挑み直しを通じて終わらなかった）`,
                grounds:
                  'busy が続いたので、この委譲についての梯子の予約を打ち切った。次の名乗り（hello）か、相手の resume の結果に任せる',
              });
            }
            continue;
          }
          this.#reattachBusyRetries.delete(job.id);
          if (outcome === 'unreadable') {
            retry = true;
            continue;
          }
          if (outcome === 'held-by-lease') {
            retry = true;
            // 待っていることを日誌に残す: 書かないと「待っている」と「忘れている」が記録から区別できない。遷移のときだけ書く: 梯子は最大30秒間隔で挑み直すので、毎回書くと同じ行が積まれ、日誌を読む側で本当に1回だけ起きたことが埋もれる。
            if (!refusedBefore) {
              await this.#journal({
                type: 'decision',
                decision: leaseRefusalDecision(job.id, record.leaseRefusal),
                grounds: record.leaseRefusal?.detail ?? '（根拠を取れなかった）',
              });
            }
            continue;
          }
          if (relocating && outcome === 'no-session') {
            // 移送のときの `no-session` はその場で lost に確定する: セッションが無いのは委譲の側の事実で、候補を回しても変わらない。
            const reason = new Error(
              'no-session: 委譲が session_id を持っておらず、どの runner でも開き直せない（移送の候補を回しても変わらないので、その場で確定した）',
            );
            await this.#journal({
              type: 'decision',
              decision: `[${job.id}] 移送先 ${runnerId} へ移せない（セッションが無い）。候補を回さず、戻せなかったものとして確定する`,
              grounds: reasonOf(reason),
            });
            await this.#confirmLost(record, reason);
            continue;
          }
          if (relocating && outcome === 'workspace-path-unknown') {
            // 貸し出しは返さない: この回では貸していず、`record.job.lease` がこの候補を指していても以前の回が貸したもので、セッションが起きていないと確かめられないものは返さない。
            const reason = new Error(
              `workspace-path-unknown: 移送先 ${runnerId} は cwd を記録しておらず、runner からも workspacePath を聞けていない`,
            );
            if (await this.#noteRelocationRefusal(record, runnerId, reason)) {
              await this.#confirmLost(record, reason);
            } else if (
              record.job.lease?.runnerId === runnerId &&
              record.job.lease.releasedAt === undefined
            ) {
              await this.#journal({
                type: 'decision',
                decision: `[${job.id}] 移送先 ${runnerId} に貸した貸し出しは返していない（以前の回の貸し出しで、セッションが起きていないと確かめられない）`,
                grounds: reasonOf(reason),
              });
            }
            continue;
          }
          if (outcome !== 'resumed') continue;
          // `#resumeOnce` から戻った直後、他の await を挟む前に読む（`#restoreJobs` と同じ理由）。
          const swapNotice = cwdSwapNoticeClause(record);
          // 受理と「戻れた」を取り違えない。
          if (record.job.status === 'lost') {
            if (windowOpen) {
              windowOpen = false;
              await this.#endRelocationWindow(job.id, windowMoved);
            }
            continue;
          }
          // 戻れたので古い観測は捨てる: 残すと「いま話しかけられない」と読める欄が話しかけられる相手に付いたままになる。由来も片方だけ残さない。
          record.sessionMissingSince = undefined;
          // 由来も一緒に消す: 片方だけ残さない。
          record.sessionMissingKind = undefined;
          record.job.status = 'running';
          this.#relocationRefusals.delete(job.id);
          await this.#persist(record);
          // `runner.send()` の失敗は無視する: 本体の resume は成功しており、この一言が届かなくても致命ではない。
          if (swapNotice !== undefined) {
            await runner.send(job.id, swapNotice).catch(() => undefined);
          }
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'outbound',
            text:
              `${EXCHANGE_KIND_RECOVERY_PREFIX}[${job.id}] （${relocating ? '別の器への移送' : 'runner 入れ替え'}後の再開）${message}` +
              (swapNotice === undefined ? '' : ` ${swapNotice}`),
          });
          this.#notifyRestored(record, 'resumed', cause);
          if (windowOpen) {
            windowOpen = false;
            await this.#endRelocationWindow(job.id, windowMoved);
          }
        } catch (error) {
          if (windowOpen) {
            windowOpen = false;
            await this.#endRelocationWindow(job.id, windowMoved);
          }
          this.#reattachBusyRetries.delete(job.id);
          // 一時的にこけたときは自分で予約する: `hello` は SSE が繋がったときにしか来ず、ストリームが安定していれば永久に来ないので、台帳が `running` のまま誰も走っていない仕事が残る。
          if (isFencedRunnerError(error)) {
            // 世代で拒まれた（409）は「戻せなかった」ではない: `lost` にして像から外すと、クローンが新しく起こし直し、fencing の失敗経路から二重実行へ到達する。状態は動かさず挑み直さない（同じ世代で投げ直しても同じ答え）が、台帳の書き込み失敗か別のデーモンの存在を人間が知る必要があるので必ず知らせる。
            await this.#journal({
              type: 'decision',
              decision: `[${job.id}] 取り直しを止めた（runner がより新しい世代を持っている＝別の誰かが握っている）`,
              grounds: reasonOf(error),
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
                `台帳の貸し出しと runner の世代が食い違っています（デーモンが2つ走っているか、貸し出しの書き込みが落ちた可能性）。人間へ相談すること: ${reasonOf(error)}`,
              ...this.#statusAtDelivery(job.id),
            });
          } else if (isRetryableRunnerError(error)) retry = true;
          else if (
            relocating &&
            isRunnerSpecificRefusal(error) &&
            !(await this.#noteRelocationRefusal(record, runnerId, error))
          ) {
            // 移送先1台の断りは委譲の運命ではない: lost に確定せず `#unresumable` も立てず、この移送先だけ見送る。ほかの候補が引き取れる。
            // この移送先へ貸した貸し出しは返す: 残すとほかの候補の関門が `held` で断り、TTL が切れるまで移れない。4xx は命令を受け取らなかったという答えで、セッションは起きていない（起きていれば 2xx）。
            if (
              record.job.lease?.runnerId === runnerId &&
              record.job.lease.releasedAt === undefined
            ) {
              record.job.lease = releaseLease(record.job.lease, this.#now());
              await this.#persist(record);
              // 黙って返さない: この契機だけは持ち主自身の `closed` ではなく 4xx の答えに拠っている。
              await this.#journal({
                type: 'decision',
                decision: `[${job.id}] 移送先 ${runnerId} に貸した貸し出しを返した（resume を 4xx で断られ、そこではセッションが起きていない）`,
                grounds: reasonOf(error),
              });
            }
          } else {
            await this.#confirmLost(record, error);
          }
        }
      }
    } catch {
      // 想定外で転んでもデーモンごと落とさず、黙って終わらない: 「もう挑まない」に倒すと、走行中だった仕事が誰にも拾われないまま `running` で残る。
      retry = true;
    } finally {
      this.#reattaching.delete(runnerId);
      if (!retry) this.#reattachDelays.delete(runnerId);
      // 走っている間に届いた名乗りは予約より即時を優先する。
      if (this.#reattachAgain.delete(runnerId) && !this.#stopped) void this.#reattach(runnerId);
      else if (retry && !this.#stopped) this.#scheduleReattach(runnerId);
    }
  }

  /** 回数で打ち切らない: 残るのは「台帳では走っているのに誰も走っていない仕事」で、この経路が直そうとしている状態そのもの。 */
  #scheduleReattach(runnerId: string): void {
    if (this.#reattachTimers.has(runnerId)) return;
    const delay = this.#reattachDelays.get(runnerId) ?? REATTACH_RETRY_BASE_MS;
    this.#reattachDelays.set(runnerId, Math.min(delay * 2, REATTACH_RETRY_MAX_MS));
    const timer = setTimeout(() => {
      this.#reattachTimers.delete(runnerId);
      if (!this.#stopped) void this.#reattach(runnerId, true);
    }, delay);
    timer.unref?.();
    this.#reattachTimers.set(runnerId, timer);
  }

  /** `依頼:` を載せず、直近の報告も全文ではなく `excerptLine` の短い抜粋だけにする: 依頼文はクローン自身が書いたもので、中身は `manager_report` でいつでも読める。 */
  #notifyExcerptLines(job: Job): string[] {
    return [
      job.lastReport === undefined
        ? ''
        : `直近の報告（抜粋）: ${excerptLine(job.lastReport, NOTIFY_REPORT_EXCERPT)}`,
      `続きを読むなら manager_report managerId=${job.id}（直近の報告の全文） / ` +
        `manager_report managerId=${job.id} part=request（依頼文）。`,
    ];
  }

  /** 黙って `running` のまま置かない: 再試行しても同じ答えが返る失敗なので、人間とクローンに見えるようにするのが唯一の出口。 */
  #notifyUnresumable(
    record: ManagerRecord,
    error: unknown,
    cause: 'runner' | 'session' = 'runner',
  ): void {
    const { job } = record;
    // 日誌は呼び出し元に委ねない: 経路ごとに呼び出し元の事前の書き込みが違い、「日誌に無い＝この経路を通っていない」を判別器にするには、経路によらず必ず1本書く必要がある。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text:
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${job.id}] （戻せなかった）` +
        (cause === 'session'
          ? '前のセッションから戻せなかった（SDK に会話が残っていない）。'
          : 'runner の器が作り直されたが、前のセッションから戻せなかった。') +
        ` 理由: ${reasonOf(error)}`,
    });
    // 即配らず合流窓へ積む: 委譲が器と一緒に失われた族は `resume_fallback` / `resume_failed` / `closed_failed` の3通で構成され、「一枠落ち一合図」に揃える。
    this.#queueSynthesizedNotice(
      job.id,
      'resume_failed',
      [
        cause === 'session'
          ? 'この委譲を前のセッションから戻せなかった（SDK に会話が残っていない）。' +
            '生ログも預かっていないので、続きの材料が無い。'
          : 'runner の器が作り直されたが、この委譲を前のセッションから戻せなかった。',
        `理由: ${reasonOf(error)}`,
        `作業ディレクトリ: ${job.cwd ?? '(不明)'}`,
        ...this.#notifyExcerptLines(job),
        '',
        // 「成果が無い」と言わない: 観測したのは戻れなかったことだけで、PR もブランチも見に行かない（落ちる直前にマージまで済ませていた、が実際に起きている）。
        '同じ命令を投げ直しても同じ答えが返る種類の失敗なので、自動では再試行しない。' +
          'ただし**この失敗は「仕事が終わっていない」ことの証拠ではない** — ' +
          '落ちる前に成果が既に外へ出ていることがある（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）。' +
          '`manager_start` で起こし直す前に、そこを確かめること。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
  }

  /** 成功として黙らせない: 続きは前のセッションそのものではなく、知らないクローンは「前に渡した細かい指示は効いている」前提で次を積んでしまう。 */
  #notifyResumeFallback(record: ManagerRecord, sessionId: string, reason: string): void {
    const { job } = record;
    const body = [
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
      .join('\n');
    // 日誌は呼び出し元にも合流窓の flush にも委ねない: 呼び出し元は理由までしか書かず、flush の1行は内訳（族と通数）だけで、ここで組み立てた拡張文言はどこにも残らない。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `${EXCHANGE_KIND_RECOVERY_PREFIX}[${job.id}] （生ログから作り直して続けた）${body}`,
    });
    // 上の `#journal` と同じ `body` を渡す: 同じ文字列を2回組み立てると片方だけ直る事故が起きる。
    this.#queueSynthesizedNotice(job.id, 'resume_fallback', body);
  }

  /**
   * 名前に `absent` を使わない: `'absent'` は `ManagerAbortResult` の値（そのマネージャーが台帳に居ない。HTTP 404）で、ここは別の観測（宛先がいま名簿に開いていない）なので、寄せると畳んではいけない2つを畳む向きへ押される。
   * 観測しているのは「いま名簿に開いた宛先が無い」ことだけ: 待てば直る状態（`connecting` / `unreachable`）を待っても直らない言葉で報告しない。文言の誤りは状態の誤りより直りにくい（読んだ側の結論は訂正が届かない）。判定できないものは言わない（取れない軸に0の行を作らない）。
   * 名簿の状態を5値のまま添える: 「まだ開けていない」と「待っても同じ答えが返る」の違いが、待つか起こし直すかの材料。畳み方は `describeRunnerEntries` を呼び、値の意味はここに書き写さない（持ち主は `runner_list` の説明）。
   * 宛先1台に絞れない: `entry.client` が無い場合で、引けない対応付けを推測で埋めない。
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
    // `select` を呼ばない: 繋がるまで待つので、起動時の引き取りや `manager_send` の下で台帳を読むだけの操作が固まる。開いている runner が無いなら「宛先が居ない」と答えるのが正しい。
    if (runnerId === undefined) {
      const open = await this.#runners.list().catch(() => []);
      return open[0] ?? null;
    }
    return this.#runners.get(runnerId);
  }

  /**
   * 止めた後は状態を動かさない: `record` は呼び出し側が取った時点の写しで、その後に `abort()` が `stopped` を書いていることがある。冒頭で最新を読み、`stopped` なら日誌にだけ残して戻る。
   * `#retire` も呼ばない: `abort()` が同じ呼びの中で済ませる。
   */
  async #confirmLost(record: ManagerRecord, error: unknown): Promise<void> {
    this.#reattachBusyRetries.delete(record.job.id);
    const { job } = record;
    const latest = this.#records.get(job.id)?.job ?? (await this.#latestJobOf(job.id)) ?? job;
    if (latest.status === 'stopped' || job.status === 'stopped') {
      await this.#journal({
        type: 'decision',
        decision: `[${job.id}] 戻せなかったとして確定するのを見送った（止めた後は状態を動かさない。台帳は stopped のまま）`,
        grounds: `確定しようとした理由: ${reasonOf(error)}`,
      });
      return;
    }
    this.#relocationRefusals.delete(job.id);
    // ジョブ側に覚える: runner 単位の `retry` では、同じ runner の別ジョブの予約のたびに巻き込まれる。台帳にも書く: 記憶は器と一緒に消えるが諦めた事実は消えない。
    this.#unresumable.add(job.id);
    record.job.status = 'lost';
    this.#records.set(job.id, record);
    await this.#persist(record);
    this.#notifyUnresumable(record, error);
    this.#retire(job.id);
  }

  /** 台帳が読めない回は何もしない: `#listJobsOrNote` が日誌に残し、次の `hello` で再び届く。 */
  async #refuseRelocationsBeforeGate(runnerId: string, duplicates: number): Promise<void> {
    const listed = await this.#listJobsOrNote(
      `runnerId=${runnerId} の併存による移送の見送りを控えられなかった（次の hello で再挑戦する）`,
    );
    if (listed === null) return;
    for (const job of listed) {
      if (this.#stopped) return;
      if (job.runnerId === undefined || job.runnerId === runnerId) continue;
      if (job.status !== 'running' && job.status !== 'waiting_human') continue;
      if (this.#unresumable.has(job.id) || !this.#shouldRelocateFrom(job.runnerId)) continue;
      const known = this.#records.get(job.id);
      // 古い写し（ループ先頭の `job`）で確定しない: この間に `abort()` が `stopped` を書いていることがあるので、確定の直前に読み直した行から作る。
      const fresh = known === undefined ? ((await this.#latestJobOf(job.id)) ?? job) : job;
      const record = known ?? { job: { ...fresh }, waiting: [], attached: false };
      const reason = new Error(
        `runnerId=${runnerId} が併存している（${duplicates} 件）ので、移送先として取り直しを見送った`,
      );
      if (await this.#noteRelocationRefusal(record, runnerId, reason)) {
        record.attached = false;
        record.waiting = [];
        await this.#confirmLost(record, reason);
      }
    }
  }

  /**
   * まだ断っていない候補が1台でも居れば確定しない（偽）: その候補の `#reattach` が引き取る。全員が断った回に限り真を返すので無限には試さず、残りを判定できない（名簿に居ない）回は「居ない」側に倒す。
   * 偽のときは残りの候補へ取り直しを予約する: 並行に起こされた候補が `busy` で抜けていた回の拾い直し。
   */
  async #noteRelocationRefusal(
    record: ManagerRecord,
    refusedBy: string,
    error: unknown,
  ): Promise<boolean> {
    const id = record.job.id;
    const refused = this.#relocationRefusals.get(id) ?? new Set<string>();
    // 既に控えにある runner の断りは判断の日誌を書き直さない: 併存の見送りが梯子で繰り返し届いても、同じ (委譲, runner) の断りを積まない。
    const alreadyRefused = refused.has(refusedBy);
    refused.add(refusedBy);
    this.#relocationRefusals.set(id, refused);
    const origin = record.job.runnerId;
    const remaining = new Set(
      this.#runners
        .entries()
        .filter((entry) => entry.runnerId !== undefined && entry.runnerId !== origin)
        .filter((entry) => entry.state === 'connected')
        .map((entry) => entry.runnerId as string)
        .filter((candidate) => !refused.has(candidate)),
    );
    const exhausted = remaining.size === 0;
    if (!alreadyRefused) {
      await this.#journal({
        type: 'decision',
        decision:
          `[${id}] 移送先 ${refusedBy} が resume を断った（その runner の都合として扱う）。` +
          (exhausted
            ? '残りの候補が無いので、戻せなかったものとして確定する'
            : `ほかの候補（${[...remaining].join(', ')}）へ移すのを試す`),
        grounds: reasonOf(error),
      });
    }
    // 残りの候補へ予約する: 並行に起こされた候補の `#reattach` は、この移送先が resume 中だと `busy` で黙って抜けており、予約しないと次の名乗りまで誰にも試されない。
    for (const candidate of remaining) this.#scheduleReattach(candidate);
    return exhausted;
  }

  /** 受理されなかった移送では元の runner の出来事を処理し直す: 捨てると lost や report を取りこぼす。受理されたなら古い世代の出来事なので日誌にだけ残して捨てる。 */
  async #endRelocationWindow(managerId: string, moved: boolean): Promise<void> {
    const target = this.#relocatingTo.get(managerId);
    this.#relocatingTo.delete(managerId);
    const sameRunner = this.#sameRunnerResumeWindow.get(managerId);
    this.#sameRunnerResumeWindow.delete(managerId);
    const held = this.#deferredEvents.get(managerId) ?? [];
    this.#deferredEvents.delete(managerId);
    for (const { event, fromRunnerId } of held) {
      // 同じ runner への復帰の窓: 受理されたなら、窓の間に届いた `closed` は resume の前のセッションの畳みなので日誌にだけ残して捨てる。
      if (sameRunner !== undefined) {
        // 新しいセッション自身の出来事だと分かるなら古い世代として捨てない。`report` は世代が無い（古い runner）ときも処理し直し、`closed` は世代が一致するときだけ。
        const record = this.#records.get(managerId);
        const generation =
          record === undefined ? 'unknown' : this.#judgeSessionGeneration(record, event);
        if (
          !moved ||
          generation === 'current' ||
          (event.type === 'report' && generation === 'unknown')
        ) {
          await this.#onEvent(event, fromRunnerId);
          continue;
        }
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `${EXCHANGE_KIND_DECISION_PREFIX}[${managerId}] （同じ runner ${sameRunner} への復帰の resume の最中に届いた、` +
            `古いセッションの出来事のため無視。resume は受理された）` +
            (event.type === 'closed'
              ? `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}`
              : `古いセッションの ${event.type} を無視した`),
        });
        continue;
      }
      const fromTarget = fromRunnerId === target;
      // 移送先自身の出来事: 受理されたなら通常の経路で処理し直し、受理されなかったなら移送先は引き取っていないので日誌にだけ残して捨てる。
      if (fromTarget && moved) {
        await this.#onEvent(event, fromRunnerId);
        continue;
      }
      if (moved || fromTarget) {
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `${EXCHANGE_KIND_DECISION_PREFIX}[${managerId}] （移送の最中に届いた古い runner の出来事のため無視。` +
            `移送先は ${target ?? '不明'}、この出来事は ${fromRunnerId} から${
              fromTarget ? '。移送は受理されなかった' : ''
            }）` +
            (event.type === 'closed'
              ? `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}`
              : `移送の最中に届いた古い runner の ${event.type} を無視した`),
        });
      } else {
        await this.#onEvent(event, fromRunnerId);
      }
    }
  }

  /** 「世代が無い」を `stale` にも `current` にも倒さない: 古い runner との後方互換。 */
  #judgeSessionGeneration(
    record: ManagerRecord,
    event: RunnerEvent,
  ): 'stale' | 'current' | 'unknown' {
    if (!isSessionScopedEvent(event)) return 'unknown';
    const given = event.sessionGeneration;
    const tracked = record.sessionGeneration;
    if (given === undefined || given.length === 0 || tracked === undefined) return 'unknown';
    return given === tracked ? 'current' : 'stale';
  }

  /** 移送の窓の間に届いた出来事を、届いた順に預ける（`#deferredEvents`）。同期で呼ぶこと。 */
  #deferEvent(
    event: Extract<RunnerEvent, { type: 'closed' | 'session' | 'report' | 'ask' | 'settled' }>,
    fromRunnerId: string,
  ): void {
    const held = this.#deferredEvents.get(event.managerId) ?? [];
    held.push({ event, fromRunnerId });
    this.#deferredEvents.set(event.managerId, held);
  }

  /** 確かめてから立てるまでに `await` を挟まない: 挟むと別の契機が同じ判断をし、同じ仕事が二重に走って同じコミットや PR が二度出る。 */
  async #resumeOnce(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
    attachments?: RunnerAttachment[],
  ): Promise<ResumeOutcome> {
    const id = record.job.id;
    // 理由は真偽値ではなく返り値（`ResumeOutcome`）で運ぶ: 呼び手が残っていた断りから推測して「待てば通る」と誤って言うため。
    if (this.#resuming.has(id)) return 'busy';
    this.#resuming.add(id);
    try {
      return await this.#resume(record, runner, message, attachments);
    } finally {
      this.#resuming.delete(id);
    }
  }

  /**
   * 同じ名前を名乗る器が2台以上開いているときは instanceId を採らず台数を返す: どちらと突き合わせるか決める材料が無く、片方を選べば話しかける相手（`Registry#get` の線形一致）と判定した相手が食い違いうる。
   * 食い違ったまま `same-holder` と答えるのが一番危ない（奪っていないつもりで奪う）ので、台数（`duplicates`）を返して `judgeLease` を `ambiguous` へ倒す。
   * 名簿に居ない回は「一意でない」とは別なので `{ runnerId }` だけを返す。
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
   * 判定材料を貸し出し（`job.lease.instanceId`）にしない: `#claimForResume` は `runner.resume()` の前に新しい `instanceId` を書くので、関門を通った後に resume が失敗すると「もう告げた」と読めて二度と告げられなくなる。セッションが実際に載ったと確かめた回にだけ進む `job.sessionInstanceId` を見る。
   * 時刻ではなく `instanceId` 同士を直接比べる: 時刻の比較は初回観測を入れ替えと誤読する。どちらか一方でも取れなければ「判定できない」（`false`）で、併存のときも `#sighting` が `instanceId` を返さずここへ落ちる。
   * 宛先の名前（`runnerId`）は見ない: 移送された委譲でも `instanceId` が違えば別の `/workspace` で、条件に足すと移送された委譲にだけ告げない穴ができる。
   * 像ではなく `Job` に持たせる: 像にだけ持たせると、デーモンの再起動で判定材料が消え、`done` の委譲は告げる機会を失う。
   * この欄が無い古い行だけ貸し出しへ落とす: 落とさなければ1回も告げず、落とせば失敗した回でも元の穴と同じ所へ落ちるだけで、どの筋でも悪くならない。
   */
  #runnerSwappedSinceSession(record: ManagerRecord, runner: RunnerClient): boolean {
    // `??` で書く: `sessionInstanceId` が在ればそれだけを見て、貸し出しは見ない。
    const recorded = record.job.sessionInstanceId ?? record.job.lease?.instanceId;
    if (recorded === undefined) return false;
    const answering = this.#sighting(runner.runnerId).instanceId;
    if (answering === undefined) return false;
    return recorded !== answering;
  }

  /** 行が0本のときは `false`: 「開けていた宛先から動いてよい」と確かめられていない以上、移送してよいとは言えない。`vacating` は「黙った」のではなく「空けると決めた」だけなので `lost` と同じ側に立つ。 */
  #shouldRelocateFrom(runnerId: string): boolean {
    const matches = this.#runners.entries().filter((entry) => entry.runnerId === runnerId);
    return (
      matches.length > 0 &&
      matches.every((entry) => entry.state === 'lost' || entry.state === 'vacating')
    );
  }

  /**
   * 文面を2箇所に散らさない: `describeAmbiguousSighting` が持っており、別の説明を書くと「別の問題が2つ在る」と誤解される。足すのは「新しく起こし直すな」という行動の指示だけ。
   * `jobIds` が空なら見送り、通知済みにもしない: 通知先が無く、次にジョブが分かった機会にもう一度試せるようにする。
   */
  #noteAmbiguousSighting(runnerId: string, duplicates: number, jobIds: readonly string[]): void {
    if (this.#ambiguousRunnersNotified.has(runnerId)) return;
    const managerId = jobIds[0];
    if (managerId === undefined) return;
    this.#ambiguousRunnersNotified.add(runnerId);
    // 日誌は呼び出し元に委ねない: どちらの呼び出し元も `#post` の前に `#journal` していないので、経路によらず「知らせた」の跡を必ず1本残す。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `${EXCHANGE_KIND_FAILURE_PREFIX}[${managerId}] ${describeAmbiguousSighting(runnerId, duplicates)}`,
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
      ...this.#statusAtDelivery(managerId),
    });
  }

  /**
   * `jobIds` が空のときは通知済みの状態を消さない: 「解けた」と言える相手が無いまま消すと、後でジョブが見つかったときに「解けた」を言う機会が失われる。
   */
  #noteAmbiguousResolved(runnerId: string, jobIds: readonly string[]): void {
    if (!this.#ambiguousRunnersNotified.has(runnerId)) return;
    const managerId = jobIds[0];
    if (managerId === undefined) return;
    this.#ambiguousRunnersNotified.delete(runnerId);
    // 日誌は呼び出し元に委ねない: どちらの呼び出し元も `#post` の前に `#journal` していないので、経路によらず「知らせた」の跡を必ず1本残す。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `${EXCHANGE_KIND_RECOVERY_PREFIX}[${managerId}] runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。`,
    });
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date(this.#now()).toISOString(),
      managerId,
      kind: 'report',
      text: `runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。以後は自動で引き取ります。`,
      ...this.#statusAtDelivery(managerId),
    });
  }

  /**
   * 関門を契機（`restore` / `hello` / `manager_send`）ごとに置かない: 足し忘れた契機だけが素通しになり、二重実行が起きるまで見えない。`#resume` は3つとも通る。
   * 断っても回数で諦めない: 持ち主が握っている間だけの話で待てば通る。諦めると、台帳では走っているのに誰も走っていない仕事が残る。
   */
  async #claimForResume(record: ManagerRecord, runner: RunnerClient): Promise<boolean> {
    const now = this.#now();
    const verdict = judgeLease({
      lease: record.job.lease,
      now,
      answering: this.#sighting(runner.runnerId),
    });

    if (!mayClaim(verdict)) {
      // 未知の判定が増えて落ちてきても `ambiguous`（時間では解けない側）に倒す: `mayClaim` の「名指ししなかった判定は断る」と同じ安全側。
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
    // delete する前に「直前が併存だったか」を見る: 後だと `#noteAmbiguousResolved` が「解けた」を出す機会を失う。
    if (record.leaseRefusal?.kind === 'ambiguous') {
      this.#noteAmbiguousResolved(runner.runnerId, [record.job.id]);
    }
    delete record.leaseRefusal;

    // 世代を進めない: 台帳の世代が runner の持つ世代より新しくなり、次の命令が拒まれる。
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

    // `#persist` の best-effort に乗せない: 書けないまま走らせると、次の引き取りが「記録が無い＝誰も握っていない」と読んで同じ委譲を無条件で奪える。
    const before = record.job.lease;
    const beforeUpdatedAt = record.job.updatedAt;
    record.job.lease = next;
    try {
      record.job.updatedAt = new Date(now).toISOString();
      await this.#stores.jobs.putJob(record.job);
    } catch (error) {
      // `updatedAt` も戻す: 貸し出しだけ戻すと、次に書けた回の台帳が「この時刻に何かを書いた」と言うのに中身が伴わない。
      record.job.lease = before;
      record.job.updatedAt = beforeUpdatedAt;
      record.leaseRefusal = {
        detail: `貸し出しを台帳へ書けなかったので引き取らない（書けないまま走らせると、次の契機が同じ委譲を無条件で奪える）: ${reasonOf(error)}`,
        // `ambiguous` にしない: `ALTEROID_RUNNER_ID` は正しく、落ちたのは台帳への書き込みだけ。
        kind: 'persist-failed',
      };
      return false;
    }

    // 奪った回も根拠つきで残す: `drained`（畳んだという約束が根拠）と `undecidable`（判定材料なし）は「奪っていない」とは言えない。
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
    attachments?: RunnerAttachment[],
  ): Promise<ResumeOutcome> {
    const { sessionId, cwd, request, projectKey } = record.job;
    if (sessionId === undefined) return 'no-session';

    // `#claimForResume` / `#loadSession` より前に断る: 後段（貸し出し・生ログ取得）が空振りする前に分かる条件。
    if (cwd === undefined && !runner.workspacePathKnown) return 'workspace-path-unknown';

    if (!(await this.#claimForResume(record, runner))) return 'held-by-lease';

    // runner のディスクに生ログが残っている前提を置かない: 器は作り直される。
    const material = await this.#loadSession(projectKey, sessionId);

    // 引けなかったものを「無い」として進めない: 材料無しで resume すると `resume_failed` の `recovered: false` が `lost` に確定し、一時的に DB が読めなかっただけで委譲が恒久に終端する。
    if (material.kind === 'unreadable') return 'unreadable';

    // チェックポイント1: `#claimForResume` の後・`runner.resume()` の直前に置く。前に置くと確認から呼び出しまでの窓が開くだけで得が無く、呼ぶ前に見送れる回は実 I/O を減らす。
    if (record.stopConfirmedAt !== undefined) return 'stopped-meanwhile';

    // 応答の `cwd` と比べる基準は `record.job.cwd`（`undefined` のことがある）ではなくこの値。
    const requestedCwd = cwd ?? runner.workspacePath;
    // 出す直前に追っている世代を下ろす: 応答が返るまで（失敗して返らなければその後も）世代の判定はしない。
    delete record.sessionGeneration;
    const resumed = await runner.resume({
      managerId: record.job.id,
      sessionId,
      cwd: requestedCwd,
      request: request ?? record.job.summary,
      ...(message === undefined ? {} : { message }),
      ...(message === undefined || attachments === undefined || attachments.length === 0
        ? {}
        : { attachments }),
      ...(material.kind === 'loaded' ? { entries: material.entries } : {}),
      ...(record.job.lease === undefined
        ? {}
        : { lease: { fence: record.job.lease.fence, ttlMs: record.job.lease.ttlMs } }),
    });
    // `resumed.cwd` が返らなければ何もしない: 「未確認」を `requestedCwd` で埋めると、倒れていた回まで「頼んだとおり開けた」と嘘をつく。
    // 倒れたかは応答後にしか分からず、resume 前に組む「移送の一言」へ混ぜられないので `cwdSwapNotice` で伝える。前回の通知は持ち越さない。
    record.cwdSwapNotice = undefined;
    if (resumed.cwd !== undefined && resumed.cwd !== requestedCwd) {
      record.job.cwd = resumed.cwd;
      record.job.workspace = workspaceLocatorFrom(this.#workspace, runner.runnerId, resumed.cwd);
      record.cwdSwapNotice = { requested: requestedCwd, actual: resumed.cwd };
    }

    // チェックポイント2: ここで `record.attached` などを書くと、止めたつもりの委譲が「走っているはず」を名乗ったまま誰にも追われなくなる。
    // `record.job.status` は書かない（`abort()` が `'stopped'` を書いて `#persist()` 済み）。畳み直せなかったときは、台帳は「止めた」なのに runner にセッションが生き残る最も危ない不一致なので黙らない。
    if (record.stopConfirmedAt !== undefined) {
      const { outcome: foldOutcome } = await this.#confirmStoppedAndReleaseLease(
        record,
        runner,
        record.job.id,
      );
      if (foldOutcome === 'stopped') {
        await this.#persist(record);
      } else {
        noteResumeAfterStopFoldFailed(record.job.id, foldOutcome);
      }
      return 'stopped-meanwhile';
    }

    record.attached = true;
    const previousRunnerId = record.job.runnerId;
    record.job.runnerId = runner.runnerId;
    // cwd が倒れた回だけ locator を作り直さない: 倒れなかった移送で `runnerId` が元の器を指したまま残る。
    if (previousRunnerId !== undefined && previousRunnerId !== runner.runnerId) {
      record.job.workspace = workspaceAfterRelocation(record.job.workspace, runner.runnerId);
    }
    this.#noteRunnerSessionSince(record);
    if (resumed.sessionGeneration !== undefined && resumed.sessionGeneration.length > 0) {
      record.sessionGeneration = resumed.sessionGeneration;
    }
    // 名簿を引き直さない: 写すのは関門（`#claimForResume`）が判定した相手。理由は `Job.sessionInstanceId` の doc。
    // これより前の枝ではこの欄が動かない: 貸し出しだけが新しい器へ進んで告げる1行が届かなかった回に、次の `send()` がもう一度告げられる。
    const placed = record.job.lease?.instanceId;
    if (placed !== undefined) record.job.sessionInstanceId = placed;
    // 生きていた旧プロセスへ流しただけの回は身元を覚えない: 旧プロセスの env は凍っているので、いまの世代を書くと古い鍵のまま走っているのに `manager_list` の ⚠ が消える（偽の一致）。
    // resume で起こし直した回は覚える: 抜けると `observedBy` が無く世代の照合が素通しになり、消費のトークン帰属も持てない。
    if (resumed.reusedLiveSession === true) {
      this.#resumedIntoLiveProcess.add(record.job.id);
    } else {
      this.#resumedIntoLiveProcess.delete(record.job.id);
      this.#rememberTokenIdentity(record.job.id);
    }
    this.#unresumable.delete(record.job.id);
    return 'resumed';
  }

  /**
   * 「無い」と「読めなかった」を分けて返す: `null` に畳むと下流が恒久の結論へ変える（`#resume` 参照）。本文は stderr に出さない（`noteDroppedRecord` と同じ）。
   */
  async #loadSession(projectKey: string | undefined, sessionId: string): Promise<SessionMaterial> {
    const store = this.#stores.sessionStore;
    if (store === undefined || projectKey === undefined) return { kind: 'absent' };
    try {
      const entries = await store.load({ projectKey, sessionId });
      // 空と不在を分けない: どちらも引けてはいて、待っても変わらない。
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
    if (material.kind !== 'loaded') return null;
    const { entries } = material;
    return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  }

  /**
   * `fromRunnerId` を見るのは `case 'closed'` / `case 'resume_failed'` だけ: 古い runner から遅れて届いた出来事が、別の runner へ移った後の委譲の台帳・貸し出しを巻き戻すのを防ぐ。`RunnerEvent` 自身は `runnerId` を運ばない。
   */
  async #onEvent(event: RunnerEvent, fromRunnerId: string): Promise<void> {
    // 札は最初の `await` より前に取る（理由は `UsageRecordOrder`、`usage.ts`）。
    const usageTicket =
      event.type === 'usage' ? this.#usageOrder.ticket(`manager:${event.managerId}`) : undefined;
    const fetchGate = this.#enterReportFetchGate(event);
    try {
      // 待つ相手が無いときは `await` を挟まない（余計な yield が並行した出来事の順序を変えるため）
      if (fetchGate.wait !== undefined) await fetchGate.wait;
      await this.#handleEvent(event, fromRunnerId, usageTicket);
    } finally {
      usageTicket?.release();
      fetchGate.release();
    }
  }

  /**
   * 計測・生ログのような状態を動かさない出来事は待たせない。門は `outboxFetchTotalTimeoutMs` で必ず開く。
   */
  #enterReportFetchGate(event: RunnerEvent): {
    wait: Promise<void> | undefined;
    release: () => void;
  } {
    const noGate = { wait: undefined, release: () => undefined };
    if (!(isSessionScopedEvent(event) || event.type === 'note' || event.type === 'worker_wait')) {
      return noGate;
    }
    const managerId = event.managerId;
    const previous = this.#reportFetchGates.get(managerId);
    if (event.type !== 'report' || (event.files?.length ?? 0) === 0) {
      return previous === undefined ? noGate : { wait: previous, release: () => undefined };
    }
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.#reportFetchGates.set(managerId, gate);
    return {
      wait: previous,
      release: () => {
        if (this.#reportFetchGates.get(managerId) === gate)
          this.#reportFetchGates.delete(managerId);
        open();
      },
    };
  }

  /** 失敗は投げない: 取り出しの不調で報告を止めない。取れなかったものは名前と理由で返し、黙って落とさない。 */
  async #fetchReportFiles(
    event: Extract<RunnerEvent, { type: 'report' }>,
    fromRunnerId: string,
  ): Promise<ManagerReportFiles> {
    const files = event.files ?? [];
    const rejectedFiles = event.rejectedFiles ?? [];
    if (files.length === 0) return { attachments: [], rejected: rejectedFiles.map(rejectedFileOf) };
    const runner = await this.#runners.get(fromRunnerId).catch(() => null);
    const fallbackReason = (reason: string): ManagerReportFiles => ({
      attachments: [],
      rejected: [
        ...rejectedFiles.map(rejectedFileOf),
        ...files.map((file) => rejectedFileOf({ name: file.name, reason })),
      ],
    });
    if (runner === null) {
      return fallbackReason('受け取れなかった（報告を出した runner が名簿に居ない）');
    }
    try {
      return await fetchManagerOutbox({
        runner,
        runnerNamesOutbox: this.runnerHasCapability(fromRunnerId, RUNNER_CAPABILITY_MANAGER_OUTBOX),
        managerId: event.managerId,
        reportId: event.reportId ?? randomUUID(),
        files,
        rejectedFiles,
        store: this.#stores.attachments,
        limits: this.#attachmentLimits ?? readAttachmentLimits().limits,
        ...(this.#outboxFetchFileTimeoutMs === undefined
          ? {}
          : { fileTimeoutMs: this.#outboxFetchFileTimeoutMs }),
        ...(this.#outboxFetchTotalTimeoutMs === undefined
          ? {}
          : { totalTimeoutMs: this.#outboxFetchTotalTimeoutMs }),
      });
    } catch (error) {
      return fallbackReason(`受け取れなかった（取り出しの処理が失敗した: ${reasonOf(error)}）`);
    }
  }

  async #handleEvent(
    event: RunnerEvent,
    fromRunnerId: string,
    usageTicket: UsageRecordTicket | undefined,
  ): Promise<void> {
    if (event.type === 'shutting_down') {
      // 同期で立てる: 先頭の `await` より前でなければ `stop()` の判定に間に合わない（`#onEvent` は並行に走る）。
      this.#farewellRunners.add(fromRunnerId);
      return;
    }
    if (event.type === 'hello') {
      this.#farewellRunners.delete(fromRunnerId);
      this.#farewellRunners.delete(event.runnerId);
      if (this.#stopped) return;
      // 前の名乗りを持ち越さない: 同じ runnerId の器が入れ替わって版が下がりうる。
      this.#runnerCapabilities.set(event.runnerId, new Set(event.capabilities ?? []));
      if (event.attachmentBodyLimit === undefined) {
        this.#runnerAttachmentBodyLimits.delete(event.runnerId);
      } else {
        this.#runnerAttachmentBodyLimits.set(event.runnerId, event.attachmentBodyLimit);
      }
      if (event.managerModel === undefined && event.workerModel === undefined) {
        this.#runnerModels.delete(event.runnerId);
      } else {
        this.#runnerModels.set(event.runnerId, {
          ...(event.managerModel === undefined ? {} : { manager: event.managerModel }),
          ...(event.workerModel === undefined ? {} : { worker: event.workerModel }),
        });
      }
      if (event.anthropicRoute === undefined) {
        this.#runnerAnthropicRoutes.delete(event.runnerId);
      } else {
        this.#runnerAnthropicRoutes.set(event.runnerId, event.anthropicRoute);
      }
      this.#setRunnerManagerPeers(event.runnerId, event.managerPeers, event.managerPeersClosed);
      // 初回だけ素通りにしない: 起動時に掴んだ器と SSE の繋がった先が違う場合（畳まれつつある旧 runner がまだ `/health` に答える間）に取り直しが起きない。
      void this.#reattach(event.runnerId);
      return;
    }

    if (event.type === 'anthropic_route') {
      if (this.#stopped) return;
      this.#runnerAnthropicRoutes.set(event.runnerId, event.anthropicRoute);
      return;
    }

    if (event.type === 'manager_peers') {
      if (this.#stopped) return;
      this.#setRunnerManagerPeers(event.runnerId, event.managerPeers, event.managerPeersClosed);
      return;
    }

    if (event.type === 'scratch_sweep') {
      await this.#onScratchSweep(event, fromRunnerId);
      return;
    }

    if (event.type === 'codex_auth') {
      if (this.#codexAuth === undefined) return;
      const runner = await this.#runners.get(fromRunnerId).catch(() => null);
      await this.#codexAuth.onRunnerNotice(event, fromRunnerId, runner);
      return;
    }

    const record = this.#records.get(event.managerId) ?? (await this.#load(event.managerId));
    if (!record) return;

    const generation = this.#judgeSessionGeneration(record, event);
    if (generation === 'stale' && isSessionScopedEvent(event)) {
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text:
          `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （古いセッションの出来事のため無視。いま追っている世代は ` +
          `${record.sessionGeneration ?? '不明'}、この出来事の世代は ${event.sessionGeneration ?? '不明'}）` +
          (event.type === 'closed'
            ? `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}`
            : `古いセッションの ${event.type} を無視した`),
      });
      return;
    }

    // 窓の間は `job.runnerId` がまだ元の runner で `#ignoreIfMovedAway` が素通りし、移送の前に古い報告が台帳と受信箱へ流れるので、結論が出るまで預かる。
    if (
      event.type === 'session' ||
      event.type === 'report' ||
      event.type === 'ask' ||
      event.type === 'settled'
    ) {
      // 移送先自身の出来事も預かる: 素通りさせると `#ignoreIfMovedAway` が「移った後の古い runner」と読んで捨てる。
      if (this.#relocatingTo.has(event.managerId)) {
        this.#deferEvent(event, fromRunnerId);
        return;
      }
      // 世代で選り分けない: 世代の判定は窓が閉じるとき（応答で追う世代が決まった後）に行う。
      if (
        event.type === 'report' &&
        this.#sameRunnerResumeWindow.get(event.managerId) === fromRunnerId
      ) {
        this.#deferEvent(event, fromRunnerId);
        return;
      }
    }

    switch (event.type) {
      case 'session': {
        if (await this.#ignoreIfMovedAway(record, fromRunnerId, event.managerId, 'session')) return;
        // 欄が無い session（古い runner・init に `plugins` が無かったセッション）では上書きしない: 「見ていない」で前の観測を消さないため
        if (event.pluginLoad !== undefined) {
          this.#pluginLoad.set(fromRunnerId, {
            at: new Date(this.#now()).toISOString(),
            managerId: event.managerId,
            pluginLoad: event.pluginLoad,
          });
          const described = describePluginLoadForJournal(event.pluginLoad);
          if (this.#pluginLoadDigests.get(event.managerId) !== described.digest) {
            this.#pluginLoadDigests.set(event.managerId, described.digest);
            await this.#journal({
              type: 'exchange',
              with: 'manager',
              role: 'inbound',
              text: `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] ${described.text}`,
            });
          }
        }
        record.job.sessionId = event.sessionId;
        record.attached = true;
        this.#noteRunnerSessionSince(record);
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
        // 止めた後に届く `report` を無条件に処理しない: `#retire()` 後も `#onEvent` は台帳から像を作り直す（`#load()`）ので、`stopped` を上書きし `#emit()` でクローンのターンを起こしてしまう。日誌には残す（捨てると黙って失われる）。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （停止済みのため受信箱へは回さない）${event.text}`,
          });
          // 本文は台帳にも残す: 日誌だけだと、誤って止めたことに気づく契機が `manager_stop` / `manager_report` のどちらにも出ない。`record.job.status` は動かさず `#emit()` もしない。
          record.job.lastFoldedTurn = { text: event.text, at: new Date().toISOString() };
          await this.#persist(record);
          return;
        }
        if (await this.#ignoreIfMovedAway(record, fromRunnerId, event.managerId, 'report')) return;
        // `reportId` で冪等にする（`ask` の `requestId` と同型）。
        // `reportId` を送らない旧 runner の report は拒まず毎回処理する: 無条件に捨てると本物の報告が消える。二重配達を見分けられないだけ。
        if (event.reportId !== undefined) {
          const reported = this.#reportedOf(record);
          if (reported.has(event.reportId)) return;
          reported.set(event.reportId, true);
        }
        record.job.lastReport = event.text;
        // `#noteRunnerSessionSince` と同じ時計（`this.#now()`）で書く: `reportSeenInSession` が前後を比べるので、別の時計だと注入した時計の試験で崩れる。
        record.job.lastReportAt = new Date(this.#now()).toISOString();
        // 並行処理の間に `closed(failed / lost)` が書いた終端を `event.status` で書き戻さない: 台帳は非終端のままクローンに `closed_failed` が出る／`lost` の引き取りの契機が消える。
        // `isTerminalJobStatus` は使わない: `done` を含むが、`done` は idle を兼ね再び走り出せる。managerId ごとの直列化は配達順に効くので採らない。
        const settledByClosed = record.job.status === 'failed' || record.job.status === 'lost';
        if (!settledByClosed) record.job.status = event.status;
        // `waiting` が空なら `waiting_human` を名乗らせない: `stop()` は `#settleAll` の前に控えた状態で報告を畳むので「解かれる前」の値が届き、器の入れ替え（`abort()` の上書きが無い経路）では食い違いが台帳に残る。
        // `event.status` そのものは書き換えない: 報告が名乗った値は `lastReportStatus` に残し、「何を名乗ったか」と「いまの状態をどう数えるか」を1つに畳まない。
        if (!settledByClosed && event.status === 'waiting_human' && record.waiting.length === 0) {
          record.job.status = 'running';
        }
        // `record.job.status` とは意図して別の値になりうる（上の補正）: `lastReportStatus` は「報告が何を名乗ったか」を残す欄で、既定値は作らない。
        record.job.lastReportStatus = event.status;
        // 応答として終わった回では畳んだ本文を消す: 残すと次に `manager_report` を読む側が「畳まれた途中経過」と誤読する。
        delete record.job.lastFoldedTurn;
        // `event.failure` の有無で条件を付けない: `report` が届いたこと自体が「セッションは生きて出力している」を確定させ、`lastSystemError` / `lastCgroupEvents` は過去になる。
        delete record.job.lastSystemError;
        delete record.job.lastCgroupEvents;
        // 失敗として終わった回は台帳にもそう残す: 包んだ文字列だけに頼ると、一覧を出す側は「報告が来た」と「エラーで死んだ」を本文の先頭を読んで判定することになる（＝ 表示のたびに文言の判定が要る）。
        // 応答として終わった回では消す: 過去の失敗が生きているマネージャーに貼り付く。`delete` なのは `exactOptionalPropertyTypes` のため。
        if (event.failure === undefined) {
          delete record.job.lastFailure;
          // 枠で止まった印は成功した回で下ろす（失敗の回では下ろさない: そこが起こし直したい相手）。印は `reached` の通知でターンの途中にも立つので、残すと通り切ったマネージャーが「枠で止まっている」ことになり、鍵が回るたびに1ターン焼く。
          this.#usageStopped.delete(event.managerId);
          this.#resetTimeSkewMatches.delete(event.managerId);
          // `#clearUsageStoppedMark` を呼ばず直接 `delete`: すぐ下の `#persist` に乗せるので、呼ぶと二重に書き込む。
          delete record.job.usageStoppedAt;
        } else {
          record.job.lastFailure = { ...event.failure, at: new Date().toISOString() };
        }
        // `event.failure` の有無とは独立に判定する: 両方無いことも片方だけ在ることもある。
        if (event.unreported === undefined) {
          delete record.job.lastUnreported;
        } else {
          record.job.lastUnreported = { ...event.unreported, at: new Date().toISOString() };
        }
        await this.#persist(record);
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}] ${event.text}`,
        });
        // 待たない: 完了を待つと、報告を受けてからクローンのターンが起きるまでに runner への往復が乗る。`contentless` / `awaitingBackground` の早い `return` より手前に置く（後ろだと中身の無い報告・背景待ちの報告で観測が取られない）。停止済みの早期 return は通らないので、止めた委譲へ往復を起こさない。
        this.#observeUnpushedWorkOnce(event.managerId, 'report');
        // `contentless` / `awaitingBackground` の早い `return` より手前に置く: 後ろだと中身の無い報告で終わった回だけ起こされないまま残る。
        // 判定は `event.failure` ではなく印（`#usageStopped`）で行う: 失敗には SDK のクラッシュも混ざり、枠と無関係に落ちたターンへ「通る鍵に戻った」と言ってしまう。
        await this.#settleUsageWake(event.managerId, this.#usageStopped.has(event.managerId));
        // 添えられたもの・断ったものが在る報告は、本文が空でも背景処理待ちでも配る: 成果物を握り潰さない。何も添えられていない報告は `await` を挟まない。
        const reportFiles =
          (event.files?.length ?? 0) > 0 || (event.rejectedFiles?.length ?? 0) > 0
            ? await this.#fetchReportFiles(event, fromRunnerId)
            : undefined;
        const carriesFiles =
          reportFiles !== undefined &&
          (reportFiles.attachments.length > 0 || reportFiles.rejected.length > 0);
        // 中身の無い報告は記録だけ残しクローンのターンを起こさない。`event.text` の文字列ではなく構造化された印 `contentless` で判定する。
        if (event.contentless === true && !carriesFiles) return;
        // 背景処理の完了待ちで畳んだターンの報告は記録だけ残し受信箱へ回さない（`event.text` の中身では判定しない）。捨てるのではなく後で必ず配る: 次の本物の報告が `#emit()` を通るときに上書きされ、来なければ `case 'closed'` と `flushWithheldReports()` が配る。
        // 配らなかった判断は日誌の `decision` に残る（本文は上の `exchange` に全文あるので抜粋でよい）。
        if (event.awaitingBackground !== undefined && !carriesFiles) {
          const awaitingBackground = event.awaitingBackground;
          await this.#journal({
            type: 'decision',
            decision: `[${event.managerId}] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない`,
            grounds:
              `managerId=${event.managerId} ` +
              `awaitingBackground.count=${String(awaitingBackground.count)} ` +
              `breakdown=${awaitingBackground.breakdown} ` +
              `本文冒頭: ${excerptLine(event.text, WITHHELD_REPORT_EXCERPT)}`,
          });
          this.#withholdBackgroundReport(event.managerId, event.text, awaitingBackground);
          return;
        }
        // `event.text` を包まない: runner 側で複数の書き手（マネージャー・SDK・runner）の断片が既に1本の文字列に連結されており、この層には `codeSpan()` で包む境目が無い。包むなら連結する側（`runner.ts`）。
        // `foldedTurn` は本文の文言ではなく構造化された印（`event.failure` / `event.unreported`）だけで判定する。
        const foldedTurn = event.failure !== undefined || event.unreported !== undefined;
        // `synthesized` が無い（旧 runner）ときは常に即配る側へ倒す: 版がずれた窓では必ず「起こす側」にする。
        // 合流窓へ積む枝では `foldedTurn` を渡さない: 複数の断片を1本にまとめる口で単発の bool を渡す場所が無く、`#flushSynthesizedNoticeFor` が `label` から判定し直す。
        if (event.synthesized !== undefined && !carriesFiles) {
          this.#queueSynthesizedNotice(event.managerId, event.synthesized, event.text);
        } else {
          this.#emit(
            event.managerId,
            'report',
            event.text,
            undefined,
            undefined,
            'full',
            foldedTurn,
            carriesFiles ? reportFiles : undefined,
          );
        }
        return;
      }

      case 'ask': {
        // 止めたマネージャーの確認要求を待ちへ積まない: `#retire()` 後も `#load()` が像を作り直すので、積むと `waiting` / `status` を `stopped` から動かしクローンへも `#emit()` してしまう。日誌には残す。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'escalation',
            question: event.summary,
            approvalId: event.requestId,
            managerId: event.managerId,
          });
          return;
        }
        if (await this.#ignoreIfMovedAway(record, fromRunnerId, event.managerId, 'ask')) return;
        // `requestId` で冪等にする: 二度配ると、答えたはずの確認がクローンへもう一度届き、答えても runner 側は中断済みで「待っていない」と返る。
        const asked = this.#askedOf(record);
        if (asked.has(event.requestId)) return;
        asked.set(event.requestId, true);

        record.waiting.push({
          requestId: event.requestId,
          summary: event.summary,
          kind: event.kind,
          // 取れなければキーごと書かない（`askedAt: undefined` は JSON を通ると同じ形にならない）。デーモン側で `new Date().toISOString()` を作らない: 値の意味が経路によって変わる。
          ...(event.askedAt === undefined ? {} : { askedAt: event.askedAt }),
        });
        // 終端を `waiting_human` で書き戻さない: 待つ間に `closed(failed / lost)` が書いていると、台帳が非終端へ戻り `lost` の引き取りの契機も消える。
        if (record.job.status !== 'failed' && record.job.status !== 'lost') {
          record.job.status = 'waiting_human';
        }
        await this.#persist(record);
        await this.#journal({
          type: 'escalation',
          question: event.summary,
          approvalId: event.requestId,
          managerId: event.managerId,
        });
        // `markup: 'none'` は `permission` のときだけ立てる: `summary` は道具の呼び出し引数の JSON ダンプで、バッククォートや `*` が入っていても Markdown ではなく、`commitments.tsx` が `<Markdown>` で描くと `<code>` に食われて字面から消える。
        // `runner.ts` 側で包まない: `<Markdown>` で描くのは1面だけで、残り5面は素テキストなので記号が増える。`runner` が文面を Markdown に変えたら黙って外れるので `runner-permission-summary-markup.test.ts` が固定している。
        // `question` でも立てない（モデルが書いた文章）。ただし `describeQuestions()` が `brief(input)` へ落ちた回は `kind` が同じ `'question'` のままで、この層には区別する材料が無く化けが残る。塞ぐなら `ask` イベントへ欄を足す（`runner-protocol.ts` の版ずれの窓が開く別作業）。
        const markup: TextMarkup | undefined = event.kind === 'permission' ? 'none' : undefined;
        this.#emit(event.managerId, event.kind, event.summary, event.requestId, markup);
        return;
      }

      case 'settled': {
        if (await this.#ignoreIfMovedAway(record, fromRunnerId, event.managerId, 'settled')) return;
        // 外す前に `summary` を控える: `withdrawn` の journal に「何の確認だったか」を残すのに要る（`abort()` が既に空にしていれば拾えず、その旨も書く）。
        const pendingSummary = record.waiting.find(
          (item) => item.requestId === event.requestId,
        )?.summary;

        // 止めたマネージャーへの専用ガードを足さない: `abort()` が `waiting` も `[]` にするので `'waiting_human'` の条件が `'stopped'` から甦らせる余地を持たず、「外す」操作だけなので足しても観測できる差が無い。`withdrawn` の記録は止めた後でも残す。
        record.waiting = record.waiting.filter((item) => item.requestId !== event.requestId);
        if (record.job.status === 'waiting_human' && record.waiting.length === 0) {
          record.job.status = 'running';
        }
        await this.#persist(record);

        // 新しい日誌の種別を作らず `escalation` を再利用する: `approvalId` は承認待ちキューの項目 id もマネージャーの確認の id も受ける欄で、`withdrawnAt` の形がそのまま使える。
        if (event.withdrawn !== undefined) {
          await this.#journal({
            type: 'escalation',
            question: pendingSummary ?? '（不明 — 台帳の該当行が settled より先に消えていた）',
            approvalId: event.requestId,
            managerId: event.managerId,
            withdrawnAt: new Date().toISOString(),
            withdrawnReason:
              `この確認への答えは CLI へ届いていない（セッションを畳んだため）。` +
              `理由: ${event.withdrawn.reason}`,
          });
        }
        return;
      }

      case 'note': {
        // 受信箱へは出さず日誌にだけ残す（マネージャーの発言ではない）。`escalate` の有無で変えない（下で足すだけ）。
        // `event.stall` の欄で判定し、本文の文字列で嗅がない。旧 runner の note は `stall` を知らず `exchange` に落ちる。
        if (event.stall === undefined) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}] ${event.text}`,
          });
        } else {
          await this.#journal({
            type: 'subagent_stall',
            agentId: event.stall.agentId,
            ...(event.stall.agentType === undefined ? {} : { agentType: event.stall.agentType }),
            ownedTaskCount: event.stall.ownedTaskCount,
            sessionTaskCount: event.stall.sessionTaskCount,
            wakeupCount: event.stall.wakeupCount,
            outcome: event.stall.outcome,
            text: `[${event.managerId}] ${event.text}`,
          });
        }

        // 欄（`event.escalate`）で判定し、本文を嗅がない。
        if (event.escalate === true) {
          this.#emit(
            event.managerId,
            'report',
            `[${event.managerId}] 作業者が自分で起こした背景処理を残したまま畳もうとする回が、` +
              '背景処理の完了を待つ上限（30分）に達して打ち切った。**この作業者は自動では再開しない**（委譲がここで止まっている）。\n' +
              `詳細（何が残っているか・何回目だったか）: ${event.text}\n` +
              '全件は日誌に残っている（`journal_read` で辿れる）。',
          );
        }

        // 逃すと自動で追いついたセッションにまで `manager_list` / `runner_list` の世代の食い違いが出続ける。世代の値は受け取らない: runner は世代を知らず、daemon が現役の身元を読み直す。
        if (event.tokenRotation === true) this.#rememberTokenIdentity(event.managerId);
        return;
      }

      case 'tool_use': {
        record.lastToolSettledAt = new Date(this.#now()).toISOString();
        await this.#journal({
          type: 'tool_use',
          actor: event.actor,
          tool: event.tool,
          input: event.input,
        });
        // 検出は分類器ではなく単純な正規表現で、誤検出を許容する: 害は観測が1回余分になるだけ（読み取りで多重投げも止まる）。見逃すと報告より前に落ちた委譲の枝名が残らない穴が開く。
        // 例外で `tool_use` の処理を止めない。
        try {
          if (event.tool === 'Bash') {
            const toolInput = event.input as { command?: unknown } | null | undefined;
            const command = toolInput?.command;
            if (
              typeof command === 'string' &&
              (bashCommandLooksLikeGitPush(command) || bashCommandLooksLikeGitBranchCreate(command))
            ) {
              this.#observeUnpushedWorkOnce(event.managerId, 'tool_use');
            }
          }
        } catch {
          // tool_use の処理を巻き添えにしないための保険。
        }
        return;
      }

      case 'permission_denied': {
        // 日誌には全部残す: ここが無いと「静かになった」と「起きていない」が区別できない。受信箱へは繰り返しのときだけ（拒否は正常な運用でも起きるので、1件ずつ流すとクローンの判断が雑音で鈍る）。
        // 鍵は道具＋層: 層を分けないとマネージャー自身の拒否と作業者の拒否が同じ数へ畳まれる。`event.actor` が無い回は「取れていない」層として別枠で数え、マネージャー側へ黙って寄せない。
        const actorLayer = denialActorLayerOf(event.actor);
        const denied = this.#deniedOf(record);
        const key = denialKey(event.tool, actorLayer);
        const count = (denied.get(key) ?? 0) + 1;
        denied.set(key, count);
        (record.deniedLastAt ??= new Map()).set(key, new Date(this.#now()).toISOString());
        // この回に無ければ前回分を消す: 「最新1件」の像なので古い理由を持ち越さない。
        const reasonSnapshot = denialReasonSnapshotOf(event);
        if (reasonSnapshot === undefined) {
          record.deniedLastReason?.delete(key);
        } else {
          (record.deniedLastReason ??= new Map()).set(key, reasonSnapshot);
        }
        (record.deniedLastRequestId ??= new Map()).set(key, event.toolUseId);

        // escalation は layer 別ではなく道具ごとの合計で判定する: 層ごとだと頻度が下がりすぎてクローンに1件も上がらず「止まっていることが見える」を裏切る。合計は拒否1件ごとにちょうど1ずつ増えるので、`shouldEscalateDenial` の exact-equality（`step === count`）にそのまま渡せる。
        const toolTotal = denied
          .entries()
          .reduce((sum, [k, v]) => (decodeDenialKey(k).tool === event.tool ? sum + v : sum), 0);

        // 欠けているものは作り物を出さず、そのキーごと省く。
        const denialDetails = [
          event.reasonType === undefined ? undefined : `分類: ${event.reasonType}`,
          event.reason === undefined ? undefined : `理由: ${event.reason}`,
          event.message === undefined ? undefined : `モデルへの拒否文: ${event.message}`,
        ].filter((line): line is string => line !== undefined);
        const denialSuffix = denialDetails.length > 0 ? ` [${denialDetails.join(' / ')}]` : '';
        // 入力は値ではなく形だけ残す: 値に環境変数・トークン・URL 内の鍵が入りうる。それでも「何も分からない」へは戻さない（先頭の語・欄名・長さで良性の誤検知と拒否されるべきコマンドを分けられる）。
        // 「無い」の種類を潰さない: 空のコマンドと入力が届かない経路が同じ字面に見える。
        const inputShape = denialInputShape(event.input);
        const inputText = inputShape ?? denialInputAbsence(event.via);
        // `undefined`（取れていない）を「マネージャー」へ読み替えず、3値のまま言う。
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
            `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] ${event.tool} の実行が確認へ上がらずに止められた` +
            `（${actorLabel} / このマネージャーのこの組で ${count} 件目 / ` +
            `${event.via === 'live' ? '走行中の合図' : 'result の記録'}）: ` +
            `${inputText}${denialSuffix}`,
        });

        // 止めた委譲の拒否は受信箱へ回さない: クローンの判断材料にならず、`DENIED_ESCALATE_AT = 1` で1件目から `#emit` してしまう。日誌と数え上げは済んでいる。
        if (record.job.status === 'stopped') return;
        if (!shouldEscalateDenial(toolTotal)) return;
        // 本文は Markdown で書いてあるので、Markdown ではない字面（入力の形・ツール名）は `codeSpan()` で包む: 形の欄名のアンダースコアが `<em>` になる。`markup` は立てられない（書き手が3人の1本の文字列）ので、混ざらないようにするだけ。
        // `denialSuffix` と入力が無い回の一文は包まない: 包むと等幅になり「文章」ではなく「コード」として描かれる。日誌も包まない（Markdown で描かれる面ではない）。
        // 層が取れているなら、その層だけを名指しする: 両論併記だとクローンが誤った相手へ指示しうる。取れていない回だけ両論を残し、分からないものを片方へ絞らない。
        const stuckWho =
          actorLayer === 'manager'
            ? 'マネージャー自身の手が止まっている可能性がある'
            : actorLayer === 'worker'
              ? '作業者の手が止まっている可能性がある'
              : 'マネージャーか作業者の手が止まっている可能性がある（どちらの層かはこの合図からは取れていない）';
        // 拒否の出所を断定しない: alteroid 自身の `PreToolUse` フック（`bash-wait-guard.ts` など）の拒否も同じ `case 'permission_denied'` を通り、帰結が違う（器の分類器 / deny 規則は担い手が本当に詰むが、フックは理由と代替案が担い手へ直接返り自力で抜けられる）。「クローンに回っていない」と決めつけず、まず担い手自身が受け取った拒否文を読ませる。
        this.#emit(
          event.managerId,
          'report',
          `${codeSpan(event.tool)} の実行が確認へ上がらずに止められた（${actorLabel} / このマネージャーで ${toolTotal} 件目・道具ごとの合計）。` +
            'この合図だけでは拒否の出所は特定できない。**まず、担い手自身に返っている拒否の理由文を読ませること**。' +
            '(a) 器のモデル分類器か deny 規則がその場で拒否したのであれば、この確認はクローンには回ってきていない。' +
            '(b) alteroid 自身の `PreToolUse` フック（例: `bash-wait-guard.ts`）が拒否したのであれば、' +
            '理由と代替案は担い手へ直接返っているので、担い手はそれだけで自力で抜けられることがある。' +
            `${stuckWho}（(a) の場合）。` +
            `直近の入力の形: ${inputShape === undefined ? inputText : codeSpan(inputShape)}${denialSuffix}` +
            // 「先頭の語」は拒否の理由ではない（機械的に取った `command` の先頭の単語）が、形だけを見ると原因欄に読めるので、載っているときだけ断る。
            (inputShape !== undefined && inputShape.includes('先頭の語=')
              ? '（「先頭の語」は入力コマンドの先頭の単語であって、拒否の原因ではない）'
              : '') +
            // `inputHead` が欠ける回は作り物で埋めず「形」だけで案内する。出所（拒否の合図が運んだ値ではなく、同じ `tool_use_id` で `PreToolUse` フックが先に見た値）を明記して誤解させない。
            (event.inputHead === undefined
              ? ''
              : `\n拒否より前に見た入力の先頭（伏せ字・最大160字。この拒否の合図自体が` +
                `運んだ値ではなく、同じ tool_use_id で runner の \`PreToolUse\` フックが` +
                `拒否より前に見た値である）: ${codeSpan(event.inputHead)}`) +
            DENIAL_REPLY_ROUTE +
            '\n全件は日誌に残っている（`journal_read` で辿れる）。',
        );
        return;
      }

      case 'worker_wait': {
        // 日誌に閉じる: 台帳には足さない（生きているマネージャーの状態ではない）。受信箱へも出さない（1区間ごとに割り込むほどの事実ではない）。
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
        // この case への到着をターン成功の証拠にしない: 枠に当たったターンも `subtype: 'success'` / `is_error: true` でここへ来る。`answered === true` のときだけ観測を渡し、欠けていたら渡さない。`observedBy` は `#observeForTokenRotation` が付ける。
        // 別の runner へ移った後に古い runner から届いた累積は台帳の基準へ畳まず、応答の観測も渡さない（現役の鍵の成功ではない）。番はここでも待つ。
        if (this.#movedAwayFrom(record, fromRunnerId)) {
          try {
            await usageTicket?.turn();
            await this.#recordStaleRunnerUsage(event, fromRunnerId, record);
          } finally {
            usageTicket?.release();
          }
          return;
        }

        if (event.answered === true) {
          await this.#observeForTokenRotation(event.managerId, { succeeded: true });
        }

        // ここで自分の番を待つ: 上の `await` の間に後から届いた usage が先に `record` へ着くと、小さい累積が後から届いて「数え直し」と読まれ過大に数える。
        await usageTicket?.turn();
        const at = new Date();
        // 1回だけ引いて使い回す: 2回引くと、間に回し手が `#tokenIdentities` を書き換えたとき「有無の判定」と「使う値」が別の世代を見る。
        const tokenIdentity = this.#tokenIdentities.get(event.managerId);
        let fold;
        try {
          fold = await this.#stores.usage.record({
            // モデル id で層を代用しない: クローンも既定で opus で走る。
            layer: 'manager',
            // 作業者（Task subagent）と compaction の分もここに混ざる（SDK の `modelUsage` が合算して降ろす）。作業者の 0 行を作らない（「使っていない」と読める）。
            site: 'session',
            managerId: event.managerId,
            date: usageDate(at),
            at: at.toISOString(),
            snapshot: { sessionId: event.sessionId, models: event.models },
            accumulation: 'cumulative',
            runner: { id: fromRunnerId, superseded: false },
            // `#tokenIdentity?.()` を読み直さない: 回した後に届いた前のセッションぶんの消費が新しいトークンに付く。無いときは渡さない。
            ...(tokenIdentity === undefined ? {} : { tokenId: tokenIdentity.tokenId }),
          });
        } catch {
          usageTicket?.release();
          // 台帳に積めないことで仕事は止めない。ただし黙って消さない。
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] 消費を台帳へ記録できなかった（この分は集計に出ない）`,
          });
          return;
        }

        usageTicket?.release();

        // 増分が空の回は行を書かない: 取れない軸に0の行を作らない。その回の `contextUsage` も一緒に捨てる（独立の `context_usage` イベントが残す）。
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
            ...(event.contextUsage === undefined ? {} : { contextUsage: event.contextUsage }),
          });
        }

        // 数え直しを黙って通さない: 累積が 0 に戻るのは正常だが、記録が無いと後から「なぜ集計が飛んでいるか」を誰も辿れない。
        if (fold.reset !== undefined) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] 消費の累積が数え直された` +
              `（$${fold.reset.fromCostUsd.toFixed(4)} → $${fold.reset.toCostUsd.toFixed(4)}）。` +
              'resume か /clear で SDK 側の累積が 0 から始まったため。記録済みの分は保持している。',
          });
        }
        return;
      }

      case 'peer_usage': {
        // トークンの身元（`#tokenIdentities`）は付けない: マネージャー本体のセッションの鍵で、peer が使った鍵とは限らない（取れない軸は埋めない）。
        const at = new Date();
        try {
          if (event.unmetered === true) {
            // 0 を積まず「取れなかった」として数える。
            await this.#stores.usage.recordUnmetered({
              layer: 'manager',
              site: 'peer',
              managerId: event.managerId,
              date: usageDate(at),
              at: at.toISOString(),
              provider: event.provider,
            });
            return;
          }
          const fold = await this.#stores.usage.record({
            layer: 'manager',
            site: 'peer',
            managerId: event.managerId,
            date: usageDate(at),
            at: at.toISOString(),
            snapshot: {
              ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
              models: event.models,
            },
            accumulation: 'oneshot',
          });
          if (Object.keys(fold.delta).length > 0) {
            await this.#journal({
              type: 'turn_usage',
              layer: 'manager',
              site: 'peer',
              managerId: event.managerId,
              ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
              models: fold.delta,
            });
          }
        } catch {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] peer（${event.provider}）の消費を台帳へ記録できなかった（この分は集計に出ない）`,
          });
        }
        return;
      }

      case 'context_usage': {
        // `turn_usage` とは独立に書く: 増分が無い回・失敗した回は `turn_usage` の行を書かないので、文脈占有だけを別の行として残す。
        await this.#journal({
          type: 'context_usage',
          layer: 'manager',
          site: 'session',
          managerId: event.managerId,
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          turnSucceeded: event.turnSucceeded,
          contextUsage: event.contextUsage,
        });
        return;
      }

      case 'usage_notice': {
        // `reached` だけで立てる: `transition` / `warning` はまだ動いており、`org_policy` は鍵を回しても直らず起こすと1ターン焼く。
        // `await` の手前で立てる（速さの都合ではない）: 同じターンの `usage_notice` と `report` は並行に走り、後ろに置くと `report` 側の下ろしが先に走って自力で終えた委譲に印が残り、回転のたびに要らない一言を投げる。
        // 畳み（下の `delivered`）より手前に置く: 後ろだと同じ文言で2本目が当たった回に印が立たない。
        if (event.notice.kind === 'reached') {
          this.#usageStopped.add(event.managerId);
          // 台帳にも写す: `Set` はデーモンの作り直しで消え、入れ替わりを跨いだ委譲が二度と起こされない。代入は `Set.add` と同じ同期の位置に置く（`await` を挟むと並行の `report` に先を越され、片方だけ遅れて真になる窓ができる）。
          // 欄が既に立っていれば persist しない（通知は何度も届く）。書き込みの失敗で下を巻き添えにしない: 下の回し手への受け渡しが鍵を回す契機そのもので、投げると鍵が回らないまま全員が止まる。
          if (record.job.usageStoppedAt === undefined) {
            record.job.usageStoppedAt = new Date(this.#now()).toISOString();
            try {
              await this.#persist(record);
            } catch (error) {
              noteDroppedRecord('枠で止まった印の永続化', `managerId=${event.managerId}`, error);
            }
          }
        }

        // `stopped` ガードを足さない: `usage_notice` / `rate_limit` が運ぶのはアカウント単位の枠の事実で、マネージャーを止めても消えない（他も同じ枠を使う）。畳むとクローンが知るべき情報を捨てる。
        // 同じ文言で受信箱を埋めない: 通知はターンごとに繰り返し届き、変わった1回が埋もれる。判定は文字列の一致ではなく「もう配ったか」（`#usageNotices` の doc）。
        // 回し手へは受信箱の畳み（下の `delivered`）より先に渡す: 後ろだと2本目のマネージャーが同じ文言で当たった回に回し手が呼ばれない。
        await this.#observeForTokenRotation(event.managerId, { notice: event.notice });

        // 末尾の `notice.text`（SDK の文言そのまま）は `codeSpan()` で包まない: 包むと等幅になり「文章」ではなく「コード」として描かれる。SDK の prose の描き方は表示の方針の話で、ここは決める場所ではない。
        // 実例では化けなかったが、SDK が文言を変えたら測り直しが要る。`describeUsageNotice()` の定型文は変えず、`withRecoveryNote` は末尾に1行足すだけ。
        const text = withRecoveryNote(
          describeUsageNotice(event.notice),
          limitRecoveryOf(event.notice.text),
        );
        const memory = this.#usageNoticeMemoryOf(event.notice.kind);
        if (memory.delivered.has(event.notice.text)) {
          // 畳んだことを記録に残す: `return` だけだと、後から「なぜ1回しか届いていないのか」を誰も辿れない。
          memory.folded += 1;
          // 件数だけでは「何本の異なるマネージャーが当たっているか」に戻せないので集合も持つ。
          memory.foldedManagers.add(event.managerId);
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_THINNING_PREFIX}[${event.managerId}] （配達済みの知らせなので受信箱へは回さない。` +
              `この種類で ${memory.folded} 件目）${text}`,
          });
          // 畳んだ回も計器は回す（配達しないだけで枠に当たった事実は同じ）。
          await this.#rememberResetTimeSkew(event);
          return;
        }
        memory.delivered.set(event.notice.text, true);
        const folded = memory.folded;
        memory.folded = 0;
        const foldedManagers = memory.foldedManagers;
        memory.foldedManagers = new Set();
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text: `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] ${text}`,
        });
        // 畳んだ件数を配る1本に必ず載せる: 受信箱しか見ていない読み手には日誌の行が見えず、「畳んだ」が観測から消える。
        this.#queueSynthesizedNotice(
          event.managerId,
          'usage_notice',
          folded === 0
            ? text
            : `${text}\n（前にこの種類を知らせてから、配達済みの同じ文言を ` +
                `${folded} 件畳んでいる。そのうち ${foldedManagers.size} 本の異なる` +
                `マネージャーが当たっている。全件は日誌に残っている。）`,
        );
        // 計器は配達より後ろに置く: `usage_notice` と `report` は並行に走り、この handler に `await` を足すと配達の順が動く（手前に置くと合流窓が知らせと報告を1本に畳んだ）。読み取り専用の計器を配達の臨界路へ置かない。
        await this.#rememberResetTimeSkew(event);
        return;
      }

      case 'rate_limit': {
        // `stopped` ガードを足さない（`usage_notice` と同じ）: 運んでいるのはアカウント単位の枠の事実。
        // 届いた1件で丸ごと置き換えない（`mergeRateLimitFacts`）: `status` を運ばない観測が「もう `rejected` を知らせた」記憶を消し、次の同じ `rejected` が同文でもう一度配られる。
        // 覚える欄は「トークンの身元 × 枠の種類」で分ける: `kind` だけだと別アカウントの事実が踏み合う。身元はセッションを起こした瞬間のもの（`#tokenIdentities`）で、現役を読み直さない（回った直後に届いた前の鍵の観測が新しい鍵の欄へ入る）。
        const factsKind = event.facts.kind ?? '';
        const memoryKey = rateLimitMemoryKey(
          this.#tokenIdentities.get(event.managerId)?.tokenId,
          factsKind,
        );
        const previous = this.#rateLimits.get(memoryKey);
        const transition = usageTransitionOf(previous, event.facts);
        const merged = mergeRateLimitFacts(previous, event.facts);
        this.#rateLimits.set(memoryKey, merged);

        // 回し手へは事実と遷移で渡し、通知の形へ仕立て直さない: `rejected` は「その枠が尽きた」であって「仕事が止まった」ではなく、`reached` にすると `overage_exhausted` の設定でも課金枠を使わずに回る。
        // 遷移の門（下の `if (transition === undefined) return;`）より手前で渡す: 門はクローンへ同じ知らせを配らないためのもので、遷移が立たない `rejected` の回の回し手の契機を門の後ろでは拾えない。
        // `statusNow` は重ねる前の生の1件から取る: 重ねた形の `status` はアカウントを跨いで残り、回した直後の健全な鍵でもう一度回る。判断はここではしない（`#observeForTokenRotation`）。
        if (transition !== undefined || event.facts.status === 'rejected') {
          await this.#observeForTokenRotation(event.managerId, {
            facts: merged,
            ...(transition === undefined ? {} : { transition }),
            ...(event.facts.status === undefined ? {} : { statusNow: event.facts.status }),
          });
        }

        if (transition === undefined) {
          // 同じ managerId の連打は「跨いだ」に数えない（`#rateLimitJournalFoldFor` が別に間引く）。違う managerId のときだけ集合へ足し、`#journal` は次に遷移が定まった回にまとめて呼ぶ。
          const crossFold = this.#rateLimitCrossFold.get(memoryKey);
          if (crossFold !== undefined && crossFold.lastManagerId !== event.managerId) {
            crossFold.folded.add(event.managerId);
          }
          return;
        }

        // 畳むたびに書かず、遷移が定まったこの回にだけ束ねて書く: 日誌の肥大化をマネージャーの数という軸で作り直さない。溜まっていない回は1行も増やさない。
        const crossFold = this.#rateLimitCrossFold.get(memoryKey);
        if (crossFold !== undefined && crossFold.folded.size > 0) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] 同じ壁を跨いで畳んだ報告に、` +
              `${crossFold.folded.size} 本の異なるマネージャーが当たっている` +
              '（前回この壁の遷移を記録してから、いまの遷移までのあいだ）。',
          });
        }
        this.#rateLimitCrossFold.set(memoryKey, {
          lastManagerId: event.managerId,
          folded: new Set(),
        });

        // 瞬間だけを知らせる（状態を毎回流さない）。
        // SDK 由来の識別子（`kind` / `overageDisabledReason`、任意の字面を通す `z.string()`）は、いま化けていなくても素で埋め込まず受信箱では包む。フォールバックの `'枠'` は包まない（デーモン自身の言葉が SDK の値の顔をする）。日誌は包まない（Markdown で描かれる面ではない）。
        // 定型文を2回書き写すと片方だけ直る事故が起きるので、包み方を受け取って1本の組み立て関数にする。
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
        // 畳むのは日誌の行だけ（1件目は必ず書く）: 配る側へ文字列一致の畳み込みを重ねると、`usageTransitionOf` の状態ベースの判定を壊す（`isCrossWindowStreakEligible` の doc）。
        const journalText = `[${event.managerId}] ${build((s) => s)}`;
        const folded = this.#rateLimitJournalFoldFor(event.managerId).observe(
          journalText,
          journalText,
          this.#now(),
        );
        if (folded.flush !== undefined) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(folded.flush)}`,
          });
        }
        if (folded.write) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `${EXCHANGE_KIND_GAUGE_PREFIX}${journalText}`,
          });
        }
        this.#queueSynthesizedNotice(event.managerId, 'rate_limit', build(codeSpan));
        return;
      }

      case 'mirror': {
        const store = this.#stores.sessionStore;
        if (store === undefined) return;
        try {
          await store.append(event.key, event.entries as never);
        } catch (error) {
          // 止めないが黙って消さない: 預かり損ねたことすら残らないと、後から「無い」のか「預かれなかった」のかが分からない。
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
          const write = await this.#stores.archive.archive(event.managerId, event.body);
          record.job.archiveIds = [...(record.job.archiveIds ?? []), write.id];
          await this.#persist(record);
          // `#journal` は自分で失敗を握るので、退避と台帳への記録の成功を日誌の失敗に道連れにしない。
          const continuityText = describeArchiveContinuityForJournal({
            caller: 'マネージャーの生ログの退避',
            sessionId: event.managerId,
            continuity: write.continuity,
            comparedTo: write.comparedTo,
            bodyChars: event.body.length,
          });
          if (continuityText !== null) {
            await this.#journal({
              type: 'exchange',
              with: 'manager',
              role: 'outbound',
              text: `${EXCHANGE_KIND_RECOVERY_PREFIX}${continuityText}`,
            });
          }
        } catch (error) {
          // 止めないが黙って消さない: 跡が無いと「そもそも退避しなかった」と区別が付かない。
          noteDroppedRecord(
            'トランスクリプトの退避',
            `managerId=${event.managerId} chars=${event.body.length}`,
            error,
          );
        }
        return;
      }

      case 'resume_failed': {
        // 止めた後に遅れて届いた resume_failed で status を巻き戻さず、クローンも起こさない: 無条件に処理すると `running` / `'lost'` へ書き換えて `#post()` し、終端が甦る。日誌には残す。
        // 明示的な `manager_send` の起こし直しは塞がない: `send()` が先に `'running'` を書くので、遅れて届く頃には `'stopped'` ではない。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] （停止済みのため無視）前のセッション` +
              `（${event.sessionId}）を開き直せなかった: ${event.reason}`,
          });
          return;
        }
        // 移った後に古い runner から遅れて届いた resume_failed で巻き戻さない。ただし「不一致」だけで「移った」と言わない: `job.runnerId` に既定値 `'runner-primary'` が焼かれたままだと、同じ runner からでも不一致になり、本当に終わった事実を捨ててしまう（`#resume` だけが書き直す）。
        // 捨てるのは `job.runnerId` が `#registeredRunnerIds()`（名簿にいま居る id）に含まれ、かつ `fromRunnerId` と食い違うときだけ。未記録の古いジョブと名簿が `null`（判定材料なし）のときは従来どおり適用する（安全側）。
        const registeredRunnerIdsForResumeFailed = this.#registeredRunnerIds();
        if (
          record.job.runnerId !== undefined &&
          record.job.runnerId !== fromRunnerId &&
          registeredRunnerIdsForResumeFailed !== null &&
          registeredRunnerIdsForResumeFailed.has(record.job.runnerId)
        ) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] （runner-id 不一致のため無視。` +
              `いまの宛先は ${record.job.runnerId}、この出来事は ${fromRunnerId} から）前のセッション` +
              `（${event.sessionId}）を開き直せなかった: ${event.reason}`,
          });
          return;
        }
        // 「resume を投げた」は「戻れた」ではない: SDK が会話を見つけられなかったので、台帳と受信箱を実際に起きたことへ揃え直す。
        await this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] 前のセッション（${event.sessionId}）を開き直せなかった: ` +
            event.reason,
        });
        if (event.recovered) {
          // 終端を `running` で書き戻さない: 待つ間に `closed(failed / lost)` が書いていると台帳が非終端へ戻る。
          if (record.job.status !== 'failed' && record.job.status !== 'lost') {
            record.job.status = 'running';
          }
          record.attached = true;
          this.#noteRunnerSessionSince(record);
          await this.#persist(record);
          this.#notifyResumeFallback(record, event.sessionId, event.reason);
          return;
        }
        // 待っても同じ答えが返る失敗なので自動の挑み直しを打ち切る: 続けても同じ障害通知が積み上がるだけ。明示的な `manager_send` は塞がない。
        this.#unresumable.add(event.managerId);
        // 諦めをプロセス内の記憶だけに置かない: `#unresumable` は器と一緒に消え、次のデプロイでまた同じ死体を起こしに行って失敗する。台帳を終端へ落として再起動の向こうまで持たせる。
        record.job.status = 'lost';
        record.attached = false;
        // `closed` と揃えて畳む: `#retire` で像ごと消すので、「消える時点で waiting が空」を呼び出し元の代入に頼らせない。
        record.waiting = [];
        await this.#persist(record);
        this.#notifyUnresumable(record, event.reason, 'session');
        // 枠の印も一緒に下ろす: 台帳に残したままだと、諦めを持たせたはずの `lost` の死体を次のデプロイでまた起こしに行く。
        this.#usageWakeOwed.delete(event.managerId);
        await this.#clearUsageStoppedMark(event.managerId);
        this.#retire(event.managerId);
        return;
      }

      case 'closed': {
        // 止めた後の `closed` で status を巻き戻さない: 無条件に `event.status` へ上書きすると終端が甦り、`failed` の枝がクローンへ `#emit()` する。日誌には残す。`#retire()` は `abort()` が済ませているので呼ばない。
        if (record.job.status === 'stopped') {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （停止済みのため無視）runner 側の終了イベント` +
              `（status=${event.status}）を受け取った: ${event.reason}`,
          });
          return;
        }
        // 移った後に古い runner から届いた closed で巻き戻さない: 無条件に処理すると `status` を書き換え、`releaseLease` でいま使われている新しい runner の貸し出しを解放して他の器が奪える状態になる。判定の理由は `case 'resume_failed'` の同じ判定を見る。
        // 移送の resume が飛んでいる最中の closed は結論が出るまで預かる（`#relocatingTo`）: 捨てると移送が失敗した回に元の runner の lost を取りこぼし、処理すると受理された回に台帳が lost のまま残る。移送先自身の closed も預かる（素通りさせると下の runner-id 不一致で捨てる）。
        if (this.#relocatingTo.has(event.managerId)) {
          this.#deferEvent(event, fromRunnerId);
          return;
        }
        // 同じ runner への復帰の resume の最中の closed も預かるが、いま追っているセッション自身の出来事（世代が一致）は預けない: 窓は「窓の間に届いたものは古い世代」と読む近似で、世代が分かる出来事には使わない。
        // 預けた列が空でない間は、一致する `closed` も列の後ろへ並べる: その場で処理すると、先に預けた `report` より先に `closed(done)` が処理され、`lastReportAt` が古いまま「report 無しの done」と誤って知らせる。
        if (
          this.#sameRunnerResumeWindow.get(event.managerId) === fromRunnerId &&
          (generation !== 'current' || (this.#deferredEvents.get(event.managerId)?.length ?? 0) > 0)
        ) {
          this.#deferEvent(event, fromRunnerId);
          return;
        }
        const registeredRunnerIdsForClosed = this.#registeredRunnerIds();
        if (
          record.job.runnerId !== undefined &&
          record.job.runnerId !== fromRunnerId &&
          registeredRunnerIdsForClosed !== null &&
          registeredRunnerIdsForClosed.has(record.job.runnerId)
        ) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （runner-id 不一致のため無視。` +
              `いまの宛先は ${record.job.runnerId}、この出来事は ${fromRunnerId} から）runner 側の` +
              `終了イベント（status=${event.status}）を受け取った: ${event.reason}`,
          });
          return;
        }
        // `lost` 確定後に届いた `closed` で status を動かさない（`stopped` の後と同じ）: `#load()` が像を作り直し、下の代入が `lost` を `done` へ書き換えてしまう。
        // `done` のときだけクローンへ1回知らせる: `lost` は成果を誰も確かめていない状態で、成果が出ている可能性を人間に見せる必要がある。`failed` / `lost` は新しい材料が無いので日誌だけ。
        // 「1回だけ」は `Job.lateDoneNotifiedAt`（`closed` に冪等キーが無く、台帳なので再起動をまたぐ）で持ち、印を先に永続してから出す: 二重に出るより、落ちたとき日誌から辿れるほうを採る。
        // `selfFenced` の枝より前に置く（`lost` の委譲は引き取り直しの梯子に載せない）。
        if (record.job.status === 'lost') {
          const notifyDone = event.status === 'done' && record.job.lateDoneNotifiedAt === undefined;
          const notice = notifyDone
            ? [
                `この委譲 ${event.managerId} は \`lost\` と確定していたが、後から runner が \`closed\`（status=done）を届けた。`,
                '台帳の状態は `lost` のまま変えていない。',
                '**成果が出ている可能性がある** — `lost` は成果を誰も確かめていない状態なので、' +
                  '成果が実際に出ているか（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
                  '確かめるまで「終わった」とも「終わっていない」とも言わない。',
                `closed の reason: ${event.reason}`,
              ].join('\n')
            : undefined;
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （lost 確定済みのため status は動かさない）` +
              `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}` +
              (notice !== undefined
                ? `。done なのでクローンへ知らせる: ${notice}`
                : event.status === 'done'
                  ? '。done は既に知らせてあるので重ねて知らせない'
                  : '。受信箱へは出さない'),
          });
          if (notice !== undefined) {
            record.job.lateDoneNotifiedAt = new Date(this.#now()).toISOString();
            await this.#persist(record);
            this.#emit(event.managerId, 'report', notice);
          }
          this.#retire(event.managerId);
          return;
        }
        // `failed` 確定済みへ同じ `closed(failed)` が再度届いても日誌にだけ残す: SSE の再接続の配り直しで、日誌の失敗行・`closed_failed` の知らせ（合流窓で「×2」）・`noteManagerFailed`（器の失敗が二重に加算され器が余計に沈む）が重なる。`closed` に冪等キーは足さない（runner とのやり取りの形が変わる）ので、デーモンの中だけで直す。
        // resume が飛んでいる最中は重複と読まない: `send()` は resume の後で `running` を書くので台帳はまだ `failed` で、その窓の `closed(failed)` は開き直した新しいセッションがすぐ落ちた知らせでありうる。`done` / `lost` はここで扱わない。
        if (
          record.job.status === 'failed' &&
          event.status === 'failed' &&
          !this.#resuming.has(event.managerId)
        ) {
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （failed 確定済みのため status は動かさず、` +
              `知らせも器の失敗の計上も重ねない）runner 側の終了イベント（status=failed）を受け取った: ` +
              event.reason,
          });
          this.#retire(event.managerId);
          return;
        }
        // 自己失効は「終わった」ではない: `lost` をそのまま書くと `#restoreJobs` も `#reattach` も引き取らず、二重実行を止めた代わりに誰も拾わない仕事ができる。状態は動かさず貸し出しだけ返して梯子へ載せる。
        // 判定は構造化された印だけで行う: `reason` の文字列一致だと、マネージャーが同じ文を書いた回まで巻き込む（`sdk-failure.ts` と同じ理由）。
        if (event.selfFenced === true) {
          record.waiting = [];
          record.attached = false;
          // 返すのは印を立てることで消すことではない: 世代（`fence`）を残す。
          if (record.job.lease !== undefined) {
            record.job.lease = releaseLease(record.job.lease, this.#now());
          }
          await this.#persist(record);
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text:
              `${EXCHANGE_KIND_RECOVERY_PREFIX}[${event.managerId}] 器が貸し出し期限で自分で畳んだ（自己失効）。` +
              `台帳の状態（${record.job.status}）は動かさず、別の器で続きを起こし直す: ${event.reason}`,
          });
          // クローンへも知らせる: 黙って止まったように見えるのが一番まずい。末尾の `event.reason` は包まない: 既に完成した1つの prose 文（runner の定型文）で、この層に包む材料が無い。包むなら `runner.ts` 側。
          this.#emit(
            event.managerId,
            'report',
            `器がデーモンと連絡を失い、貸し出し期限で自分で畳みました（自己失効）。` +
              `この委譲は終わっていません — 引き取りを自動で挑み直します: ${event.reason}`,
          );
          // 像から外さない（終わっていない）。
          if (record.job.runnerId !== undefined) this.#scheduleReattach(record.job.runnerId);
          return;
        }

        record.job.status = event.status;
        record.waiting = [];
        record.attached = false;
        // 貸し出しは期限を待たず返す（`closed` は持ち主自身が「もう走っていない」と言っている）: 返さないと引き取りが猶予のぶん遅れる。消さずに印を立てる: 消すと世代（`fence`）まで消え、遅れて届いた返却で runner の世代より小さい世代を渡し命令が拒まれ続ける。
        if (record.job.lease !== undefined) {
          record.job.lease = releaseLease(record.job.lease, this.#now());
        }
        // 台帳へも残す: 受信箱は流れるので、本文だけでは振り返る面（`manager_list` / `manager_report`）から復元できない。無い回に既定値を作らない。
        // 先に前の回の値を下ろす: 欄が無い回に下ろさないと、続けて `failed` で閉じたとき1回目の値が今回の落ち方として残る。`status` では絞らない。
        delete record.job.lastSystemError;
        if (event.status === 'failed' && event.systemError !== undefined) {
          record.job.lastSystemError = { ...event.systemError, at: new Date().toISOString() };
        }
        // `lastSystemError` と同じ理由・同じ条件（`failed` の回だけ）で、先に前の回の値を下ろす。
        delete record.job.lastCgroupEvents;
        if (event.status === 'failed' && event.cgroupEvents !== undefined) {
          record.job.lastCgroupEvents = { ...event.cgroupEvents, at: new Date().toISOString() };
        }
        // `unpushedWork` は `status` で絞らない: 「どの枝を見ればよいか」は失敗特有の事実ではない。同じ上書きガードを通す: `report` / `tool_use` の fire-and-forget が非同期に競走し、`closed` の処理より後に解決しうる。
        // `#recordUnpushedWorkObservation` を直接呼ばない: 自分で `#persist` するので、直後の `#persist` と二重に書き込む。
        if (event.unpushedWork !== undefined) {
          const at = new Date(this.#now()).toISOString();
          const observation = unpushedWorkObservationOf(event.unpushedWork, at, 'closed');
          if (
            isUnpushedWorkObservationAtLeastAsNewAs(
              observation,
              record.job.lastUnpushedWorkObservation,
            )
          ) {
            record.job.lastUnpushedWorkObservation = observation;
          }
        }
        await this.#persist(record);
        // `failed` だけでなく `lost` も見る: SIGABRT の `failed` の後の resume が `spawn … EAGAIN` で `lost` になる形で、後者は `failed` 専用の `noteManagerFailed` に届かない。判定は構造化された値だけ。`runnerId` が無い分は無実の器を沈めないために数えない。
        if (
          (event.status === 'failed' || event.status === 'lost') &&
          record.job.runnerId !== undefined
        ) {
          if (event.systemError?.code === 'EAGAIN') {
            this.#runners.notePidsSaturationSign?.(record.job.runnerId, 'eagain');
          }
          if ((event.cgroupEvents?.pidsMaxDelta ?? 0) > 0) {
            this.#runners.notePidsSaturationSign?.(record.job.runnerId, 'fork-denied');
          }
        }
        // `event.reason` を包まない: runner の接頭辞と例外文言が既に1本の文字列に連結されており、この層に `codeSpan()` で包む境目が無い。包むなら `runner.ts` の `#read()`。`event.reason` は1文字も変えず、`systemError` / `cgroupEvents` は末尾に足すだけ。
        if (event.status === 'failed') {
          // 本文を日誌へ先に書く: 合流窓の flush の日誌は内訳の1行だけで個々の本文を含まないので、flush 前にプロセスが落ちると本文がどこにも残らない。
          const body = withCgroupEventsNote(
            withSystemErrorNote(event.reason, event.systemError),
            event.cgroupEvents,
          );
          await this.#journal({
            type: 'exchange',
            with: 'manager',
            role: 'inbound',
            text: `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] ${body}`,
          });
          this.#queueSynthesizedNotice(event.managerId, 'closed_failed', body);
          // 落ちたことを名簿へも知らせる: 無いと `/health` の `managers` が減り配置の点数の分母が縮んで落とした器がまた選ばれる。
          // `failed` だけを数える: `lost` は器の不調と別の軸（枠 429 が理由の回が並んでいた）で、入れ替わった直後の resume 失敗を数えると戻ってきたばかりの器を二重に沈める。
          // `systemError` で絞らない: シグナルで畳まれた回には `code` が付かず、`SIGABRT` を取りこぼす。`runnerId` が無い分は数えない: 無実の器を沈める。
          if (record.job.runnerId !== undefined) {
            this.#runners.noteManagerFailed(record.job.runnerId);
          }
        }
        // report が無いまま `closed(done)` だけが届いたらクローンへ知らせる: 台帳は `done` になるが受信箱には何も出ず、成果が出ているかを誰も確かめないまま終わる。報告の後の idle としての `closed(done)` は無音。判定できないときは知らせる側へ倒す（`reportSeenInSession`）。
        // 背景処理の積み（`#withheldReports`）が在るときは重ねない: 直下の分岐が「この委譲は終わった」を配るので二重になる。本文を先に日誌へ書く（flush の前に落ちても辿れるように）。
        if (event.status === 'done' && !this.#withheldReports.has(event.managerId)) {
          const seen = reportSeenInSession(
            record.job.lastReportAt,
            record.job.runnerSessionSince,
            record.job.turnStartedAt,
          );
          // 同じセッションについては1回だけ: 印はターンの始まりを含めた境の時刻で、新しいセッションやターンでは値が変わり知らせ直せる（`Job.silentDoneNotifiedFor`）。
          const sessionKey =
            laterIso(record.job.runnerSessionSince, record.job.turnStartedAt) ?? '';
          const alreadyNotified = record.job.silentDoneNotifiedFor === sessionKey;
          if (seen !== 'seen' && alreadyNotified) {
            await this.#journal({
              type: 'exchange',
              with: 'manager',
              role: 'inbound',
              text:
                `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] report 無しの closed(done)。` +
                `同じセッション（${sessionKey === '' ? '開始時刻は不明' : sessionKey}）については知らせ済みなので重ねて知らせない: ` +
                event.reason,
            });
          } else if (seen !== 'seen') {
            const body = [
              `この委譲 ${event.managerId} は、report を出さないまま終わった（closed の status=done。台帳の状態は done）。`,
              '**成果が出ているとは限らない** — 成果が実際に出ているか' +
                '（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
                '確かめるまで「終わった」とも「終わっていない」とも言わない。',
              ...(seen === 'unknown'
                ? [
                    'このセッションで report を受け取ったかは判定できなかった（この欄を書く前の古い行などで' +
                      '比較する時刻が無い）ため、念のため知らせている。',
                  ]
                : []),
              `closed の reason: ${event.reason}`,
            ].join('\n');
            await this.#journal({
              type: 'exchange',
              with: 'manager',
              role: 'inbound',
              text:
                `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] report 無しの closed(done)` +
                `（${seen === 'none' ? 'report は一度も受け取っていない' : '判定できないので知らせる側へ倒した'}）。` +
                `クローンへ知らせる: ${body}`,
            });
            // 印を先に台帳へ書く（`lateDoneNotifiedAt` と同じ）。
            record.job.silentDoneNotifiedFor = sessionKey;
            await this.#persist(record);
            this.#queueSynthesizedNotice(event.managerId, 'closed_done_silent', body);
          }
        }
        // 積みが在れば `#retire()` の前に配る: 握り潰した報告は「後で必ず配る」約束で、この委譲はもう走らないので次の本物の報告が上書きする経路は来ない。`#emit()` が積みを見つけて末尾へ足すので、ここは「畳まれた」事実だけを書く。
        if (this.#withheldReports.has(event.managerId)) {
          this.#emit(
            event.managerId,
            'report',
            `[${event.managerId}] この委譲は終わった（status=${event.status}）。` +
              '背景処理の完了待ちで畳んでいた報告をまとめて配る。',
          );
        }
        this.#retire(event.managerId);
        // 枠でセッションごと落ちた回は `report` が出ず、ここしか通らない。`#retire` の後で呼ぶ: 起こし直しは `send()` に相乗りし、像が無ければ台帳から読み直すので resume できる。逆順だと `#retire` が `send()` の載せ直した像を消す。
        await this.#settleUsageWake(event.managerId, this.#usageStopped.has(event.managerId));
        return;
      }

      case 'shutdown_unpushed_work': {
        // best-effort: 届かなかった回はこの `case` が呼ばれないので「0件」を作らない（既存の観測は残り、`unavailable` と「届いていない」を混同しない）。`source: 'shutdown'` を明示する。
        // `record.job.status` には触れない: `stop()` が `closed` を出さない設計を変えず、`case 'closed'` の他の判断は持ち込まない。
        await this.#recordUnpushedWorkObservation(record, event.unpushedWork, 'shutdown');
        return;
      }

      case 'rescue_ref': {
        // `pushed` は新しい回が持たなければ前のものを残す: 後の回が「送らなかった」でも remote の ref はまだ在る。`status` / `lease` には触れない。`secret-like` はファイル名だけ日誌へ残し、文字列そのものは持たない。
        const at = new Date(this.#now()).toISOString();
        const previousRescue = record.job.lastRescue;
        record.job.lastRescue = mergeRescue(previousRescue, event.worktrees, at);
        for (const tree of event.worktrees) {
          if (tree.notPushed?.reason !== 'secret-like') continue;
          // 運び直しで同じ日誌を積まない。
          const before = previousRescue?.worktrees.find(
            (w) => w.relativePath === tree.relativePath,
          )?.notPushed;
          if (
            before?.reason === 'secret-like' &&
            JSON.stringify(before.files ?? []) === JSON.stringify(tree.notPushed.files ?? [])
          ) {
            continue;
          }
          await this.#journal({
            type: 'decision',
            decision:
              `作業ツリー ${tree.relativePath} の退避 ref は、鍵らしい文字列を差分に ` +
              '見つけたので送らなかった。',
            grounds:
              `当たったファイル: ${(tree.notPushed.files ?? []).join(', ') || '(不明)'}。` +
              '文字列そのものは記録しない。取り除くか伏せれば次の周期で送られる。',
          });
        }
        await this.#persist(record);
        return;
      }

      case 'tool_running':
      case 'tool_end': {
        // `#journal` を呼ばない: 稼働の地図のメモリへ渡すだけ。コールバックの失敗でイベント処理を止めない。
        try {
          this.#onWorkerToolEvent?.(event);
        } catch {
          // 観測のための口。握りつぶす。
        }
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

  // 上限で黙って忘れない: 忘れた id の `ask` の再送は新しい確認として再度回るので、日誌に跡が無いと理由を辿れない。
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
            `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 配り終えた確認の記憶が上限（${ASKED_MEMORY_LIMIT}件）に達したので、` +
            `古い ${ids.length} 件を忘れた: ${excerptLine(ids.join(', '), ASKED_FORGOTTEN_EXCERPT)}。` +
            'この id の確認が再送されると、新しい確認としてもう一度回る。',
        });
      },
    });
    record.asked = asked;
    return asked;
  }

  // 上限で黙って忘れない: 忘れた id の `report` の再送は新しい報告として再度回るので、日誌に跡が無いと理由を辿れない。
  // 忘れた id の列挙は `renderListing` で切る: 最大 `REPORTED_MEMORY_LIMIT` 件を一度に渡されるため、素通しだと件数に比例して伸びる。
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
            `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 処理済みの報告の記憶が上限（${REPORTED_MEMORY_LIMIT}件）に達したので、` +
            `古い ${ids.length} 件を忘れた: ${listing}。` +
            'この id の報告が再送されると、新しい報告としてもう一度回る。',
        });
      },
    });
    record.reported = reported;
    return reported;
  }

  // 上限で黙って忘れない: 忘れた道具の件数は 0 から数え直しになり、「何十回も止められている」形が受信箱に出るまでが伸びる。
  // `onForget` へ渡るのは生の鍵: journal の文面へ区切り文字を漏らさないよう `decodeDenialKey` で道具名へ戻す。
  #deniedOf(record: ManagerRecord): RecentMap<number> {
    const existing = record.denied;
    if (existing !== undefined) return existing;
    const managerId = record.job.id;
    const denied = createRecentMap<number>({
      limit: DENIED_TOOL_LIMIT,
      onForget: (keys) => {
        for (const key of keys) {
          record.deniedLastAt?.delete(key);
          record.deniedLastReason?.delete(key);
          // `deniedLastAt` と同じ鍵なので同時に消す。
          record.deniedRenotify?.delete(key);
          record.deniedLastRequestId?.delete(key);
          // `lastDenialRenotify` は単一値なので、忘れた鍵を指しているときだけ消す。
          if (record.lastDenialRenotify?.key === key) record.lastDenialRenotify = undefined;
        }
        const labels = keys.map((key) => {
          const { tool, actor } = decodeDenialKey(key);
          return actor === undefined ? tool : `${tool}（${actor}）`;
        });
        void this.#journal({
          type: 'exchange',
          with: 'manager',
          role: 'inbound',
          text:
            `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 拒否の件数を覚えている道具×層の組が上限（${DENIED_TOOL_LIMIT}種）に` +
            `達したので、古い ${keys.length} 件を忘れた: ${labels.join(', ')}。` +
            'この組が次に止められたら 1 件目から数え直す（日誌には全件残っている）。',
        });
      },
    });
    record.denied = denied;
    return denied;
  }

  // 失敗しても委譲は止めない（`#pushProfile` と同じ）。ただし黙って古いトークンで走らせない: 跡を残す。
  async #pushAgentToken(runner: RunnerClient): Promise<void> {
    if (this.#stopped || this.#syncRunnerToken === undefined) return;
    try {
      await this.#syncRunnerToken(runner);
      this.#notePushOutcome(runner.runnerId, 'agentToken', { status: 'ok', at: this.#nowIso() });
    } catch (error) {
      this.#notePushOutcome(runner.runnerId, 'agentToken', {
        status: 'failed',
        at: this.#nowIso(),
        error: reasonOf(error),
      });
      // `this.#stores.journal.append(...).catch(() => undefined)` で直に揉み消さない: append 自体が落ちると跡が残らない（`#journal` は `self_dropped` へ残す）。
      // 投げ直さない: マネージャーの委譲経路には、投げ直した例外を受け取って判断し直す相手がいない。
      await this.#journalPushFailure(
        runner.runnerId,
        'agentToken',
        `${runner.runnerId} に認証トークンを降ろせなかった（この runner で起こすマネージャーは、器の環境変数に認証トークンが入っていればそれで走り、入っていなければ資格を1つも持たずに走る——どちらになるかは器の env 次第で、ここからは分からない）: ${reasonOf(error)}`,
      );
    }
  }

  // 同じ本文が続くあいだは2件目以降を畳む: 直らない障害では挑み直しのたびに同じ行が毎分積まれるため。
  // 畳むのは日誌の1行だけ。帳面（`#pushHealth`）・挑み直し・クローンへの通知は畳まない。
  async #journalPushFailure(
    runnerId: string,
    kind: keyof RunnerPushHealth,
    body: string,
  ): Promise<void> {
    // 接頭辞は書く箇所の字面に置く（`exchange-kind-coverage.test.ts` の静的検査が読む）。
    const text = `${EXCHANGE_KIND_FAILURE_PREFIX}${body}`;
    const key = `${runnerId}\u0000${kind}`;
    let fold = this.#pushFailureFolds.get(key);
    if (fold === undefined) {
      fold = new JournalFoldWindow({
        idleGapMs: PUSH_FAILURE_FOLD_IDLE_GAP_MS,
        maxSpanMs: PUSH_FAILURE_FOLD_MAX_SPAN_MS,
      });
      this.#pushFailureFolds.set(key, fold);
    }
    const folded = fold.observe(text, text, this.#now());
    if (folded.flush !== undefined) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(folded.flush)}`,
      });
    }
    if (folded.write) {
      await this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}${body}`,
      });
    }
  }

  #flushPushFailureFold(runnerId: string, kind: keyof RunnerPushHealth): void {
    const key = `${runnerId}\u0000${kind}`;
    const fold = this.#pushFailureFolds.get(key);
    if (fold === undefined) return;
    this.#pushFailureFolds.delete(key);
    const flushed = fold.flush();
    if (flushed === undefined) return;
    void this.#journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(flushed)}`,
    });
  }

  #flushPushFailureFolds(): void {
    for (const fold of this.#pushFailureFolds.values()) {
      const flushed = fold.flush();
      if (flushed === undefined) continue;
      void this.#journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(flushed)}`,
      });
    }
    this.#pushFailureFolds.clear();
  }

  #nowIso(): string {
    return new Date(this.#now()).toISOString();
  }

  // `runnerId` が無い runner には書かない: 名乗る前の runner は `RunnerOverview` にも `runnerId` 無しの行で出るので紐づけようがない。
  #notePushOutcome(
    runnerId: string | undefined,
    kind: keyof RunnerPushHealth,
    outcome: RunnerPushOutcome,
  ): void {
    if (runnerId === undefined) return;
    if (outcome.status === 'ok') this.#flushPushFailureFold(runnerId, kind);
    const health = this.#pushHealth.get(runnerId) ?? {};
    health[kind] = outcome;
    this.#pushHealth.set(runnerId, health);
  }

  // 日誌の行はここでは書かない: 即時の配布の失敗を日誌へ残すのは呼び出し元（`app.ts` / `tools.ts`）で、ここでも書くと二重になる。
  #recordDirectPushResults(
    kind: 'profile' | 'mcpServers' | 'credentials' | 'plugins',
    results: readonly { runnerId: string; ok: boolean; error?: string; unsupported?: true }[],
  ): void {
    if (this.#stopped) return;
    const at = this.#nowIso();
    for (const result of results) {
      if (kind === 'mcpServers') {
        if (result.unsupported === true) this.#mcpServersUnsupported.add(result.runnerId);
        else this.#mcpServersUnsupported.delete(result.runnerId);
      }
      if (kind === 'plugins') {
        if (result.unsupported === true) this.#pluginsUnsupported.add(result.runnerId);
        else this.#pluginsUnsupported.delete(result.runnerId);
      }
      this.#notePushOutcome(
        result.runnerId,
        kind,
        result.ok
          ? { status: 'ok', at }
          : { status: 'failed', at, error: result.error ?? '理由不明' },
      );
      this.#settlePushRetry(result.runnerId);
    }
  }

  #settlePushRetry(runnerId: string): void {
    const health = this.#pushHealth.get(runnerId);
    // 口を持たない古い runner への MCP の登録は数えない: 挑み直しても同じ 404 が返るだけで、同じ失敗が日誌へ積まれ続ける。
    const stillFailing =
      health !== undefined &&
      Object.entries(health).some(
        ([kind, outcome]) =>
          outcome?.status === 'failed' &&
          !(kind === 'mcpServers' && this.#mcpServersUnsupported.has(runnerId)) &&
          !(kind === 'plugins' && this.#pluginsUnsupported.has(runnerId)),
      );
    if (!stillFailing) {
      this.#pushRetryDelays.delete(runnerId);
      return;
    }
    this.#schedulePushRetry(runnerId);
  }

  // 間隔は伸ばすが、挑み直しを諦めない（north_star 禁止2）。
  #schedulePushRetry(runnerId: string): void {
    if (this.#stopped) return;
    if (this.#pushRetryTimers.has(runnerId)) return;
    const delay = this.#pushRetryDelays.get(runnerId) ?? PUSH_RETRY_BASE_MS;
    this.#pushRetryDelays.set(runnerId, Math.min(delay * 2, PUSH_RETRY_MAX_MS));
    const timer = setTimeout(() => {
      this.#pushRetryTimers.delete(runnerId);
      if (!this.#stopped) void this.#retryFailedPushes(runnerId);
    }, delay);
    timer.unref?.();
    this.#pushRetryTimers.set(runnerId, timer);
  }

  // 直っている種類は撒き直さない: 種類ごとに独立して落ちる。
  // 繋ぎ直し中の押し込みがあれば待つ: 二重に撒くと日誌が無駄に二重の跡を残す。
  async #retryFailedPushes(runnerId: string): Promise<void> {
    if (this.#stopped) return;
    const health = this.#pushHealth.get(runnerId);
    if (health === undefined) return;

    const runner = await this.#runners.get(runnerId).catch(() => null);
    if (runner === null) {
      return;
    }

    const inFlight = this.#reattachPushes.get(runnerId) ?? this.#connections.get(runner);
    if (inFlight !== undefined) await inFlight.catch(() => undefined);
    if (this.#stopped) return;

    if (health.profile?.status === 'failed') await this.#pushProfile(runner);
    if (health.credentials?.status === 'failed') await this.#pushCredentials(runner);
    if (health.agentToken?.status === 'failed') await this.#pushAgentToken(runner);
    if (health.mcpServers?.status === 'failed' && !this.#mcpServersUnsupported.has(runnerId)) {
      await this.#pushMcpServers(runner);
    }
    if (health.plugins?.status === 'failed' && !this.#pluginsUnsupported.has(runnerId)) {
      await this.#pushPlugins(runner);
    }
    this.#settlePushRetry(runnerId);
  }

  // `ManagerPool#restore()` の living 枝（生きているセッションを引き取るだけの経路）から呼ばない:
  // env を更新していないのに「観測しただけの現役の世代」を抱えている世代として書き、本物の食い違いが「一致」に化ける。
  #rememberTokenIdentity(managerId: string): void {
    const identity = this.#tokenIdentity?.();
    if (identity === undefined) return;
    // 指紋は持ち込まない: 観測に添える身元は tokenId と世代だけで、指紋は `send()` が現役の側から読む。
    this.#tokenIdentities.set(managerId, {
      tokenId: identity.tokenId,
      generation: identity.generation,
    });
    const record = this.#records.get(managerId);
    if (record !== undefined) record.reattachedAcrossRestart = undefined;
  }

  // 投げてもマネージャーの経路を壊さない: 回せなかったことは枠に当たったこととは別の失敗で、後者の報告を前者で置き換えない。
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

  // 名簿が判定不能なら移ったとは言わない（`case 'closed'` / `'resume_failed'` と同じ）。
  #movedAwayFrom(record: ManagerRecord, fromRunnerId: string): boolean {
    const registered = this.#registeredRunnerIds();
    return (
      record.job.runnerId !== undefined &&
      record.job.runnerId !== fromRunnerId &&
      registered !== null &&
      registered.has(record.job.runnerId)
    );
  }

  // 台帳・受信箱・`#emit` には触れない: 引き取り先の委譲の `status` / `lastReport` / `sessionId` を古い側の値で上書きし、答えの届かない確認を配ってしまう。
  async #ignoreIfMovedAway(
    record: ManagerRecord,
    fromRunnerId: string,
    managerId: string,
    kind: string,
  ): Promise<boolean> {
    if (!this.#movedAwayFrom(record, fromRunnerId)) return false;
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}[${managerId}] （runner-id 不一致のため無視。` +
        `いまの宛先は ${record.job.runnerId ?? '不明'}、この出来事は ${fromRunnerId} から）` +
        `移った後に届いた古い runner の ${kind} を無視した`,
    });
    return true;
  }

  // 控えはメモリに持たず台帳の store に置く: デーモンの再起動で消え、毎晩の反映のたびに窓が開く。
  // 台帳の基準（新しい runner の高さ）へ畳まない: 小さい基準に対する大きい累積が全量の数え直しになり二重計上する。
  // 差が取れないときは積まず、累積そのものを日誌に残す: 積めば過大、積まなければ取りこぼしの恐れがあり、どれだけ記録済みか言えない。
  async #recordStaleRunnerUsage(
    event: Extract<RunnerEvent, { type: 'usage' }>,
    fromRunnerId: string,
    record: ManagerRecord,
  ): Promise<void> {
    const note = async (text: string): Promise<void> => {
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] 移った後に ${fromRunnerId} から届いた消費の累積（いまの宛先は ${record.job.runnerId ?? '不明'}）: ${text}`,
      });
    };
    const at = new Date(this.#now());
    let fold;
    try {
      fold = await this.#stores.usage.record({
        layer: 'manager',
        site: 'session',
        managerId: event.managerId,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { sessionId: event.sessionId, models: event.models },
        accumulation: 'cumulative',
        runner: { id: fromRunnerId, superseded: true },
      });
    } catch {
      await this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] 移った後に届いた消費を台帳へ記録できなかった（この分は集計に出ない）`,
      });
      return;
    }
    const total = Object.values(event.models).reduce((sum, m) => sum + m.costUsd, 0);
    if (fold.skipped?.reason === 'unknown-runner') {
      await note(
        `この runner の前回の累積を台帳が覚えていないので、記録済みの分が分からず積まなかった（累積 $${total.toFixed(4)}）。`,
      );
    } else if (fold.skipped?.reason === 'decreased') {
      await note(
        `この runner の累積が前回（$${fold.skipped.fromCostUsd.toFixed(4)}）より減っていたので、積まなかった（累積 $${fold.skipped.toCostUsd.toFixed(4)}）。`,
      );
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
              `${EXCHANGE_KIND_THINNING_PREFIX}配り終えた上限の文言の記憶（${kind}）が上限（${USAGE_NOTICE_MEMORY_LIMIT}通り）に` +
              `達したので、古い ${texts.length} 件を忘れた。この文言が次に届いたら` +
              'もう一度クローンへ配る。',
          });
        },
      }),
      folded: 0,
      foldedManagers: new Set(),
    };
    this.#usageNotices.set(kind, memory);
    return memory;
  }

  // `new Date()` を直接使わず `this.#now()` を使う: `lastAt` は `flushWithheldReports()` が `this.#now()` との差分で期限を判定する材料で、時計が違うと注入したテストで期限判定を検査できない。
  #withholdBackgroundReport(
    managerId: string,
    text: string,
    awaitingBackground: { count: number; breakdown: string },
  ): void {
    const now = new Date(this.#now()).toISOString();
    const existing = this.#withheldReports.get(managerId);
    this.#withheldReports.set(managerId, {
      count: (existing?.count ?? 0) + 1,
      firstAt: existing?.firstAt ?? now,
      lastAt: now,
      lastText: text,
      breakdown: awaitingBackground.breakdown,
      // 在り高は足さず上書きする: `awaitingBackground.count` は runner がその回に見た在り高で増分ではなく、足すと二重に数える。
      taskCount: awaitingBackground.count,
      // `flushedAt` は持ち越す: オブジェクトを作り直すので、落とすと `flushWithheldReports()` の「エピソードにつき1本だけ」が壊れる。
      ...(existing?.flushedAt === undefined ? {} : { flushedAt: existing.flushedAt }),
    });
  }

  // `WithheldReportMemory` をそのまま外へ出さない: `lastText` は報告の本文そのもので、一覧に全文を載せない（`listing-and-detail`）。
  // 読むだけで在庫は動かさない: 一覧を開いて握り潰しが配られると、`manager_list` のたびに受信箱が動く。
  #awaitingBackgroundOf(managerId: string): ManagerAwaitingBackground | undefined {
    const withheld = this.#withheldReports.get(managerId);
    if (withheld === undefined) return undefined;
    return {
      tasks: withheld.taskCount,
      withheldReports: withheld.count,
      breakdown: withheld.breakdown,
      since: withheld.firstAt,
    };
  }

  // 宛先（`requestId`）も意思（`decision`）も無い一言は、待ちが1件でも回答として消費しない（`send` の「宛先を推測しない」）:
  // 普通の会話文が `inferDecision` に落ちて `allow` に化け、「少し待って」が `deny` として返る。
  // 知らせ直しより前から待っていた1件へも黙って当てない（`'renotify-pending'`）: 無関係な確認へ許可・拒否を当てる側に倒さない。
  #choosePending(
    record: ManagerRecord,
    requestId: string | undefined,
    decision: ManagerDecision | undefined,
  ): { requestId: string; summary: string } | null | 'ambiguous' | 'gone' | 'renotify-pending' {
    if (requestId !== undefined) {
      return record.waiting.find((item) => item.requestId === requestId) ?? 'gone';
    }
    if (decision === undefined) return null;
    if (record.waiting.length === 0) return null;
    if (record.waiting.length === 1) {
      const only = record.waiting[0] ?? null;
      if (only !== null && this.#predatesLastDenialRenotify(record, only))
        return 'renotify-pending';
      return only;
    }
    return 'ambiguous';
  }

  // `item.askedAt` が取れない回は前後を比べられないので当てない側（true）に倒す: 許可・拒否の推測では、当てて誤るより `requestId` を聞き直す方が安い。
  #predatesLastDenialRenotify(record: ManagerRecord, item: RunnerWaiting): boolean {
    const last = record.lastDenialRenotify;
    if (last === undefined) return false;
    if (item.askedAt === undefined) return true;
    return item.askedAt < last.at;
  }

  // 見つからなかった枝でだけ呼ぶ: 見つかった回に一覧を余分に読まない。読むだけで、何も書かず、止めず、送らない。
  async #unreadableRowDetail(managerId: string): Promise<string | undefined> {
    const row = (await this.#stores.jobs.listUnreadableJobs()).find(
      (entry) => entry.id === managerId,
    );
    return row === undefined ? undefined : describeUnreadableManagerRow(managerId, row.reason);
  }

  async #latestJobOf(managerId: string): Promise<Job | null> {
    try {
      return (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId) ?? null;
    } catch {
      return null;
    }
  }

  // 既に `#records` に像が在れば作らず返す: 無条件に作ると、同時に来た2つの契機が別々の `Job` のコピーを握り、後から `#persist()` した側が先の変更を上書きする。
  // `listJobs()` の `await` から戻って次の `await` までは同期区間なので、この再確認だけでロック無しに同じ像を握れる。
  async #load(managerId: string): Promise<ManagerRecord | null> {
    const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    if (!job) return null;
    const existing = this.#records.get(managerId);
    if (existing !== undefined) return existing;
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
    const head =
      cause === 'runner'
        ? 'runner の器が作り直された'
        : cause === 'relocated'
          ? '走らせていた runner が黙ったので、別の器で開き直した'
          : 'デーモンが再起動した';
    // 日誌は呼び出し元に委ねない: `attached` の呼び出し元は書かず、`resumed` 側が書くのは別の事実（再開の指示）で、この知らせ自体の跡ではない。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: `${EXCHANGE_KIND_RECOVERY_PREFIX}${
        how === 'attached'
          ? `[${job.id}] （走行中を確認）${head}。runner の中で走り続けている。`
          : `[${job.id}] （再開を知らせた）${head}。前のセッションから再開させた。`
      }`,
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
        // 判定は `workspaceAfterSwap` に委ねる（`restartNudge` と同じ判定を二重に書かない）。
        // path は出さない: 直前の行で作業ディレクトリを出しており、重ねると読む側が2つの値を突き合わせることになる。
        cause !== 'daemon'
          ? cloneWorkspaceAfterSwapLine(
              workspaceAfterSwap(job.workspace, job.lastUnpushedWorkObservation, job.lastRescue),
            )
          : '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
      ...this.#statusAtDelivery(job.id),
    });
  }

  // `#records` に無ければ `{}` を返し、既定値を作らない: キー自体が付かないので「取れなかった」と「そういう状態だった」が同じ顔にならない。
  #statusAtDelivery(managerId: string): { statusAtDelivery: JobStatus } | Record<string, never> {
    const status = this.#records.get(managerId)?.job.status;
    return status === undefined ? {} : { statusAtDelivery: status };
  }

  // 順序は並べ替えない（`docs/architecture.md`）: 畳めない出来事が来たら、先に合成した知らせの積みを全部配り切ってから本題を配る。
  // `#flushSynthesizedNoticeFor` はここを経由せず直接 `#deliver` を呼ぶ: 経由すると、窓が閉じて配る1回が新しい出来事として全 managerId の積みを二重に flush する。
  #emit(
    managerId: string,
    kind: 'report' | 'question' | 'permission',
    text: string,
    requestId?: string,
    markup?: TextMarkup,
    withheldSuffixDetail: 'full' | 'flush' = 'full',
    foldedTurn = false,
    reportFiles?: ManagerReportFiles,
  ): void {
    this.#flushSynthesizedNotices();
    this.#deliver(
      managerId,
      kind,
      text,
      requestId,
      markup,
      withheldSuffixDetail,
      false,
      foldedTurn,
      reportFiles,
    );
  }

  #deliver(
    managerId: string,
    kind: 'report' | 'question' | 'permission',
    text: string,
    requestId?: string,
    markup?: TextMarkup,
    withheldSuffixDetail: 'full' | 'flush' = 'full',
    synthesized = false,
    foldedTurn = false,
    reportFiles?: ManagerReportFiles,
  ): void {
    // 握り潰した報告の件数を日誌だけに残さず、配る `text` の末尾にも足す: 日誌だと引きに行かないと、報告まで消していないかに気づけない。
    const withheld = this.#withheldReports.get(managerId);
    let outgoing = text;
    if (withheld !== undefined) {
      // `'flush'` は在庫を `delete` しない: `firstAt` が失われ、次に積んだ回が新しいエピソードとして数え直され、`flushWithheldReports()` が何度でも合図を立て直せてしまう。
      if (withheldSuffixDetail === 'flush') {
        this.#withheldReports.set(managerId, {
          ...withheld,
          count: 0,
          flushedAt: new Date(this.#now()).toISOString(),
        });
      } else {
        this.#withheldReports.delete(managerId);
      }
      // `count === 0` のときは足さない: フラッシュ直後は在庫が `count: 0` で残っており、足すと「0 本配っていない」という嘘の1行が出る。
      if (withheld.count > 0) {
        // `'flush'` は抜粋を付けない: 配られる中身は既に日誌に在るので再送する意味が無い。
        const countNote =
          `${text}\n\n（この間に、背景処理の完了待ちで畳んだターンの報告を ` +
          `${String(withheld.count)} 本配っていない（最初 ${withheld.firstAt} / ` +
          `最後 ${withheld.lastAt}）。全文は日誌に在る（\`journal_read\`）。`;
        outgoing =
          withheldSuffixDetail === 'flush'
            ? `${countNote}）`
            : `${countNote}最後の1本の冒頭: ${excerptLine(withheld.lastText, WITHHELD_REPORT_EXCERPT)}）`;
      }
    }
    // 何を配ったかに関わらず帳面を消す: 次に同じ本文の知らせが来たら、また1件目として配る（`#flushSynthesizedNoticeFor` だけは直後に新しい署名で `set` し直す）。
    const streak = this.#synthesizedNoticeStreaks.get(managerId);
    this.#synthesizedNoticeStreaks.delete(managerId);
    if (streak !== undefined && streak.suppressed > 0) {
      outgoing =
        `${outgoing}\n\n（この間に、直前と同じ本文の「機構が合成した知らせ」を ` +
        `${String(streak.suppressed)} 束（通数 ${String(streak.suppressedArrived)} 件）配っていない` +
        `（最初 ${streak.firstAt ?? '不明'} / 最後 ${streak.lastAt ?? '不明'}）。` +
        `**1件目は配ってあり、配らなかったのは2件目以降の完全な重複だけである。**` +
        `全文は日誌に在る（\`journal_read\`）。）`;
    }
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: new Date().toISOString(),
      managerId,
      kind,
      text: outgoing,
      ...(requestId === undefined ? {} : { requestId }),
      // 取れない軸に値を作らない: `markup` が `undefined` のときはキーごと書かない。
      ...(markup === undefined ? {} : { markup }),
      ...this.#statusAtDelivery(managerId),
      ...(synthesized ? { synthesized: true as const } : {}),
      ...(foldedTurn ? { foldedTurn: true as const } : {}),
      ...(reportFiles === undefined || reportFiles.attachments.length === 0
        ? {}
        : { attachments: reportFiles.attachments }),
      ...(reportFiles === undefined || reportFiles.rejected.length === 0
        ? {}
        : { rejectedAttachments: reportFiles.rejected }),
    });
  }

  // 畳む判定は「機構が合成した印」と「窓の中」の積: 印だけで畳むと、数十秒離れて届いた別の束まで巻き込む。
  // 同じ束か別の出来事か外から決められないときは畳まない: 畳めなければクローンのターンが焼けるだけで情報は消えず、畳み間違いのほうが重い。
  // 窓のタイマーは延長しない: 届き続ける限り閉じなくなり、後から必ず配られる保証が崩れる（north_star 禁止2）。
  // 族も本文も同一の2度目は数を増やすだけ、本文が違えば別の出来事として積みを flush する: 内容の違う2件を1件に潰すとクローンから「2件目が来なかった」と区別が付かない。
  #queueSynthesizedNotice(managerId: string, label: SynthesizedNoticeLabel, text: string): void {
    const arrivedAt = this.#now();
    const existing = this.#synthesizedNotices.get(managerId);
    if (existing !== undefined) {
      // 本文の比較は正規化も切り詰めもしない: 1バイトでも違えば別のことを言っている側へ倒す。
      const duplicate = existing.fragments.find(
        (fragment) => fragment.label === label && fragment.text === text,
      );
      if (duplicate !== undefined) {
        duplicate.count += 1;
        existing.arrivedAt.push(arrivedAt);
        return;
      }
      if (existing.fragments.some((fragment) => fragment.label === label)) {
        this.#flushSynthesizedNoticeFor(managerId);
      } else {
        existing.fragments.push({ label, text, count: 1 });
        existing.arrivedAt.push(arrivedAt);
        return;
      }
    }
    const timer = setTimeout(() => {
      this.#flushSynthesizedNoticeFor(managerId);
    }, this.#synthesizedNoticeWindowMs);
    timer.unref?.();
    this.#synthesizedNotices.set(managerId, {
      fragments: [{ label, text, count: 1 }],
      timer,
      arrivedAt: [arrivedAt],
    });
  }

  // `#emit()` を経由せず直接 `#deliver` を呼ぶ: 経由すると窓を1本閉じるたびに他の managerId の窓まで早期に閉じる。
  // 同期のまま保つ（日誌は待たない）: `#emit()` の「全部 flush してから配る」が非同期だと、本題の `#deliver` が先に走って順序が崩れる。
  #flushSynthesizedNoticeFor(managerId: string): void {
    const entry = this.#synthesizedNotices.get(managerId);
    if (entry === undefined) return;
    this.#synthesizedNotices.delete(managerId);
    clearTimeout(entry.timer);
    const { text, breakdown, arrived } = mergeSynthesizedNoticeFragments(entry.fragments);

    // 合流しなかった窓（`undefined`）は行を書かない: 取れない軸に 0 の行を作らない。
    const arrivalIntervals = synthesizedNoticeArrivalIntervals(entry.arrivedAt);
    if (arrivalIntervals !== undefined) {
      void this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text:
          `${EXCHANGE_KIND_GAUGE_PREFIX}[${managerId}] 合流窓に続けて畳まれた合図は ` +
          `${String(arrivalIntervals.count)} 件、間隔は最大 ${String(arrivalIntervals.maxIntervalMs)}ms・` +
          `最小 ${String(arrivalIntervals.minIntervalMs)}ms だった` +
          `（窓の長さ ${String(this.#synthesizedNoticeWindowMs)}ms）。`,
      });
    }

    // 「同文なら常に捨てる」にしない: 1件目まで消えて黙らせる側になる（連鎖は配ったあとの `set` で初めて立つ）。
    // 対象は `turn_failed` 単独の束だけ: `rate_limit` / `usage_notice` は専用の状態ベースの判定を経ており、文字列一致を重ねると誤って握りつぶす。
    const signature = synthesizedNoticeSignature(entry.fragments);
    const eligible = isCrossWindowStreakEligible(entry.fragments);
    const streak = this.#synthesizedNoticeStreaks.get(managerId);
    if (eligible && streak !== undefined && streak.signature === signature) {
      const at = new Date(this.#now()).toISOString();
      streak.suppressed += 1;
      streak.suppressedArrived += arrived;
      streak.firstAt ??= at;
      streak.lastAt = at;
      void this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text:
          `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 直前に配ったものと同文の知らせ（内訳: ${breakdown}）が ` +
          `${String(arrived)} 件届いたので、受信箱へは回さず数だけ残した` +
          `（この連鎖で ${String(streak.suppressed)} 束目 / 通数 ${String(streak.suppressedArrived)} 件）。`,
      });
      return;
    }
    // 本文の文言ではなく `label` で判定する。
    const foldedTurn = entry.fragments.some((fragment) => fragment.label === 'turn_failed');
    // `#deliver` より先に `set` しない: `#deliver` は直前の連鎖の件数を末尾に運んでから帳面を消すので、先に上書きすると「配らなかった件数」が届かず消える。
    this.#deliver(managerId, 'report', text, undefined, undefined, 'full', true, foldedTurn);
    // 対象外の束では新しい連鎖を立てない: 次に同じ族が来ても握りつぶす先が無く、記憶を持つだけ無駄。
    if (eligible) {
      this.#synthesizedNoticeStreaks.set(managerId, {
        signature,
        suppressed: 0,
        suppressedArrived: 0,
      });
    }
    // 消えてよいのはクローンを起こすことだけで、記録ではない: 個々の知らせは積んだ時点で既に日誌に書かれており、ここで足すのは「まとめた」1行だけ。
    void this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text:
        `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 機構が合成した知らせを ${String(arrived)} 件、` +
        `1件にまとめて配った（内訳: ${breakdown}）。`,
    });
  }

  #flushSynthesizedNotices(): void {
    for (const managerId of [...this.#synthesizedNotices.keys()]) {
      this.#flushSynthesizedNoticeFor(managerId);
    }
  }

  async #persist(record: ManagerRecord): Promise<void> {
    record.job.updatedAt = new Date(this.#now()).toISOString();
    // 生存の時刻は別のタイマーで進めず、書くついでに進める: 委譲ごとにタイマーが増え、進める条件を2箇所で判定することになる。
    // 応えているプロセスが違うなら進めない: 入れ替わった器の貸し出しが生き続け、引き取れる時刻が来ない。
    const lease = record.job.lease;
    // 返した貸し出しは進めない: 返してあるのに期限が動き続け、後から読む側が「まだ握っている」と読む。
    if (lease !== undefined && lease.releasedAt === undefined) {
      const seen = this.#sighting(lease.runnerId);
      if (seen.instanceId !== undefined && seen.instanceId === lease.instanceId) {
        record.job.lease = touchLease(lease, this.#now());
      }
    }
    try {
      await this.#stores.jobs.putJob(record.job);
    } catch (error) {
      // ジョブ台帳が書けなくてもマネージャーは走らせるが、黙って消さない: 失敗は台帳にも日誌にも跡を残さない。
      noteDroppedRecord('ジョブ台帳', `job id=${record.job.id} status=${record.job.status}`, error);
    }
  }

  // 像（`ManagerRecord.runnerSessionSince`）はプロセス内にしか置かない: 生存確認と未 push 観測の判定は「再起動後は欄が無い」前提で倒れ先を決めている。
  #noteRunnerSessionSince(record: ManagerRecord): void {
    const at = new Date(this.#now()).toISOString();
    record.runnerSessionSince = at;
    record.job.runnerSessionSince = at;
    // start / resume は新しいターンの始まりでもある。`send()` が先に書いた値より後ろへだけ進める。
    record.job.turnStartedAt = laterIso(record.job.turnStartedAt, at);
  }

  // 「上限で古いものを捨てる」にしない。上限を持たせると、走行中のマネージャーが増えただけで無関係な1本が押し出される形になりうる（north_star 禁止2）。
  // 契機は終端という状態遷移だけにする。
  #retire(managerId: string): void {
    this.#records.delete(managerId);
    // 握り潰した報告を静かに畳んでよい理由は、全文が日誌の `type: 'exchange'` に残っているから（`decision` 側は冒頭抜粋だけ）。
    // 受信箱へ流して起こすのは `abort()` の「止めた後は回さない」を覆すので流さず、握り潰したまま終わった事実だけを stderr へ残す。
    // 呼び出し元で分岐させずここに置く: どの呼び出し元でも同じ1行が漏れなく残る。
    const withheldBeforeDelete = this.#withheldReports.get(managerId);
    if (withheldBeforeDelete !== undefined && withheldBeforeDelete.count > 0) {
      noteWithheldReportsDiscarded(
        managerId,
        withheldBeforeDelete.count,
        withheldBeforeDelete.firstAt,
        withheldBeforeDelete.lastAt,
      );
    }
    this.#withheldReports.delete(managerId);
    this.#synthesizedNoticeStreaks.delete(managerId);
    // 日誌の畳み込みは外す前に畳み残しを吐く: 畳んだ2件目以降はまだ日誌のどこにも書かれておらず、黙って捨てると件数が失われる。
    const foldedAtRetire = this.#rateLimitJournalFolds.get(managerId)?.flush();
    if (foldedAtRetire !== undefined) {
      void this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(foldedAtRetire)}`,
      });
    }
    this.#rateLimitJournalFolds.delete(managerId);
    this.#autoFoldSkipJournalWritten.delete(managerId);
    // busy の取り直しの数えはここで消す: `#reattach` のループは数えを消さずに `continue` で抜けるので、残すと後の busy で上限（`REATTACH_BUSY_MAX_RETRIES`）を前の分で縮める。
    this.#reattachBusyRetries.delete(managerId);
  }

  // 上限を持たない: 外す契機が `#retire()` に在る。
  #rateLimitJournalFoldFor(managerId: string): JournalFoldWindow {
    const existing = this.#rateLimitJournalFolds.get(managerId);
    if (existing !== undefined) return existing;
    const created = new JournalFoldWindow();
    this.#rateLimitJournalFolds.set(managerId, created);
    return created;
  }

  // `void` で投げる: 止める手を日誌の書き込みで待たせない（書けなければ `#journal` が跡を残す）。
  #flushRateLimitJournalFolds(): void {
    for (const fold of this.#rateLimitJournalFolds.values()) {
      const flushed = fold.flush();
      if (flushed === undefined) continue;
      void this.#journal({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(flushed)}`,
      });
    }
    this.#rateLimitJournalFolds.clear();
  }

  // 片付けて消しただけの回は日誌だけにする: 人の手が要らない。
  async #onScratchSweep(
    event: Extract<RunnerEvent, { type: 'scratch_sweep' }>,
    fromRunnerId: string,
  ): Promise<void> {
    const runnerId = event.runnerId.length > 0 ? event.runnerId : fromRunnerId;
    const label = (i: ScratchSweepItem): string =>
      `${i.name}（${i.kind}${i.managerId === undefined ? '' : `、委譲 ${i.managerId}`}）`;
    const removedLines = event.removed.map((i) => {
      if (i.kind === 'node_modules') {
        return `  - 消した ${i.name} の node_modules ${String(i.count ?? 0)} 件: ${(i.paths ?? []).join(', ')}`;
      }
      const untracked =
        i.untracked === undefined
          ? ''
          : ` 未追跡 ${String(i.untracked.count)} 件を捨てた: ${i.untracked.names.join(', ')}`;
      return `  - 消した ${label(i)}${untracked}`;
    });
    const keptLines = event.kept.map(
      (i) =>
        `  - 残した ${label(i)} 理由 ${i.reason ?? '(不明)'}: ${i.detail ?? ''}` +
        (i.untracked === undefined ? '' : ` 未追跡: ${i.untracked.names.join(', ')}`) +
        (i.files === undefined ? '' : ` ファイル: ${i.files.names.join(', ')}`),
    );
    const statfsLine =
      event.statfs === undefined
        ? '/tmp の余力: (未観測)'
        : 'unavailable' in event.statfs
          ? `/tmp の余力: 取れなかった（${event.statfs.unavailable}）`
          : `/tmp の余力: inode ${String(event.statfs.usedInodes)}/${String(event.statfs.totalInodes)}、` +
            `バイト ${String(event.statfs.usedBytes)}/${String(event.statfs.totalBytes)}`;
    const grounds = [
      ...(event.scanError === undefined ? [] : [`走査の失敗: ${event.scanError}`]),
      ...removedLines,
      ...keptLines,
      statfsLine,
    ].join('\n');
    await this.#journal({
      type: 'decision',
      decision:
        `runner ${runnerId} が /tmp の委譲の作業場を片付けた（消した ${String(event.removed.length)} 件、` +
        `新しく残した ${String(event.kept.length)} 件）。`,
      grounds,
    });
    if (event.kept.length === 0 && event.scanError === undefined) return;
    try {
      this.#post({
        type: 'external',
        id: randomUUID(),
        at: new Date(this.#now()).toISOString(),
        source: DAEMON_RUNNER_REGISTRY_SOURCE,
        payload: {
          text:
            `runner ${runnerId} の /tmp の片付けで、片付けずに残した作業場があります（未 push のコミット・` +
            `未コミットの変更・判定できないもの）。runner の一時領域が埋まる前に、人間か該当の委譲で確かめてください。\n` +
            grounds,
        },
      });
    } catch (error) {
      noteDroppedRecord('受信箱', `scratch_sweep runner=${runnerId}`, error);
    }
  }

  async #journal(entry: JournalEntryInput): Promise<void> {
    try {
      await this.#stores.journal.append(entry);
    } catch (error) {
      // 記録できないこと自体では委譲を止めないが、黙って消さない: 跡が無いと「日誌に無い」が「起きなかった」と読める。
      noteDroppedRecord('日誌', journalEntryShape(entry), error);
    }
  }

  // 読めなかった回は空の一覧に倒さず `null` を返す: `[]` は「読めたが1本も無い」と区別できず、「委譲が無い」という結論で進んでしまう。
  // `null` の扱い（見送る／挑み直す）は呼び出し元が決める: ここでは直せない。
  async #listJobsOrNote(skipped: string): Promise<Job[] | null> {
    try {
      return await this.#stores.jobs.listJobs();
    } catch (error) {
      await this.#journal({
        type: 'decision',
        decision: `台帳の委譲の一覧を読めなかったので、${skipped}`,
        grounds:
          `読めなかった原因: ${reasonOf(error)}。` +
          '一覧が読めなかったことは「委譲が無い」ではない（この回は何も判定していない）。',
      });
      return null;
    }
  }
}

// 上げ続けない: 止められ続けている1本が受信箱を埋めると他の判断材料が押し流される。黙りもしない: 続けば次の桁でもう一度出る。
// 入口（1）と刻み（3倍）は別の判断: 入口を上げると一度きりの拒否が黙り、刻みを詰めると1件ずつ流す形に戻る。
// 入力の中身ではなく道具の名前で束ねる: 1文字違う `Edit` を別物と数えると、同じファイルの編集が何度も拒否される形を取り逃す。
function shouldEscalateDenial(count: number): boolean {
  if (count < DENIED_ESCALATE_AT) return false;
  let step = DENIED_ESCALATE_AT;
  while (step < count) step *= 3;
  return step === count;
}

// `claimableAt` の有無では言い方を変えない: 台帳の書き込み失敗（`persist-failed`）まで「人間が `ALTEROID_RUNNER_ID` を直すまで解けない」側に倒れる。
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

// `#restoreJobs` と `#reattach` で共有する: 別々に書くと片方だけ直る形になる。
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

// 恒久（`no-session`）と一時（`unreadable` / `busy`）を混ぜない: 全部を「起こし直すこと」と言うと、待てば直る失敗でも続きが失われる行動を指示してしまう。
// 言い方の持ち主を1つにする。`send()` は `#resuming` を事前にも見るので、同じ「取り直している最中」を2箇所で書くと、片方だけが直る形になる。
function resumeFailureDetail(
  managerId: string,
  outcome: Exclude<ResumeOutcome, 'resumed'>,
  // `leaseRefusal.kind` で言い方を変える: 読んだクローンはこの1行のとおりに行動するので、`ambiguous` に「待てば解ける」と言うと待ち続ける。
  // 「新しく起こし直さないこと」はどの `kind` でも必ず言う: 消すと二重実行の入口になる。
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
    case 'stopped-meanwhile':
      // 「新しく起こし直すこと」を言わない: 戻れなかったのではなく戻る必要が無くなったので、起こし直すと止めた意思をこの応答が覆す。
      return (
        `${managerId} は resume している最中に止められた（止めた意思を優先し、` +
        '起こしかけた・起こしてしまったセッションは畳んだ）。台帳の status は ' +
        '`stopped` のまま——新しく起こし直さないこと。再開してよいかは、止めた側' +
        '（人間・クローン）の判断に従うこと。'
      );
    default: {
      const exhaustive: never = outcome;
      throw new Error(`未知の resume の結果: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// `resumeFailureDetail` を置き換えず、確かめた別の観測を前に付ける: resume の失敗理由とセッションが無いことは独立で、片方だけ読むと打つ手を間違える。
// `missing` が偽なら1文字も足さない: 確かめていないことを言わない。
// 「失われた」と読ませない: セッションが無い由来は「途中で失われた」と「完遂後に畳まれ終端イベントだけ届かなかった」の2つで、デーモンは台帳から区別できない。
// 言い切ると読んだクローンが完遂済みの仕事を委譲し直し、`gh pr create` のような取り返しのつかない操作が二度走りうる。
function sendFailureDetail(managerId: string, resumeDetail: string, missing: boolean): string {
  if (!missing) return resumeDetail;
  return (
    `宛先の runner は ${managerId} のセッションを持っていない（そう答えた）。${resumeDetail} ` +
    '**この委譲が失われたという意味ではない** — 仕事が完遂した後にセッションが畳まれ、' +
    'その終端イベントだけが届かなかった回も、台帳からはこれと同じ形に見える' +
    '（デーモンにこの2つを区別する材料は無い）。**委譲し直す前に manager_report を見ること** — ' +
    '報告が空でも、生ログまで降りて「生成されたが配られていない」報告を拾う経路がある。'
  );
}

type RestartCause = 'daemon' | 'runner' | 'relocated';

// 判定の持ち主を1つにする: `restartNudge` と `#notifyRestored` が同じ `job.workspace` から引くので、2箇所に書くと片方だけ直る。
type WorkspaceAfterSwap =
  | { kind: 'kept'; path: string }
  | { kind: 'rebuild'; repository: string; ref: string }
  | {
      kind: 'unverified';
      path: string;
      /** 観測した作業ツリーがあるときだけ載る: 情報が無いなら新しい主張をしない。 */
      cloneHints?: readonly WorkspaceCloneHint[];
      observedAt?: string;
      incompleteNote?: string;
    }
  | { kind: 'unrecorded' };

// `runner-volume` を `kept` にしない: 以前に書かれた行が名乗っている値で確かめた結果ではなく、区別する手が無いので、「volume に在るので残っている」と読むと存在しない永続性の主張を復活させる。
// `observation` は `locator.kind === 'unknown'` のときだけ読む: clone の指示を出すのは `unknown` に限る。
function workspaceAfterSwap(
  locator: WorkspaceLocator | undefined,
  observation?: LastUnpushedWorkObservation,
  rescue?: LastRescue,
): WorkspaceAfterSwap {
  if (locator === undefined) return { kind: 'unrecorded' };
  switch (locator.kind) {
    case 'shared-volume':
      return { kind: 'kept', path: locator.path };
    case 'git':
      return { kind: 'rebuild', repository: locator.repository, ref: locator.ref };
    case 'unknown': {
      const found = workspaceCloneHintsFrom(observation, rescue);
      return found === undefined
        ? { kind: 'unverified', path: locator.path }
        : {
            kind: 'unverified',
            path: locator.path,
            cloneHints: found.hints,
            ...(found.at === undefined ? {} : { observedAt: found.at }),
            ...(found.incompleteNote === undefined ? {} : { incompleteNote: found.incompleteNote }),
          };
    }
    case 'runner-volume':
      return { kind: 'unverified', path: locator.path };
    default: {
      const exhaustive: never = locator;
      throw new Error(`未知の workspace locator: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function observationBasisNote(observedAt: string | undefined): string {
  return observedAt === undefined
    ? '未 push の観測が無い（取れなかった）ので、件数や失われたものは分からない。'
    : `${observedAt} 時点の観測に基づく——これより後に作った枝は含まれない。`;
}

function workspaceAfterSwapClause(after: WorkspaceAfterSwap): string {
  switch (after.kind) {
    case 'unrecorded':
      return '作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。';
    case 'unverified':
      if (after.cloneHints === undefined) {
        return (
          `作業ディレクトリ（${after.path}）が残っているとは限らないので、` +
          '続きに入る前に手元の状態を確かめよ。'
        );
      }
      return (
        `作業ディレクトリ（${after.path}）が残っているとは限らない。` +
        observationBasisNote(after.observedAt) +
        (after.incompleteNote === undefined ? '' : `${after.incompleteNote} `) +
        (anyHintHasLossRisk(after.cloneHints)
          ? 'コミット済みで未 push のものも失われている可能性がある。'
          : '') +
        '見つかった作業ツリーごとに次のとおり進めよ:\n' +
        formatWorkspaceCloneHintLines(after.cloneHints, after.observedAt)
      );
    case 'kept':
      return (
        `作業ディレクトリ（${after.path}）は器を跨いで共有されているので、中身は残っている。` +
        'ただし書きかけで落ちた可能性はあるので、続きに入る前に手元の状態を確かめよ。'
      );
    case 'rebuild':
      return (
        `作業ディレクトリは器と一緒に失われている。${after.repository} の ${after.ref} を` +
        'clone し直してから、続きに入れ。コミットしていなかった変更は残っていないので、' +
        '必要なら書き直すこと。'
      );
  }
}

// `restartNudge` とは読み手が違う（クローン向け）ので文言は別に持ち、判定は同じ `workspaceAfterSwap` を通す。
// path は出さない: 呼び出し元が既に作業ディレクトリを出している。
function cloneWorkspaceAfterSwapLine(after: WorkspaceAfterSwap): string {
  switch (after.kind) {
    case 'unrecorded':
      return (
        '器に永続化が無ければ、外へ保存していない作業は失われている。' +
        '同じ結果を期待せず、手元の状態から組み立て直させること。'
      );
    case 'unverified':
      if (after.cloneHints === undefined) {
        return (
          '器に永続化が無ければ、外へ保存していない作業は失われている。' +
          '同じ結果を期待せず、手元の状態から組み立て直させること。'
        );
      }
      return (
        observationBasisNote(after.observedAt) +
        (after.incompleteNote === undefined ? '' : `${after.incompleteNote} `) +
        (anyHintHasLossRisk(after.cloneHints)
          ? 'コミット済みで未 push のものも失われている可能性がある。'
          : '') +
        '外へ保存していない作業は失われている前提で、見つかった作業ツリーごとに' +
        '次のとおり組み立て直させること:\n' +
        formatWorkspaceCloneHintLines(after.cloneHints, after.observedAt, 'short')
      );
    case 'kept':
      return (
        '作業ディレクトリは器を跨いで共有されているので、外へ保存していない作業も残っている。' +
        'ただし書きかけで落ちた可能性はあるので、手元を確かめさせること。'
      );
    case 'rebuild':
      return (
        `作業ディレクトリは器と一緒に失われている。${after.repository} の ${after.ref} から` +
        '作り直させること。コミットしていなかった変更は残っていない。'
      );
  }
}

// `restartNudge` をそのまま呼ばない: 末尾の「続きを進めよ」が、直後に続く人間・クローンの指示と二重の指図になる。
// `status` を見ない（resume 経路すべてに同じものを当て、`done` だけ特別扱いしない）ので、`waiting_human` の枝は持ち込まない。
// 判定は `workspaceAfterSwap` に委ねる: 別の判定を書くと片方だけ直る。
function runnerSwapNudge(
  locator: WorkspaceLocator | undefined,
  observation?: LastUnpushedWorkObservation,
  rescue?: LastRescue,
): string {
  return (
    '[system] この委譲を最後に走らせていた器は、もう居ない（別の器がこの宛先に応えている）。' +
    workspaceAfterSwapClause(workspaceAfterSwap(locator, observation, rescue))
  );
}

// `restartNudge` をそのまま呼ばない: `waiting_human` の枝が「確認は器と一緒に失われている」と言うが、ここでは会話も待ちも失われていず嘘になる。
// 「最初からやり直すな」を明示する: 枠で死んだのはそのターンだけで、書かないと `lastFailure` が立っているぶんやり直しから入り、トークンを二重に使う。
function usageRotationNudge(): string {
  return (
    '[system] 認証トークンが枠で止まっていたが、通る鍵に戻った。' +
    'この会話はそのまま続いている（最初からやり直さないこと）。' +
    '枠で落ちたターンだけをやり直し、中断していた作業の続きを進めよ。'
  );
}

function restartNudge(
  status: JobStatus,
  cause: RestartCause,
  locator: WorkspaceLocator | undefined,
  observation?: LastUnpushedWorkObservation,
  rescue?: LastRescue,
): string {
  // runner が入れ替わったことを「デーモンが再起動した」と伝えない: 手元が残っている前提で続きを書き始めると、消えた作業を書いたつもりで進む。
  const head =
    cause === 'runner'
      ? '[system] runner の器が作り直された。' +
        workspaceAfterSwapClause(workspaceAfterSwap(locator, observation, rescue))
      : cause === 'relocated'
        ? '[system] 走らせていた runner が黙ったので、別の器で続きを開いた。' +
          workspaceAfterSwapClause(workspaceAfterSwap(locator, observation, rescue))
        : '[system] デーモンが再起動した。';
  if (status === 'waiting_human') {
    return (
      `${head}あなたが待っていた確認は器と一緒に失われている。` +
      'まだ必要なら聞き直し、不要なら中断していた作業の続きを進めよ。'
    );
  }
  return `${head}中断していた作業の続きを進めよ。`;
}

// `restartNudge` に混ぜず別に持つ: あちらは resume の前に組み立てるが、runner が実際に使った cwd は resume が返るまで分からない。
// `undefined` は「今回は足さない」で「未確認」ではない: 倒れていない回と古い runner の回を区別しない。
function cwdSwapNoticeClause(record: ManagerRecord): string | undefined {
  const notice = record.cwdSwapNotice;
  if (notice === undefined) return undefined;
  return (
    `[system] 元の cwd（${notice.requested}）はこの器に無かったので、` +
    `${notice.actual} で開いた。`
  );
}

// 宛先が書かれていない委譲は引かない: どの器に居たのかをこの情報だけでは決められない。
function lostSinceOf(
  record: ManagerRecord,
  silentRunners: ReadonlyMap<string, string>,
): string | undefined {
  return record.job.runnerId === undefined ? undefined : silentRunners.get(record.job.runnerId);
}

// `status !== 'running'` なら常に `undefined`: `done` で畳まれた委譲の宛先が後から消えても「running のまま残っている」症状ではない。
// 時刻は返さない（`ManagerSummary.runnerVanished` の doc「時刻を持たない」）。
function vanishedOf(
  record: ManagerRecord,
  registeredRunnerIds: ReadonlySet<string> | null,
): true | undefined {
  if (record.job.status !== 'running') return undefined;
  // 判定できない回は立てない。
  if (registeredRunnerIds === null) return undefined;
  const runnerId = record.job.runnerId;
  if (runnerId === undefined) return undefined;
  if (registeredRunnerIds.has(runnerId)) return undefined;
  return true;
}

function runnerListedAtOf(
  job: Pick<Job, 'id' | 'runnerId'>,
  silentRunners: ReadonlyMap<string, string>,
  sessions: ReadonlyMap<string, { ids: ReadonlySet<string>; observedAt: string }>,
): string | undefined {
  const runnerId = job.runnerId;
  if (runnerId === undefined) return undefined;
  if (silentRunners.has(runnerId)) return undefined;
  const observed = sessions.get(runnerId);
  if (observed === undefined) return undefined;
  return observed.ids.has(job.id) ? observed.observedAt : undefined;
}

// 像が `#records` に載っていること自体を「話しかけられる」の根拠にしない: `#load()` が作った像は戻れるかを確かめておらず、`status: lost` と `live: true` の両立しない組が出る。
function isLive(record: ManagerRecord, silentRunners: ReadonlyMap<string, string>): boolean {
  // `lost` は何より先に見る: `#resume` は `await runner.resume(...)` の直後に楽観的に `attached = true` を書くので、
  // その間に `resume_failed` が届くと `lost` の像が `attached: true` で立つ。
  // `stopped` も同じ列に置く: `abort()` が `runner.list()` を探ってセッションが消えたことを確かめた事実で、`job.sessionId` は消さないので、
  // 下の `sessionId` 分岐に任せると停止後も `live: true` に化ける。
  if (record.job.status === 'lost' || record.job.status === 'stopped') return false;
  // 宛先の器が黙ったなら下の2つを見ない: `attached` / `sessionId` はイベント駆動でしか更新されず、器が合図なしに消えると `attached` が `true` のまま残る。
  // 足すのはデーモンが既に確定させた判定（名簿の `state: 'lost'`）だけ。`status` は動かさない: 黙っているのが器なのか経路なのかは片側から決められない。
  // 言えるのは「置き先として数えない」まで、「いま話しかけられない」とは言えない:
  // この行が `false` を返す委譲へ `ManagerPool.send()` を撃つと `outcome: 'delivered'` が返り、runner の resume の口が実際に叩かれた実測がある。
  // `silentRunners` と `send()` が通る `Registry#get()` は同じ名簿の違う面で、`#markSilent` は `entry.client` を落とさず `get()` は `entry.state` を見ない。
  // `live: false` を「送っても届かない」と読み替えない。
  //
  // `vacating`（意図して空けている最中）は `false` に倒さない:
  // 1. `live: false` には理由を1つだけ名指しする欄（`runnerLostSince`）が対に在り、`vacating` を倒すと理由を名乗れない `false` ができる。
  // 2. `live` は「話しかけられるか」しか言わない。`vacating` な器は heartbeat が続いており、置き先から外れることとは別である。
  // 3. `#silentRunners` のホワイトリストに `vacating` を足さない（黙った結果ではなく空けると決めた結果）。
  if (record.job.runnerId !== undefined && silentRunners.has(record.job.runnerId)) return false;
  if (record.attached) return true;
  // 「戻れなかった（`lost`）」と「戻る先が無い（session_id なし）」を潰さない: `status` と `sessionId` が別々に持つ。
  // ここで言えるのは「戻せないことの証明ではない」水準まで（`#runnerNotOpenDetail` と同じ）。
  return record.job.sessionId !== undefined;
}

// `isLive()` の返り値は読まない独立した集計にする: 数えるのは「`isLive()` が嘘をついている本数」ではなく、それを包む「宛先が名簿からまるごと消えている本数」。
export function vanishedRunnerBacklog(
  summaries: readonly ManagerSummary[],
  registeredRunnerIds: ReadonlySet<string>,
): ReadonlyMap<string, { count: number; oldestStartedAt: string }> {
  const backlog = new Map<string, { count: number; oldestStartedAt: string }>();
  for (const summary of summaries) {
    if (summary.status !== 'running') continue;
    if (summary.runnerId === undefined) continue;
    if (registeredRunnerIds.has(summary.runnerId)) continue;
    const existing = backlog.get(summary.runnerId);
    if (existing === undefined) {
      backlog.set(summary.runnerId, { count: 1, oldestStartedAt: summary.startedAt });
    } else {
      existing.count += 1;
      if (summary.startedAt < existing.oldestStartedAt) {
        existing.oldestStartedAt = summary.startedAt;
      }
    }
  }
  return backlog;
}

// `describeBackgroundWaitElapsed` を使わない: あちらは private で、日をまたぐ丸め方までは要らない。
function formatVanishedRunnerElapsed(elapsedMs: number): string {
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours < 1 ? `${String(minutes)}分` : `${String(hours)}時間${String(minutes)}分`;
}

// `[計器]`（`EXCHANGE_KIND_GAUGE_PREFIX`）を含めない: `exchange-kind-coverage.test.ts` の静的検査は呼び出し元の `text:` の式に接頭辞定数が直接在ることを見るので、関数の中に隠すと見えなくなる。
// 経過が読めない・負のときは経過を捏造せず省く（取れない軸に0の行を作らない）。
export function describeVanishedRunnerBacklogLine(
  runnerId: string,
  backlog: { count: number; oldestStartedAt: string },
  now: number,
): string {
  const parsed = Date.parse(backlog.oldestStartedAt);
  const elapsedMs = Number.isNaN(parsed) ? undefined : now - parsed;
  const elapsedText =
    elapsedMs === undefined || elapsedMs < 0
      ? ''
      : `（最古の委譲は${formatVanishedRunnerElapsed(elapsedMs)}経過）`;
  return (
    `[${runnerId}] 名簿から entry ごと消えている器の上に、` +
    `running のまま残っている委譲が ${String(backlog.count)} 本ある${elapsedText}。`
  );
}

// 「デプロイ全体の話」を「この委譲固有の話」より先に見る: プールが配線されていなければ、living 枝を経由していてもこの委譲について言えることは無い。
function tokenGenerationUnknownReasonOf(
  tokenGeneration: number | undefined,
  poolWired: boolean,
  reattachedAcrossRestart: true | undefined,
): TokenGenerationUnknownReason | undefined {
  if (tokenGeneration !== undefined) return undefined;
  if (!poolWired) return 'pool-not-wired';
  if (reattachedAcrossRestart === true) return 'reattached-across-restart';
  return 'not-yet-observed';
}

// `live` などに既定値を置かず必須の引数にする: 省略した側が黙って「繋がっている」と名乗り、既定を `false` にしても「繋がっているのに切れて見える」が混ざる。
// 材料が `record` から読めないプロセス内の状態（名簿・`#usageStopped` など）の欄は、呼ぶ側が計算した値だけを渡す。
function summaryOf(
  record: ManagerRecord,
  live: boolean,
  runnerLostSince: string | undefined,
  runnerVanished: true | undefined,
  sessionMissingSince: string | undefined,
  turnEndedAt: string | undefined,
  turnEndReason: string | undefined,
  turnEndTail: string | undefined,
  toolUseStallAt: string | undefined,
  toolUseStallPending: PendingToolUse[] | undefined,
  awaitingBackground: ManagerAwaitingBackground | undefined,
  tokenGeneration: number | undefined,
  activeTokenGeneration: number | undefined,
  tokenGenerationPoolWired: boolean,
  resetTimeSkewMatch: NoticeResetMatch | undefined,
  usageStoppedAt: string | undefined,
  runnerListedAt: string | undefined,
): ManagerSummary {
  const { job } = record;
  const tokenGenerationUnknownReason = tokenGenerationUnknownReasonOf(
    tokenGeneration,
    tokenGenerationPoolWired,
    record.reattachedAcrossRestart,
  );
  return {
    managerId: job.id,
    status: job.status,
    live,
    ...(runnerLostSince === undefined ? {} : { runnerLostSince }),
    ...(runnerVanished === undefined ? {} : { runnerVanished }),
    ...(runnerListedAt === undefined ? {} : { runnerListedAt }),
    ...(sessionMissingSince === undefined
      ? {}
      : {
          sessionMissingSince,
          // 由来は引数にせず像から読み、時刻と一緒にしか出さない: 片方だけ渡し忘れると、時刻の無い由来や由来の無い時刻が外へ出る。
          ...(record.sessionMissingKind === undefined
            ? {}
            : { sessionMissingKind: record.sessionMissingKind }),
          // 判定できないとき（`record.runnerSessionSince` が無い）も `false`（届いていない）側に倒す。
          shutdownObservationArrivedAfterSwap:
            job.lastUnpushedWorkObservation?.source === 'shutdown' &&
            record.runnerSessionSince !== undefined &&
            job.lastUnpushedWorkObservation.at >= record.runnerSessionSince,
        }),
    // 3欄は独立に出し分ける: `turnEndedAt` だけは元の行が `timestamp` を持たないとき単独で欠けうるので、その有無で残り2つを畳まない（`toolUseStall*` も同じ）。
    ...(turnEndedAt === undefined ? {} : { turnEndedAt }),
    ...(turnEndReason === undefined ? {} : { turnEndReason }),
    ...(turnEndTail === undefined ? {} : { turnEndTail }),
    // `toolUseStallAt` は元の行が `timestamp` を持たないと単独で欠けうるので、`turnEnded*` と独立に出し分ける（片方の有無でもう片方を畳まない）。
    ...(toolUseStallAt === undefined ? {} : { toolUseStallAt }),
    ...(toolUseStallPending === undefined ? {} : { toolUseStallPending }),
    cwd: job.cwd ?? '',
    request: job.request ?? job.summary,
    startedAt: job.createdAt,
    updatedAt: job.updatedAt,
    waiting: [...record.waiting],
    ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
    ...(job.lastReport === undefined ? {} : { lastReport: job.lastReport }),
    ...(job.lastReportAt === undefined ? {} : { lastReportAt: job.lastReportAt }),
    ...(job.lastReportStatus === undefined ? {} : { lastReportStatus: job.lastReportStatus }),
    // `lastReport` と同じ行で運ぶ: 片方だけだと、読む側が「報告が来た」と「エラーで死んだ」を本文の文言で判定するしかなくなる。
    ...(job.lastFailure === undefined ? {} : { lastFailure: job.lastFailure }),
    ...(job.lastUnreported === undefined ? {} : { lastUnreported: job.lastUnreported }),
    ...(job.lastFoldedTurn === undefined ? {} : { lastFoldedTurn: job.lastFoldedTurn }),
    ...(job.lastSystemError === undefined ? {} : { lastSystemError: job.lastSystemError }),
    ...(job.lastCgroupEvents === undefined ? {} : { lastCgroupEvents: job.lastCgroupEvents }),
    ...(usageStoppedAt === undefined ? {} : { usageStoppedAt }),
    ...(job.runnerId === undefined ? {} : { runnerId: job.runnerId }),
    // `unknown` を黙って落とさない: 欄ごと消すと「取れなかった」という観測が消える。
    ...(job.workspace === undefined ? {} : { workspace: job.workspace }),
    // 貸し出しは判定を出さず材料だけ写す: `judgeLease` は時刻で答えが変わるので、一覧に焼くと読んだ瞬間から古びる。
    ...(job.lease === undefined ? {} : { lease: job.lease }),
    ...(job.lastUnpushedWorkObservation === undefined
      ? {}
      : { lastUnpushedWorkObservation: job.lastUnpushedWorkObservation }),
    ...(job.lastRescue === undefined ? {} : { lastRescue: job.lastRescue }),
    // `live` と同じく引数で運ぶ（省略可能にしない）: 既定を置くと、足す人が考えなかったことが「背景処理は待っていない」という主張になって外へ出る。
    ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
    // `tokenGeneration` が無ければ `activeTokenGeneration` も出さない: 比べる相手が無い判定を作らない。
    ...(tokenGeneration === undefined
      ? // 測れていないときだけ、なぜ測れていないかを添える。
        tokenGenerationUnknownReason === undefined
        ? {}
        : { tokenGenerationUnknownReason }
      : {
          tokenGeneration,
          ...(activeTokenGeneration === undefined ? {} : { activeTokenGeneration }),
        }),
    ...(resetTimeSkewMatch === undefined ? {} : { resetTimeSkewMatch }),
  };
}

// 判定を2箇所へ書かない: `describeTokenGeneration` の ⚠ と `failureLine` の但し書きは同じ事実で、別々に書くと片方だけ直って食い違う。
// どちらかが `undefined` なら偽: 比べる相手が居ないときに食い違いを捏造しない。
export function tokenGenerationMismatched(
  manager: Pick<ManagerSummary, 'tokenGeneration' | 'activeTokenGeneration'>,
): boolean {
  if (manager.tokenGeneration === undefined) return false;
  if (manager.activeTokenGeneration === undefined) return false;
  return manager.tokenGeneration !== manager.activeTokenGeneration;
}
