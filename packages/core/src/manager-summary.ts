import { definedProps } from './defined-props.js';
import type {
  ManagerAwaitingBackground,
  ManagerRecord,
  ManagerSummary,
  TokenGenerationUnknownReason,
} from './manager.js';
import type { NoticeResetMatch } from './token-reset-match.js';
import type { PendingToolUse } from './turn-end-probe.js';

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
// `ManagerPool` の一覧と1件の読みが、同じ応答の中で全件を同じ像で比べるための材料
export interface SummaryContext {
  silent: ReadonlyMap<string, string>;
  runnerSessions: ReadonlyMap<string, { ids: ReadonlySet<string>; observedAt: string }>;
  registeredRunnerIds: ReadonlySet<string> | null;
  activeTokenGeneration: number | undefined;
  tokenGenerationPoolWired: boolean;
}

export function summaryOf(
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
    ...definedProps({ runnerLostSince, runnerVanished, runnerListedAt }),
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
    ...definedProps({ turnEndedAt, turnEndReason, turnEndTail }),
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
    ...(job.supersededBy === undefined ? {} : { supersededBy: job.supersededBy }),
    ...(job.supersedes === undefined ? {} : { supersedes: job.supersedes }),
    ...(job.runnerId === undefined ? {} : { runnerId: job.runnerId }),
    // `unknown` を黙って落とさない: 欄ごと消すと「取れなかった」という観測が消える。
    ...(job.workspace === undefined ? {} : { workspace: job.workspace }),
    // 貸し出しは判定を出さず材料だけ写す: `judgeLease` は時刻で答えが変わるので、一覧に焼くと読んだ瞬間から古びる。
    ...(job.lease === undefined ? {} : { lease: job.lease }),
    ...(job.lastUnpushedWorkObservation === undefined
      ? {}
      : { lastUnpushedWorkObservation: job.lastUnpushedWorkObservation }),
    ...(job.lastRescue === undefined ? {} : { lastRescue: job.lastRescue }),
    ...(job.rescueStash === undefined || job.rescueStash.length === 0
      ? {}
      : {
          rescueStash: {
            count: job.rescueStash.length,
            totalBytes: job.rescueStash.reduce((sum, e) => sum + e.size, 0),
            latestAt: job.rescueStash.reduce((latest, e) => (e.at > latest ? e.at : latest), ''),
          },
        }),
    ...(job.externalOutputs === undefined ? {} : { externalOutputs: job.externalOutputs }),
    ...(job.heldMessages === undefined || job.heldMessages[0] === undefined
      ? {}
      : {
          heldMessages: {
            count: job.heldMessages.length,
            oldestHeldAt: job.heldMessages[0].heldAt,
          },
        }),
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
