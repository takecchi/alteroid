import { randomUUID } from 'node:crypto';

import { assertNever } from './assert-never.js';
import { ArchiveReceiver } from './archive-receiver.js';
import { AutoFold } from './auto-fold.js';
import { DAEMON_RUNNER_REGISTRY_SOURCE } from './daemon-self-notice.js';
import { DenialRenotifier } from './denial-renotify.js';
import {
  journalEntryShape,
  noteBackgroundFailure,
  noteDroppedRecord,
  noteManagerIdCollision,
  noteResumeAfterStopFoldFailed,
  noteRunnerFarewellGaveUp,
  noteUnreadableRecord,
  reasonOf,
  runnerEventShape,
} from './dropped-record.js';
import { excerptLine, renderListing } from './excerpt.js';
import { laterIso } from './later-iso.js';
import { HELD_FORCE_FOLD_AFTER_MS, HeldMessages, type StaleHoldStuck } from './held-messages.js';
import { WITHHELD_REPORT_EXCERPT, resolveWithheldReportFlushMs } from './withheld-reports.js';
import {
  decodeDenialKey,
  type DenialReasonSnapshot,
  type DenialRenotifyState,
  type ManagerDenial,
} from './denial-key.js';
import {
  resolveWorkspacePolicy,
  workspaceAfterRelocation,
  workspaceLocatorFrom,
  type WorkspacePolicy,
} from './workspace-policy.js';
import {
  QUOTA_STOP_WINDOW_MS,
  failedReportBodyOf,
  partialBeforeFailureOf,
  quotaMarkOf,
  type QuotaMark,
} from './quota-stop-notice.js';
import { QuotaStopWindows } from './quota-stop-windows.js';
import { RestoredWindows } from './restored-windows.js';
import { RESUME_CONFIRM_TIMEOUT_MS } from './resume-confirmation.js';
import { ResumeEventWindows } from './resume-event-windows.js';
import type { ClassifierDenialOverLimit } from './classifier-denial-streak.js';
import { resolveSynthesizedNoticeWindowMs, type FoldWhenBack } from './synthesized-notice.js';
import { SynthesizedNoticeWindows } from './synthesized-notice-windows.js';
import { isQuotaFailure } from './sdk-failure.js';
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
import {
  judgeClaimAgainst,
  movedAwayOf,
  registeredRunnerIdsOf,
  runnerSessionsOf,
  runnerSwappedSince,
  shouldRelocateFromRoster,
  sightingOf,
  silentRunnersOf,
  swapNoteOf,
} from './runner-roster.js';
import type { AgentPluginLoad } from './agent-events.js';
import { codeSpan } from './markdown-span.js';
import { PushLedger, type RunnerPushHealth } from './push-ledger.js';
import { SessionLoaders } from './session-loaders.js';
import { TurnEndWatch } from './turn-end-watch.js';
import type { CredentialService } from './credential-service.js';
import type { DelegatedPermissionRuleService } from './delegated-permission-rules.js';
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
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  RUNNER_CAPABILITY_MANAGER_PEERS,
  RunnerHttpError,
} from './runner-protocol.js';
import { attachmentRefsOf, ManagerAttachmentsRefusedError } from './manager-attachments.js';
import { readAttachmentLimits, type AttachmentLimits } from './attachment.js';
import { AttachmentStager } from './attachment-stager.js';
import {
  fetchManagerOutbox,
  rejectedFileOf,
  type ManagerReportFiles,
} from './manager-outbox-fetch.js';
import type {
  RunnerAttachment,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEntry,
  RunnerEvent,
  ScratchSweepItem,
  RunnerExecutionResources,
  RunnerLegState,
  RunnerManagerPeer,
  RunnerManagerPeerClosed,
  PidsSaturation,
  RunnerLiveness,
  RunnerMcpServersFingerprint,
  RunnerProfileFingerprint,
  RunnerRegistry,
  RunnerRevisionStatus,
  RunnerWaiting,
} from './runner-protocol.js';
import { definedProps } from './defined-props.js';
import { probeRunnerFingerprint, type RunnerFingerprintProbe } from './runner-probe.js';
import { brief } from './runner.js';
import type {
  InboxEvent,
  Job,
  JobStatus,
  JournalEntryInput,
  LastRescue,
  LastUnpushedWorkObservation,
  TextMarkup,
  UnpushedWorkObservationSource,
  WorkspaceLocator,
  ExternalOutput,
} from './schema.js';
import { externalOutputLimits } from './schema.js';
import { describeUnreadableManagerRow, UnreadableJobError, type Stores } from './store.js';
import { isManagerInFlight } from './job-status-running.js';
import { ManagerClosedFrontReceiver } from './manager-closed-front.js';
import { ManagerDenialReceiver } from './manager-denial.js';
import { ManagerParkedPeersReceiver } from './manager-parked-peers.js';
import { ManagerSelfFencedReceiver } from './manager-self-fenced.js';
import { ManagerSessionReceiver } from './manager-session.js';
import { ManagerToolUseReceiver } from './manager-tool-use.js';
import { askDeliveryOf, ManagerWaitingReceiver } from './manager-waiting.js';
import { ManagerTaskLink } from './manager-task-link.js';
import {
  carryKnownBranches,
  isUnpushedWorkObservationAtLeastAsNewAs,
  UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS,
  unpushedWorkObservationOf,
  type ManagerUnpushedWork,
} from './unpushed-work-observation.js';
import { StaleTokenFold } from './stale-token-fold.js';
import { markRescueGoneWhileAlive } from './rescue-cleanup.js';
import { RescueSweeper } from './rescue-sweeper.js';
import { ManagerRescueStash } from './manager-rescue-stash.js';
import { withCgroupEventsNote } from './cgroup-events.js';
import { withSystemErrorNote } from './system-error.js';
import type { NoticeResetMatch } from './token-reset-match.js';
import { resolveTokenSavingExcerpt } from './token-saving-switches.js';
import { classifyUsageNotice, isRateLimitReason } from './usage-limits.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { UsageRecordOrder, type UsageRecordTicket } from './usage.js';
import { UsageReceiver } from './usage-receiver.js';
import { UsageWake } from './usage-wake.js';
import { WithheldReportsStore } from './withheld-reports-store.js';
import { notePhase } from './loop-stall.js';
import {
  FOLD_NOTICE_COMMANDS_MAX,
  abortTextsOf,
  composeFoldNotice,
  composePeerCloseNotices,
  cwdSwapNoticeClause,
  describeStoppedReportFiles,
  describeVanishedRunnerBacklogLine,
  leaseRefusalDecision,
  NO_DROPPED_FILES,
  notifyExcerptLines,
  remainingFoldNotice,
  remainingPeerCloseNotice,
  reportDeliveryTextOf,
  reportFullTextOf,
  restartNudge,
  resumeFailureDetail,
  resumeFallbackBody,
  runnerSwapNudge,
  sendFailureDetail,
  unresumableNotice,
  type DroppedReportFiles,
  type RestartCause,
} from './manager-notices.js';
import {
  isLive,
  lostSinceOf,
  runnerListedAtOf,
  vanishedOf,
  vanishedRunnerBacklog,
} from './manager-liveness.js';
import { summaryOf, type SummaryContext } from './manager-summary.js';
import type { PendingToolUse } from './turn-end-probe.js';

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
   * この委譲が結び付く task（`manager_start` の `taskId`）。台帳の `Job.taskId` へ写し、委譲の状態に合わせてデーモンが task の状態を動かす（#5469 P3）。
   * 存在と開いているかの確認は呼び出し元（道具）が済ませる。ここでは確かめない: task が見つからなければ状態を追わせないだけで、委譲は止めない。
   */
  taskId?: string;
  /**
   * 記憶・日誌には中身を写さない（日誌にはメタデータの参照だけ）。runner が
   * `manager-attachments` を名乗らなければ断る: 欄が黙って捨てられるため。
   */
  attachments?: RunnerAttachment[];
  /**
   * 前任の managerId。failed / lost などで終わった担当の後継を立てるときに渡す: 前任の枠で止まった印を下ろし、自動の起こし直しの対象から外す（#4861）。
   * 前任が終わっていないとき（running / waiting_human / 生きている done）は断る: 止めるのはクローンの判断で、黙って止めない。
   */
  supersedes?: string;
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
 * 在庫（`WithheldReportsStore`）の写し。在庫は台帳（`Job.withheldReports`）にも写してあり、デーモンを作り直すと起動時に組み直される。
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
   * 素通しだと `UsageWake#clearUsageStoppedMark` が `Set` を先に下ろして台帳を非同期に下ろす窓で、
   * 要約だけが古い時刻を運ぶ。
   *
   * `lastFailure` とは別の軸で、重なりを許す（排他にしない）。走行中は `usage_notice` が
   * ターンの途中でも届くので `usageStoppedAt` だけが先に立ちうる。どちらか一方から
   * もう一方を推測しない。
   */
  usageStoppedAt?: string;
  /** 後継へ引き継いだ前任の側に立つ。自動の起こし直しの対象外（#4861）。 */
  supersededBy?: string;
  /** 後継の側に立つ、前任の id（#4861）。 */
  supersedes?: string;
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
   * `undefined` は「0 本」ではなく「分からない」（未聴取・状態が読めなかった委譲）。往復は足さず名簿の観測を
   * 読むだけなので、少し古いことがある。
   */
  liveBackgroundTasks?: number;
  /**
   * 分類器（auto mode）の拒否が上限を越えている相手（担当本人・作業者）。名簿の観測を読むだけなので少し古いことがある。
   * `undefined` は「分からない」（未聴取・古い runner）。空配列は「越えている相手は居ない」。
   */
  classifierDenials?: readonly ClassifierDenialOverLimit[];
  /**
   * 担当の答え（`peer_approve`）を待っている peer（Codex）の確認の本数と、最古の待ち始めの時刻（#4886）。確認に期限は無く、答え忘れると peer は止まったまま残る。
   * 待っているものが無いとき・分からないとき（未聴取・古い runner）は欄が無い。名簿の観測を読むだけなので少し古いことがある。
   */
  pendingPeerApprovals?: { count: number; oldestSince: string };
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
  /**
   * 預かっている未追跡のファイル（`Job.rescueStash`。#4863 案A）の件数・合計・いちばん新しい預かりの時刻。
   * パスは載せない（`manager_report` と取り戻しの知らせが出す）。預かりが無ければ欄ごと無い。
   */
  rescueStash?: { count: number; totalBytes: number; latestAt: string };
  externalOutputs?: ExternalOutput[];
  /**
   * `manager_send` が届けられずに預かっている伝言（`Job.heldMessages`）の件数と、いちばん古い預かりの時刻。
   * 本文は載せない（送り手自身の文で、一覧の予算を食う）。預かりが無ければ欄ごと無い。
   */
  heldMessages?: { count: number; oldestHeldAt: string };
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
   * 値は運ばない。無いことだけを見ない: `asked` かつ無しなら「置いていない」、`unheard`/`failed` なら
   * 「訊けなかった」。
   */
  mcpServers?: RunnerMcpServersFingerprint;
  mcpServersProbe?: RunnerFingerprintProbe;
  /**
   * 潰さない3状態: 読めた／runner に訊けなかった（`resources` 自体が `undefined`。理由は
   * `resourcesProbe` が持つ）／訊けたが pids が読めなかった（cgroup を持たない器。欄ごと省略）。
   * 2 と 3 を同じ文言に倒さない: 疑う先が違う（2 は接続・器の生死、3 は cgroup 構成）。
   */
  resources?: RunnerExecutionResources;
  /** `resources` が無い理由（`unheard` / `failed`。`asked` で無しなら、runner が資源を名乗らなかった）を持つ。 */
  resourcesProbe?: RunnerFingerprintProbe;
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

type RunnerManagerPeers =
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
 * - `'skipped-concurrent'`: 2つの契機のもう一方が同じ委譲を処理中（`AutoFold#inFlight` の doc）。
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

type ManagerDecision = 'allow' | 'deny';

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
 * | `'declined'` | 世代が食い違う done の委譲を畳んで新しい鍵で起こし直したいが、畳めない（背景処理・確認待ちが残っている・それらが分からない・畳めたと確かめられない）ので、畳まず、旧セッションへも送らなかった。預からなかった（添付付き・預かりの上限を超えた）。そのものは居る | 200 |
 * | `'held'` | `'declined'` と同じ理由でいまは届けられないので、台帳（`Job.heldMessages`）に預かった。届けられるようになったら自動で届け、日誌とクローンへ知らせる（`deliverHeldMessages`）。送り直すと二重に届く | 200 |
 *
 * `'session_missing'` を `'unknown'` へ畳まない: daemon の `app-routes-managers.ts` が 404 を返し、`ManagerAbortResult` の doc が
 * 否定した形（待てば直る状態を 404 という機械可読な終端で返す）に戻る。`sessionId` が残っていれば
 * もう一度 resume を試せる。404 は「そんなものは無い」としてしか読めず、読み手の解釈で救われない。
 * `RunnerClient.send` が `Promise<boolean>` なのは、`LocalRunner` が例外を投げず、セッションが
 * 無くても常に `'delivered'` になるのを防ぐため（`#sendDetectingMissingSession` が戻り値も読む）。
 */
export interface ManagerSendResult {
  outcome:
    'answered' | 'delivered' | 'session_missing' | 'unknown' | 'unreadable' | 'declined' | 'held';
  detail: string;
}

/**
 * requestId 無しの decision が確認に当たらなかった回を言う警告（当たらない回は空文字）。
 * 待っている確認が無いと本文は追加指示として届く（預かりは本文だけを持つ）ので、言わないと、
 * 呼び手は許可・拒否を出したつもりのまま、相手は本文を普通の指示として読む。当たった回の outcome は `answered`。
 * 道具（`manager_send`）と HTTP（`POST /managers/:id/messages`）で入口ごとに文が変わると、同じ失敗の見え方が割れるので、
 * 文はここ1か所に置く。
 */
export function decisionUnusedNote(
  decision: ManagerDecision | undefined,
  requestId: string | undefined,
  outcome: ManagerSendResult['outcome'],
): string {
  if (decision === undefined || requestId !== undefined) return '';
  if (outcome !== 'delivered' && outcome !== 'held') return '';
  return (
    `\n⚠ decision（${decision}）を付けたが、いま答えを待っている確認が無かったので、回答としては使っていない` +
    '（許可・拒否としてはどこにも当たっていない）。本文は追加指示として' +
    (outcome === 'held' ? '預かった。' : '届けた。') +
    '確認に答えるつもりだったなら、受信箱に届いた requestId を付けて送り直すこと。'
  );
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
  /**
   * 確認への回答として `runner.answer` を呼ぶ直前に、答える確認を渡して呼ぶ。投げたら答えず、例外をそのまま呼び手へ伝える。
   * 回答でない送信（確認待ちに当たらなかった回）では呼ばれない。
   *
   * Why not 呼び手が自分で確認を特定して先に日誌を書く: 答える確認を選ぶのは `send` の中（`#choosePending`）で、
   * 呼び手は `requestId` 無しの `decision` がどの確認に当たるかを知らない。呼び手が推測して書くと、
   * 日誌の確認と実際に答えた確認がずれうる。
   */
  beforeAnswer?: (pending: { requestId: string; summary: string }) => Promise<void>;
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
type VacateHandshakeSkipReason = 'runner_unreadable' | 'jobs_unreadable';

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
   * 1件だけ読む（#5089）。`list()` の該当の1件と同じ像を返す（ただし一覧の並べ替えと、一覧のついでに書く計器は無い）。
   * 無ければ `undefined`。台帳の行が読めなければ `UnreadableJobError`。
   */
  get(managerId: string): Promise<ManagerSummary | undefined>;
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
   * `GET /runners` が `pushHealthOf` と同じ理由で経由する。`undefined` は「観測なし」で、
   * 「読み込みに失敗した」とも「0件」とも読まない。
   */
  pluginLoadOf(runnerId: string): RunnerPluginLoadObservation | undefined;
  /** `pushHealthOf` と同じ理由で `GET /runners` が経由する。 */
  managerPeersOf(runnerId: string | undefined): RunnerManagerPeers;
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
  runnerReportedModels(runnerId: string): { manager?: string; worker?: string } | undefined;
  /** 表示用。`undefined` は不明で、`[]` の「何も置かれていない」とは別。 */
  runnerReportedAnthropicRoute(runnerId: string): readonly string[] | undefined;
  /**
   * 新しい往復・周期処理は無い: `#place` が既に払った `resources()` の応答を使う（判定・実行は
   * `AutoFold#foldIdleOnRunnerIfUnderPressure` と共有し、ロジックを2つに増やさない）。
   * `manager_start` の応答を待たせない（`void` で切り離す）: 配置の点数計算は終わっていて、
   * 畳んだ分の pids は今回の配置に反映されないのに、`unpushedWork()` の往復ぶん配置が遅くなる。
   */
  autoFoldOnPlacementPressure(
    runnerId: string,
    pids: { readonly current: number; readonly max: number },
  ): void;
  /**
   * 周回の見回りから、開いている各 runner の pids を読み、逼迫していれば自動の畳みを掛ける（#5157）。
   * `runner_list resources:true`・配置・鍵の回転の前、のどれの契機も来ない間に器が飽和しても畳めるようにする口。
   * 判定と実行は `AutoFold#foldIdleOnRunnerIfUnderPressure` と共有し、条件は変えない。
   * 走らせる間隔は 30 分で、ここで間引く（毎分の呼び出しは何もせず返る）。前の回が終わっていなければ何もしない。
   * 1つの runner の失敗で残りを止めない。
   */
  autoFoldUnderPressure(): Promise<void>;
  /**
   * 周回の見回りから、終わった委譲にしか結び付いていないのに `waiting` のままの task を `needs_decision` へ直す。
   * 報告由来の `done`（ターンの終わり）は `ManagerTaskLink#sync` が task を動かさず、猶予（`TASK_FOLLOW_GRACE_MS`、30 分）を過ぎて静かなままのものをここが倒す。
   * 冪等（何度呼んでも同じ結果）で、`restore()` が起動時に走らせる直しと同じ本体。止めた後は何もしない。読めない・書けないときは例外にせず stderr に残す。
   */
  repairStrandedTasks(): Promise<void>;
  /** manager_id からセッションの生ログへ降りる（可観測性の最下段）。 */
  transcript(managerId: string): Promise<ManagerTranscript>;
  /**
   * 生ログの末尾だけ（本文が `maxChars` より長ければ、それを厳密に上回る量。短ければ全文）。全文が要らない読み手用（#4638）。
   * 省略可能: 持たない実装（テストの偽物）では、呼び手が `transcript()` に落ちる。
   */
  transcriptTail?(managerId: string, maxChars: number): Promise<ManagerTranscript>;
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
   * （`selectArchiveRemovalTargets` の「含有の証明」の上にしか成り立たない）。ネットワークは叩かない。
   */
  runningManagerPinning(archiveId: string): string | undefined;
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
   * 退避 ref（`refs/alteroid-rescue/…`）の後始末を1周する。
   * 台帳（`Job.lastRescue`）に無い ref は触らない（孤児を消さない）。消した印は `pushed.removal` に残し、
   * `pushed` は消さない。走査の間隔はここで空ける（全委譲の台帳を読むので毎分は撃たない）。
   * 1件の失敗で残りを止めない。
   */
  sweepRescueRefs(): Promise<void>;
  /**
   * `manager_send` が預かった伝言（`Job.heldMessages`）を、委譲ごとに古い順に1通へまとめ、`send()` と同じ経路でもう一度届ける。
   * 届けられる条件は `send()` の判定そのまま（背景処理・確認待ちが片付けば畳んで新しい鍵で起こし直す・抱えている鍵が ready なら旧セッションへ・器が替わっていれば resume）で、ここに別の判定を書かない。
   * 届けたら日誌とクローンへ知らせる。期限切れ・委譲の終端では捨て、その本文ごと日誌とクローンへ返す（黙って消さない）。
   * 1件の失敗で残りを止めない（周期の呼び手はデーモンのポーラー）。
   */
  deliverHeldMessages(): Promise<void>;
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
 *
 * 値の積み上げ（#4932）: runner が畳みで待つ上限は自分の SIGTERM から 50 秒（`apps/runner/src/index.ts` の `PICKUP_WAIT_LIMIT_MS`）なので、
 * それ + 取り寄せの余裕 2 秒 = 52 秒。forced exit（55 秒）まで残る 3 秒が、待ったあとの吐き出し・口を閉じる・`storage.close()` の分
 * （以前は 45 秒で、runner の上限より手前だった）。`apps/daemon/src/index.ts` の `RUNNER_FAREWELL_DEADLINE_MS` と同じ値にそろえる。
 * デーモンの `drainingSeconds`（60 秒）は延ばさない: `LEASE_DRAIN_MS` の写しがあり、延ばす向きは二重実行の窓になる。
 */
const RUNNER_FAREWELL_WAIT_MS = 52_000;

interface ManagerPoolStopOptions {
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
 * `undefined` を渡す（逐語は `grep -Fn -- 'guardArchiveRemoval(context.managers, target.id, undefined' packages/core/src/clone-tools-ops.ts`）:
 * 理由1本で全件を開けると「どの1件をなぜ開けたか」が記録から消える。一括だから速い経路を別に引かない:
 * 引いた瞬間に退避を守る方針が片方の口からだけ消える。
 *
 * `requireContainment: true` のときだけ、保護を `runningManagerOwning`（`archiveIds` 全件）から
 * `runningManagerPinning`（末尾1本）へ狭める。含有の証明（`archive-prune.ts` の `selectArchiveRemovalTargets`）が
 * 前提で、`false` / `undefined` で狭めると証明の無い行を走行中の委譲から奪う。
 */
type ArchiveRemovalGuard =
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
    requireContainment === true
      ? managers.runningManagerPinning(archiveId)
      : managers.runningManagerOwning(archiveId);
  if (managerId === undefined) return { kind: 'allowed' };
  const reason = overrideReason?.trim();
  if (reason !== undefined && reason.length > 0) {
    return { kind: 'allowed-with-override', managerId, reason };
  }
  return { kind: 'denied', managerId };
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
  /**
   * トークン1本の「いま使えるか」を聞く。世代が食い違った done の委譲へ送るとき、畳めない理由（確認待ち・背景処理）が残っていても、
   * 委譲が抱えている古い鍵が `'ready'` なら断らず旧セッションへ届けるために使う。
   * 省略・`undefined`・例外は「分からない」で、従来どおり断る（安全側）。
   */
  tokenAvailability?: (
    tokenId: string,
  ) => Promise<'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined>;
  /** **このプールは回すかどうかを判断しない。** */
  onUsageObservation?: (observation: TokenRotatorObservation) => Promise<void>;
  /**
   * runner は記憶ストアを読めないので、器が作り直されたときに降ろすのはデーモンの責任である。
   * これが無いと、後から上がってきた runner は古いトークンで走るか資格を持たずに走り、
   * その食い違いはマネージャーの側からは見えない。
   */
  syncRunnerToken?: (runner: RunnerClient) => Promise<void>;
  /**
   * 鍵の回転で runner へ撒いた結果を受け取る口（#4725）。落ちた runner は `agentToken` の失敗として帳面に載せ、挑み直す（`syncRunnerToken`）。
   * これが無いと、回転で1度だけ撒き損ねた runner は、繋ぎ直すかデーモンを起こし直すまで、冷却中の古い鍵のまま担当を起こし続ける。
   */
  agentTokenPushes?: {
    onPushed(
      listener: (results: readonly { runnerId: string; ok: boolean; error?: string }[]) => void,
    ): () => void;
  };
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
  /** 委譲先の許可規則（#4952）。runner は記憶ストアを読めず一覧をメモリにしか持たないので、名乗りのたびに降ろし直すのはデーモンの責任である。 */
  permissionRules?: DelegatedPermissionRuleService;
  /** runner は記憶ストアを読めないので、器が作り直されたときに降ろすのはデーモンの責任である。 */
  codexAuth?: CodexAuthRunnerSync;
  /** 期限は時刻そのものが答えを決めるので、渡せないと「猶予の中では奪わない」を確かめる試験が書けない。 */
  now?: () => number;
  /** `vi.mock('node:crypto')` は使わないので、衝突を再現する試験はここを差し替えるしかない。 */
  generateManagerId?: () => string;
  workspace?: WorkspacePolicy;
  withheldReportFlushMs?: number;
  /** 系統3「抜粋・予算」の節約を掛けるか（既定は掛ける。省略は `process.env` の `ALTEROID_TOKEN_SAVING_EXCERPT`）。 */
  tokenSavingExcerpt?: boolean;
  synthesizedNoticeWindowMs?: number;
  /** 枠だけの束をプール全体で1通にまとめる固定窓（既定 {@link QUOTA_STOP_WINDOW_MS}）。試験が短くするための口。 */
  quotaStopWindowMs?: number;
  /** resume が戻れたかの確定を待つ時間（既定 {@link RESUME_CONFIRM_TIMEOUT_MS}）。試験が短くするための口。 */
  resumeConfirmTimeoutMs?: number;
  attachmentLimits?: AttachmentLimits;
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

/**
 * 移った後の古い runner から届いたら、台帳・受信箱に触れず日誌にだけ残して捨てる出来事（#4924）。
 * `archive`（生ログの退避）と `mirror`（生ログの写し）は古い器からも取り込む。生ログの本文は古い器にしか無く、
 * 台帳も動かさないので、取り込まないと失われるため（#6190 の試験で縛ってある）。
 * `rescue_ref` は古い器からは取り込まない（#6193。個別に判定する: `rescue_files` と同じく `case` の頭で捨てる）。
 */
const MOVED_AWAY_IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session',
  'report',
  'ask',
  'settled',
  'parked_peers_closed',
  'rescue_restore_request',
]);

// 読めない時刻と無い時刻は数えない: 全部無ければ `undefined`（待ちの数え始めが分からない）
function earliestMs(times: readonly (string | undefined)[]): number | undefined {
  return times
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter((at) => !Number.isNaN(at))
    .reduce<number | undefined>(
      (min, at) => (min === undefined ? at : Math.min(min, at)),
      undefined,
    );
}

/**
 * `Pool#send` の届け方。`mode === 'held-delivery'` は預かった伝言の届け直し（`HeldMessages#deliver`）だけが使う: 断られても預け直さず、預かりの列にも並ばない（並ぶと自分自身を待つ）。
 * `mode === 'usage-rotation'` は鍵の回転・枠の起こし直し（`UsageWake#nudgeForUsageRotation`）だけが使う: 預かりに回さず（断られたら届かなかったと返し、周回の掃きが間隔を置いて挑み直す）、
 * 抱えている古い鍵が ready でなければ背景処理が残っていても畳む（#4850）。
 */
interface SendDelivery {
  mode: 'caller' | 'held-delivery' | 'usage-rotation';
  // 届けた断り書きが畳んだ背景処理（peer を除く）の本数を呼び手へ返す（#4902）: 起こし直しが成功した回だけクローンへ知らせるため
  onFoldNoticeDelivered?: (backgroundTasks: number) => void;
  // 見回り（`deliverHeldMessages`）からの届け直しだけ真（#4982）: 前と同じ判定で断るだけなら新しい判断ではないので、decision を書き直さない
  pollRetry?: boolean;
  // 待ちの上限（`HELD_FORCE_FOLD_AFTER_MS`）を過ぎた見回りの回に、畳まずに断った材料を呼び手へ返す（#5041）
  onStuck?: (stuck: StaleHoldStuck) => void;
}

/**
 * **`boolean` にしない。** `false` は「戻る先が無い」の意味で使われ、`send()` はそれを「新しく起こし直すこと」と
 * 報告する。読めなかっただけのときに同じ言葉を出すと、一時を恒久として報告し、起こし直すという誤った行動まで
 * 指示する（続きが失われる）。
 */
export type ResumeOutcome =
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

export interface ManagerRecord {
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
   * 出来事に付いて届いた世代（#5195）。**メモリだけで持つ**。いま追っている世代がここに無い間に古い世代から届いた報告は、捨てずに配る:
   * 起こし直した新しいセッションが黙ったまま、古いセッションが生きてターンを回し続け、その報告を全部捨てていたことがあるため
   * （2026-10-23 heosterra。古いセッションが止まらなかった理由はまだ分かっていない）。
   * 印（いまの世代を見たか）ではなく集合で持つ: 新しいセッションの出来事は resume の応答より先に届きうり、その間は追う世代が決まっていないため。
   */
  observedSessionGenerations?: Set<string>;
  /**
   * 直近の resume を、預かった生ログ無しで（`SessionLoaders#loadSession` が `absent`）新しいプロセスへ出したか（#4501）。
   * 器が作り直された・別の器へ移った後なら、新しい CLI に会話は無いので、戻れない見込みが高い。その旨を受理の知らせに添えるためだけに使う。
   * **プロセス内の像にしか置かない**。`#resume` が resume を出すたびに書き直す。
   */
  resumedWithoutLog?: boolean;
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
   * 再起動で引き取ったとき、runner の一覧がこのセッションの鍵として名乗った指紋（#4643）。**プロセス内の像にしか置かない**。
   * 生存確認の観測が無い間だけ、枠の通知に添える指紋の代わりに使う（`#sessionTokenFingerprintOf`）。
   */
  tokenFingerprintAtReattach?: string;
  /**
   * 再起動の引き取りの後、見回りの1回目で「配られていない報告」を確かめる印（#4644）。**プロセス内の像にしか置かない**。
   * 前のデーモンが受け取ったまま処理し終えずに落ちた `report` は、作り直したデーモンへ二度と届かない（SSE の控えを引く連番を持たないため）。
   * 1回確かめたら下ろす: 引き取った後の普通のターンの終わりまで「拾い直し」として配らないため。
   */
  reportCheckAfterRestore?: true;
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
export type LeaseRefusalKind = 'held' | 'ambiguous' | 'persist-failed';

/** 担当ごとに覚える、出来事に付いて届いた世代の数の上限（#5195）。比べたいのはいま追っている世代だけで、古いものは要らない。 */
const OBSERVED_SESSION_GENERATIONS_MAX = 8;

/** いま追っている世代があり、その世代の出来事がまだ1つも届いていないか（#5195 / #5203）。追っていなければ偽（判定しない）。 */
function trackedGenerationSilent(record: ManagerRecord): boolean {
  const tracked = record.sessionGeneration;
  return tracked !== undefined && record.observedSessionGenerations?.has(tracked) !== true;
}

/** `manager_send` の直接の返り値でページングを経由せず、`summary` は自由文なので、ここが伸びると全部そのまま agent へ渡る。 */
const AMBIGUOUS_WAITING_EXCERPT = 400;

/** `report` は「解決」で消える口が無いので `ASKED_MEMORY_LIMIT`（`manager-waiting.ts`）と揃える強い理由は無い（実測で偏りが分かったら値だけ分ける）。 */
const REPORTED_MEMORY_LIMIT = 512;

/** 上限も省略の合図も無い列挙にしない: `renderListing` に寄せて、切ったら「何件省いたか」が必ず出るようにする。 */
const REPORTED_FORGOTTEN_BUDGET = 2_000;

/**
 * 疑わしい側（上書き）を止める: 引き直しを打ち切って例外にしても `start()` を呼び直せば済むが、
 * 誤って上書きすると走行中の別の委譲の記録が黙って消える（`lease.ts` の `mayClaim` と同じ非対称）。
 * 達するのは注入された発行器が衝突しやすい値しか返さないときだけで、その異常を上書きで隠さない。
 */
const MAX_MANAGER_ID_ATTEMPTS = 5;

const HELLO_WAIT_MS = 5_000;
const HELLO_POLL_MS = 50;

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
  readonly #codexAuth: CodexAuthRunnerSync | undefined;
  readonly #records = new Map<string, ManagerRecord>();
  /** **器の時計を直に読まない**（時計を渡せないと「猶予の中では奪わない」を確かめる試験が書けない）。 */
  readonly #now: () => number;
  /** 委譲の状態を結び付いた task へ写す（`#persist` が `readBefore`・`stampEndedAt`・`sync` を、`restore()` と見回りが `repairStranded` を呼ぶ）。 */
  readonly #taskLink: ManagerTaskLink;
  /** 構築時に一度だけ確定し、以後 `process.env` を読み直さない。 */
  readonly #withheldReportFlushMs: number;
  /** 構築時に一度だけ確定する（`ALTEROID_TOKEN_SAVING_EXCERPT`）。偽なら報告を最後の発言だけにせず、畳んだ報告の抜粋の予算を #5414 の前に戻す。 */
  readonly #tokenSavingExcerpt: boolean;
  /** 枠だけの束のプール全体の窓と、窓を外した後の flush の集合（`QuotaStopWindows`）。 */
  readonly #quotaWindows: QuotaStopWindows;
  /** 「取り戻した」知らせの窓と、resume が戻れたかの確認（`RestoredWindows`）。 */
  readonly #restored: RestoredWindows;
  /** **器の乱数を直に読まない**（テストが衝突を再現できるようにする。`#now` と同じ理由）。 */
  readonly #generateManagerId: () => string;
  /** **`start` のたびに `process.env` を読み直さない**: 起動時に1度だけ解決して保持する。 */
  readonly #workspace: WorkspacePolicy;
  readonly #tokenIdentity:
    (() => { tokenId: string; generation: number; fingerprint?: string } | undefined) | undefined;
  readonly #onWorkerToolEvent: ((event: WorkerToolEvent) => void) | undefined;
  readonly #onUsageObservation:
    ((observation: TokenRotatorObservation) => Promise<void>) | undefined;
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
  readonly #attachmentStager: AttachmentStager;
  readonly #staleTokenFold: StaleTokenFold;
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
   * 下ろす箇所（`UsageWake#clearUsageStoppedMark`）は両方を同じタイミングで下ろす。
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
   * 作業者（サブエージェント）の枠の落ちで手を止めた担当の印（#5030）。`#usageStopped` とは別の印にする:
   * 担当自身は枠で落ちておらず、鍵の回転の契機（`#observeForTokenRotation`）にも流さない（#4903「回転は起こさない」）。起こすのは担当の続きだけ。
   * `turnStartedAt` は落ちが記録されたターンの開始時刻。担当がそのあと新しいターンを始めたら（値が変わったら）印を下ろす。
   * 6785 の「自力で終えたターンへ一言を投げない」決め（`UsageWake#settleUsageWake`）の例外は、この印の立つ「作業者の落ちが記録されたターン」だけ。
   * **台帳（`Job.workerLimitStopped`）にも写しを持つ**（`#usageStopped` と同じ理由）: メモリだけだと、デーモンが再起動した後は回転前の鍵で止まった `done` の担当が鍵が回っても起こされず放置される。
   * `Map` が真の参照で、台帳側はデーモンの寿命を跨ぐための写し。起動時（`#restoreJobs`）に組み直す。下ろす箇所は `UsageWake#clearWorkerLimitMark` か、台帳を書く直前の `delete record.job.workerLimitStopped`。
   */
  readonly #workerLimitStopped = new Map<
    string,
    { readonly preRotationKey: boolean; readonly turnStartedAt: string | undefined }
  >();
  // 後継を起こしている最中の前任（確認 → `supersededBy` の書き込みの間）。値は後継を起こす start の印（#4865）
  readonly #supersedePending = new Map<string, symbol>();
  /**
   * 起こし直しが届かなかった（`skipped`）担当の、次に挑み直す時刻と失敗の回数（#4850 / #4733）。揮発してよい: 消えても印（`#usageStopped`、台帳にも写しがある）が残り、次の鍵の出来事か周回の掃きが拾い直す。
   * 周回の掃き（`settleStalledUsageWakes`）だけが読む。成功・印の解除で消す（間隔を戻す）。
   */
  readonly #usageWakeRetry = new Map<string, { failures: number; nextAt: number }>();
  /**
   * いま走っている枠の起こし直し（`UsageWake#nudgeForUsageRotation`）。担当ごとに1本だけ通す（#5205 の引き金）。
   * 起こす契機は複数ある（失敗の報告・closed・回し手の `resumeStoppedByUsage`・周回の掃き・作業者の落ち）。印を下ろすのは起こし終えた後なので、
   * その間に来た2本目も判定を通り、起こし直したばかりのセッションを「古い鍵」と見て畳んで起こし直していた（2026-10-23 mgr-3b537374）
   */
  readonly #usageNudgeInFlight = new Map<string, Promise<unknown>>();
  /**
   * 回転前の鍵で作業者が落ちた担当（`#workerLimitStopped`）を、周回の掃きで次に挑む時刻と失敗の回数。
   * ターンの終わりに現役の鍵がまだ `ready` でなかった・起こしが届かなかった担当を、次の鍵の回転まで取り残さないため。
   * 揮発してよい: 消えても印が残る間は次の周回が拾う。印が消えたら下ろす。
   */
  readonly #workerLimitWakeRetry = new Map<string, { failures: number; nextAt: number }>();
  /**
   * 鍵の回転の起こし直しを、背景処理を理由に待たせている担当の、待ちの上限の時刻（epoch ms。#5044）。
   * `UsageWake#noteOutcome` が次の挑み直しをこの時刻へ寄せるためだけに使い、読んだら下ろす。揮発してよい: 消えても倍々の間隔で挑み直す。
   */
  readonly #rotationFoldDueAt = new Map<string, number>();
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
   *
   * **`#retire()` で消さない（畳んだ委譲の分も残る）**: 畳んだ後も読む所が在る。一覧（`list()` の世代の ⚠）・枠で止まった委譲の起こし直しと周回の掃き・
   * 像を外した後の `#observeForTokenRotation`・`#queueSynthesizedNotice`（窓の鍵）は、いずれも畳んだ委譲を相手にする。消すと世代が「分からない」に戻り、判定が変わる。
   * 1件は `{ tokenId, generation }` だけで、増えるのは起こした委譲1本につき1件。消してよい契機（台帳から委譲が消える経路）は今は無い。
   */
  readonly #tokenIdentities = new Map<string, { tokenId: string; generation: number }>();
  /**
   * 429の文言の resets 時刻をプールの各鍵の cooldownUntil と突き合わせた結果（{@link ManagerSummary.resetTimeSkewMatch}）。
   * `#tokenIdentities` とは別の材料源（`reached` のたびに DB を読み直す）なので、あちらが空でも埋まりうる。
   * 枠で止まった印と寿命を揃えて下ろす: 古い判定が次の当たりに貼り付かないように。
   * 台帳には写さない: 起こし直す対象を覚える印ではなく計器で、次の `reached` で作り直せる。
   */
  readonly #resetTimeSkewMatches = new Map<string, NoticeResetMatch>();
  /** 握り潰した「背景処理の完了待ちで畳んだ報告」の在庫と、窓へ運ぶ途中の在庫（`WithheldReportsStore`）。 */
  readonly #withheld: WithheldReportsStore;
  /**
   * 機構が合成した知らせの担当ごとの合流窓と、窓をまたいで同文を畳む連（`SynthesizedNoticeWindows`）。在庫（`#withheld`）とは別物。
   * `#emit()` は呼ばれるたびに全 managerId ぶんを先に flush する（`docs/architecture.md`「順序は並べ替えない」）。
   */
  readonly #synthesized: SynthesizedNoticeWindows;
  /**
   * `#observeUnpushedWorkOnce` の多重投げ止め。トリガー（`report` 終わり・`git push` 検出）を問わず
   * 1つの Set を共有する: 待たずに投げるので、短い間隔で続くと runner への往復が同じ委譲へ積み上がる。
   * 揮発してよい（1本ずつを守るだけの印で、台帳に写す状態ではない）。
   */
  readonly #unpushedWorkObservationInFlight = new Set<string>();
  /** 使用量を受け取る出来事の受け側（`UsageReceiver`）。枠の記憶・畳みの窓はここが持ち、`#usageStopped` などの印は `Pool` が持って参照を渡している。 */
  readonly #usageReceiver: UsageReceiver;
  readonly #autoFold: AutoFold;
  readonly #denialRenotifier: DenialRenotifier;
  readonly #rescueSweeper: RescueSweeper;
  readonly #rescueStash: ManagerRescueStash;
  /** 枠で止まった担当の起こし直し（`UsageWake`。周回の掃き・鍵の回転の起こし・印の解除）。欄は上の `#usageStopped` などをこの `Pool` が持ち、参照を渡している。 */
  readonly #usageWake: UsageWake;
  /**
   * 担当ごとの「新しい入力を生きたセッションへ渡しに行った回数」。`#send` が渡す直前に進め、自動の畳み（`abort()` の `by === 'auto-fold'`）が
   * 止める直前に控えと見比べる。時刻にしない: 同じ時刻に2回入っても、回数なら違いが消えない。
   * 外す契機は `#retire()`（#6019: 終えた担当の欄を残さない）。
   */
  readonly #inputMarks = new Map<string, number>();
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
   * 委譲ごとの、resume が通った回数（`#resume` が `resumed` を返した回。#5207）。鍵の付け替えの畳み（`StaleTokenFold`。参照で渡してある）が、
   * 判断を始めてから畳む直前までの間に、別の経路が起こし直していないかを見るためだけに使う。数そのものに意味は無い。
   * **`#retire()` で消さない**: 判断の最中に担当が畳まれて数が 0 に戻ると、起こし直しが無かったのに「数が変わった」と読んで判定が変わる。
   * 1件は数1つで、増えるのは resume が通った委譲1本につき1件。
   */
  readonly #resumedCount = new Map<string, number>();
  /**
   * 永続化しない: 試すのを止める印ではなく（断った runner も `hello` のたびに試される）、
   * 再起動後に候補を1巡し直すのは妥当で、無限には試さない。
   */
  readonly #relocationRefusals = new Map<string, Set<string>>();
  /** resume の最中に届く出来事を預ける窓（`ResumeEventWindows`。移送の窓と同じ runner への復帰の窓の欄はそちらが持つ）。 */
  readonly #resumeWindows: ResumeEventWindows;
  /**
   * 生きていた旧プロセスへ流しただけの resume の印。`send()` の返す文と、`#tokenIdentities` を書かない理由（凍った鍵）に対応する。
   * `#retire()` で消さない: 畳んだ委譲への次の `send()` が同じ旧プロセスへ流れたとき、返す文が変わる。消えるのは resume で新しい SDK を起こした回と指紋で確かめた回。
   */
  readonly #resumedIntoLiveProcess = new Set<string>();
  /**
   * `retry` は runner 単位、この判定はジョブ単位: 覚えておかないと「挑み直さない」と決めたジョブが毎回巻き込まれて再送され、
   * 同じ障害通知がクローンの受信箱に積み上がる。
   * 人間とクローンの明示的な経路は塞がない（`manager_send` の resume はここを見ない）。
   * `#retire()` で消さない: 諦めた委譲は台帳の終端（畳んだ後）から見回りが拾うので、畳んだ後こそ読む。消えるのは resume が通った回とデーモンの停止。
   */
  readonly #unresumable = new Set<string>();
  /**
   * `closed(failed / lost)` でクローンへ知らせた peer の閉じの知らせの `at`（担当ごと）。同じ知らせを閉じのたびに重ねて出さないための印。
   * 台帳の `pendingPeerCloseNotice` は担当が起こされるまで残すので、これで「知らせ済み」を分ける（プロセス内だけ: 閉じは再起動を跨いで届き直さない）。
   */
  readonly #peerCloseReportedAt = new Map<string, string>();
  /**
   * `record.leaseRefusal`（ジョブ単位）ではなく `runnerId` 単位で持つ: 併存の検出は `#claimForResume` と、
   * `record` に触れずに抜ける `#reattach` の早期検出の2箇所にあり、後者が見つけた併存は `#claimForResume` に届かず
   * 「解けた」を言う機会が無いまま残る。1つの状態にすれば、どちらの経路でも「入った」「解けた」が1回ずつ出る。
   * 「解けた」を出さないと、併存が続いているのか解けたのか、受信箱の沈黙からは区別できない。
   */
  readonly #ambiguousRunnersNotified = new Set<string>();
  /** 弱参照なのは、名簿から外れた runner をここが握り続けないため。 */
  readonly #connections = new WeakMap<RunnerClient, Promise<void>>();
  readonly #pushLedger: PushLedger;
  readonly #sessionLoaders: SessionLoaders;
  readonly #held: HeldMessages;
  /** 消さない: 器が入れ替わっても次の `session` が上書きし、`at` が観測の古さを名乗る。 */
  readonly #pluginLoad = new Map<string, RunnerPluginLoadObservation>();
  readonly #unsubscribeDirectPushes: (() => void)[] = [];
  readonly #turnEndWatch: TurnEndWatch;
  readonly #unsubscribe: () => void;
  #stopped = false;
  readonly #eventsInFlight = new Set<Promise<unknown>>();

  /**
   * 後から届いた同じ委譲の `settled` / `closed` などはこれが終わるまで処理を始めない:
   * `#onEvent` は並行に走るので、さもないと後続が報告を追い越し、クローンへは「終わった」の後に報告が届く。
   */
  readonly #reportFetchGates = new Map<string, Promise<void>>();
  readonly #attachmentLimits: AttachmentLimits | undefined;
  readonly #archiveReceiver: ArchiveReceiver;
  /** 担当の `permission_denied` を数え、日誌と受信箱へ回す（`#handleEvent` の `case` が `handle` を直に返す）。 */
  readonly #denial: ManagerDenialReceiver;
  /** 担当の `session` を受け、plugin の読み込み・MCP の接続の署名を持つ（`#handleEvent` の `case` が `handle` を直に返す）。 */
  readonly #session: ManagerSessionReceiver;
  /** 担当の `tool_use` を日誌へ書き、未 push の観測を起こす（`#handleEvent` の `case` が `handle` を直に返す）。 */
  readonly #toolUse: ManagerToolUseReceiver;
  /** 担当の `parked_peers_closed` を、知らせか台帳の預けへ回す（`#handleEvent` の `case` が `handle` を直に返す）。 */
  readonly #parkedPeers: ManagerParkedPeersReceiver;
  readonly #waiting: ManagerWaitingReceiver;
  /** 自己失効の `closed` を受け、貸し出しを返して引き取りを挑み直す（`#closeWithoutTransition` が `closeSelfFenced` の Promise を直に返す）。 */
  readonly #selfFenced: ManagerSelfFencedReceiver;
  /** `closed` の前段のうち、`lost` 確定後の `closed` と重複 `closed(failed)` を日誌へ書いて像を畳む（`#closeWithoutTransition` が `Promise` を直に返す）。 */
  readonly #closedFront: ManagerClosedFrontReceiver;

  readonly #usageOrder = new UsageRecordOrder();

  /** 名乗っていない runner（旧 runner）は `stop()` が一切待たない。新しい器の `hello` が来たら消す（古い名乗りで新しい器を待たない）。 */
  readonly #farewellRunners = new Set<string>();

  constructor({
    stores,
    post,
    runners,
    profile,
    credentials,
    mcpServers,
    plugins,
    permissionRules,
    codexAuth,
    now,
    withheldReportFlushMs,
    tokenSavingExcerpt,
    synthesizedNoticeWindowMs,
    quotaStopWindowMs,
    resumeConfirmTimeoutMs,
    generateManagerId,
    tokenIdentity,
    tokenAvailability,
    onUsageObservation,
    syncRunnerToken,
    agentTokenPushes,
    onWorkerToolEvent,
    workspace,
    attachmentLimits,
  }: ManagerPoolOptions) {
    this.#attachmentLimits = attachmentLimits;
    this.#onWorkerToolEvent = onWorkerToolEvent;
    this.#stores = stores;
    this.#post = post;
    this.#runners = runners;
    this.#codexAuth = codexAuth;
    this.#now = now ?? (() => Date.now());
    this.#taskLink = new ManagerTaskLink({
      stores: () => this.#stores,
      journal: (entry) => this.#journal(entry),
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
    });
    this.#sessionLoaders = new SessionLoaders({
      stores,
      runners,
      journal: (entry) => this.#journal(entry),
      // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
      journalExchange: this.#journalExchange.bind(this),
      stopped: () => this.#stopped,
      sighting: (runnerId) => this.#sighting(runnerId),
      swapNote: (runnerId, before) => this.#swapNote(runnerId, before),
    });
    this.#withheld = new WithheldReportsStore({
      records: this.#records,
      persist: (record) => this.#persist(record),
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      tokenSavingExcerpt: () => this.#tokenSavingExcerpt,
      withheldReportFlushMs: () => this.#withheldReportFlushMs,
      emitFlush: (managerId, text) => {
        this.#emit(managerId, 'report', text, undefined, undefined, 'flush');
      },
    });
    this.#turnEndWatch = new TurnEndWatch({
      records: this.#records,
      withheldReports: this.#withheld.reports,
      stores,
      now: () => this.#now(),
      journal: (entry) => this.#journal(entry),
      emitReport: (managerId, text) => {
        this.#emit(managerId, 'report', text);
      },
      runnerOf: (record) => this.#runnerOf(record),
      runnerHasCapability: (runnerId, capability) => this.runnerHasCapability(runnerId, capability),
    });
    this.#autoFold = new AutoFold({
      runners,
      now: () => this.#now(),
      stopped: () => this.#stopped,
      retainedIds: () => [
        ...this.#usageStopped,
        ...this.#workerLimitStopped.keys(),
        ...this.#held.jobIds(),
      ],
      runnerHasCapability: (runnerId, capability) => this.runnerHasCapability(runnerId, capability),
      findJob: (managerId) => this.#findJob(managerId),
      runnerIdOf: (managerId) => this.runnerIdOf(managerId),
      list: () => this.list(),
      // 新しい定数を増やさず `UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS` を使い回す: `case 'report'` の観測と同じ理由で足りるため。
      observeUnpushedWork: (managerId) =>
        this.unpushedWork(managerId, {
          source: 'auto-fold',
          signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
        }),
      abort: (managerId, reason, by) => this.abort(managerId, reason, by),
      journal: (entry) => this.#journal(entry),
    });
    this.#denialRenotifier = new DenialRenotifier({
      records: this.#records,
      now: () => this.#now(),
      stopped: () => this.#stopped,
      emitReport: (managerId, text) => {
        this.#emit(managerId, 'report', text);
      },
      journalExchange: this.#journalExchange.bind(this),
    });
    this.#rescueSweeper = new RescueSweeper({
      records: this.#records,
      stores,
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      stopped: () => this.#stopped,
      journal: (entry) => this.#journal(entry),
      persist: (record) => this.#persist(record),
      runnerOf: (record) => this.#runnerOf(record),
      runnersOrEmpty: () => this.#runnersOrEmpty(),
    });
    this.#attachmentStager = new AttachmentStager({
      awaitHello: (runnerId) => this.#awaitHello(runnerId),
      hasCapability: (runnerId, capability) => this.runnerHasCapability(runnerId, capability),
      openAttachment: (id) => this.#stores.attachments.open(id),
    });
    this.#rescueStash = new ManagerRescueStash({
      stores,
      attachmentLimits,
      runnerOrNull: (runnerId) => this.#runnerOrNull(runnerId),
      runnerHasCapability: (runnerId, capability) => this.runnerHasCapability(runnerId, capability),
      instanceIdOf: (runnerId) => this.#sighting(runnerId).instanceId,
      swapNote: (runnerId, before) => this.#swapNote(runnerId, before),
      nowIso: () => this.#nowIso(),
      persist: (record) => this.#persist(record),
      journal: (entry) => this.#journal(entry),
      records: this.#records,
      load: (managerId) => this.#load(managerId),
      send: (managerId, text, options) => this.#send(managerId, text, options, { mode: 'caller' }),
    });
    this.#held = new HeldMessages({
      records: this.#records,
      load: (managerId) => this.#load(managerId),
      persist: (record) => this.#persist(record),
      journal: (entry) => this.#journal(entry),
      queueNotice: (managerId, label, text) => this.#queueSynthesizedNotice(managerId, label, text),
      send: (managerId, message, delivery) => this.#send(managerId, message, {}, delivery),
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      stopped: () => this.#stopped,
      usageStopped: this.#usageStopped,
      resuming: this.#resuming,
    });
    this.#pushLedger = new PushLedger({
      services: {
        profile,
        credentials,
        mcpServers,
        plugins,
        permissionRules,
        codexAuth,
        syncRunnerToken,
      },
      runners,
      journal: (entry) => this.#journal(entry),
      now: () => this.#now(),
      stopped: () => this.#stopped,
      pendingPush: (runnerId, runner) =>
        this.#reattachPushes.get(runnerId) ?? this.#connections.get(runner),
    });
    for (const [kind, source] of [
      ['permissionRules', permissionRules],
      ['profile', profile],
      ['mcpServers', mcpServers],
      ['credentials', credentials],
      ['plugins', plugins],
      ['agentToken', agentTokenPushes],
    ] as const) {
      const unsubscribe = source?.onPushed((results, scope?: { unnamed: true }) =>
        this.#pushLedger.recordDirectPushResults(
          kind,
          // 名指せなかった失敗は、この manager が知っている runner（帳面に載っている runner）全部の失敗として記録する。
          scope?.unnamed === true
            ? this.#pushLedger.knownRunnerIds().map((runnerId) => ({
                runnerId,
                ok: false,
                error: results[0]?.error,
              }))
            : results,
        ),
      );
      if (unsubscribe !== undefined) this.#unsubscribeDirectPushes.push(unsubscribe);
    }
    this.#withheldReportFlushMs = withheldReportFlushMs ?? resolveWithheldReportFlushMs();
    this.#tokenSavingExcerpt = tokenSavingExcerpt ?? resolveTokenSavingExcerpt();
    const quotaWindowMs = quotaStopWindowMs ?? QUOTA_STOP_WINDOW_MS;
    this.#quotaWindows = new QuotaStopWindows({
      records: this.#records,
      // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
      journalExchange: this.#journalExchange.bind(this),
      post: (event) => this.#post(event),
      listJobsOrNote: (skipped) => this.#listJobsOrNote(skipped),
      withheldCarriedToWindow: this.#withheld.carriedToWindow,
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      windowMs: quotaWindowMs,
    });
    this.#synthesized = new SynthesizedNoticeWindows({
      records: this.#records,
      tokenIdentities: this.#tokenIdentities,
      supersedePending: this.#supersedePending,
      quotaWindows: this.#quotaWindows,
      takeWithheldForDelivery: (managerId, text, withheldSuffixDetail) =>
        this.#withheld.takeForDelivery(managerId, text, withheldSuffixDetail),
      post: (event) => this.#post(event),
      statusAtDelivery: (managerId) => this.#statusAtDelivery(managerId),
      // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
      journalExchange: this.#journalExchange.bind(this),
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      windowMs: synthesizedNoticeWindowMs ?? resolveSynthesizedNoticeWindowMs(),
    });
    this.#restored = new RestoredWindows({
      records: this.#records,
      // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
      journalExchange: this.#journalExchange.bind(this),
      post: (event) => this.#post(event),
      postReport: (managerId, text, extra) => this.#postReport(managerId, text, extra),
      queueNotice: (managerId, label, text) => this.#queueSynthesizedNotice(managerId, label, text),
      notifyExcerptLines,
      listJobsOrNote: (skipped) => this.#listJobsOrNote(skipped),
      trackFlush: (flush) => this.#quotaWindows.trackFlush(flush),
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      stopped: () => this.#stopped,
      windowMs: quotaWindowMs,
      confirmTimeoutMs: resumeConfirmTimeoutMs ?? RESUME_CONFIRM_TIMEOUT_MS,
    });
    this.#resumeWindows = new ResumeEventWindows({
      records: this.#records,
      judgeSessionGeneration: (record, event) => this.#judgeSessionGeneration(record, event),
      trackedGenerationSilent,
      onEvent: (event, fromRunnerId) => this.#onEvent(event, fromRunnerId),
      droppedReportFiles: (event, fromRunnerId) => this.#droppedReportFiles(event, fromRunnerId),
      journal: (entry) => this.#journal(entry),
    });
    this.#generateManagerId = generateManagerId ?? (() => `mgr-${randomUUID()}`);
    this.#workspace = workspace ?? resolveWorkspacePolicy();
    this.#tokenIdentity = tokenIdentity;
    this.#usageWake = new UsageWake({
      records: this.#records,
      usageStopped: this.#usageStopped,
      usageWakeOwed: this.#usageWakeOwed,
      usageWakeRetry: this.#usageWakeRetry,
      usageNudgeInFlight: this.#usageNudgeInFlight,
      workerLimitStopped: this.#workerLimitStopped,
      workerLimitWakeRetry: this.#workerLimitWakeRetry,
      rotationFoldDueAt: this.#rotationFoldDueAt,
      resetTimeSkewMatches: this.#resetTimeSkewMatches,
      supersedePending: this.#supersedePending,
      tokenIdentities: this.#tokenIdentities,
      stores,
      now: () => this.#now(),
      stopped: () => this.#stopped,
      load: (managerId) => this.#load(managerId),
      findJob: (managerId) => this.#findJob(managerId),
      persist: (record) => this.#persist(record),
      journal: (entry) => this.#journal(entry),
      // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
      journalExchange: this.#journalExchange.bind(this),
      tokenIdentity: () => this.#tokenIdentity?.(),
      tokenAvailability:
        tokenAvailability === undefined ? undefined : (tokenId) => tokenAvailability(tokenId),
      send: (managerId, message, delivery) => this.#send(managerId, message, {}, delivery),
      queueSynthesizedNotice: (managerId, label, text) =>
        this.#queueSynthesizedNotice(managerId, label, text),
      observeForTokenRotation: (managerId, observation, heldFingerprint) =>
        this.#observeForTokenRotation(managerId, observation, heldFingerprint),
      sessionTokenFingerprintOf: (managerId) => this.#sessionTokenFingerprintOf(managerId),
      beforeWakes: (wakeIds) => this.#autoFold.beforeWakes(wakeIds),
      rateLimits: () => this.#usageReceiver.rateLimits,
    });
    this.#staleTokenFold = new StaleTokenFold({
      resumedCount: this.#resumedCount,
      rotationFoldDueAt: this.#rotationFoldDueAt,
      tokenIdentities: this.#tokenIdentities,
      tokenIdentity: () => this.#tokenIdentity?.(),
      tokenAvailability:
        tokenAvailability === undefined ? undefined : (tokenId) => tokenAvailability(tokenId),
      sessionTokenFingerprintOf: (managerId) => this.#sessionTokenFingerprintOf(managerId),
      observedTokenFingerprint: (runnerId, managerId) =>
        this.#observedSessionField('sessionTokenFingerprints', runnerId, managerId),
      journal: (entry) => this.#journal(entry),
      lastStaleDecline: (managerId) => this.#held.lastStaleDecline(managerId),
      rememberStaleDecline: (managerId, declineRecord) =>
        this.#held.rememberStaleDecline(managerId, declineRecord),
      unpushedWork: (managerId, options) => this.unpushedWork(managerId, options),
    });
    this.#usageReceiver = new UsageReceiver({
      stores: this.#stores,
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      tokenIdentities: this.#tokenIdentities,
      usageStopped: this.#usageStopped,
      journal: (entry) => this.#journal(entry),
      journalExchange: this.#journalExchange.bind(this),
      persist: (record) => this.#persist(record),
      movedAwayFrom: (record, fromRunnerId) => this.#movedAwayFrom(record, fromRunnerId),
      observeForTokenRotation: (managerId, observation) =>
        this.#observeForTokenRotation(managerId, observation),
      rememberResetTimeSkew: (event) => this.#usageWake.rememberResetTimeSkew(event),
      queueSynthesizedNotice: (managerId, label, text, quotaMark) =>
        this.#queueSynthesizedNotice(managerId, label, text, quotaMark),
    });
    this.#archiveReceiver = new ArchiveReceiver({
      stores: this.#stores,
      fetchArchiveRetrying: (managerId, archiveId, fromRunnerId) =>
        this.#sessionLoaders.fetchArchiveRetrying(managerId, archiveId, fromRunnerId),
      appendMirrorRetrying: (store, event) =>
        this.#sessionLoaders.appendMirrorRetrying(store, event),
      persist: (record) => this.#persist(record),
      journalExchange: this.#journalExchange.bind(this),
    });
    this.#denial = new ManagerDenialReceiver({
      nowIso: () => this.#nowIso(),
      journalExchange: this.#journalExchange.bind(this),
      emit: (managerId, kind, text) => this.#emit(managerId, kind, text),
    });
    this.#session = new ManagerSessionReceiver({
      nowIso: () => this.#nowIso(),
      journalExchange: this.#journalExchange.bind(this),
      persist: (record) => this.#persist(record),
      noteRunnerSessionSince: (record) => this.#noteRunnerSessionSince(record),
      rememberPluginLoad: (runnerId, observation) => {
        this.#pluginLoad.set(runnerId, observation);
      },
    });
    this.#toolUse = new ManagerToolUseReceiver({
      nowIso: () => this.#nowIso(),
      journal: (entry) => this.#journal(entry),
      observeUnpushedWorkOnce: (managerId, source) =>
        this.#observeUnpushedWorkOnce(managerId, source),
    });
    this.#parkedPeers = new ManagerParkedPeersReceiver({
      nowIso: () => this.#nowIso(),
      emit: (managerId, kind, text) => this.#emit(managerId, kind, text),
      persist: (record) => this.#persist(record),
    });
    this.#waiting = new ManagerWaitingReceiver({
      persist: (record) => this.#persist(record),
      journal: (entry) => this.#journal(entry),
      journalExchange: this.#journalExchange.bind(this),
      emit: (managerId, kind, text, requestId, markup) =>
        this.#emit(managerId, kind, text, requestId, markup),
      nowIso: () => this.#nowIso(),
    });
    this.#selfFenced = new ManagerSelfFencedReceiver({
      now: () => this.#now(),
      journalExchange: this.#journalExchange.bind(this),
      persist: (record) => this.#persist(record),
      emit: (managerId, kind, text) => this.#emit(managerId, kind, text),
      withdrawWaiting: (record, reason) => this.#withdrawWaiting(record, reason),
      scheduleReattach: (runnerId) => this.#scheduleReattach(runnerId),
    });
    this.#closedFront = new ManagerClosedFrontReceiver({
      nowIso: () => this.#nowIso(),
      journalExchange: this.#journalExchange.bind(this),
      persist: (record) => this.#persist(record),
      emit: (managerId, kind, text) => this.#emit(managerId, kind, text),
      retire: (managerId) => this.#retire(managerId),
    });
    this.#onUsageObservation = onUsageObservation;
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
    // 新しい委譲を起こす前に前任を確かめる: 断るなら、後継を起こさず台帳にも跡を残さない（#4861）
    if (input.supersedes === undefined) return this.#startAfterSupersedeCheck(input);
    // 確認で印を立てた start だけが下ろす: 断られた並行の start が先行の印を消すと、先行の引き継ぎ中に前任が起こされる（#4865）
    const token = await this.#assertSupersedable(input.supersedes);
    try {
      return await this.#startAfterSupersedeCheck(input);
    } finally {
      // 後継を立てられなかったときも下ろす: 印を残すと前任が永久に自動で起こされなくなるため（#4865）
      if (this.#supersedePending.get(input.supersedes) === token) {
        this.#supersedePending.delete(input.supersedes);
      }
    }
  }

  async #startAfterSupersedeCheck(input: ManagerStartInput): Promise<ManagerSummary> {
    const { runner, managerId, startAttachments } = await this.#prepareStart(input);
    const cwd = input.cwd ?? runner.workspacePath;
    const now = this.#now();
    const at = new Date(now).toISOString();
    // 前任が預かっていた未追跡のファイルがあれば、最初の依頼文の末尾に取り戻しの口を足す（台帳の `request` は元のまま）
    let startRequest = input.request;
    if (input.supersedes !== undefined) {
      startRequest = await this.#startRequestWithPredecessorNote(
        input.request,
        input.supersedes,
        runner.runnerId,
      );
    }

    const { record, lease } = this.#newStartRecord(input, runner, managerId, cwd, now, at);
    this.#records.set(managerId, record);
    this.#rememberTokenIdentity(managerId);

    let started: { cwd: string; sessionGeneration?: string };
    try {
      started = await runner.start({
        managerId,
        request: startRequest,
        cwd,
        lease: { fence: lease.fence, ttlMs: lease.ttlMs },
        ...(startAttachments.length === 0 ? {} : { attachments: startAttachments }),
      });
    } catch (error) {
      // 起こせなかったものを一覧に残さない: 「走っている」と見えて、誰も読まない相手へ指示を送り続けることになる。
      this.#records.delete(managerId);
      throw error;
    }
    const requestedCwd = this.#noteStarted(record, runner, started, cwd, lease);
    await this.#persist(record);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      managerId,
      text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] ${input.request}`,
      ...(startAttachments.length === 0 ? {} : { attachments: attachmentRefsOf(startAttachments) }),
    });
    if (input.supersedes !== undefined)
      await this.#handOverToSuccessor(input.supersedes, managerId);
    return this.#startedSummaryOf(record, requestedCwd);
  }

  /** 起こす前の支度（runner の選択・接続・添付の断り・cwd の確認・managerId の発行・大きいファイルの押し出し）。断るときは投げる。 */
  async #prepareStart(input: ManagerStartInput): Promise<{
    runner: RunnerClient;
    managerId: string;
    startAttachments: NonNullable<ManagerStartInput['attachments']>;
  }> {
    const runner = await this.#runners.select({
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId }),
    });
    // best-effort にしない: 受け口の開いていない runner でマネージャーが走り出し、報告も許可確認も誰にも届かない。
    await this.#connectTo(runner);
    const startAttachments = input.attachments ?? [];
    if (startAttachments.length > 0) {
      const refused = await this.#attachmentStager.refusal(runner, startAttachments, input.request);
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
    // 大きいファイルは、貸し出しの時刻（`now`）を取る前に別口へ押す（押す間に貸し出しの猶予を食わないため）。
    // 押せなければ起こさない（台帳にも跡を残さない）。
    if (startAttachments.some((item) => item.staged === true)) {
      const failed = await this.#attachmentStager.stage(runner, managerId, startAttachments);
      if (failed !== undefined) throw new ManagerAttachmentsRefusedError(failed);
    }
    return { runner, managerId, startAttachments };
  }

  /** 前任が預かっていた未追跡のファイルの取り戻しの口を、最初の依頼文の末尾へ足す（口が無ければ依頼文のまま返す）。 */
  async #startRequestWithPredecessorNote(
    request: string,
    supersedes: string,
    runnerId: string,
  ): Promise<string> {
    const predecessor = this.#records.get(supersedes)?.job ?? (await this.#latestJobOf(supersedes));
    const note = this.#rescueStash.note(predecessor?.rescueStash, runnerId, supersedes);
    return note === undefined ? request : `${request}\n\n[system] ${note}`;
  }

  /** 新しい委譲の貸し出しと台帳の行を組む（同期。`#records.set` は呼び元）。 */
  #newStartRecord(
    input: ManagerStartInput,
    runner: RunnerClient,
    managerId: string,
    cwd: string,
    now: number,
    at: string,
  ): { record: ManagerRecord; lease: ReturnType<typeof grantLease> } {
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
      ttlMs: LEASE_TTL_MS,
    });

    const record: ManagerRecord = {
      job: {
        id: managerId,
        managerId,
        createdAt: at,
        updatedAt: at,
        status: 'running',
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        summary: brief({ request: input.request }),
        request: input.request,
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
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
    return { record, lease };
  }

  /** runner が起こした結果を台帳の行へ写す（同期。頼んだ cwd と違ったときだけ、その頼んだ値を返す）。 */
  #noteStarted(
    record: ManagerRecord,
    runner: RunnerClient,
    started: { cwd: string; sessionGeneration?: string },
    cwd: string,
    lease: ReturnType<typeof grantLease>,
  ): string | undefined {
    this.#noteRunnerSessionSince(record);
    if (started.sessionGeneration !== undefined && started.sessionGeneration.length > 0) {
      record.sessionGeneration = started.sessionGeneration;
    }
    // runner が実際に開いた作業場（`started.cwd`）は必ず返る。頼んだ値と違えば、台帳を実際の値へ書き換える。
    let requestedCwd: string | undefined;
    if (started.cwd !== cwd) {
      requestedCwd = cwd;
      record.job.cwd = started.cwd;
      record.job.workspace = workspaceLocatorFrom(this.#workspace, runner.runnerId, started.cwd);
    }
    // 名簿を引き直さず、この回に貸し出しを立てた相手を写す。`undefined` で上書きしない: 一度名乗った器の値まで消えて以後判定できなくなる。
    if (lease.instanceId !== undefined) record.job.sessionInstanceId = lease.instanceId;
    return requestedCwd;
  }

  /** 起こした直後の要約を組む（同期。`cwdConfirmed` / `requestedCwd` を足す）。 */
  #startedSummaryOf(record: ManagerRecord, requestedCwd: string | undefined): ManagerSummary {
    const silent = this.#silentRunners();
    const summary = this.#summaryOfRecord(record, {
      silent,
      registeredRunnerIds: this.#registeredRunnerIds(),
      activeTokenGeneration: this.#tokenIdentity?.()?.generation,
      tokenGenerationPoolWired: this.#tokenIdentity !== undefined,
      runnerListedAt: runnerListedAtOf(record.job, silent, this.#runnerSessions()),
    });
    // `summaryOf` へは混ぜない: `cwdConfirmed` / `requestedCwd` は起こした回にしか意味が無く、
    // 引数を増やすと他の全呼び出し元が「該当なし」を渡す羽目になる。
    return {
      ...summary,
      cwdConfirmed: true,
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
    const result = await this.#send(managerId, message, options, { mode: 'caller' });
    // 送ることは止めず、送った側へ注意だけを足す（#4877）: 前任を手で起こすのはクローンの選択でありうるが、黙って起こすと後継と二重に走るため。内部の送り（鍵の回転・預かりの届け直し）は `#send` を直に呼ぶので足さない
    const successor = this.#records.get(managerId)?.job.supersededBy;
    if (
      successor === undefined ||
      result.outcome === 'unknown' ||
      result.outcome === 'unreadable'
    ) {
      return result;
    }
    return {
      ...result,
      detail:
        `${result.detail}\n⚠ ${managerId} は後継 ${successor} へ引き継いである前任である。` +
        '前任が起きると、後継と同じ仕事を二重に進めうる。続きを頼むなら、普通は後継へ送ること。',
    };
  }

  /** 届け方（`mode` ほか）は `SendDelivery`。 */
  async #send(
    managerId: string,
    message: string,
    options: ManagerSendOptions,
    delivery: SendDelivery,
  ): Promise<ManagerSendResult> {
    const { mode } = delivery;
    const target = await this.#resolveSendTarget(managerId);
    if ('outcome' in target) return target;
    const { record, runner } = target;

    const { decision, requestId } = options;
    const pending = this.#choosePending(record, requestId, decision);
    if (typeof pending === 'string') {
      return this.#refuseUnclearPending(record, managerId, requestId, pending);
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
      const refusedAttachments = await this.#refuseOrStageAttachments(
        runner,
        managerId,
        message,
        sendAttachments,
      );
      if (refusedAttachments !== undefined) return refusedAttachments;
    }

    if (pending) {
      return await this.#answerPending(
        record,
        runner,
        managerId,
        message,
        options,
        decision,
        pending,
      );
    }

    // 預かりがある間に来た伝言は列の後ろへ積み、まとめて届けを試す: 先に届けると、預かった伝言を追い越すため。
    // 添付付きは預からない（中身を台帳に載せない）ので、ここでは並ばずに下の経路で扱う。
    const holdable = mode === 'caller' && sendAttachments.length === 0;
    if (holdable && (record.job.heldMessages?.length ?? 0) > 0) {
      return await this.#queueBehindHeld(record, managerId, message);
    }

    // 認証トークンの世代が食い違った done の委譲は旧セッションへ流さない: 旧プロセスの env は起動時に凍っていて、
    // 鍵が回った後も古い鍵で走り、また枠に当たる。
    let fingerprintMatched = false;
    let staleDelivery: { generation: number; blockers: string[] } | undefined;
    // 届ける前に取る: 届いた直後に来た report を「ターンの前」と読まないため
    const turnStartedAt = this.#nowIso();
    if (record.job.status === 'done') {
      const folded = await this.#foldStaleTokenBeforeDelivery(
        record,
        runner,
        managerId,
        message,
        delivery,
        holdable,
      );
      if ('outcome' in folded) return folded;
      fingerprintMatched = folded.fingerprintMatched;
      staleDelivery = folded.staleDelivery;
    }
    const { outgoing, foldedFoldNotice, foldedPeerCloseNotice } = this.#composeOutgoing(
      record,
      message,
    );

    // `attached` を信じ切らない: イベント駆動でしか更新されず、`closed` / resume 失敗の合図が届かなかった窓では
    // `true` のまま嘘になる。404 を例外のまま `send()` から貫通させると、どの `outcome` にもならず人間は 500 を受け取る。
    let attached = record.attached;
    let reentered = false;
    // 渡しに行く前に印を進める（預かりの届け直し `HeldMessages#deliver` もここを通る）: 自動の畳みが、渡した一言ごと担当を止めないため。
    this.#inputMarks.set(managerId, (this.#inputMarks.get(managerId) ?? 0) + 1);
    if (attached) {
      const missing = await this.#deliverToAttachedSession(
        record,
        runner,
        managerId,
        outgoing,
        sendAttachments,
      );
      if (missing) attached = false;
    }

    // 直前に 404 で訂正した相手も同じここを通す: 別経路を作ると、同じ session を二本起こさないための歯止めが片方にだけ効く。
    if (!attached) {
      const reentry = await this.#reenterByResume(
        record,
        runner,
        managerId,
        outgoing,
        sendAttachments,
        fingerprintMatched,
      );
      if ('outcome' in reentry) return reentry;
      reentered = reentry.reentered;
    }

    /*
     * 台帳へ `running` を書く直前にもう一度 `stopConfirmedAt` を見る: `#resume` の2つのチェックポイントを通った後でも、
     * `send()` へ戻るまでの `await` の間に `abort()` が印を立てうる。畳み直しは `abort()` と同じ
     * `#confirmStoppedAndReleaseLease` を使う。
     */
    if (record.stopConfirmedAt !== undefined) {
      return await this.#settleStoppedMeanwhile(record, runner, managerId);
    }

    return await this.#recordDelivery(
      record,
      managerId,
      outgoing,
      sendAttachments,
      turnStartedAt,
      foldedFoldNotice,
      foldedPeerCloseNotice,
      delivery,
      staleDelivery,
      reentered,
      attached,
    );
  }

  /** 段A（入口）: 接続を確かめ、台帳の像と宛先の runner を引く。引けなければ断りの結果を返す。 */
  async #resolveSendTarget(
    managerId: string,
  ): Promise<{ record: ManagerRecord; runner: RunnerClient } | ManagerSendResult> {
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

    return { record, runner };
  }

  /** 段B（確認の選び方）: 宛先を選べなかった（あいまい・無い・知らせ直し直後）ときの断りを返す。同期。 */
  #refuseUnclearPending(
    record: ManagerRecord,
    managerId: string,
    requestId: string | undefined,
    pending: 'ambiguous' | 'gone' | 'renotify-pending',
  ): ManagerSendResult {
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
    return assertNever('未知の確認の選び方（send）', pending);
  }

  /** 段C（添付）: 追加指示に付いた添付を検め、大きいファイルを別口へ押す。断るなら結果を返し、通れば `undefined`。 */
  async #refuseOrStageAttachments(
    runner: RunnerClient,
    managerId: string,
    message: string,
    sendAttachments: RunnerAttachment[],
  ): Promise<ManagerSendResult | undefined> {
    const refused = await this.#attachmentStager.refusal(runner, sendAttachments, message);
    if (refused !== undefined)
      return { outcome: 'unknown', detail: `${refused}（何も送っていない）` };
    // 大きいファイルは、命令（`send` でも resume でも）を出す前に別口へ押す。押せなければ命令を送らない。
    const stageFailed = await this.#attachmentStager.stage(runner, managerId, sendAttachments);
    if (stageFailed !== undefined)
      return { outcome: 'unknown', detail: `${stageFailed}（何も送っていない）` };
    return undefined;
  }

  /** 段D（答え）: 止まっている確認へ回答を届け、日誌へ残す。 */
  async #answerPending(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
    message: string,
    options: ManagerSendOptions,
    decision: ManagerDecision | undefined,
    pending: { requestId: string; summary: string },
  ): Promise<ManagerSendResult> {
    // 答える前に呼ぶ: 答えが届いた後に日誌が書けない窓を作らないため（投げたら答えない）
    await options.beforeAnswer?.({ requestId: pending.requestId, summary: pending.summary });
    const answered = await runner.answer(managerId, {
      requestId: pending.requestId,
      message,
      ...(decision === undefined ? {} : { decision }),
    });
    if (!answered.delivered) {
      // runner がもう持っていない確認は台帳の待ちからも外す（#4775）: 残すと、requestId を付けない次の答えも同じ古い確認を選び、届かないまま担当が waiting_human に残るため
      const dropped = this.#dropUndeliveredWaiting(record, pending.requestId);
      if (dropped) await this.#persist(record);
      return {
        outcome: 'unknown',
        detail:
          `${pending.requestId} は runner 側で既に解けている。` +
          (dropped
            ? '台帳の待ちからも外した（次の送信はこの確認への答えとしては扱われない）。'
            : ''),
      };
    }
    await this.#journal({
      type: 'escalation',
      question: pending.summary,
      approvalId: pending.requestId,
      managerId,
      answeredAt: this.#nowIso(),
      /*
       * runner.ts が確定した decision をそのまま書く。`decision` や `inferDecision(message)` を
       * ここで計算し直さない: runner.ts 側が変わったときに黙ってずれる。
       * `answered.decision` が無い回（届いたのに `decision` を名乗らない応答。runner は届いた回に必ず付ける）は `allow`/`deny` へ倒さず `[unknown]` で区別する。
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

  /** 段E（預かりの列）: 預かりがある間に来た伝言を列の後ろへ積み、まとめて届けを試す。 */
  async #queueBehindHeld(
    record: ManagerRecord,
    managerId: string,
    message: string,
  ): Promise<ManagerSendResult> {
    const queued = await this.#held.hold(record, message, '先に預かった伝言がまだ届いていない');
    if (queued.outcome !== 'held') return queued;
    const attempt = await this.#held.deliver(managerId, 'caller');
    return attempt ?? queued;
  }

  /** 段F（古い鍵の畳み）: done の委譲を畳めるか確かめる。断る・預かるなら結果を返し、進めるなら畳み込みの材料を返す。 */
  async #foldStaleTokenBeforeDelivery(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
    message: string,
    delivery: SendDelivery,
    holdable: boolean,
  ): Promise<
    | ManagerSendResult
    | {
        fingerprintMatched: boolean;
        staleDelivery: { generation: number; blockers: string[] } | undefined;
      }
  > {
    const { mode, pollRetry = false, onStuck } = delivery;
    const oldestHeldAt = record.job.heldMessages?.[0]?.heldAt;
    // 待ちの数え始めは、いちばん古い預かりと、背景処理待ちに入った時刻の早いほう（#5041）: 担当は預かりより前から古い鍵のまま
    // 背景処理を待っていて、話しかけたい伝言が届いた時点で、もう止まっている時間を数えるため（預かりだけから数えると、LAND-9 は8分で畳まれなかった）。
    // 畳むのは今どおり `StaleTokenFold` が「鍵が現役と食い違い、その鍵が ready でない」と判定した回だけ
    // （ready なら旧セッションへ届ける）。人が走らせる長い仕事を、鍵が使える間に奪わない。
    const awaitingSince = this.#withheld.awaitingBackgroundOf(managerId)?.since;
    const waitStartedAt = earliestMs([oldestHeldAt, awaitingSince]);
    const waitedLongEnough =
      mode === 'held-delivery' &&
      oldestHeldAt !== undefined &&
      waitStartedAt !== undefined &&
      this.#now() - waitStartedAt >= HELD_FORCE_FOLD_AFTER_MS;
    // 鍵の回転の起こし直しの待ちの数え始め（#5044）: 枠で止まった時刻と、背景処理待ちに入った時刻の早いほう。
    // どちらも分からなければ待たない（#4850 の今まで）: 数え始めの無い待ちは、上限が来ないまま古い鍵で居座るため
    const rotationWaitStartedAt =
      mode === 'usage-rotation'
        ? earliestMs([
            // 台帳の値を素通しにしない（`ManagerSummary.usageStoppedAt` の doc）: 印が真の参照のため
            this.#usageStopped.has(managerId) ? record.job.usageStoppedAt : undefined,
            awaitingSince,
          ])
        : undefined;
    const rotationFoldDueAt =
      rotationWaitStartedAt === undefined
        ? undefined
        : rotationWaitStartedAt + HELD_FORCE_FOLD_AFTER_MS;
    const folded = await this.#staleTokenFold.fold(record, runner, managerId, {
      foldBackgroundAfterWait: waitedLongEnough,
      foldBackgroundIfHeldTokenNotReady: mode === 'usage-rotation',
      ...(rotationFoldDueAt === undefined || this.#now() >= rotationFoldDueAt
        ? {}
        : { rotationFoldDueAt }),
      skipUnchangedDeclineRecord: mode === 'held-delivery' && pollRetry,
    });
    if (folded.declined !== undefined) {
      if (waitedLongEnough && folded.stuck !== undefined) onStuck?.(folded.stuck);
      // 断った本文を捨てない: 呼び手が台帳で追って送り直すしかなく、追い損ねた伝言は誰にも届かないまま消えるため。
      if (holdable) {
        // 畳めない理由が背景処理だけなら、待ちの上限で畳んで届ける。その時刻を返事で言う: 言わないと、呼び手はいつ届くか分からず、
        // 背景処理ごと捨てる manager_stop → manager_start を選ぶ（2026-10-19 に4回。どれも上限の前に手で止めた）
        const backgroundOnly =
          folded.stuck !== undefined &&
          folded.stuck.blockers.length === 1 &&
          (folded.stuck.backgroundTasks ?? 0) > 0;
        const foldDueAt = backgroundOnly
          ? this.#held.foldDueAt(oldestHeldAt, awaitingSince)
          : undefined;
        return await this.#held.hold(
          record,
          message,
          folded.declinedReason ?? folded.declined.detail,
          foldDueAt,
        );
      }
      return folded.declined;
    }
    const fingerprintMatched = folded.fingerprintMatched === true;
    const staleDelivery = folded.staleDelivery;
    if (folded.foldedBackground !== undefined || folded.foldedPeers !== undefined) {
      // 畳んだ事実は届くまで台帳に残す: この後の resume が失敗して預かりのまま再試行になると、旧セッションはもう無く、畳んだと知る手が無くなるため。
      const peers = (folded.foldedPeers ?? 0) + (record.job.pendingFoldNotice?.peers ?? 0);
      record.job.pendingFoldNotice = {
        backgroundTasks:
          (folded.foldedBackground ?? 0) + (record.job.pendingFoldNotice?.backgroundTasks ?? 0),
        ...(peers === 0 ? {} : { peers }),
        ...(folded.foldedBackgroundCommands === undefined &&
        record.job.pendingFoldNotice?.commands === undefined
          ? {}
          : {
              commands: [
                ...(record.job.pendingFoldNotice?.commands ?? []),
                ...(folded.foldedBackgroundCommands ?? []),
              ].slice(0, FOLD_NOTICE_COMMANDS_MAX),
            }),
        at: this.#nowIso(),
      };
      // 書けなくても進む: 背景処理は殺してあり、この回に届けば断り書きは付く（失うのは再起動を跨ぐ分だけ）。
      await this.#persist(record).catch(() => undefined);
    }
    return { fingerprintMatched, staleDelivery };
  }

  /** 段F2（本文の組み立て）: 畳み込んだ分の写しを取り、断り書きを前に付けた本文を作る。同期。 */
  #composeOutgoing(record: ManagerRecord, message: string) {
    let outgoing = message;
    // 畳み込んだ分の写しを取っておく（#4899）: 配達の途中の長い await の間に積まれた知らせまで下ろさないため
    const foldedFoldNotice =
      record.job.pendingFoldNotice === undefined
        ? undefined
        : structuredClone(record.job.pendingFoldNotice);
    const foldedPeerCloseNotice =
      record.job.pendingPeerCloseNotice === undefined
        ? undefined
        : structuredClone(record.job.pendingPeerCloseNotice);
    if (foldedFoldNotice !== undefined) {
      outgoing = composeFoldNotice(foldedFoldNotice) + '\n\n' + message;
    }
    if (foldedPeerCloseNotice !== undefined) {
      outgoing = composePeerCloseNotices(foldedPeerCloseNotice) + '\n\n' + outgoing;
    }
    return { outgoing, foldedFoldNotice, foldedPeerCloseNotice };
  }

  /** 段G（渡す）: 生きているセッションへ送り、runner が「持っていない」と答えたら台帳へそう書く。持っていなければ true。 */
  async #deliverToAttachedSession(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
    outgoing: string,
    sendAttachments: RunnerAttachment[],
  ): Promise<boolean> {
    const missing = await this.#sendDetectingMissingSession(
      runner,
      managerId,
      outgoing,
      sendAttachments,
    );
    if (missing) {
      record.attached = false;
      record.sessionMissingSince ??= this.#nowIso();
      // 由来は上書きする（生存確認が先に置いた `unlisted` より強い観測）が、時刻は `??=` のまま: 最初に気づいた時刻を動かさない。
      record.sessionMissingKind = 'resume-failed';
      await this.#persist(record);
    }
    return missing;
  }

  /** 段H（起こし直し）: セッションの無い委譲を resume から入り直す。断るなら結果を返し、入れたら入り直したかを返す。 */
  async #reenterByResume(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
    outgoing: string,
    sendAttachments: RunnerAttachment[],
    fingerprintMatched: boolean,
  ): Promise<ManagerSendResult | { reentered: boolean }> {
    let reentered = false;
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
            this.#rescueStash.note(record.job.rescueStash, runner.runnerId),
          )}\n\n${outgoing}`
        : outgoing,
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
       * `session_missing` を `'unknown'` へ畳まない（`ManagerSendResult` の doc の表）: 畳むと daemon の `app-routes-managers.ts` が 404 を返し、
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
    return { reentered };
  }

  /** 段I（停止の確かめ）: 送っている間に止められていた委譲を畳み直し、`session_missing` を返す。 */
  async #settleStoppedMeanwhile(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
  ): Promise<ManagerSendResult> {
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

  /** 段J（書いて返す）: 台帳へ届いたことを書き、日誌へ残して `delivered` を返す。 */
  async #recordDelivery(
    record: ManagerRecord,
    managerId: string,
    outgoing: string,
    sendAttachments: RunnerAttachment[],
    turnStartedAt: string,
    foldedFoldNotice: Job['pendingFoldNotice'],
    foldedPeerCloseNotice: Job['pendingPeerCloseNotice'],
    delivery: SendDelivery,
    staleDelivery: { generation: number; blockers: string[] } | undefined,
    reentered: boolean,
    attached: boolean,
  ): Promise<ManagerSendResult> {
    const { onFoldNoticeDelivered } = delivery;
    // 応答より先に届いた確認（`waiting`）があれば `waiting_human` を保つ: `running` で上書きすると一覧が確認待ちに見えず、`waiting_human` を前提にした処理が外れる。
    record.job.status = record.waiting.length > 0 ? 'waiting_human' : 'running';
    record.job.turnStartedAt = laterIso(record.job.turnStartedAt, turnStartedAt);
    // 断り書きは実際に届いた回で下ろす（1回だけ付く）
    // 畳み込んだ分だけ下ろし、送信の途中で積まれた分は次の起こし直しに残す（#4899）
    record.job.pendingFoldNotice = remainingFoldNotice(
      record.job.pendingFoldNotice,
      foldedFoldNotice,
    );
    record.job.pendingPeerCloseNotice = remainingPeerCloseNotice(
      record.job.pendingPeerCloseNotice,
      foldedPeerCloseNotice,
    );
    await this.#persist(record);
    if (foldedFoldNotice !== undefined) onFoldNoticeDelivered?.(foldedFoldNotice.backgroundTasks);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      managerId,
      text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] ${outgoing}`,
      // 中身は日誌へ書かない（参照のメタデータだけ）。
      ...(sendAttachments.length === 0 ? {} : { attachments: attachmentRefsOf(sendAttachments) }),
    });
    return {
      outcome: 'delivered',
      // 台帳を直したことは黙らず呼び手へ言う: 届き方が違うと、続けて送る側は器が入れ替わった後の文脈で走っていると知る必要がある。
      detail: this.#deliveredDetail(managerId, staleDelivery, reentered, attached),
    };
  }

  /** 段Jの detail: 届き方（古い鍵のまま・生きた旧プロセス・入り直し）を言い分ける。同期。 */
  #deliveredDetail(
    managerId: string,
    staleDelivery: { generation: number; blockers: string[] } | undefined,
    reentered: boolean,
    attached: boolean,
  ): string {
    return (
      // 畳めない理由が残るので古い鍵のまま届けた回は、それを黙らない（鍵がいま使えると確かめたうえでの判断）。
      staleDelivery !== undefined && !reentered
        ? `追加指示として届けた（古い鍵（世代 ${String(staleDelivery.generation)}）のまま旧セッションへ届けた。` +
            `畳めない理由（${staleDelivery.blockers.join('。')}）が残っているため、新しい鍵で起こし直していない。` +
            'その鍵はいま使える状態（ready）だった）。'
        : // 短絡した回は、新しい SDK を起こしておらず旧プロセス（起動時の鍵が凍っている）へ届いたと言う。
          !attached && this.#resumedIntoLiveProcess.has(managerId)
          ? '追加指示として届けた（生きた旧プロセスへ流した。新しい SDK は起こしていない。' +
            'その鍵が現役かどうかは確かめていないので、この委譲の認証トークンの世代は「分からない」のままにしてある）。'
          : reentered
            ? '追加指示として届けた（runner にこの委譲のセッションが無かったので、resume から入り直した）。'
            : '追加指示として届けた。'
    );
  }

  deliverHeldMessages(): Promise<void> {
    return this.#held.deliverAll();
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

  // 名簿の読み取り（`runner-roster.ts`）: runner は叩かず、名簿に既に立っている観測を同期に読むだけ（往復を払うのは heartbeat の側）。
  #silentRunners(): ReadonlyMap<string, string> {
    return silentRunnersOf(this.#runners.entries());
  }

  #registeredRunnerIds(): ReadonlySet<string> | null {
    return registeredRunnerIdsOf(this.#runners.entries());
  }

  #runnerSessions(): ReadonlyMap<string, { ids: ReadonlySet<string>; observedAt: string }> {
    return runnerSessionsOf(this.#runners.entries());
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
      if (!isManagerInFlight(status)) continue;
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

  /**
   * 名簿の最後の観測を読むだけで往復しない。聞けていない・欄を返さない runner・キーが無い委譲のときは `undefined`（「分からない」。0 ではない）。
   * `field` は `RunnerEntry` の観測の欄（委譲ごとのキーを持つ記録）の名前。
   */
  #observedSessionField<
    K extends
      | 'sessionBackgroundTasks'
      | 'sessionClassifierDenials'
      | 'sessionPeerApprovals'
      | 'sessionTokenFingerprints',
  >(
    field: K,
    runnerId: string | undefined,
    managerId: string,
  ): NonNullable<RunnerEntry[K]>[string] | undefined {
    if (runnerId === undefined) return undefined;
    for (const entry of this.#runners.entries()) {
      if (entry.runnerId !== runnerId) continue;
      const observed = entry[field] as Readonly<Record<string, unknown>> | undefined;
      if (observed !== undefined && Object.hasOwn(observed, managerId)) {
        return observed[managerId] as NonNullable<RunnerEntry[K]>[string];
      }
    }
    return undefined;
  }

  /**
   * セッションの env に入っている鍵の指紋。生存確認の観測（10秒ごとの `/managers`）を先に見て、無ければ引き取りの時に runner の一覧が名乗った値を使う。
   * 引き取りの直後は生存確認の観測がまだ無いことがあり、そこで枠の通知が来ると指紋を添えられないため。
   */
  #sessionTokenFingerprintOf(managerId: string): string | undefined {
    const record = this.#records.get(managerId);
    if (record === undefined) return undefined;
    return (
      this.#observedSessionField('sessionTokenFingerprints', record.job.runnerId, managerId) ??
      record.tokenFingerprintAtReattach
    );
  }

  // 名簿・現役の世代は1回だけ引いて使い回す: 一覧を作っている間に動いても、同じ応答の中では全件を同じ像で比べる
  // （1本ずつ `this.#tokenIdentity?.()` を呼び直すと、回転が割り込んだとき一部だけ新しい現役と比べることになる）。
  // `list()` と `get()` が同じ組み立てを使う（#5089）: 口ごとに組むと、一覧と詳細で同じ委譲の状態が食い違うため
  #summaryContext(): SummaryContext {
    this.#noteMissingSessions();
    return {
      silent: this.#silentRunners(),
      runnerSessions: this.#runnerSessions(),
      // 一覧を作っている間に名簿が動いても、同じ応答の中では全件を同じ像で比べる: 1回だけ引き、呼び出しごとに読み直さない。
      registeredRunnerIds: this.#registeredRunnerIds(),
      activeTokenGeneration: this.#tokenIdentity?.()?.generation,
      tokenGenerationPoolWired: this.#tokenIdentity !== undefined,
    };
  }

  #summarize(record: ManagerRecord, context: SummaryContext): ManagerSummary {
    const { silent, runnerSessions, registeredRunnerIds } = context;
    return this.#summaryOfRecord(record, {
      silent,
      registeredRunnerIds,
      activeTokenGeneration: context.activeTokenGeneration,
      tokenGenerationPoolWired: context.tokenGenerationPoolWired,
      runnerListedAt: runnerListedAtOf(record.job, silent, runnerSessions),
    });
  }

  /**
   * 委譲の要約を組む（起こした直後・一覧と詳細・起動時の引き取りの3つの口が使う）。口ごとに違う材料（名簿の像・現役の鍵の世代・`runnerListedAt`）は
   * `view` で受け、残りの材料（背景処理・この委譲の鍵の世代・`#usageStopped` の門など）はここで読む: 口ごとに同じ材料を並べ直す写しを作らないため。
   */
  #summaryOfRecord(
    record: ManagerRecord,
    view: {
      readonly silent: ReadonlyMap<string, string>;
      readonly registeredRunnerIds: ReadonlySet<string> | null;
      readonly activeTokenGeneration: number | undefined;
      readonly tokenGenerationPoolWired: boolean;
      readonly runnerListedAt: string | undefined;
    },
  ): ManagerSummary {
    const job = record.job;
    return summaryOf(record, {
      live: isLive(record, view.silent),
      runnerLostSince: lostSinceOf(record, view.silent),
      runnerVanished: vanishedOf(record, view.registeredRunnerIds),
      runnerListedAt: view.runnerListedAt,
      awaitingBackground: this.#withheld.awaitingBackgroundOf(job.id),
      tokenGeneration: this.#tokenIdentities.get(job.id)?.generation,
      activeTokenGeneration: view.activeTokenGeneration,
      tokenGenerationPoolWired: view.tokenGenerationPoolWired,
      resetTimeSkewMatch: this.#resetTimeSkewMatches.get(job.id),
      // `record.job.usageStoppedAt` を直接渡さない: `ManagerSummary.usageStoppedAt` の doc のとおり門を通す。
      usageStoppedAt: this.#usageStopped.has(job.id) ? job.usageStoppedAt : undefined,
    });
  }

  // 聞けていない委譲には欄を作らない（0 を捏造しない）。走行中の像（`#records`）に在る委譲だけに添える
  #withObserved(record: ManagerRecord, summary: ManagerSummary): ManagerSummary {
    let result = summary;
    const tasks = this.#observedSessionField(
      'sessionBackgroundTasks',
      record.job.runnerId,
      record.job.id,
    );
    if (tasks !== undefined) result = { ...result, liveBackgroundTasks: tasks };
    const denials = this.#observedSessionField(
      'sessionClassifierDenials',
      record.job.runnerId,
      record.job.id,
    );
    if (denials !== undefined) result = { ...result, classifierDenials: denials };
    const peerApprovals = this.#observedSessionField(
      'sessionPeerApprovals',
      record.job.runnerId,
      record.job.id,
    );
    if (peerApprovals !== undefined) {
      result = { ...result, pendingPeerApprovals: { ...peerApprovals } };
    }
    return result;
  }

  // 1件のために台帳を全部読まない（#5089）。走行中の像に在ればそれを、無ければ台帳の1行だけを読む（`list()` と同じ優先）。
  // 読めない行は `UnreadableJobError` を投げ直す（`JobStore.getJob` の doc）
  async get(managerId: string): Promise<ManagerSummary | undefined> {
    await this.#ensureConnected();
    const context = this.#summaryContext();
    const record = this.#records.get(managerId);
    if (record !== undefined) return this.#withObserved(record, this.#summarize(record, context));
    const job = await this.#stores.jobs.getJob(managerId);
    if (job === null) return undefined;
    return this.#summarize({ job, waiting: [], attached: false }, context);
  }

  async list(): Promise<ManagerSummary[]> {
    await this.#ensureConnected();

    const context = this.#summaryContext();
    const { registeredRunnerIds } = context;
    const known = new Map<string, ManagerSummary>();
    for (const record of this.#records.values()) {
      known.set(record.job.id, this.#summarize(record, context));
    }
    // `live: false` を決め打ちしない: `#retire` が `#records` から外した後の「台帳にしか無い」は
    // 「runner に宛先が無い」とは限らず、決め打つと外した瞬間に `live: true` だった委譲が `false` へ化ける。
    for (const job of await this.#stores.jobs.listJobs()) {
      if (known.has(job.id)) continue;
      known.set(job.id, this.#summarize({ job, waiting: [], attached: false }, context));
    }
    for (const record of this.#records.values()) {
      const summary = known.get(record.job.id);
      if (summary !== undefined) known.set(record.job.id, this.#withObserved(record, summary));
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
        void this.#journalExchange(
          'inbound',
          `${EXCHANGE_KIND_GAUGE_PREFIX}${describeVanishedRunnerBacklogLine(runnerId, entry, this.#now())}`,
        );
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
    return this.#pushLedger.healthOf(runnerId);
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
        ...definedProps({
          awaitingBackground: manager.awaitingBackground,
          tokenGeneration: manager.tokenGeneration,
          activeTokenGeneration: manager.activeTokenGeneration,
          tokenGenerationUnknownReason: manager.tokenGenerationUnknownReason,
        }),
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
        ? new Map((await this.#runnersOrEmpty()).map((runner) => [runner.runnerId, runner]))
        : undefined;

    const placed = await Promise.all(
      entries.map(async (entry) => {
        const client = entry.runnerId === undefined ? undefined : open?.get(entry.runnerId);
        const pushHealth =
          entry.runnerId === undefined ? undefined : this.#pushLedger.healthOf(entry.runnerId);
        // `probe` を必ず併せて返す: 「頼まれていない」「聞けなかった」「聞いたが失敗した」を同じ `undefined` に潰さない。
        const [credentialsProbed, profileProbed, mcpServersProbed] = await Promise.all([
          probeRunnerFingerprint(client, options.fingerprints, (c) => c.credentials()),
          probeRunnerFingerprint(client, options.fingerprints, (c) => c.profile()),
          probeRunnerFingerprint(client, options.fingerprints, (c) => c.mcpServers()),
        ]);
        const credentials = credentialsProbed.value;
        const profile = profileProbed.value;
        const mcpServers = mcpServersProbed.value;
        // 訊けなかった理由は `resourcesProbe` が持つ（失敗・「繋がっていない」を `undefined` に潰さない）。
        // `asked` で `value` が `undefined` のままでも、応答が資源を名乗らなかっただけで失敗ではない。
        const resourcesProbed = await probeRunnerFingerprint(client, options.resources, (c) =>
          c.resources(),
        );
        // `null` を返す偽物も `undefined` にそろえる（「資源を名乗らなかった」を1つの形にする）
        const resources = resourcesProbed.value ?? undefined;

        // `pendingEvents` が `undefined`（古い runner・応答の形が壊れていた）のときは書かない: 0 で埋めない。
        if (entry.runnerId !== undefined && resources?.pendingEvents !== undefined) {
          this.#runnerBacklog.set(entry.runnerId, {
            runnerId: entry.runnerId,
            pendingEvents: resources.pendingEvents,
            ...(resources.oldestPendingAt === undefined
              ? {}
              : { oldestPendingAt: resources.oldestPendingAt }),
            observedAt: this.#nowIso(),
            // `resources()` は instanceId を運ばないので、名簿がいま知っている値を観測時点のものとして凍結する。
            ...(entry.instanceId === undefined
              ? {}
              : { instanceIdAtObservation: entry.instanceId }),
          });
        }

        const pidsSaturation =
          entry.runnerId === undefined
            ? undefined
            : this.#runners.pidsSaturationOf(entry.runnerId, resources?.pids);

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
            ? await this.#autoFold.foldIdleOnRunnerIfUnderPressure(
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

  autoFoldOnPlacementPressure(
    runnerId: string,
    pids: { readonly current: number; readonly max: number },
  ): void {
    this.#autoFold.onPlacementPressure(runnerId, pids);
  }

  autoFoldUnderPressure(): Promise<void> {
    return this.#autoFold.underPressure();
  }

  async repairStrandedTasks(): Promise<void> {
    if (this.#stopped) return;
    await this.#taskLink.repairStranded();
  }

  runnerPidsSaturation(runnerId: string): PidsSaturation | undefined {
    return this.#runners.pidsSaturationOf(runnerId);
  }

  async runnerIdOf(managerId: string): Promise<string | undefined> {
    const record = this.#records.get(managerId);
    // 像が `runnerId` を持たなくても、それが正しい「いまの」値なので台帳へ降りて上書きしない。
    if (record !== undefined) return record.job.runnerId;
    const job = await this.#findJob(managerId);
    return job?.runnerId;
  }

  async transcript(managerId: string): Promise<ManagerTranscript> {
    const job = await this.#findJob(managerId);
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

    const fromSessionStore = await this.#sessionLoaders.fromSessionStore(job);
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
    const observedAt = this.#nowIso();
    const { outcome, observerInstanceId } = await this.#probeUnpushedWork(
      managerId,
      record,
      options,
    );
    await this.#recordUnpushedWorkObservation(
      record,
      outcome,
      options?.source,
      observedAt,
      observerInstanceId,
    );
    return outcome;
  }

  /**
   * `unpushedWork()` の実際の調べもの（台帳への書き込みは呼び出し元が持つ）。
   * `observerInstanceId` は問い合わせる前に取る: 往復の最中に器が入れ替わった回を、入れ替え前の器の答えとして扱わないため。
   */
  async #probeUnpushedWork(
    managerId: string,
    record: ManagerRecord,
    options?: { signal?: AbortSignal },
  ): Promise<{ outcome: ManagerUnpushedWork; observerInstanceId?: string }> {
    const runner = await this.#runnerOf(record);
    if (runner === null) {
      return {
        outcome: { kind: 'unavailable', reason: '宛先の runner がいま開いていない。' },
      };
    }
    const observerInstanceId = this.#sighting(runner.runnerId).instanceId;
    const withObserver = (outcome: ManagerUnpushedWork) => ({
      outcome,
      ...(observerInstanceId === undefined ? {} : { observerInstanceId }),
    });
    try {
      const result = await runner.unpushedWork(managerId, options);
      if (result === undefined) {
        return withObserver({
          kind: 'unavailable',
          reason: 'runner が答えなかった（セッションが無い・期限切れ・古い版のいずれか）。',
        });
      }
      return withObserver({ kind: 'ok', result });
    } catch (error) {
      return withObserver({
        kind: 'unavailable',
        reason: `runner への問い合わせが失敗した: ${reasonOf(error)}`,
      });
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
    observerInstanceId?: string,
  ): Promise<void> {
    const at = observedAt ?? this.#nowIso();
    const observation = unpushedWorkObservationOf(outcome, at, source);
    if (
      !isUnpushedWorkObservationAtLeastAsNewAs(observation, record.job.lastUnpushedWorkObservation)
    ) {
      return;
    }
    record.job.lastUnpushedWorkObservation = carryKnownBranches(
      observation,
      record.job.lastUnpushedWorkObservation,
    );
    // 台帳へ書いた観測だけを当てる: 古い観測で弾かれた回の「無い」を、新しい観測の後の事実として扱わないため。
    const gone = markRescueGoneWhileAlive(record.job.lastRescue, observation, observerInstanceId);
    if (gone !== null) record.job.lastRescue = gone;
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
  probeTurnEnds(): Promise<void> {
    return this.#turnEndWatch.probe();
  }

  async flushWithheldReports(): Promise<void> {
    this.#withheld.flush();
  }

  async transcriptTail(managerId: string, maxChars: number): Promise<ManagerTranscript> {
    const job = await this.#findJob(managerId);
    if (!job) {
      const unreadable = await this.#unreadableRowDetail(managerId);
      return unreadable === undefined
        ? { kind: 'missing' }
        : { kind: 'unreadable', detail: unreadable };
    }
    return this.#turnEndWatch.transcriptTailOf(job, this.#records.get(managerId), maxChars);
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
    return this.#usageWake.resumeStoppedByUsage();
  }

  async settleStalledUsageWakes(): Promise<string[]> {
    return this.#usageWake.settleStalled();
  }

  sweepRescueRefs(): Promise<void> {
    return this.#rescueSweeper.sweep();
  }

  async renotifyStalledDenials(): Promise<void> {
    this.#denialRenotifier.renotifyStalled();
  }

  /**
   * 前任として受けてよいかを確かめる。断るときは投げる（黙って止めない: 止めるのはクローンの判断）。
   * 受けるのは failed / lost / stopped、および像に居ない（`#retire` 済み）か、像が居ても生きていない done。
   * done で `attached` が真なら、runner にセッションが生きている（手が空いただけ）ので断る。
   */
  async #assertSupersedable(predecessorId: string): Promise<symbol> {
    const record = this.#records.get(predecessorId) ?? (await this.#load(predecessorId));
    if (record === null) {
      throw new Error(
        `前任 ${predecessorId} が台帳に無いため、supersedes に渡せない（id が違うか、manager_list に出ていない）`,
      );
    }
    const status = record.job.status;
    if (isManagerInFlight(status) || (status === 'done' && record.attached)) {
      throw new Error(
        `前任 ${predecessorId} はまだ終わっていない（status=${status}${status === 'done' ? '・セッションが生きている' : ''}）ため、` +
          '後継を立てない。先に manager_stop で止めること（黙って止めない: 止めるのはクローンの判断）。',
      );
    }
    if (record.job.supersededBy !== undefined) {
      throw new Error(
        `前任 ${predecessorId} は既に後継 ${record.job.supersededBy} へ引き継いである。後継を二重に立てない。`,
      );
    }
    // ここから印立てまで await を挟まない: 同じ前任を指す並行の start が確認の間に割り込んで両方通るのを防ぐ（#4865）
    if (this.#supersedePending.has(predecessorId)) {
      throw new Error(`前任 ${predecessorId} には引き継ぎ中の後継がある。後継を二重に立てない。`);
    }
    const token = Symbol(predecessorId);
    this.#supersedePending.set(predecessorId, token);
    return token;
  }

  /**
   * 前任を「後継に引き継いだ」として扱う（#4861）。枠の印・挑み直し・借りを下ろし、台帳へ `supersededBy` を写す。
   * 以後 `UsageWake#nudgeForUsageRotation` は前任を `gone` とみなし、鍵の回転・周回の掃き・起動時の組み直しが前任を起こさない。
   * 投げない: 後継は既に起きており、ここで落ちると呼び元が後継の managerId を受け取れなくなる。
   */
  async #handOverToSuccessor(predecessorId: string, successorId: string): Promise<void> {
    try {
      const record = this.#records.get(predecessorId) ?? (await this.#load(predecessorId));
      if (record === null) return;
      record.job.supersededBy = successorId;
      this.#usageWakeOwed.delete(predecessorId);
      this.#workerLimitStopped.delete(predecessorId);
      delete record.job.workerLimitStopped;
      // 印の解除は台帳へ書く口を兼ねる。印が無くても `supersededBy` は書く
      await this.#usageWake.clearUsageStoppedMark(predecessorId);
      await this.#persist(record);
      const held = record.job.heldMessages ?? [];
      if (held.length > 0) {
        await this.#held.release(record, held.length, `後継 ${successorId} に引き継いだ`);
      }
      await this.#journal({
        type: 'decision',
        decision: `[${predecessorId}] を後継 [${successorId}] に引き継いだ（以後は自動で起こさない）`,
        grounds: '後継を立てた前任が、鍵の回転で起き上がって二重に走るのを防ぐ（supersedes）。',
      });
    } catch (error) {
      noteDroppedRecord('前任の引き継ぎ', `managerId=${predecessorId}`, error);
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
        if (!isManagerInFlight(status)) continue;
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
      if (!this.#stopped) await this.#taskLink.repairStranded();
      const restored = await this.#restoreJobs();
      this.#withheld.rebuildFromLedger();
      return restored;
    } finally {
      this.#restoring = null;
      finished();
    }
  }

  async #restoreJobs(): Promise<ManagerSummary[]> {
    if (this.#stopped) return [];
    await this.#ensureConnected();

    const { alive, unheard, unreadable } = await this.#listLivingSessions();

    const silent = this.#silentRunners();
    const registeredRunnerIds = this.#registeredRunnerIds();
    const resumed: ManagerSummary[] = [];
    for (const job of await this.#stores.jobs.listJobs()) {
      // 像の有無より前に置く: 預かりの見回りは像を持たない終端の委譲（捨てて返す側）も見るため。
      this.#held.indexRestored(job);
      if (this.#records.has(job.id)) continue;

      // 下で `continue` される `lost` より前に置く: 印を組み直さないと `resumeStoppedByUsage()` が `lost` の委譲を回転の対象にすら入れない。
      // 後継へ引き継いだ前任（`supersededBy`）の印は組み直さない（#4861）
      if (job.workerLimitStopped !== undefined && job.supersededBy === undefined) {
        this.#workerLimitStopped.set(job.id, {
          preRotationKey: job.workerLimitStopped.preRotationKey,
          turnStartedAt: job.workerLimitStopped.turnStartedAt,
        });
      }
      if (job.usageStoppedAt !== undefined && job.supersededBy === undefined) {
        this.#usageStopped.add(job.id);
        // すぐ挑む挑み直しの状態を入れる（#4852）: 挑み直しの状態はメモリだけで再起動で消え、生きていない委譲は像にも載らないので、入れないと次の鍵の出来事まで誰も起こさない
        if (!this.#usageWakeRetry.has(job.id)) {
          this.#usageWakeRetry.set(job.id, { failures: 0, nextAt: this.#now() });
        }
      }

      // 状態を読めなかったが runner に居る委譲は resume せずに引き取る: 生きているとしか読めない状態を名指しできないので `attached: false`（話しかけたら `host.resume()` が生きたセッションへ流して短絡する）。待ちは持ち越さず、`status` は台帳の値のまま。
      const unreadableOn = alive.has(job.id) ? undefined : unreadable.get(job.id);
      if (unreadableOn !== undefined) {
        await this.#adoptUnreadable(job, unreadableOn);
        continue;
      }

      const living = alive.get(job.id);
      if (living) {
        resumed.push(await this.#adoptLiving(job, living, silent, registeredRunnerIds));
        continue;
      }

      // 聞けなかった器のジョブは触らず、`#records` へ載せる前に抜ける: 「`alive` に居ない」は「確かめられなかった」であり、載せなければ次の `restore()` が拾い直す。宛先の無いジョブは聞けなかった器が1台でもあれば同じ扱いにする。
      if (unheard.size > 0 && (job.runnerId === undefined || unheard.has(job.runnerId))) continue;

      if (job.sessionId === undefined) continue;

      // 戻せないものを「居る」ことにしない: `#records` へ載せると `list()` が `live: true` で見せ、腐った session_id しか持たない相手に話しかければ続くように見える。
      if (job.status === 'lost') continue;

      // 古い写し（ループ先頭の `job`）で resume を決めない: 待っている間に `abort()` が `stopped` を書いて `#retire` していると、`stopped` を `running` で上書きして起こし直す。resume しうる写しだけ像を載せる直前に読み直し、`await` の間に像が載りうるので読んだ後にもう一度 `#records` を見る。
      const resumable = isManagerInFlight(job.status);
      const fresh = resumable ? ((await this.#latestJobOf(job.id)) ?? job) : job;
      if (resumable && this.#records.has(job.id)) continue;
      if (fresh.status === 'lost') continue;

      const record: ManagerRecord = { job: { ...fresh }, waiting: [], attached: false };
      this.#records.set(job.id, record);

      if (!isManagerInFlight(fresh.status)) continue;

      const runner = await this.#runnerOf(record);
      if (!runner) continue;

      const summary = await this.#resumeAfterRestart(
        job,
        record,
        fresh,
        runner,
        silent,
        registeredRunnerIds,
      );
      if (summary !== undefined) resumed.push(summary);
    }
    return resumed;
  }

  /** 全 runner に生きているセッションを聞く（聞けなかった器と、状態は読めなかった委譲も集める）。 */
  async #listLivingSessions(): Promise<{
    alive: Map<
      string,
      { runner: RunnerClient; state: Awaited<ReturnType<RunnerClient['list']>>[number] }
    >;
    unheard: Set<string>;
    unreadable: Map<string, RunnerClient>;
  }> {
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
    return { alive, unheard, unreadable };
  }

  /** 状態を読めなかったが runner に居る委譲を、resume せずに台帳へ載せる（`attached: false`）。 */
  async #adoptUnreadable(job: Job, unreadableOn: RunnerClient): Promise<void> {
    const record: ManagerRecord = {
      job: { ...job, runnerId: unreadableOn.runnerId },
      waiting: [],
      attached: false,
      reattachedAcrossRestart: true,
    };
    this.#records.set(job.id, record);
    await this.#persist(record);
  }

  /** runner が生きているセッションを開いている委譲を、resume せずに台帳へ引き取る。一覧へ載せる要約を返す。 */
  async #adoptLiving(
    job: Job,
    living: { runner: RunnerClient; state: Awaited<ReturnType<RunnerClient['list']>>[number] },
    silent: ReadonlyMap<string, string>,
    registeredRunnerIds: ReadonlySet<string> | null,
  ): Promise<ManagerSummary> {
    // `attached: true` を固定しない: runner が畳まれた `lost` / `failed` を名乗ることがあり、畳まれたセッションへの `push` は黙って捨てられるのに、届いたことにして台帳の終端状態を `running` へ巻き戻す。
    // `done` も同じ隙間を持つが、この一覧（`RunnerManagerState`）はどちらの `done` かを区別する材料を持たない。
    // だからホワイトリストで書く: ブラックリストに `done` を足す形は、状態が増えたとき既定が `attached: true`（危険側）へ倒れる。
    // 安全側に倒しても代償は無い: 待機している `done` は resume 扱いになるが、`host.resume()` が生きたセッションへ `push` して短絡する。
    const attached = living.state.status === 'running' || living.state.status === 'waiting_human';
    // 台帳の `cwd` を runner が実際に開いているセッションの値へ揃える: 頼んだだけの古い値を持ち越すと、`manager_list` / Web UI が実際と違う `cwd` を名乗り続ける。
    const record: ManagerRecord = {
      job: {
        ...job,
        status: living.state.status,
        ...this.#placementOn(living.runner, living.state),
      },
      waiting: living.state.waiting,
      attached,
      reattachedAcrossRestart: true,
      ...(living.state.tokenFingerprint === undefined
        ? {}
        : { tokenFingerprintAtReattach: living.state.tokenFingerprint }),
      // `running` だけ: `waiting_human` は確認を待っていてターンを終えておらず、配り直しは `#redeliverWaitingAfterRestore` が持つ
      ...(living.state.status === 'running' ? { reportCheckAfterRestore: true as const } : {}),
    };
    this.#records.set(job.id, record);
    // 現役と違う鍵で走り続けている委譲は、起こし直しの借りに載せる（#4643）: 借り（`#usageWakeOwed`）はメモリにしか無く再起動で消えるが、
    // 「回した時点で古い鍵のまま走っていた」はセッションの鍵の指紋と現役の指紋から引き取りの場で組み直せる。載せないと、古い鍵で枠に落ちた
    // 通知は回し手に「もう回した後」として捨てられ（正しい）、鍵の側からの契機が二度と来ず、その委譲はクローンが手で起こすまで止まる。
    const activeFingerprint = this.#tokenIdentity?.()?.fingerprint;
    if (
      attached &&
      living.state.tokenFingerprint !== undefined &&
      activeFingerprint !== undefined &&
      living.state.tokenFingerprint !== activeFingerprint
    ) {
      this.#usageWakeOwed.add(job.id);
    }
    // `#rememberTokenIdentity(job.id)` を呼ばない: 引き取っただけでセッションの env は古い世代の鍵のままなので、観測しただけの現役の世代を書くと本物の食い違いが「一致」に化ける。
    // 記録が無いままにする: 嘘の「一致」より、取れない軸に0の行を作らず正直に「材料が無い」を選ぶ。理由は `reattachedAcrossRestart` で名乗る。
    await this.#persist(record);
    if (attached) {
      this.#restored.notify(record, 'attached');
      this.#redeliverWaitingAfterRestore(record);
    }
    return this.#restoredSummaryOf(record, silent, registeredRunnerIds);
  }

  /** 起動時の引き取りで一覧へ載せる要約を作る（生きていたセッションの引き取りと resume の受理で共有する）。 */
  #restoredSummaryOf(
    record: ManagerRecord,
    silent: ReadonlyMap<string, string>,
    registeredRunnerIds: ReadonlySet<string> | null,
  ): ManagerSummary {
    return this.#summaryOfRecord(record, {
      silent,
      registeredRunnerIds,
      activeTokenGeneration: this.#tokenIdentity?.()?.generation,
      tokenGenerationPoolWired: this.#tokenIdentity !== undefined,
      // 引き取りの口は runner の一覧の観測を渡さない（`runnerListedAt` を立てない）
      runnerListedAt: undefined,
    });
  }

  /** 再起動後に resume できる委譲を runner へ戻す（同じ runner への resume の窓の開閉・resume・受理後の書き戻し・拒否と失敗の後始末）。戻せた回は一覧へ載せる要約を返す。 */
  async #resumeAfterRestart(
    job: Job,
    record: ManagerRecord,
    fresh: Job,
    runner: RunnerClient,
    silent: ReadonlyMap<string, string>,
    registeredRunnerIds: ReadonlySet<string> | null,
  ): Promise<ManagerSummary | undefined> {
    let summary: ManagerSummary | undefined;
    // cause は `'runner'`: runner がセッションを知らないのは器の入れ替わり（作業ツリーが消えている）と区別できず、`'daemon'` だと枝名の clone 案内と「コミット前の変更は失われている」が出ない。
    const nudge = restartNudge(
      fresh.status,
      'runner',
      fresh.workspace,
      fresh.lastUnpushedWorkObservation,
      undefined,
      this.#rescueStash.note(fresh.rescueStash, runner.runnerId),
    );
    // 1本が戻せなくても残りを道連れにしない: 投げると走査が止まり、後ろに並んだ委譲は `#records` にすら載らないまま台帳に `running` で残る（呼び出し元は例外を握り潰すので跡はログ1行だけ）。`#resumeOnce` の中の実 I/O は投げうる。
    // 同じ runner への resume が飛んでいる間は `closed` を預ける窓を立て、どの抜け方でも必ず1回閉じる。
    // 別の契機が resume 中なら窓は持たない: そちらの窓を壊さない。
    const windowOpen = !this.#resuming.has(job.id);
    try {
      if (windowOpen) this.#resumeWindows.openSameRunner(job.id, runner.runnerId);
      let ok: ResumeOutcome | undefined;
      // 受理された回は `running` を persist した後に閉じる: 処理し直した結果を後から上書きしないため。受理されなかった回と投げた回は `moved` を立てずに閉じる。
      try {
        ok = await this.#resumeOnce(record, runner, nudge);
        if (ok === 'resumed') {
          // `#resumeOnce` から戻った直後、他の await を挟む前に読む: `#resuming` の関門は既に外れており、await の隙間に別の契機が新しい resume を仕掛けて `record.cwdSwapNotice` を上書きしうる。
          const swapNotice = cwdSwapNoticeClause(record);
          // 受理は「戻れた」ではない: 失敗は SSE で追いかけてくるので、無条件に上書きすると書いたばかりの終端状態が `running` へ巻き戻る。
          if (record.job.status === 'lost') {
            return undefined;
          }
          await this.#settleResumedAfterRestart(record, runner, job.id, nudge, swapNotice);
          summary = this.#restoredSummaryOf(record, silent, registeredRunnerIds);
        }
      } finally {
        if (windowOpen) await this.#resumeWindows.close(job.id, ok === 'resumed');
      }
      // 貸し出し期限で断られたのは「まだ」: 黙って諦めると次の契機が永久に来ない（台帳では走っているのに誰も走っていない仕事が残る）ので、回数では諦めない梯子へ載せる。他の理由はここでは何もしない。
      if (ok === 'held-by-lease') {
        await this.#journal({
          type: 'decision',
          decision: leaseRefusalDecision(job.id, record.leaseRefusal),
          grounds: record.leaseRefusal?.detail ?? '（根拠を取れなかった）',
        });
        this.#scheduleReattach(runner.runnerId);
      }
    } catch (error) {
      if (isFencedRunnerError(error)) {
        // 世代で拒まれた（409）は「戻せなかった」ではない: `lost` にして像から外すと、クローンが新しく起こし直し、fencing の失敗経路から二重実行へ到達する。状態は動かさず挑み直さず、必ず知らせる。
        await this.#refuseFenced(job.id, error, '起動時の引き取りを止めた', '起動時の引き取り');
      } else if (isRetryableRunnerError(error)) {
        // 一時的なこけ方は黙って引き下がらない: 次の契機が永久に来ないことがあるので梯子へ載せる。
        this.#scheduleReattach(runner.runnerId);
      } else {
        // `running` のままにしない: resume を実際に試して戻れなかったので、`lost` は確かめた事実。
        // 直書きしない: resume を待つ間に `abort()` が `stopped` を書いていることがあり、`#confirmLost` は止めた後を動かさない（`#reattach` と同じ入口）。
        await this.#confirmLost(record, error);
      }
    }
    return summary;
  }

  /** resume が受理された委譲の状態を書き戻し、一言と日誌と通知を出す（`#resumeAfterRestart` の受理の枝）。 */
  async #settleResumedAfterRestart(
    record: ManagerRecord,
    runner: RunnerClient,
    jobId: string,
    nudge: string,
    swapNotice: string | undefined,
  ): Promise<void> {
    // 応答より先に届いた確認（`waiting`）があれば `waiting_human` を保つ（`#send` の同じ書き込みと同じ理由）。
    record.job.status = record.waiting.length > 0 ? 'waiting_human' : 'running';
    await this.#persist(record);
    // `runner.send()` の失敗は無視する: 本体の resume は成功しており、この一言が届かなくても致命ではない。
    if (swapNotice !== undefined) {
      await runner.send(jobId, swapNotice).catch(() => undefined);
    }
    await this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${jobId}] （再起動後の再開）${nudge}` +
        (swapNotice === undefined ? '' : ` ${swapNotice}`),
    );
    this.#restored.notify(record, 'resumed', 'runner');
  }

  /** runner が実際に開いているセッションの値へ台帳の宛先・cwd・workspace・sessionId を揃える（起動時の引き取りと、移送先に既に居た委譲の取り直しが共有する）。 */
  #placementOn(
    runner: RunnerClient,
    state: Awaited<ReturnType<RunnerClient['list']>>[number],
  ): Pick<Job, 'runnerId' | 'cwd' | 'workspace' | 'sessionId'> {
    return {
      runnerId: runner.runnerId,
      cwd: state.cwd,
      workspace: workspaceLocatorFrom(this.#workspace, runner.runnerId, state.cwd),
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    };
  }

  /**
   * 移送先の一覧に既に居る委譲の台帳を移送先へ揃える: 揃えないと台帳は元の runner を指したままで、移送先から届く出来事が「移った後の古い runner」として捨てられる。
   * 止めた・戻せなかった後は動かさない。像が別の宛先へ移っていたら（古い写し）触らない。
   */
  async #alignToTarget(
    job: Job,
    runner: RunnerClient,
    state: Awaited<ReturnType<RunnerClient['list']>>[number],
  ): Promise<void> {
    const known = this.#records.get(job.id);
    const current = known?.job ?? (await this.#latestJobOf(job.id)) ?? job;
    const again = this.#records.get(job.id);
    if (
      current.runnerId !== job.runnerId ||
      (again?.job.runnerId ?? job.runnerId) !== job.runnerId
    ) {
      return;
    }
    if (current.status === 'stopped' || current.status === 'lost') return;
    const attached = state.status === 'running' || state.status === 'waiting_human';
    const record: ManagerRecord = again ?? {
      job: { ...current },
      waiting: state.waiting,
      attached,
    };
    Object.assign(record.job, this.#placementOn(runner, state));
    record.attached = attached;
    this.#records.set(job.id, record);
    await this.#persist(record);
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
    const target = await this.#resolveAbortTarget(managerId);
    if ('outcome' in target) return target;
    const { record, runner } = target;

    const who =
      by === 'clone' ? 'クローン' : by === 'auto-fold' ? 'デーモン（pids逼迫の自動畳み）' : '人間';

    // 止めた意思を確かめる前に先に立てる: await の間に別の契機（`send()` や別 runner の `#reattach`）が同じ `ManagerRecord` で resume を進めると、走り続ける委譲を「止まった」と言う事故になる。台帳は `outcome === 'stopped'` を確かめてからしか書かない: これは意思の共有であって確定の記録ではない。
    const lastReportAtAtStart = record.job.lastReportAt;
    const inputMarkAtStart = this.#inputMarks.get(managerId);
    // 自動の畳みだけ、印を停止前の確認の往復のあとへ遅らせる: 先に立てると、その往復の間に届いた `send()` が末尾の `stopConfirmedAt` の確かめに当たり、依頼は生きたセッションへ渡っているのに `session_missing` を返して担当ごと畳む。遅らせた間の入りは下の読み直し（`#inputMarks`）が拾う。人間・クローンの明示の停止は従来どおり先に立てる（意思が先）。
    if (by !== 'auto-fold') record.stopConfirmedAt = this.#nowIso();
    // await の前の宛先を覚えておく: await の後にこれと食い違えば、委譲は別の runner へ移っている。
    const runnerIdBeforeConfirm = record.job.runnerId;

    // `by` で条件分けせず全員に `runner.stop()` の直前の観測を取る: `'auto-fold'` の安全弁より「止める直前」に近く、新しいほうが上書きガードで勝つ。runner 側の best-effort な先取りを増やさず、生きて往復できるここで同期に取る。`.catch()` は観測の失敗で判定を巻き添えにしないため。
    await this.unpushedWork(managerId, {
      signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
      source: 'stop',
    }).catch(() => undefined);

    // 自動の畳みだけ、止める直前にもう一度「手が空いたまま」かを読み直す: 候補の判定からここまでに未pushの確認（最大5秒×2）と日誌の書き込みの往復を挟み、その間に届いた依頼（`send()` / 預かりの届け直し）が `status` を `running` へ、新しい報告が `lastReportAt` を動かす。止めると依頼を受けた担当を畳み、送り直しで二重になる。人間・クローンの明示の停止は読み直さない（意思が先）。
    if (
      by === 'auto-fold' &&
      (record.job.status !== 'done' ||
        record.job.lastReportAt !== lastReportAtAtStart ||
        this.#inputMarks.get(managerId) !== inputMarkAtStart)
    ) {
      return await this.#cancelAutoFold(managerId, record, who);
    }
    // 読み直しと同じ同期の区間で立てる（間に `await` を挟まない）: 以後の `send()` は従来どおりこの印で断られる。
    if (by === 'auto-fold') record.stopConfirmedAt = this.#nowIso();

    // `runner.stop()` が投げても abort() ごと reject させない: 日誌もクローンへの通知も状態の更新も残らず 500 になり、「止めた事実は日誌に残る」約束がいちばん要る場面で消える。権威は `sessionGone` の探りに置く（stop の RPC が返らなくても止まっていることがある）。
    let { outcome, stopError, sessionGone } = await this.#confirmStoppedAndReleaseLease(
      record,
      runner,
      managerId,
    );

    // 二重の網: 印を立てる前の await の間に `#reattach` が resume を終えていれば印では塞げないので、戻った直後に宛先の食い違いを見る。新しい持ち主に任せず止めた意思を優先し、確かめられなければ「台帳を書かない」側へ合流させる。
    if (outcome === 'stopped' && record.job.runnerId !== runnerIdBeforeConfirm) {
      ({ outcome, stopError, sessionGone } = await this.#reconfirmAfterMove(record, managerId));
    }

    if (outcome !== 'stopped') {
      // 印だけが確かめられた事実に追いつかないまま残らないよう下ろす。
      delete record.stopConfirmedAt;
    }

    let withheldNote = '';
    if (outcome === 'stopped') {
      withheldNote = await this.#settleStoppedRecord(record, managerId);
    }
    // `'not_stopped'` / `'unknown'` のときは台帳を書かない: 生きているかもしれないマネージャーの `waiting` を畳まず、確かめていない状態を確定させない。「止めた」と言えるのは止まったと確かめたときだけ。

    const { detail, messageText, markup } = abortTextsOf({
      outcome,
      stopError,
      who,
      reason,
      by,
      managerId,
      withheldNote,
    });
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      // `（停止）` はそのまま残す: テストが固定している。`[outcome=...]` は文の解釈なしに grep で数えられるようにする。
      text: `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] （停止）[outcome=${outcome}] ${detail}`,
    });
    // クローン発の停止は受信箱へ配らない: `manager_stop` の戻り値で同じターンに同期的に受け取る内容の真部分集合で新しい事実が無く、`manager_message` は束ねられないので、停止1本ごとにクローンのターン（システムプロンプトの読み直し）を1回焼く。日誌には条件を問わず残る。
    // 人間発は配る: クローンには戻り値が無く、他に知る手段が無い。
    if (by !== 'clone') {
      this.#postReport(managerId, messageText, markup === undefined ? {} : { markup });
    }

    return { outcome, detail, ...(sessionGone === undefined ? {} : { sessionGone }) };
  }

  /** 段A（入口）: 接続を確かめ、台帳の像と宛先の runner を引く。引けなければ断りの結果を返す。 */
  async #resolveAbortTarget(
    managerId: string,
  ): Promise<{ record: ManagerRecord; runner: RunnerClient } | ManagerAbortResult> {
    await this.#ensureConnected();

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
      // `'absent'` を返さない: マネージャーは存在し、宛先がいま開いていないだけで、daemon の `app-routes-managers.ts` が 404 にすると一時的な状態が「そんなものは無い」という終端になる。言い方は `send()` と同じものを使う: 同じ観測に2つの言い方を持たせると片方だけが直る。
      return { outcome: 'unknown', detail: this.#runnerNotOpenDetail(record) };
    }

    return { record, runner };
  }

  /** 段B（自動の畳みの取りやめ）: 止める直前に新しい動きが入っていた回を日誌に残し、止めていない結果を返す。条件は呼び元が見る。 */
  async #cancelAutoFold(
    managerId: string,
    record: ManagerRecord,
    who: string,
  ): Promise<ManagerAbortResult> {
    const detail =
      `${who}が停止を試みたが、止める直前に ${managerId} へ新しい動きが入っていた` +
      `（status=${record.job.status}）ので取りやめた。止めていない。`;
    await this.#journal({
      type: 'decision',
      decision: `[auto-fold] ${managerId} の自動の畳みを取りやめた（直前に依頼が入った）: ${detail}`,
      grounds:
        'デーモンの自動畳み（Issue #1394）: 止める直前の読み直しで、手が空いた状態ではなくなっていた',
    });
    return { outcome: 'not_stopped', detail };
  }

  /** 段C（宛先の食い違い）: 委譲が別の runner へ移っていた回に、移った先で止まりを確かめ直す。条件は呼び元が見る。 */
  async #reconfirmAfterMove(
    record: ManagerRecord,
    managerId: string,
  ): Promise<{
    outcome: 'stopped' | 'not_stopped' | 'unknown';
    stopError: unknown;
    sessionGone: boolean | undefined;
  }> {
    const movedRunner = await this.#runnerOf(record);
    if (movedRunner === null) {
      return { outcome: 'unknown', stopError: undefined, sessionGone: undefined };
    }
    return await this.#confirmStoppedAndReleaseLease(record, movedRunner, managerId);
  }

  /** 段D（止めた台帳の確定）: 止まったと確かめた回の台帳の整理・保存・在庫の控え・像の片付け。控えた知らせの文を返す。条件は呼び元が見る。 */
  async #settleStoppedRecord(record: ManagerRecord, managerId: string): Promise<string> {
    record.waiting = [];
    record.attached = false;
    record.job.status = 'stopped';
    this.#workerLimitStopped.delete(managerId);
    delete record.job.workerLimitStopped;
    await this.#persist(record);
    // `#retire()` で在庫が消えるので、読むのは必ずその前（`WithheldReportsStore#stoppedNote`）。
    const withheldNote = this.#withheld.stoppedNote(managerId);
    this.#retire(managerId);
    return withheldNote;
  }

  async stop(options?: ManagerPoolStopOptions): Promise<void> {
    // 締切の既定は待つ相手が居るときだけ時計を読んで決める: 待たない stop に時計を読む新しい口を増やさない。
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribeDirectPushes.splice(0)) unsubscribe();
    await this.#drainNoticeWindows();
    // 日誌の畳み込みも吐き出す: こちらは日誌のどこにも書かれていない記録そのものを失い、`#retire()` を通らずに止まると畳んだ2件目以降が丸ごと消える。
    this.#usageReceiver.flushJournalFolds();
    this.#pushLedger.stop();
    this.#unsubscribe();
    for (const timer of this.#reattachTimers.values()) clearTimeout(timer);
    this.#reattachTimers.clear();
    this.#restored.clearConfirmations();
    this.#reattachDelays.clear();
    this.#reattachBusyRetries.clear();
    this.#unresumable.clear();
    // 閉じる前に受け取る: `runner.close()` が SSE を自分で切るので、待つならこの手前でなければ効かない。
    await this.#awaitRunnerFarewells(options?.farewellDeadlineAt);
    // 別れの合図を待つ間と、上で窓の台帳を読む間にも、runner の出来事は届いて担当ごとの窓へ積まれる。runner を閉じる前にもう一度吐き出す:
    // 吐き出さないと、その窓のタイマーはデーモンと一緒に消え、器の入れ替えで届いた知らせ（`turn_failed` 等）が配られない。
    await this.#drainNoticeWindows();
    // runner のマネージャーは止めない: デーモンの都合で人の仕事を殺さない。
    for (const runner of await this.#runnersOrEmpty()) {
      await runner.close().catch(() => undefined);
    }
    // 閉じた後にもう一度吐き出す: 2回目の吐き出しの台帳読みの間と、runner を閉じ終えるまでに届いた出来事も担当ごとの窓へ積まれ、
    // 閉じる者が居ないままデーモンと一緒に消えるため（#4490）。閉じた後は新しい出来事が届かないので、処理中の分を待てば窓は空になる。
    await this.#settleEventsInFlight();
    await this.#drainNoticeWindows();
    this.#records.clear();
  }

  // 窓の中でデーモンが落ちると積んだ知らせが失われるので、ここで flush する（`setTimeout` は二度と発火しない）。
  // 担当ごとの窓を先に閉じる: 閉じた束がプール全体の窓へ入るので、順序が逆だとその分が残る。
  async #drainNoticeWindows(): Promise<void> {
    this.#synthesized.flushAll();
    await this.#quotaWindows.flushAll();
    await this.#restored.flushAll();
    await this.#quotaWindows.settleInFlight();
  }

  /** 締切に達したら待つのをやめる（閉じる側に倒す）。runner は互いに独立に待つ: 1台の遅れが他を待たせない。 */
  async #awaitRunnerFarewells(farewellDeadlineAt: number | undefined): Promise<void> {
    if (this.#farewellRunners.size === 0) return;
    const deadlineAt = farewellDeadlineAt ?? this.#now() + RUNNER_FAREWELL_WAIT_MS;
    // 待っている間に新しく名乗った runner（デーモンが先に畳まれ、runner の SIGTERM が少し遅れた回。#4932）も、同じ締切の内側で拾う。
    // 待ち終えた runner は二度待たない。
    const waited = new Set<string>();
    for (;;) {
      const runners = (await this.#runnersOrEmpty()).filter(
        (runner) =>
          this.#farewellRunners.has(runner.runnerId) &&
          runner.awaitStreamEnd !== undefined &&
          !waited.has(runner.runnerId),
      );
      if (runners.length === 0) return;
      for (const runner of runners) waited.add(runner.runnerId);
      await this.#awaitFarewellsOf(runners, deadlineAt);
    }
  }

  async #awaitFarewellsOf(runners: readonly RunnerClient[], deadlineAt: number): Promise<void> {
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
   * 一度きりにしない: 「もう繋いだ」を1つの旗で持つと、後から載った runner の報告も許可確認も永久に届かない。旗は宛先ごとに持つ。
   * 転んだ1台に他を道連れにさせない。選んだ相手に繋がっているかどうかは `start` が別に確かめる。
   */
  async #ensureConnected(): Promise<void> {
    if (this.#stopped) return;
    const runners = await this.#runnersOrEmpty();
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
      // 鍵を先に降ろす（#4841）: 並びは `#pushSpecs` の表の順。
      await this.#pushLedger.pushEnvironmentTo(runner);
      this.#pushLedger.settleRetry(runner.runnerId);
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

      // 併存は関門より前に確かめる: `this.#runners.get` は同名の行が2つ以上あっても黙って一方を返すので、関門（`#claimForResume`）に着く前にプロファイルの配布（`#pushSetting`。日誌の文言には旧名の `#pushProfile` が残る）と `runner.list()` が誤解決した相手へ走ってしまう。関門は複製せず、進んでよい状態かを覗くだけ。
      // この断りは `held` と違って時間で解けないので「遷移のときだけ書く」dedup（`refusedBefore`）には乗せない: 初回だけ言うと、見逃した後・デーモン再起動後は永久に見えなくなる。
      const sighting = this.#sighting(runnerId);
      if (sighting.duplicates !== undefined && sighting.duplicates > 1) {
        // 梯子を予約する: 残さないと、解けた後に取り直す契機は `hello` しか無く、来なければ委譲は `running` のまま誰にも拾われない。時間で解けるとは限らないので間隔は上限に固定する。`viaLadder` の回は併存の日誌・知らせを出し直さない: 梯子が回るたびに積まれる。
        retry = true;
        this.#reattachDelays.set(runnerId, REATTACH_RETRY_MAX_MS);
        await this.#refuseAmbiguousRunner(runnerId, sighting.duplicates, viaLadder);
        return;
      }
      if (this.#ambiguousRunnersNotified.has(runnerId)) {
        await this.#noteAmbiguousResolvedFor(runnerId);
      }

      // 取り直しの前に環境を整える: 走り出してから降ろすと、その仕事の最初のコマンドだけが古い環境で走る。降ろし切るまで委譲にも待たせる。
      // `#connections` は触らず別の窓口（`#reattachPushes`）に置く: `#connectTo` の失敗時の後始末が誰の Promise かを見ずに消すため、上書きすると古い接続の失敗がこの降ろし直しを巻き添えで消しうる。
      await this.#pushEnvironmentBeforeReattach(runner, runnerId);

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
          const livingState = listing.states.find((state) => state.managerId === job.id);
          if (
            livingState !== undefined &&
            job.runnerId !== undefined &&
            job.runnerId !== runnerId &&
            this.#shouldRelocateFrom(job.runnerId)
          ) {
            await this.#alignToTarget(job, runner, livingState);
          }
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

        if (await this.#reattachOne(job, runner, runnerId, relocating)) retry = true;
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

  /**
   * 併存（同じ runnerId を名乗る器が2台以上）を検出した回の断り: 日誌と受信箱へ知らせ、移送先の候補として数えていたジョブへ見送りを流す。
   * `viaLadder` の回は流すだけで、日誌・知らせは出し直さない。
   */
  async #refuseAmbiguousRunner(
    runnerId: string,
    duplicates: number,
    viaLadder: boolean,
  ): Promise<void> {
    if (viaLadder) {
      await this.#refuseRelocationsBeforeGate(runnerId, duplicates);
      return;
    }
    await this.#journal({
      type: 'decision',
      decision: `runnerId=${runnerId} の取り直しを見送った（併存を関門より前で検出。#pushProfile と runner.list() は誤解決した相手へ走らせていない）`,
      grounds: describeAmbiguousSighting(runnerId, duplicates),
    });
    // 受信箱にもここで知らせる: `#claimForResume` 側の通知だけに任せると、併存を検出する経路（`hello`）がここで折り返され続け、クローンへ一度も届かない。dedup は `#ambiguousRunnersNotified` を共有するので二重には出ない。
    // ジョブの一覧は store から引く: `this.#records`（プロセス内の像）はまだこのジョブを持っていないことがある。
    // 一覧を読めなかった回を「紐づく委譲が無い」とみなさない: `#noteAmbiguousSighting` を呼ばなければ通知済みにもならず、次の `hello` で再挑戦できる。見送ったことは日誌に残す。
    const listed = await this.#listJobsOrNote(
      `runnerId=${runnerId} の併存の通知を見送った（通知済みにはしていない。次の hello で再挑戦する）`,
    );
    if (listed !== null) {
      const jobIds = listed.filter((job) => job.runnerId === runnerId).map((job) => job.id);
      this.#noteAmbiguousSighting(runnerId, duplicates, jobIds);
    }
    // この runner を移送先の候補として数えていたジョブには、見送りを断りとして流す: runner 単位の `return` なので、ジョブのループには届かない。
    await this.#refuseRelocationsBeforeGate(runnerId, duplicates);
  }

  /** 併存が解けた回の通知: 台帳の一覧を読めなかった回は言わず、通知済みの印を残す。 */
  async #noteAmbiguousResolvedFor(runnerId: string): Promise<void> {
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

  /** 取り直しの前に鍵・プロファイルを降ろし直す: 降ろし切るまで委譲（`#connectTo`）にも待たせる。 */
  async #pushEnvironmentBeforeReattach(runner: RunnerClient, runnerId: string): Promise<void> {
    const push = (async () => {
      // 繋ぎ直してきた runner は器ごと入れ替わっていることがあり、置いた鍵とプロファイルは消えているので降ろし直す。
      // 鍵を先に降ろす（#4841）: 並びは `#pushSpecs` の表の順。認証トークンも降ろし忘れない（`#pushEnvironmentTo` の注記）。
      await this.#pushLedger.pushEnvironmentTo(runner);
      this.#pushLedger.settleRetry(runnerId);
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
  }

  /**
   * 1本の委譲を取り直す（`#reattach` のループの1周ぶん）: 像の読み直し・resume・結果ごとの後始末まで。
   * 戻り値は「挑み直しを予約するか」。`continue` で次の委譲へ進んでいた所は `return` で返す。
   */
  async #reattachOne(
    job: Job,
    runner: RunnerClient,
    runnerId: string,
    relocating: boolean,
  ): Promise<boolean> {
    let retry = false;
    // 古い写し（ループ先頭の `job`）の宛先で像へ書かない: `#reattaching` は runner ごとの直列化なので、待っている間に別の runner の取り直しが移送を終えていると、移送先で健全に走る像へ `attached = false`・`waiting = []` と「resume に失敗した」観測を書いてしまう。判定は読み直しの後・像への最初の書き込みの前に置く。自分の runner の委譲（`!relocating`）は宛先が変わらないので飛ばさない。
    const fresh =
      this.#records.get(job.id) === undefined ? ((await this.#latestJobOf(job.id)) ?? job) : job;
    // 読み直しの `await` の間に像が載ることもあるので、読んだ後にもう一度 `#records` を見る。
    const known = this.#records.get(job.id);
    if ((known?.job.runnerId ?? fresh.runnerId) !== job.runnerId) return false;

    // 移送のときは、像を「器にセッションが無い」側へ倒すのを貸し出しの関門を通った後まで待つ（下の `markMissing`）。
    // 関門で断られるのは持ち主がまだ握っているときで、名簿が器を一時的に `lost` と誤判定しただけのこともある。先に倒すと、断られた後も
    // 待っていた確認（`waiting`）が消えたまま戻らず、回答が届かなくなる。`attached = false` も残り、次の `manager_send` が生きたセッションへ resume を撃ち直す（#4454）。
    if (known && !relocating) known.attached = false;

    // 印は resume を挑む直前に置き、戻れたときに消す: `#resumeOnce` が投げる回も「戻れなかった」側へ落ち、この節を抜けて印が立っている ⟺ resume が成功しなかった、が成り立つ。
    const missingAt = this.#nowIso();

    // 手を動かしている最中だったものだけ戻す: `done` は死ではなく待機で、起こすと開いたままの窓を勝手に閉じる。判定より前に `#records` へ載せない: 終わった仕事まで `live: true` で見せ、話しかけると必ず失敗する相手が生まれる。
    // 古い写し（ループ先頭の `job`）で判定しない: 待っている間に `abort()` が `stopped` を書いて `#retire` していると、`stopped` を `running` で上書きして起こし直す。`known` が無いときは読み直した `fresh` で判定し、record も同じ行から作る。
    const current = this.#records.get(job.id) ?? known;
    const status = current?.job.status ?? fresh.status;
    if (!isManagerInFlight(status)) return false;

    const record = current ?? { job: { ...fresh }, waiting: [], attached: false };
    this.#records.set(job.id, record);
    const markMissing = (): void => {
      record.attached = false;
      // 待っていた確認を持ち越さない: 新しい器はその request_id を知らず、残すと以後の `manager_send` が死んだ確認への回答として横取りされ、誰からも届かないマネージャーになる。
      this.#withdrawWaiting(record, '器が入れ替わり、新しい器はこの確認を知らない');
      record.sessionMissingSince ??= missingAt;
      // 由来を上書きする（格上げ）: ここを抜けて印が残っている ⟺ resume でも入り直せなかった。
      record.sessionMissingKind = 'resume-failed';
    };
    if (!relocating) markMissing();

    // 1本が戻せなくても残りを道連れにしない。移送の窓はどの抜け方でも必ず1回閉じる（`ResumeEventWindows#close`）。
    try {
      const cause: RestartCause = relocating ? 'relocated' : 'runner';
      const message = restartNudge(
        status,
        cause,
        record.job.workspace,
        record.job.lastUnpushedWorkObservation,
        record.job.lastRescue,
        this.#rescueStash.note(record.job.rescueStash, runnerId),
      );
      const refusedBefore = record.leaseRefusal !== undefined;
      // 別の契機が resume 中なら窓は持たない: そちらの窓を壊さない。同じ runner への復帰は `closed` だけを預ける別の窓を持つ。
      const ownsWindow = !this.#resuming.has(job.id);
      if (ownsWindow) {
        if (relocating) this.#resumeWindows.openRelocation(job.id, runnerId);
        else this.#resumeWindows.openSameRunner(job.id, runnerId);
      }
      let outcome: ResumeOutcome | undefined;
      // 受理された回は台帳を `running` へ戻して persist した後に閉じる: 移送先自身の出来事（closed(failed) や ask）を処理し直した結果を、後から `running` で上書きしないため。受理されなかった回と投げた回は `moved` を立てずに、下の分岐より先に閉じる。
      try {
        outcome = await this.#resumeOnce(
          record,
          runner,
          message,
          undefined,
          relocating ? markMissing : undefined,
        );
        if (outcome === 'resumed') {
          // `#resumeOnce` から戻った直後、他の await を挟む前に読む（`#restoreJobs` と同じ理由）。
          const swapNotice = cwdSwapNoticeClause(record);
          // 受理と「戻れた」を取り違えない。
          if (record.job.status === 'lost') return false;
          await this.#settleResumedReattach(
            job,
            record,
            runner,
            relocating,
            cause,
            message,
            swapNotice,
          );
        }
      } finally {
        if (ownsWindow) await this.#resumeWindows.close(job.id, outcome === 'resumed');
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
        return retry;
      }
      this.#reattachBusyRetries.delete(job.id);
      if (outcome === 'unreadable') {
        retry = true;
        return retry;
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
        return retry;
      }
      if (relocating && outcome === 'no-session') {
        // 移送のときの `no-session` はその場で lost に確定する: セッションが無いのは委譲の側の事実で、候補を回しても変わらない。
        await this.#settleRelocationNoSession(job, record, runnerId);
        return false;
      }
      if (relocating && outcome === 'workspace-path-unknown') {
        // 貸し出しは返さない: この回では貸していず、`record.job.lease` がこの候補を指していても以前の回が貸したもので、セッションが起きていないと確かめられないものは返さない。
        await this.#settleRelocationWorkspaceUnknown(job, record, runnerId);
        return false;
      }
    } catch (error) {
      // 投げる前に立てた予約（`held-by-lease` の日誌の書き込みが投げた回など）は落とさない: 切り出す前は `retry` が `#reattach` の変数で、catch でも残っていた。
      const retryAfterError = await this.#classifyReattachError(
        error,
        record,
        job.id,
        runnerId,
        relocating,
      );
      return retry || retryAfterError;
    }
    return retry;
  }

  /** resume が受理され、戻れたと確かめた後の後始末: 古い観測の消去・台帳への書き戻し・一言・日誌・知らせ。 */
  async #settleResumedReattach(
    job: Job,
    record: ManagerRecord,
    runner: RunnerClient,
    relocating: boolean,
    cause: RestartCause,
    message: string,
    swapNotice: string | undefined,
  ): Promise<void> {
    // 戻れたので古い観測は捨てる: 残すと「いま話しかけられない」と読める欄が話しかけられる相手に付いたままになる。由来も片方だけ残さない。
    record.sessionMissingSince = undefined;
    // 由来も一緒に消す: 片方だけ残さない。
    record.sessionMissingKind = undefined;
    // 応答より先に届いた確認（`waiting`）があれば `waiting_human` を保つ（`#send` の同じ書き込みと同じ理由）。
    record.job.status = record.waiting.length > 0 ? 'waiting_human' : 'running';
    this.#relocationRefusals.delete(job.id);
    await this.#persist(record);
    // `runner.send()` の失敗は無視する: 本体の resume は成功しており、この一言が届かなくても致命ではない。
    if (swapNotice !== undefined) {
      await runner.send(job.id, swapNotice).catch(() => undefined);
    }
    await this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${job.id}] （${relocating ? '別の器への移送' : 'runner 入れ替え'}後の再開）${message}` +
        (swapNotice === undefined ? '' : ` ${swapNotice}`),
    );
    this.#restored.notify(record, 'resumed', cause);
  }

  /** 移送のときの `no-session` の後始末: セッションが無いのは委譲の側の事実なので、その場で lost に確定する。 */
  async #settleRelocationNoSession(
    job: Job,
    record: ManagerRecord,
    runnerId: string,
  ): Promise<void> {
    const reason = new Error(
      'no-session: 委譲が session_id を持っておらず、どの runner でも開き直せない（移送の候補を回しても変わらないので、その場で確定した）',
    );
    await this.#journal({
      type: 'decision',
      decision: `[${job.id}] 移送先 ${runnerId} へ移せない（セッションが無い）。候補を回さず、戻せなかったものとして確定する`,
      grounds: reasonOf(reason),
    });
    await this.#confirmLost(record, reason);
  }

  /** 移送のときの `workspace-path-unknown` の後始末: 断りを数え、上限なら lost に確定し、そうでなければ貸し出しを返さなかったことを日誌に残す。 */
  async #settleRelocationWorkspaceUnknown(
    job: Job,
    record: ManagerRecord,
    runnerId: string,
  ): Promise<void> {
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
  }

  /**
   * 取り直しで投げられた失敗の仕分け: 世代で拒まれたら止める・一時的なら予約する・移送先1台の断りなら見送る・それ以外は lost に確定する。
   * 戻り値は「挑み直しを予約するか」。
   */
  async #classifyReattachError(
    error: unknown,
    record: ManagerRecord,
    jobId: string,
    runnerId: string,
    relocating: boolean,
  ): Promise<boolean> {
    let retry = false;
    this.#reattachBusyRetries.delete(jobId);
    // 一時的にこけたときは自分で予約する: `hello` は SSE が繋がったときにしか来ず、ストリームが安定していれば永久に来ないので、台帳が `running` のまま誰も走っていない仕事が残る。
    if (isFencedRunnerError(error)) {
      // 世代で拒まれた（409）は「戻せなかった」ではない: `lost` にして像から外すと、クローンが新しく起こし直し、fencing の失敗経路から二重実行へ到達する。状態は動かさず挑み直さない（同じ世代で投げ直しても同じ答え）が、台帳の書き込み失敗か別のデーモンの存在を人間が知る必要があるので必ず知らせる。
      await this.#refuseFenced(jobId, error, '取り直しを止めた', '取り直し');
    } else if (isRetryableRunnerError(error)) retry = true;
    else if (
      relocating &&
      isRunnerSpecificRefusal(error) &&
      !(await this.#noteRelocationRefusal(record, runnerId, error))
    ) {
      // 移送先1台の断りは委譲の運命ではない: lost に確定せず `#unresumable` も立てず、この移送先だけ見送る。ほかの候補が引き取れる。
      // この移送先へ貸した貸し出しは返す: 残すとほかの候補の関門が `held` で断り、TTL が切れるまで移れない。4xx は命令を受け取らなかったという答えで、セッションは起きていない（起きていれば 2xx）。
      if (record.job.lease?.runnerId === runnerId && record.job.lease.releasedAt === undefined) {
        record.job.lease = releaseLease(record.job.lease, this.#now());
        await this.#persist(record);
        // 黙って返さない: この契機だけは持ち主自身の `closed` ではなく 4xx の答えに拠っている。
        await this.#journal({
          type: 'decision',
          decision: `[${jobId}] 移送先 ${runnerId} に貸した貸し出しを返した（resume を 4xx で断られ、そこではセッションが起きていない）`,
          grounds: reasonOf(error),
        });
      }
    } else {
      await this.#confirmLost(record, error);
    }
    return retry;
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

  /** 文面は `unresumableNotice`（`manager-notices.ts`）。ここは日誌と合流窓へ積む副作用だけを持つ。 */
  #notifyUnresumable(
    record: ManagerRecord,
    error: unknown,
    cause: 'runner' | 'session' = 'runner',
  ): void {
    const { job } = record;
    const { journal, notice } = unresumableNotice(job, error, cause);
    // 日誌は呼び出し元に委ねない: 経路ごとに呼び出し元の事前の書き込みが違い、「日誌に無い＝この経路を通っていない」を判別器にするには、経路によらず必ず1本書く必要がある。
    void this.#journalExchange('outbound', `${EXCHANGE_KIND_FAILURE_PREFIX}[${job.id}] ${journal}`);
    // 即配らず合流窓へ積む: 委譲が器と一緒に失われた族は `resume_fallback` / `resume_failed` / `closed_failed` の3通で構成され、「一枠落ち一合図」に揃える。
    this.#queueSynthesizedNotice(job.id, 'resume_failed', notice);
  }

  /** 成功として黙らせない: 続きは前のセッションそのものではなく、知らないクローンは「前に渡した細かい指示は効いている」前提で次を積んでしまう。 */
  #notifyResumeFallback(record: ManagerRecord, sessionId: string, reason: string): void {
    const { job } = record;
    const body = resumeFallbackBody(job, sessionId, reason);
    // 日誌は呼び出し元にも合流窓の flush にも委ねない: 呼び出し元は理由までしか書かず、flush の1行は内訳（族と通数）だけで、ここで組み立てた拡張文言はどこにも残らない。
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${job.id}] （生ログから作り直して続けた）${body}`,
    );
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
      const open = await this.#runnersOrEmpty();
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
      if (!isManagerInFlight(job.status)) continue;
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
        this.#withdrawWaiting(record, '器を失い、移送先でも引き取れなかった');
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

  /**
   * 追っている世代が無い間（再起動の直後・resume の応答待ち・世代を返さない古い runner）は `unknown`（世代を見ない）。
   * 追っている世代があるのに値の無い出来事は、食い違いと同じ `stale` に倒す（runner は出来事に必ず世代を載せる。#5764）。
   */
  #judgeSessionGeneration(
    record: ManagerRecord,
    event: RunnerEvent,
  ): 'stale' | 'current' | 'unknown' {
    if (!isSessionScopedEvent(event)) return 'unknown';
    const tracked = record.sessionGeneration;
    if (tracked === undefined) return 'unknown';
    return event.sessionGeneration === tracked ? 'current' : 'stale';
  }

  /** 出来事に付いて届いた世代を覚える（#5195）。古い順に捨てて上限で締める: 担当の像は起こし直しのたびに世代が増えるため。 */
  #observeSessionGeneration(record: ManagerRecord, event: RunnerEvent): void {
    if (!isSessionScopedEvent(event)) return;
    const given = event.sessionGeneration;
    // 記録する値が無いだけ（型のための guard）。判定は `#judgeSessionGeneration` が持つ
    if (given === undefined || given.length === 0) return;
    const observed = (record.observedSessionGenerations ??= new Set<string>());
    observed.delete(given);
    observed.add(given);
    while (observed.size > OBSERVED_SESSION_GENERATIONS_MAX) {
      const oldest = observed.values().next().value;
      if (oldest === undefined) break;
      observed.delete(oldest);
    }
  }

  /**
   * 古い世代の確認の要求（`ask`）でも、いま追っている世代がまだ1つも出来事を出していなければ、捨てずにクローンへ知らせる（#5203）。知らせたら `true`。
   *
   * 古いセッションは答えを待って止まり、新しいセッションは黙り、台帳は `running` のまま — 捨てると誰も気づかない。条件は報告（#5195）と同じ。
   * 待ちの列（`waiting`）には積まず、`waiting_human` にもしない: runner の `answer` は名簿に居るセッション（起こし直した新しい側）にしか
   * 答えを渡さないので、`manager_answer` で答えても古いセッションへは届かない。答えられるように見せると、答えたのに止まったままになる。
   * 日誌は `escalation` ではなく `decision` に書く: `escalation` は答えを待つ確認として数えられるため。
   */
  async #noticeAskFromUnreplacedSession(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'ask' }>,
    fromRunnerId: string,
  ): Promise<boolean> {
    const tracked = record.sessionGeneration;
    if (tracked === undefined || !trackedGenerationSilent(record)) return false;
    if (record.job.status === 'stopped') return false;
    if (record.job.runnerId !== undefined && record.job.runnerId !== fromRunnerId) return false;
    const asked = this.#waiting.askedOf(record);
    if (asked.has(event.requestId)) return true;
    asked.set(event.requestId, true);
    const managerId = event.managerId;
    await this.#journal({
      type: 'decision',
      decision: `[${managerId}] 古いセッションの確認の要求だが、起こし直した新しいセッションがまだ何も出していないので、捨てずにクローンへ知らせる（答えは届かない。#5203）`,
      grounds:
        `いま追っている世代=${tracked} この確認の世代=${event.sessionGeneration ?? '不明'} ` +
        `runnerId=${fromRunnerId} requestId=${event.requestId} kind=${event.kind} 内容: ${excerptLine(event.summary, WITHHELD_REPORT_EXCERPT)}`,
    });
    this.#emit(
      managerId,
      'report',
      [
        `[${managerId}] （alteroid より: 起こし直す前の古いセッションが確認を求めて止まっている。起こし直した新しいセッションはまだ何も出していない。#5203）`,
        `確認の種類: ${event.kind}`,
        `内容: ${event.summary}`,
        'この確認には manager_answer で答えても届かない（runner は答えを起こし直した新しいセッションへ渡し、古いセッションへの経路が無い）。古いセッションは答えを待ったまま止まり続ける。',
        '取れる手: 内容が要る仕事なら、manager_send で新しいセッションに同じことを頼み直す。古いセッションは runner の名簿に居ないので manager_stop の対象にならない — 止める必要があれば人間へ上げる。',
      ].join('\n'),
    );
    return true;
  }

  /**
   * 古い世代の報告でも、いま追っている世代がまだ1つも出来事を出していなければ、捨てずにクローンへ配る（#5195）。配ったら `true`。
   *
   * 起こし直した新しいセッションが黙ったまま、古いセッションが生きてターンを回し続け、その完遂の報告が全部「古いセッションの出来事」として
   * 捨てられていた（2026-10-23 heosterra。担当は報告したつもりで待ち、PR が誰にも拾われなかった）。生きて話しているのは古い側なので、聞く。
   * 新しい世代が一度でも出来事を出したら、今どおり捨てる（そちらが本物で、古い側は畳みの遅れである）。
   *
   * 配るのは本文と台帳の `lastReport` まで。`status`・枠の印・鍵の回転には触らない: 台帳が追っているのは新しいセッションで、
   * 古い側の `done` で書き換えると、次の送りが走っている新しいセッションを畳むため。失敗の報告（`failure`）も今どおり捨てる:
   * 古い鍵の失敗で枠の印や回転を動かさないため。止めた担当・別の runner へ移った担当の古い報告も今どおり捨てる。
   */
  async #deliverReportFromUnreplacedSession(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'report' }>,
    fromRunnerId: string,
  ): Promise<boolean> {
    const tracked = record.sessionGeneration;
    if (tracked === undefined || !trackedGenerationSilent(record)) return false;
    if (event.failure !== undefined) return false;
    if (record.job.status === 'stopped') return false;
    if (record.job.runnerId !== undefined && record.job.runnerId !== fromRunnerId) return false;
    if (event.reportId !== undefined) {
      const reported = this.#reportedOf(record);
      if (reported.has(event.reportId)) return true;
      reported.set(event.reportId, true);
    }
    const managerId = event.managerId;
    record.job.lastReport = event.text;
    record.job.lastReportAt = this.#nowIso();
    record.job.lastReportStatus = event.status;
    delete record.job.lastFoldedTurn;
    await this.#persist(record);
    await this.#journal({
      type: 'decision',
      decision: `[${managerId}] 古いセッションの報告だが、起こし直した新しいセッションがまだ何も出していないので、捨てずにクローンへ配る（#5195）`,
      grounds:
        `いま追っている世代=${tracked} この報告の世代=${event.sessionGeneration ?? '不明'} ` +
        `runnerId=${fromRunnerId} 報告が名乗った status=${event.status} 台帳の status=${record.job.status}（書き換えない）`,
    });
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_REPLY_PREFIX}[${managerId}] ${event.text}`,
    );
    const reportFiles =
      (event.files?.length ?? 0) > 0 || (event.rejectedFiles?.length ?? 0) > 0
        ? await this.#fetchReportFiles(event, fromRunnerId)
        : undefined;
    const carriesFiles =
      reportFiles !== undefined &&
      (reportFiles.attachments.length > 0 || reportFiles.rejected.length > 0);
    if (event.contentless === true && !carriesFiles) return true;
    this.#emit(
      managerId,
      'report',
      `[${managerId}] （alteroid より: 起こし直す前の古いセッションからの報告。起こし直した新しいセッションはまだ何も出していないので、捨てずに配る。` +
        `台帳の状態は ${record.job.status} のまま書き換えていない。#5195）\n\n${event.text}`,
      undefined,
      undefined,
      'full',
      event.unreported !== undefined,
      carriesFiles ? reportFiles : undefined,
    );
    return true;
  }

  /** 確かめてから立てるまでに `await` を挟まない: 挟むと別の契機が同じ判断をし、同じ仕事が二重に走って同じコミットや PR が二度出る。 */
  async #resumeOnce(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
    attachments?: RunnerAttachment[],
    onClaimed?: () => void,
  ): Promise<ResumeOutcome> {
    const id = record.job.id;
    // 理由は真偽値ではなく返り値（`ResumeOutcome`）で運ぶ: 呼び手が残っていた断りから推測して「待てば通る」と誤って言うため。
    if (this.#resuming.has(id)) return 'busy';
    this.#resuming.add(id);
    try {
      return await this.#resume(record, runner, message, attachments, onClaimed);
    } finally {
      this.#resuming.delete(id);
    }
  }

  #sighting(runnerId: string): LeaseSighting {
    return sightingOf(this.#runners.entries(), runnerId);
  }

  #runnerSwappedSinceSession(record: ManagerRecord, runner: RunnerClient): boolean {
    return runnerSwappedSince(record.job, this.#sighting(runner.runnerId).instanceId);
  }

  #shouldRelocateFrom(runnerId: string): boolean {
    return shouldRelocateFromRoster(this.#runners.entries(), runnerId);
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
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_FAILURE_PREFIX}[${managerId}] ${describeAmbiguousSighting(runnerId, duplicates)}`,
    );
    this.#postReport(
      managerId,
      `${describeAmbiguousSighting(runnerId, duplicates)} ` +
        '**新しく起こし直さないこと** — 起こし直すと同じ仕事が2本になりえます。',
    );
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
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${managerId}] runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。`,
    );
    this.#postReport(
      managerId,
      `runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。以後は自動で引き取ります。`,
    );
  }

  /**
   * 関門を契機（`restore` / `hello` / `manager_send`）ごとに置かない: 足し忘れた契機だけが素通しになり、二重実行が起きるまで見えない。`#resume` は3つとも通る。
   * 断っても回数で諦めない: 持ち主が握っている間だけの話で待てば通る。諦めると、台帳では走っているのに誰も走っていない仕事が残る。
   */
  async #claimForResume(record: ManagerRecord, runner: RunnerClient): Promise<boolean> {
    const now = this.#now();
    const verdict = judgeClaimAgainst(
      this.#runners.entries(),
      record.job.lease,
      runner.runnerId,
      now,
    );

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
      ttlMs: LEASE_TTL_MS,
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

  /** `onClaimed` は貸し出しの関門を通った直後に1回だけ呼ぶ（断られた回・関門より前に断った回は呼ばない）。 */
  async #resume(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
    attachments?: RunnerAttachment[],
    onClaimed?: () => void,
  ): Promise<ResumeOutcome> {
    const { sessionId, cwd, request, projectKey } = record.job;
    if (sessionId === undefined) return 'no-session';

    // `#claimForResume` / `SessionLoaders#loadSession` より前に断る: 後段（貸し出し・生ログ取得）が空振りする前に分かる条件。
    if (cwd === undefined && !runner.workspacePathKnown) return 'workspace-path-unknown';

    if (!(await this.#claimForResume(record, runner))) return 'held-by-lease';
    onClaimed?.();

    // runner のディスクに生ログが残っている前提を置かない: 器は作り直される。
    const material = await this.#sessionLoaders.loadSession(projectKey, sessionId);

    // 引けなかったものを「無い」として進めない: 材料無しで resume すると `resume_failed` の `recovered: false` が `lost` に確定し、一時的に DB が読めなかっただけで委譲が恒久に終端する。
    if (material.kind === 'unreadable') return 'unreadable';

    const { subagents, peers } =
      material.kind === 'loaded' && projectKey !== undefined
        ? await this.#loadResumeCompanions(record.job.id, projectKey, sessionId)
        : { subagents: [], peers: [] };

    // チェックポイント1: `#claimForResume` の後・`runner.resume()` の直前に置く。前に置くと確認から呼び出しまでの窓が開くだけで得が無く、呼ぶ前に見送れる回は実 I/O を減らす。
    if (record.stopConfirmedAt !== undefined) return 'stopped-meanwhile';

    // 応答の `cwd` と比べる基準は `record.job.cwd`（`undefined` のことがある）ではなくこの値。
    const requestedCwd = cwd ?? runner.workspacePath;
    const resumed = await this.#issueResume(record, runner, {
      sessionId,
      requestedCwd,
      request,
      message,
      attachments,
      material,
      subagents,
      peers,
    });
    this.#noteResumedCwd(record, runner, resumed, requestedCwd);

    // チェックポイント2: ここで `record.attached` などを書くと、止めたつもりの委譲が「走っているはず」を名乗ったまま誰にも追われなくなる。
    // `record.job.status` は書かない（`abort()` が `'stopped'` を書いて `#persist()` 済み）。畳み直せなかったときは、台帳は「止めた」なのに runner にセッションが生き残る最も危ない不一致なので黙らない。
    if (record.stopConfirmedAt !== undefined) {
      await this.#settleStoppedAfterResume(record, runner);
      return 'stopped-meanwhile';
    }

    this.#recordResumed(record, runner, resumed, material, projectKey);
    return 'resumed';
  }

  /** `#resume` の段: 主の記録が戻る回に、作業者（subagents）と peer の記録を引く（呼び元が条件を見てから呼ぶ）。 */
  async #loadResumeCompanions(
    managerId: string,
    projectKey: string,
    sessionId: string,
  ): Promise<{
    subagents: Awaited<ReturnType<SessionLoaders['loadSubagents']>>;
    peers: Awaited<ReturnType<SessionLoaders['loadPeers']>>;
  }> {
    // 主の記録が戻る回だけ作業者の分も戻す: 主が無い回に作業者だけ戻しても、続ける会話が無い
    const subagents = await this.#sessionLoaders.loadSubagents(managerId, projectKey, sessionId);
    // peer（Codex）の記録も同じ条件で戻す: 主が無ければ、peer の続きを頼む担当の会話そのものが無い
    const peers = await this.#sessionLoaders.loadPeers(managerId, projectKey, sessionId);
    return { subagents, peers };
  }

  /** `#resume` の段: 世代を下ろして `#restored.begin` を立て、`runner.resume()` を出す（応答が返らない失敗は一覧で確かめ、居なければ `#restored.end` して投げる）。 */
  async #issueResume(
    record: ManagerRecord,
    runner: RunnerClient,
    args: {
      sessionId: string;
      requestedCwd: string;
      request: string | undefined;
      message: string | undefined;
      attachments: RunnerAttachment[] | undefined;
      material: Awaited<ReturnType<SessionLoaders['loadSession']>>;
      subagents: Awaited<ReturnType<SessionLoaders['loadSubagents']>>;
      peers: Awaited<ReturnType<SessionLoaders['loadPeers']>>;
    },
  ): Promise<Partial<Awaited<ReturnType<RunnerClient['resume']>>>> {
    const { sessionId, requestedCwd, request, message, attachments, material, subagents, peers } =
      args;
    // 出す直前に追っている世代を下ろす: 応答が返るまで（失敗して返らなければその後も）世代の判定はしない。
    delete record.sessionGeneration;
    // 応答より前に立てる: 新しいセッションの出来事は resume の応答より先に届きうる（`manager-report-before-resume-response.test.ts`）。
    this.#restored.begin(record.job.id, runner.runnerId);
    // 応答が返らず一覧で引き取った回（下の `resumed = {}`）だけは、runner が開いた値を持たない
    let resumed: Partial<Awaited<ReturnType<RunnerClient['resume']>>>;
    try {
      resumed = await runner.resume({
        managerId: record.job.id,
        sessionId,
        cwd: requestedCwd,
        request: request ?? record.job.summary,
        ...(message === undefined ? {} : { message }),
        ...(message === undefined || attachments === undefined || attachments.length === 0
          ? {}
          : { attachments }),
        ...(material.kind === 'loaded' ? { entries: material.entries } : {}),
        ...(subagents.length === 0 ? {} : { subagents }),
        ...(peers.length === 0 ? {} : { peers }),
        ...(record.job.lease === undefined
          ? {}
          : { lease: { fence: record.job.lease.fence, ttlMs: record.job.lease.ttlMs } }),
      });
    } catch (error) {
      // 応答の無い失敗（期限切れ・接続の断）は「効かなかった」と決めず、runner の一覧で確かめる（#4715）: runner は受け取って
      // セッションを起こしたのに応答だけが返らないことがあり、効かなかった側へ倒すと、生きているセッションを引き取らないまま
      // その出来事を「移った後の古い runner」として捨て続けるため。runner が答えた失敗（`RunnerHttpError`）は確かめずにそのまま投げる
      const alive =
        error instanceof RunnerHttpError
          ? false
          : await listRunnerManagers(runner)
              .then(
                (listing) =>
                  listing.states.some((state) => state.managerId === record.job.id) ||
                  listing.unreadableIds.includes(record.job.id),
              )
              .catch(() => false);
      if (!alive) {
        this.#restored.end(record.job.id);
        throw error;
      }
      // 世代は分からないので持たない（応答が運ぶもの）: 世代の判定は「不明」として出来事を受ける
      resumed = {};
      await this.#journal({
        type: 'decision',
        decision: `[${record.job.id}] resume の応答が返らなかったが、${runner.runnerId} にセッションが居るので、resume は効いたとして引き取った`,
        grounds: `resume の失敗: ${reasonOf(error)}。${runner.runnerId} の一覧にこの委譲が居た`,
      });
    }
    return resumed;
  }

  /** `#resume` の段（同期）: 応答の `cwd` が頼んだ値と違えば、台帳の `cwd` と locator を直して `cwdSwapNotice` を立てる。 */
  #noteResumedCwd(
    record: ManagerRecord,
    runner: RunnerClient,
    resumed: Partial<Awaited<ReturnType<RunnerClient['resume']>>>,
    requestedCwd: string,
  ): void {
    // 応答が返らず引き取った回（`resumed.cwd` が無い）は何もしない: 「未確認」を `requestedCwd` で埋めると、倒れていた回まで「頼んだとおり開けた」と嘘をつく。
    // 倒れたかは応答後にしか分からず、resume 前に組む「移送の一言」へ混ぜられないので `cwdSwapNotice` で伝える。前回の通知は持ち越さない。
    record.cwdSwapNotice = undefined;
    if (resumed.cwd !== undefined && resumed.cwd !== requestedCwd) {
      record.job.cwd = resumed.cwd;
      record.job.workspace = workspaceLocatorFrom(this.#workspace, runner.runnerId, resumed.cwd);
      record.cwdSwapNotice = { requested: requestedCwd, actual: resumed.cwd };
    }
  }

  /** `#resume` の段: resume の後で止められていた委譲を畳み直す（呼び元が `stopConfirmedAt` を見てから呼ぶ）。 */
  async #settleStoppedAfterResume(record: ManagerRecord, runner: RunnerClient): Promise<void> {
    this.#restored.end(record.job.id);
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
  }

  /** `#resume` の段（同期）: 受理された resume を台帳と pool の欄へ写す。await が無い並びなので途中で切らない。 */
  #recordResumed(
    record: ManagerRecord,
    runner: RunnerClient,
    resumed: Partial<Awaited<ReturnType<RunnerClient['resume']>>>,
    material: Awaited<ReturnType<SessionLoaders['loadSession']>>,
    projectKey: string | undefined,
  ): void {
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
    // 生きていた旧プロセスへ流しただけの回は立てない: 会話はそのプロセスが持っている。
    // 預け先が在って引けた結果が空だった回だけ立てる: 預け先の無い構成（fs）や鍵（projectKey）の無い古い行では、`absent` は「無いと確かめた」ではない。
    record.resumedWithoutLog =
      this.#stores.sessionStore !== undefined &&
      projectKey !== undefined &&
      material.kind === 'absent' &&
      resumed.reusedLiveSession !== true;
    this.#unresumable.delete(record.job.id);
    this.#resumedCount.set(record.job.id, (this.#resumedCount.get(record.job.id) ?? 0) + 1);
  }

  #swapNote(runnerId: string, before: string | undefined): string {
    return swapNoteOf(this.#sighting(runnerId).instanceId, before);
  }

  async #onEvent(event: RunnerEvent, fromRunnerId: string): Promise<void> {
    // 札は最初の `await` より前に取る（理由は `UsageRecordOrder`、`usage.ts`）。
    const usageTicket =
      event.type === 'usage' ? this.#usageOrder.ticket(`manager:${event.managerId}`) : undefined;
    // 返すのは処理の終わり（`finally`）: 途中で return・throw しても後の預けを止めないため
    const releaseMirrorTurn =
      event.type === 'mirror' ? this.#archiveReceiver.takeMirrorTurn(event) : undefined;
    const fetchGate = this.#enterReportFetchGate(event);
    try {
      // 待つ相手が無いときは `await` を挟まない（余計な yield が並行した出来事の順序を変えるため）
      if (fetchGate.wait !== undefined) await fetchGate.wait;
      await this.#handleEvent(event, fromRunnerId, usageTicket);
    } finally {
      usageTicket?.release();
      releaseMirrorTurn?.();
      fetchGate.release();
      // 非同期の続き（台帳の読み書き・日誌）まで終えた印（#4485）: `runner-event-handled` は同期の部分が返った印で、止まった窓がその後に印なしで続くと、続きの中か外かを分けられないため
      notePhase(`runner-event-settled:${event.type}`);
    }
  }

  /**
   * 計測・生ログのような状態を動かさない出来事は待たせない。門は `OUTBOX_FETCH_TOTAL_TIMEOUT_MS` で必ず開く。
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

  /** 取りに行かないと決めた出来事の出し箱・預かりを、runner へ DELETE して退避先ごと消させる（#4925）。失敗は握る。 */
  async #discardRunnerPickups(event: RunnerEvent, fromRunnerId: string): Promise<void> {
    const targets: { fileId: string; kind: 'outbox' | 'rescue' }[] = [];
    let managerId: string;
    if (event.type === 'report') {
      managerId = event.managerId;
      for (const file of event.files ?? []) targets.push({ fileId: file.fileId, kind: 'outbox' });
    } else if (event.type === 'rescue_files') {
      managerId = event.managerId;
      for (const file of event.files) targets.push({ fileId: file.fileId, kind: 'rescue' });
    } else {
      return;
    }
    if (targets.length === 0) return;
    const runner = await this.#runnerOrNull(fromRunnerId);
    if (runner === null) return;
    await Promise.allSettled(
      targets.map(async ({ fileId, kind }) => {
        await runner.deletePickupFile(kind, managerId, fileId, {
          signal: AbortSignal.timeout(5000),
        });
      }),
    );
  }

  /** 失敗は投げない: 取り出しの不調で報告を止めない。取れなかったものは名前と理由で返し、黙って落とさない。 */
  async #fetchReportFiles(
    event: Extract<RunnerEvent, { type: 'report' }>,
    fromRunnerId: string,
  ): Promise<ManagerReportFiles> {
    const files = event.files ?? [];
    const rejectedFiles = event.rejectedFiles ?? [];
    if (files.length === 0) return { attachments: [], rejected: rejectedFiles.map(rejectedFileOf) };
    const instanceBefore = this.#sighting(fromRunnerId).instanceId;
    const runner = await this.#runnerOrNull(fromRunnerId);
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
        swapNote: () => this.#swapNote(fromRunnerId, instanceBefore),
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
    if (this.#applyRunnerNotice(event, fromRunnerId)) return;

    if (event.type === 'scratch_sweep') {
      await this.#onScratchSweep(event, fromRunnerId);
      return;
    }

    if (event.type === 'codex_auth') {
      if (this.#codexAuth === undefined) return;
      const runner = await this.#runnerOrNull(fromRunnerId);
      await this.#codexAuth.onRunnerNotice(event, fromRunnerId, runner);
      return;
    }

    const record = this.#records.get(event.managerId) ?? (await this.#load(event.managerId));
    if (!record) {
      // 台帳に無い担当の出来事: 取りに行かない出し箱・預かりも消させる（#4925）。消さないと runner の畳みが、取られない退避先を上限まで待つ
      await this.#discardRunnerPickups(event, fromRunnerId);
      return;
    }

    this.#observeSessionGeneration(record, event);
    const generation = this.#judgeSessionGeneration(record, event);
    if (generation === 'stale' && isSessionScopedEvent(event)) {
      await this.#dropStaleSessionEvent(record, event, fromRunnerId);
      return;
    }

    // 古い世代の出来事を捨てた後に見る: 前のセッションの遅れた出来事で「戻れた」と確定しないため。
    this.#restored.observe(record, event, fromRunnerId);

    if (this.#resumeWindows.deferIfWindow(event, fromRunnerId)) return;

    // 移った後の古い runner の出来事は、この種類なら入口で捨てる（個別の判定は `closed` / `resume_failed` / `usage` / `rescue_files`: 捨て方が違う）。
    // `report` / `ask` は停止済みの扱い（日誌へ残す）が先: 停止済みなら下の case が受ける。
    if (
      MOVED_AWAY_IGNORED_EVENT_TYPES.has(event.type) &&
      !(record.job.status === 'stopped' && (event.type === 'report' || event.type === 'ask')) &&
      (await this.#ignoreIfMovedAway(record, fromRunnerId, event))
    ) {
      return;
    }

    switch (event.type) {
      case 'session': {
        return this.#session.handle(event, record, fromRunnerId);
      }

      case 'project_key': {
        if (record.job.projectKey === event.projectKey) return;
        record.job.projectKey = event.projectKey;
        await this.#persist(record);
        return;
      }

      case 'report': {
        return this.#handleReport(event, record, fromRunnerId);
      }

      case 'ask': {
        return this.#waiting.handleAsk(event, record);
      }

      case 'settled': {
        return this.#waiting.handleSettled(event, record);
      }

      case 'note': {
        // 作業者の落ちの印を立てる（#5030）。`await` の前に同期で立てる: 鍵の突き合わせの間にターンが終わっても、終わりの契機が印を見られるように。
        // `#usageStopped` と鍵の回転の観測（`#observeForTokenRotation`）へは流さない（#4903）。
        if (event.workerLimit !== undefined) {
          await this.#markWorkerLimitStopped(record, event.managerId, event.workerLimit);
        }
        // 作業者の落ちの note（`event.workerLimit` の欄で判定する）には、落ちた枠の鍵の突き合わせを1行足す（#5021）。日誌とクローンへの知らせの両方に同じ文を載せる。
        const noteText =
          event.workerLimit === undefined
            ? event.text
            : `${event.text}\n${await this.#usageWake.describeWorkerLimitKey(event.workerLimit.raw)}`;
        await this.#journalNote(event, noteText);
        this.#emitNoteNotices(event, noteText);

        // 逃すと自動で追いついたセッションにまで `manager_list` / `runner_list` の世代の食い違いが出続ける。世代の値は受け取らない: runner は世代を知らず、daemon が現役の身元を読み直す。
        if (event.tokenRotation === true) this.#rememberTokenIdentity(event.managerId);
        return;
      }

      case 'tool_use': {
        return this.#toolUse.handle(event, record);
      }

      case 'permission_denied': {
        return this.#denial.handle(event, record);
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
        await this.#usageReceiver.onUsage(event, fromRunnerId, record, usageTicket);
        return;
      }

      case 'parked_peers_closed': {
        return this.#parkedPeers.handle(event, record);
      }

      case 'peer_usage': {
        await this.#usageReceiver.onPeerUsage(event);
        return;
      }

      case 'context_usage': {
        await this.#usageReceiver.onContextUsage(event);
        return;
      }

      case 'usage_notice': {
        await this.#usageReceiver.onUsageNotice(event, record);
        return;
      }

      case 'rate_limit': {
        await this.#usageReceiver.onRateLimit(event);
        return;
      }

      case 'mirror': {
        await this.#archiveReceiver.onMirror(event);
        return;
      }

      case 'archive': {
        await this.#archiveReceiver.onArchive(event, fromRunnerId, record);
        return;
      }

      case 'resume_failed': {
        return this.#handleResumeFailed(event, record, fromRunnerId);
      }

      case 'closed': {
        const ignored = this.#ignoreOrDeferClosed(record, event, fromRunnerId, generation);
        if (ignored !== false) {
          await ignored;
          return;
        }
        const unchanged = this.#closeWithoutTransition(record, event);
        if (unchanged !== false) {
          await unchanged;
          return;
        }
        await this.#closeJob(record, event);
        return;
      }

      case 'shutdown_unpushed_work': {
        // best-effort: 届かなかった回はこの `case` が呼ばれないので「0件」を作らない（既存の観測は残り、`unavailable` と「届いていない」を混同しない）。`source: 'shutdown'` を明示する。
        // `record.job.status` には触れない: `stop()` が `closed` を出さない設計を変えず、`case 'closed'` の他の判断は持ち込まない。
        await this.#recordUnpushedWorkObservation(
          record,
          event.unpushedWork,
          'shutdown',
          undefined,
          this.#sighting(fromRunnerId).instanceId,
        );
        return;
      }

      case 'external_output': {
        // 日誌には書かない: 道具の呼び出しそのものが `tool_use` の行として入力ごと日誌に残っているため（二重に書かない）
        record.job.externalOutputs = [...(record.job.externalOutputs ?? []), event.output].slice(
          -externalOutputLimits.keptPerJob,
        );
        await this.#persist(record);
        return;
      }

      case 'rescue_ref': {
        // #6193: 移った後の古い器からは取り込まない（後勝ちで今の器の項目を古い内容で上書きするため）。
        // `rescue_files` と違い消させる物は無いので DELETE はせず、日誌にだけ残す。
        if (await this.#ignoreIfMovedAway(record, fromRunnerId, event)) return;
        await this.#rescueStash.acceptRef(record, event, fromRunnerId);
        return;
      }

      case 'rescue_files': {
        // #4924: 移った後の古い器からは取り込まない。退避先は、捨てる回も消させる（器の退避先と待ちの集合に積み残さない）
        if (this.#movedAwayFrom(record, fromRunnerId)) {
          const runner = await this.#runnerOrNull(fromRunnerId);
          if (runner !== null) {
            for (const file of event.files) {
              await runner
                .deletePickupFile('rescue', event.managerId, file.fileId, {
                  signal: AbortSignal.timeout(5000),
                })
                .catch(() => undefined);
            }
          }
          await this.#ignoreIfMovedAway(record, fromRunnerId, event);
          return;
        }
        await this.#rescueStash.acceptSerially(record, event, fromRunnerId);
        return;
      }

      case 'rescue_restore_request': {
        // 届けは待たない: 担当が畳まれていれば resume を挟み、出来事の処理を長く塞ぐため。失敗は日誌に残す
        void this.#rescueStash.restore(record, event).catch((error: unknown) => {
          noteDroppedRecord('預かりの取り戻し', `managerId=${event.managerId}`, error);
        });
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

  /** 担当の出来事 `report` の1件を処理する（`#handleEvent` が振り分ける）。 */
  async #handleReport(
    event: Extract<RunnerEvent, { type: 'report' }>,
    record: ManagerRecord,
    fromRunnerId: string,
  ): Promise<void> {
    // 止めた後に届く `report` を無条件に処理しない: `#retire()` 後も `#onEvent` は台帳から像を作り直す（`#load()`）ので、`stopped` を上書きし `#emit()` でクローンのターンを起こしてしまう。日誌には残す（捨てると黙って失われる）。
    if (record.job.status === 'stopped') {
      await this.#recordStoppedReport(record, event, fromRunnerId);
      return;
    }
    // `reportId` で冪等にする（`ask` の `requestId` と同型）。
    // `reportId` を送らない旧 runner の report は拒まず毎回処理する: 無条件に捨てると本物の報告が消える。二重配達を見分けられないだけ。
    if (event.reportId !== undefined) {
      const reported = this.#reportedOf(record);
      if (reported.has(event.reportId)) return;
      reported.set(event.reportId, true);
    }
    const markedByFailure = this.#applyReportToJob(record, event);
    await this.#persist(record);
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}] ${reportFullTextOf(event)}`,
    );
    await this.#afterReportRecorded(event, markedByFailure);
    await this.#deliverReport(record, event, fromRunnerId);
    return;
  }

  /** 担当の出来事 `resume_failed` の1件を処理する（`#handleEvent` が振り分ける）。 */
  async #handleResumeFailed(
    event: Extract<RunnerEvent, { type: 'resume_failed' }>,
    record: ManagerRecord,
    fromRunnerId: string,
  ): Promise<void> {
    // 止めた後に遅れて届いた resume_failed で status を巻き戻さず、クローンも起こさない: 無条件に処理すると `running` / `'lost'` へ書き換えて `#post()` し、終端が甦る。日誌には残す。
    // 明示的な `manager_send` の起こし直しは塞がない: `send()` が先に `'running'` を書くので、遅れて届く頃には `'stopped'` ではない。
    if (record.job.status === 'stopped') {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] （停止済みのため無視）前のセッション` +
          `（${event.sessionId}）を開き直せなかった: ${event.reason}`,
      );
      return;
    }
    // 移った後に古い runner から遅れて届いた resume_failed で巻き戻さない。ただし「不一致」だけで「移った」と言わない: `job.runnerId` に既定値 `'runner-primary'` が焼かれたままだと、同じ runner からでも不一致になり、本当に終わった事実を捨ててしまう（`#resume` だけが書き直す）。
    // 捨てるのは `job.runnerId` が `#registeredRunnerIds()`（名簿にいま居る id）に含まれ、かつ `fromRunnerId` と食い違うときだけ。未記録の古いジョブと名簿が `null`（判定材料なし）のときは従来どおり適用する（安全側）。
    if (this.#movedAwayFrom(record, fromRunnerId)) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] （runner-id 不一致のため無視。` +
          `いまの宛先は ${record.job.runnerId}、この出来事は ${fromRunnerId} から）前のセッション` +
          `（${event.sessionId}）を開き直せなかった: ${event.reason}`,
      );
      return;
    }
    // 「resume を投げた」は「戻れた」ではない: SDK が会話を見つけられなかったので、台帳と受信箱を実際に起きたことへ揃え直す。
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] 前のセッション（${event.sessionId}）を開き直せなかった: ` +
        event.reason,
    );
    if (event.recovered) {
      await this.#recoverAfterResumeFailed(record, event);
      return;
    }
    await this.#giveUpAfterResumeFailed(record, event);
    return;
  }

  /** `#handleEvent` の入口の段: hello / anthropic_route / manager_peers の runner 名乗りを受ける（同期。当たれば true）。 */
  #applyRunnerNotice(
    event: RunnerEvent,
    fromRunnerId: string,
  ): event is Extract<RunnerEvent, { type: 'hello' | 'anthropic_route' | 'manager_peers' }> {
    if (event.type === 'hello') {
      this.#farewellRunners.delete(fromRunnerId);
      this.#farewellRunners.delete(event.runnerId);
      if (this.#stopped) return true;
      // 前の名乗りを持ち越さない: 同じ runnerId の器が入れ替わって版が下がりうる。
      this.#runnerCapabilities.set(event.runnerId, new Set(event.capabilities ?? []));
      this.#attachmentStager.noteHello(
        event.runnerId,
        event.attachmentBodyLimit,
        event.attachmentStageLimit,
      );
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
      return true;
    }

    if (event.type === 'anthropic_route') {
      if (this.#stopped) return true;
      this.#runnerAnthropicRoutes.set(event.runnerId, event.anthropicRoute);
      return true;
    }

    if (event.type === 'manager_peers') {
      if (this.#stopped) return true;
      this.#setRunnerManagerPeers(event.runnerId, event.managerPeers, event.managerPeersClosed);
      return true;
    }

    return false;
  }

  /** `#handleEvent` の入口の段: 古いセッションの出来事を、配る・知らせる・日誌に残して捨てる（呼び元が古い世代かどうかで呼ぶ）。 */
  async #dropStaleSessionEvent(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' | 'session' | 'report' | 'ask' | 'settled' }>,
    fromRunnerId: string,
  ): Promise<void> {
    if (
      event.type === 'report' &&
      (await this.#deliverReportFromUnreplacedSession(record, event, fromRunnerId))
    ) {
      return;
    }
    if (
      event.type === 'ask' &&
      (await this.#noticeAskFromUnreplacedSession(record, event, fromRunnerId))
    ) {
      return;
    }
    const dropped = await this.#droppedReportFiles(event, fromRunnerId);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （古いセッションの出来事のため無視。いま追っている世代は ` +
        `${record.sessionGeneration ?? '不明'}、この出来事の世代は ${event.sessionGeneration ?? '不明'}）` +
        (event.type === 'closed'
          ? `runner 側の終了イベント（status=${event.status}）を受け取った: ${event.reason}`
          : `古いセッションの ${event.type} を無視した`) +
        dropped.text,
      ...dropped.attachments,
    });
  }

  /** `note` の段1: 作業者の落ちの印を立てて台帳へ写す（呼び元が `event.workerLimit` の有無で呼ぶ）。 */
  async #markWorkerLimitStopped(
    record: ManagerRecord,
    managerId: string,
    workerLimit: NonNullable<Extract<RunnerEvent, { type: 'note' }>['workerLimit']>,
  ): Promise<void> {
    const mark = {
      preRotationKey: workerLimit.preRotationKey,
      turnStartedAt: record.job.turnStartedAt,
    };
    this.#workerLimitStopped.set(managerId, mark);
    // 台帳にも写す: デーモンが再起動しても印が残るように
    record.job.workerLimitStopped = { ...mark };
    await this.#persist(record);
  }

  /** `note` の段2: note を日誌へ残す（stall の有無で行の種類を分ける）。 */
  async #journalNote(
    event: Extract<RunnerEvent, { type: 'note' }>,
    noteText: string,
  ): Promise<void> {
    // 受信箱へは出さず日誌にだけ残す（マネージャーの発言ではない）。`escalate` の有無で変えない（下で足すだけ）。
    // `event.stall` の欄で判定し、本文の文字列で嗅がない。旧 runner の note は `stall` を知らず `exchange` に落ちる。
    if (event.stall === undefined) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_REPLY_PREFIX}[${event.managerId}] ${noteText}`,
      );
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
  }

  /** `note` の段3（同期）: `escalate` / `notifyClone` の欄に応じてクローンへの知らせを積む。 */
  #emitNoteNotices(event: Extract<RunnerEvent, { type: 'note' }>, noteText: string): void {
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

    // 欄（`event.notifyClone`）で判定し、本文を嗅がない（#4685）: 成果が失われうる知らせは、日誌だけだとクローンが引かない限り見えないため
    if (event.notifyClone === true) {
      // 作業者の落ちには、積んだ時点の担当の鍵の世代を添えて「別の世代へ移って戻ったら畳んでよい」と印を付ける（#5048）。世代が分からなければ付けない
      const heldGeneration = this.#tokenIdentities.get(event.managerId)?.generation;
      this.#emit(
        event.managerId,
        'report',
        `[${event.managerId}] ${noteText}`,
        undefined,
        undefined,
        'full',
        false,
        undefined,
        event.workerLimit === undefined || heldGeneration === undefined
          ? undefined
          : { movedFromGeneration: heldGeneration },
      );
    }
  }

  /** `resume_failed` の段1: 前のセッションを開き直せなかったが runner が自力で戻れた回の台帳・知らせを整える。 */
  async #recoverAfterResumeFailed(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'resume_failed' }>,
  ): Promise<void> {
    // 終端を `running` で書き戻さない: 待つ間に `closed(failed / lost)` が書いていると台帳が非終端へ戻る。
    if (record.job.status !== 'failed' && record.job.status !== 'lost') {
      record.job.status = 'running';
    }
    record.attached = true;
    this.#noteRunnerSessionSince(record);
    await this.#persist(record);
    this.#notifyResumeFallback(record, event.sessionId, event.reason);
  }

  /** `resume_failed` の段2: 戻れなかった委譲を `lost` へ落として諦め、枠の印と像を片付ける。 */
  async #giveUpAfterResumeFailed(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'resume_failed' }>,
  ): Promise<void> {
    // 待っても同じ答えが返る失敗なので自動の挑み直しを打ち切る: 続けても同じ障害通知が積み上がるだけ。明示的な `manager_send` は塞がない。
    this.#unresumable.add(event.managerId);
    // 諦めをプロセス内の記憶だけに置かない: `#unresumable` は器と一緒に消え、次のデプロイでまた同じ死体を起こしに行って失敗する。台帳を終端へ落として再起動の向こうまで持たせる。
    record.job.status = 'lost';
    record.attached = false;
    // `closed` と揃えて畳む: `#retire` で像ごと消すので、「消える時点で waiting が空」を呼び出し元の代入に頼らせない。
    this.#withdrawWaiting(record, 'resume に失敗し、この委譲は戻らない');
    await this.#persist(record);
    this.#notifyUnresumable(record, event.reason, 'session');
    // 枠の印も一緒に下ろす: 台帳に残したままだと、諦めを持たせたはずの `lost` の死体を次のデプロイでまた起こしに行く。
    // ただし理由文が枠（429・枠の文言）のときは下ろさず立てて保つ（#4866）: 戻れなかった原因が鍵の枠なら、鍵を替えれば戻れる見込みがあり、下ろすと鍵の回転にも周回の掃きにも拾われないため。
    const reasonNotice = classifyUsageNotice(event.reason);
    const quotaReason = reasonNotice?.kind === 'reached' || isRateLimitReason(event.reason);
    this.#usageWakeOwed.delete(event.managerId);
    if (quotaReason) {
      this.#usageStopped.add(event.managerId);
      record.job.usageStoppedAt ??= this.#nowIso();
      // 書けなくても進む: 台帳に写せないのは再起動を跨ぐ分だけで、メモリの印で今回の回転は拾える。
      await this.#persist(record).catch((error: unknown) => {
        noteDroppedRecord('枠で止まった印の永続化', `managerId=${event.managerId}`, error);
      });
    } else {
      await this.#usageWake.clearUsageStoppedMark(event.managerId);
    }
    // 像を外す前に指紋を控える（`closed` の枝と同じ）
    const heldFingerprintAtRetire = this.#sessionTokenFingerprintOf(event.managerId);
    this.#retire(event.managerId);
    // 印を立てたら、使える鍵が在れば今すぐ起こし直してもらう（`closed` の枝と同じ）: `#retire` の後に置く理由も同じ。
    if (quotaReason) {
      await this.#usageWake.requestRotationForFailure(
        event.managerId,
        reasonNotice?.kind === 'reached' ? reasonNotice.text : event.reason,
        heldFingerprintAtRetire,
      );
    }
  }

  // `report` の段1: 止めた担当へ届いた報告を、受信箱へは回さず日誌と台帳にだけ残す。
  async #recordStoppedReport(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'report' }>,
    fromRunnerId: string,
  ): Promise<void> {
    // 添えられた成果物は取り寄せて置き場へ入れ、日誌の行に結び付ける（#4675）: 取り寄せないと runner の退避先に残ったまま掃除で消え、止めた担当の成果が黙って失われるため
    const stoppedFiles =
      (event.files?.length ?? 0) > 0 || (event.rejectedFiles?.length ?? 0) > 0
        ? await this.#fetchReportFiles(event, fromRunnerId)
        : undefined;
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （停止済みのため受信箱へは回さない）${reportFullTextOf(event)}` +
        describeStoppedReportFiles(stoppedFiles),
      ...(stoppedFiles === undefined || stoppedFiles.attachments.length === 0
        ? {}
        : { attachments: stoppedFiles.attachments.map((ref) => ({ ...ref })) }),
    });
    // 本文は台帳にも残す: 日誌だけだと、誤って止めたことに気づく契機が `manager_stop` / `manager_report` のどちらにも出ない。`record.job.status` は動かさず `#emit()` もしない。
    record.job.lastFoldedTurn = {
      text: reportFullTextOf(event),
      at: this.#nowIso(),
    };
    await this.#persist(record);
  }

  // `report` の段2: 報告の中身を台帳（`record.job`）へ写す。同期のまま保つ（`await` を挟むと並行の出来事に先を越される）。枠の印を新しく立てたら `true`。
  #applyReportToJob(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'report' }>,
  ): boolean {
    // 台帳と日誌には全文を残す: `manager_report` と画面の「最後の報告」は `lastReport` を読むので、途中の発言を見たいときはそこから引ける
    record.job.lastReport = reportFullTextOf(event);
    // `#noteRunnerSessionSince` と同じ時計（`this.#now()`）で書く: `reportSeenInSession` が前後を比べるので、別の時計だと注入した時計の試験で崩れる。
    record.job.lastReportAt = this.#nowIso();
    // 並行処理の間に `closed(failed / lost)` が書いた終端を `event.status` で書き戻さない: 台帳は非終端のままクローンに `closed_failed` が出る／`lost` の引き取りの契機が消える。
    // `isTerminalJobStatus` は使わない: `done` を含むが、`done` は idle を兼ね再び走り出せる。managerId ごとの直列化は配達順に効くので採らない。
    const settledByClosed = record.job.status === 'failed' || record.job.status === 'lost';
    // 畳む直前の書き出し（`unreported`）は、台帳を `failed` / `lost` にしない（#4963）: 状態は直後に必ず届く `closed` が決める。
    // ここで終端にすると、続く `closed(failed)` が「確定済みへの重複」として捨てられ、`closed` にしか無い処理（失敗の行と cgroup の注記・`lastSystemError` / `lastCgroupEvents`・器の失敗の計上・pids の飽和の印・`closed_failed` の知らせ）が全部飛ぶ。
    const deferTerminalToClosed =
      event.unreported !== undefined && (event.status === 'failed' || event.status === 'lost');
    if (!settledByClosed && !deferTerminalToClosed) record.job.status = event.status;
    // 背景処理の完了待ちで閉じた `done` は、台帳の `status` では idle と見分けられないので、印を別の欄に立てる（`ManagerTaskLink#sync` が task を倒さない根拠）。
    // 背景待ちでない報告では下ろす。`done` 以外の状態へ動く書き込みは `#persist` が下ろす。
    if (event.awaitingBackground !== undefined && record.job.status === 'done') {
      record.job.awaitingBackgroundSince = this.#nowIso();
    } else {
      delete record.job.awaitingBackgroundSince;
    }
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
    // この報告で枠の印を新しく立てたか（下の失敗の枝）。立てた回だけ、使える鍵が在れば今すぐ回すよう回し手へ頼む。
    let markedByFailure = false;
    // 失敗として終わった回は台帳にもそう残す: 包んだ文字列だけに頼ると、一覧を出す側は「報告が来た」と「エラーで死んだ」を本文の先頭を読んで判定することになる（＝ 表示のたびに文言の判定が要る）。
    // 応答として終わった回では消す: 過去の失敗が生きているマネージャーに貼り付く。`delete` なのは `exactOptionalPropertyTypes` のため。
    if (event.failure === undefined) {
      delete record.job.lastFailure;
      // 枠で止まった印は成功した回で下ろす（失敗の回では下ろさない: そこが起こし直したい相手）。印は `reached` の通知でターンの途中にも立つので、残すと通り切ったマネージャーが「枠で止まっている」ことになり、鍵が回るたびに1ターン焼く。
      this.#usageStopped.delete(event.managerId);
      this.#resetTimeSkewMatches.delete(event.managerId);
      // `UsageWake#clearUsageStoppedMark` を呼ばず直接 `delete`: すぐ下の `#persist` に乗せるので、呼ぶと二重に書き込む。
      delete record.job.usageStoppedAt;
    } else {
      // `status` は台帳へ写さない: 枠の束の判定にだけ使う値で、`lastFailure` の欄（code / via）を増やさない。
      record.job.lastFailure = {
        code: event.failure.code,
        via: event.failure.via,
        at: this.#nowIso(),
      };
      // 429・枠の失敗は、枠の通知（`usage_notice`）が先に届かなくても印を立てる（#4850）: 通知は本文の文言でしか出ないので、構造化された失敗（`status=429` など）だけで落ちたターンは印が無く、鍵が回っても起こし直しの対象に入らなかった。クラッシュなど枠と無関係な失敗は `isQuotaFailure` が偽なので立てない。
      // 同期の位置で立てる（`usage_notice` と同じ理由）: 間に `await` を挟むと並行の出来事に先を越される。永続化は下の `#persist` に乗せる。
      if (isQuotaFailure(event.failure) && !this.#usageStopped.has(event.managerId)) {
        this.#usageStopped.add(event.managerId);
        record.job.usageStoppedAt ??= this.#nowIso();
        markedByFailure = true;
      }
    }
    // `event.failure` の有無とは独立に判定する: 両方無いことも片方だけ在ることもある。
    if (event.unreported === undefined) {
      delete record.job.lastUnreported;
    } else {
      record.job.lastUnreported = {
        ...event.unreported,
        at: this.#nowIso(),
      };
    }
    return markedByFailure;
  }

  // `report` の段3: 台帳と日誌へ書いた後の、未 push の観測と枠の起こし直し。配達の判断（`#deliverReport`）の早い `return` より手前に置く。
  async #afterReportRecorded(
    event: Extract<RunnerEvent, { type: 'report' }>,
    markedByFailure: boolean,
  ): Promise<void> {
    // 待たない: 完了を待つと、報告を受けてからクローンのターンが起きるまでに runner への往復が乗る。`contentless` / `awaitingBackground` の早い `return` より手前に置く（後ろだと中身の無い報告・背景待ちの報告で観測が取られない）。停止済みの早期 return は通らないので、止めた委譲へ往復を起こさない。
    this.#observeUnpushedWorkOnce(event.managerId, 'report');
    // `contentless` / `awaitingBackground` の早い `return` より手前に置く: 後ろだと中身の無い報告で終わった回だけ起こされないまま残る。
    // 判定は `event.failure` ではなく印（`#usageStopped`）で行う: 失敗には SDK のクラッシュも混ざり、枠と無関係に落ちたターンへ「通る鍵に戻った」と言ってしまう。
    await this.#usageWake.settleUsageWake(event.managerId, this.#usageStopped.has(event.managerId));
    // 作業者の落ちで手を止めた担当は、ターンが `done` で終わったこの時点で起こす（回転前の鍵で落ちた印だけ。#5030）。
    await this.#usageWake.wakeForWorkerLimit(event.managerId, 'turn-ended');
    // 印を立てた直後に、使える鍵が在れば今すぐ起こし直してもらう（#4850）。起こし直しは回し手が鍵を回した後の `resumeStoppedByUsage()` に乗る。
    // 上の `UsageWake#settleUsageWake` が起こせて印が下りていれば頼まない: 要らない鍵の回転を起こさない。
    if (markedByFailure && this.#usageStopped.has(event.managerId)) {
      await this.#usageWake.requestRotationForFailure(
        event.managerId,
        failedReportBodyOf(event.text) ?? event.text,
      );
    } else if (event.failure !== undefined && this.#usageStopped.has(event.managerId)) {
      // 印がターンの途中の `usage_notice` で先に立っていた回も、失敗で終わったこの時点で起こし直す: 通知の枝は印を立てるだけで起こさず、
      // 回転の借りも挑み直しの状態も無ければ周回の掃きも拾わないので、次の鍵の回転まで止まる（古い鍵のセッションで回転の後も走っていた担当）。
      await this.#usageWake.wakeIfHeldTokenStale(event.managerId);
    }
  }

  // `report` の段4: 報告をクローンへ配るか畳むかを決めて配る。中身の無い報告・畳んだ報告・追い越された報告の早い `return` はすべてここに閉じる。
  async #deliverReport(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'report' }>,
    fromRunnerId: string,
  ): Promise<void> {
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
    // 外へ出した成果（マージ・PR の作成・push など）を含む報告は畳まない: 30分のまとめ配りまで待たせると、他の担当への連絡がその分遅れるため。判定は本文ではなく、runner が見た実際のコマンド（`outwardActions`）だけで行う
    if (event.awaitingBackground !== undefined && event.outwardActions !== undefined) {
      await this.#journal({
        type: 'decision',
        decision: `[${event.managerId}] 背景処理の完了待ちのターンだが、外へ出した成果を含むので受信箱へ回す`,
        grounds:
          `managerId=${event.managerId} ` +
          `outwardActions=${event.outwardActions.join(', ')} ` +
          `awaitingBackground.count=${String(event.awaitingBackground.count)}`,
      });
    }
    if (
      event.awaitingBackground !== undefined &&
      event.outwardActions === undefined &&
      !carriesFiles
    ) {
      const awaitingBackground = event.awaitingBackground;
      await this.#journal({
        type: 'decision',
        decision: `[${event.managerId}] 背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない`,
        grounds:
          `managerId=${event.managerId} ` +
          `awaitingBackground.count=${String(awaitingBackground.count)} ` +
          `breakdown=${awaitingBackground.breakdown} ` +
          `本文冒頭: ${excerptLine(event.text, WITHHELD_REPORT_EXCERPT)}`,
        routine: true,
      });
      // 畳む前に像と状態を見直す: 上の `await` の間に `abort()` / `#retire()` が走り切ると在庫が消えており、ここで積むと止めた委譲の報告を `flushWithheldReports()` が受信箱へ配ってしまう（#5504）。日誌の `decision` は事実として残す。
      if (record.job.status === 'stopped') return;
      // 人間・クローンが止めたのではなく、同じ担当の `closed`（done など）に追い越されて `#retire()` されただけなら、積まずに今すぐ配る: 積んでも `closed` はもう在庫を見終えており、`flushWithheldReports()` も像が無くて拾わないので、本文がクローンへ届かず消える。`closed` の「report 無し」の知らせは `lastReportAt` が書かれていて出ないので、二重にもならない。
      if (this.#records.get(event.managerId) !== record) {
        this.#emit(
          event.managerId,
          'report',
          this.#tokenSavingExcerpt ? reportDeliveryTextOf(event) : reportFullTextOf(event),
          undefined,
          undefined,
          'full',
          event.failure !== undefined || event.unreported !== undefined,
        );
        // 上で書いた「受信箱へは回さない」の decision は消せないので、実際には配ったことを日誌に足す（日誌だけ読む人に「配られていない」と読ませない）。
        await this.#journal({
          type: 'decision',
          decision: `[${event.managerId}] 同じ担当の closed に追い越されたので、畳まずに受信箱へ配った`,
          grounds:
            `managerId=${event.managerId} ` +
            `awaitingBackground.count=${String(awaitingBackground.count)} ` +
            `本文冒頭: ${excerptLine(event.text, WITHHELD_REPORT_EXCERPT)}`,
          routine: true,
        });
        return;
      }
      this.#withheld.withhold(event.managerId, event.text, awaitingBackground);
      return;
    }
    // `event.text` を包まない: runner 側で複数の書き手（マネージャー・SDK・runner）の断片が既に1本の文字列に連結されており、この層には `codeSpan()` で包む境目が無い。包むなら連結する側（`runner.ts`）。
    // `foldedTurn` は本文の文言ではなく構造化された印（`event.failure` / `event.unreported`）だけで判定する。
    const foldedTurn = event.failure !== undefined || event.unreported !== undefined;
    // `synthesized` が無い（旧 runner）ときは常に即配る側へ倒す: 版がずれた窓では必ず「起こす側」にする。
    // 合流窓へ積む枝では `foldedTurn` を渡さない: 複数の断片を1本にまとめる口で単発の bool を渡す場所が無く、`#flushSynthesizedNoticeFor` が `label` から判定し直す。
    if (event.synthesized !== undefined && !carriesFiles) {
      // 枠の印は構造化された失敗（`failure.code` / `via` / `status`）だけで付ける。時刻の言い回しは SDK の本文（見出しと「失敗する前に出ていた本文」を除いた部分）からだけ読む: マネージャー本人の文に `resets` と書いてあっても拾わない。
      let quota: QuotaMark | undefined;
      if (
        event.synthesized === 'turn_failed' &&
        event.failure !== undefined &&
        isQuotaFailure(event.failure)
      ) {
        const body = failedReportBodyOf(event.text);
        const said = partialBeforeFailureOf(event.text);
        quota = quotaMarkOf(body === undefined ? {} : { text: body }, this.#now(), {
          ...(body === undefined ? {} : { sdkText: body }),
          ...(said === undefined ? {} : { said }),
        });
      }
      this.#queueSynthesizedNotice(event.managerId, event.synthesized, event.text, quota);
    } else {
      this.#emit(
        event.managerId,
        'report',
        // 系統3の節約が無効なら、途中の発言を含む全文を配る（#5269 の前の形）
        this.#tokenSavingExcerpt ? reportDeliveryTextOf(event) : reportFullTextOf(event),
        undefined,
        undefined,
        'full',
        foldedTurn,
        carriesFiles ? reportFiles : undefined,
      );
    }
  }

  // `closed` の段1: 停止済み・移送中と復帰窓の預かり・移った後の古い runner の `closed` を処理して抜ける。処理したらその完了の Promise（呼び元はそこで case を抜ける）、どれにも当たらなければ `false`。
  // `async` にしない: 当たらない回に呼び元の `await` が1周ぶん増えると、`closed` を同期の順で追う試験（`manager-onevent-stale-runner.test.ts`）と台帳の書き込みの時機がずれる。
  #ignoreOrDeferClosed(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
    fromRunnerId: string,
    generation: 'stale' | 'current' | 'unknown',
  ): Promise<void> | false {
    // 止めた後の `closed` で status を巻き戻さない: 無条件に `event.status` へ上書きすると終端が甦り、`failed` の枝がクローンへ `#emit()` する。日誌には残す。`#retire()` は `abort()` が済ませているので呼ばない。
    if (record.job.status === 'stopped') {
      return this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （停止済みのため無視）runner 側の終了イベント` +
          `（status=${event.status}）を受け取った: ${event.reason}`,
      );
    }
    if (this.#resumeWindows.deferClosedIfWindow(event, fromRunnerId, generation)) {
      return Promise.resolve();
    }
    // 移った後に古い runner から届いた closed で巻き戻さない: 無条件に処理すると `status` を書き換え、`releaseLease` でいま使われている新しい runner の貸し出しを解放して他の器が奪える状態になる。判定の理由は `case 'resume_failed'` の同じ判定を見る。
    if (this.#movedAwayFrom(record, fromRunnerId)) {
      return this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （runner-id 不一致のため無視。` +
          `いまの宛先は ${record.job.runnerId}、この出来事は ${fromRunnerId} から）runner 側の` +
          `終了イベント（status=${event.status}）を受け取った: ${event.reason}`,
      );
    }
    return false;
  }

  // `closed` の段2: 状態を動かさずに済ませる `closed`（lost 確定済み・failed の重複・自己失効）を、当たった枝へ振って処理する。処理したらその完了の Promise、どれにも当たらなければ `false`。
  // `async` にしない: 当たらない回に呼び元の `await` が1周ぶん増えるのを避ける（段1と同じ理由）。枝の順は変えない（`lost` が `selfFenced` より先）。
  #closeWithoutTransition(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): Promise<void> | false {
    if (record.job.status === 'lost') return this.#closedFront.closeAfterLost(record, event);
    if (
      record.job.status === 'failed' &&
      event.status === 'failed' &&
      !this.#resuming.has(event.managerId)
    ) {
      return this.#closedFront.closeDuplicateFailed(event);
    }
    if (event.selfFenced === true) return this.#selfFenced.closeSelfFenced(record, event);
    return false;
  }

  // `closed` の段3: 終端として確定させる本体。台帳へ写し、失敗・peer・report 無しの done・畳んだ報告を知らせ、像を外して起こし直す。
  async #closeJob(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): Promise<void> {
    this.#applyClosedToJob(record, event);
    await this.#persist(record, { sessionClosed: true });
    this.#notePidsSaturationAtClose(record, event);
    const markedByClosed =
      event.status === 'failed' ? await this.#noteClosedFailure(record, event) : undefined;
    this.#noticePeerCloseAtEnd(record, event);
    // report が無いまま `closed(done)` だけが届いたらクローンへ知らせる: 台帳は `done` になるが受信箱には何も出ず、成果が出ているかを誰も確かめないまま終わる。報告の後の idle としての `closed(done)` は無音。判定できないときは知らせる側へ倒す（`reportSeenInSession`）。
    // 背景処理の積み（`#withheld`）が在るときは重ねない: 直下の分岐が「この委譲は終わった」を配るので二重になる。本文を先に日誌へ書く（flush の前に落ちても辿れるように）。
    if (event.status === 'done' && !this.#withheld.has(event.managerId)) {
      await this.#noticeSilentDone(record, event);
    }
    this.#flushWithheldAtClose(event);
    // 像を外す前に控える: 再起動で引き取っただけのセッションの鍵は、像の上の指紋でしか分からない（`UsageWake#wakeIfHeldTokenStale`）
    const heldFingerprintAtClose = this.#sessionTokenFingerprintOf(event.managerId);
    this.#retire(event.managerId);
    // 印を立てた直後に、使える鍵が在れば今すぐ起こし直してもらう（#4850）。`#retire` の後に置く: 回し手が鍵を回して `resumeStoppedByUsage()` を呼ぶと `send()` が像を載せ直すので、手前だと `#retire` がそれを消す。
    if (markedByClosed !== undefined && this.#usageStopped.has(event.managerId)) {
      await this.#usageWake.requestRotationForFailure(
        event.managerId,
        markedByClosed,
        heldFingerprintAtClose,
      );
    } else if (
      (event.status === 'failed' || event.status === 'lost') &&
      this.#usageStopped.has(event.managerId)
    ) {
      // 印が既に立っていた担当（古い鍵のまま背景処理を待たされていた回、#5044）も、セッションが終わった時点で起こし直す:
      // 待つ理由（背景処理）はセッションと一緒に消えたのに、周回の掃きは待ちの上限（15 分）まで拾わず、その間 failed のまま止まる。
      // 落ちた理由の文で絞らない: 背景処理の完了で古い鍵のターンが起き、`exited with code 1` だけを残して落ちる形が在る（2026-10-19 HOUSE-17・PROFILE-2）。
      await this.#usageWake.wakeIfHeldTokenStale(event.managerId, heldFingerprintAtClose);
    }
    // 枠でセッションごと落ちた回は `report` が出ず、ここしか通らない。`#retire` の後で呼ぶ: 起こし直しは `send()` に相乗りし、像が無ければ台帳から読み直すので resume できる。逆順だと `#retire` が `send()` の載せ直した像を消す。
    await this.#usageWake.settleUsageWake(event.managerId, this.#usageStopped.has(event.managerId));
  }

  // `closed` の段3-1: 状態・貸し出し・直近の失敗の事実・未 push の観測を台帳（`record.job`）へ写す。同期のまま保つ。
  #applyClosedToJob(record: ManagerRecord, event: Extract<RunnerEvent, { type: 'closed' }>): void {
    record.job.status = event.status;
    // 閉じたのだから背景待ちの保留も下ろす（`closed(done)` は `status` が `done` のままなので `#persist` の掃除では落ちない）
    delete record.job.awaitingBackgroundSince;
    this.#withdrawWaiting(record, `セッションが閉じた（status=${event.status}）`);
    record.attached = false;
    // 貸し出しは期限を待たず返す（`closed` は持ち主自身が「もう走っていない」と言っている）: 返さないと引き取りが猶予のぶん遅れる。消さずに印を立てる: 消すと世代（`fence`）まで消え、遅れて届いた返却で runner の世代より小さい世代を渡し命令が拒まれ続ける。
    if (record.job.lease !== undefined) {
      record.job.lease = releaseLease(record.job.lease, this.#now());
    }
    // 台帳へも残す: 受信箱は流れるので、本文だけでは振り返る面（`manager_list` / `manager_report`）から復元できない。無い回に既定値を作らない。
    // 先に前の回の値を下ろす: 欄が無い回に下ろさないと、続けて `failed` で閉じたとき1回目の値が今回の落ち方として残る。`status` では絞らない。
    delete record.job.lastSystemError;
    if (event.status === 'failed' && event.systemError !== undefined) {
      record.job.lastSystemError = {
        ...event.systemError,
        at: this.#nowIso(),
      };
    }
    // `lastSystemError` と同じ理由・同じ条件（`failed` の回だけ）で、先に前の回の値を下ろす。
    delete record.job.lastCgroupEvents;
    if (event.status === 'failed' && event.cgroupEvents !== undefined) {
      record.job.lastCgroupEvents = {
        ...event.cgroupEvents,
        at: this.#nowIso(),
      };
    }
    // `unpushedWork` は `status` で絞らない: 「どの枝を見ればよいか」は失敗特有の事実ではない。同じ上書きガードを通す: `report` / `tool_use` の fire-and-forget が非同期に競走し、`closed` の処理より後に解決しうる。
    // `#recordUnpushedWorkObservation` を直接呼ばない: 自分で `#persist` するので、直後の `#persist` と二重に書き込む。
    if (event.unpushedWork !== undefined) {
      const at = this.#nowIso();
      const observation = unpushedWorkObservationOf(event.unpushedWork, at, 'closed');
      if (
        isUnpushedWorkObservationAtLeastAsNewAs(observation, record.job.lastUnpushedWorkObservation)
      ) {
        record.job.lastUnpushedWorkObservation = carryKnownBranches(
          observation,
          record.job.lastUnpushedWorkObservation,
        );
      }
    }
  }

  // `closed` の段3-2: `failed` / `lost` の落ち方から、器の pids 飽和の印を立てる。同期のまま保つ。
  #notePidsSaturationAtClose(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): void {
    // `failed` だけでなく `lost` も見る: SIGABRT の `failed` の後の resume が `spawn … EAGAIN` で `lost` になる形で、後者は `failed` 専用の `noteManagerFailed` に届かない。判定は構造化された値だけ。`runnerId` が無い分は無実の器を沈めないために数えない。
    if (
      (event.status === 'failed' || event.status === 'lost') &&
      record.job.runnerId !== undefined
    ) {
      if (event.systemError?.code === 'EAGAIN') {
        this.#runners.notePidsSaturationSign(record.job.runnerId, 'eagain');
      }
      if ((event.cgroupEvents?.pidsMaxDelta ?? 0) > 0) {
        this.#runners.notePidsSaturationSign(record.job.runnerId, 'fork-denied');
      }
    }
  }

  // `closed` の段3-3: `failed` で閉じた回の知らせ（日誌・枠の印・合流窓・器の失敗の計上）。枠の印を新しく立てたときはその理由を返す。
  async #noteClosedFailure(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): Promise<string | undefined> {
    // `event.reason` を包まない: runner の接頭辞と例外文言が既に1本の文字列に連結されており、この層に `codeSpan()` で包む境目が無い。包むなら `runner.ts` の `#read()`。`event.reason` は1文字も変えず、`systemError` / `cgroupEvents` は末尾に足すだけ。
    // 枠の文言で落ちた回に、枠の印を新しく立てたか（下の `failed` の枝）。
    let markedByClosed: string | undefined;
    // 本文を日誌へ先に書く: 合流窓の flush の日誌は内訳の1行だけで個々の本文を含まないので、flush 前にプロセスが落ちると本文がどこにも残らない。
    const body = withCgroupEventsNote(
      withSystemErrorNote(event.reason, event.systemError),
      event.cgroupEvents,
    );
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] ${body}`,
    );
    // 枠の印は落ちた理由を既存の分類（`classifyUsageNotice`）に通して付ける: `reached` / `transition` のときだけ。分類できない落ち方（SDK のクラッシュ等）は印を付けず、担当ごとに配る。
    const reasonNotice = classifyUsageNotice(event.reason);
    // 枠の文言で落ちた回にも、`usage_notice` を待たずに枠の印を立てる（#4850）: セッションの例外で落ちた回は runner が通知を出さず、印が無いと回転の起こし直しの対象に入らない。`reached` だけ（`usage_notice` と同じ）。分類できない落ち方（SDK のクラッシュ等）には立てない。
    // API の 429（rate_limit_error）をそのまま運ぶ理由文も枠として扱う（#4859）: SDK の枠の決まり文句を含まないことがあり、`closed` には構造化された失敗が無いため
    const quotaReason = reasonNotice?.kind === 'reached' || isRateLimitReason(event.reason);
    if (quotaReason && !this.#usageStopped.has(event.managerId)) {
      this.#usageStopped.add(event.managerId);
      record.job.usageStoppedAt ??= this.#nowIso();
      markedByClosed = reasonNotice?.kind === 'reached' ? reasonNotice.text : event.reason;
      // 書けなくても進む: 台帳に写せないのは再起動を跨ぐ分だけで、メモリの印で今回の回転は拾える。
      await this.#persist(record).catch((error: unknown) => {
        noteDroppedRecord('枠で止まった印の永続化', `managerId=${event.managerId}`, error);
      });
    }
    this.#queueSynthesizedNotice(
      event.managerId,
      'closed_failed',
      body,
      reasonNotice?.kind === 'reached' || reasonNotice?.kind === 'transition'
        ? quotaMarkOf({ text: event.reason }, this.#now(), { sdkText: event.reason })
        : undefined,
    );
    // 落ちたことを名簿へも知らせる: 無いと `/health` の `managers` が減り配置の点数の分母が縮んで落とした器がまた選ばれる。
    // `failed` だけを数える: `lost` は器の不調と別の軸（枠 429 が理由の回が並んでいた）で、入れ替わった直後の resume 失敗を数えると戻ってきたばかりの器を二重に沈める。
    // `systemError` で絞らない: シグナルで畳まれた回には `code` が付かず、`SIGABRT` を取りこぼす。`runnerId` が無い分は数えない: 無実の器を沈める。
    if (record.job.runnerId !== undefined) {
      this.#runners.noteManagerFailed(record.job.runnerId);
    }
    return markedByClosed;
  }

  // `closed` の段3-4: 担当が終端で終わったとき、台帳に残る peer の閉じの知らせをクローンへも知らせる。同期のまま保つ。
  #noticePeerCloseAtEnd(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): void {
    // 担当が終端で終わったとき、台帳に残る peer の閉じの知らせをクローンへも知らせる: `parked_peers_closed(failed)` は `closed` より前に届き、その時点の job はまだ running なので台帳へ積まれる。以後起こされないと誰にも届かない。
    // 台帳の知らせは消さない（あとで起こし直されれば担当の先頭にも添う。宛先が違うので二重にならない）。同じ知らせは1回だけ（`#peerCloseReportedAt`）。
    const pendingPeerClose = record.job.pendingPeerCloseNotice;
    if (
      (event.status === 'failed' || event.status === 'lost') &&
      pendingPeerClose !== undefined &&
      this.#peerCloseReportedAt.get(event.managerId) !== pendingPeerClose.at
    ) {
      this.#peerCloseReportedAt.set(event.managerId, pendingPeerClose.at);
      this.#emit(
        event.managerId,
        'report',
        `[${event.managerId}] ${composePeerCloseNotices(pendingPeerClose)}`,
      );
    }
  }

  // `closed` の段3-5: report が無いまま届いた `closed(done)` をクローンへ知らせる（呼び元が `done` かつ在庫無しのときだけ呼ぶ）。
  async #noticeSilentDone(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'closed' }>,
  ): Promise<void> {
    const seen = reportSeenInSession(
      record.job.lastReportAt,
      record.job.runnerSessionSince,
      record.job.turnStartedAt,
    );
    // 同じセッションについては1回だけ: 印はターンの始まりを含めた境の時刻で、新しいセッションやターンでは値が変わり知らせ直せる（`Job.silentDoneNotifiedFor`）。
    const sessionKey = laterIso(record.job.runnerSessionSince, record.job.turnStartedAt) ?? '';
    const alreadyNotified = record.job.silentDoneNotifiedFor === sessionKey;
    if (seen !== 'seen' && alreadyNotified) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] report 無しの closed(done)。` +
          `同じセッション（${sessionKey === '' ? '開始時刻は不明' : sessionKey}）については知らせ済みなので重ねて知らせない: ` +
          event.reason,
      );
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
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] report 無しの closed(done)` +
          `（${seen === 'none' ? 'report は一度も受け取っていない' : '判定できないので知らせる側へ倒した'}）。` +
          `クローンへ知らせる: ${body}`,
      );
      // 印を先に台帳へ書く（`lateDoneNotifiedAt` と同じ）。
      record.job.silentDoneNotifiedFor = sessionKey;
      await this.#persist(record);
      this.#queueSynthesizedNotice(event.managerId, 'closed_done_silent', body);
    }
  }

  // `closed` の段3-6: 畳んでいた報告の在庫が在れば、像を外す前に配る（合流窓が開いていれば窓へ積む）。同期のまま保つ。
  #flushWithheldAtClose(event: Extract<RunnerEvent, { type: 'closed' }>): void {
    // 積みが在れば `#retire()` の前に配る: 握り潰した報告は「後で必ず配る」約束で、この委譲はもう走らないので次の本物の報告が上書きする経路は来ない。`#emit()` が積みを見つけて末尾へ足すので、ここは「畳まれた」事実だけを書く。
    const withheldAtClose = this.#withheld.get(event.managerId);
    if (withheldAtClose !== undefined) {
      const closedNote =
        `[${event.managerId}] この委譲は終わった（status=${event.status}）。` +
        '背景処理の完了待ちで畳んでいた報告をまとめて配る。';
      if (this.#synthesized.hasWindow(event.managerId)) {
        // 担当の合流窓が開いている（同じ落ち方の `turn_failed` / `closed_failed` が居る）ときは、`#emit()` せず窓へ積んで1通にする: `#emit()` は全窓を閉じて先に断片だけを配るので、この1通が別に届く。窓は開けない・延ばさない（開いていなければ下の `#emit()` で今までどおりすぐ配る）。
        // 在庫は `#retire()` が消すので、窓の flush（`#deliver`）が運べるよう先に移す。移した分は `#retire()` の「握り潰したまま終わった」の stderr にも出ない（配るので捨てていない）。枠の印（`quota`）は下で `closed_failed` から受け継ぐ（枠で落ちた回だけ）。印の無い回は付けず、印の無い断片が混ざった束は担当ごとに配られる。
        this.#withheld.carryToWindow(event.managerId, withheldAtClose);
        // 枠で落ちた回（同じ `closed` で積んだ `closed_failed` に枠の印がある）だけ、その印（トークンの鍵ごと）を受け継ぐ: 束が「枠だけ」のままになり、プール窓の一覧に入る。印の無い回は付けない。
        const inheritedQuota = this.#synthesized.quotaOfFragment(event.managerId, 'closed_failed');
        this.#queueSynthesizedNotice(
          event.managerId,
          'closed_withheld_flush',
          closedNote,
          inheritedQuota,
        );
      } else {
        this.#emit(event.managerId, 'report', closedNote);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 台帳と受信箱
  // -------------------------------------------------------------------------

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
        void this.#journalExchange(
          'inbound',
          `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 処理済みの報告の記憶が上限（${REPORTED_MEMORY_LIMIT}件）に達したので、` +
            `古い ${ids.length} 件を忘れた: ${listing}。` +
            'この id の報告が再送されると、新しい報告としてもう一度回る。',
        );
      },
    });
    record.reported = reported;
    return reported;
  }

  // 一時障害は「居ない」「空」に倒す（呼び出し側が個別に握り直す必要が無い口）。async にせず元の Promise をそのまま返す: await の回数・順を変えない。
  #runnerOrNull(runnerId: string) {
    return this.#runners.get(runnerId).catch(() => null);
  }

  #runnersOrEmpty() {
    return this.#runners.list().catch(() => []);
  }

  #nowIso(): string {
    return new Date(this.#now()).toISOString();
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
    // 像を外した後に呼ぶときに、外す前に控えた指紋（`UsageWake#wakeIfHeldTokenStale` と同じ）
    heldFingerprint: string | undefined = this.#sessionTokenFingerprintOf(managerId),
  ): Promise<void> {
    if (this.#onUsageObservation === undefined) return;
    const identity = this.#tokenIdentities.get(managerId);
    // 身元が無い（再起動で引き取っただけの）セッションは、runner が名乗る鍵の指紋を添える（#4643）: 添えないと回し手は「分からない」を
    // 現役の通知として扱い、回したばかりの鍵をもう一度回す。成功の観測には添えない: そちらは id と世代のある観測しか照合しない生産者へ渡る
    const fingerprint =
      identity === undefined && observation.succeeded !== true ? heldFingerprint : undefined;
    const observedBy = identity ?? (fingerprint === undefined ? undefined : { fingerprint });
    // 回し手へ渡す前後に印を打つ（#4485）: 利用上限で担当が一斉に落ちた回（2026-10-13T16:52Z〜）に、`rate_limit` の後で
    // 印の無い停止が続いた。回し手（鍵の回転の判断・配布・セッションの作り直し）が止めていたなら、窓に `-done` が無いまま残る
    notePhase(`manager:token-rotation:${managerId}`);
    try {
      await this.#onUsageObservation({
        ...observation,
        ...(observedBy === undefined ? {} : { observedBy }),
      });
    } catch (error) {
      noteDroppedRecord('認証トークンの切替', `manager ${managerId}`, error);
    }
    notePhase(`manager:token-rotation-done:${managerId}`);
  }

  #movedAwayFrom(record: ManagerRecord, fromRunnerId: string): boolean {
    return movedAwayOf(record.job.runnerId, fromRunnerId, this.#registeredRunnerIds());
  }

  // 台帳・受信箱・`#emit` には触れない: 引き取り先の委譲の `status` / `lastReport` / `sessionId` を古い側の値で上書きし、答えの届かない確認を配ってしまう。
  async #ignoreIfMovedAway(
    record: ManagerRecord,
    fromRunnerId: string,
    event: Extract<RunnerEvent, { managerId: string }>,
  ): Promise<boolean> {
    if (!this.#movedAwayFrom(record, fromRunnerId)) return false;
    const dropped = await this.#droppedReportFiles(event, fromRunnerId);
    await this.#journal({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text:
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] （runner-id 不一致のため無視。` +
        `いまの宛先は ${record.job.runnerId ?? '不明'}、この出来事は ${fromRunnerId} から）` +
        `移った後に届いた古い runner の ${event.type} を無視した` +
        dropped.text,
      ...dropped.attachments,
    });
    return true;
  }

  /**
   * 捨てる報告の本文を日誌に残し、添えられた成果物も取り寄せて日誌の行に結び付ける。停止済みの報告（#4675）と同じ扱い。
   * 本文を残す（#4717）: 「…の report を無視した」とだけ書くと、誤検知で生きていた古いセッションの最終報告（PR の番号など）が誰にも見えずに消えるため。
   * 成果物を取り寄せる（#4703）: 取り寄せないと、runner が出し箱から退避先へ移した成果物が、名前も残らずに失われるため。受信箱へ回さない・台帳を動かさないのは呼び手のまま。
   */
  async #droppedReportFiles(event: RunnerEvent, fromRunnerId: string): Promise<DroppedReportFiles> {
    if (event.type !== 'report') return NO_DROPPED_FILES;
    const body = `\n\n捨てた報告の本文: ${event.text}`;
    if ((event.files?.length ?? 0) === 0 && (event.rejectedFiles?.length ?? 0) === 0) {
      return { text: body, attachments: {} };
    }
    const files = await this.#fetchReportFiles(event, fromRunnerId);
    return {
      text: body + describeStoppedReportFiles(files),
      attachments:
        files.attachments.length === 0
          ? {}
          : { attachments: files.attachments.map((ref) => ({ ...ref })) },
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

  #predatesLastDenialRenotify(record: ManagerRecord, item: RunnerWaiting): boolean {
    const last = record.lastDenialRenotify;
    if (last === undefined) return false;
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
      return (await this.#findJob(managerId)) ?? null;
    } catch {
      return null;
    }
  }

  // 1件のために台帳を全部読まない（#5140）: `listJobs()` は全行の版を読むので、主キーで1行を読む `getJob` を使う。
  // 読めない行は見つからない扱いにする: `listJobs()` が読めない行を外していたのと同じ答えにするため（理由が要る呼び手は `#unreadableRowDetail` で引く）
  async #findJob(managerId: string): Promise<Job | undefined> {
    try {
      return (await this.#stores.jobs.getJob(managerId)) ?? undefined;
    } catch (error) {
      if (error instanceof UnreadableJobError) return undefined;
      throw error;
    }
  }

  // 既に `#records` に像が在れば作らず返す: 無条件に作ると、同時に来た2つの契機が別々の `Job` のコピーを握り、後から `#persist()` した側が先の変更を上書きする。
  // 台帳の読み（`#findJob`）の `await` から戻って次の `await` までは同期区間なので、この再確認だけでロック無しに同じ像を握れる。
  async #load(managerId: string): Promise<ManagerRecord | null> {
    const job = await this.#findJob(managerId);
    if (!job) return null;
    const existing = this.#records.get(managerId);
    if (existing !== undefined) return existing;
    const record: ManagerRecord = { job: { ...job }, waiting: [], attached: false };
    this.#records.set(managerId, record);
    return record;
  }

  /**
   * 生きている runner へ引き取り直した委譲の返事待ちを、クローンへ配り直す。
   *
   * 前のデーモンは `ask` を受けて台帳へ書いてから受信箱へ投函するが、投函は書き込みを待たない。その間に落ちると、
   * 確認はクローンへ届かないまま runner の中で待ち続ける。runner は `ask` を送り直さないので、引き取りの知らせが言う
   * 「返事待ちがあれば改めて届く」を誰も果たさず、委譲が返事待ちのまま詰まる。
   * runner の一覧に残っている確認は、まだ答えが runner へ届いていない確認なので、配り直して二重になっても
   * クローンが同じ確認を2回見るだけで済む。届かないまま詰まるより安い。
   * 配った id は覚える: 引き取りの後に runner が同じ id を送ってきても、もう一度は配らない。
   */
  #redeliverWaitingAfterRestore(record: ManagerRecord): void {
    const asked = this.#waiting.askedOf(record);
    for (const waiting of record.waiting) {
      if (asked.has(waiting.requestId)) continue;
      asked.set(waiting.requestId, true);
      const delivered = askDeliveryOf(waiting.kind, waiting.summary);
      this.#emit(record.job.id, waiting.kind, delivered.text, waiting.requestId, delivered.markup);
    }
  }

  // `#records` に無ければ `{}` を返し、既定値を作らない: キー自体が付かないので「取れなかった」と「そういう状態だった」が同じ顔にならない。
  #statusAtDelivery(managerId: string): { statusAtDelivery: JobStatus } | Record<string, never> {
    const status = this.#records.get(managerId)?.job.status;
    return status === undefined ? {} : { statusAtDelivery: status };
  }

  /** クローンへ `report` を1通出す。`extra` は `markup`・`foldWhenBack` のような、その知らせだけの追加の欄。 */
  #postReport(
    managerId: string,
    text: string,
    extra: { markup?: TextMarkup; foldWhenBack?: FoldWhenBack } = {},
  ): void {
    this.#post({
      type: 'manager_message',
      id: randomUUID(),
      at: this.#nowIso(),
      managerId,
      kind: 'report',
      text,
      ...extra,
      ...this.#statusAtDelivery(managerId),
    });
  }

  /** 世代で拒まれた（409）ときの知らせ（日誌 `decision` と、クローンへの報告）。`what` は「起動時の引き取り」「取り直し」。 */
  async #refuseFenced(jobId: string, error: unknown, stopped: string, what: string): Promise<void> {
    await this.#journal({
      type: 'decision',
      decision: `[${jobId}] ${stopped}（runner がより新しい世代を持っている＝別の誰かが握っている）`,
      grounds: reasonOf(error),
    });
    this.#postReport(
      jobId,
      `${jobId} の${what}が世代で拒まれました（409）。この委譲は**自分より新しい世代の誰かが握っています**。` +
        `終わったとは限らないので、**新しく起こし直さないでください** — ` +
        `台帳の貸し出しと runner の世代が食い違っています（デーモンが2つ走っているか、貸し出しの書き込みが落ちた可能性）。人間へ相談すること: ${reasonOf(error)}`,
    );
  }

  // 合成した知らせの段2（担当ごとの短い窓）は `SynthesizedNoticeWindows` が持つ。呼び元と他のクラスへ渡す口を書き換えずに済むよう、ここは1行で委ねる。
  #emit(...args: Parameters<SynthesizedNoticeWindows['emit']>): void {
    this.#synthesized.emit(...args);
  }

  #queueSynthesizedNotice(...args: Parameters<SynthesizedNoticeWindows['queue']>): void {
    this.#synthesized.queue(...args);
  }

  /**
   * `options.sessionClosed`: セッションが畳まれた書き込み（`#closeJob` だけが真）。`done` でも終わった委譲として task を即時に倒す。
   * 偽の `done` は報告由来（ターンの終わり）で、task を動かさず `endedAt` だけ書き、猶予を過ぎた見回りが倒す（`TASK_FOLLOW_GRACE_MS`）。
   */
  async #persist(
    record: ManagerRecord,
    options: { readonly sessionClosed?: boolean } = {},
  ): Promise<void> {
    record.job.updatedAt = this.#nowIso();
    // `done` 以外へ動く書き込み（`manager_send` の `running`・`ask` の `waiting_human`・`failed` など）は背景待ちの保留を下ろす。状態を変える経路は多く、個別に下ろすと1つ漏れた経路の印だけが残るので、書き込みの1本の口に置く
    if (record.job.status !== 'done') delete record.job.awaitingBackgroundSince;
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
    // task へ写すのに、書く前の台帳の状態が要る（結び付いた委譲だけ読む）。読めなければ `undefined`
    const linkedTaskId = record.job.taskId;
    const before =
      linkedTaskId === undefined
        ? undefined
        : await this.#taskLink.readBefore(record, linkedTaskId);
    // 終端へ入った時刻を1回だけ書く（起動時の直しの基準）。読めなかった回は触れない
    this.#taskLink.stampEndedAt(record, before);
    try {
      await this.#stores.jobs.putJob(record.job);
    } catch (error) {
      // ジョブ台帳が書けなくてもマネージャーは走らせるが、黙って消さない: 失敗は台帳にも日誌にも跡を残さない。
      noteDroppedRecord('ジョブ台帳', `job id=${record.job.id} status=${record.job.status}`, error);
    }
    await this.#taskLink.sync(record, before, options.sessionClosed === true);
  }

  // 像（`ManagerRecord.runnerSessionSince`）はプロセス内にしか置かない: 生存確認と未 push 観測の判定は「再起動後は欄が無い」前提で倒れ先を決めている。
  #noteRunnerSessionSince(record: ManagerRecord): void {
    const at = this.#nowIso();
    record.runnerSessionSince = at;
    record.job.runnerSessionSince = at;
    // start / resume は新しいターンの始まりでもある。`send()` が先に書いた値より後ろへだけ進める。
    record.job.turnStartedAt = laterIso(record.job.turnStartedAt, at);
  }

  // 「上限で古いものを捨てる」にしない。上限を持たせると、走行中のマネージャーが増えただけで無関係な1本が押し出される形になりうる（north_star 禁止2）。
  // 契機は終端という状態遷移だけにする。
  #retire(managerId: string): void {
    // 像を外す前に在庫を下ろす（台帳の写しは像から引くため）。
    this.#withheld.retire(managerId);
    this.#records.delete(managerId);
    this.#synthesized.forget(managerId);
    // 日誌の畳み込みは外す前に畳み残しを吐く: 畳んだ2件目以降はまだ日誌のどこにも書かれておらず、黙って捨てると件数が失われる（`UsageReceiver#retire`）。
    this.#usageReceiver.retire(managerId);
    this.#held.forget(managerId);
    this.#autoFold.forget(managerId);
    this.#inputMarks.delete(managerId);
    // busy の取り直しの数えはここで消す: `#reattach` のループは数えを消さずに `continue` で抜けるので、残すと後の busy で上限（`REATTACH_BUSY_MAX_RETRIES`）を前の分で縮める。
    this.#reattachBusyRetries.delete(managerId);
    this.#turnEndWatch.forget(managerId);
    this.#restored.end(managerId);
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
        at: this.#nowIso(),
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

  /**
   * 待っていた確認を外し、残っていた分を日誌で取り下げにする（#4719）。
   * 残っているのは取り下げ（`settled(withdrawn)`）が届かなかった確認だけ: runner が畳むときに送った分は `case 'settled'` が既に外して書いている。
   * 書かないと、器と一緒に消えた確認が日誌の上で「未回答」のまま残り、クローンも人間も答えようの無い確認を有効なものとして見続ける。
   * 待たない（`#journal` は投げない）: 呼び手には同期の経路（`markMissing`）がある。
   */
  /**
   * 1件だけ外して取り下げを日誌に残す（#4775）。外したら `true`。待ちが空になれば `waiting_human` を `running` に戻す（`case 'settled'` と同じ扱い）。
   * 待たない（`#journal` は投げない）: `#withdrawWaiting` と同じ。
   */
  #dropUndeliveredWaiting(record: ManagerRecord, requestId: string): boolean {
    const item = record.waiting.find((candidate) => candidate.requestId === requestId);
    if (item === undefined) return false;
    record.waiting = record.waiting.filter((candidate) => candidate.requestId !== requestId);
    if (record.job.status === 'waiting_human' && record.waiting.length === 0) {
      record.job.status = 'running';
    }
    void this.#journal({
      type: 'escalation',
      question: item.summary,
      approvalId: item.requestId,
      managerId: record.job.id,
      withdrawnAt: this.#nowIso(),
      withdrawnReason:
        'この確認への答えは届かない（答えを送ったが、runner はこの確認をもう持っていなかった）',
    });
    return true;
  }

  #withdrawWaiting(record: ManagerRecord, reason: string): void {
    const dropped = record.waiting;
    record.waiting = [];
    if (dropped.length === 0) return;
    const at = this.#nowIso();
    for (const item of dropped) {
      void this.#journal({
        type: 'escalation',
        question: item.summary,
        approvalId: item.requestId,
        managerId: record.job.id,
        withdrawnAt: at,
        withdrawnReason: `この確認への答えは届かない（${reason}）`,
      });
    }
  }

  // `with: 'manager'` の exchange を書く。async にせず `#journal` の Promise をそのまま返す: `await` / `void` の呼び出し側のタイミングを変えない。
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  #journalExchange(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#journal({ type: 'exchange', with: 'manager', role, text });
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
