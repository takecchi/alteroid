import { redactErrorText } from './denial-input-head.js';
import { z } from 'zod';

import { cgroupEventsDeltaSchema } from './cgroup-events.js';
import { CREDENTIAL_NAME_MAX_LENGTH } from './credentials.js';
import { excerptLine } from './excerpt.js';
import type { McpServers } from './mcp-servers.js';
import type { RunnerPlugin as RunnerPluginPush } from './plugins.js';
import { type RunnerRevisionReport } from './revision.js';
import {
  contextUsageObservationSchema,
  externalOutputSchema,
  jobStatusSchema,
  rescueWorktreeSchema,
} from './schema.js';
import { systemErrorFactsSchema } from './system-error.js';
import { rateLimitFactsSchema, usageLimitNoticeSchema } from './usage-limits.js';
import { usageTotalsSchema } from './usage.js';

const DUPLICATE_RUNNER_ID_EXCERPT = 400;

const isoDateTime = z.string().datetime({ offset: true });

/**
 * 逆向きのコールバック URL を足さない: 接続を張るのは常にデーモン側で、runner にデーモンの所在も鍵も
 * 持たせない（持たせると runner の中の子プロセスがその鍵で記憶へ届くため）。
 *
 * この境界の回帰テストは `JSON.parse(JSON.stringify(...))` を通すか `apps/daemon` 側で書く:
 * 同一プロセスだと `{ input: undefined }` のキーが残り、zod 4 の必須欄が `safeParse` を通ってしまうため。
 */

// 定義を1箇所にする: `ask` イベントと `state()` が返す `waiting` の両方が同じ2値を指すようにするため。
export const waitingKindSchema = z.enum(['question', 'permission']);

export type WaitingKind = z.infer<typeof waitingKindSchema>;

/**
 * `kind` と `askedAt` を必須にしない: 旧 runner の `/managers` 応答にこの2つが乗らない窓があり、必須だと
 * `HttpRunner#list()` の `safeParse` が要素ごと黙って捨て、待っていた確認まで消えるため。
 * 欠けたまま運び、デーモン側で既定値は作らない（`askedAt` を「取れなければいま」で埋めると値の意味が経路で変わる）。
 */
export const runnerWaitingSchema = z.object({
  requestId: z.string(),
  summary: z.string(),
  kind: waitingKindSchema.optional(),
  askedAt: isoDateTime.optional(),
});

export type RunnerWaiting = z.infer<typeof runnerWaitingSchema>;

export const runnerManagerStateSchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  cwd: z.string(),
  request: z.string(),
  waiting: z.array(runnerWaitingSchema),
  sessionId: z.string().optional(),
  /**
   * `undefined` は「0 本」ではなく「分からない」: 欄を持たない古い runner が居る窓があり、0 と読むと
   * 背景処理を抱えた古い runner のセッションを黙って畳むため。
   */
  liveBackgroundTasks: z.number().int().nonnegative().optional(),
  /** `undefined` は「分からない」。デーモンは断らず、流して世代は書かない（再起動後の done へ送れなくなるため）。 */
  tokenFingerprint: z.string().optional(),
});

export interface RunnerManagerListing {
  states: RunnerManagerState[];
  unreadableIds: string[];
}

/** `unreadableIds` も「runner に居る」側に数える: 状態が読めないことを、居ないことと畳まない。 */
export async function listRunnerManagers(
  runner: Pick<RunnerClient, 'list' | 'listWithUnreadable'>,
  options?: { signal?: AbortSignal },
): Promise<RunnerManagerListing> {
  if (runner.listWithUnreadable !== undefined) return runner.listWithUnreadable(options);
  return { states: await runner.list(options), unreadableIds: [] };
}

export type RunnerManagerState = z.infer<typeof runnerManagerStateSchema>;

// ---------------------------------------------------------------------------
// デーモン → runner（命令）
// ---------------------------------------------------------------------------

/**
 * lease を必須にしない: 名乗らない古いデーモンや、lease を知らない `runner-local.ts` のような呼び出しを壊さないため。
 * runner は最後に受け取った `fence` より古い世代の命令を拒む（`RunnerFenceError`）。
 */
export const runnerLeaseSchema = z.object({
  fence: z.number().int().nonnegative(),
  ttlMs: z.number().int().positive(),
});

export type RunnerLease = z.infer<typeof runnerLeaseSchema>;

/**
 * runner が取りに行く別ルートは作らない: 中身（`data`）を命令の本文に base64 で載せる。
 * runner は記憶ストアの鍵もファイルシステムの共有も持たず、同じ要求で運べば最初のターンとの競りも起きないため。
 * `id` / `name` はパスの部品になるので、スキーマは形だけを見て、置く側が検める。
 * 大きいファイル（#4128 段3a）は `data` を載せず `staged: true` だけにする: 中身はデーモンが先に別口
 * （`PUT /managers/:id/attachments/:attachmentId`）へ押して置かせるため。`staged` は `manager-attachments-stage` を名乗る runner にだけ送る。
 */
export const runnerAttachmentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    mediaType: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    data: z.string().optional(),
    staged: z.literal(true).optional(),
  })
  .refine((item) => (item.data === undefined) !== (item.staged === undefined), {
    message: '`data` と `staged` はちょうど一方',
  });

export type RunnerAttachment = z.infer<typeof runnerAttachmentSchema>;

export const runnerStartCommandSchema = z.object({
  managerId: z.string().min(1),
  request: z.string().min(1),
  cwd: z.string().min(1),
  lease: runnerLeaseSchema.optional(),
  /*
   * `provider` 欄は無い（マネージャー層は常に Claude で動く）。旧いデーモンが送ってきても、
   * `z.object` は未知の欄を黙って捨てる。
   */
  attachments: z.array(runnerAttachmentSchema).optional(),
});

export type RunnerStartCommand = z.infer<typeof runnerStartCommandSchema>;

/** `entries` は runner のディスクに残っている前提を置かない: 器が作り直されていれば消えているので、デーモンが持っている分を渡す。 */
export const runnerResumeCommandSchema = z.object({
  managerId: z.string().min(1),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  request: z.string().min(1),
  message: z.string().optional(),
  entries: z.array(z.unknown()).optional(),
  lease: runnerLeaseSchema.optional(),
  /** `message` が無ければ使わない。`manager_send` が resume から入り直す回に、添付を黙って落とさないために要る。 */
  attachments: z.array(runnerAttachmentSchema).optional(),
});

export type RunnerResumeCommand = z.infer<typeof runnerResumeCommandSchema>;

/**
 * 既存の識別子を流用しない: `lease.fence` は同じ runner への resume では進まず、`instanceId` は同じプロセスの
 * resume で変わらない。どちらも古いセッションの畳み（`closed`）と新しいセッションの出来事を区別できない。
 * 欄が無い古い runner の出来事は、世代が古いとも新しいとも読まず従来どおり処理する。
 */
const sessionGenerationSchema = z.string().optional();

/** 文字列の長さ・`errors` の件数は縛らない: 切り方の違う版の `session` ごと読み捨てて、セッションの開始を失うため。 */
const agentPluginLoadSchema = z.object({
  plugins: z.array(z.object({ name: z.string(), version: z.string().optional() })),
  /** `null` は init がこの欄を省いたこと（無事の断定ではない）。 */
  errors: z
    .array(
      z.object({
        plugin: z.string(),
        type: z.string(),
        message: z.string(),
        path: z.string().optional(),
      }),
    )
    .nullable(),
  errorsOmitted: z.number().int().positive().optional(),
});

/**
 * `cwd` は省略されうる: 旧 runner は `{ ok: true }` だけを返す。受け取る側は欠けた回を「頼んだ値のまま」へ倒さず、
 * `cwd` キーを省いたまま運ぶ（欠けた軸に0を書かない）。
 */
export const runnerSessionOpenResultSchema = z.object({
  ok: z.boolean(),
  cwd: z.string().optional(),
  /**
   * `true` のとき message が届いたのは起動時の env（鍵）が凍った旧プロセスで、鍵が現役かは分からない。
   * `undefined` は「分からない」: 古い runner は短絡したかを名乗れない。
   */
  reusedLiveSession: z.boolean().optional(),
  /** `undefined` は「分からない」（欄を持たない古い runner）。デーモンは追っている世代を持たない側へ倒す。 */
  sessionGeneration: sessionGenerationSchema,
});

export type RunnerSessionOpenResult = z.infer<typeof runnerSessionOpenResultSchema>;

export interface RunnerResumeResult {
  cwd?: string;
  reusedLiveSession?: boolean;
  sessionGeneration?: string;
}

/**
 * `lease` を持たせない: 既に開いている（`start` / `resume` で世代の検査を済ませた）セッションへの命令で、
 * 世代で締め出されたプロセスは自己失効で畳むため。`RunnerClient.send` / `answer` の署名も変えずに済む。
 */
export const runnerMessageCommandSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(runnerAttachmentSchema).optional(),
});

/** 鍵を環境変数で配らず命令として降ろす: 環境変数は起動時に凍り、鍵を直すのに走行中の仕事を失うことになるため。 */
export const runnerCredentialSchema = z.object({
  /** 自由な文字列にしない: `../../../etc/cron.d/x` がそのままファイル名になり、器の外へ書けたため。 */
  name: z
    .string()
    .min(1)
    .max(CREDENTIAL_NAME_MAX_LENGTH)
    .regex(/^[A-Z][A-Z0-9_]*$/, '鍵の名前は英大文字・数字・_ のみ'),
  value: z.string(),
});

export const runnerSetCredentialsCommandSchema = z.object({
  credentials: z.array(runnerCredentialSchema).min(1),
});

export type RunnerSetCredentialsCommand = z.infer<typeof runnerSetCredentialsCommandSchema>;

export const runnerCredentialFingerprintSchema = z.object({
  name: z.string(),
  sha256: z.string(),
  updatedAt: z.string(),
});

export type RunnerCredentialFingerprint = z.infer<typeof runnerCredentialFingerprintSchema>;

/**
 * 環境変数の一覧を持たない: 中身は解釈しない。名前検査を足したくなったら、それは `credentials` の口の仕事である。
 * 命令として降ろすのは、runner に記憶ストアを読ませない境界のため runner が自分で取りに行けないから。
 */
export const runnerSetProfileCommandSchema = z.object({
  script: z.string(),
});

export type RunnerSetProfileCommand = z.infer<typeof runnerSetProfileCommandSchema>;

export const runnerProfileFingerprintSchema = z.object({
  sha256: z.string(),
  bytes: z.number(),
  updatedAt: z.string(),
});

export type RunnerProfileFingerprint = z.infer<typeof runnerProfileFingerprintSchema>;

/** 「置けた」で終わらせない: 構文を間違えたプロファイルは以後すべてのコマンドを壊し、原因がどこにも出ないため、置いた直後に評価して結果を返す。 */
export const runnerProfileResultSchema = z.object({
  profile: runnerProfileFingerprintSchema.optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  output: z.string().optional(),
  /** 値は返さない。 */
  names: z.array(z.string()).optional(),
});

export type RunnerProfileResult = z.infer<typeof runnerProfileResultSchema>;

/**
 * この層では形を検めない（`z.unknown()` の袋のまま運ぶ）: 検査の正本は `parseMcpServers` で、ここに書くと
 * 2つ目の正本になり、この小さな共有モジュールが `mcp-servers.ts` へ依存するため。
 * 不正なら runner が 400 を返し、前の登録が残る。
 */
export const runnerSetMcpServersCommandSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

export type RunnerSetMcpServersCommand = z.infer<typeof runnerSetMcpServersCommandSchema>;

/**
 * 値（`env` / `headers` / `args`）は返さない。名前は返す: 道具名としてマネージャーの文脈にも出る秘密でない値で、
 * 指紋だけでは人間が確かめる手段を持たないため。
 */
export const runnerMcpServersFingerprintSchema = z.object({
  sha256: z.string(),
  names: z.array(z.string()),
  updatedAt: z.string(),
});

export type RunnerMcpServersFingerprint = z.infer<typeof runnerMcpServersFingerprintSchema>;

/** この層では形を緩く運ぶ: 検査の正本は `parseRunnerPlugin` で、受けた runner が検める。 */
export const runnerPluginFileWireSchema = z.object({
  path: z.string(),
  executable: z.boolean(),
  /** base64（RFC 4648 の標準の綴り・padding あり）。 */
  content: z.string(),
});

export const runnerSetPluginCommandSchema = z.object({
  name: z.string(),
  sourceSha: z.string(),
  scope: z.string(),
  enableHooks: z.boolean(),
  enableMcp: z.boolean(),
  contentSha256: z.string(),
  files: z.array(runnerPluginFileWireSchema),
});

export type RunnerSetPluginCommand = z.infer<typeof runnerSetPluginCommandSchema>;

export const RUNNER_PLUGIN_RETAIN_MAX_NAMES = 1024;

export const runnerRetainPluginsCommandSchema = z.object({
  names: z.array(z.string()).max(RUNNER_PLUGIN_RETAIN_MAX_NAMES),
});

export type RunnerRetainPluginsCommand = z.infer<typeof runnerRetainPluginsCommandSchema>;

/** files の中身は返さない（名前・取り元の sha・中身の指紋だけで、どれも秘密ではない）。 */
export const runnerPluginFingerprintEntrySchema = z.object({
  name: z.string(),
  sha: z.string(),
  contentSha256: z.string(),
  /** optional にする: 欄が無い古い runner の応答も読めるように。欄が無ければ daemon 側の比較で「差あり」になり送り直される。 */
  enableHooks: z.boolean().optional(),
  enableMcp: z.boolean().optional(),
});

export const runnerPluginsFingerprintSchema = z.object({
  sha256: z.string(),
  plugins: z.array(runnerPluginFingerprintEntrySchema),
  updatedAt: z.string(),
});

export type RunnerPluginFingerprintEntry = z.infer<typeof runnerPluginFingerprintEntrySchema>;
export type RunnerPluginsFingerprint = z.infer<typeof runnerPluginsFingerprintSchema>;

/**
 * フィールド名を `capacity` にしない: 上限として使われ始め、「超えたら断る」という能力の削除になるため。
 * 材料は独立して省略できる。報告できないことを理由に宛先から外してはならない。
 */
export const runnerExecutionResourcesSchema = z.object({
  /** `os.cpus().length` ではない: cgroup で絞られた器でもホストのコア数を答え、登録順に選ぶのと変わらなくなるため。 */
  cpu: z.object({ cores: z.number().positive(), source: z.enum(['cgroup', 'os']) }).optional(),
  /** `usedBytes` から読み捨てできるページキャッシュを引く: 引かないと何もしていない器が「使用中」に見えるため。 */
  memory: z
    .object({
      limitBytes: z.number().positive(),
      usedBytes: z.number().nonnegative(),
      source: z.enum(['cgroup', 'os']),
    })
    .optional(),
  /** `source` を持たない: pids には cgroup が読めないとき倒れる先（ホストの値）が無く、読めなければまるごと省略する。 */
  pids: z.object({ current: z.number().nonnegative(), max: z.number().positive() }).optional(),
  /**
   * `pids` の中には入れず兄弟として置く: `chooseByResources` が `pids: { current, max }` の配置そのものを読むため。
   * `.optional()` は、この機能より前の runner が欄自体を持たない窓のため。
   * `pids.current` と厳密に一致するとは限らない: 測る主体（走査している runner 自身）が走査中に増減するので、1〜数本ずれる。
   * 生存プロセスの素性は含まない: 出るのは数（`threads` / `processes` / `zombies`）とゾンビの `comm` だけ。
   */
  tasks: z
    .object({
      threads: z.number().int().nonnegative(),
      processes: z.number().int().nonnegative(),
      zombies: z.number().int().nonnegative(),
      zombieCommands: z
        .array(z.object({ command: z.string(), count: z.number().int().positive() }))
        .optional(),
      oldestZombieSeconds: z.number().int().nonnegative().optional(),
      /**
       * `mode` は `'observe'` と `'reclaim'` の両方を受け付ける: 受け取る側を先に広げないと、版がずれた窓でこの欄が丸ごと落ちる。
       * `signalled` / `killed` / `freedThreads` は撃っていない回も0で、欄は省かない: 欄が生えたように見せると、撃たない観測と撃つ観測が別物に見える。
       * 走査が読めなかった回は欄ごと出さないので、`candidates: 0` は「数え切って0本」を意味する。
       * `.optional()` は、この機能より前の runner が欄自体を持たない窓のため（`tasks` 自身と同じ先例）。
       * 生存プロセスの素性は入れない: 出るのは数と時刻だけで、判定に使う材料も `stat` と `/proc/<pid>` ディレクトリの所有 UID まで
       * （`cmdline` / `cwd` / `environ` は読んでいない）。
       */
      reclaim: z
        .object({
          mode: z.enum(['observe', 'reclaim']),
          candidates: z.number().int().nonnegative(),
          candidateThreads: z.number().int().nonnegative(),
          /** `.optional()`: この機能より前の runner が欄自体を持たない窓がある（`reclaim` 自身と同じ先例）。 */
          roots: z.number().int().nonnegative().optional(),
          largestTreeCandidates: z.number().int().nonnegative().optional(),
          singletonTrees: z.number().int().nonnegative().optional(),
          oldestAgeSec: z.number().int().nonnegative().optional(),
          /** 齢は「起動からの齢」で、「孤児になってからの齢」ではない（`oldestAgeSec` と同じ軸）。 */
          medianAgeSec: z.number().int().nonnegative().optional(),
          ageBuckets: z
            .array(
              z.object({
                upToSec: z.number().int().positive().optional(),
                count: z.number().int().nonnegative(),
              }),
            )
            .optional(),
          signalled: z.number().int().nonnegative(),
          killed: z.number().int().nonnegative(),
          freedThreads: z.number().int().nonnegative(),
          lastRunAt: z.number().int().nonnegative(),
          pidsAtScan: z
            .object({ current: z.number().nonnegative(), max: z.number().positive() })
            .optional(),
          /**
           * 数えるだけで、撃つ判定には効かない。`held` / `bySid` は判定材料が無い runner では出ない（「取れない」を0に潰さない）。
           * `.optional()` は、この欄より前の runner が持たない窓のため。
           */
          notFired: z
            .object({
              outsideRoots: z.object({
                total: z.number().int().nonnegative(),
                parentInScan: z.number().int().nonnegative(),
                bySid: z
                  .object({
                    wouldFire: z.number().int().nonnegative(),
                    sidUnknown: z.number().int().nonnegative(),
                    sidLive: z.number().int().nonnegative(),
                    sidLeaderPresent: z.number().int().nonnegative(),
                    sidUnrecognised: z.number().int().nonnegative(),
                  })
                  .optional(),
              }),
              held: z
                .object({
                  sidUnknown: z.number().int().nonnegative(),
                  sidLive: z.number().int().nonnegative(),
                  sidLeaderPresent: z.number().int().nonnegative(),
                  sidUnrecognised: z.number().int().nonnegative(),
                })
                .optional(),
              observeOnly: z.number().int().nonnegative().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export type RunnerExecutionResources = z.infer<typeof runnerExecutionResourcesSchema>;

export const runnerPlacementResourcesSchema = runnerExecutionResourcesSchema.extend({
  managers: z.number().int().nonnegative().optional(),
  /** 0件でもキーは省かれない: 「未送出が何件か」は0件のときも測れる軸で、`oldestPendingAt` と違い0を捏造にならない。 */
  pendingEvents: z.number().int().nonnegative().optional(),
  /** runner が `Outbox` へ積んだ時刻で、マネージャーが報告を生成した時刻ではない。1件も無ければキーごと省かれる。 */
  oldestPendingAt: isoDateTime.optional(),
});

export type RunnerPlacementResources = z.infer<typeof runnerPlacementResourcesSchema>;

/** `lease` を持たせない: `runnerMessageCommandSchema` と同じ理由。 */
export const runnerAnswerCommandSchema = z.object({
  requestId: z.string().min(1),
  message: z.string(),
  decision: z.enum(['allow', 'deny']).optional(),
});

export type RunnerAnswerCommand = z.infer<typeof runnerAnswerCommandSchema>;

/** `lease` は持たせない（`runnerAnswerCommandSchema` と同じ理由）。 */
export const runnerRescueRefDeleteRequestSchema = z.object({
  remote: z.string().min(1),
  ref: z.string().min(1),
  commit: z.string().min(1),
});
export type RunnerRescueRefDeleteRequest = z.infer<typeof runnerRescueRefDeleteRequestSchema>;

export const runnerRescueRefDeleteResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('removed'), alreadyGone: z.boolean() }),
  z.object({
    outcome: z.literal('failed'),
    kind: z.enum(['auth', 'network', 'timeout', 'moved', 'no-remote', 'other']),
  }),
]);
export type RunnerRescueRefDeleteResult = z.infer<typeof runnerRescueRefDeleteResultSchema>;

/**
 * `decision` は省略されうる: 旧 runner は `{ ok: true }` だけを返す。受け取る側は欠けた回を allow/deny の既定値へ倒さず、
 * キーを省いたまま運ぶ。`'unreadable'` を畳まず3値目にする: 呼び手へ「答え直せ」と伝えるには、本当の拒否と区別できる値が要るため。
 */
export const runnerAnswerResultSchema = z.object({
  ok: z.boolean(),
  decision: z.enum(['allow', 'deny', 'unreadable']).optional(),
});

export type RunnerAnswerResult = z.infer<typeof runnerAnswerResultSchema>;

/** ワイヤーの語彙（`{ ok, decision }`）と業務の語彙（`{ delivered, decision }`）を分ける: ワイヤーの形が変わっても意味が変わらないように。 */
export interface RunnerAnswerOutcome {
  /** `false` = その確認は runner 側に無い（既に解けた / 別の宛先）。 */
  delivered: boolean;
  /** `delivered` が true でも欠けうる。`'unreadable'`（読み取れなかった）は欄が無いこととは別で、欠落は欄を省く形で表す。 */
  decision?: 'allow' | 'deny' | 'unreadable';
}

// ---------------------------------------------------------------------------
// runner → デーモン（出来事）
// ---------------------------------------------------------------------------

/**
 * 版番号ではなく能力の名前で名乗る: 版から能力を推すと推し方がデーモン側に散らばるため。
 * 名乗らない器はどの能力も持たないものとして扱い、「送っているはず」と仮定しない。
 *
 * - `awaiting-background-signal`: これを名乗らない器では、印が無いことを「背景処理を待っていない」と読めない
 * - `manager-attachments`: これを名乗らない器へ添付を送ると欄は黙って捨てられるので、デーモンは送らずに断る
 */
export const RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL = 'awaiting-background-signal';

export const RUNNER_CAPABILITY_MANAGER_ATTACHMENTS = 'manager-attachments';

/** これを名乗らない器へ `staged` の添付を送らない（`data` が必須の旧い runner は命令ごと 400 で断る。#4128 段3a）。 */
export const RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE = 'manager-attachments-stage';

/** これを名乗らない器の報告に `files` が無いことを「成果物が無い」と読まない（旧い runner は出し箱を知らない）。 */
export const RUNNER_CAPABILITY_MANAGER_OUTBOX = 'manager-outbox';

/**
 * 名乗る器が `managerPeers` を送らなければ「開いている peer は無い」、名乗らない器は「不明」: 無いことを「頼めない」と既定値で埋めない。
 */
export const RUNNER_CAPABILITY_MANAGER_PEERS = 'manager-peers';

export const RUNNER_CAPABILITIES: readonly string[] = [
  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
  RUNNER_CAPABILITY_MANAGER_OUTBOX,
  RUNNER_CAPABILITY_MANAGER_PEERS,
];

/** 中身は載せない（取りに行く先は `GET /managers/:id/outbox/:fileId`）。 */
export const runnerOutboxFileSchema = z.object({
  fileId: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RunnerOutboxFile = z.infer<typeof runnerOutboxFileSchema>;

export const runnerOutboxRejectedFileSchema = z.object({ name: z.string(), reason: z.string() });
export type RunnerOutboxRejectedFile = z.infer<typeof runnerOutboxRejectedFileSchema>;

export const runnerManagerPeerSchema = z.object({
  provider: z.string().min(1),
  models: z.array(z.string().min(1)).optional(),
});

export type RunnerManagerPeer = z.infer<typeof runnerManagerPeerSchema>;

export const runnerManagerPeerClosedSchema = z.object({
  provider: z.string().min(1),
  reason: z.string().min(1),
});

export type RunnerManagerPeerClosed = z.infer<typeof runnerManagerPeerClosedSchema>;

/**
 * 出してよいのは有無・件数・枝名と、origin remote の host/path まで: ファイル名・差分の中身・コミットメッセージ・author と、
 * userinfo・クエリ・フラグメント・資格・生の URL 文字列は含めない。止める側へ本人の情報を出す文脈なので線を引く。
 *
 * `runnerEventSchema` より前に置く: `closed.unpushedWork` が参照し、`const` は宣言順に評価されるため後ろだと TDZ になる。
 */
export const unpushedWorkTreeSchema = z.object({
  /** `job.cwd` の外で見つかった作業ツリーは絶対パス（`describeWorktreePath`）。 */
  relativePath: z.string(),
  branch: z.string().nullable(),
  /**
   * `@{u}` ではなく `git rev-list --count HEAD --not --remotes=origin` を使う: upstream 未設定の枝でも検出できるため。
   * ネットワークを使わないので remote-tracking ref が古びて多めに出ることはあるが、実際に未 push なのに0と出ることは無い。
   */
  unpushedCommitCount: z.number().int().nonnegative().optional(),
  /** 省略 = 確かめられた。 */
  unpushedCommitCountUnknown: z.string().optional(),
  uncommittedChangeCount: z.number().int().nonnegative().optional(),
  uncommittedChangeCountUnknown: z.string().optional(),
  /** 解釈できない・userinfo などを確実に落とせない形は欄ごと省く: 生の文字列を出すくらいなら何も出さない。 */
  remoteOrigin: z
    .object({
      host: z.string(),
      path: z.string(),
    })
    .optional(),
});
export type UnpushedWorkTree = z.infer<typeof unpushedWorkTreeSchema>;

// `job.cwd` の下に見つかった作業ツリーを全部持つ: 1本目だけを返さない（マネージャーが作業者へ別ツリーを切る運用を `AGENTS.md` が許容しているため）。
export const unpushedWorkResultSchema = z.object({
  cwd: z.string(),
  worktrees: z.array(unpushedWorkTreeSchema),
  /** 打ち切ったことを書かないと「全部見つかった」に見えてしまう。 */
  truncatedAtCount: z.number().int().positive().optional(),
  /** 打ち切っても `worktrees` からは落とさず、調べられなかった分は各欄の `*Unknown` に理由が付く。 */
  stoppedEarly: z.literal(true).optional(),
  /** 省略を「/tmp にスクラッチディレクトリは無かった」と読まない: 載っているとき、`/tmp` 由来の作業ツリーは探せていない。 */
  scratchRootsUnknown: z.string().optional(),
  /** `scratchRootsUnknown` とは別軸（こちらは `job.cwd` の下の子ディレクトリが読めなかった回数）。 */
  unreadableDirCount: z.number().int().positive().optional(),
  /** 最初の1件だけの診断用サンプル。 */
  unreadableDirSample: z.string().optional(),
});
export type UnpushedWorkResult = z.infer<typeof unpushedWorkResultSchema>;

/**
 * `closed.unpushedWork` と `shutdown_unpushed_work` が共有する形。`kind: 'unavailable'` は取れなかったことそのものを名乗り、
 * 欄が丸ごと無いこととは混ぜない。1箇所にまとめるのは、手で同じ形を2つ書くと片方だけ直る事故が起きるため。
 */
export const runnerUnpushedWorkOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), result: unpushedWorkResultSchema }),
  z.object({ kind: z.literal('unavailable'), reason: z.string() }),
]);
export type RunnerUnpushedWorkOutcome = z.infer<typeof runnerUnpushedWorkOutcomeSchema>;

/** 中身（ファイルの内容）は持たない。名前と件数だけ。 */
export const scratchSweepItemSchema = z.object({
  name: z.string(),
  kind: z.enum(['directory', 'file', 'symlink', 'node_modules']),
  managerId: z.string().optional(),
  untracked: z.object({ count: z.number().int(), names: z.array(z.string()) }).optional(),
  paths: z.array(z.string()).optional(),
  files: z.object({ count: z.number().int(), names: z.array(z.string()) }).optional(),
  reason: z
    .enum([
      'unpushed-commits',
      'tracked-changes',
      'undecidable',
      'worktree-dependency',
      'rm-failed',
      'untracked-files',
      'non-git-content',
      'stash',
      'unsafe-target',
    ])
    .optional(),
  count: z.number().int().optional(),
  detail: z.string().optional(),
});
export type ScratchSweepItem = z.infer<typeof scratchSweepItemSchema>;

export const scratchSweepEventSchema = z.object({
  type: z.literal('scratch_sweep'),
  runnerId: z.string(),
  removed: z.array(scratchSweepItemSchema),
  kept: z.array(scratchSweepItemSchema),
  scanError: z.string().optional(),
  statfs: z
    .union([
      z.object({
        totalBytes: z.number(),
        usedBytes: z.number(),
        totalInodes: z.number(),
        usedInodes: z.number(),
      }),
      z.object({ unavailable: z.string() }),
    ])
    .optional(),
});
export type ScratchSweepEvent = z.infer<typeof scratchSweepEventSchema>;

export const runnerEventSchema = z.discriminatedUnion('type', [
  /**
   * `managerProvider` / `managerProviders` の名乗りは撤去した: 旧い runner が送ってきても、`z.object` が未知の欄を捨てるので
   * 落ちない（`.strict()` にしないこと）。`capabilities` が無いことは「どの能力も名乗っていない」で、既定値で埋めない。
   */
  z.object({
    type: z.literal('hello'),
    runnerId: z.string(),
    capabilities: z.array(z.string()).optional(),
    /** 無ければ「不明」と読み、既定の帯で埋めない。値域を縛らない: 帯の名前を足した新しい runner の名乗りを旧いデーモンが捨てないため。 */
    managerModel: z.string().optional(),
    workerModel: z.string().optional(),
    /**
     * 器ごとの事実を名乗らせる（デーモンの設定と二重管理にしない）。無ければデーモン側の既定値で検める。
     * `capabilities` は名前の集合で値を持てないので、別の optional 欄にした。
     */
    attachmentBodyLimit: z.number().int().positive().optional(),
    /** 無い（旧い版）なら別口を持たないので、デーモンは大きいファイルを送らずに断る（#4128 段3a）。 */
    attachmentStageLimit: z.number().int().positive().optional(),
    /** 開いている peer が無い器は送らない。hello の後に開閉が変われば `manager_peers` で名乗り直す。 */
    managerPeers: z.array(runnerManagerPeerSchema).optional(),
    managerPeersClosed: z.array(runnerManagerPeerClosedSchema).optional(),
    /** 鍵の値は載せない。`[]` は「見たが何も置かれていない」、無ければ「名乗っていない」。 */
    anthropicRoute: z.array(z.string()).optional(),
  }),
  /** その時点の全体を名乗り直す（デーモンは丸ごと置き換える）。旧 daemon は未知の type として落とすだけで接続は切れない。 */
  z.object({
    type: z.literal('anthropic_route'),
    runnerId: z.string(),
    anthropicRoute: z.array(z.string()),
  }),
  /** `anthropic_route` と同じく、その時点の全体を名乗り直す（差分ではない）。旧 daemon は未知の type として落とすだけで接続は切れない。 */
  z.object({
    type: z.literal('manager_peers'),
    runnerId: z.string(),
    managerPeers: z.array(runnerManagerPeerSchema),
    managerPeersClosed: z.array(runnerManagerPeerClosedSchema).optional(),
  }),
  z.object({
    type: z.literal('session'),
    managerId: z.string(),
    sessionId: z.string(),
    sessionGeneration: sessionGenerationSchema,
    /** 省略は空の結果とは違う（古い runner・init に `plugins` が無かったセッション）。 */
    pluginLoad: agentPluginLoadSchema.optional(),
  }),
  z.object({ type: z.literal('project_key'), managerId: z.string(), projectKey: z.string() }),
  z.object({
    type: z.literal('report'),
    managerId: z.string(),
    /** セッションの世代（`sessionGenerationSchema`）。 */
    sessionGeneration: sessionGenerationSchema,
    /**
     * runner が新しい値を毎回振るのではなく、SDK 側の識別子（`turn_ended` の `message.uuid`）をそのまま運ぶ:
     * `ManagerPool#emit` が `randomUUID()` を毎回振ると `event.id` を鍵にした冪等化が効かなかったため。
     * 塞ぐのは SSE 再接続の二重配達で、SDK のセッション世代をまたぐ二重 emit は別の `message.uuid` になりうるので塞げない。
     * `.optional()`: 旧 runner が送らない。`reportId` が無い report も黙って捨てない。
     */
    reportId: z.string().optional(),
    text: z.string(),
    status: jobStatusSchema,
    /**
     * `status` では表せない: あちらは仕事の状態で、ここは「その1ターンがどう終わったか」。
     * 上限に当たった回もセッションは生きているので、`status` を `failed` へ倒すと嘘になる。
     * `code` は SDK の語そのまま、`via` はどの印で分かったか。言い換えない（掘り始めの位置が変わるため）。
     */
    failure: z
      .object({
        code: z.string(),
        via: z.string(),
        /** `result.api_error_status`（HTTP の状態番号）。読めたときだけ。枠（429）の判定を `code` の文字列を割らずに行うため。旧 runner は送らない。 */
        status: z.number().int().optional(),
      })
      .optional(),
    /**
     * 構造化された印で判定する: `'（報告なし）'` という文字列に一致させると、マネージャーが本当にそう書いて報告した回まで
     * 黙って畳むため。立てるのは `result` にも `said` にも文字が無かったと確定したときだけで、`failure` が付く回には立てない
     * （`failedReportText()` は必ず本文を作る）。`.optional()` なのは、無いことを「中身があった」の既定値にするため。
     */
    contentless: z.literal(true).optional(),
    /**
     * 「背景処理の完了待ちで畳んだだけ」の印。`runner.ts` は3条件（`failure` が無い・`status === 'done'`・背景タスクの在り高が非0）
     * を全部満たすときだけ立て、1つでも欠けたら必ず配る側へ倒す。
     * `breakdown` は診断用の写しで判定には使わない: `manager.ts` は握り潰すかを欄の有無だけで決める。
     * `.optional()` は新旧どちらのずれでも「配る」側へ倒れるため: 握り潰しは新デーモンと新 runner が揃ったときにしか起きない。
     */
    awaitingBackground: z
      .object({ count: z.number().int().positive(), breakdown: z.string() })
      .optional(),
    /**
     * 値は「族の名前」（例: `'turn_failed'`）で、真偽値にしない: まとめた本文・日誌の内訳に族名を出し、将来族で畳む経路の土台にするため。
     * 立てるのは `failedReportText()` の経路だけ: `reportText()` はマネージャー本人の発話の断片を含みうるので機構が合成したとは言えない。
     * `.optional()` で、無ければ畳まない（版がずれた窓では必ず「起こす側」へ倒れる）。
     */
    synthesized: z.string().min(1).optional(),
    /**
     * `result` を受け取らないまま畳まれたターンの報告。`failure` は立てない: SDK は一度も「応答ではない」と言っておらず、
     * 取れない事実を取れた顔で出すことになるため（`status` も変えない）。本文は完遂した報告ではなく途中経過なので、
     * 見出しが「直近の報告」のままだと完遂と読まれる。
     * `synthesized` を流用しない: 本文が `said`（本人が書いた断片）を連結するため、「機構が合成した」と言うと嘘になる。
     * `reason` は `#flushUnreported` が受け取った理由文字列をそのまま運び、言い換えない。
     * `.optional()` は新旧どちらのずれでも「これまでどおり」へ倒れる。
     */
    unreported: z.object({ reason: z.string() }).optional(),
    /** 中身は載せない: デーモンが `GET /managers/:id/outbox/:fileId` で取りに行き、受け取ったら `DELETE` で消す。旧 runner が送らない欄は「添付が無い」と読む。 */
    files: z.array(runnerOutboxFileSchema).optional(),
    rejectedFiles: z.array(runnerOutboxRejectedFileSchema).optional(),
  }),
  /**
   * 1ターン1行ではなく委譲1区間1行にする: ターンの回数と時刻は既に日誌にあり、足りないのは契機だけなので、
   * 1ターン1行は日誌でいちばん書き込みの多い経路を二重にする。「どの作業者だったか」は `tool_use` の日誌にある。
   *
   * 数えるのは「マネージャーのターン」だけで、作業者（Task サブエージェント）のターンは出てこない。
   * 作業者は同一の SDK セッションの中で走り、SDK が層をまたいで合算して降ろすので分離できない。分離しようとしないこと。
   */
  z.object({
    type: z.literal('worker_wait'),
    managerId: z.string(),
    openedAt: isoDateTime,
    /** `task_started` の件数で、作業者の人数ではない（同じ `task_id` が二度来れば二度数える）。ambient task も間引かない。 */
    tasks: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    /** 3つの合計は必ず `turns` と一致する（排他で1件だけ数える）。 */
    byCause: z.object({
      input: z.number().int().nonnegative(),
      /** 「通知の直後に回ったターン」であって、その通知が原因だったことの証明ではない。 */
      notification: z.number().int().nonnegative(),
      /**
       * 消去法で出している値: 分類の漏れ（まだ知らない第4の契機）も黙ってここへ流れ込む。
       * 「SDK/CLI 側の自己継続である」は解釈であって観測ではない——alteroid はこの部分のコードを1行も持たないので
       * 直接確かめる手段が無い。
       */
      continuation: z.number().int().nonnegative(),
    }),
    /** マネージャー自身の `PostToolUse` が発火しなかったことだけを言う（本文だけ書いて終わったターンも入る）。作業者の道具は混ぜない。 */
    toolless: z.number().int().nonnegative(),
    /** 対応する `task_started` を観測していない通知も数えるので、`tasks` を超えうる。 */
    notifications: z.number().int().nonnegative(),
    /** `turns` と食い違うこと自体が観測だが、食い違いの原因までは言っていない。 */
    submits: z.number().int().nonnegative(),
    /**
     * 取れた分だけ載せ、1件も取れなければフィールドごと省く（`{}` を置かない）。
     * `system` は「機械に起こされたターン」の数で、通知か SDK の自己継続かの内訳ではない。
     * 無いことは機械に起こされていないではない: SDK JSDoc は「Payloads may omit it while the field rolls out」[sdk-verbatim UserPromptSubmitHookInput.source] と言っている。
     */
    sources: z.record(z.string(), z.number().int().nonnegative()).optional(),
    /**
     * 閉じる瞬間の `#openTasks.size === 0` をそのまま使う。`false` は閉じた時点で完了通知が未着の委譲があったことだけを言い、
     * 通知が失われたことは意味しない。`true` でも最後の `result` が来ないまま畳まれると `turns` に含まれない（`submits` との突き合わせで気づける）。
     */
    settled: z.boolean(),
  }),
  z.object({
    type: z.literal('ask'),
    managerId: z.string(),
    /** セッションの世代（`sessionGenerationSchema`）。 */
    sessionGeneration: sessionGenerationSchema,
    requestId: z.string(),
    /** `kind` は元から必須（旧 runner も送っていた）なので optional にしない。 */
    kind: waitingKindSchema,
    summary: z.string(),
    /** `runnerWaitingSchema.askedAt` と同じ理由で `.optional()`（旧 runner は送らない）。 */
    askedAt: isoDateTime.optional(),
    /**
     * 印は `summary` の先頭にも必ず書く（`【peer: <provider>】`）: 旧いデーモンはこの欄を落とすので、本文の印が無いと
     * 印の無い承認が作られる。判定はこの欄の有無で行い、文言では行わない。
     */
    source: z.object({ type: z.literal('peer'), provider: z.string() }).optional(),
  }),
  z.object({
    type: z.literal('settled'),
    managerId: z.string(),
    sessionGeneration: sessionGenerationSchema,
    requestId: z.string(),
    /**
     * 畳むとき（`#settleAll`）に解いた確認だけに載る: `query.close()` が await を挟まず直後に呼ばれるので、
     * CLI がこの確認への答えを一度も受け取っていない、という事実を記録に残すための欄。
     * `reason` は `#settleAll(reason)` に渡った文字列そのままで、言い換えない。
     * `.optional()`: 新旧どちらの組でも `withdrawn` が無い側の挙動に倒れる。判定は欄の有無で行い、`reason` の文言では行わない。
     */
    withdrawn: z.object({ reason: z.string() }).optional(),
  }),
  /** runner が何かを落とすときの口。マネージャーの発言ではないので `report` と混ぜない。 */
  z.object({
    type: z.literal('note'),
    managerId: z.string(),
    text: z.string(),
    /**
     * 判定は必ずこの欄で行う: 本文を文字列で嗅ぐと表記ゆれで壊れる。
     * `.optional()` は新旧どちらの組でも壊れない: 旧デーモンは未知の欄を落として日誌にだけ残し、旧 runner は欄を送らない。
     */
    escalate: z.boolean().optional(),
    /**
     * `escalate` と同じく、判定は必ずこの欄で行い `note.text` の文言では行わない。
     * 中の欄を optional にしない: `stall` が存在する限り新 runner は全部揃えて送る。`agentType` だけは SDK が `agent_type` を
     * 欠くことがあるので、取れたときだけ載せる。旧デーモンでは新種別 `subagent_stall` としては記録されず `exchange` に留まる。
     */
    stall: z
      .object({
        agentId: z.string(),
        agentType: z.string().optional(),
        /** 当人が自分で起こした背景処理のうち、残っていた件数。 */
        ownedTaskCount: z.number().int().nonnegative(),
        /** その瞬間のセッション全体の在庫。 */
        sessionTaskCount: z.number().int().nonnegative(),
        /** この `agent_id` を起こし直した回数（今回を含む）。 */
        wakeupCount: z.number().int().nonnegative(),
        /** 2値を潰さない: 前者は委譲が進む見込みのある空転、後者は自動では再開しない空転で、数える側は区別したい。 */
        outcome: z.enum(['woken', 'limit_reached']),
      })
      .optional(),
    /**
     * `#reopenForTokenRotation` から来た回だけ立つ。`manager.ts` はこれを見て `#rememberTokenIdentity` を呼び直す:
     * そうしないと自動の開き直しを知らないまま古い世代を名乗り続け、世代表示が追いついたセッションにまで ⚠ を出し続ける。
     * 識別子そのものは乗せない: runner は生の値しか受け取っておらず世代を知らないので、daemon が自分の現役の身元を読み直す。
     * 判定は必ずこの欄で行い、`text` の文言では行わない。
     */
    tokenRotation: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    managerId: z.string(),
    /** `manager:<id>` / `worker:<id>:<agent>`。 */
    actor: z.string(),
    tool: z.string(),
    /**
     * `.optional()` は冗長ではない: `hook.tool_input` が無いことがあり、`JSON.stringify` が `undefined` のキーを落とすので、
     * zod 4 の `z.unknown()`（キーの不在を許さない）が必須だと `tool_use` イベントがまるごとデーモンに届かない。
     * `schema.ts` の `tool_use` エントリの `input` も同時に `.optional()` でなければならない: 日誌の読み出しで行が消えるため。
     */
    input: z.unknown().optional(),
  }),
  /**
   * 確認へ上がらずにその場で止められた道具の実行（分類器・deny 規則）。確認の入り口を閉じた側で何が起きたかを見る口で、
   * 無いと「静かになった」と「起きていない」が区別できない。事実だけを運ぶ: 繰り返しを知らせるかの判断はデーモン側。
   */
  z.object({
    type: z.literal('permission_denied'),
    managerId: z.string(),
    /** 同じ拒否を二度上げないための鍵（生の合図と `result` の記録の両方に載る）。SDK が付けてこなければ runner が作る。 */
    toolUseId: z.string(),
    tool: z.string(),
    /**
     * `.optional()` は冗長ではない: `via: 'live'` の合図には `tool_input` が無く、`JSON.stringify` がキーごと落とす。
     * zod 4 は必須の `z.unknown()` のキーの不在を許さないので、live の拒否が一切届かず、`#denied` が立っているため
     * `result` 側の再送も止まって拒否が失われる。
     * `input` の欄へ後から詰めない: SDK の合図に無い値を runner が埋めれば推測であって事実ではない。
     * 後から届く `result` の入力の形だけは `note` で降ろすが、それでもこの欄は埋めない（「合図に入力が付いていた」という嘘になるため）。
     */
    input: z.unknown().optional(),
    /** `live` は走行中の合図、`result` はターン終わりの記録（SDK 曰くこちらが authoritative）。 */
    via: z.enum(['live', 'result']),
    /**
     * `tool_use` の `actor` と同じ形で運ぶ。`.optional()` は「原理的に取れない回がある」ことを表す:
     * `via: 'result'` の `SDKPermissionDenial` には `agent_id` が無い。
     * `undefined` を「マネージャーだった」の既定値にしない: 無いものは無いまま運び、片方の層へ黙って寄せない。
     */
    actor: z.string().optional(),
    /**
     * `.optional()` は `input` と同じ理由: 必須にすると値が無い回の `permission_denied` が丸ごと `safeParse` に落ち、
     * `#denied` が立っているので再送も起きない。`via: 'result'` では必ず欠ける（理由の欄が無い）。
     */
    reason: z.string().optional(),
    /** `reason` の文字列を解釈して分類し直さない: 言い回しは SDK の版で変わりうるので、分類はこちらの種別で判定する。 */
    reasonType: z.string().optional(),
    /** モデルが tool_result として受け取った文言そのもの（`reason` は人間向け）。 */
    message: z.string().optional(),
    /**
     * `input` とは出所が違う: SDK が運んだ値ではなく、alteroid 自身の `PreToolUse` フックが拒否より前に見た入力を runner が
     * 伏せて切ったもの（最大160字）。`input` の欄へ詰めず別の欄にする: 事実（SDK が運んだ値）と観測（runner が別経路で見た値）を混ぜない。
     * `.optional()`: `PreToolUse` を経由しない拒否や、控えが先に忘れられた回は欠け、作り物で埋めない。
     */
    inputHead: z.string().optional(),
  }),
  /**
   * 累積のまま降ろす。差分は runner で作らない: 再送で同じイベントが2回届いても累積なら増分0で済むが、
   * 差分だと二重計上になり、数字は増えるだけなので誰も気づけない。
   */
  z.object({
    type: z.literal('usage'),
    managerId: z.string(),
    sessionId: z.string().optional(),
    models: z.record(z.string(), usageTotalsSchema),
    /**
     * 失敗したターンの文脈占有は `usage` が `event.succeeded` の内側でしか出ないためここに乗らない。
     * 独立の `context_usage` イベントが観測できた回すべてを送る。`#flushUsage` はターンの境界ではないので付けない。
     */
    contextUsage: contextUsageObservationSchema.optional(),
    /**
     * `usage` が来たことを成功の証拠にしない: 枠に当たったターンも `subtype: 'success'` / `is_error: true` で返り `usage` が降りるため、
     * 成功と読むと `recovered` → 委譲を起こす → また枠で落ちる、の無限の往復になる。
     * 欠けていたら「応答ではない」と読む（成功を捏造しない）。`#flushUsage` はこの欄を付けない。
     */
    answered: z.boolean().optional(),
  }),
  /**
   * `usage` とは別のイベントにする: peer のセッションは基準が別で、マネージャー本体の累積と混ぜると差分が嘘になるため、
   * runner が peer セッションごとの基準で差分にしてから降ろし、デーモンはそのまま積む（`accumulation: 'oneshot'`）。
   * `unmetered` は provider が消費を報告しないターンで、値の行は作らず「取れなかった」と数える。
   */
  z.object({
    type: z.literal('peer_usage'),
    managerId: z.string(),
    provider: z.string(),
    sessionId: z.string().optional(),
    models: z.record(z.string(), usageTotalsSchema),
    unmetered: z.boolean().optional(),
  }),
  /**
   * 消費（`usage`）に相乗りさせない: `usage` は `event.succeeded` の内側でしか出ず、失敗したターンの文脈占有が残らないため、
   * `case 'turn_ended'` の先頭から無条件に送る。観測そのものが `undefined` の回は送らない。
   */
  z.object({
    type: z.literal('context_usage'),
    managerId: z.string(),
    sessionId: z.string().optional(),
    turnSucceeded: z.boolean(),
    contextUsage: contextUsageObservationSchema,
  }),
  /** 文言は言い換えずそのまま運ぶ: claude.ai の画面と人間が突き合わせられなくなるため。 */
  z.object({
    type: z.literal('usage_notice'),
    managerId: z.string(),
    notice: usageLimitNoticeSchema,
  }),
  /** ターンを回している間しか届かないので、使い捨ての probe による定期観測（`usage-snapshot.ts`）と併用する。 */
  z.object({
    type: z.literal('rate_limit'),
    managerId: z.string(),
    facts: rateLimitFactsSchema,
  }),
  z.object({
    type: z.literal('mirror'),
    managerId: z.string(),
    key: z.object({
      projectKey: z.string(),
      sessionId: z.string(),
      subpath: z.string().optional(),
    }),
    entries: z.array(z.unknown()),
  }),
  z.object({ type: z.literal('archive'), managerId: z.string(), body: z.string() }),
  z.object({
    type: z.literal('closed'),
    managerId: z.string(),
    /** セッションの世代（`sessionGenerationSchema`）。 */
    sessionGeneration: sessionGenerationSchema,
    status: jobStatusSchema,
    reason: z.string(),
    /**
     * 貸し出し期限の自己失効で畳まれたことの構造化された印。判定は文言で行わない: `reason` への文字列一致だと、
     * マネージャーが偶然同じ文言を報告に書いた回まで巻き込むため。
     * `status` は `lost` のまま動かさない（このプロセスでは続けられない）。台帳側がこの印を見て貸し出しだけ返し、別の器から引き取り直せるようにする。
     * `.optional()` は、無いことを「自己失効ではない」の既定値にして、この欄を送らない古い runner の `closed` を壊さないため。
     * `stop()` や resume 不能で `#finish` へ落ちる経路には立たない。
     */
    selfFenced: z.literal(true).optional(),
    /**
     * `reason` の言い換えではなく並べて運ぶ別の欄: 語は `reason` にも残るが、1本の文字列だと「枠（429）で落ちた」と
     * 「器の資源で落ちた」を分けるには文字列を解釈するしかなくなる。`code` を持たない例外ではこの欄ごと付けない
     * （`''` や `'unknown'` を入れると「取れなかった」と「取れて空だった」が同じ形になる）。`status` は `failed` とは限らない。
     */
    systemError: systemErrorFactsSchema.optional(),
    /**
     * 委譲が生きていた間に、器の cgroup 全体で増えた「上限で拒んだ／殺した」回数の差分。器全体の差分であって、この委譲の専有ではない。
     * `systemError` とは別の軸: `code` を持たない例外（signal で畳まれた回など）にはあちらが付かず、こちらだけが効く。
     * 読めない・開いたときの値が無い回は欄ごと出さない（0 と混ぜない）。
     */
    cgroupEvents: cgroupEventsDeltaSchema.optional(),
    /**
     * `closed` を emit する直前に runner が自分で取る: `RunnerSession#finish()` は `closed` を emit した同じ同期区間で `#onClosed()` を呼ぶので、
     * デーモンが `closed` を受けてから `pool.unpushedWork()` を呼んでも、セッションは消えていて空振りする。
     * `kind: 'unavailable'` は取れなかったことそのもので、欄が丸ごと無いこととは混ぜない。書き込みは `manager.ts` の `case 'closed'` が持つ。
     */
    unpushedWork: runnerUnpushedWorkOutcomeSchema.optional(),
  }),
  /**
   * `resume` の応答では表せない: 命令は受理され（HTTP 200）、SDK が「そんな会話は無い」と答えるのはストリームが開いた後のため。
   * 降ろさないと、デーモンは「戻せた」と思ったまま同じ session_id へ投げ直し続ける。
   */
  z.object({
    type: z.literal('resume_failed'),
    managerId: z.string(),
    sessionId: z.string(),
    reason: z.string(),
    /** `false` ならその仕事は止まっている。 */
    recovered: z.boolean(),
  }),
  /**
   * `closed` を流用しない: `closed` の意味（status の終端・貸し出しの解放・自己失効の判定）を引き継がずに未 push の観測だけを運ぶため。
   * 流用すると `manager.ts` の `case 'closed'` の「止めたマネージャーの closed で status を巻き戻さない」ガードをすり抜ける経路が増える。
   * best-effort: SIGTERM 直後は SSE 購読も切れかけているので届く保証は無い。届かなかった回は欄の更新自体が起きず、
   * 既存の観測がそのまま残る（「0件」を新しく作らない）。
   *
   * どの `stop()` から出るか: `Host#shutdown()` 経由だけで、`Host#stop(managerId)` 経由の明示停止は対象外。
   * デーモン起点の停止は、呼び出し元が停止の前に `pool.unpushedWork()` を呼べるため。
   * `closed.unpushedWork` と違い `.optional()` にしない: この欄を運ぶことが存在理由のため。
   */
  z.object({
    type: z.literal('shutdown_unpushed_work'),
    managerId: z.string(),
    unpushedWork: runnerUnpushedWorkOutcomeSchema,
  }),
  /**
   * 走行中に届く経路で運ぶ: `closed` / `shutdown_unpushed_work` は器が入れ替わる最後の瞬間にしか出ず、届かないことがあるため。
   * 前回から変わった作業ツリーだけを送り、未追跡のパスは名前だけで中身は運ばない。
   * 旧 daemon は未知の type を `safeParse` で落とし、接続は切れない。
   */
  z.object({
    type: z.literal('rescue_ref'),
    managerId: z.string(),
    worktrees: z.array(rescueWorktreeSchema),
  }),
  /**
   * 古いセッションの出来事でも落とさない: 外へ出した事実はセッションの世代と関係なく残るため。
   * 旧 daemon は未知の type を `safeParse` で落とし、接続は切れない。
   */
  z.object({
    type: z.literal('external_output'),
    managerId: z.string(),
    output: externalOutputSchema,
  }),
  /**
   * 畳みの最初に、`closed` / `archive` / `shutdown_unpushed_work` より前に1回だけ送る: デーモンと runner が同じ反映で SIGTERM を受けると
   * デーモンが先に終わり、runner が畳みの最後に積む出来事が購読者の居ない outbox に残るため。
   * デーモンはこの名乗りを聞いた runner についてだけ、その SSE が閉じるまで上限付きで待つ。名乗らない旧 runner は待たない。
   * `vacate` とは別物（runner 自身が畳み始めた事実の通知）。
   */
  z.object({
    type: z.literal('shutting_down'),
    runnerId: z.string(),
  }),
  /**
   * 日誌には書かない（稼働の地図のメモリへ渡すだけ）。`input` は載せない（量と伏せ字のため）。20秒を超えて未決のときだけ1回送る。
   * peer（Codex）は道具ごとのフックが無くターンが丸ごと1つの仕事なので、20秒を待たずターンの開始で送り、終わりで `tool_end` を送る。
   * 欄が無いことを「実行中でない」と読まない。
   */
  z.object({
    type: z.literal('tool_running'),
    managerId: z.string(),
    actor: z.string(),
    tool: z.string(),
    toolUseId: z.string(),
    startedAt: isoDateTime,
    /** peer のときだけ載る。どちらも無ければ載せない（「既定」と読む）。 */
    model: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('tool_end'),
    managerId: z.string(),
    toolUseId: z.string(),
  }),
  /**
   * 未知の欄（`paths` / `files`）は旧 daemon が捨てるが、未知の列挙値（`kind` / `reason`）を含む出来事は全体が `safeParse` で落ちる
   * （接続は切れず、その1件が届かないだけ）。`statfs` は余力の観測で、警告の閾値ではない。
   */
  scratchSweepEventSchema,
  /** `changed` は値を載せない（指紋と元の版だけ）: デーモンが制御面で取りに行き、版の compare-and-swap で書き戻す。 */
  z.object({
    type: z.literal('codex_auth'),
    runnerId: z.string(),
    kind: z.enum(['changed', 'failed']),
    baseRevision: z.string(),
    fingerprint: z.string().optional(),
    reason: z.string().optional(),
  }),
]);

export type RunnerEvent = z.infer<typeof runnerEventSchema>;

// ---------------------------------------------------------------------------
// 失敗の種別
// ---------------------------------------------------------------------------

/** status を落とさずに持ち上げる: 「待てば直る」と「待っても直らない」の判断は宛先の実装に依らないので、口の定義と同じ場所に置く。 */
export class RunnerHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RunnerHttpError';
    this.status = status;
  }
}

/** 挑み直しに数えない: 古い版の runner（404）は挑み直しても同じ答えで、数えると同じ失敗が日誌へ積まれ続けるため。 */
export class RunnerMcpServersUnsupportedError extends Error {
  constructor(runnerId: string) {
    super(
      `${runnerId} は MCP の登録を受け取る口を持たない（古い版の runner。` +
        'この runner で起こすマネージャー・作業者は記憶ストアの登録を持たずに走る。runner を上げれば次の名乗りで降りる）',
    );
    this.name = 'RunnerMcpServersUnsupportedError';
  }
}

/** 挑み直しに数えない（`RunnerMcpServersUnsupportedError` と同じ）。 */
export class RunnerPluginsUnsupportedError extends Error {
  constructor(runnerId: string) {
    super(
      `${runnerId} は plugin を受け取る口を持たない（古い版の runner。runner を上げれば次の名乗りで降りる）`,
    );
    this.name = 'RunnerPluginsUnsupportedError';
  }
}

/** `null` は外す。 */
export const runnerSetCodexAuthCommandSchema = z.object({
  codexAuth: z.object({ value: z.string(), revision: z.string().min(1) }).nullable(),
});

export const runnerTakeCodexAuthWriteBackCommandSchema = z.object({
  fingerprint: z.string().min(1),
});

export const runnerCodexAuthWriteBackSchema = z.object({
  value: z.string(),
  baseRevision: z.string(),
  fingerprint: z.string(),
});

/** 挑み直しに数えない（`RunnerMcpServersUnsupportedError` と同じ）。 */
export class RunnerCodexAuthUnsupportedError extends Error {
  constructor(runnerId: string) {
    super(
      `${runnerId} は Codex の ChatGPT ログインを受け取る口を持たない（古い版の runner。` +
        'この runner の peer の Codex は CODEX_API_KEY が無ければ認証を持たずに走る。runner を上げれば次の名乗りで降りる）',
    );
    this.name = 'RunnerCodexAuthUnsupportedError';
  }
}

/** runner は 409 で返す。500 にしない: 5xx は「待てば直る」に分類され、古い世代の命令が延々と挑み直されるため。 */
export class RunnerFenceError extends Error {
  readonly managerId: string;
  readonly expected: number;
  readonly given: number;

  constructor(input: { managerId: string; expected: number; given: number }) {
    super(
      `manager_id=${input.managerId} の命令が古い世代を名乗っている` +
        `（runner が覚えている世代=${input.expected}, 受け取った世代=${input.given}）。` +
        'このセッションには一切触れていない。',
    );
    this.name = 'RunnerFenceError';
    this.managerId = input.managerId;
    this.expected = input.expected;
    this.given = input.given;
  }
}

/** 「戻せなかった」と同じ扱いにしない: 409 は新しい世代の誰かがその委譲を握っているので、`lost` にすると起こし直して二重実行になる。 */
export function isFencedRunnerError(error: unknown): boolean {
  return error instanceof RunnerHttpError && error.status === 409;
}

/**
 * status が分からない失敗（`fetch failed`・器が起き上がりきっていない）は「待てば直る」側に寄せる: 諦めると走行中の仕事が `running` のまま残る。
 * 4xx は runner が「その命令は受け取れない」と答えているので、同じものを投げ直しても同じ答えが返る（混雑を表す 408 / 429 だけは別）。
 */
export function isRetryableRunnerError(error: unknown): boolean {
  if (!(error instanceof RunnerHttpError)) return true;
  if (error.status === 408 || error.status === 429) return true;
  return error.status >= 500;
}

/** 409（世代で拒まれた）は含めない（`isFencedRunnerError`）。 */
export function isInvalidDelegationRefusal(error: unknown): boolean {
  return (
    error instanceof RunnerHttpError &&
    (error.status === 400 || error.status === 415 || error.status === 422)
  );
}

/** 移送のとき（別の runner を探せるとき）だけ `#reattach` が使う。元の runner への復帰では使わない。 */
export function isRunnerSpecificRefusal(error: unknown): boolean {
  return (
    error instanceof RunnerHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 409 &&
    !isRetryableRunnerError(error) &&
    !isInvalidDelegationRefusal(error)
  );
}

// ---------------------------------------------------------------------------
// デーモン側から見た runner
// ---------------------------------------------------------------------------

/**
 * 「観測していない」はこの型の外: `RunnerClient.legState` を持たない実装（`LocalRunner`）は欄を持たないだけで、
 * `'never-connected'` へ倒さない（「脚が無い」と「脚が繋がっていない」は別の事実）。
 */
export type RunnerLegState =
  | {
      status: 'connected';
      since: string;
      /** 接続はしたがまだ1バイトも受け取っていない窓では省く（0件を作らない）。 */
      lastByteAt?: string;
    }
  | {
      status: 'down';
      /** `fetch` が一度も応答を返さないまま待ち続けている段階では取れない。 */
      since?: string;
      /** 例外の文言とは限らない: 例外を投げずに閾値未満で静かに閉じた回は固定文言になる。 */
      lastFailureReason?: string;
      nextRetryAt?: string;
    }
  | { status: 'never-connected' };

/** `switch` の `default` に置くと、状態が増えたときに `tsc` で落ちる。 */
export function assertNeverRunnerLegStatus(status: never): never {
  throw new Error(`未知の RunnerLegState.status: ${String(status)}`);
}

export interface RunnerStagedAttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

/** `size` は runner の自己申告（応答の `content-length`）で、信じきらない。 */
export interface RunnerOutboxContent {
  /** 無ければ自己申告が無い（読み手は `body` を数えて上限で打ち切る）。 */
  readonly size?: number;
  readonly body: AsyncIterable<Uint8Array>;
}

/** デーモンは特定 runner の実装やローカルパスを前提にしない。 */
export interface RunnerClient {
  /**
   * `HttpRunner` は `/health` から一度も受け取れていなくても既定値 `'runner-primary'` を持つので、
   * 「聞けたか」の判定はこの欄ではなく {@link runnerIdKnown} で行う（取れていない値が取れた値の顔をして出る）。
   */
  readonly runnerId: string;
  /** `false` のときの `runnerId` は既定値で、出す側は出さない。`LocalRunner` は常に `true`。 */
  readonly runnerIdKnown: boolean;
  readonly workspacePath: string;
  /**
   * 判定を `workspacePath === ''` で代用しない: 本当に空文字を名乗った runner と、一度も接続できていない既定値が区別できなくなる。
   * `onSwap` / `onLost` はこの欄を読まない（`workspacePath` を運ばない）。
   */
  readonly workspacePathKnown: boolean;
  /**
   * `hello()` が読む `GET /health` から接続の瞬間に一度だけ読む値で、heartbeat では更新しない（それは `identity()` の役目）。
   * 省略されたとき名簿は `unheard` のまま: 「版を名乗った上で分からない」（`unknown`）と混同しない。
   */
  readonly revision?: RunnerRevisionReport;
  /**
   * 接続の瞬間に要る: 直後に走るデーモンの引き取りの貸し出し期限判定（`lease.ts`）がこの値を材料にするため、
   * heartbeat を待つと「判定材料が無い」まま引き取りが走る窓ができ、生きている器の仕事を奪いうる。
   * 無いことを「入れ替わっていない」と読まない（`judgeLease` は `undecidable` へ倒れる）。
   */
  readonly instanceId?: string;
  connect(onEvent: (event: RunnerEvent) => void): Promise<void>;
  /**
   * SSE の `hello` は器が礼儀正しく落ちたときにしか届かないので、沈黙を拾うための補完。
   * 省略した実装は名簿が「叩く必要が無い＝生きている」と読む（口を強いると「常に失敗」か「嘘の成功」になる）。
   * `signal` は名簿の probe 期限で、返らない1台が名簿全体を止めないために使う。
   */
  ping?(options?: { signal?: AbortSignal }): Promise<void>;
  /**
   * 名乗りの中身を読むが採らない口: 名簿は `runnerId` を上書きせず、`instanceId` が変わったことを知らせるだけにする
   * （黙って採ると器の入れ替わりで台帳の鎖 `manager_id → runner_id` が音もなく繋ぎ変わる）。
   * 省略した実装・古い runner では入れ替えを判定せず、「入れ替わっていない」と読まない。
   * `pendingEvents` / `oldestPendingAt` / `managers` は `/health` が既に返している欄で、heartbeat からも warm するために拾う。
   * `undefined` は「取れていない」であって0ではない。`managers` が0なら `list()` を引かずに済ませる。
   */
  identity?(options?: { signal?: AbortSignal }): Promise<
    | {
        runnerId?: string;
        instanceId?: string;
        revision?: RunnerRevisionReport;
        pendingEvents?: number;
        oldestPendingAt?: string;
        managers?: number;
      }
    | undefined
  >;
  /**
   * `ping` に相乗りさせない: `ping` は本文を読み捨てる設計で、読む物を1つ足すと読んではいけない物も読む口になるため。
   * 採るのは資源だけで、`runnerId` / `workspacePath` は採らない。省略した実装は名簿が「報告しない器」として扱い、`select` で不利にしない。
   * `signal` は配置の期限で、返らない1台が配置全体を止めないために使う。
   */
  resources?(options?: { signal?: AbortSignal }): Promise<RunnerPlacementResources | undefined>;
  /**
   * 問い合わせない: `HttpRunner` が `#pump` / `#stream` の中で更新しているフィールドを読むだけの同期的な値。
   * 持たない実装（`LocalRunner`・テストの偽物）に「常に `never-connected`」という嘘を書かせないため省略できる。
   */
  readonly legState?: RunnerLegState;
  /**
   * `cwd` は省略されうる（`runnerSessionOpenResultSchema` の doc）。呼び出し側は欠けた回を「頼んだ値のまま」へ倒さず「未確認」と読む。
   */
  start(command: RunnerStartCommand): Promise<{ cwd?: string; sessionGeneration?: string }>;
  /** `RunnerFenceError` を投げうる（世代が古い。呼び出し側は 409 へ変換すること）。 */
  resume(command: RunnerResumeCommand): Promise<RunnerResumeResult>;
  /**
   * 戻り値は「届いたか」（`answer()` の `delivered` と同じ）。`false` は runner がその `managerId` のセッションを持っていない。
   * `void` にしない: `LocalRunner` は例外を投げる経路を持たず、`false` を捨てると `#sendDetectingMissingSession` の自己修復が発火しない。
   * 非2xx を例外で投げる実装（`HttpRunner`）も `false` を返す実装も契約を満たし、呼び出し側は両方を「セッションが無い」と読む。
   */
  send(
    managerId: string,
    text: string,
    attachments?: readonly RunnerAttachment[],
  ): Promise<boolean>;
  /** `decision` は `delivered` が true でも欠けうる。欠けた回を allow/deny の既定値へ倒さない（journal は「不明」として扱う）。 */
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome>;
  stop(managerId: string): Promise<void>;
  /**
   * 10秒ごとの生存確認もここを叩く。`identity()` などと違い別の URL（`GET /managers`）で、heartbeat 1周につき1台あたり1往復増える。
   * 払う理由: 払わないと、消えたセッションを持つ委譲が誰かが `manager_send` を打つまで `[running]` と出続ける。
   * `manager_list` の側に opt-in を足す形では CLI・HTTP API・Web UI の3面に運べず穴が残る。`manager_list` は自分では往復を足さない。
   */
  list(options?: { signal?: AbortSignal }): Promise<RunnerManagerState[]>;
  /**
   * スキーマに合わずに読めなかったが `managerId` だけは拾えた委譲の id も返す。省略できる（版ずれは別プロセスの runner だけで起きる）。
   * 読めなかった委譲を黙って落とすと、Pool は「runner に居ない」と判定し、まだ走っている委譲の貸し出しを解放して待っていた確認を捨てて resume する。
   */
  listWithUnreadable?(options?: { signal?: AbortSignal }): Promise<RunnerManagerListing>;
  /** runner のローカルにある生ログ。無ければ null。 */
  transcript(managerId: string): Promise<string | null>;
  /**
   * 無ければ `undefined`（404・退避先が消えた）。取れなかった（接続断・期限切れ・非2xx）ときは投げる。
   * 読む側が大きさを数えて途中で打ち切る。口を持たない実装は、呼び出し側が「取り出しの口を名乗っていない」として扱い、取れたことにしない。
   */
  openOutboxFile?(
    managerId: string,
    fileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<RunnerOutboxContent | undefined>;
  /** 冪等。受け取って置き場へ入れた後に呼ぶ。失敗は呼び出し側が握る（取りこぼしは runner の24時間の掃除が消す）。 */
  deleteOutboxFile?(
    managerId: string,
    fileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /**
   * 置けなかったら投げる: 呼び手は理由つきで命令を送らずに断る（#4128 段3a）。押す向きだけで、runner から取りに行く経路は作らない。
   * 省略した実装へは、呼び手が大きいファイルを送らずに断る。
   */
  stageAttachment?(
    managerId: string,
    meta: RunnerStagedAttachmentMeta,
    body: AsyncIterable<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /**
   * 委譲のターンが報告で終わったときにも1回呼ばれ、観測が台帳に残る（`manager.ts` の `case 'report'`。失敗しても報告の配達は止めない）。
   * `manager_list` と `force: true` の経路からは呼ばない: 一覧の側から自動で往復を足さず、決めた後に往復を払う意味も無い。
   * ネットワークを一切使わない（`fetch` も `git ls-remote` もしない）: 費用の性質を変えないため。
   * 省略した実装に「0件でした」という嘘を書かせない: `undefined` は「確かめられなかった」で、0 とは混ぜない。
   */
  unpushedWork?(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined>;
  /**
   * push の資格は runner の子の環境にしか無いので、消すのは runner。`commit` は lease（remote の ref がそれと違えば消さない）。
   * 口が無い実装は呼び出し側が `no-runner` として残し、消したことにしない。応答が読めない・期限切れは `failed` を返し、消えたとは言わない。
   */
  deleteRescueRef?(
    request: RunnerRescueRefDeleteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RunnerRescueRefDeleteResult>;
  /** 値は返らない。これが無いと、人間が置いた鍵とマネージャーが握っている鍵が同じかを誰も切り分けられない。 */
  credentials(): Promise<RunnerCredentialFingerprint[]>;
  /** 器を作り直さずに鍵を回すための口。 */
  setCredentials(
    credentials: RunnerSetCredentialsCommand['credentials'],
  ): Promise<RunnerCredentialFingerprint[]>;
  /** 本文は返らない。 */
  profile(): Promise<RunnerProfileFingerprint | undefined>;
  /** runner が繋ぎ直すたびに降ろし直す: 器が入れ替われば置いたものは消えるため。 */
  setProfile(script: string): Promise<RunnerProfileResult>;
  /** 値は返らない。省略した実装には、口が無いことを「確かめられなかった」として扱い、「置いていない」という嘘を書かせない。 */
  mcpServers?(): Promise<RunnerMcpServersFingerprint | undefined>;
  /**
   * 空の `{}` は登録を外す。runner が繋ぎ直すたびに降ろし直す（登録はプロセスのメモリにしか無い）。
   * 効くのはこれから開くセッションから（SDK の `mcpServers` は `query()` の起動時に1度だけ渡る）。
   * 口を持たない古い runner には `RunnerMcpServersUnsupportedError` を投げ、省略した実装へは降ろさない。
   */
  setMcpServers?(servers: McpServers): Promise<RunnerMcpServersFingerprint | undefined>;
  /**
   * 持っていなければ `undefined`。口を持たない古い runner も `undefined`（区別は `setPlugin` の 404）。
   * 欄が在るのに読めなかったときは投げる（「持っていない」へ倒さない）。
   */
  plugins?(): Promise<RunnerPluginsFingerprint | undefined>;
  /** 同名は置き換え。口を持たない相手には `RunnerPluginsUnsupportedError` を投げる。 */
  setPlugin?(plugin: RunnerPluginPush): Promise<RunnerPluginFingerprintEntry>;
  /** 一覧に無いものを runner はメモリから外す。口を持たない相手には `RunnerPluginsUnsupportedError`。 */
  retainPlugins?(names: readonly string[]): Promise<RunnerPluginsFingerprint | undefined>;
  /** `null` は外す。runner が繋ぎ直すたびに降ろし直す。口を持たない相手には `RunnerCodexAuthUnsupportedError` を投げる。 */
  setCodexAuth?(push: { value: string; revision: string } | null): Promise<void>;
  /** 指紋が一致するものが無ければ `null`。 */
  takeCodexAuthWriteBack?(
    fingerprint: string,
  ): Promise<{ value: string; baseRevision: string; fingerprint: string } | null>;
  /**
   * インプロセス実装はセッションごと畳むが、HTTP 実装はストリームを閉じるだけ:
   * デーモンの再起動で runner の中のマネージャーを殺さない。
   */
  close(): Promise<void>;
  /**
   * デーモンが畳むとき（`ManagerPool#stop`）だけ呼ぶ。呼ばれたらそれ以上繋ぎ直さない（新しい器へ繋がって、引き取りが畳み中のデーモンで走らないように）。
   * いま開いているストリームが終わったとき（runner が exit したとき）に解く。ストリームは自分から切らない（切るのは `close()`）。
   */
  awaitStreamEnd?(): Promise<void>;
}

/**
 * 「開いた接続」ではなく「開き方」を取る: 接続そのものだと名簿を作る前に runner を開き終える必要があり、
 * 起動時に最大2分、chat も日誌も承認も止まっていたため。開き方なら runner が上がっていなくても名簿に載せられ、失敗しても名簿の側が挑み直せる。
 */
export interface RunnerSource {
  /** `runnerId` は登録時に要求しない（繋がるまで分からない）。名簿の中で1台を指す鍵はこの label で、同じ label の再登録は「その宛先を開き直す」意味になる。 */
  label: string;
  open: () => Promise<RunnerClient>;
}

/**
 * `unreachable` と `lost` は似て見えるが**別物である**。前者は「まだ開けていない」
 * 宛先で、抱えている仕事は無い。後者は「開けていた」宛先で、**走っていた仕事ごと
 * 黙った**可能性がある — あとで移送の契機になるのはこちらだけである。
 *
 * `vacating` は意図して空けている最中で、`lost` と同じく委譲は置かず移送の元になる。
 * デーモンが接続の結果から計算する値で、runner の応答を parse するためのスキーマではない。
 */
export const runnerLivenessSchema = z.enum([
  'connecting',
  'connected',
  'unreachable',
  'unusable',
  'lost',
  'vacating',
]);

export type RunnerLiveness = z.infer<typeof runnerLivenessSchema>;

/**
 * `unheard`（名乗りを一度も聞いていない）を `unknown`（名乗ったが版を知らない）と混同しない: 対処が違う（前者はネットワーク・登録、後者は runner の設定を疑う）。
 * `unreachable` と同じ語を使わない: あちらは宛先が開けないことで、主語が違う。
 * `RunnerLiveness` から導出しない: `lost` でも `#markSilent` は学習した `revision` を捨てないので `known` が残り、
 * `connected` でも `revision` を実装しない runner（`LocalRunner` 等）は `unheard` のまま残る。
 * `known` は「最後に聞いた名乗り」で、`lost` のときは黙る前の値。単独で読まず `state` と併せて読む。
 */
export type RunnerRevisionStatus = RunnerRevisionReport | { status: 'unheard' };

/**
 * `runnerId` と `workspacePath` は繋がるまで分からないので省略されうる: 「登録されているのに繋がっていない」を表せないと、
 * `GET /runners` が空を返すだけになり「設定し忘れた」のか「上がってこない」のかが区別できない。値は返さない（状態だけ）。
 */
export interface RunnerEntry {
  label: string;
  state: RunnerLiveness;
  runnerId?: string;
  workspacePath?: string;
  /** 原因を人間が見るための窓で、値は載せない。 */
  error?: string;
  since: string;
  /**
   * 名乗らない runner では無い。無いことを「入れ替わっていない」と読まない。
   * 遷移の知らせ（`onSwap`）とは別に状態としても出す: 引き取りの判定（`lease.ts`）の材料が人間から見えないと、判定が正しいかを誰も確かめられない。
   */
  instanceId?: string;
  /**
   * 「入れ替えを観測した時刻」ではなく「いまの相手を初めて見た時刻」: デーモンの再起動直後は入れ替えの瞬間を知らないので、
   * 自分が初めて見た時刻から数える（過去に見積もると、まだ畳まれていない器の仕事を奪いに行く。`lease.ts` の `LEASE_DRAIN_MS`）。
   */
  instanceSince?: string;
  /**
   * 生存判定の起点（最後に名乗りが返った周の時刻。開いた直後は開けた時刻）。`lost` のあいだも動かない。
   * 引き取りの判定（`lease.ts` の `holderSeenAt`）の材料: 台帳の `seenAt` は書き込みのついでにしか進まず、黙って確認を待っている委譲の持ち主が
   * いまも名乗っているかを台帳だけでは言えないため（#4454）。
   */
  lastSeenAt?: string;
  /** 常に3値のどれかで省略されない。`state` が `'lost'` でも古い値が残ることがある（`RunnerRevisionStatus`）。 */
  revision: RunnerRevisionStatus;
  /**
   * heartbeat が最後に聞けた値。`identity()` を持たない runner は heartbeat から warm しないので `undefined` のままでありうる:
   * 「行が出ない＝滞留0」ではない（`RunnerBacklogSnapshot`）。
   */
  pendingEvents?: number;
  oldestPendingAt?: string;
  pendingEventsObservedAt?: string;
  /**
   * `pendingEvents` を観測したときの相手の instanceId を凍結して持つ（`instanceId` は随時更新される）:
   * 時刻の大小ではなく instanceId 同士を直接比べて器の入れ替えを検出するため。
   */
  pendingEventsInstanceId?: string;
  /**
   * `undefined` は「1本も抱えていない」ではなく「まだ聞けていない」: 畳むと、聞けなかった回を「セッションが消えた」と読み、
   * 走っているマネージャーを一覧が「セッションが無い」と名乗る。空配列が「答えたが1本も無かった」。
   * 聞けた回にだけ `sessionsObservedAt` と対で載せる（最大10秒古い）。
   */
  sessions?: readonly string[];
  sessionsObservedAt?: string;
  /** 欄を名乗った委譲だけが載る: 古い runner の委譲はキーが無い（0 ではなく「分からない」）。 */
  sessionBackgroundTasks?: Readonly<Record<string, number>>;
  /** 鍵の指紋で、値は持たない。キーが無いのは「分からない」。 */
  sessionTokenFingerprints?: Readonly<Record<string, string>>;
  /** `entries()` のたびに `entry.client.legState` を読み直す。観測の時刻の対は持たない。無いことは `'never-connected'` とは別の事実。 */
  legState?: RunnerLegState;
}

/**
 * `select` に人工的な上限を入れない: 「同時に何本まで」は能力の削除であって配置の判断ではない。
 * 見てよいのは runner が報告する CPU・メモリ・稼働セッション数といった実行環境の資源である。
 */
export interface RunnerRegistry {
  /** 開けていないものは並ばない（`entries` で見る）。 */
  list(): Promise<RunnerClient[]>;
  get(runnerId: string): Promise<RunnerClient | null>;
  /**
   * 必ず返る: 繋がるまで待つ形にすると、委譲を呼んだクローンのターンが張り付く。繋がっていないだけなら短い猶予のあいだ待ち、
   * それを過ぎたらどの宛先がいまどの状態かを添えて投げる（登録が0台・まだどれにも繋がっていない・全部 `unusable` の3種は対応が変わるので区別する）。
   * 「同時に何本まで」を理由に断らない（north_star 禁止2）。
   *
   * `cwd` は置き先の材料になっていない: 渡しても読まない。全台が同じ `workspacePath`（`/workspace`）を名乗り実体だけが別のボリュームなので、
   * パスの一致ではどの器か区別が付かず、照合を入れると効いていない照合が「効いている」ように残る。
   *
   * `runnerId` は指名として読み、資源による自動配置を通さずその器へ置く。本数の制限ではない。指名の失敗
   * （名簿に一致が無い・`connected` ではない・一致が複数開けている）はどれも自動配置へ落とさない: 落とすとクローンの判断が見えないまま覆される。
   * `runnerId` は開けてからしか分からないので、まだ開けていない器があるときは「名簿に無い」と断定しない。
   * 一致が複数のときは `Registry#get` が線形一致で先に見つかった方を返すため、片方に固定できない既知のギャップがある。
   */
  select(input: { cwd?: string; runnerId?: string }): Promise<RunnerClient>;
  /** 開き終わるのを待たずに載る。失敗しても投げない: 開けなかったことは名簿の状態になり、待てば直る種類なら背景で挑み直す。 */
  register(source: RunnerSource): Promise<void>;
  unregister(label: string): Promise<void>;
  /**
   * デーモン内部の名簿の操作で、runner には何も投げない（`RunnerClient` ではなくここに置くのは `runnerLivenessSchema` と同じ理由）。
   * 同期で完結する。効果は `list()` から外れることだけで、委譲を移す・止めるのは呼び出し元（`ManagerPool`）の別の握手。
   */
  vacate(runnerId: string): void;
  /**
   * 点数計算の側だけでは塞げない: 配置の点数は `cores / (managers + 1)` を含み、`managers` はセッションが落ちればその場で減るので、
   * 落ちるほど落とした器の点数が上がり、`chooseByResources` が純関数のため壊れた器が磁石になる。`#place` には「さっき何本落ちたか」が無いので外から入れる。
   * 数えた失敗は「いま抱えている本数」へ足し戻すだけで、点数を負にも0にもしない（制限ではない。`chooseByResources` は0点でも返す）。
   * 口を省略可能にしない: 省略が静かに効き、呼ばれない配線は赤くならない。同期で完結する。
   */
  noteManagerFailed(runnerId: string): void;
  /**
   * 「いま新しいプロセスを起こせない」印（`closed` の `systemError.code === 'EAGAIN'`・`cgroupEvents.pidsMaxDelta > 0`）を知らせる。文言は読まない。
   * `noteManagerFailed` と違い `failed` に限らず `lost` の回も数える。制限ではない（全台が飽和なら最良を返す）。省略可能（偽の名簿が持たなくても型が通る）。
   */
  notePidsSaturationSign?(runnerId: string, sign: PidsSaturationSign): void;
  /**
   * 材料が無ければ `undefined`（「飽和ではない」とは言わない）。`pids` を渡さなければ直近の配置で取った現在値を使い、
   * 印は窓（`PLACEMENT_FAILURE_MEMORY_MS`）の内側だけを数える。
   */
  pidsSaturationOf?(
    runnerId: string,
    pids?: { readonly current: number; readonly max: number },
  ): PidsSaturation | undefined;
  /**
   * 繋がっていないものも並ぶ（`GET /runners` の材料）。`runner_list` の継続点（`runner-cursor.ts`）が依拠する契約:
   * `label` は一意で、並びは `Map` の反復順＝登録順（呼びをまたいで安定する）。並びを変えるなら継続点の錨も見直す。
   * 錨が消えないことまでは約束しない（`unregister` で器は消えうる。継続点は `restarted` として扱う）。
   */
  entries(): RunnerEntry[];
  /** 後から現れた runner に繋ぐための口: 無いと、後から載った runner の報告も許可確認も永久に届かない。 */
  subscribe(onOpen: (runner: RunnerClient) => void): () => void;
  /** 開いた runner は閉じない: 閉じる方針は `ManagerPool` が持っており、ここで閉じると方針が2箇所に散る。 */
  stop(): Promise<void>;
}

export interface RunnerRegistryOptions {
  /** 黙って挑み続けない: 鍵違いや命令の形の誤りは待っても直らず、無限に叩くと設定の誤りが「なぜか繋がらない」として隠れる。 */
  notify?: (failure: { label: string; error: string }) => void;
  /**
   * 1回だけ呼ばれる。状態の再計算ではなく遷移にする: 都度数える形だと落ちた瞬間が現れず、移送の契機が作れない。
   * この口自体は移送をしない: 奪ってよいかの判定は貸し出し期限（fencing）の関門が持ち、持ち主が握っている委譲は動かされない。
   */
  onLost?: (lost: { label: string; runnerId?: string; error: string }) => void;
  /**
   * `onLost` では拾えない: 器が入れ替わっても `/health` は応え続け、生死の判定からは何も起きていないように見える。
   * この口自体は引き取りをしない: 入れ替えが見えることと「もう動いていない」ことは別（ネットワークだけが分かれると古いプロセスが走り続ける）ので、
   * 奪ってよいかは `ManagerPool` の関門（`#claimForResume`）が持つ。入れ替わるたびに呼ばれる（`onLost` と違い1回だけではない）。
   */
  onSwap?: (swap: {
    label: string;
    /** 書き換えていない値。 */
    runnerId?: string;
    before: string;
    after: string;
  }) => void;
  /** 回数では諦めない。主にテスト用。 */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** 環境変数の設定項目にしない: 数値をつまみとして外へ出すと、そこが実質の制限になる。主にテスト用。 */
  selectWaitMs?: number;
  /**
   * `#place` が全台へ聞いた `resources()` の結果を配置の後にもう一度渡す。追加の往復は無い。
   * `runnerIdKnown` が true の器だけを渡す: `client.runnerId` は未聞でも既定値を持ち、名乗った器と取り違えるため。
   * 呼び出し側は fire-and-forget で受ける: 待つと `select()`（延いては `manager_start` の応答）がこのコールバックの終わりまで待たされる。
   * 判断は `ManagerPool` の仕事のままで、ここは通知口に留める。
   */
  onPlacementResources?: (
    reports: readonly {
      readonly runnerId: string;
      readonly resources: RunnerPlacementResources | undefined;
    }[],
  ) => void;
  /**
   * 既定は `Date.now`。主にテスト用: `vi.useFakeTimers()` だと名乗りを聞きに行く `setInterval` と `withDeadline` の `setTimeout` まで止まり、
   * 測りたい窓（`PLACEMENT_FAILURE_MEMORY_MS`）以外の時計が巻き込まれる。本番の起動経路は渡さない。
   */
  now?: () => number;
}

/** 上限は能力の上限ではなく、器が長く戻らないときに秒間何度も叩かないための頭打ち（north_star 禁止2 が禁じるのは実行回数の制限）。 */
const REGISTRY_RETRY_BASE_MS = 1_000;
const REGISTRY_RETRY_MAX_MS = 30_000;

/** コードに固定する。環境変数に出さない: つまみにすると、そこが実質の制限になる。待ち続けると呼んだ側が状況を知れない。 */
const SELECT_WAIT_MS = 3_000;

/**
 * この5分は実測ではなく仮定である。測られた値として扱わない。短いほうから始めた: 長すぎる記憶は「一時的な不調が過ぎた器を避け続ける」形になり戻しにくい。
 * 「1本落ちて、5分空いて、また1本落ちる」は数えられないが、連続して落ちるあいだは窓が更新され続けるので、同じ器が選ばれ直す輪には効く。
 * 環境変数の設定項目にしない（`SELECT_WAIT_MS` / `HEARTBEAT_*` と同じ理由）。制限ではない: 伸ばしても縮めても置き先は返る。
 */
const PLACEMENT_FAILURE_MEMORY_MS = 5 * 60_000;

/**
 * 3つの数値はコードに固定する。環境変数の設定項目にしない: 「何秒で死んだと見なすか」をつまみにすると、そこが実質の制限になる
 * （長くすれば落ちた器が宛先のまま残り、短くすれば生きている器が落ちたことにされる）。
 */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** 1回の取りこぼしで動かさない: 再デプロイ中の一瞬や詰まった1回の応答で宛先を失うと、生きている runner から仕事を取り上げる。 */
const HEARTBEAT_LOST_MS = 30_000;

/**
 * 出口（`entries()` / `onSwap` / `onLost`）ごとに同じ分岐を書かないための1本。`runnerIdKnown` を見ずに `entry.client.runnerId` を出すと、
 * 一度も聞けていない相手の既定値 `'runner-primary'` が「受け取った値」の顔で出る。塞ぐのは出口だけで、`#reattach` 自身は `runnerId` の文字列一致だけで相手を決めている。
 */
function heardRunnerIdOf(client: RunnerClient | null): { runnerId?: string } {
  return client !== null && client.runnerIdKnown ? { runnerId: client.runnerId } : {};
}

/**
 * `heardRunnerIdOf` を広げず別関数にする: 出口の数が軸ごとに違い（`workspacePath` を運ぶのは `entries()` だけ）、
 * 2つの欄は独立に「聞けたか」が決まるため（片方だけ型に合う応答はありうる）。
 */
function heardWorkspacePathOf(client: RunnerClient | null): { workspacePath?: string } {
  return client !== null && client.workspacePathKnown
    ? { workspacePath: client.workspacePath }
    : {};
}

/** 期限が無いと、黙って死んだ器（拒否せず何も返さない）に probe が張り付き、誰の生死も更新されない。 */
const HEARTBEAT_PROBE_MS = 5_000;

/** 環境変数の設定項目にしない（`SELECT_WAIT_MS` と同じ理由）。期限を過ぎた1台は宛先から外れず、「報告しない器」になる。 */
const PLACEMENT_PROBE_MS = 2_000;

export function createRunnerRegistry(
  runners: RunnerClient[] = [],
  options: RunnerRegistryOptions = {},
): RunnerRegistry {
  const registry = new Registry(options);
  for (const runner of runners) registry.adopt(runner);
  return registry;
}

interface RegistryEntry {
  source: RunnerSource;
  state: RunnerLiveness;
  since: string;
  client: RunnerClient | null;
  error?: string;
  /** 多重に開きに行かないための1本。 */
  opening: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  delay: number;
  /** 経過時間だけで生死を決めない（それは `alive` の仕事）。ここにあるのは判定の材料。 */
  lastSeen: number;
  /** 前回の判定結果。突き合わせないと、落ちている間ずっと同じ答えが出て遷移（生きている → 落ちた）が消え、知らせが何度も出るか一度も出ないかになる。 */
  alive: boolean;
  /** `alive` と同じ「前回の値」。持たない runner では `undefined` のままで、判定しない（「入れ替わっていない」と読まない）。 */
  instanceId?: string;
  /** 入れ替えの瞬間ではなく「自分が初めて見た時刻」: デーモンの再起動直後は瞬間を知らず、知らないものを過去に見積もらないため。 */
  instanceSince?: string;
  /** 前回との比較はしない（入れ替えは `instanceId` で検出済み）。`state` が `'lost'` になっても戻さない（`#markSilent` は学習済みの情報を捨てない）。 */
  revision: RunnerRevisionStatus;
  /**
   * heartbeat の `identity()` から最後に聞けた値。`undefined` のときは書かない: 0で埋めると「滞留0」と「まだ観測していない」が区別できなくなる。
   */
  pendingEvents?: number;
  oldestPendingAt?: string;
  /** これが無いと、`manager.ts` の `runnerBacklog()` が `resources()` 由来のキャッシュとの新旧を比べられない。 */
  pendingEventsObservedAt?: string;
  pendingEventsInstanceId?: string;
  /**
   * `undefined`（まだ聞けていない）と空集合（答えたが1本も無かった）を畳まない。`#probeSessions` は聞けた回にしか書かず、
   * 失敗した回は前の観測を残す（消すと「聞けなかった」が「1本も無い」に化ける）。
   */
  sessions?: ReadonlySet<string>;
  sessionsObservedAt?: string;
  sessionBackgroundTasks?: ReadonlyMap<string, number>;
  sessionTokenFingerprints?: ReadonlyMap<string, string>;
  /** 周期より遅い応答を積み上げないための錠: `true` の間はこの entry へ次の探りを投げない。 */
  sessionsProbing?: boolean;
}

/**
 * 持ち主を1つにするために外へ出してある: 宛先が引けなかったことを報告する場所は名簿の中だけではなく（`ManagerPool#send` にもある）、
 * 両方で組み立てると片方だけが状態を畳んだ形へ倒れても気づけない。`state` を `connected` へ畳まない:
 * 「まだ開けていない」と「待っても同じ答えが返る」の違いが、読む側が待つか起こし直すかを決める材料のため。
 */
export function describeRunnerEntries(entries: RunnerEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${entry.label} は ${entry.state}` +
        `${entry.error === undefined ? '' : `（${entry.error}）`}`,
    )
    .join(' / ');
}

class Registry implements RunnerRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #subscribers = new Set<(runner: RunnerClient) => void>();
  readonly #waiting = new Set<{
    resolve: (runner: RunnerClient) => void;
    reject: (e: Error) => void;
  }>();
  readonly #notify: ((failure: { label: string; error: string }) => void) | undefined;
  readonly #onLost:
    ((lost: { label: string; runnerId?: string; error: string }) => void) | undefined;
  readonly #onSwap:
    | ((swap: { label: string; runnerId?: string; before: string; after: string }) => void)
    | undefined;
  readonly #onPlacementResources:
    | ((
        reports: readonly {
          readonly runnerId: string;
          readonly resources: RunnerPlacementResources | undefined;
        }[],
      ) => void)
    | undefined;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #selectWaitMs: number;
  /** 窓の外は読むたびに畳む（`#freshFailuresOf`）ので、別のタイマーは持たない。 */
  readonly #failures = new Map<string, number[]>();
  readonly #saturationSigns = new Map<string, { at: number; sign: PidsSaturationSign }[]>();
  readonly #livePidsAtLimit = new Map<string, { at: number; current: number; max: number }>();
  readonly #now: () => number;
  /** `stop()` で必ず畳む（残すとテストがハングする）。 */
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(options: RunnerRegistryOptions) {
    this.#notify = options.notify;
    this.#onLost = options.onLost;
    this.#onSwap = options.onSwap;
    this.#onPlacementResources = options.onPlacementResources;
    this.#retryBaseMs = options.retryBaseMs ?? REGISTRY_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxMs ?? REGISTRY_RETRY_MAX_MS;
    this.#selectWaitMs = options.selectWaitMs ?? SELECT_WAIT_MS;
    this.#now = options.now ?? Date.now;

    const heartbeat = setInterval(() => this.#beat(), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    this.#heartbeat = heartbeat;
  }

  adopt(runner: RunnerClient): void {
    const label = runner.runnerId;
    this.#entries.set(label, {
      source: { label, open: async () => runner },
      state: 'connected',
      since: new Date().toISOString(),
      client: runner,
      opening: null,
      timer: null,
      delay: this.#retryBaseMs,
      lastSeen: Date.now(),
      alive: true,
      revision: { status: 'unheard' },
    });
  }

  /**
   * `lost` は並べない（新しい仕事を沈黙へ投げ込むことになる）。`vacating` も並べない（空けると決めた宛先へ置くのは drain の意図に反する）。
   * どちらも `entries()` には残って人間から見える。
   */
  async list(): Promise<RunnerClient[]> {
    return [...this.#entries.values()].flatMap((entry) =>
      entry.client === null || entry.state === 'lost' || entry.state === 'vacating'
        ? []
        : [entry.client],
    );
  }

  async get(runnerId: string): Promise<RunnerClient | null> {
    for (const entry of this.#entries.values()) {
      if (entry.client?.runnerId === runnerId) return entry.client;
    }
    return null;
  }

  entries(): RunnerEntry[] {
    return [...this.#entries.values()].map((entry) => ({
      label: entry.source.label,
      state: entry.state,
      since: entry.since,
      lastSeenAt: new Date(entry.lastSeen).toISOString(),
      revision: entry.revision,
      ...heardWorkspacePathOf(entry.client),
      ...heardRunnerIdOf(entry.client),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      // 開けていなくても最後に名乗ったプロセスは出す: 消すと、黙っている間だけ戻ってきたときの突き合わせ材料が消える。
      ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
      ...(entry.instanceSince === undefined ? {} : { instanceSince: entry.instanceSince }),
      ...(entry.pendingEvents === undefined
        ? {}
        : {
            pendingEvents: entry.pendingEvents,
            ...(entry.oldestPendingAt === undefined
              ? {}
              : { oldestPendingAt: entry.oldestPendingAt }),
            ...(entry.pendingEventsObservedAt === undefined
              ? {}
              : { pendingEventsObservedAt: entry.pendingEventsObservedAt }),
            ...(entry.pendingEventsInstanceId === undefined
              ? {}
              : { pendingEventsInstanceId: entry.pendingEventsInstanceId }),
          }),
      // `sessionsObservedAt` と対でしか渡さない: 観測時刻の無い一覧は、`manager.ts` 側が「この委譲が置かれる前の観測」を捨てられなくなる。
      ...(entry.sessions === undefined || entry.sessionsObservedAt === undefined
        ? {}
        : { sessions: [...entry.sessions], sessionsObservedAt: entry.sessionsObservedAt }),
      ...(entry.sessionBackgroundTasks === undefined || entry.sessionsObservedAt === undefined
        ? {}
        : { sessionBackgroundTasks: Object.fromEntries(entry.sessionBackgroundTasks) }),
      ...(entry.sessionTokenFingerprints === undefined || entry.sessionsObservedAt === undefined
        ? {}
        : { sessionTokenFingerprints: Object.fromEntries(entry.sessionTokenFingerprints) }),
      ...(entry.client?.legState === undefined ? {} : { legState: entry.client.legState }),
    }));
  }

  subscribe(onOpen: (runner: RunnerClient) => void): () => void {
    this.#subscribers.add(onOpen);
    return () => this.#subscribers.delete(onOpen);
  }

  async register(source: RunnerSource): Promise<void> {
    if (this.#stopped) return;
    const existing = this.#entries.get(source.label);
    // 既に開けている宛先を登録し直しても、繋ぎ直さない（同じものが二重に載らない）。
    if (existing?.state === 'connected') return;
    // 予約を畳んでから入れ替える: 設定を直して登録し直した場合、古い開き方で挑み続ける予約が残ると直したものが効かない。
    if (existing !== undefined && existing.timer !== null) clearTimeout(existing.timer);

    const entry: RegistryEntry = {
      source,
      state: 'connecting',
      since: new Date().toISOString(),
      client: null,
      opening: null,
      timer: null,
      delay: this.#retryBaseMs,
      lastSeen: Date.now(),
      alive: true,
      revision: { status: 'unheard' },
    };
    this.#entries.set(source.label, entry);
    await this.#open(entry);
  }

  async unregister(label: string): Promise<void> {
    const entry = this.#entries.get(label);
    if (entry === undefined) return;
    this.#entries.delete(label);
    if (entry.timer !== null) clearTimeout(entry.timer);
    // 口を閉じる: 名簿から消えたのに SSE だけ残ると、誰も宛先として選べない runner のイベントが流れ続ける。
    await entry.client?.close().catch(() => undefined);
  }

  /**
   * `alive` は触らない: `false` へ倒すと、次の heartbeat の成功が `#markSeen` の「戻ってきた」分岐を通り、`state` が黙って `'connected'` へ書き戻される。
   * `true` のままなら早期 return を通るだけで、生きている heartbeat が `vacating` を踏み潰さない。
   * 一致する entry は `get` のように1台に絞らず全部倒す: 片方だけ残ると、その生き残りへ新しい委譲が置かれ続ける。
   */
  vacate(runnerId: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.client?.runnerId !== runnerId) continue;
      entry.state = 'vacating';
      entry.since = new Date().toISOString();
    }
  }

  noteManagerFailed(runnerId: string): void {
    const fresh = this.#freshFailuresOf(runnerId);
    fresh.push(this.#now());
    this.#failures.set(runnerId, fresh);
  }

  notePidsSaturationSign(runnerId: string, sign: PidsSaturationSign): void {
    const fresh = this.#freshSaturationSignsOf(runnerId);
    fresh.push({ at: this.#now(), sign });
    this.#saturationSigns.set(runnerId, fresh);
  }

  pidsSaturationOf(
    runnerId: string,
    pids?: { readonly current: number; readonly max: number },
  ): PidsSaturation | undefined {
    let live = pids;
    if (live === undefined) {
      const seen = this.#livePidsAtLimit.get(runnerId);
      if (seen !== undefined && seen.at > this.#now() - PLACEMENT_FAILURE_MEMORY_MS) live = seen;
    }
    return pidsSaturationFrom({
      ...(live === undefined ? {} : { pids: live }),
      signs: this.#freshSaturationSignsOf(runnerId).map((entry) => entry.sign),
    });
  }

  #freshSaturationSignsOf(runnerId: string): { at: number; sign: PidsSaturationSign }[] {
    const seen = this.#saturationSigns.get(runnerId);
    if (seen === undefined) return [];
    const since = this.#now() - PLACEMENT_FAILURE_MEMORY_MS;
    const fresh = seen.filter((entry) => entry.at > since);
    if (fresh.length === 0) this.#saturationSigns.delete(runnerId);
    else this.#saturationSigns.set(runnerId, fresh);
    return fresh;
  }

  /** 読むついでに畳む（掃除のためだけのタイマーを足さない）。窓の境目は `>`: ちょうど窓の長さだけ経った1件は数えない。 */
  #freshFailuresOf(runnerId: string): number[] {
    const seen = this.#failures.get(runnerId);
    if (seen === undefined) return [];
    const since = this.#now() - PLACEMENT_FAILURE_MEMORY_MS;
    const fresh = seen.filter((at) => at > since);
    if (fresh.length === 0) this.#failures.delete(runnerId);
    else this.#failures.set(runnerId, fresh);
    return fresh;
  }

  /**
   * `cwd` を仮引数に含めない: 受けて捨てる形にすると「読んでいるが効かなかった」に見え、届いていないこと自体が消える。
   * 作らなければ、呼び出し側から辿った者がここで必ず気づく。
   */
  async select({ runnerId }: { cwd?: string; runnerId?: string } = {}): Promise<RunnerClient> {
    if (runnerId !== undefined) return this.#selectByName(runnerId);

    const until = Date.now() + this.#selectWaitMs;
    for (;;) {
      if (this.#stopped) throw new Error('名簿が停止している');

      const open = await this.list();
      const first = open[0];
      if (first !== undefined) {
        // 1台しか無いなら聞きに行かない。答えは変わらないのに、委譲を起こす経路へ
        // 往復1回分の待ちを足すだけである。
        if (open.length === 1) return first;
        return await this.#place(open, first);
      }

      if (this.#entries.size === 0) {
        throw new Error(
          'manager-runner が1台も登録されていない。' +
            'これは設定の問題なので、時間を置いても直らない' +
            '（ALTEROID_RUNNER_URLS / ALTEROID_RUNNER_URL か同一プロセスの runner が要る）。',
        );
      }

      // 挑み直す先が無いなら待たず理由を添えて返す: 待つと、鍵を間違えた人間が「なぜか委譲が返ってこない」を見る。
      const pending = [...this.#entries.values()].filter((entry) => entry.state !== 'unusable');
      if (pending.length === 0) {
        throw new Error(
          `登録されている manager-runner がどれも使えない。挑み直しても同じ答えが返る種類の` +
            `失敗なので、名簿は挑み直していない: ${this.#describeEntries()}`,
        );
      }

      const remaining = until - Date.now();
      if (remaining <= 0) throw new Error(this.#notConnectedMessage());
      const opened = await this.#waitForOpen(remaining);
      if (opened === null) throw new Error(this.#notConnectedMessage());
    }
  }

  /**
   * 待たない: 名前の解決は待っても名乗っていない器の正体は変わらないので、状態をそのまま返し、呼んだ側が「少し置いて投げ直す」を選べるようにする。
   * どの失敗でも自動配置（`#place`）へ落とさない: 落とすと「指名したのに別の器で走った」という観測されない不一致になる。
   * 一致が複数なら拒む: `Registry#get` は線形一致で先に見つかった方を返すので片方に固定できず、誤った器を黙って選ぶよりましである。
   */
  #selectByName(runnerId: string): RunnerClient {
    const matches = [...this.#entries.values()].filter(
      (entry) => entry.client?.runnerId === runnerId,
    );

    if (matches.length > 1) {
      throw new Error(
        `runnerId=${runnerId} を名乗る器が ${matches.length} 台開けている（名前が一意でない）。` +
          'Registry#get は線形一致で先に見つかった方を返す実装なので、指名しても片方には' +
          '固定できない（fencing #160 が入った後も残る既知のギャップ。個別の穴は #200・#209）: ' +
          excerptLine(
            matches.map((entry) => `${entry.source.label}(${entry.state})`).join(' / '),
            DUPLICATE_RUNNER_ID_EXCERPT,
          ),
      );
    }

    const match = matches[0];
    if (match === undefined) {
      // `unusable` は挑み直さないので、これ以上分かるようにならない。除外する。
      const stillUnknown = [...this.#entries.values()].some(
        (entry) => entry.client === null && entry.state !== 'unusable',
      );
      throw new Error(
        `runnerId=${runnerId} という名前は名簿のどの器の runnerId とも一致しない。` +
          (stillUnknown
            ? 'ただし、まだ一度も開けていないので runnerId が分からない器が残っている' +
              '（開けば一致するかもしれない、「無い」とは断定できない）: '
            : '登録されている器はすべて開き終わっており、それでも一致しなかった: ') +
          this.#describeEntries(),
      );
    }

    if (match.state !== 'connected') {
      throw new Error(
        `runnerId=${runnerId}（${match.source.label}）は名簿にあるが使えない` +
          `（state: ${match.state}${match.error === undefined ? '' : ` / ${match.error}`}）。` +
          '他の器へは自動で落とさない——指名は指名のまま失敗する。',
      );
    }

    const client = match.client;
    if (client === null) throw new Error(`runnerId=${runnerId} の内部整合性エラー`);
    return client;
  }

  /** 聞けなかった1台は「報告しない器」に落ちるだけで宛先から外さない: 外すと、資源を報告しない器が締め出される。 */
  async #place(open: readonly RunnerClient[], fallback: RunnerClient): Promise<RunnerClient> {
    const reports = await Promise.all(
      open.map(async (client) => {
        try {
          const resources = await withDeadline(
            (signal) => client.resources?.({ signal }) ?? Promise.resolve(undefined),
            PLACEMENT_PROBE_MS,
            '資源の報告',
          );
          const pids = resources?.pids;
          if (pids !== undefined && pids.current >= pids.max) {
            this.#livePidsAtLimit.set(client.runnerId, {
              at: this.#now(),
              current: pids.current,
              max: pids.max,
            });
          } else if (pids !== undefined) {
            this.#livePidsAtLimit.delete(client.runnerId);
          }
          return {
            client,
            resources,
            recentFailures: this.#freshFailuresOf(client.runnerId).length,
            pidsSaturated: this.pidsSaturationOf(client.runnerId, pids) !== undefined,
          };
        } catch {
          // 資源を聞けなくても失敗の記憶は落とさない: 名簿が自分で持つ値で、捨てると答えない器ほど落とした事実が消える。
          // `unreachable: true` は「口が無い／`undefined` を返した」成功経路とは別の観測（probe が返っていない）で、`chooseByResources` が別の値として扱う。
          return {
            client,
            resources: undefined,
            recentFailures: this.#freshFailuresOf(client.runnerId).length,
            unreachable: true,
            pidsSaturated: this.pidsSaturationOf(client.runnerId) !== undefined,
          };
        }
      }),
    );

    // 待たない: `onPlacementResources` の実装が内側の非同期処理を `void` で切り離しているので、await する必要が無い。
    this.#onPlacementResources?.(
      reports.flatMap((r) =>
        r.client.runnerIdKnown ? [{ runnerId: r.client.runnerId, resources: r.resources }] : [],
      ),
    );

    return chooseByResources(reports) ?? fallback;
  }

  /** 状態と直近の失敗を必ず添える: 「繋がりません」だけでは、呼んだ側が「少し置いて投げ直す」か「人間に知らせる」かを判断できない。 */
  #notConnectedMessage(): string {
    return (
      'いま繋がっている manager-runner が無いので、委譲を置けない。' +
      '名簿は背景で挑み直し・名乗りの確認を続けている（回数では諦めない）ので、' +
      '少し置いて投げ直せば通ることがある: ' +
      this.#describeEntries()
    );
  }

  #describeEntries(): string {
    return describeRunnerEntries(this.entries());
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    // 先に畳む: 畳み残すと、止めたはずの名簿が背景で runner を叩き続ける。
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const entry of this.#entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
    }
    for (const waiter of this.#waiting) waiter.reject(new Error('名簿が停止した'));
    this.#waiting.clear();
    this.#subscribers.clear();
  }

  #open(entry: RegistryEntry): Promise<void> {
    const already = entry.opening;
    if (already !== null) return already;

    const opening = (async () => {
      try {
        const client = await entry.source.open();
        if (this.#stopped || this.#entries.get(entry.source.label) !== entry) {
          // 開いている間に外された（か止まった）。握り潰さずに閉じる。
          await client.close().catch(() => undefined);
          return;
        }
        entry.client = client;
        entry.state = 'connected';
        entry.since = new Date().toISOString();
        delete entry.error;
        entry.delay = this.#retryBaseMs;
        // 開けた瞬間が生存判定の起点: 置き忘れると、開いた直後の1台が「30秒黙っていた」ことにされる。
        entry.lastSeen = Date.now();
        entry.alive = true;
        // `hello()` が既に読んだ版と instanceId をここで採る: 直後の `#subscribers`（デーモンの引き取り）の貸し出し期限判定が
        // instanceId を材料にし、heartbeat を待つと「判定材料が無い」まま引き取りが走って生きている器の仕事を奪いうる。
        // 省略している runner（`LocalRunner` 等）は何も触らず、「変わっていない」と読まない。
        this.#noteInstance(entry, entry.lastSeen, {
          ...(client.instanceId === undefined ? {} : { instanceId: client.instanceId }),
          ...(client.revision === undefined ? {} : { revision: client.revision }),
        });
        for (const subscriber of this.#subscribers) subscriber(client);
        for (const waiter of this.#waiting) waiter.resolve(client);
        this.#waiting.clear();
      } catch (error) {
        if (this.#stopped || this.#entries.get(entry.source.label) !== entry) return;
        entry.client = null;
        const redacted = redactErrorText(String(error), process.env);
        entry.error = redacted;
        entry.since = new Date().toISOString();
        if (isRetryableRunnerError(error)) {
          // 回数では諦めない: 諦めた先に残るのは、宛先を失ったまま誰にも知らされないデーモン。
          entry.state = 'unreachable';
          this.#scheduleOpen(entry);
        } else {
          entry.state = 'unusable';
          // 知らせはクローンの文脈まで届くので、`entry.error` と同じ伏せ字を通した値を渡す。
          this.#notify?.({ label: entry.source.label, error: redacted });
          this.#failIfAllUnusable();
        }
      } finally {
        entry.opening = null;
      }
    })();

    entry.opening = opening;
    return opening;
  }

  #scheduleOpen(entry: RegistryEntry): void {
    if (this.#stopped || entry.timer !== null) return;
    const delay = entry.delay;
    entry.delay = Math.min(delay * 2, this.#retryMaxMs);
    const timer = setTimeout(() => {
      entry.timer = null;
      if (this.#stopped || this.#entries.get(entry.source.label) !== entry) return;
      void this.#open(entry);
    }, delay);
    timer.unref?.();
    entry.timer = timer;
  }

  /** SSE の `hello` は器が礼儀正しく落ちたときにしか届かないので、沈黙をここで拾う。全台へ同時に投げる。 */
  #beat(): void {
    if (this.#stopped) return;
    const at = Date.now();
    for (const entry of [...this.#entries.values()]) {
      // 開けていない宛先は挑み直しの担当。ここで二重に叩かない。
      if (entry.client === null) continue;
      // 待たずに次を投げる: 直列だと、返らない1台の後ろに全台が並び、1台の沈黙が名簿全体の生死判定を止める。
      void this.#probe(entry, at);
    }
  }

  async #probe(entry: RegistryEntry, at: number): Promise<void> {
    const client = entry.client;
    if (client === null) return;

    let failure: string | null = null;
    let identity:
      | {
          runnerId?: string;
          instanceId?: string;
          revision?: RunnerRevisionReport;
          pendingEvents?: number;
          oldestPendingAt?: string;
          managers?: number;
        }
      | undefined;
    try {
      // `identity()` と `ping()` の両方は叩かない: 10秒ごとに全台へ2往復を投げることになる。
      identity = await withDeadline(
        (signal) =>
          client.identity !== undefined
            ? client.identity({ signal })
            : (client.ping?.({ signal }) ?? Promise.resolve()).then(() => undefined),
        HEARTBEAT_PROBE_MS,
      );
    } catch (error) {
      failure = redactErrorText(String(error), process.env);
    }

    // 聞いている間に外された / 開き直された / 名簿が止まった: 古い答えで上書きしない。
    if (this.#stopped) return;
    if (this.#entries.get(entry.source.label) !== entry || entry.client !== client) return;

    if (failure === null) {
      this.#markSeen(entry, at, client, identity);
      // 0本と答えた回は `/managers` を引かない: `managers` は `/managers` と同じ源（`host.list()`）の件数なので0は一覧が空の確定で、
      // 往復を払っても分かることは増えない。「聞けなかった」ではなく答えた結果なので、空集合として記録してよい。
      if (identity?.managers === 0) {
        entry.sessions = new Set();
        entry.sessionBackgroundTasks = new Map();
        entry.sessionTokenFingerprints = new Map();
        entry.sessionsObservedAt = new Date(at).toISOString();
        return;
      }
      // 待たずに投げる: 遅い1台の `/managers` が次の周期の生死判定を遅らせないため。
      void this.#probeSessions(entry, at, client);
      return;
    }
    this.#markSilent(entry, at, failure);
  }

  /**
   * 失敗しても `#markSilent` を呼ばない: 生死は `/health` ただ1つで決める契約で、ここで倒すと `/managers` だけが詰まった器から仕事を取り上げる。
   * 失敗した回は前の観測を消さない（消すと「聞けなかった」と「1本も無かった」が畳まれる）。
   * 観測時刻は応答が返った時刻ではなく聞きに行った周の時刻（`at`）: 期限まで粘って返った回に「その後にできたセッション」まで見たことにしないため（古い側＝安全側へ倒れる）。
   */
  async #probeSessions(entry: RegistryEntry, at: number, client: RunnerClient): Promise<void> {
    if (entry.sessionsProbing === true) return;
    entry.sessionsProbing = true;
    try {
      const states = await withDeadline(
        (signal) => client.list({ signal }),
        HEARTBEAT_PROBE_MS,
        'セッション一覧',
      );
      if (this.#stopped) return;
      if (this.#entries.get(entry.source.label) !== entry || entry.client !== client) return;
      entry.sessions = new Set(states.map((state) => state.managerId));
      entry.sessionBackgroundTasks = new Map(
        states.flatMap((state): [string, number][] =>
          state.liveBackgroundTasks === undefined
            ? []
            : [[state.managerId, state.liveBackgroundTasks]],
        ),
      );
      entry.sessionTokenFingerprints = new Map(
        states.flatMap((state): [string, string][] =>
          state.tokenFingerprint === undefined ? [] : [[state.managerId, state.tokenFingerprint]],
        ),
      );
      entry.sessionsObservedAt = new Date(at).toISOString();
    } catch {
      // 何も書かない（前の観測を残す）。
    } finally {
      entry.sessionsProbing = false;
    }
  }

  /**
   * 黙っていた器が戻ったら `connected` へ戻す: `lost` のままだと、生きている runner が宛先から永久に外れる。
   * ここで `#subscribers` を呼ばない（引き取りの契機にしない）のは判断である: 入れ替えが見えることと「もう動いていない」ことは別で
   * （ネットワークだけが分かれると古いプロセスが別のところで走り続け、同じ宛先に新しいプロセスが応えうる）、
   * 片側だけで「もう動いていない」と言うには貸し出し期限（lease）が要る。契機にしているのは `#onSwap` と `onLost` の側。
   * `runnerId` は絶対に採らない: 採れば台帳の鎖（`manager_id → runner_id`）が音もなく繋ぎ変わる。
   */
  #markSeen(
    entry: RegistryEntry,
    at: number,
    client: RunnerClient,
    identity?: {
      runnerId?: string;
      instanceId?: string;
      revision?: RunnerRevisionReport;
      pendingEvents?: number;
      oldestPendingAt?: string;
    },
  ): void {
    entry.lastSeen = at;
    this.#noteInstance(entry, at, identity);
    if (entry.alive) {
      delete entry.error;
      return;
    }
    entry.alive = true;
    entry.state = 'connected';
    entry.since = new Date().toISOString();
    delete entry.error;
    for (const waiter of this.#waiting) waiter.resolve(client);
    this.#waiting.clear();
  }

  /** 採るのは `instanceId` だけで、`runnerId` は採らない（採れば台帳の鎖が音もなく繋ぎ変わる）。 */
  #noteInstance(
    entry: RegistryEntry,
    at: number,
    identity:
      | {
          runnerId?: string;
          instanceId?: string;
          revision?: RunnerRevisionReport;
          pendingEvents?: number;
          oldestPendingAt?: string;
        }
      | undefined,
  ): void {
    // 版は前回との比較をしない（入れ替えは `instanceId` で検出済み）。`identity` 自体が無いときは触らず、`unheard` のまま残す
    // （`unknown` と混同しない）。`instanceId` を名乗らない相手でも版は覚えるので、下の早期 return より前に置く。
    if (identity?.revision !== undefined) {
      entry.revision = identity.revision;
    }

    // `pendingEvents` が `undefined` のときは触らない（0で埋めると「滞留0」と「まだ観測していない」が区別できない）。
    // `oldestPendingAt` はそのまま上書きする: 0件に戻った回で前回の値を持ち越さない。
    if (identity?.pendingEvents !== undefined) {
      entry.pendingEvents = identity.pendingEvents;
      entry.oldestPendingAt = identity.oldestPendingAt;
      entry.pendingEventsObservedAt = new Date(at).toISOString();
      // 応答が運んだ instanceId を優先する: pendingEvents と同じ瞬間の値でいちばん正確。無ければ更新前の `entry.instanceId`。
      entry.pendingEventsInstanceId = identity.instanceId ?? entry.instanceId;
    }

    const instanceId = identity?.instanceId;
    if (instanceId === undefined || instanceId.length === 0) return;
    const before = entry.instanceId;
    // 初めて聞いた分は入れ替えではない: 知らせると、デーモンが起きた直後に必ず1回「入れ替わった」が出る。
    entry.instanceId = instanceId;
    // 同じ相手なら動かさない: 動かすと、入れ替わりの猶予が heartbeat ごとに先送りされ、期限が永久に来ない。
    if (before !== instanceId || entry.instanceSince === undefined) {
      entry.instanceSince = new Date(at).toISOString();
    }
    if (before === undefined || before === instanceId) return;
    // 前の器の失敗は忘れる: `runnerId` は作り直しても同じ値なので、消さないと、もう居ないプロセスの記録でいま応えているプロセスの健康を判定する。
    const swappedRunnerId = entry.client?.runnerId;
    if (swappedRunnerId !== undefined) this.#failures.delete(swappedRunnerId);
    this.#onSwap?.({
      label: entry.source.label,
      ...heardRunnerIdOf(entry.client),
      before,
      after: instanceId,
    });
  }

  /** 直近の失敗は必ず残す（`GET /runners` の窓）。落ちたと決めるのは遷移のときだけで、落ちている間ずっと知らせ続けない。 */
  #markSilent(entry: RegistryEntry, at: number, error: string): void {
    entry.error = error;
    if (!entry.alive) return;
    // 意図して空けた宛先は、黙っても `lost` へ倒さない: `vacate()` は `alive` を触らないので、倒すと30秒の断で `vacating` が `lost` に上書きされ、
    // 戻ったときに `#markSeen` の復帰分岐が `connected` へ書き戻して、空けると決めた宛先へ新しい委譲が入り始める。
    // 失う能力は無い（`vacating` も置き先から外れ、移送は `ManagerPool.vacate()` が握手のあと無条件に行う）。
    if (entry.state === 'vacating') return;
    // 1回の取りこぼしでは動かさない: 再デプロイ中の一瞬や詰まった1回の応答で宛先を失うと、生きている runner から仕事を取り上げる。
    if (at - entry.lastSeen < HEARTBEAT_LOST_MS) return;

    entry.alive = false;
    entry.state = 'lost';
    entry.since = new Date().toISOString();
    this.#onLost?.({
      label: entry.source.label,
      ...heardRunnerIdOf(entry.client),
      error,
    });
  }

  /** 待ちを名簿に残したまま帰らない: 残すと、`stop` のときに誰も見ていない拒否が投げられ、時間切れのたびに待ちが積み上がる。 */
  #waitForOpen(ms: number): Promise<RunnerClient | null> {
    return new Promise<RunnerClient | null>((resolve, reject) => {
      // 先に宣言しないと待ち手が自分を畳めない。
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (runner: RunnerClient) => {
          clearTimeout(timer);
          this.#waiting.delete(waiter);
          resolve(runner);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.#waiting.delete(waiter);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        this.#waiting.delete(waiter);
        resolve(null);
      }, ms);
      timer.unref?.();
      this.#waiting.add(waiter);
    });
  }

  #failIfAllUnusable(): void {
    if (this.#waiting.size === 0) return;
    if ([...this.#entries.values()].some((entry) => entry.state !== 'unusable')) return;
    const message =
      '登録されている manager-runner がどれも使えない。挑み直しても同じ答えが返る種類の' +
      `失敗なので、名簿は挑み直していない: ${this.#describeEntries()}`;
    for (const waiter of [...this.#waiting]) waiter.reject(new Error(message));
    this.#waiting.clear();
  }
}

/**
 * `Promise.race` だけにしない: 名簿は先へ進めても叩かれた側の繋ぎが開いたまま残り、黙って死んだ器を10秒ごとに叩くと返らない繋ぎが積み上がる。
 * `signal` を渡し、かつ期限で自分も抜ける（中断を無視する実装があっても名簿は止まらない）。
 */
function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  what = '名乗り',
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${ms}ms 以内に${what}が返らなかった`));
    }, ms);
    timer.unref?.();
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      finish();
    };
    let started: Promise<T>;
    try {
      started = run(controller.signal);
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    started.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/**
 * 点数は「メモリの余り × プロセス数の余り × 新しい1本が受け取る CPU（`cores / (managers + 1)`）」。
 *
 * pids も同じ形で混ぜる: pids が上限に張り付いた器では `fork` が通らず、置かれたマネージャーは起動直後に落ちる。
 * しかも落ちると `managers` が減って `share` の分母が縮み、落とした器の点数が上がる。この関数は純関数なので、落ちるたびに同じ器が選ばれ続ける輪になる。
 * 指数も係数も足さない: 「飽和に近いほど強く」の二乗などは名前の付いていない重みで、次に触る者が動かせなくなる（掛け算の形が既に飽和で強く効く）。
 * pids は「断る」材料ではない。
 *
 * 重みを持たないのは意図である: 重みを設定項目にすれば、そこが実質の定員つまみになる（「メモリの重みを上げる」は「メモリが減ったら断る」に化ける）。
 *
 * 報告の無い材料は、見えている器の平均で埋める: 除外すれば資源を報告しない古い器が締め出され、最良として扱えば余裕のある新しい器が選ばれなくなる。
 * ただし memory と pids の2軸が同時に欠けた器は、軸ごとの平均の積ではなく両方を報告した器の `room × pidsRoom` の平均で埋める:
 * 軸が逆向きに動く器が同居すると、軸ごとの平均の積が実測した全器の点数の範囲を超えうるため。1軸だけ欠けた器は従来どおりその軸の平均で埋める。
 *
 * 直近に落とした本数は抱えている本数へ足し戻す: 失敗が点数を上げも下げもしなくなる。ペナルティではなく観測の補正（重みを足さない）で、点数は0未満にならない。
 * 同点なら登録順の先だが、直近に落とした器は同点のときだけ後ろへ回す: 足し戻しだけだと、登録順の先に居る壊れた器が同点勝ちで磁石のまま残る。
 *
 * **0点でも返る。** 資源を見るのは「どこに置くか」を決めるためで、「置けるか」を決めるためではない（north_star 禁止2）。
 *
 * 点数の前に「段」で分ける: 0 = 健全、1 = 聞けなかった（`unreachable`）、2 = pids 飽和。小さい段が前で、全台が同じ段なら点数で選ぶ（断らない）。
 * 「聞けなかった」を平均で埋めない: 期限切れの器は定義上いま最も混んでいる器で、平均で埋めると見えている器の写しになり、
 * 報告者が1台だけの艦隊では `scoresTie` で同点になって登録順の先（聞けなかった器）が勝つ。段は順序であって重みではなく、記憶を持たない（sticky にしない）。
 */
function chooseByResources(
  reports: readonly {
    client: RunnerClient;
    resources: RunnerPlacementResources | undefined;
    /** 窓の内側で、その器が `failed` で落とした本数。渡さない呼び出しは 0。 */
    recentFailures?: number;
    /** `resources()` が throw したか期限切れで reject した場合だけ `true`（「口が無い／`undefined` を返した」とは別）。渡さない呼び出しは `false`。 */
    unreachable?: boolean;
    /** {@link pidsSaturationFrom} と判定された器か。渡さない呼び出しは `false`。 */
    pidsSaturated?: boolean;
  }[],
): RunnerClient | undefined {
  const rooms = reports.flatMap((r) =>
    r.resources?.memory ? [memoryRoomOf(r.resources.memory)] : [],
  );
  const cores = reports.flatMap((r) => (r.resources?.cpu ? [r.resources.cpu.cores] : []));
  const held = reports.flatMap((r) =>
    r.resources?.managers === undefined ? [] : [r.resources.managers],
  );
  const pidsRooms = reports.flatMap((r) =>
    r.resources?.pids ? [pidsRoomOf(r.resources.pids)] : [],
  );
  // 誰も報告しないときの 1 は点数を素通りさせる値で、上限ではない。
  const meanRoom = mean(rooms) ?? 1;
  const meanCores = mean(cores) ?? 1;
  const meanHeld = mean(held) ?? 0;
  const meanPidsRoom = mean(pidsRooms) ?? 1;
  const meanRoomTimesPids = mean(
    reports.flatMap((r) =>
      r.resources?.memory && r.resources.pids
        ? [memoryRoomOf(r.resources.memory) * pidsRoomOf(r.resources.pids)]
        : [],
    ),
  );

  let best: RunnerClient | undefined;
  let bestScore = -Infinity;
  let bestFailures = Infinity;
  // 誰も居ない状態は一番後ろ（Infinity）に置く: 最初の報告がどの段でも、下の分岐で暫定王として立つ。
  let bestTier = Infinity;
  for (const report of reports) {
    const unreachable = report.unreachable ?? false;
    const tier = report.pidsSaturated === true ? 2 : unreachable ? 1 : 0;
    const room = report.resources?.memory ? memoryRoomOf(report.resources.memory) : meanRoom;
    const pidsRoom = report.resources?.pids ? pidsRoomOf(report.resources.pids) : meanPidsRoom;
    const roomTimesPids =
      !report.resources?.memory && !report.resources?.pids && meanRoomTimesPids !== undefined
        ? meanRoomTimesPids
        : room * pidsRoom;
    const failures = report.recentFailures ?? 0;
    const share =
      (report.resources?.cpu?.cores ?? meanCores) /
      ((report.resources?.managers ?? meanHeld) + failures + 1);
    const score = roomTimesPids * share;

    // 段が違うなら点数を見ずに決める。
    if (tier !== bestTier) {
      if (tier < bestTier) {
        bestScore = score;
        bestFailures = failures;
        best = report.client;
        bestTier = tier;
      }
      continue;
    }

    // 同点かどうかを先に見る: 後にすると、誤差ぶんだけ大きい点数が `score > bestScore` を通って勝ち、艦隊の並び順で結果が変わる。
    if (scoresTie(score, bestScore)) {
      if (failures < bestFailures) {
        bestScore = score;
        bestFailures = failures;
        best = report.client;
      }
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      bestFailures = failures;
      best = report.client;
    }
  }
  return best;
}

/** どちらも構造化された値から立てる（文言は読まない）。 */
export type PidsSaturationSign = 'eagain' | 'fork-denied';

export type PidsSaturationBasis =
  | { readonly kind: 'at-limit'; readonly current: number; readonly max: number }
  | { readonly kind: PidsSaturationSign; readonly count: number };

export interface PidsSaturation {
  readonly basis: readonly PidsSaturationBasis[];
  readonly windowMs: number;
}

/**
 * 純関数で時計を持たない（窓の内側の印だけを呼び出し側が渡す）。現在値は 999 と 1000 の間で揺れるので、印の窓がばたつきを抑える。
 * 現在値が読めないことは「飽和ではない」を意味しない: 材料が無いだけで、印も無ければ `undefined`（0 や false を作らない）。
 * 断る材料ではない: 結果は配置の段と表示にだけ使う。
 */
export function pidsSaturationFrom(input: {
  pids?: { readonly current: number; readonly max: number };
  signs: readonly PidsSaturationSign[];
}): PidsSaturation | undefined {
  const basis: PidsSaturationBasis[] = [];
  const { pids } = input;
  if (pids !== undefined && pids.max > 0 && pids.current >= pids.max) {
    basis.push({ kind: 'at-limit', current: pids.current, max: pids.max });
  }
  for (const kind of ['eagain', 'fork-denied'] as const) {
    const count = input.signs.filter((sign) => sign === kind).length;
    if (count > 0) basis.push({ kind, count });
  }
  if (basis.length === 0) return undefined;
  return { basis, windowMs: PLACEMENT_FAILURE_MEMORY_MS };
}

export function describePidsSaturation(saturation: PidsSaturation): string {
  const minutes = Math.round(saturation.windowMs / 60_000);
  const parts = saturation.basis.map((entry) => {
    switch (entry.kind) {
      case 'at-limit':
        return `pids ${String(entry.current)}/${String(entry.max)} で上限に達している`;
      case 'eagain':
        return `直近${String(minutes)}分に spawn が EAGAIN で失敗 ${String(entry.count)} 回`;
      case 'fork-denied':
        return `直近${String(minutes)}分に fork が pids 上限で拒まれた委譲 ${String(entry.count)} 本`;
    }
  });
  return parts.join(' / ');
}

/**
 * `===` で比べない: 点数は浮動小数なので、同じ諸元の器どうしでも `0.8` と `0.7999999999999999` に割れ、「同点のときだけ効く」分岐が掛け算の順序で効いたり効かなかったりする。
 * 相対で見る: 点数の桁は艦隊の諸元で変わり、絶対値だと大きい器ほど同点になりやすい。
 */
const SCORE_TIE_EPSILON = 1e-9;

function scoresTie(a: number, b: number): boolean {
  // 初回（`bestScore = -Infinity`）と `NaN` は同点にしない。
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= SCORE_TIE_EPSILON * scale;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 使い切っていても 0 で、負にはしない（0点でも置き先になる）。 */
function memoryRoomOf(memory: { limitBytes: number; usedBytes: number }): number {
  if (!(memory.limitBytes > 0)) return 1;
  return Math.min(1, Math.max(0, (memory.limitBytes - memory.usedBytes) / memory.limitBytes));
}

/**
 * `memoryRoomOf` と同じ式: 同じ形の資源（cgroup の上限と現在値の対）に別々の式を当てる理由が無い。上限を 0 以下と読んだ回は 1 へ倒す（壊れた観測でその器を沈めない）。
 * 「あと何本置けるか」ではない: 余りが 100 でも `vitest` が1本立ち上がるだけで pids は +131 跳ねる。「どちらがましか」を比べる目盛りである。
 */
function pidsRoomOf(pids: { current: number; max: number }): number {
  if (!(pids.max > 0)) return 1;
  return Math.min(1, Math.max(0, (pids.max - pids.current) / pids.max));
}
