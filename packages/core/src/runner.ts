import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';

import type { CredentialEntry, CredentialFingerprint, CredentialStore } from './credentials.js';
import { createProfileApplier, type ProfileApplier, type ProfileVessel } from './profile.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import type {
  RunnerAnswerCommand,
  RunnerEvent,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerResumeCommand,
  RunnerStartCommand,
} from './runner-protocol.js';
import type { JobStatus } from './schema.js';

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

/** マネージャーのモデル帯。変更には人間の承認が要る（AGENTS.md 地雷5）。 */
export const MANAGER_MODEL = 'opus';

/** 作業者のモデル帯。SDK の既定はマネージャーの継承なので、必ず明示する。 */
export const WORKER_MODEL = 'sonnet';

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
 */
export const MANAGER_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

export type ManagerPermissionMode = (typeof MANAGER_PERMISSION_MODES)[number];

/** 既定の権限モード。ここを `default` に倒すと持ち主が確認で止まり続ける。 */
export const DEFAULT_PERMISSION_MODE: ManagerPermissionMode = 'auto';

/** 権限モードを差し替える環境変数（実行環境の設定であって、能力の制限ではない）。 */
export const PERMISSION_MODE_ENV_KEY = 'ALTEROID_MANAGER_PERMISSION_MODE';

/**
 * `ALTEROID_MANAGER_PERMISSION_MODE` を読む。
 *
 * **不正な値は落とす。** 黙って既定へ倒すと、綴りを間違えた持ち主が「都度確認に
 * したはずなのに確認が来ない」状態に気づけない。
 */
export function resolvePermissionMode(env: NodeJS.ProcessEnv): ManagerPermissionMode {
  const given = env[PERMISSION_MODE_ENV_KEY]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_PERMISSION_MODE;
  if ((MANAGER_PERMISSION_MODES as readonly string[]).includes(given)) {
    return given as ManagerPermissionMode;
  }
  throw new Error(
    `${PERMISSION_MODE_ENV_KEY} の値が不正: ${given}` +
      `（使えるのは ${MANAGER_PERMISSION_MODES.join(' / ')}。既定は ${DEFAULT_PERMISSION_MODE}）`,
  );
}

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
  resume(command: RunnerResumeCommand): Promise<void>;
  send(managerId: string, text: string): Promise<boolean>;
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean>;
  stop(managerId: string): Promise<void>;
  list(): RunnerManagerState[];
  transcript(managerId: string): Promise<string | null>;
  /** 全セッションを畳む。プロセスが消えるときだけ呼ぶ。 */
  shutdown(): Promise<void>;
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
      session.begin(command.request);
    } catch (error) {
      this.#sessions.delete(command.managerId);
      throw error;
    }
  }

  /**
   * 中断されたセッションの続きへ戻す。
   *
   * 既に同じ manager が走っているなら（デーモンだけが再起動した場合）、何もせず
   * 追加の一言だけを流す。**走っているものを resume で作り直さない** — 手を
   * 動かしている最中のマネージャーを二重に起こすことになる。
   */
  async resume(command: RunnerResumeCommand): Promise<void> {
    const alive = this.#sessions.get(command.managerId);
    if (alive) {
      if (command.message !== undefined) alive.push(command.message);
      return;
    }
    const session = this.#create(command.managerId, command.request, command.cwd);
    session.resume(command.sessionId, command.entries, command.message);
  }

  async send(managerId: string, text: string): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    if (!session) return false;
    session.push(text);
    return true;
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean> {
    const session = this.#sessions.get(managerId);
    if (!session) return false;
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
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.stop('runner が停止した。')),
    );
    this.#sessions.clear();
  }
}

/** 返事を待って止まっている1件（許可確認 or 質問）。 */
interface PendingRequest {
  id: string;
  kind: 'question' | 'permission';
  summary: string;
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
  /** resume のために預かった生ログ（SDK の `SessionStore.load` が返す素材）。 */
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
   */
  #progressed = false;
  readonly #inputWaiters = new Set<() => void>();
  #query: Query | null = null;
  #reader: Promise<void> | null = null;
  #status: JobStatus = 'running';
  #sessionId: string | undefined;
  #transcriptPath: string | undefined;
  #stopped = false;

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
      waiting: this.#pending.map((request) => ({
        requestId: request.id,
        summary: request.summary,
      })),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    };
  }

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

  /** 返事の宛先は `requestId` で指す。推測しない（取り違えは拒否を承認に変える）。 */
  answer(answer: RunnerAnswerCommand): boolean {
    const pending = this.#pending.find((request) => request.id === answer.requestId);
    if (!pending) return false;
    pending.settle({
      message: answer.message,
      ...(answer.decision === undefined ? {} : { decision: answer.decision }),
    });
    return true;
  }

  async transcript(): Promise<string | null> {
    const path = this.#transcriptPath;
    if (path === undefined) return null;
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    // 止まる前に全文を返す。runner のディスクは器と一緒に消えるので、ここで
    // 渡し損ねると manager_id から生ログへ降りる経路が切れる。
    await this.#shipArchive();
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

  // -------------------------------------------------------------------------
  // SDK セッション
  // -------------------------------------------------------------------------

  #open(resume?: string): void {
    if (this.#query) return;
    const generation = this.#generation;
    const q = this.#queryFn({ prompt: this.#inputStream(), options: this.#buildOptions(resume) });
    this.#query = q;
    this.#reader = this.#read(q, generation);
  }

  #buildOptions(resume?: string): Options {
    return {
      model: MANAGER_MODEL,
      // `tools` は渡さない = preset 全部。明示リストで絞らない（AGENTS.md 地雷1）。
      // `maxTurns` も渡さない（地雷2）。
      // 人間が開く Claude Code と同じ既定（Auto）。`canUseTool` は下に残してあり、
      // `default` へ戻せば1件ずつクローンへ確認が回る。
      permissionMode: this.#permissionMode,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildManagerSystemPrompt({ managerId: this.#id, workerName: WORKER_AGENT_NAME }),
      },
      // 作業者層の本体はこの1個だけ。`tools` を書かない = 親の全ツールを継承。
      agents: {
        [WORKER_AGENT_NAME]: {
          description:
            'コストと文脈のために切り出した実作業の担い手。実装に限らず、調査・下読み・' +
            '外部サービスの確認・レビュー・相談のたたき台づくりまで任せてよい。',
          prompt: buildWorkerPrompt(),
          model: WORKER_MODEL,
        },
      },
      cwd: this.#cwd,
      // 人間が使っているのと同じ設定・同じ .mcp.json を渡す（下向きは同じものが見える）
      settingSources: ['user', 'project', 'local'],
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
      hooks: {
        PostToolUse: [{ hooks: [(input) => this.#onPostToolUse(input)] }],
        PreCompact: [{ hooks: [(input) => this.#onPreCompact(input)] }],
      },
    };
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
        this.#dispatch(message);
      }
      if (this.#stopped || generation !== this.#generation) return;
      // 一度も手が動かないまま閉じたのなら、resume は効かなかった。
      if (this.#recoverFromFailedResume('セッションが開かないまま閉じた')) return;
      await this.#finish('done', 'マネージャーのセッションが閉じた。');
    } catch (error) {
      if (generation !== this.#generation) return;
      if (!this.#stopped && this.#recoverFromFailedResume(String(error))) return;
      await this.#finish('failed', `マネージャーのセッションが落ちた: ${String(error)}`);
    }
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
   * 戻り値 `true` は「この経路で引き取った」。呼び出し側は `#finish` しない。
   */
  #recoverFromFailedResume(reason: string): boolean {
    const attempt = this.#resumeAttempt;
    if (attempt === null) return false;
    this.#resumeAttempt = null;

    // **手が動いた後の失敗は resume の失敗ではない。** そこで作り直すと、既に
    // 済ませた作業（コミットや PR）を記録から二度走らせることになる。判定は
    // `init` が来たかではなく、**このセッションが何かをしたか**で見る。
    if (this.#progressed) return false;

    const record = renderSessionLog(this.#seed);
    if (record === null) {
      this.#emit({
        type: 'resume_failed',
        managerId: this.#id,
        sessionId: attempt.sessionId,
        reason,
        recovered: false,
      });
      return false;
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
    return true;
  }

  #dispatch(message: SDKMessage): void {
    if (message.type === 'system' && message.subtype === 'init') {
      this.#sessionId = message.session_id;
      this.#emit({ type: 'session', managerId: this.#id, sessionId: message.session_id });
      return;
    }

    if (message.type !== 'result') return;

    // **`init` が来たことは「戻れた」ことではない。** 実機では、開きはしたが
    // その回が `error_during_execution` で何も返さずに終わる形も出ている。
    // 手が動く前の結果なし終了は、この resume が効かなかったということである。
    if (isSuccessResult(message)) this.#progressed = true;
    else if (this.#recoverFromFailedResume(`結果なしで終了: ${resultText(message)}`)) return;

    const text = resultText(message);
    this.#status = this.#pending.length > 0 ? 'waiting_human' : 'done';
    this.#emit({ type: 'report', managerId: this.#id, text, status: this.#status });
  }

  async #finish(status: JobStatus, reason: string): Promise<void> {
    this.#stopped = true;
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
    this.#emit({ type: 'closed', managerId: this.#id, status, reason });
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
    this.#progressed = true;
    // SDK は同じ確認を再送しうる。id を SDK 側の識別子に揃えて、再送では新しい
    // 待ちを積まずに同じ結果を返す（二重に消費されると片方が永久に返らない）。
    const id = extra.requestId ?? extra.toolUseID ?? randomUUID();
    const already = this.#pending.find((request) => request.id === id);
    if (already) return already.result;

    const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
    const summary =
      kind === 'question' ? describeQuestions(input) : `${toolName} の実行許可: ${brief(input)}`;

    let settle!: PendingRequest['settle'];
    const answered = new Promise<{ message: string; decision?: 'allow' | 'deny' }>((resolve) => {
      settle = resolve;
    });

    const result = answered.then((answer) => {
      if (kind === 'question') {
        return { behavior: 'allow' as const, updatedInput: withAnswers(input, answer.message) };
      }
      const decision = answer.decision ?? inferDecision(answer.message);
      return decision === 'allow'
        ? { behavior: 'allow' as const }
        : { behavior: 'deny' as const, message: answer.message };
    });

    let done = false;
    let unlisten = () => undefined as void;

    const request: PendingRequest = {
      id,
      kind,
      summary,
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

    this.#emit({ type: 'ask', managerId: this.#id, requestId: id, kind, summary });

    return result;
  }

  /** マネージャーと作業者の全ツール実行をデーモンの日誌へ（監査）。 */
  async #onPostToolUse(input: unknown): Promise<{ continue: true }> {
    const hook = input as {
      tool_name?: string;
      tool_input?: unknown;
      transcript_path?: string;
      agent_id?: string;
      agent_type?: string;
    };

    if (typeof hook.transcript_path === 'string') this.#transcriptPath = hook.transcript_path;
    // 道具が動いた＝このセッションは生きている（生ログからの作り直しはもうしない）。
    this.#progressed = true;

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

    return { continue: true };
  }

  /** 要約に潰される前に全文を上げる（監査は日誌＋アーカイブで担保する）。 */
  async #onPreCompact(input: unknown): Promise<{ continue: true }> {
    const { transcript_path: path } = input as { transcript_path?: string };
    if (typeof path === 'string' && path.length > 0) this.#transcriptPath = path;
    await this.#shipArchive();
    return { continue: true };
  }

  async #shipArchive(): Promise<void> {
    const body = await this.transcript();
    if (body === null || body.length === 0) return;
    this.#emit({ type: 'archive', managerId: this.#id, body });
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

/** 「1ターンを最後まで走り切った」結果か。 */
function isSuccessResult(message: SDKMessage): boolean {
  return (message as { subtype?: unknown }).subtype === 'success';
}

function resultText(message: SDKMessage): string {
  const candidate = message as { result?: unknown; subtype?: string };
  if (typeof candidate.result === 'string' && candidate.result.length > 0) return candidate.result;
  if (candidate.subtype !== undefined && candidate.subtype !== 'success') {
    return `（結果なしで終了: ${candidate.subtype}）`;
  }
  return '（報告なし）';
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
