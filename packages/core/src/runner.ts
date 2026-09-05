import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentContentBlock,
  AgentDelegationNotified,
  AgentDelegationStarted,
  AgentEvent,
  AgentPermissionDenial,
  AgentTurnEnded,
} from './agent-events.js';
import { buildManagerSessionOptions, foldClaudeMessage } from './claude-provider.js';
import { denialInputShape, type DeniedRecord } from './denial-shape.js';
import {
  noteBackgroundFailure,
  noteMissingRecordSource,
  noteUnclassifiedFailure,
  noteUnclassifiedFailuresSummary,
  noteUnreadableRecord,
} from './dropped-record.js';
import type { CredentialEntry, CredentialFingerprint, CredentialStore } from './credentials.js';
import { placedModelTier, resolveModelTier } from './model-tier.js';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  resolvePermissionModeFor,
  type PermissionModeName,
} from './permission-mode.js';
import { createProfileApplier, type ProfileApplier, type ProfileVessel } from './profile.js';
import { createRecentMap } from './recent.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import { RunnerFenceError } from './runner-protocol.js';
import type {
  RunnerAnswerCommand,
  RunnerAnswerOutcome,
  RunnerEvent,
  RunnerLease,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerStartCommand,
} from './runner-protocol.js';
import type { JobStatus } from './schema.js';
// **クローン（`clone.ts`）と同じ判定を呼ぶ。** 「これは応答ではない」の見分けを
// 層ごとに書くと、片方だけが印を見落として非対称になる（実際に
// `result.errors[]` はここにしか無く、クローン側は読んでいなかった）。
//
// **印そのものを読むのは provider の写しである**（`claude-provider.ts` の
// `foldClaudeMessage`）。ここが受け取るのは、既に中立イベントへ載った印である。
import { assistantFailureOf, type SdkFailure } from './sdk-failure.js';
import { classifyUsageNotice } from './usage-limits.js';
import { readSessionUsage } from './usage.js';

/**
 * manager-runner — SDK を隔離して走らせる層（roadmap M4）。
 *
 * **マネージャーと作業者は実装物ではない。** ここに書くのは配線だけ — 起こす・
 * 話しかける・出来事をデーモンへ返す・生ログを渡す。
 *
 * この層は**判断をしない**。「これは人間に聞くべきか」「この道具は許してよいか」は
 * 一切持たず、確認をそのままデーモン（＝クローン）へ上げる。ここに行為の一覧を
 * 置いた瞬間、権限境界が設定に化けて人による違いが潰れる（AGENTS.md 地雷3）。
 *
 * 2つの禁止（north_star）が効くのもここである:
 *
 * - `tools` を**渡さない**（preset 全部）。明示リストで絞れば能力の削除になる
 * - `maxTurns` を渡さない。暴走はターン数ではなく実行環境の境界で止める
 * - 同時セッション数に人工上限を設けない。上限はマシンリソースそのもの
 * - `permissionMode` は人間が開く Claude Code と同じ既定（`auto`）。層を下りた
 *   途端に `Read` や `grep` で止まるのは仕様ではなくデグレード。確認そのものの
 *   経路（`canUseTool` でデーモンへ回す）は残してあり、`default` へ戻せば効く
 */

/** マネージャーのモデル帯の既定。変更には人間の承認が要る（AGENTS.md 地雷5）。 */
export const MANAGER_MODEL = 'opus';

/** 作業者のモデル帯の既定。SDK の既定はマネージャーの継承なので、必ず明示する。 */
export const WORKER_MODEL = 'sonnet';

/**
 * マネージャー / 作業者のモデル帯を人間が差し替えるための環境変数。
 *
 * **クローン（`ALTEROID_CLONE_MODEL`）と同じ性質のものである** — 設定ではなく
 * 人間の承認の置き場で、既定は動かさない（`model-tier.ts` に理由がある）。
 * 3層のうち1層にだけ置き場があるのは非対称で、**「クローンは人間が帯を選べるが
 * マネージャーは選べない」は人間の側の能力の欠落**になる。
 *
 * 読むのは**この層を実際に SDK へ渡す器**、すなわち runner である。デーモンにも
 * 同じ値が降りるが（`compose.yaml` の `x-shared-env` / Railway の Shared
 * Variables）、あちらが使うのは自己認識に載せる**宣言**のためだけで、実際に
 * セッションへ渡っているのはここで解いた値である。
 */
export const MANAGER_MODEL_ENV_KEY = 'ALTEROID_MANAGER_MODEL';
export const WORKER_MODEL_ENV_KEY = 'ALTEROID_WORKER_MODEL';

/** 環境変数を見てマネージャーのモデル帯を決める。空・空白なら既定（`opus`）。 */
export function resolveManagerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, MANAGER_MODEL_ENV_KEY, MANAGER_MODEL);
}

/** 環境変数を見て作業者のモデル帯を決める。空・空白なら既定（`sonnet`）。 */
export function resolveWorkerModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelTier(env, WORKER_MODEL_ENV_KEY, WORKER_MODEL);
}

/**
 * 人間が実際に値を置いた層だけを並べる（起動時に表へ出すための材料）。
 *
 * **「既定と違うもの」ではなく「置かれたもの」を返す。** `ALTEROID_MANAGER_MODEL=opus`
 * のように既定と同じ値を明示的に置いた場合も含める — ここが答えているのは
 * 「差し替えの承認がここに置かれているか」であって、値の比較ではない。
 */
export function placedManagerModels(
  env: NodeJS.ProcessEnv = process.env,
): { key: string; value: string; fallback: string }[] {
  return (
    [
      { key: MANAGER_MODEL_ENV_KEY, fallback: MANAGER_MODEL },
      { key: WORKER_MODEL_ENV_KEY, fallback: WORKER_MODEL },
    ] as const
  ).flatMap(({ key, fallback }) => {
    const value = placedModelTier(env, key);
    return value === null ? [] : [{ key, value, fallback }];
  });
}

/** 作業者層の本体はこの `agents` 定義1個だけ。独自のワーカープールを作らない。 */
export const WORKER_AGENT_NAME = 'worker';

/**
 * runner の子プロセスへ渡さない環境変数。
 *
 * 記憶ストアの鍵（ローカルのパス / DB 接続情報）に加えて、**runner の制御面の鍵**も
 * 落とす。マネージャーが runner の API を叩けると、自分宛の許可確認に自分で
 * `allow` を返せてしまう — クローンも人間も通らずに権限境界を迂回できる
 * （「マネージャーから見たユーザーはクローン」という配線が崩れる）。
 *
 * ここは**二重の底**である。本命は実行環境の分離（別コンテナ・別 UID・鍵の非配布）で、
 * ここはその内側でもう一枚落としているだけ。**ここだけを頼りにしないこと。**
 */
export const WITHHELD_ENV_KEYS = [
  'ALTEROID_HOME',
  'ALTEROID_PORT',
  'ALTEROID_DATABASE_URL',
  'ALTEROID_RUNNER_TOKEN',
  'ALTEROID_RUNNER_TOKEN_SHA256',
  'ALTEROID_RUNNER_SOCKET',
] as const;

/**
 * SDK 子プロセス（マネージャーと作業者）を走らせる UID。
 *
 * **同じ UID で走らせると、子プロセスは runner の `/proc/1/environ` を読み、
 * 制御面の鍵も、Unix ソケットへの接続権も手に入れる。** 分けて初めて、
 * 「マネージャーは自分の許可確認に答えられない」が構造として成立する。
 *
 * 落とすには特権が要るので、runner 本体は root で走る（子だけを降ろす）。
 * 特権が無いのに設定されていたら、黙って同じ UID で走らせずに落とすこと —
 * 境界があるつもりで無い状態が、いちばん危ない。
 */
export interface RunnerChildUser {
  uid: number;
  gid: number;
  /** 子プロセスの `HOME`。root の home を渡すと書けずに落ちる。 */
  home?: string;
}

/**
 * SDK の権限モード。**既定は `auto`**（人間が開く Claude Code と同じ）。
 *
 * 人間が Claude Code を開けば `Read` や `grep` でいちいち止まらない。層を下りた
 * 瞬間にそれが止まるなら、それはデグレード（north_star 禁止1）であって仕様ではない。
 * `default` に戻せば従来どおり1件ずつクローンへ確認が回る（配線は残してある）。
 *
 * **判定の本体は `permission-mode.ts` にある**（クローンも同じ形を使う。
 * `model-tier.ts` と同じ理由で、層ごとに書き写さない）。ここに残すのは
 * 「マネージャーの置き場はこの環境変数である」という対応だけである。
 */
export const MANAGER_PERMISSION_MODES = PERMISSION_MODES;

export type ManagerPermissionMode = PermissionModeName;

export { DEFAULT_PERMISSION_MODE };

/** 権限モードを差し替える環境変数（実行環境の設定であって、能力の制限ではない）。 */
export const PERMISSION_MODE_ENV_KEY = 'ALTEROID_MANAGER_PERMISSION_MODE';

/** `ALTEROID_MANAGER_PERMISSION_MODE` を読む（不正な値は落とす）。 */
export function resolvePermissionMode(env: NodeJS.ProcessEnv): ManagerPermissionMode {
  return resolvePermissionModeFor(env, PERMISSION_MODE_ENV_KEY);
}

/**
 * 貸し出し期限の自己失効を見張る間隔（roadmap M5 PR4）。
 *
 * **環境変数の設定項目にしないこと。** `runner-protocol.ts` の `HEARTBEAT_INTERVAL_MS`
 * などと同じ論法 — つまみとして外へ出すと、そこが実質の運用パラメータになる。
 * `lease.ts` の `LEASE_TTL_MS`（既定10分）に対して十分に細かく見張れる長さであれば
 * よく、厳密さは要らない（見張りが1周遅れても、次の周で必ず気づく）。
 */
const LEASE_WATCH_INTERVAL_MS = 10_000;

export interface RunnerHostOptions {
  /** 安定した識別子。デーモンが `manager_id → runner_id` を台帳に残す。 */
  runnerId: string;
  /** 出来事の出口。デーモンが繋いでいなければ溜めておく（呼び出し側の責任）。 */
  emit: (event: RunnerEvent) => void;
  /** この runner の作業ディレクトリ（cwd を省いた委譲の既定）。 */
  workspacePath: string;
  /** 主にテスト用。既定は SDK の `query`。 */
  queryFn?: typeof query;
  /** 主にテスト用。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** `WITHHELD_ENV_KEYS` に足して伏せる鍵。 */
  withheldEnvKeys?: readonly string[];
  /** SDK 子プロセスを別 UID で走らせる（コンテナ構成の既定）。 */
  childUser?: RunnerChildUser;
  /**
   * 権限モード。省略すると `env` の `ALTEROID_MANAGER_PERMISSION_MODE`、
   * それも無ければ `auto`。
   */
  permissionMode?: ManagerPermissionMode;
  /**
   * マネージャーの道具の鍵（`GH_TOKEN` など）。
   *
   * 渡すと、鍵は `env` のスナップショットではなく**こちらが持つ現在値**が配られる。
   * 走行中に差し替えても新しいマネージャーには即座に、既に走っているマネージャーにも
   * 器（ファイル）越しに次の `git` / `gh` 呼び出しから届く（`credentials.ts`）。
   */
  credentials?: CredentialStore;
  /**
   * 実行環境プロファイル（`.zprofile` 相当）の器。
   *
   * 渡すと、デーモンから降りてきたシェルスクリプトを置き、**SDK 子プロセスの
   * env とすべての Bash 実行に効かせる**。渡さなければプロファイルは使えない
   * （＝差し替えの口が 501 を返す）。**runner が自分で記憶ストアを読みに行く形に
   * しないこと** — 読みに行けるということは鍵があるということである。
   */
  profile?: ProfileVessel;
  /**
   * 貸し出し期限（lease）の自己失効を有効にする（roadmap M5 PR4）。**既定は
   * false。**
   *
   * `true` のとき、`lease` を伴って起こされたセッションは、`noteDaemonContact()`
   * が最後に呼ばれてから `lease.ttlMs` を過ぎたら自分で畳む
   * （`RunnerSession#selfFence`）。これが lease の歯である — デーモンと連絡が
   * 取れなくなった runner がこの猶予を過ぎても居座ると、「もう動いていない」を
   * 引き取る側が片側だけで言えなくなる（`lease.ts` の doc）。
   *
   * **既定を false にしてある理由。** 同一プロセスの `runner-local` では
   * 「デーモンだけが消える」ことが構造的に起こり得ない（デーモンと runner が
   * 同じプロセスなので、デーモンが死ねば runner も一緒に死ぬ）。既定で有効にすると、
   * HTTP の接触という概念そのものが無い構成で走っているセッションを理由なく畳む
   * ことになる。**コンテナで走る器（`apps/runner/src/index.ts`）だけが `true` を
   * 渡す。**
   */
  enforceLease?: boolean;
}

export interface RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  /** いま配っている鍵の指紋。**値は出さない。** */
  credentials(): CredentialFingerprint[];
  /** 鍵を差し替える。器を作り直さずに鍵を回すための唯一の口である。 */
  setCredentials(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]>;
  /** いま置いてある実行環境プロファイルの指紋。**本文は出さない。** */
  profile(): RunnerProfileFingerprint | undefined;
  /** 実行環境プロファイルを差し替える。**置く前に評価して、結果を返す。** */
  setProfile(script: string): Promise<RunnerProfileResult>;
  start(command: RunnerStartCommand): Promise<void>;
  /** `RunnerFenceError` を投げうる（世代が古い。呼び出し側は 409 へ変換すること）。 */
  resume(command: RunnerResumeCommand): Promise<void>;
  send(managerId: string, text: string): Promise<boolean>;
  /**
   * `delivered: false` = その確認は runner 側に無い。`decision` は確定した
   * allow/deny（#322。`decideAnswer` の doc）。同一プロセスなので常に付く。
   */
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome>;
  stop(managerId: string): Promise<void>;
  list(): RunnerManagerState[];
  transcript(managerId: string): Promise<string | null>;
  /** 全セッションを畳む。プロセスが消えるときだけ呼ぶ。 */
  shutdown(): Promise<void>;
  /**
   * デーモンから制御面への接触があったことを知らせる（貸し出し期限の自己失効の
   * 時計を進める）。
   *
   * **呼ぶのは認証済みの制御面の呼びだけにすること。** `apps/runner/src/app.ts`
   * の `/livez` は無認証なので、そこから呼ぶと誰でも貸し出し期限を延ばせてしまう
   * （＝自己失効が機能しなくなる）。
   */
  noteDaemonContact(): void;
}

export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  return new Host(options);
}

class Host implements RunnerHost {
  readonly runnerId: string;
  readonly workspacePath: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: typeof query;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  /**
   * 実行環境プロファイル。
   *
   * **起こすたびに評価し直さない。** 評価はプロセスを1本起こす操作なので、
   * マネージャーを起こす経路に挟むと、人間の書いたスクリプト次第で委譲そのものが
   * 遅くなる（返ってこないスクリプトなら止まる）。差し替えの口で1度だけ評価し、
   * 結果を持つ。走行中のコマンドへは `BASH_ENV` 経由で毎回届くので、
   * 「差し替えが届かない」は起きない。
   */
  readonly #profile: ProfileApplier | undefined;
  readonly #sessions = new Map<string, RunnerSession>();
  readonly #enforceLease: boolean;
  /**
   * 制御面（認証済みの呼び）から最後に接触があった時刻。
   *
   * **起動直後は「今」を起点にする。** 何も知らない時刻をゼロや過去に見積もると、
   * デーモンが1度も繋いでいない起動直後のセッションまで即座に自己失効しうる
   * （`lease.ts` の `instanceSince` と同じ「知らない時刻を過去に見積もらない」
   * という判断）。
   */
  #lastDaemonContact = Date.now();
  /** 貸し出し期限の自己失効を見張る1本。**`shutdown()` で必ず畳む。** */
  #leaseWatcher: ReturnType<typeof setInterval> | null = null;

  constructor(options: RunnerHostOptions) {
    this.runnerId = options.runnerId;
    this.workspacePath = options.workspacePath;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn ?? query;
    this.#env = options.env ?? process.env;
    this.#withheldEnvKeys = [...WITHHELD_ENV_KEYS, ...(options.withheldEnvKeys ?? [])];
    this.#childUser = options.childUser;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode ?? resolvePermissionMode(this.#env);
    this.#enforceLease = options.enforceLease ?? false;
    if (this.#enforceLease) {
      const watcher = setInterval(() => this.#checkLeaseExpiry(), LEASE_WATCH_INTERVAL_MS);
      // 見張りでプロセスの終了を引き延ばさない（このリポジトリの既存のタイマーが
      // 全部そうしている）。
      watcher.unref?.();
      this.#leaseWatcher = watcher;
    }
    this.#profile =
      options.profile === undefined
        ? undefined
        : createProfileApplier({
            vessel: options.profile,
            baseEnv: () => this.#baseChildEnv(),
            // **器が約束している分だけを検査する**（既定）。Host が env から落とす
            // 一覧（`#withheldEnvKeys`）とは役割が違う — あちらは配るときの最後の
            // 一枚で、こちらは「器が書いた `unset` が本当に効いたか」の実測である。
            // 読むのは SDK 子プロセスと同じ主体である。root で読めても意味がない
            // （降りた先では読めないプロファイルを「置けた」と報告することになる）。
            ...(this.#childUser === undefined
              ? {}
              : { spawnFn: (spawnOptions) => this.#spawnAsChildUser(spawnOptions) }),
          });
  }

  credentials(): CredentialFingerprint[] {
    return this.#credentials?.fingerprints() ?? [];
  }

  /** 制御面から接触があった。貸し出し期限の自己失効の時計を進める。 */
  noteDaemonContact(): void {
    this.#lastDaemonContact = Date.now();
  }

  /**
   * 貸し出し期限が切れたセッションを自分で畳む（roadmap M5 PR4 の自己失効）。
   *
   * **`lease` を伴わずに起こされたセッションは見ない**（`leaseTtlMs` が
   * `undefined`）。`enforceLease` が有効でも、世代の約束をしていないセッションを
   * 理由なく畳まない。
   */
  #checkLeaseExpiry(): void {
    const now = Date.now();
    for (const [managerId, session] of [...this.#sessions.entries()]) {
      const ttlMs = session.leaseTtlMs;
      if (ttlMs === undefined) continue;
      if (now - this.#lastDaemonContact < ttlMs) continue;
      void session
        .selfFence(
          'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）。' +
            `最後に接触があったのは ${new Date(this.#lastDaemonContact).toISOString()}、` +
            `約束していた貸し出し期限は ${ttlMs}ms。`,
        )
        /*
         * **畳むのに失敗したことを黙って落とさない。**
         *
         * `selfFence` → `#finish` は生ログの退避（実 I/O）を挟むので落ちうる。ここは
         * `setInterval` のコールバックなので、握らないと unhandled rejection になって
         * **器のログにしか出ない**（デーモンには何も届かない）。しかも落ちた場合は
         * セッションが畳まれていない可能性があり、**引き取る側は「相手は自分で畳んだ」
         * という前提で期限を数えている** — つまりここは前提が崩れた瞬間そのものなので、
         * 上へ言うのが唯一の出口である。
         */
        .catch((error: unknown) => {
          this.#emit({
            type: 'note',
            managerId,
            text: `貸し出し期限の自己失効に失敗した（このセッションは畳まれていない可能性がある）: ${String(error)}`,
          });
        });
    }
  }

  async setCredentials(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]> {
    if (this.#credentials === undefined) {
      throw new Error(
        '鍵の器が無い runner では差し替えられない（ALTEROID_CREDENTIAL_DIR を用意すること）',
      );
    }
    return this.#credentials.set(entries);
  }

  profile(): RunnerProfileFingerprint | undefined {
    return this.#profile?.fingerprint();
  }

  /**
   * プロファイルを置き換える。**置く前に1度評価する。**
   *
   * 評価せずに置くと、構文を間違えたスクリプトが `BASH_ENV` に載り、以後
   * すべてのコマンドが壊れた環境で走る。しかも失敗はコマンドの出力に紛れるので、
   * 人間は「なぜか動かない」としか分からない。**壊れているなら置かずに、
   * 理由を返す**（前のプロファイルはそのまま残る）。
   */
  async setProfile(script: string): Promise<RunnerProfileResult> {
    if (this.#profile === undefined) {
      throw new Error(
        'プロファイルの器が無い runner では差し替えられない（ALTEROID_PROFILE_FILE を用意すること）',
      );
    }
    return this.#profile.apply(script);
  }

  /**
   * プロファイルを重ねる前の env。鍵まで載せた状態で評価する。
   *
   * 素の `process.env` で評価すると、プロファイルの中で `gh` を叩くような書き方
   * （`eval "$(gh auth token)"` 等）が評価時だけ失敗する。実際に配る env と
   * 同じものを渡す。
   */
  #baseChildEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    if (this.#credentials !== undefined) {
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  /** 子プロセスを別 UID で起こす（プロファイルの評価も同じ主体で行う）。 */
  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  #create(managerId: string, request: string, cwd: string): RunnerSession {
    const session = new RunnerSession({
      managerId,
      request,
      cwd: cwd.length > 0 ? cwd : this.workspacePath,
      emit: this.#emit,
      queryFn: this.#queryFn,
      env: this.#env,
      withheldEnvKeys: this.#withheldEnvKeys,
      ...(this.#childUser === undefined ? {} : { childUser: this.#childUser }),
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      permissionMode: this.#permissionMode,
      profileEnv: () => this.#profile?.env() ?? {},
      onClosed: () => this.#sessions.delete(managerId),
    });
    this.#sessions.set(managerId, session);
    return session;
  }

  async start(command: RunnerStartCommand): Promise<void> {
    if (this.#sessions.has(command.managerId)) {
      throw new Error(`${command.managerId} は既に走っている`);
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    try {
      // **新しいセッションなので拒む判定は起きない。** `checkFence` は
      // 「まだ世代を覚えていない」ときは無条件に覚えるだけである
      // （`RunnerSession#checkFence` の doc）。
      session.checkFence(command.lease);
      session.begin(command.request);
    } catch (error) {
      this.#sessions.delete(command.managerId);
      throw error;
    }
  }

  /**
   * 中断されたセッションの続きへ戻す。**`RunnerFenceError` を投げうる。**
   *
   * 既に同じ manager が走っているなら（デーモンだけが再起動した場合）、何もせず
   * 追加の一言だけを流す。**走っているものを resume で作り直さない** — 手を
   * 動かしている最中のマネージャーを二重に起こすことになる。
   *
   * **世代の検査はこの短絡の手前に置く。** 古い世代の resume が来たら
   * `checkFence` が投げ、その時点でまだ何もしていない（`push` を呼ぶ前）ので、
   * 走っているセッションは1文字も影響を受けない。新しい世代なら世代だけ
   * 覚え直し、同じ短絡（作り直さずに一言だけ流す）へそのまま合流する。
   */
  async resume(command: RunnerResumeCommand): Promise<void> {
    const alive = this.#sessions.get(command.managerId);
    if (alive) {
      alive.checkFence(command.lease);
      if (command.message !== undefined) alive.push(command.message);
      return;
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    // **この Host インスタンスにとっては初めて見るセッション**（器の入れ替え・
    // デーモンの再起動後の resume）なので、比べる前の世代が無い。拒む判定は
    // 起きず、覚えるだけになる（`start` と同じ形）。
    session.checkFence(command.lease);
    session.resume(command.sessionId, command.entries, command.message);
  }

  async send(managerId: string, text: string): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    if (!session) return false;
    session.push(text);
    return true;
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    const session = this.#sessions.get(managerId);
    if (!session) return { delivered: false };
    return session.answer(answer);
  }

  async stop(managerId: string): Promise<void> {
    await this.#sessions.get(managerId)?.stop('デーモンから停止を指示された。');
  }

  list(): RunnerManagerState[] {
    return [...this.#sessions.values()].map((session) => session.state());
  }

  async transcript(managerId: string): Promise<string | null> {
    return (await this.#sessions.get(managerId)?.transcript()) ?? null;
  }

  async shutdown(): Promise<void> {
    // **見張りを先に畳む。** 畳み残すと、この後 `#sessions.clear()` で空になった
    // 名簿を、止まったはずの見張りが叩き続ける（名簿は空なので実害は無いが、
    // テストならタイマーが残ってハングする — `runner-protocol.ts` の `Registry#stop`
    // と同じ理由）。
    if (this.#leaseWatcher !== null) clearInterval(this.#leaseWatcher);
    this.#leaseWatcher = null;
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.stop('runner が停止した。')),
    );
    this.#sessions.clear();
  }
}

/**
 * 解決済みの確認を覚えておく件数。**セッション1本ぶんの上限**である。
 *
 * 帳面はセッションと一緒に消えるので、寿命は元から有限。ここで件数にも蓋を
 * するのは、1本が異常に長く走ったときのためで、達したら `note` で上へ言う。
 */
const RESOLVED_MEMORY_LIMIT = 512;

/**
 * 上へ降ろした拒否を覚えておく件数。**セッション1本ぶんの上限**である。
 *
 * 同じ拒否は2つの経路で届く（走行中の合図と `result` の記録）ので、`tool_use_id`
 * で二度目を落とす。帳面はセッションと一緒に消えるので寿命は元から有限で、
 * 件数の蓋は1本が異常に多く拒否されたときのため。達したら `note` で上へ言う。
 */
const DENIED_MEMORY_LIMIT = 512;

/**
 * `#onSubagentStop` が `note` の `text` へ積む文字数の上限（#357）。
 *
 * **黙って落とさない**（AGENTS.md「静かに失敗する道具」）。超えたら切り、
 * 切ったこと自体を末尾に書く。日誌1行が背景処理の一覧で際限なく伸びるのを
 * 防ぐための締め切りであって、観測そのものを狭める意図ではない。
 */
const SUBAGENT_STOP_NOTE_TEXT_LIMIT = 1_500;

/**
 * `#backgroundTaskOwners`（背景タスクの id → それを起こした主体）が持つ件数の
 * 上限（#570）。
 *
 * **超えたら「いちばん古いもの」から捨てる。** `Map` の挿入順をそのまま使う。
 * 落ちるのが古い側なのは、この表を引くのが `SubagentStop` の瞬間 —— つまり
 * **登録の直後**だからである（実測: 登録から 1.4 秒後に引いた）。新しい側を
 * 落とすと、いま畳もうとしている作業者の分がまず消える。
 *
 * ⚠️ **捨てたことは外から見えない。** 捨てた分は「所有者を引けない」に落ち、
 * `#onSubagentStop` の診断（1セッションに1回）でだけ表に出る。
 */
const BACKGROUND_TASK_OWNER_LIMIT = 500;

/** 返事を待って止まっている1件（許可確認 or 質問）。 */
interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  summary: string;
  /**
   * **runner がこの確認を SDK から受け取った時刻**（ISO8601, UTC）。
   *
   * 値の持ち主はここ（`#onPermission` が組み立てる瞬間）1つだけである。
   * `state()` もデーモン向けの `ask` イベントも、ここで確定した値をそのまま
   * 運ぶだけで**取り直さない**——デーモン再起動後の引き取り（`state()` 経由）
   * のたびに取り直すと、待っている時間の長さという、この値を持たせた理由
   * そのものが消える（#334）。
   */
  askedAt: string;
  settle: (answer: { message: string; decision?: 'allow' | 'deny' }) => void;
  /** 同じ確認が再送されたときに同じ結果を返すための約束（SDK は再送しうる）。 */
  result: Promise<PermissionResult>;
}

interface RunnerSessionOptions {
  managerId: string;
  request: string;
  cwd: string;
  emit: (event: RunnerEvent) => void;
  queryFn: typeof query;
  env: NodeJS.ProcessEnv;
  withheldEnvKeys: readonly string[];
  childUser?: RunnerChildUser;
  credentials?: CredentialStore;
  permissionMode: ManagerPermissionMode;
  /**
   * プロファイル由来の env（評価済みの差分＋`BASH_ENV` などの所在）。
   *
   * **関数で受ける。** 走行中に差し替わるので、値で渡すと後から起こした
   * マネージャーだけが古い環境で走る。
   */
  profileEnv: () => Record<string, string>;
  onClosed: () => void;
}

class RunnerSession {
  readonly #id: string;
  readonly #request: string;
  readonly #cwd: string;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #queryFn: typeof query;
  readonly #env: NodeJS.ProcessEnv;
  readonly #withheldEnvKeys: readonly string[];
  readonly #childUser: RunnerChildUser | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #permissionMode: ManagerPermissionMode;
  readonly #profileEnv: () => Record<string, string>;
  readonly #onClosed: () => void;

  readonly #input: SDKUserMessage[] = [];
  readonly #pending: PendingRequest[] = [];
  /**
   * **解けた確認と、そのときの結果。**
   *
   * `#pending` は「いま待っている」ものしか持たない。解けた瞬間に消えるので、
   * それだけを見て重複を判定すると、**解決後の再送が新しい確認になる** —
   * クローンへ二度目が届き、その再送は SDK 側で既に中断済みなので即 `settle` し、
   * デーモンは `waiting` からそれを消す。答えたクローンには「待っていない」と
   * 返る。「解決した」という事実が runner 側に残っていないことが原因である。
   *
   * だから覚える。再送には**同じ結果をそのまま返す**（`ask` は出さない）。
   * 帳面はセッションと一緒に消え、件数にも上限がある（`RESOLVED_MEMORY_LIMIT`）。
   */
  readonly #resolved = createRecentMap<PermissionResult>({
    limit: RESOLVED_MEMORY_LIMIT,
    // **忘れたことを黙らない。** 忘れた id の再送はもう一度クローンへ出るので、
    // ここが記録に無いと「なぜ二度届いたのか」を誰も辿れない。
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `解決済みの確認の記憶が上限（${RESOLVED_MEMORY_LIMIT}件）に達したので、` +
          `古い ${ids.length} 件を忘れた: ${ids.join(', ')}。` +
          'この id の確認が SDK から再送されると、新しい確認としてもう一度回る。',
      }),
  });
  /**
   * 上へ降ろした拒否の `tool_use_id`。
   *
   * 同じ1件が**走行中の合図**（`system/permission_denied`）と**ターン終わりの
   * 記録**（`result.permission_denials`）の両方に載る。しかも `result` が
   * 累積かどうかは SDK の型に書かれていない（`modelUsage` には「累積」と明記が
   * あるが、こちらには無い）ので、**どちらでも壊れないように id で落とす**。
   *
   * **値は「その id について、入力を持つ記録を既に降ろしたか」である。**
   * `true` を置くだけだと「降ろした」しか覚えられず、**入力を持たない
   * `via: 'live'` が先に鍵を立てたとき、入力を持つ `via: 'result'` を
   * 区別できずに捨てる**（それが直している穴である）。`false` のまま残って
   * いる id にだけ、後から形を1度足す（`#noteDenial`）。
   */
  readonly #denied = createRecentMap<DeniedRecord>({
    limit: DENIED_MEMORY_LIMIT,
    // **忘れたことを黙らない。** 忘れた id が `result` にもう一度載っていれば、
    // 同じ拒否が新しい拒否として上がる（デーモン側の件数も二重に増える）。
    onForget: (ids) =>
      this.#emit({
        type: 'note',
        managerId: this.#id,
        text:
          `上へ降ろした拒否の記憶が上限（${DENIED_MEMORY_LIMIT}件）に達したので、` +
          `古い ${ids.length} 件を忘れた: ${ids.join(', ')}。` +
          'この tool_use_id が result に残っていれば、同じ拒否がもう一度上がる。',
      }),
  });
  /**
   * resume のために預かった生ログ（SDK の `SessionStore.load` が返す素材）。
   *
   * **正常フローでは `#markProgressed` が解放する。** `#sessionStore().load()`
   * が読むのは SDK がセッションを開く最初の1回だけで、それは `#progressed` が
   * 立つ（道具を使った・確認を出した・結果を返した）よりも必ず先に済んでいる
   * ── モデルが手を動かすには、動かす前にセッションが開いていないといけない。
   * だから `#progressed` が立った時点で `load()` はもう `#seed` を読み終えており、
   * 二度と呼ばれない。
   *
   * **`system/init` が来た時点では解放しない。** `init` は「開いた」ことしか
   * 示さず、`#recoverFromFailedResume` が resume の成否を判定するのに使う基準は
   * `#progressed`（「続けられた」）であって `init` の有無ではない
   * （`#recoverFromFailedResume` のコメント参照）。`init` の直後・何も手が動く
   * 前に接続が切れる形は「resume が効かなかった」として扱われ、そのときの
   * 回復（`renderSessionLog(this.#seed)`）にはまだ `#seed` が要る。ここで
   * 解放すると、その回復だけが静かに材料を失う。
   */
  #seed: SessionStoreEntry[] | undefined;

  /**
   * 投げたが、まだ効いたと確かめられていない resume。
   *
   * **「resume を投げた」と「続きへ戻れた」は別物である。** SDK は開いた後に
   * `No conversation found with session ID: …` を投げてくるので、成否は
   * `system/init` が来たかどうかで見るしかない（`clone.ts` の `#sawInit` と同じ形）。
   * 効いたら消す。消えないまま閉じたなら、その resume は効かなかった。
   */
  #resumeAttempt: { sessionId: string } | null = null;
  /**
   * 開いている入力ストリームの世代。
   *
   * resume に失敗して新しいセッションを開くと、前の `#inputStream` がまだ
   * `#input` を待っている。世代を進めて畳まないと、新しいセッション宛の指示を
   * 死んだストリームが横取りする。
   */
  #generation = 0;
  /**
   * このセッションが実際に何かをしたか（道具を使った・確認を出した・結果を返した）。
   *
   * 生ログからの作り直しを**手が動く前だけ**に限るための旗である。動いた後で
   * 作り直すと、済んだ作業を記録から二度走らせる。
   *
   * **一度立てたら二度と下ろさない。** `#recoverFromFailedResume` は
   * `if (this.#progressed) return 'not-a-resume-failure';` でここが立っていれば
   * `#seed` を読む前に抜けるので、これが立った時点で `#seed` はこの先この
   * インスタンスの寿命が尽きるまで二度と読まれないことが確定する
   * （`#markProgressed` 参照）。
   */
  #progressed = false;
  /**
   * このターンでマネージャーが出した本文（人間が Claude Code の画面で読むもの）。
   *
   * **報告を `result` 1本から作らない。** `result` はそのターンの最後の一片で
   * しかなく、道具を挟むたびに本文は切れる。`result` だけを渡すと、クローンには
   * 末尾だけが届き、**欠けていることが誰にも見えない**。人間は全部読めるのだから、
   * 受信側だけが読めないのは能力の削除である（north_star 禁止1）。
   */
  #said: string[] = [];
  /**
   * `#said` へ最後に積んだ assistant メッセージの `uuid`（SDK が払う id）。
   *
   * **`#flushUnreported()` が `reportId` として運ぶためだけに持つ。**
   * 通常の報告は `result` メッセージの `message.uuid` を `reportId` に使う
   * （`runner-protocol.ts` の `report.reportId` の doc — 「runner が新しい値を
   * 毎回振るのではなく、SDK 側の識別子をそのまま運ぶ」）。**`result` が来ない
   * まま畳む回には、その id が存在しない。** そこで `randomUUID()` を振ると
   * その作法を破ることになるので、**同じ本文を運んできた assistant メッセージの
   * id をそのまま使う** — SDK 側の識別子であることは変わらず、再送しても
   * 同じ値になる。
   *
   * **`#said` と同じ区切りで畳む**（持ち越すと、前のターンの id が次の報告に
   * 付く）。
   */
  #saidUuid: string | undefined;
  /**
   * このターンで SDK が「これは応答ではない」と印を付けたメッセージ
   * （`assistant.error`）。
   *
   * **`#said` と同じ区切りで畳む。** 持ち越すと、次のターンが成功しても失敗として
   * 報告されることになる。
   */
  #rejected: SdkFailure | null = null;

  /**
   * いま開いている作業者への委譲（Task）の `task_id` 集合。
   *
   * `task_started` で追加、`task_notification` で削除する。**`skip_transcript:
   * true` の `task_started`（SDK の JSDoc 曰く ambient/housekeeping task）も
   * 間引かずに数える** — 何を除外してよいかの判断を誰も持っていないので、
   * 数える側では絞らない。
   */
  #openTasks = new Set<string>();

  /**
   * いま開いている委譲区間（`worker_wait` の集計。`runner-protocol.ts` の
   * `worker_wait` イベントと同じ形で溜める。`sources` だけ `Map` にしてあるのは
   * 途中で加算し続けるため）。
   *
   * `#openTasks` が 0→1 になった瞬間に開く。**閉じるのは `#openTasks` が空に
   * なった瞬間ではない** — 最後の完了通知そのものを契機に回ったターン（実際に
   * 仕事をする回）を数え落とさないため、`#windowClosing` を立てて次の `result`
   * でそのターンを数えてから閉じる（`#closeWorkerWaitWindow`）。
   */
  #window: {
    openedAt: string;
    tasks: number;
    turns: number;
    byCause: { input: number; notification: number; continuation: number };
    toolless: number;
    notifications: number;
    submits: number;
    sources: Map<string, number>;
  } | null = null;

  /**
   * `#openTasks` が空になった。**その場では `#window` を閉じない。**
   *
   * 次の `result` でそのターンを数えてから `#closeWorkerWaitWindow` を呼ぶ。
   * `#onTaskStarted` が閉じ待ちの間に次の委譲が始まったのを見つけたら、
   * 閉じずに取り消す（同じ区間として続ける）。
   */
  #windowClosing = false;

  /** このターンで `#inputStream` が実際に消費した入力の件数（`result` で畳む）。 */
  #inputsSinceResult = 0;
  /** このターンで受けた `task_notification` の件数（`result` で畳む）。 */
  #notificationsSinceResult = 0;
  /**
   * このターンでマネージャー自身の道具が動いた回数（`result` で畳む）。
   *
   * **作業者の道具は数えない**（`hook.agent_id` が付いているものは除く。
   * `#onPostToolUse` の判定と同じ）。混ぜると「マネージャーは何もしていない
   * ターン」＝事故（「残り5体を待ちます」だけのターン）の再現条件そのものが
   * 消える。
   */
  #toolsSinceResult = 0;
  /** このターンで `UserPromptSubmit` がマネージャー自身に発火した回数（`result` で畳む）。 */
  #submitsSinceResult = 0;
  /**
   * 背景タスクの id → **それを起こした主体**（#570）。
   *
   * 値は作業者の `agent_id`。**マネージャー自身が起こしたものは空文字 `''`**
   * にする —— 「マネージャーのものだった」と「表に無い（引けなかった）」を
   * 混ぜないため。混ぜると、経路が壊れて表が空になった状態が「全部マネージャー
   * のものだった」に化ける。
   *
   * **作るのは `#onPostToolUse`、引くのは `#onSubagentStop`。** その間だけ
   * runner が状態を持つ。寿命はセッションと同じで、`BACKGROUND_TASK_OWNER_LIMIT`
   * 件を超えたら古い側から捨てる。
   */
  #backgroundTaskOwners = new Map<string, string>();
  /**
   * 「所有者を引けなかった」診断を、このセッションで既に出したか（#570）。
   *
   * 診断は**1セッションに1回だけ**出す。毎回出すと、壊れていることの通知が
   * そのまま雑音になって読まれなくなる。
   */
  #ownerLookupFailureNoted = false;
  /**
   * `UserPromptSubmit` の `source` ごとの件数（`result` で畳む）。
   *
   * **取れた分だけ載せる。** 取れない回に `'unknown': 1` のような行を作らない
   * （AGENTS.md 地雷「取れない軸に0の行を作る」）。
   *
   * ## **「外部には付かない」は SDK 0.3.239 で消えた。この軸はもう死んでいない**
   *
   * ここには元々「いまは Anthropic 内部のセッションでしか付かない見込みで、
   * 外部のペイロードには付かない」と書いてあった。**それは SDK 0.3.237 の
   * JSDoc の正しい引き写しだったが、`1ce97ed`（0.3.239 への自動更新）で
   * 前提のほうが変わった。** 実物の差分（2026-08-22 観測）:
   *
   * - 0.3.237: `Currently only set for Anthropic-internal sessions while the
   *   field is trialed; external payloads omit it.`
   * - 0.3.239: `Payloads may omit it while the field rolls out.`
   *
   * **「必ず付かない」から「付かないこともある」へ変わった** ので、alteroid の
   * ような外部セッションでも `sources` が埋まりうる。**取れない前提で読み飛ばす
   * と、いちばん知りたい内訳を見落とす** — 同じ JSDoc は `system` を
   * 「他の機械が起こしたターン（peer/channel messages・task notifications・
   * auto-continuation）」と定義しており、これは `byCause` が
   * `notification`（通知の直後）と `continuation`（消去法の残り）に分けて
   * *推定*している当のものを、**SDK 自身が名指しで分類した値**である。
   *
   * ## それでも `sources` が答えない問い
   *
   * - **`system` は3つを畳んでいる。** peer/channel messages と
   *   task notifications と auto-continuation は同じ `'system'` に落ちる。
   *   「通知で起きたのか、SDK が自分で続けたのか」は**この値では割れない**
   * - **付かない回は今も在る**（「may omit」）。`sources` の合計は `submits`
   *   と一致するとは限らず、**一致しない分が「どの source だったか」は不明**で
   *   あって「source が無い契機だった」ではない
   *
   * **この JSDoc がまた変わったら `sdk-source-field.test.ts` が落ちる。**
   * 落ちたら、この doc と `runner-protocol.ts` の `sources` の doc と
   * `#onUserPromptSubmit` のコメントの3か所を読み直すこと（SDK の更新は
   * `.github/workflows/update-claude-sdk.yml` が自動で PR にするので、
   * **黙って腐る。実際に一度腐った**）。
   */
  #submitSources = new Map<string, number>();
  readonly #inputWaiters = new Set<() => void>();
  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #status: JobStatus = 'running';
  #sessionId: string | undefined;
  /**
   * SDK が失敗として出したのに、枠の文言としては分類できなかった回の帳面
   * （Issue #393。`種別 → 件数`）。
   *
   * **セッション1本ぶんである。** プロセス単位で畳むと、器が入れ替わって新しい
   * 失敗が始まっても「前に見たから」で黙る（`noteUnclassifiedFailure` の doc）。
   *
   * **これは計器であって、何も分岐させない。** 分類できたときに `usage_notice`
   * を出す判断も、回し手へ渡すものも、1文字も変えていない。
   */
  readonly #unclassifiedFailures = new Map<string, number>();
  /**
   * いま起こしっぱなしの背景処理（`agent-events.ts` の
   * `AgentBackgroundTasksEvent`）。**REPLACE 意味論**——SDK の JSDoc が
   * 「missed bookend cannot wedge a stale running indicator」と言っている
   * とおり、届いた `tasks` で丸ごと入れ替える。加算・削除の差分計算はしない。
   *
   * **空へ戻すのは「器（CLI プロセス）が本当に入れ替わったとき」だけ**
   * ——契機は3つに限る:
   *
   * 1. フィールド初期化（このデフォルト値）——新しい `RunnerSession`
   *    インスタンス＝新しい器
   * 2. `#open()` が実際に SDK セッションを開いた／開き直したとき
   *    （`#open()` のコメント）
   * 3. `init`（`session_started`）が来て、`event.sessionId` が直前の
   *    `this.#sessionId` と違っていたとき（`case 'session_started'` の
   *    コメント）
   *
   * **⚠️ 以前はここに「`session_started` で必ず空に戻す」と書いてあったが、
   * それは誤りだった。** `init` はターンの頭ごとに来る（`SDKSystemMessage`
   * の JSDoc）のであって、器の (re)start の合図ではない——器の (re)start を
   * 言っているのは `SDKBackgroundTasksChangedMessage` の JSDoc のほうで、
   * こちらは「背景タスクの level 信号が per-process である」ことの説明に
   * すぎない。**この2つの JSDoc は別のことを言っている**——逐語は
   * `case 'session_started'` のコメントに置いた。誤読の結果、ターンの頭
   * ごとに在り高が0へ落ち、そのターン中に `background_tasks_changed` が
   * 来なければ `awaitingBackground` が付かず、報告が畳まれずクローンを
   * 起こしていた（実測: K 本並列に出すと K-1 回よけいに起こす）。
   *
   * 読むのは `result` の枝（`awaitingBackground` を報告に載せるかどうかの
   * 判定）だけ。**`worker_wait` の区間の開閉には使わない**
   * （`claude-provider.ts` の `foldSystemMessage` の doc）。
   */
  #liveBackgroundTasks: readonly { id: string; taskType: string }[] = [];
  #transcriptPath: string | undefined;
  #stopped = false;
  /**
   * 最後に受け取った世代番号（fencing token）。
   *
   * **`undefined` は「まだ lease を伴わずに起こされた」ことを表す。** そのときは
   * 判定しない（`lease.ts` の `undecidable` と同じ形 — 材料が無いことを
   * 「古くない」と読まない。ただし判定しない以上、拒む理由も無いので実質は
   * 「常に受ける」になる）。名乗らない古いデーモンとも繋がるための任意フィールドと
   * 対になっている（`runnerLeaseSchema` の doc）。
   */
  #fence: number | undefined;
  /**
   * いまの貸し出し期限（ミリ秒）。`Host` の自己失効の見張りが読む。
   *
   * **lease を伴わずに起こされたセッションは `undefined` のまま。** 自己失効は
   * 期限を約束されたセッションだけに効く（`RunnerHostOptions.enforceLease` の doc）。
   */
  #leaseTtlMs: number | undefined;

  constructor(options: RunnerSessionOptions) {
    this.#id = options.managerId;
    this.#request = options.request;
    this.#cwd = options.cwd;
    this.#emit = options.emit;
    this.#queryFn = options.queryFn;
    this.#env = options.env;
    this.#withheldEnvKeys = options.withheldEnvKeys;
    this.#childUser = options.childUser;
    this.#credentials = options.credentials;
    this.#permissionMode = options.permissionMode;
    this.#profileEnv = options.profileEnv;
    this.#onClosed = options.onClosed;
  }

  /** 見張り（`Host#checkLeaseExpiry`）が読む、いまの貸し出し期限。 */
  get leaseTtlMs(): number | undefined {
    return this.#leaseTtlMs;
  }

  /**
   * 世代番号（fencing token）を検査し、覚える（roadmap M5 PR4）。
   *
   * **`lease` が無ければ何もしない。** 任意フィールドなので、名乗らない古い
   * デーモンから来た命令は今までどおり素通しする。
   *
   * まだ世代を覚えていない（`#fence === undefined`）なら、これは `start` か、
   * この `Host` インスタンスにとって初めて見る `resume`（器の入れ替え・デーモンの
   * 再起動後）である。比べる前の世代が無いので、拒む判定は起きず**覚えるだけ**
   * になる。
   *
   * 既に覚えている世代より**古ければ** `RunnerFenceError` を投げる。**投げる前に
   * 何も書き換えない**ので、走っているセッションはこの呼び出しで1文字も影響を
   * 受けない。**同じ値は再送として受ける**（更新も拒否もしない）。**新しい値**は
   * ここで覚え直すだけで、セッションを作り直す判断はここには無い
   * （`Host#resume` が呼び出し元で、既にセッションを作り直さない短絡を持っている）。
   */
  checkFence(lease: RunnerLease | undefined): void {
    if (lease === undefined) return;
    if (this.#fence !== undefined && lease.fence < this.#fence) {
      throw new RunnerFenceError({
        managerId: this.#id,
        expected: this.#fence,
        given: lease.fence,
      });
    }
    this.#fence = lease.fence;
    this.#leaseTtlMs = lease.ttlMs;
  }

  begin(request: string): void {
    this.push(request);
    this.#open();
  }

  /**
   * 前のセッションの続きから開く。
   *
   * `message` を必ず流すのは、**resume が「開き直す」だけでは仕事が進まない**
   * からである。人間の不在で止まってよいのは承認待ちの仕事だけで（PRD「自律」）、
   * 器が落ちたことを理由に止まったままにはしない。
   */
  resume(sessionId: string, entries: unknown[] | undefined, message: string | undefined): void {
    this.#sessionId = sessionId;
    this.#seed = entries as SessionStoreEntry[] | undefined;
    this.#resumeAttempt = { sessionId };
    if (message !== undefined) this.push(message);
    this.#open(sessionId);
  }

  state(): RunnerManagerState {
    return {
      managerId: this.#id,
      status: this.#status,
      cwd: this.#cwd,
      request: this.#request,
      // **`kind` も運ぶ（#334）。** `#pending` の要素（`PendingRequest`）は
      // 既に `kind` を持っている（`#onPermission` が組み立てる）。ここで
      // 落とすと、デーモン再起動後の引き取り（`manager.ts` の
      // `#restoreJobs`、`state()` を経由する）だけ種別が消える——`ask`
      // イベント経由（`#emit`）は既に運んでいたので、非対称だった。
      //
      // **`askedAt` は `request.askedAt` をそのまま運ぶ（取り直さない）。**
      // ここで `new Date().toISOString()` を新しく呼ぶと、デーモン再起動の
      // たびに「待ち始めた時刻」が「いま」へ書き換わり、この値を持たせた
      // 理由（どれだけ待っているかが分かる）が消える。
      waiting: this.#pending.map((request) => ({
        requestId: request.id,
        summary: request.summary,
        kind: request.kind,
        askedAt: request.askedAt,
      })),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    };
  }

  /**
   * クローン・人間からの一言をマネージャーへ押し込む。
   *
   * **ここは作業者（Task サブエージェント）の完了を契機に呼ばない。** 作業者は
   * マネージャーと**同一の query ストリーム**の中で動くので、完了は
   * `tool_result` として同じ `#read` ループに現れる — 新しい入力を押し込む
   * 必要がない（呼ぶと SDK 側の自己継続と二重にターンが回り、`worker_wait` の
   * `byCause` の切り分けも壊れる。`input` と `continuation` の両方が同じ完了を
   * 指すことになる）。
   *
   * **ただしこれは型にもテストにも書かれておらず、たまたま設計がそうなっている
   * だけの前提である。** 固定しているのは `runner-wakeup.test.ts` の
   * 「`task_notification` を受けても `byCause.input` は増えない」の1本のみ。
   */
  push(text: string): void {
    if (this.#stopped) return;
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.#status = 'running';
    this.#wakeInput();
  }

  /**
   * 返事の宛先は `requestId` で指す。推測しない（取り違えは拒否を承認に変える）。
   *
   * **確定した allow/deny を同期的に返す（#322）。** `decideAnswer` を
   * `#onPermission` の `.then()`（SDK へ実際に返す `PermissionResult` を組み立てる
   * 側）と共有しているので、ここが返す値と SDK へ返る値は常に同じ計算から出る
   * ——2箇所に式を書くと、Issue #322 が候補2（`manager.ts` で `inferDecision` を
   * 呼び直す）を却下した理由（「runner.ts 側が変わったときに黙ってずれる」）を
   * 場所を変えて再現する。
   */
  answer(answer: RunnerAnswerCommand): RunnerAnswerOutcome {
    const pending = this.#pending.find((request) => request.id === answer.requestId);
    if (!pending) return { delivered: false };
    const decision = decideAnswer(pending.kind, answer.decision, answer.message);
    pending.settle({
      message: answer.message,
      ...(answer.decision === undefined ? {} : { decision: answer.decision }),
    });
    return { delivered: true, decision };
  }

  /**
   * 公開 API（`Host#transcript(managerId)` 等から呼ばれる）。**戻り値の形は
   * 1バイトも変えない**——ここを3状態にすると呼び出し側（`index.ts` の
   * export 経由で他パッケージからも見える公開面）へ波及する。3状態の判別は
   * {@link #readTranscript}（private）へ切り出し、ここはそれを従来の
   * `string | null` へ薄く畳むだけの層にする。
   */
  async transcript(): Promise<string | null> {
    const result = await this.#readTranscript();
    return result.status === 'ok' ? result.body : null;
  }

  /**
   * 生ログの読み取り口。**「無い」の種類を3つに区別して返す**（#630 / #629 が
   * 「範囲外」として残した2つの穴のうち、`#shipArchive()` 側の穴の直し）。
   *
   * - `no-path`: `#transcriptPath` を一度も受け取っていない
   *   （＝ `PostToolUse` / `PreCompact` フックが一度も走っていない）。
   *   **疑うべきは計器の配線**（hook が来ていない）。
   * - `unreadable`: path は在るが `readFile` が投げた。
   *   **疑うべきはディスク・権限。**
   * - `ok`: 読めた（本文が0文字のこともある——それは正常。「何も書かれて
   *   いないセッション」であって、上の2つとは次の一手が違う）。
   *
   * **`transcript()`（public）はこの3状態を `string | null` へ畳んで返す**
   * ——上2つを同じ `null` に潰すのは呼び出し側の判断であって、ここでは潰さない。
   */
  async #readTranscript(): Promise<
    | { status: 'no-path' }
    | { status: 'unreadable'; error: unknown }
    | { status: 'ok'; body: string }
  > {
    const path = this.#transcriptPath;
    if (path === undefined) return { status: 'no-path' };
    try {
      return { status: 'ok', body: await readFile(path, 'utf8') };
    } catch (error) {
      return { status: 'unreadable', error };
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    // **器の入れ替えと `manager_stop` はここを通る**（`Host#shutdown` / `Host#stop`
    // → `stop()`）。`result` を待っていると、この経路で畳まれたぶんは台帳に1行も
    // 残らない。生ログと同じで、渡し損ねたら二度と取れない。
    await this.#flushUsage();

    // **`worker_wait` も同じ理由で取りこぼさない。** この経路は `#finish` を
    // 通らないので、ここで閉じないと開いたままの区間が黙って消える
    // （`#finish` の doc と同じ判断）。`settled` は渡さない — 中で
    // `#openTasks` の状態から導く（`#closeWorkerWaitWindow` の doc）。
    this.#closeWorkerWaitWindow();

    // **分類できなかった失敗の件数も、同じ理由でここで出す（Issue #393）。**
    // 直上の `worker_wait` とまったく同じ穴である —— `#finish` にだけ置くと、
    // **器の入れ替えと `manager_stop` で畳まれたセッションのぶんが黙って消える。**
    // 初出の1行は既に出ているので存在は残るが、**量が失われる**。
    noteUnclassifiedFailuresSummary(this.#unclassifiedFailures, this.#id);

    // 止まる前に全文を返す。runner のディスクは器と一緒に消えるので、ここで
    // 渡し損ねると manager_id から生ログへ降りる経路が切れる。
    await this.#shipArchive();
    // **`#finish` と同じ理由でここにも置く（#323）。** この経路は `closed` すら
    // 出さないので、置かないと「マネージャーが既に書いた本文」が器と一緒に消える
    // — 直上の `#shipArchive` / `#flushUsage` / `#closeWorkerWaitWindow` が
    // ここに並んでいるのと同じ穴である。
    this.#flushUnreported(reason, this.#status);
    this.#settleAll(reason);
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    await this.#reader?.catch(() => undefined);
    this.#onClosed();
  }

  /**
   * 貸し出し期限の自己失効（roadmap M5 PR4）。**`stop()` とは別の経路である。**
   *
   * `stop()`（デーモンからの明示停止・器の shutdown）は `closed` イベントを
   * 出さない — 呼んだ側（デーモン）は自分が起こした結果を `runner.list()` で
   * 確かめられるので、知らせは要らない（`manager.ts#abort` が `sessionGone` を
   * 自分で探りに行く形と対になっている）。**自己失効はランナー自身の判断**なので、
   * デーモンはこれを知る手段が `closed` イベントしかない。だから `stop()` ではなく
   * `#finish()` を通す。
   *
   * **status は `lost` にする。** 「戻れないと確定した」という既存の意味
   * （`#recoverFromFailedResume` が resume 不能を `lost` にしているのと同じ）に、
   * 「このプロセスからはこれ以上続けられない、が持ち主を失ったわけではない」
   * という自己失効の性質が最も近い。
   *
   * **ただし `lost` だけでは、自己失効と resume 不能を区別できない。** どちらも
   * 「このプロセスではもう続けられない」だが、前者は生ログさえあれば別の器から
   * 続けられる（持ち主を失っていない）のに対し、後者は材料そのものが無い。
   * そこで `closed` に構造化された印 `selfFenced: true` を立てる
   * （`runnerEventSchema` の `closed` の doc）。**文言（`reason`）では判定させない**
   * ——台帳側（`manager.ts`）がこの印だけを見て、`status` を動かさずに貸し出し
   * （`lease`）を返し、引き取り直せるようにする。
   */
  async selfFence(reason: string): Promise<void> {
    if (this.#stopped) return;
    await this.#finish('lost', reason, { selfFenced: true });
  }

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  #open(resume?: string): void {
    if (this.#query) return;
    // **ここが「器（CLI プロセス）を実際に開く／開き直す」唯一の場所である**
    // ——SDK の `SDKBackgroundTasksChangedMessage` の JSDoc が言う
    // 「whenever the session's CLI process (re)starts」に正確に対応するのは
    // ここであって、次に来る `init`（`case 'session_started'`）ではない
    // （`init` はターンの頭ごとに来るだけで、器の (re)start を意味しない
    // ——詳しくは `#liveBackgroundTasks` の doc）。`#recoverFromFailedResume`
    // が `#openTasks.clear()` を「前のセッションの task_id を持ち越さない」
    // ために置いているのと同じ理由で、ここでも前の器の在り高を持ち越さない。
    this.#liveBackgroundTasks = [];
    const generation = this.#generation;
    const q = this.#queryFn({ prompt: this.#inputStream(), options: this.#buildOptions(resume) });
    this.#query = q;
    this.#reader = this.#read(q, generation);
  }

  #buildOptions(resume?: string): Options {
    return buildManagerSessionOptions({
      // 既定は `opus`。人間が `ALTEROID_MANAGER_MODEL` に置いていればそれを使う
      // （設定ではなく承認の置き場。`model-tier.ts`）。**ここが正本である** —
      // デーモン側の自己認識に出るのは同じ env から解いた宣言であって、
      // 実際にセッションへ渡っているのはこの値である。
      model: resolveManagerModel(this.#env),
      // 人間が開く Claude Code と同じ既定（Auto）。`canUseTool` は下に残してあり、
      // `default` へ戻せば1件ずつクローンへ確認が回る。
      permissionMode: this.#permissionMode,
      systemPromptAppend: buildManagerSystemPrompt({
        managerId: this.#id,
        workerName: WORKER_AGENT_NAME,
      }),
      // 作業者層の本体はこの1個だけ。`tools` を書かない = 親の全ツールを継承。
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: buildWorkerPrompt(),
      // **省略しない。** SDK の既定は親（マネージャー）の継承なので、
      // 省けばマネージャーを差し替えた人が作業者まで巻き添えで動かすことになる。
      workerModel: resolveWorkerModel(this.#env),
      cwd: this.#cwd,
      env: this.#childEnv(),
      // 生ログはデーモンへ預ける。runner は永続化の器を持たない（記憶ストアの
      // 鍵を runner に置かないため）。
      sessionStore: this.#sessionStore(),
      ...(resume === undefined ? {} : { resume }),
      // 子プロセスを別 UID へ降ろす。**能力は1つも削らない** — 道具も preset も
      // そのままで、変えるのは実行する主体だけである（実行環境の境界）。
      ...(this.#childUser === undefined
        ? {}
        : { spawnClaudeCodeProcess: (options) => this.#spawnAsChildUser(options) }),
      canUseTool: (toolName, input, extra) => this.#onPermission(toolName, input, extra),
      onPostToolUse: (input) => this.#onPostToolUse(input),
      onPreCompact: (input) => this.#onPreCompact(input),
      // **観測専用**（`worker_wait`）。`{ continue: true }` を返すだけで何も
      // ブロックしない。理由は `#onUserPromptSubmit` の doc を見よ。
      onUserPromptSubmit: (input) => this.#onUserPromptSubmit(input),
      // **観測専用**（#357）。`{ continue: true }` を返すだけで何もブロック
      // しない。理由は `#onSubagentStop` の doc を見よ。
      onSubagentStop: (input) => this.#onSubagentStop(input),
    });
  }

  /**
   * 生ログの預け先。**runner は DB を知らない。**
   *
   * `append` は上へ流すだけ（永続化はデーモン）。`load` は resume 時にデーモンが
   * 渡してきた素材を返す — runner のディスクに前回の生ログが残っている前提を
   * 置かないための口である（器は作り直される）。
   */
  #sessionStore(): SessionStore {
    return {
      append: async (key: SessionKey, entries: SessionStoreEntry[]) => {
        this.#emit({
          type: 'mirror',
          managerId: this.#id,
          key: {
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
          },
          entries,
        });
        this.#emit({ type: 'project_key', managerId: this.#id, projectKey: key.projectKey });
      },
      load: async (key: SessionKey) => {
        if (key.subpath !== undefined) return null;
        return this.#seed ?? null;
      },
    };
  }

  /** SDK の子プロセスを別 UID で起こす（実体は `spawnAsUser`）。 */
  #spawnAsChildUser(options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) {
    return spawnAsUser(this.#childUser as RunnerChildUser, options);
  }

  /**
   * 記憶ストアの所在は子プロセスへ渡さない（渡さなければ構造的に触れない）。
   *
   * 逆に、**下（外の世界）へ手を伸ばす鍵は現在値で上書きして渡す**。`this.#env` は
   * runner が起動した瞬間のスナップショットなので、そのまま配ると人間が後から
   * 差し替えた鍵が永久に届かない（`credentials.ts`）。
   */
  #childEnv(): NodeJS.ProcessEnv {
    const env = { ...this.#env };
    if (this.#credentials !== undefined) {
      // 器の現在値が凍った env に勝つ。順番を逆にすると鍵が回らない。
      Object.assign(env, this.#credentials.values(), this.#credentials.env());
    }
    // **プロファイルは鍵より後。** 人間が明示的に書いたほうが勝つ（`credentials`
    // は1つの鍵を回すための細い口で、こちらは実行環境そのものの宣言である）。
    //
    // 重ねるのは2つ。評価済みの差分（**本命**。この env を継承した先で
    // マネージャーも作業者も MCP サーバも走る）と、`BASH_ENV` などの所在
    // （効く場面では読み直される口）。
    //
    // **走行中の仕事への配達をここに期待しないこと。** 起動時に畳んだ env は
    // その子の一生分であり、`BASH_ENV` は `bash -c` では読まれない。走行中へ
    // 届くのは `gh` シムがファイルを読み直す経路だけである（`profile.ts`）。
    Object.assign(env, this.#profileEnv());
    // **伏せるのは最後。** 先に消してから鍵を重ねると、鍵の名前として
    // `ALTEROID_DATABASE_URL` を渡すだけで、伏せたはずの値を注入し直せる。
    // 配る仕組みが伏せる仕組みを越えないよう、順序でも保証する（`credentials.ts`
    // の名前検査・プロファイル末尾の `unset` と三重にしてあるのは、どれか1つを
    // 通り忘れても穴にしないため）。
    for (const key of this.#withheldEnvKeys) delete env[key];
    return env;
  }

  /** 待っているストリームを全部起こす。**1本だけ覚えない** — 世代が重なる。 */
  #wakeInput(): void {
    const waiters = [...this.#inputWaiters];
    this.#inputWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  async *#inputStream(): AsyncGenerator<SDKUserMessage> {
    const generation = this.#generation;
    for (;;) {
      // **世代の確認を `shift` より先に。** 逆にすると、畳まれる直前の死んだ
      // ストリームが新しいセッション宛の1通を引き抜いてから終わる。
      if (generation !== this.#generation) return;
      const next = this.#input.shift();
      if (next !== undefined) {
        // **`worker_wait` の `byCause.input` の材料。** 実際に消費した入力だけを
        // 数える（積んだ時点ではなく、SDK が読み取った時点）。
        this.#inputsSinceResult += 1;
        yield next;
        continue;
      }
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        this.#inputWaiters.add(resolve);
      });
    }
  }

  /**
   * `generation` は、このストリームが何世代目のものかである。
   *
   * **作り直しの後に古い読み手が `#finish` しない**ようにするために持つ。
   * 引き継ぎで新しいセッションを開くと、畳まれた古いストリームの `for await` が
   * そこで終わって降りてくるが、それは失敗でも完了でもない。
   */
  async #read(q: Query, generation: number): Promise<void> {
    try {
      for await (const message of q) {
        // **provider の綴りを読むのはここまでである**（`claude-provider.ts` の
        // `foldClaudeMessage`）。ここから下へ流れるのは中立イベントだけで、
        // 次の provider を足しても `#apply` は1本のままになる（#486）。
        for (const event of foldClaudeMessage(message)) this.#apply(event);
      }
      if (this.#stopped || generation !== this.#generation) return;
      // 一度も手が動かないまま閉じたのなら、resume は効かなかった。
      const closed = 'セッションが開かないまま閉じた';
      switch (this.#recoverFromFailedResume(closed)) {
        case 'recovered':
          return;
        case 'unresumable':
          await this.#finish('lost', closed);
          return;
        default:
          await this.#finish('done', 'マネージャーのセッションが閉じた。');
          return;
      }
    } catch (error) {
      if (generation !== this.#generation) return;
      const reason = String(error);
      if (!this.#stopped) {
        switch (this.#recoverFromFailedResume(reason)) {
          case 'recovered':
            return;
          // **`failed` にしない。** 「セッションが落ちた」は、話しかければ直るかも
          // しれない失敗に見える。戻れなかったことが確定しているなら、そう言う。
          case 'unresumable':
            await this.#finish('lost', reason);
            return;
          default:
            break;
        }
      }
      await this.#finish('failed', `マネージャーのセッションが落ちた: ${reason}`);
    }
  }

  /**
   * `#progressed` を立てる唯一の口。**必ずここを通す** — 直接
   * `this.#progressed = true` を書くと、`#seed` の解放を足し忘れる経路が生まれる。
   *
   * 立てると同時に `#seed` を解放する。安全な理由は `#seed` のフィールド
   * コメントを参照。既に立っている（＝既に解放済み）なら何もしない。
   */
  #markProgressed(): void {
    if (this.#progressed) return;
    this.#progressed = true;
    this.#seed = undefined;
  }

  /**
   * 前のセッションへ戻れなかったときの出口。
   *
   * **黙って引き下がることも、黙って挑み直すこともしない。** 生ログはデーモンが
   * 預かっているので、session_id が腐っていても続きの材料はある。新しい
   * セッションを開いて、そこへ記録ごと引き継がせる（`resume` が拒まれたことは
   * それ自体を事実として上へ降ろす）。
   *
   * 材料まで無いなら止まるしかない。**そのときも黙らない** — 投げ直しても同じ
   * 答えが返る失敗なので、デーモンが自動の挑み直しを打ち切ってクローンへ回す。
   *
   * 戻り値:
   *
   * - `recovered`: 新しいセッションへ引き継いだ。呼び出し側は `#finish` しない
   * - `unresumable`: 戻れないと確定した。**呼び出し側はこのセッションを畳む**
   * - `not-a-resume-failure`: resume の失敗ではない。呼び出し側は普段どおり
   *
   * **`unresumable` を `not-a-resume-failure` と同じ戻り値にしない。** 一緒に
   * すると、戻れなかった resume がそのまま「1ターン終わった」という報告として
   * 上がり、台帳には `done`（＝待機中。話しかければ続く）が残る。器を作り直すと
   * プロセス内の諦めは消えるので、腐った session_id しか無いマネージャーが
   * 「まだ続けられるもの」としてクローンへ見え続ける。
   */
  #recoverFromFailedResume(reason: string): 'recovered' | 'unresumable' | 'not-a-resume-failure' {
    const attempt = this.#resumeAttempt;
    if (attempt === null) return 'not-a-resume-failure';
    this.#resumeAttempt = null;

    // **手が動いた後の失敗は resume の失敗ではない。** そこで作り直すと、既に
    // 済ませた作業（コミットや PR）を記録から二度走らせることになる。判定は
    // `init` が来たかではなく、**このセッションが何かをしたか**で見る。
    if (this.#progressed) return 'not-a-resume-failure';

    // **委譲の区間を持ち越さない。** 新しいセッション（か、この後の終了）は
    // 前のセッションが開いていた作業者の `task_id` を一切知らない。持ち越すと
    // 二度と来ない `task_notification` を待ち続けて区間が永久に閉じない。
    // ここで開いていれば畳む（`#finish` と同じ理由。`recovered` で終わる経路には
    // `#finish` を通らないので、ここで閉じないと一生閉じない）。`unresumable` で
    // 終わる経路は直後に呼ばれる `#finish` が同じ関数を呼ぶが、既に閉じている
    // ので二重には emit しない。
    //
    // **`close()` を先に、`clear()` を後に。** `#closeWorkerWaitWindow` は
    // `settled` を「その時点の `#openTasks` が空か」から導く。先に `clear()`
    // すると、`task-2` が開いたまま resume に失敗した回まで「全員から完了通知を
    // 受け切った」（`settled: true`）に化ける — 開いたままの委譲を握り潰して
    // 帳消しにする形になり、`settled: false` の意味（受け切る前に畳まれた）が
    // 崩れる。先に読ませてから、読み終わった後で捨てる。
    this.#closeWorkerWaitWindow();
    this.#openTasks.clear();

    const record = renderSessionLog(this.#seed);
    if (record === null) {
      this.#emit({
        type: 'resume_failed',
        managerId: this.#id,
        sessionId: attempt.sessionId,
        reason,
        recovered: false,
      });
      return 'unresumable';
    }

    // 前のストリームを畳んでから開く。世代を進めないと、死んだ `#inputStream` が
    // 引き継ぎの一言を横取りする。
    this.#generation += 1;
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    this.#query = null;
    this.#reader = null;
    this.#sessionId = undefined;
    // 新しいセッションは resume しないので、素材は本文へ畳んで渡す。
    this.#seed = undefined;
    // **前の器へ向けた入力を捨てない。** 一言も落とさずに引き継ぎへ折り込む
    // （落とすと、人間やクローンがちょうど送った指示だけが消える）。
    const carried = this.#input
      .splice(0)
      .map((message) => String(message.message.content))
      .filter((text) => text.length > 0);

    this.#emit({
      type: 'resume_failed',
      managerId: this.#id,
      sessionId: attempt.sessionId,
      reason,
      recovered: true,
    });
    this.push(handoffPrompt({ sessionId: attempt.sessionId, reason, record, carried }));
    this.#open();
    return 'recovered';
  }

  /**
   * 中立イベント1件へ反応する（`agent-events.ts` の表の (ii)）。
   *
   * **provider の綴りはここには無い。** 何が起きたかを決めるのは
   * `foldClaudeMessage` で、ここが決めるのは「起きたことへマネージャー層がどう
   * 反応するか」だけである —— 何を `RunnerEvent` として降ろすか、委譲の区間を
   * どう数えるか、どこでセッションを畳むか。**クローン層の同じ場所は
   * `clone.ts` の `#apply` で、副作用は2層で15種あり重なるのは2種だけである。**
   */
  #apply(event: AgentEvent): void {
    switch (event.type) {
      case 'session_started': {
        // **`init` そのものはリセットの契機にしない。** `SDKSystemMessage`
        // の JSDoc（逐語。version 0.3.259 同梱の sdk.d.ts）:
        //
        // > Session metadata the CLI emits at the start of each turn,
        // > normally ahead of every other message of that turn: session_id,
        // > model, working directory, tools, MCP servers, slash commands,
        // > permission mode, and the capabilities list for feature
        // > detection.
        //
        // **＝ init はターンの頭ごとに来る。** 器（CLI プロセス）が
        // (re)start したときにしか来ないのではない。
        //
        // 一方 `SDKBackgroundTasksChangedMessage` の JSDoc（同じく逐語）が
        // 言っているのは：
        //
        // > The level is per-process: nothing is emitted at startup, so
        // > consumers must reset to the empty set whenever the session's
        // > CLI process (re)starts and let the next membership change
        // > repopulate it.
        //
        // ここが言っているのは「背景タスクの level 信号が per-process で
        // ある」ことだけで、「init はプロセス起動時にしか来ない」ではない。
        // **以前のここのコメントは、この一節を init の発火条件の説明として
        // 誤って流用していた。** 同じ session_id のまま来る init は、ターン
        // が変わっただけで器は入れ替わっていない——ここで無条件にリセット
        // すると、ターンの頭ごとに在り高が0へ落ち、そのターン中に
        // `background_tasks_changed` が来なければ `awaitingBackground` が
        // 付かず、報告が畳まれずクローンを起こしていた（実測: K 本並列に
        // 出すと K-1 回よけいに起こす）。
        //
        // **器が本当に入れ替わったかは `#open()`（フィールド初期化・reopen
        // 側）が既に見ている**（`#liveBackgroundTasks` の doc の契機1・2）。
        // ここで見るのは、SDK 側でセッションが差し替わった場合の保険——
        // `event.sessionId` が直前の `this.#sessionId` と違うときだけ、
        // 判定できないときは配る側へ倒すという原則に沿ってリセットする。
        // **比較は `this.#sessionId` を更新する前に行う。** 初回は
        // `#sessionId === undefined` なので必ずリセット側に倒れる
        // （空→空で無害）。
        if (this.#sessionId !== event.sessionId) this.#liveBackgroundTasks = [];
        this.#sessionId = event.sessionId;
        this.#emit({ type: 'session', managerId: this.#id, sessionId: event.sessionId });
        return;
      }

      case 'rate_limit': {
        // 枠の事実（アカウント単位）。**ターンの頭ごとに来る**ので、ここが
        // 走行中の唯一の最新情報になる（使い捨ての probe は idle 用）。
        this.#emit({ type: 'rate_limit', managerId: this.#id, facts: event.facts });
        return;
      }

      case 'permission_denied': {
        // 確認へ上げずにその場で止められた1件（分類器・deny 規則）。
        //
        // **`permissionMode: 'auto'` ではここが唯一の生の合図である。** `canUseTool`
        // は呼ばれないので、この合図を捨てるとマネージャーや作業者の手が止まったこと
        // は誰にも見えない。SDK 曰くこれは best-effort（取りこぼしうる）で、
        // authoritative なのは `result.permission_denials` — だから**両方**読む。
        this.#noteDenial(event.denial, 'live');
        return;
      }

      // 委譲の区間を追う（`worker_wait`）。**どの合図を委譲の開閉として数え、
      // どれを数えないかは provider の写しが決めている**（`claude-provider.ts` の
      // `foldClaudeMessage` —— 取りこぼすと契機がどこにも残らなかった事故の
      // 経緯もあちらに在る）。ここが決めるのは、開閉を受けて区間をどう数えるか
      // だけである。
      case 'delegation_started': {
        this.#onTaskStarted(event);
        return;
      }

      case 'delegation_notified': {
        this.#onTaskNotification(event);
        return;
      }

      case 'usage_notice': {
        // 上限の文言。**API エラーとしては来ない**（SDK のコメント）ので、
        // 通知・情報メッセージの本文を見るしかない。ここを見ないと「枠を使い切って
        // 課金枠に移った」＝止まる一歩前を捉えられない。
        // **文言の分類そのものは provider の写しが済ませている**
        // （`claude-provider.ts` の `foldClaudeMessage`）。ここへ届く時点で
        // 「上限の合図である」は確定している。
        this.#emit({ type: 'usage_notice', managerId: this.#id, notice: event.notice });
        return;
      }

      case 'assistant_message': {
        // マネージャーが喋った本文を溜めておく。**作業者の本文は混ぜない** —
        // `parentToolUseId` が付いているものは Task の中の別の層の発言であって、
        // マネージャーが人間（＝クローン）へ向けて書いたものではない。
        if (event.parentToolUseId === null) {
          const said = assistantText(event.blocks);
          // **SDK が「これは応答ではない」と印を付けたメッセージは報告に混ぜない。**
          // 支出上限（`billing_error`）・枠（`rate_limit`）・認証の失敗はここへ来る。
          // 直す前はこの印を1度も見ておらず、上限の英語文言がそのまま
          // 「マネージャーの報告」として台帳・日誌・クローンの受信箱へ流れていた
          // （`sdk-failure.ts` の doc。クローン側の穴と同じ形である）。
          const rejected = assistantFailureOf(event.errorCode, said);
          if (rejected !== undefined) {
            this.#rejected = rejected;
            return;
          }
          if (said.length > 0) {
            this.#said.push(said);
            // **`#flushUnreported()` のための材料**（`#saidUuid` の doc）。
            // 通常の経路（`result` が来る回）はこの値を1度も読まない。
            this.#saidUuid = event.id;
          }
        }
        return;
      }

      case 'background_tasks': {
        // **REPLACE 意味論。加算・削除の差分計算はしない**
        // （`#liveBackgroundTasks` の doc）。読むのは `result` の枝だけ。
        this.#liveBackgroundTasks = event.tasks;
        return;
      }

      // **この層が反応しない事実。** 逐次配信（`text_delta`）はクローン層の画面の
      // ためのもので、マネージャーの `Options` は `includePartialMessages` を
      // 立てていない。道具の結果（`tool_result`）も同じく画面の合図である。
      // **「まだ書いていない」ではなく「この層は見ないと決めてある」である。**
      case 'text_delta':
      case 'tool_result':
        return;

      // **こちらは「見ないと決めてある」ではなく「まだ書いていない」である。**
      // compaction の観測は、いまはクローン層の `turn_usage`（`clone.ts` の
      // `case 'turn_ended'`）にだけ載せてある —— マネージャー層の
      // `turn_usage`（`manager.ts` の `case 'usage'`）はこのイベントを読んで
      // いない。同じ形をこちらにも足すかどうかは、この PR の範囲外の判断として
      // 別途に残す（PR 本文「言えないこと」）。
      case 'compaction':
        return;

      case 'turn_ended': {
        // ターンの区切りで必ず畳む。持ち越すと、前のターンの本文が次の報告に
        // 混ざって「言っていないことを言った」ことになる。
        const said = this.#said;
        this.#said = [];
        // **`#said` と同じ区切りで畳む**（`#saidUuid` の doc）。
        this.#saidUuid = undefined;
        // **印も同じ区切りで畳む。** 持ち越すと、次のターンが成功しても失敗として
        // 報告されることになる（`#said` を持ち越してはいけないのと同じ理由）。
        const rejected = this.#rejected;
        this.#rejected = null;

        // **委譲の契機を数える（`worker_wait`）。** ターンの区切りで必ず畳む —
        // 持ち越すと次のターンへ漏れる（`#said` を畳むのと同じ理由）。
        const inputsThisTurn = this.#inputsSinceResult;
        const notificationsThisTurn = this.#notificationsSinceResult;
        const toolsThisTurn = this.#toolsSinceResult;
        const submitsThisTurn = this.#submitsSinceResult;
        const sourcesThisTurn = this.#submitSources;
        this.#inputsSinceResult = 0;
        this.#notificationsSinceResult = 0;
        this.#toolsSinceResult = 0;
        this.#submitsSinceResult = 0;
        this.#submitSources = new Map();

        // **`#window` が非 null なのは、区間が開いている（`#openTasks` が非空）か
        // 閉じ待ち（`#windowClosing`）のときだけ**である。委譲の外で起きたターン
        // （人間・クローンと直接話しているだけの回）は数えない。
        if (this.#window !== null) {
          const window = this.#window;
          window.turns += 1;
          // **契機は排他で1件だけ数える。** 3つの合計が `turns` と必ず一致する
          // （`runner-wakeup.test.ts` がこの不変を固定する）。
          if (inputsThisTurn > 0) {
            window.byCause.input += 1;
          } else if (notificationsThisTurn > 0) {
            window.byCause.notification += 1;
          } else {
            window.byCause.continuation += 1;
          }
          if (toolsThisTurn === 0) window.toolless += 1;
          window.notifications += notificationsThisTurn;
          window.submits += submitsThisTurn;
          for (const [source, count] of sourcesThisTurn) {
            window.sources.set(source, (window.sources.get(source) ?? 0) + count);
          }
          // **最後の完了通知そのものを契機に回ったこのターンを数え終えてから閉じる。**
          // `#openTasks` が空になった瞬間に閉じないのはこのためである
          // （`#windowClosing` の doc）。`settled` は渡さない — この時点で
          // `#openTasks` は必ず空なので（`#windowClosing` はそのときにしか立たない）、
          // 中で導く `settled` は自動的に `true` になる。
          if (this.#windowClosing) this.#closeWorkerWaitWindow();
        }

        // **成否で絞らない。** 拒否は成功したターンにも失敗したターンにも載る（型は
        // `SDKResultSuccess` と `SDKResultError` の両方が持っている）。`usage` と違って
        // ゼロ埋めで害が出る値ではないので、ここは落とさず全部見る。
        for (const denial of event.denials) this.#noteDenial(denial, 'result');

        // **SDK が「応答ではない」と言っている印**（`assistant.error` /
        // `result.subtype` / `subtype: 'success'` なのに `is_error`）。
        //
        // **`succeeded` はこれを兼ねられない。** あちらは台帳の問い
        // （この累積を通してよいか）で `subtype === 'success'` だけを見るので、
        // `is_error: true` の result を成功として通す（`sdk-failure.ts` の表）。
        // 下の `#progressed` と `usage` は従来どおり `succeeded`（＝
        // `usage.ts` の `isSuccessResult`）のままにしてあり、
        // 変えたのは**報告の扱い**だけである。
        const failure = event.failure ?? rejected ?? undefined;

        // **`init` が来たことは「戻れた」ことではない。** 実機では、開きはしたが
        // その回が `error_during_execution` で何も返さずに終わる形も出ている。
        // 手が動く前の結果なし終了は、この resume が効かなかったということである。
        if (event.succeeded) {
          this.#markProgressed();
          // 消費の累積を降ろす（台帳へ畳むのはデーモン）。
          //
          // **成功した result だけを通す。** SDK は
          // `crash/startup-error results may carry zeroed values` と言っている。
          // ゼロを「累積が 0 になった」として通すと、受け取った側の基準が下がり、
          // 次に届いた本物の累積が丸ごと増分になる＝記録済みの分がもう一度積まれる。
          //
          // **絞っても取りこぼさない。** 値は累積なので、失敗した回のぶんも次の成功が
          // 運んでくる。落ちるのは「セッションが失敗で終わったときの最後の1ターン」
          // だけで、そこで打ち切りなので後続へ波及しない。
          if (event.usage !== undefined) {
            this.#emit({
              type: 'usage',
              managerId: this.#id,
              sessionId: this.#sessionId,
              models: event.usage.models,
            });
          }
        }

        // **なぜ終わったのかを落とさない。** 実際に支出上限へ当たったとき、
        // マネージャーは `You've hit your individual spend limit` を返して終わった。
        // これを「結果なしで終了」だけにすると、上限で止まったのか失敗したのかを
        // クローンが区別できない — 前者は待つ / 人間に頼む、後者は挑み直す、で
        // 手が正反対になる。判定は SDK の定数で行う（自前の正規表現は腐る）。
        //
        // **成否の分岐の外に出してある。** `assistant.error` で止まった回は `result` が
        // 成功で返ってくることがあり、`else` の中に置くとその回だけ検知できない。
        // 分類にかけるのは**SDK が失敗として出した文言だけ**である（マネージャーが
        // 書いた本文 `said` は通さない — `classifyUsageNotice` は部分一致なので、
        // 「上限に当たった」と報告に書いた瞬間に上限と誤判定する）。
        if (failure !== undefined) {
          let classified = false;
          for (const candidate of [failure.text, resultTextOf(event).text, ...event.errorLines]) {
            const notice = classifyUsageNotice(candidate);
            if (notice !== undefined) {
              this.#emit({ type: 'usage_notice', managerId: this.#id, notice });
              classified = true;
              break;
            }
          }
          // **1件も分類できなかった回に跡を残す（Issue #393）。** ここを黙って
          // 抜けると、**回し手が原理的に聞けない失敗**が何回起きているかがどこにも
          // 残らない —— 資格が1つも無い器で起こしたときがその形で、マネージャーが
          // 落ち続けてもプールは何も検知しない。**出す判断は変えていない**
          // （分類できたら従来どおり `usage_notice` を出し、できなければ従来どおり
          // 何も出さない）。足したのは数えることだけである。
          if (!classified) {
            noteUnclassifiedFailure(
              this.#unclassifiedFailures,
              this.#id,
              failure.via,
              failure.code,
            );
          }
        }

        if (!event.succeeded) {
          const outcome = this.#recoverFromFailedResume(
            `結果なしで終了: ${resultTextOf(event).text}`,
          );
          if (outcome === 'recovered') return;
          // **戻れなかった resume を「1ターン終わった」として報告しない。** ここを
          // 素通りさせると `report` が上がり、台帳には `done`（＝終えて待機中。
          // 話しかければ続く）が書かれる。実際には腐った session_id しか無いので、
          // クローンは「まだ続けられるもの」を見せられ、話しかけるたびに失敗する。
          // 手が動いていないのだから、ここは畳むのが正しい。
          if (outcome === 'unresumable') {
            // **落ち方は変えない。「どこで」だけを足す（#438 案D）。**
            //
            // **他5箇所（1122 / 1297 / 1300 / 1313 / 1319）のように `await` へ
            // 揃えることはしていない。** ここを囲む `#dispatch` は同期メソッドで、
            // 呼び出し元（`#read` の `for await`）も `await` せずに呼んでいる。
            // 揃えるには両方を非同期へ変えることになり、**メッセージ処理に直列化点が
            // 1つ増える** —— その影響は測っていないので、この変更には含めない。
            void this.#finish('lost', `結果なしで終了: ${resultTextOf(event).text}`).catch(
              (error: unknown) => {
                noteBackgroundFailure(
                  'セッションの片付け',
                  `managerId=${this.#id} outcome=lost`,
                  error,
                );
                throw error;
              },
            );
            return;
          }
        }

        // **失敗した回の報告に、失敗であることを載せる。** 直す前は成否によらず
        // `reportText(said, resultText(message))` を上げていたので、上限の英語文言が
        // そのまま「マネージャーの報告」として台帳（`lastReport`）・日誌・クローンの
        // 受信箱へ流れていた。クローンから見て「報告が来た」と「エラーで死んだ」が
        // 区別できない ＝ クローン側で塞いだのと同じ穴がここに残っていた。
        //
        // **本文（`text`）の側でも包む。** 構造化した `failure` だけに頼ると、それを
        // 見ていない読み手（台帳の `lastReport` を出す画面・日誌を読む人間）には
        // 依然としてエラー文が報告として見える。
        //
        // **失敗で終わった回は `contentless` に含めない。** `failedReportText` は
        // 必ず本文を作るし、上限に当たった事実はクローンが知る必要がある
        // （このターン限りは待つ／挑み直すの判断材料）ので、`failure !== undefined`
        // の枝では `reportText` そのものを呼ばない。
        const outcome =
          failure === undefined
            ? reportText(said, resultTextOf(event))
            : {
                text: failedReportText(said, failure, resultTextOf(event).text),
                contentless: false,
              };
        this.#status = this.#pending.length > 0 ? 'waiting_human' : 'done';
        // **マネージャーがバックグラウンド実行の完了を待つためだけに畳んだ
        // ターンの報告に、その旨を載せる（`runner-protocol.ts` の
        // `report.awaitingBackground` の doc）。**
        //
        // 実測の経緯: `Bash` を `run_in_background: true` で起こした直後、
        // マネージャーが「完了を待つ」とだけ言って `end_turn` で畳むと、その
        // 最後の発話がそのまま「報告」としてクローンへ配られ、クローンの
        // ターンを1本無駄に起こしていた（依頼者が生ログで実測、同日に11本）。
        //
        // **3条件すべてを満たすときだけ載せる**（1つでも欠けたら必ず配る側
        // へ倒す）:
        // 1. `failure === undefined` —— 失敗で終わった回は必ず配る
        //    （上限・拒否は握り潰さない）
        // 2. `this.#status === 'done'` —— `waiting_human`（確認待ちが在る）
        //    回は必ず配る。確認待ちを黙って畳むと人間の判断が止まる
        // 3. `this.#liveBackgroundTasks.length > 0` —— 起こしっぱなしの
        //    背景処理が実際に在るときだけ
        const awaitingBackground =
          failure === undefined && this.#status === 'done' && this.#liveBackgroundTasks.length > 0
            ? {
                count: this.#liveBackgroundTasks.length,
                // **診断用の写しであって判定には使わない**（doc のとおり）。
                breakdown: summarizeBackgroundTasks(this.#liveBackgroundTasks),
              }
            : undefined;
        this.#emit({
          type: 'report',
          managerId: this.#id,
          // **#206: provider がこの結果に払った id を運ぶ。** SDK の `result.uuid` で、
          // `#onPermission` が `extra.requestId` / `extra.toolUseID` をそのまま
          // 使うのと同じ作法——runner が新しい値を振るのではなく、SDK 側の
          // 識別子をそのまま `reportId` として運ぶ（`runnerEventSchema` の
          // `report.reportId` の doc）。
          reportId: event.id,
          text: outcome.text,
          status: this.#status,
          ...(failure === undefined ? {} : { failure: { code: failure.code, via: failure.via } }),
          ...(outcome.contentless ? { contentless: true } : {}),
          ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
        });
        return;
      }

      // **枝が増えたらここが型で落ちる（#285 と同じ形）。** 落ちたら「この層は
      // その事実にどう反応するか」を決めてから通すこと —— 既定で無視へ倒すと、
      // provider が名乗り始めた事実が黙って網の外へ出る。
      default: {
        const unread: never = event;
        void unread;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 委譲の契機を数える（`worker_wait`）
  // -------------------------------------------------------------------------

  /** `task_started`。`#openTasks` が 0→1 になった瞬間に区間を開く。 */
  #onTaskStarted(event: AgentDelegationStarted): void {
    // provider が id を名乗らなければ、取りこぼすより偽の id で数える方を選ぶ
    // （他の道具の `brief`/`randomUUID` 系の判断と同じ）。**代用値をここで作るのは、
    // 何で埋めるかが層の判断だからである**（`agent-events.ts` の doc）。
    const taskId = event.taskId ?? randomUUID();
    if (this.#openTasks.size === 0 && this.#window !== null) {
      // 閉じ待ちの間に次の委譲が始まった。**同じ区間として続ける** — ここで
      // 新しい区間を開き直すと、閉じていない集計を上書きして消してしまう。
      this.#windowClosing = false;
    }
    const window =
      this.#window ??
      (this.#window = {
        openedAt: new Date().toISOString(),
        tasks: 0,
        turns: 0,
        byCause: { input: 0, notification: 0, continuation: 0 },
        toolless: 0,
        notifications: 0,
        submits: 0,
        sources: new Map(),
      });
    this.#openTasks.add(taskId);
    window.tasks += 1;
  }

  /** `task_notification`。開いている委譲から1件外し、全部片付いたら閉じ待ちにする。 */
  #onTaskNotification(event: AgentDelegationNotified): void {
    const taskId = event.taskId;
    const had = taskId !== undefined && this.#openTasks.delete(taskId);
    // **`worker_wait.notifications` の材料。** 対応する `task_started` を見て
    // いなくても（`had` が false でも）数える — 通知そのものは事実である。
    this.#notificationsSinceResult += 1;
    // **本当に 1→0 の遷移のときだけ閉じ待ちにする。** 対応の無い通知（本来
    // 起きない想定だが防御的に見る）で誤って閉じ待ちを立てない。
    if (had && this.#openTasks.size === 0) this.#windowClosing = true;
  }

  /**
   * 開いている委譲区間を1件の `worker_wait` として降ろし、閉じる。
   *
   * **`#window` が null なら何もしない。** `#finish` / `stop` / 引き継ぎの
   * どこから呼んでも安全に重ねられるようにするための無害化である。
   *
   * **`settled` は引数で受け取らず、ここで `#openTasks` の状態から導く。**
   * 呼び出し側に真偽値を持たせると、`#finish` / `stop` / 引き継ぎの3経路が
   * 固定で `false` を渡すことになり、**「委譲した作業者全員から完了通知を
   * 受け切った直後に、次の `result` が来ないままセッションが畳まれた」場合まで
   * `false`（＝受け切れなかった）と偽って報告する。** これはこの PR が答えたい
   * 問い（最後の完了通知の後、SDK はマネージャーを起こすのか）のど真ん中で
   * 起きる — 「起こさない」という当たりの仮説が成り立つ場合に限って、**全区間
   * に偽の印が付く**ことになる。`#openTasks.size === 0` は「呼ばれた時点で
   * 委譲した全員から通知を受け切っているか」をそのまま表すので、これを直接
   * 使う（呼び出し側の意図の言い換えを挟まない）。
   *
   * `sources` は**取れた分だけ載せる**。`#submitSources` が1件も無ければ
   * フィールドごと省く — 取れない軸に0の行を作らない（AGENTS.md 地雷）。
   */
  #closeWorkerWaitWindow(): void {
    const window = this.#window;
    if (window === null) return;
    const settled = this.#openTasks.size === 0;
    this.#window = null;
    this.#windowClosing = false;
    const sources = Object.fromEntries(window.sources);
    this.#emit({
      type: 'worker_wait',
      managerId: this.#id,
      openedAt: window.openedAt,
      tasks: window.tasks,
      turns: window.turns,
      byCause: window.byCause,
      toolless: window.toolless,
      notifications: window.notifications,
      submits: window.submits,
      ...(Object.keys(sources).length > 0 ? { sources } : {}),
      settled,
    });
  }

  /**
   * 止められた1件を上へ降ろす（同じ id は一度だけ）。
   *
   * **`#progressed` は立てない。** 拒否は「やろうとしたが何も起きなかった」で
   * あって、手が動いた印ではない。ここで立てると、resume が効かずに終わった回を
   * 「もう作業した」と誤認して生ログからの作り直しを止めてしまう。
   */
  #noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): void {
    const tool = denial.tool ?? '(不明な道具)';
    const input = denial.input;
    // id が無ければ道具と入力から作る。**取りこぼすより重複を許す** — 決まった
    // 形なので、生の合図と result の記録が同じ1件なら普通はここでも一致する。
    //
    // **代用値を作るのはこちら側の仕事である**（`agent-events.ts` の
    // `AgentPermissionDenial` の doc）。provider の写しは「無かった」をそのまま
    // 運ぶだけで、何で埋めるかは層が決める。
    //
    // **入力そのものを鍵に混ぜない。** ここは以前 `brief(input, 120)` を素で
    // 連結していたが、この鍵は `#denied` の `onForget` が**日誌へそのまま並べる**
    // （`ids.join(', ')`）。道具の入力には環境変数の値やトークンが入りうるので、
    // 記憶が上限に達した回にだけコマンド本文が日誌へ出る経路が開いていた。
    // **同じ文字列は同じ鍵になる**ので、畳み方（＝重複排除の効き方）は変わらない。
    const toolUseId = denial.toolUseId ?? `${tool}:${digestOf(brief(input, 120))}`;
    // **既に降ろしてある1件でも、入力を持つ記録が後から来たら形だけ足す。**
    //
    // 同じ拒否は `via: 'live'`（走行中の合図）と `via: 'result'`（ターン終わりの
    // 記録）の両方に載るが、**入力を持っているのは後者だけ**である
    // （`runner-protocol.ts` の `input` の doc）。ここが `has` だけで弾いて
    // いたので、入力を持つ authoritative な記録が丸ごと捨てられ、日誌には
    // 「何を実行しようとしたか」が1件も残らなかった——読む側は「良性のコマンドが
    // 誤検知された」と「拒否されるべきコマンドだった」を区別できず、次の一手を
    // 選べない。
    //
    // **これは `input` の欄を後から詰めているのではない**（`runner-protocol.ts`
    // の `input` の doc が禁じているのはそちら）。降ろしているのは SDK が
    // `result.permission_denials` で実際に名乗った値であって、推測ではない。
    //
    // **本文は載せず形だけ載せる**（`denial-shape.ts`）。**足すのは1度だけ** ——
    // `result` が累積かどうかは SDK の型に書かれていない（この帳面の doc）ので、
    // 2度目以降は下の早期返却が落とす。
    //
    // **`permission_denied` をもう一度降ろさない。** デーモン（`manager.ts`）は
    // 拒否を1件ずつ数えており、`shouldEscalateDenial` は「1ずつ増える数」を
    // 前提にしている。2本目を降ろすと二重計上になり、段（3件目・10件目…）を
    // 跨いで escalation が飛ぶ。**だから既存の `note` で足す** —— protocol に
    // 種別も欄も足さないので、デーモンと runner のデプロイ順序がどちらでも
    // 壊れない（新しい種別を足すと、まだ知らないデーモンでは
    // `runnerEventSchema` の `safeParse` が落ちて `unknown-shape` の
    // 取りこぼしとして鳴る。`apps/daemon/src/runner-client.ts`）。
    const seen = this.#denied.get(toolUseId);
    if (seen !== undefined) {
      if (seen.input || input === undefined) return;
      this.#denied.set(toolUseId, { input: true });
      const shape = denialInputShape(input);
      if (shape !== undefined) {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text:
            `先に降ろした ${tool} の拒否について、ターン終わりの記録（via: result）に` +
            `入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: ${shape}`,
        });
      }
      return;
    }
    this.#denied.set(toolUseId, { input: input !== undefined });
    // `decision_reason` / `decision_reason_type` / `message` は SDK の走行中の
    // 合図（`via: 'live'`）にしか付かない任意フィールドである（`result` の
    // `SDKPermissionDenial` は理由を持たない）。**文字列であることを確かめて
    // からしか載せない** — `undefined` を代入すると `JSON.stringify` で落ちる
    // にせよ、型を保証しないまま runner-protocol.ts の `z.string().optional()`
    // へ渡すのは事故のもとである（SDK の型変化で数値や null が来ても黙って通す
    // ことになる）。無いものは作り物を出さず、キーごと省く。
    //
    // **`actor` は `via: 'live'` のときだけ載せる（`#onPostToolUse` と同じ式）。**
    // `via: 'result'`（`result.permission_denials`）の SDK 型（`SDKPermissionDenial`）
    // は `tool_name` / `tool_use_id` / `tool_input` の3つしか持たず、`agent_id`
    // が原理的に存在しない。**「マネージャーだった」と決めつけないこと** ——
    // それは「層が取れた」ではなく「取れなかった」であり、`actor` をキーごと
    // 省いて第3の状態のまま runner-protocol.ts / manager.ts へ渡す
    // （このメソッド既存の「無いものは作り物を出さず、キーごと省く」規則を
    // そのまま延長しただけである）。**同じ扱いが、runner とデーモンの
    // デプロイのずれの窓も塞ぐ** —— 古い runner がまだ `actor` を送ってこない
    // 回も、同じ「取れていない」へ自然に落ちる。
    //
    // **`agent_type` は今のところ常に無い。** `SDKPermissionDeniedMessage`
    // （`via: 'live'` の合図）は `agent_id` は持つが `agent_type` を持たない
    // （`PostToolUseHookInput` にはあるが、この合図には無い。SDK
    // `0.3.247` の型で確認済み）。だから作業者の拒否は `WORKER_AGENT_NAME`
    // （`worker`）に落ちる ——`#onPostToolUse` のように呼び出した Task の
    // 具体的な agent_type までは分からない。**揃えられなかった点であり、
    // SDK の型に無い情報をここで作り物として埋めることはしない。** 将来
    // SDK がこの欄を持たせてきた場合に備えて読みはするが、現状では
    // 常に `undefined` である。
    const agentId = denial.agentId;
    const agentType = denial.agentType;
    const actor =
      via === 'live'
        ? agentId === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${agentType ?? WORKER_AGENT_NAME}`
        : undefined;
    this.#emit({
      type: 'permission_denied',
      managerId: this.#id,
      toolUseId,
      tool,
      input,
      via,
      ...(actor === undefined ? {} : { actor }),
      ...(denial.reason === undefined ? {} : { reason: denial.reason }),
      ...(denial.reasonType === undefined ? {} : { reasonType: denial.reasonType }),
      ...(denial.message === undefined ? {} : { message: denial.message }),
    });
  }

  /**
   * **畳む直前に累積をもう一度読む。** 台帳の穴はここでしか塞げない。
   *
   * 台帳へ入るのは `result.modelUsage` だけなので（`#dispatch`）、**`result` を
   * 1度も出さずに終わったセッションの消費はどこにも載らない。** しかも載らない
   * だけではなく一覧にも現れないので、「いくら取りこぼしたか」すら分からない。
   * 実測では、30分走って PR をマージまで運んだ委譲が器の入れ替えで畳まれ、台帳に
   * 1行も残らなかった（`mgr-eef70c01`）。
   *
   * SDK は同じ値を control channel からも出している —
   * `SDKControlGetUsageResponse.session.model_usage` は `result.modelUsage` と
   * **同じ型・同じ意味の累積**で、`result` を待たずに読める
   * （`usage.ts` の `sessionModelUsageOf`）。
   *
   * **best-effort である。決して投げず、畳む経路をこれに縛らない。**
   *
   * - 実測で、ターンを回している最中の control 要求は
   *   `ProcessTransport is not ready for writing` で失敗する（`usage-probe.ts` の
   *   注記4）。**失敗は異常ではなく通常の枝**である。取れなければ取れないまま畳む
   * - **全部ゼロなら降ろさない。** ゼロは「使っていない」ではなく「読めなかった」で
   *   ある。降ろすと台帳にゼロだけの基準ができて、**「記録が無い」が「$0.00 使った」に
   *   化ける**（`foldUsageSnapshot` が守っているのは基準を*下げない*ことで、基準を
   *   *作らない*ことではない）
   * - 値は累積なので、この1回が `result` 経由の記録と重なっても増分が 0 になるだけ
   *   である（`runner-protocol.ts`「累積なら再送に耐える」）
   *
   * **読み取りそのものは `usage.ts` の `readSessionUsage` が持つ。** クローン層の
   * `clone.ts` の `#flushSessionUsage` が同じものを呼ぶ。**層ごとに書き分けない**
   * —— 片方だけが直っている状態は、直っていない側の欠落を「使っていない」と
   * 読ませる（そちらの doc に、なぜ両方要るかを逐語で書いた）。
   */
  async #flushUsage(): Promise<void> {
    const models = await readSessionUsage(this.#query);
    if (models === undefined) return;
    this.#emit({
      type: 'usage',
      managerId: this.#id,
      sessionId: this.#sessionId,
      models,
    });
  }

  /**
   * **`result` を受け取らないまま畳むとき、既に喋られていた本文を報告として出す（#323）。**
   *
   * 報告は `#dispatch` の `message.type === 'result'` の枝でしか作られない。
   * assistant のメッセージは（`stop_reason` が `end_turn` でも）`#said` に
   * 積まれるだけで、畳むのは `result` の到来だけである。**だから `result` が
   * 来ないまま終わる回は、マネージャーが書き終えた本文が丸ごと消えていた** —
   * 生ログ（`manager_transcript`）にだけ残り、台帳にも日誌にもクローンの
   * 受信箱にも1文字も出ない。これは #323 が「生ログには `end_turn` まで在り、
   * `manager_list` の直近の報告にも台帳にも出ない」と書いた症状そのものである。
   *
   * **`result` が来ない回は例外ではない。** `#finish` の doc が逐語で
   * 「ここを通るのはクラッシュ・`lost`・`failed`、つまり `result` が出ない
   * まま終わる経路そのものである」と書いており、`stop()`（器の入れ替えと
   * `manager_stop`）も同じ穴を持つ（あちらは `closed` すら出さない）。
   *
   * **空なら1件も出さない。** 中身の無い報告はクローンのターンを1本焼く
   * （`runner-protocol.ts` の `report.contentless` の doc）。ここは
   * 「積んだ本文が在るときだけ出す」なので、`contentless` は構造上立たない
   * — だからこのイベントに `contentless` は付けない。
   *
   * **畳んでから出す。** 二度呼ばれても二度は出ない（`stop()` の後に
   * `#read` の catch から `#finish` が来る経路が実在する）。
   *
   * **`#rejected`（SDK が「応答ではない」と印を付けた事実）はここでは読まない。**
   * あれはターンの終わり方を言う印で、その確定は `result` が運ぶ。
   * `result` が来ていないこの経路では「失敗として終わった」と名乗れない
   * ——名乗れないものを名乗らない（`AGENTS.md`「取れない軸に0の行を作る」）。
   */
  #flushUnreported(reason: string, status: JobStatus): void {
    if (this.#said.length === 0) return;
    const said = this.#said;
    this.#said = [];
    const reportId = this.#saidUuid;
    this.#saidUuid = undefined;
    this.#emit({
      type: 'report',
      managerId: this.#id,
      // 無ければ付けない。デーモン側は `reportId` の無い report を「冪等化を
      // 諦める」経路で受ける（`manager.ts` の `case 'report':`）——捨てはしない。
      ...(reportId === undefined ? {} : { reportId }),
      text: unreportedText(said, reason),
      status,
    });
  }

  /**
   * `selfFenced` は `RunnerSession#selfFence` からだけ渡す。
   *
   * **他の呼び出し元（resume 不能・クラッシュ）は渡さない**——渡さなければ
   * `runnerEventSchema` の `closed.selfFenced` は既定で undefined になり、
   * デーモン側の判定（自己失効なら `lease` だけ返す）は自己失効の1経路にしか
   * 効かない（`runner-protocol.ts` の `closed` の doc）。
   */
  async #finish(
    status: JobStatus,
    reason: string,
    options: { selfFenced?: true } = {},
  ): Promise<void> {
    this.#stopped = true;
    // **量をここで1行にまとめる。終わり口はここだけではない（Issue #393）。**
    // もう1本は `stop()`（器の入れ替えと `manager_stop` が通る道）で、**あちらは
    // ここを通らない** —— だから同じ呼び出しが両方に在る（`stop()` の中の
    // `#closeWorkerWaitWindow` の隣に、同じ理由で並べてある）。
    //
    // **片方だけにすると、存在は残るが量だけが失われる。** 初出の1行は経路に
    // 関係なく出るので、**落ちていることに気づく手がかりが出力に無い。**
    // 数え上げの持ち主は `noteUnclassifiedFailuresSummary` の doc に在り、
    // そこは「すべての終わり口」ではなく現物の2本を名指ししている。
    noteUnclassifiedFailuresSummary(this.#unclassifiedFailures, this.#id);
    // **`close()` より先に読む。** 閉じた後の control channel からは何も取れない。
    // ここを通るのはクラッシュ・`lost`・`failed`、つまり `result` が出ないまま
    // 終わる経路そのものである。
    await this.#flushUsage();
    // **取りこぼしを作らない。** window が開いたまま（か閉じ待ちのまま）
    // 畳まれるなら降ろしてから閉じる。`settled` は渡さない — その時点の
    // `#openTasks` から導く（`#closeWorkerWaitWindow` の doc）。委譲した全員
    // から通知を受け切っていたのに `result` が来ないまま閉じた回は
    // `settled: true` になる（`turns` が最後の1回を含まないだけである）。
    this.#closeWorkerWaitWindow();
    this.#settleAll(reason);
    // 読み取りが終わっても入力側を起こして本体を閉じる。怠ると閉じられない
    // Query と起きない `#inputStream` が残る。
    this.#wakeInput();
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
    this.#status = status;
    await this.#shipArchive();
    // **生ログに在る本文を、報告としても渡してから閉じる（#323）。**
    // `#shipArchive()` の後に置いてあるのは、この報告を読んだクローンが
    // すぐ `manager_transcript` で裏を取れるようにするためである。
    this.#flushUnreported(reason, status);
    this.#emit({
      type: 'closed',
      managerId: this.#id,
      status,
      reason,
      ...(options.selfFenced === undefined ? {} : { selfFenced: options.selfFenced }),
    });
    this.#onClosed();
  }

  // -------------------------------------------------------------------------
  // 配線 — マネージャーから見た「ユーザー」はクローン
  // -------------------------------------------------------------------------

  /**
   * 許可確認と `AskUserQuestion` をデーモン（＝クローン）へ回す。
   *
   * ここは追加の関門ではない。人間が画面越しに受け取っていた確認が、そのまま
   * クローンへ届くだけである。だから待ち時間に上限を置かない — 止まるのはこの
   * 1件だけで、他は走り続ける。
   *
   * **`permissionMode` が `auto` でもこの配線は外さない。** SDK が確認を降ろして
   * きたとき（`AskUserQuestion` を含む）の行き先はここ1本である。
   */
  async #onPermission(
    toolName: string,
    input: Record<string, unknown>,
    extra: { signal: AbortSignal; requestId?: string; toolUseID?: string },
  ): Promise<PermissionResult> {
    // 確認を出せている＝セッションは開いて手を動かしている。
    this.#markProgressed();
    // SDK は同じ確認を再送しうる。id を SDK 側の識別子に揃えて、再送では新しい
    // 待ちを積まずに同じ結果を返す（二重に消費されると片方が永久に返らない）。
    const id = extra.requestId ?? extra.toolUseID ?? randomUUID();
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;
    // **解けた後の再送も同じ扱いにする。** ここを `#pending` だけで見ていたのが
    // 「答えたのに待っていないと言われる」の原因だった（`#resolved` の注記）。
    const resolved = this.#resolved.get(id);
    if (resolved !== undefined) return resolved;

    const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
    const summary =
      kind === 'question' ? describeQuestions(input) : `${toolName} の実行許可: ${brief(input)}`;
    // **ここで1度だけ取る（#334）。** `state()` も `ask` イベントもこの値を
    // そのまま運ぶだけにする——経路ごとに取り直すと、同じ確認が経路によって
    // 違う「待ち始めた時刻」を名乗る。
    const askedAt = new Date().toISOString();

    let settle!: PendingRequest['settle'];
    const answered = new Promise<{ message: string; decision?: 'allow' | 'deny' }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      // **`decideAnswer` が決定の唯一の実装である（#322）。** `Session#answer()`
      // が同じ関数を同じ引数（`kind` / `decision` / `message`）で呼んでいるので、
      // クローンへ即座に返す値（`Pool#send` の `answered.decision`）と、SDK へ
      // 実際に返る `behavior` は常に同じ計算から出る。
      const decision = decideAnswer(kind, answer.decision, answer.message);
      const outcome: PermissionResult =
        decision === 'deny'
          ? { behavior: 'deny', message: answer.message }
          : kind === 'question'
            ? { behavior: 'allow', updatedInput: withAnswers(input, answer.message) }
            : { behavior: 'allow' };
      // **解けたことを覚えるのはここ1箇所。** 回答でも中断でも停止でも、解けた
      // 事実は同じように残る（経路ごとに覚え忘れる隙を作らない）。
      this.#resolved.set(id, outcome);
      return outcome;
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      summary,
      askedAt,
      result,
      // **待ち行列から自分を外すのは settle の責任**。呼び出し側任せにすると、
      // 中断で解けた1件が行列に残り、次に届いた言葉を食い潰す。
      settle: (value) => {
        if (done) return;
        done = true;
        unlisten();
        const at = this.#pending.indexOf(request);
        if (at !== -1) this.#pending.splice(at, 1);
        if (this.#status === 'waiting_human' && this.#pending.length === 0) {
          this.#status = 'running';
        }
        this.#emit({ type: 'settled', managerId: this.#id, requestId: id });
        settle(value);
      },
    };

    this.#pending.push(request);
    this.#status = 'waiting_human';

    // マネージャー側で中断されたら宙吊りにしない。
    const onAbort = () =>
      request.settle({ message: 'マネージャー側で中断された。', decision: 'deny' });
    if (extra.signal.aborted) {
      onAbort();
    } else {
      extra.signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => extra.signal.removeEventListener('abort', onAbort);
    }

    this.#emit({ type: 'ask', managerId: this.#id, requestId: id, kind, summary, askedAt });

    return result;
  }

  /**
   * マネージャーと作業者の全ツール実行をデーモンの日誌へ（監査）。
   *
   * **併せて、背景タスクの所有者を控える**（#570。`#backgroundTaskOwners`）。
   * ここでしか取れない —— `SubagentStop` の `background_tasks[]` に所有者の欄が
   * 無く、作業者の生ログ側にも構造化された形では出ないためである（実測: 生ログ
   * に出るのは `Command running in background with ID: …` という**自由文**だけ）。
   */
  async #onPostToolUse(input: unknown): Promise<{ continue: true }> {
    const hook = input as {
      tool_name?: string;
      tool_input?: unknown;
      tool_response?: unknown;
      transcript_path?: string;
      agent_id?: string;
      agent_type?: string;
    };

    if (typeof hook.transcript_path === 'string') this.#transcriptPath = hook.transcript_path;
    // 道具が動いた＝このセッションは生きている（生ログからの作り直しはもうしない）。
    this.#markProgressed();

    // **`worker_wait.toolless` の材料。** マネージャー自身の道具だけを数える
    // （`hook.agent_id` が付いているものは作業者の分なので混ぜない）。
    if (hook.agent_id === undefined) this.#toolsSinceResult += 1;

    this.#emit({
      type: 'tool_use',
      managerId: this.#id,
      actor:
        hook.agent_id === undefined
          ? `manager:${this.#id}`
          : `worker:${this.#id}:${hook.agent_type ?? WORKER_AGENT_NAME}`,
      tool: hook.tool_name ?? '(不明)',
      input: hook.tool_input,
    });

    this.#recordBackgroundTaskOwner(hook.tool_response, hook.agent_id);

    return { continue: true };
  }

  /**
   * 背景タスクを起こした主体を控える（#570。`#onPostToolUse` から呼ぶ）。
   *
   * **実測（SDK 0.3.247。`out8/hooks.jsonl` の逐語）:**
   *
   * ```
   * PostToolUse  agent_id=aa070833e2cf03a72  tool_name=Bash
   *              tool_response={… "backgroundTaskId":"b4kk5s3qh"}
   * SubagentStop agent_id=aa070833e2cf03a72
   *              background_tasks=[…, {"id":"b4kk5s3qh","type":"shell", …}]
   * ```
   *
   * ⟹ **`tool_response.backgroundTaskId` と `background_tasks[].id` は同じ値**
   * であり、同じ入力に `agent_id` が在る。これが所有者を引ける唯一の経路である。
   *
   * **入力は防御的に読む。** `tool_response` の形は SDK 側の都合で変わりうるので、
   * 文字列の `backgroundTaskId` が在るときだけ控える（無ければ何もしない）。
   */
  #recordBackgroundTaskOwner(toolResponse: unknown, agentId: string | undefined): void {
    if (typeof toolResponse !== 'object' || toolResponse === null) return;
    const taskId = (toolResponse as { backgroundTaskId?: unknown }).backgroundTaskId;
    if (typeof taskId !== 'string' || taskId.length === 0) return;

    // マネージャー自身の分は空文字で控える（「引けなかった」と混ぜないため）。
    this.#backgroundTaskOwners.set(taskId, agentId ?? '');

    // 上限を超えたら古い側から捨てる（理由は `BACKGROUND_TASK_OWNER_LIMIT`）。
    while (this.#backgroundTaskOwners.size > BACKGROUND_TASK_OWNER_LIMIT) {
      const oldest = this.#backgroundTaskOwners.keys().next();
      if (oldest.done === true) break;
      this.#backgroundTaskOwners.delete(oldest.value);
    }
  }

  /**
   * ターンの開始を数える（`worker_wait`）。**観測専用。** `{ continue: true }`
   * を返すだけで、何もブロックしない（ブロックすれば能力の削除になる）。
   *
   * **なぜこの hook を足すのか。** `result` が SDK 側の自己継続ターンごとに
   * 必ず来るのかは、手元の環境では確認できない。`UserPromptSubmit` はターンの
   * 開始ごとに発火するので、`submits`（ここで数える）と `turns`（`result` の
   * 回数）が食い違えば、それ自体が「`result` は自己継続ターンごとに出るのか」
   * という未解決の問いへの答えになる — どちらの仮説でも読める観測にしてある。
   *
   * `hook.agent_id === undefined` のときだけ数える（`#onPostToolUse` と同じ
   * 判定。作業者の分を混ぜない）。
   */
  async #onUserPromptSubmit(input: unknown): Promise<{ continue: true }> {
    const hook = input as { agent_id?: string; source?: unknown };
    if (hook.agent_id === undefined) {
      this.#submitsSinceResult += 1;
      // **取れた分だけ載せる。** SDK の JSDoc
      // （`UserPromptSubmitHookInput.source`）曰く、この値は「system = 他の
      // 機械が起こしたターン（peer/channel messages・task notifications・
      // auto-continuation）」等を表す。**取れる見込みは 0.3.239 で変わった**
      // （「外部のペイロードには付かない」→「付かないこともある」。経緯と、
      // それでも割れない問いは `#submitSources` の doc）。取れない回に
      // `'unknown': 1` のような行を作らない（AGENTS.md 地雷「取れない軸に0の
      // 行を作る」）。
      if (typeof hook.source === 'string') {
        this.#submitSources.set(hook.source, (this.#submitSources.get(hook.source) ?? 0) + 1);
      }
    }
    return { continue: true };
  }

  /**
   * 作業者セッションが停止した瞬間に、追跡中の背景処理の在り高を記録する
   * （#357 — 作業者が「バックグラウンド処理の完了通知を待つ」形でターンを
   * 閉じて空転する症状の実測口）。**観測専用。** `{ continue: true }` を返す
   * だけで、何もブロックしない・`decision` も `additionalContext` も返さない
   * （ブロックすれば能力の削除になる。挙動を変えないのが今回の判断である）。
   *
   * **`note` イベントに乗せる。** `runner-protocol.ts` の欄は増やさない —
   * デーモンと runner は別々にデプロイされるので、runner が新しく名乗る値を
   * 足すと古い runner が居る窓が開く。`note` は既存の口で、`manager.ts` の
   * `case 'note'` が日誌にだけ残し受信箱へは出さないので、雑音にもならない。
   *
   * ## ⚠️ `background_tasks` が非空であることは、空転の署名では **ない**
   *
   * ここは元々「非空＝作業者が背景処理を待って畳んだ署名」として書かれていた。
   * **実測（SDK 0.3.247。#570 に生 JSON が在る）で反証された:**
   *
   * 1. **畳もうとしている当人が必ず配列に入る**（`id` = `agent_id` /
   *    `type=subagent` / `status=running`）⟹ 発火4回すべてで非空だった。
   *    ⟹ 「空なら最初の1回だけ記録する」という枝には**到達しない**
   * 2. **兄弟の作業者も入る** — 道具を1つも使わない作業者の配列に、走っている
   *    別の作業者が載った ⟹ 件数では「この作業者が待っている」が言えない
   * 3. **`BackgroundTaskSummary` に所有者の欄が無い**（`id` / `type` / `status` /
   *    `description` / `command?` / `agent_type?` / `server?` / `tool?` / `name?`）
   *
   * ⟹ **だから絞る。** 所有者は `#onPostToolUse` が控えている
   * （`#recordBackgroundTaskOwner`。`tool_response.backgroundTaskId` と
   * `background_tasks[].id` が同じ値であることは実測済み）。
   *
   * **`note` を出す条件は2つ:**
   * 1. **当人が起こした背景処理が1件以上残っているとき** — それだけを載せる。
   *    セッション全体の在庫の件数も併記する（生の値を隠さないため）
   * 2. **所有者を引けなかったとき** — 1セッションに1回だけ（`#noteOwnerLookupFailure`）
   *
   * **当人だけ／兄弟だけのときは、何も出さない。** これがこの直しの本体である。
   *
   * ## ⚠️ この `note` が出ないことは「空転が無かった」を意味しない
   *
   * **フックの発火そのものが条件付きである。** 実測では、作業者の完了8件のうち
   * 発火は4件で、**「畳んだ瞬間に親のターンが開いていたか」で8件が8件とも
   * 割れた**（親が先に閉じていた4件は発火していない）。そして委譲は既定で
   * `is_backgrounded: true` なので、**親が先に閉じる形が本番では普通である。**
   * ⟹ 拾えるのは一部である。**同じ断りを `note` の本文にも書いてある**
   * （片方だけ読んだ人が誤らないため）。
   *
   * **入力は防御的に読む**（既存フックと同じく `as` で受けて型を仮定しない）。
   * `text` の組み立てで例外が出ても握り、必ず `{ continue: true }` を返す。
   * `#markProgressed()` などの既存の副作用は呼ばない（観測専用。挙動を変えない）。
   */
  async #onSubagentStop(input: unknown): Promise<{ continue: true }> {
    try {
      const hook = input as {
        background_tasks?: unknown;
        session_crons?: unknown;
        agent_type?: string;
        agent_id?: string;
      };
      const tasks = Array.isArray(hook.background_tasks) ? hook.background_tasks : [];
      const crons = Array.isArray(hook.session_crons) ? hook.session_crons : [];
      const agentId = hook.agent_id;

      // **当人が起こしたものだけを残す。** `id` が表に在り、その所有者が
      // いま畳もうとしている作業者と一致するものだけを数える。
      const mine = tasks.filter((task) => {
        const id = (task as { id?: unknown }).id;
        if (typeof id !== 'string' || agentId === undefined) return false;
        return this.#backgroundTaskOwners.get(id) === agentId;
      });

      if (mine.length === 0) {
        this.#noteOwnerLookupFailure(tasks);
        return { continue: true };
      }

      const lines: string[] = [
        `SubagentStop（作業者: ${hook.agent_type ?? '(不明)'} / agent_id=${agentId ?? '(不明)'}）: ` +
          `**この作業者が自分で起こした背景処理が ${mine.length}件 残ったまま畳んだ**` +
          `（この瞬間のセッション全体の在庫=${tasks.length}件、session_crons=${crons.length}件）。` +
          '⚠️ この行が出ないことは「空転が無かった」を意味しない — ' +
          'このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。',
      ];
      for (const task of mine) {
        const t = task as {
          type?: unknown;
          status?: unknown;
          description?: unknown;
          // `command` は shell タスクにしか付かない任意欄で、SDK 側で既に
          // 1000文字に切ってある（`BackgroundTaskSummary.command` の doc）。
          // ここで載せるのは「作業者が待っていた背景処理の中身」を突き合わせる
          // のに command が最も効くためで、全体の上限（下）で二重に守る。
          command?: unknown;
        };
        const type = typeof t.type === 'string' ? t.type : '(不明)';
        const status = typeof t.status === 'string' ? t.status : '(不明)';
        const description = typeof t.description === 'string' ? t.description : '(不明)';
        const command = typeof t.command === 'string' ? ` command=${t.command}` : '';
        lines.push(`- type=${type} status=${status} description=${description}${command}`);
      }

      let text = lines.join('\n');
      if (text.length > SUBAGENT_STOP_NOTE_TEXT_LIMIT) {
        text =
          text.slice(0, SUBAGENT_STOP_NOTE_TEXT_LIMIT) +
          `…（上限 ${SUBAGENT_STOP_NOTE_TEXT_LIMIT} 文字で切った）`;
      }

      this.#emit({ type: 'note', managerId: this.#id, text });
    } catch (error: unknown) {
      // 観測専用のフックが例外でセッションを止めてはいけない。記録そのものが
      // 失敗したことだけを、握れる範囲でもう一度 note として上げる。
      try {
        this.#emit({
          type: 'note',
          managerId: this.#id,
          text: `SubagentStop の観測に失敗した: ${String(error)}`,
        });
      } catch {
        // ここまで失敗したら、もう上げる手段が無い。観測専用なので黙って諦める
        // （挙動は変えない＝必ず continue: true を返すことのほうを優先する）。
      }
    }

    return { continue: true };
  }

  /**
   * 「所有者を引く経路が壊れた」ことだけを、1セッションに1回だけ日誌へ出す
   * （#570）。**観測専用。**
   *
   * **これが要る理由 — 直した観測口は、壊れると *無音* になるからである。**
   * `#onSubagentStop` は「当人が起こした背景処理」が1件も無ければ何も出さない。
   * ⟹ 表が引けなくなった状態（SDK が `backgroundTaskId` を改名した・上限で
   * 捨てた・経路が変わった）と、「作業者はきれいに畳んだ」が、日誌の上で同じ
   * 顔になる。**その2つを分けるためだけの1行である。**
   *
   * 出す条件は「`type` が `subagent` でないエントリのうち、id が表に**1件も**
   * 無いものが在る」。`subagent` を外すのは、委譲そのもの（当人・兄弟）は
   * `PostToolUse` の `backgroundTaskId` を持たないので、表に無いのが正常だから
   * である。
   */
  #noteOwnerLookupFailure(tasks: readonly unknown[]): void {
    if (this.#ownerLookupFailureNoted) return;

    const orphans = tasks.filter((task) => {
      const t = task as { id?: unknown; type?: unknown };
      if (t.type === 'subagent') return false;
      return typeof t.id !== 'string' || !this.#backgroundTaskOwners.has(t.id);
    });
    if (orphans.length === 0) return;

    this.#ownerLookupFailureNoted = true;
    const listed = orphans
      .map((task) => {
        const t = task as { id?: unknown; type?: unknown };
        const id = typeof t.id === 'string' ? t.id : '(不明)';
        const type = typeof t.type === 'string' ? t.type : '(不明)';
        return `id=${id} type=${type}`;
      })
      .join(' / ');

    this.#emit({
      type: 'note',
      managerId: this.#id,
      text:
        `SubagentStop: 背景処理の**所有者を引けなかった**（${orphans.length}件。${listed}）。` +
        'この行が出たら計器のほうを疑う — ' +
        '`PostToolUse` の `tool_response.backgroundTaskId` が改名・消滅したか、' +
        `表が上限（${BACKGROUND_TASK_OWNER_LIMIT}件）で古い側を捨てたかである。` +
        '⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。' +
        'そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。' +
        '（雑音にしないため、この診断はセッションに1回だけ出す。）',
    });
  }

  /** 要約に潰される前に全文を上げる（監査は日誌＋アーカイブで担保する）。 */
  async #onPreCompact(input: unknown): Promise<{ continue: true }> {
    const { transcript_path: path } = input as { transcript_path?: string };
    if (typeof path === 'string' && path.length > 0) this.#transcriptPath = path;
    await this.#shipArchive();
    return { continue: true };
  }

  /**
   * **「無い」を3つに言い分ける**（`#readTranscript` の doc）。`archive` を
   * emit しないのは3状態とも同じ（`runner-archive-leg.test.ts` の「#shipArchive()
   * は本文が空のとき何も emit しない」が固定している——この歯は残す）。
   *
   * **⚠️ ここで `#emit` を通す形にはしない。** `stop()` 経路は器ごと畳まれる
   * 最中で、この outbox（`RunnerHost` から先）は失われうる（#629 が示した
   * とおり）。加えて `runner-archive-leg.test.ts` は「`transcript_path` を
   * 一度も渡さない ⟹ `archive` が emit されない」を固定しており、ここで
   * `archive` を出す形に変えるとその歯を割る。stderr（`dropped-record.ts`）へ
   * 出す。
   *
   * **本文が0文字（`ok` かつ空文字列）は正常として扱い、跡を出さない。**
   * 「何も書かれていないセッション」は次の一手が要らない状態であって、
   * 計器やディスクを疑わせる2状態（`no-path` / `unreadable`）と同列に鳴らすと
   * 雑音になる（PR 本文にこの判断の理由を書く）。
   */
  async #shipArchive(): Promise<void> {
    const result = await this.#readTranscript();
    if (result.status === 'no-path') {
      noteMissingRecordSource('生ログ', `managerId=${this.#id} transcript_path`);
      return;
    }
    if (result.status === 'unreadable') {
      noteUnreadableRecord('生ログ', `managerId=${this.#id}`, result.error);
      return;
    }
    if (result.body.length === 0) return;
    this.#emit({ type: 'archive', managerId: this.#id, body: result.body });
  }

  /** 待たせたまま消えない。止まっている確認は理由付きで全部解く。 */
  #settleAll(reason: string): void {
    for (const request of [...this.#pending]) {
      request.settle({ message: reason, decision: 'deny' });
    }
    this.#pending.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 引き継ぎに載せる生ログの上限（文字）。溢れたら**古い側**を落とす。 */
const HANDOFF_LOG_LIMIT = 12_000;

/**
 * 預かった生ログを、新しいセッションへ渡せる文章に均す。
 *
 * SDK の生ログの形（`{ type, message: { role, content } }`）に強く依存しない。
 * 読めた分だけ返し、1行も読めなければ `null`（＝引き継ぎの材料が無い）と答える。
 */
export function renderSessionLog(
  entries: readonly unknown[] | undefined,
  limit = HANDOFF_LOG_LIMIT,
): string | null {
  if (entries === undefined || entries.length === 0) return null;
  const lines = entries
    .map((entry) => renderLogEntry(entry))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  const text = lines.join('\n');
  // 溢れたら**末尾を残す**。直前に何をしていたかのほうが、続きには効く。
  return text.length > limit ? `（前略）\n${text.slice(text.length - limit)}` : text;
}

function renderLogEntry(entry: unknown): string | null {
  const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  const role =
    typeof record.message?.role === 'string'
      ? record.message.role
      : typeof record.type === 'string'
        ? record.type
        : null;
  if (role === null) return null;

  const content = record.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => renderContentPart(part))
            .filter((part) => part.length > 0)
            .join('\n')
        : '';
  return text.length === 0 ? null : `${role}: ${text}`;
}

function renderContentPart(part: unknown): string {
  const block = part as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'tool_use') return `[${String(block.name ?? '道具')} ${brief(block.input)}]`;
  return '';
}

/**
 * 生ログから作り直すときに、新しいセッションの先頭へ置く一言。
 *
 * **失敗を伏せない。** 「前のセッションには戻れていない」ことをマネージャー自身に
 * 伝えないと、記憶にあるはずの文脈を前提に話し始めて、噛み合わないまま進む。
 */
function handoffPrompt(input: {
  sessionId: string;
  reason: string;
  record: string;
  carried: readonly string[];
}): string {
  return [
    `[system] 前のセッション（${input.sessionId}）を開き直せなかった: ${input.reason}`,
    'このセッションは前の続きではない。以下は失われたセッションの記録である。' +
      'ここから状況を組み立て直して、作業の続きを進めよ。',
    '作業ディレクトリの状態は記録と食い違っているかもしれない。' +
      '同じ結果を期待せず、手元を確かめてから動くこと。',
    '--- 失われたセッションの記録（ここから） ---',
    input.record,
    '--- 失われたセッションの記録（ここまで） ---',
    ...input.carried,
  ].join('\n');
}

/**
 * 応答の本文ブロックを、出た順につないで取り出す。
 *
 * **`clone.ts` の同名の写しとは繋ぎ方が違う**（あちらはそのまま繋ぐだけで trim も
 * しない）。揃えていないのは、繋ぎ方が報告と表示の作法＝層の側の判断だからである。
 */
function assistantText(blocks: readonly AgentContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * `awaitingBackground.breakdown`（`taskType` ごとの内訳）を組み立てる。
 *
 * **診断用の写しであって判定には使わない**（`runner-protocol.ts` の
 * `report.awaitingBackground` の doc）。`Map` の挿入順（＝最初に現れた順）で
 * 並べる——ソートし直さないのは、届いた `tasks` の並び自体に意味を持たせない
 * ため（不変な基準を作らない。ソートすれば「同じ内訳なのに順序が変わる」を
 * 心配する必要が無くなる、という程度の理由でしかない）。
 */
function summarizeBackgroundTasks(tasks: readonly { id: string; taskType: string }[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.taskType, (counts.get(task.taskType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([taskType, count]) => `${taskType}×${String(count)}`)
    .join(', ');
}

/**
 * 1ターン分の報告を組み立てる。
 *
 * 出た順につなぐ（人間が画面で読んだ順である）。`result` は多くの場合その
 * 最後の一片なので既に含まれるが、**含まれていないなら落とさずに足す** —
 * エラー終了の `（結果なしで終了: …）` のように、本文には出ないまま結果だけが
 * 来ることがあり、そこを黙って捨てると終わり方が分からなくなる。
 *
 * **`contentless` は「クローンを起こしてよいか」を運ぶ構造化された印であって、
 * 文言の判定ではない。** `result.empty` は `resultText()` が「SDK 自身の
 * `result` にも文字が無かった」と確定させた事実で、ここではそれに
 * `said`（そのターンでマネージャーが実際に喋った本文）が空だったかどうかを
 * 掛け合わせるだけである。**`（報告なし）` という文字列に一致させていない** —
 * だからマネージャーが本文として本当に `（報告なし）` と書いた回は、
 * `body` が非空になるので `contentless: false` のまま素通りする
 * （`sdk-failure.ts` の「文言で検知しない」を報告の畳み込みにも揃えた形）。
 */
function reportText(
  said: readonly string[],
  result: { text: string; empty: boolean },
): { text: string; contentless: boolean } {
  const body = said.join('\n\n').trim();
  if (body.length === 0) return { text: result.text, contentless: result.empty };
  if (body.includes(result.text.trim())) return { text: body, contentless: false };
  return { text: `${body}\n\n${result.text}`, contentless: false };
}

/**
 * `result` を受け取らないまま畳まれた回の報告本文（#323）。
 *
 * **先頭で「畳まれた」と言い切る。** `failedReportText` と同じ作法である
 * ——これを付けないと、読み手（クローン・台帳・日誌）には通常の報告と
 * 区別が付かず、**ターンの途中で切られた本文を「マネージャーの結論」として
 * 読むことになる。**
 *
 * **本文は言い換えず、そのまま全部載せる。** 途中まででも、マネージャーが
 * 何を書いていたかは次に何を頼み直すかを決める材料である
 * （`failedReportText` の「途中まで出ていた本文も捨てない」と同じ理由）。
 */
function unreportedText(said: readonly string[], reason: string): string {
  const body = said.join('\n\n').trim();
  return (
    `（このターンは結果を受け取らないまま畳まれた: ${reason}）\n` +
    `（以下は畳まれる前にマネージャーが書いていた本文である。ターンの途中の発言が混ざっていることがある）\n\n` +
    body
  );
}

/**
 * 失敗で終わったターンの報告本文。
 *
 * **本文の先頭で「応答ではない」と言い切る。** 直す前は成否によらず
 * `reportText` を通していたので、支出上限の英語文言が「マネージャーの報告」
 * としてそのまま台帳と日誌とクローンの受信箱へ入った。
 *
 * **SDK の文言は言い換えず、そのまま残す**（`usage-limits.ts` の約束と同じ。
 * 人間が検索できる形で残す）。**途中まで出ていた本文も捨てない** — 上限に
 * 当たるまでに何をやったかは、次に何を頼み直すかを決める材料である。
 */
function failedReportText(said: readonly string[], failure: SdkFailure, result: string): string {
  const body = failure.text.length > 0 ? failure.text : result;
  const head = `（このターンは応答を返さずに終わった: ${failure.code} / ${failure.via}）\n${body}`;
  const partial = said.join('\n\n').trim();
  return partial.length === 0 ? head : `${head}\n\n（失敗する前に出ていた本文）\n${partial}`;
}

/**
 * SDK の `result` から本文を取り出す。
 *
 * **`empty` は「文字が1つも無かった」という構造的な事実であって、
 * 返す文字列（`（報告なし）` 等）そのものではない。** `reportText()` が
 * `contentless` を組み立てるときに見るのはこの `empty` だけで、返り値の
 * `text` は出力にそのまま使われる従来どおりの文言である
 * （`AGENTS.md`「テストが書けない構造は、テストが無いのと同じ」への対応 —
 * 文字列を変えずに構造だけを添える）。
 */
function resultTextOf(event: AgentTurnEnded): { text: string; empty: boolean } {
  if (event.body.length > 0) return { text: event.body, empty: false };
  if (event.outcome !== undefined)
    return { text: `（結果なしで終了: ${event.outcome}）`, empty: false };
  return { text: '（報告なし）', empty: true };
}

/** `AskUserQuestion` の回答は「質問文 → 回答」の対応で返す（SDK の入力形）。 */
function withAnswers(input: Record<string, unknown>, message: string): Record<string, unknown> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const text = (question as { question?: unknown }).question;
    if (typeof text === 'string') answers[text] = message;
  }
  return { ...input, answers };
}

function describeQuestions(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const texts = questions
    .map((question) => (question as { question?: unknown }).question)
    .filter((text): text is string => typeof text === 'string');
  return texts.length > 0 ? texts.join(' / ') : brief(input);
}

/** 否定として読み取る語。日本語は語境界が無いので素直に部分一致で見る。 */
const DENIAL_PHRASES = [
  'やめ',
  'だめ',
  '駄目',
  '不可',
  '中止',
  '却下',
  'しないで',
  '止めて',
  '待って',
  '許可しない',
  '承認しない',
];

/** 英語側は語境界で見る（`nothing` の `no` を否定と読まないため）。 */
const DENIAL_WORDS = /\b(deny|denied|no|nope|don't|do not|stop|cancel)\b/i;

/**
 * `decision` を付け忘れた回答の読み取り。
 *
 * 迷ったら通さない — ではなく、**否定が読み取れたときだけ拒否**する。ここで
 * 保守的に倒すと、クローンが承認したつもりの仕事が黙って止まる（デグレード）。
 *
 * 日本語を語境界（`\s` や `\b`）で探してはいけない。「それはやめて」の「やめ」の
 * 前に区切りは無く、探せていないことが**承認**として表に出る。
 */
export function inferDecision(message: string): 'allow' | 'deny' {
  if (DENIAL_PHRASES.some((phrase) => message.includes(phrase))) return 'deny';
  return DENIAL_WORDS.test(message) ? 'deny' : 'allow';
}

/**
 * 確認の最終的な決定を計算する、**唯一の実装**（#322）。
 *
 * `Session#answer()`（クローンへ即座に返す値）と `#onPermission` の
 * `answered.then()`（SDK へ実際に返す `PermissionResult` を組み立てる側）の
 * **両方がこの関数を呼ぶ。** 式を2箇所に書くと、Issue #322 が候補2
 * （`manager.ts` で `inferDecision` を呼び直す）を却下した理由と同じ形の穴に
 * なる——場所を `runner.ts` の中に留めても、実装が2つあれば「runner.ts 側が
 * 変わったときに黙ってずれる」は再現する。
 *
 * - `AskUserQuestion`（`kind === 'question'`）は **decision を一切見ず常に
 *   allow**（既存の挙動そのまま。質問への回答に allow/deny という概念が無い）
 * - それ以外（`kind === 'permission'`）は明示の `decision` を優先し、
 *   無ければ `inferDecision(message)` に倒す
 */
export function decideAnswer(
  kind: 'question' | 'permission',
  decision: 'allow' | 'deny' | undefined,
  message: string,
): 'allow' | 'deny' {
  if (kind === 'question') return 'allow';
  return decision ?? inferDecision(message);
}

/**
 * 文字列を短い16進へ畳む。**中身を復元できない形にするためだけに使う。**
 *
 * 暗号としての強度が要る場所ではない（署名でも認証でもない）。要るのは
 * 「同じ文字列は同じ鍵になる」ことと、「鍵を見ても元の文字列が読めない」ことの
 * 2つだけである。前者が重複排除を保ち、後者が `onForget` の日誌行から本文を
 * 締め出す（`#noteDenial` の `toolUseId` の doc）。
 */
function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function brief(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 子プロセスを別 UID で起こす。
 *
 * `HOME` を差し替えるのは、root の home のまま降ろすと設定を書けずに落ちるから
 * である。**能力を削るのではなく、走らせる主体を変えているだけ**であることに注意。
 *
 * SDK の子プロセスとプロファイルの評価で共有している。評価だけ root で走らせると、
 * **降りた先では読めないプロファイルを「置けた」と報告する**ことになる。
 */
function spawnAsUser(
  user: RunnerChildUser,
  options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  },
) {
  return spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...options.env,
      ...(user.home === undefined ? {} : { HOME: user.home }),
    },
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    uid: user.uid,
    gid: user.gid,
  });
}
