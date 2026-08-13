import { z } from 'zod';

import { jobStatusSchema } from './schema.js';

/**
 * デーモン ↔ manager-runner の境界（roadmap M4）。
 *
 * **なぜ分けるのか。** マネージャーはデーモンと同じ器で走る限り、`/proc/1/environ`
 * からデーモンの環境変数（＝記憶ストアの接続情報）に届く。ツールを削って塞ぐのは
 * 禁止されている（north_star 禁止2）ので、**実行環境を分ける**。
 *
 * この境界で守っている向きは2つある。
 *
 * - 下向き（デーモン → runner）: 命令だけが降りる。判断は降ろさない。runner は
 *   SDK セッションの start / send / stop / resume と、その出来事の返送しかしない。
 *   権限の一覧も、確認してよいことの表も runner には無い（判断はクローンの仕事）
 * - 上向き（runner → デーモン）: **接続を張るのは常にデーモン側**である。runner は
 *   デーモンの所在も鍵も持たない。持たせた瞬間、runner の中の子プロセス（＝
 *   マネージャー）がその鍵で記憶へ届く経路ができる
 *
 * だからイベントは「デーモンが開いたストリームを runner が流れ落とす」形にしてある。
 * 逆向きのコールバック URL を足さないこと。
 */

/** 1つの確認（許可確認 / 質問）。runner 側で1件だけが返事を待って止まる。 */
export const runnerWaitingSchema = z.object({
  requestId: z.string(),
  summary: z.string(),
});

export type RunnerWaiting = z.infer<typeof runnerWaitingSchema>;

/** runner が持っている1セッションの状態。 */
export const runnerManagerStateSchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  cwd: z.string(),
  request: z.string(),
  waiting: z.array(runnerWaitingSchema),
  sessionId: z.string().optional(),
});

export type RunnerManagerState = z.infer<typeof runnerManagerStateSchema>;

// ---------------------------------------------------------------------------
// デーモン → runner（命令）
// ---------------------------------------------------------------------------

export const runnerStartCommandSchema = z.object({
  managerId: z.string().min(1),
  request: z.string().min(1),
  /** 実プロジェクトの作業ディレクトリ（runner から見たパス）。 */
  cwd: z.string().min(1),
});

export type RunnerStartCommand = z.infer<typeof runnerStartCommandSchema>;

/**
 * 中断されたセッションの続きへ戻す。
 *
 * `entries` は生ログそのもの。**runner のディスクに残っている前提を置かない** —
 * 器が作り直されていれば消えているので、デーモンが持っている分を渡して
 * materialize させる（SDK の SessionStore.load がこれを返す）。
 */
export const runnerResumeCommandSchema = z.object({
  managerId: z.string().min(1),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  request: z.string().min(1),
  /** resume 直後に流す一言。省略すると開くだけで手は動かない。 */
  message: z.string().optional(),
  entries: z.array(z.unknown()).optional(),
});

export type RunnerResumeCommand = z.infer<typeof runnerResumeCommandSchema>;

export const runnerMessageCommandSchema = z.object({ text: z.string().min(1) });

/**
 * マネージャーの道具の鍵の差し替え（roadmap M4 の穴埋め）。
 *
 * **なぜ命令として降ろすのか。** 鍵を runner の環境変数で配ると、値は runner の
 * プロセスが起動した瞬間に凍る。人間が鍵を直しても、器を作り直すまで届かない —
 * つまり「鍵を直す」と「走行中の仕事を失う」が同じ操作になる。ここを通せば、
 * 器はそのままで鍵だけが回る。
 *
 * これは判断ではなく事実の伝達である（何を許すかの表ではない）。
 */
export const runnerCredentialSchema = z.object({
  /**
   * 環境変数の名前そのもの。**自由な文字列にしない。**
   *
   * ここを緩くしていたせいで `../../../etc/cron.d/x` のような名前がそのまま
   * ファイル名になり、root で器の外へ書けた。名前は器の中のファイル名になるので、
   * パスとして解釈されうる形を最初から名前として認めない。
   */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z][A-Z0-9_]*$/, '鍵の名前は英大文字・数字・_ のみ'),
  /** 空文字は「鍵を外す」。未設定へ戻す意思を表せるようにしてある。 */
  value: z.string(),
});

export const runnerSetCredentialsCommandSchema = z.object({
  credentials: z.array(runnerCredentialSchema).min(1),
});

export type RunnerSetCredentialsCommand = z.infer<typeof runnerSetCredentialsCommandSchema>;

/** 鍵が合っているかを**値を出さずに**照合するための指紋。 */
export const runnerCredentialFingerprintSchema = z.object({
  name: z.string(),
  /** sha256（16進）の先頭12桁。 */
  sha256: z.string(),
  updatedAt: z.string(),
});

export type RunnerCredentialFingerprint = z.infer<typeof runnerCredentialFingerprintSchema>;

/**
 * 実行環境プロファイル（`.zprofile` 相当）の差し替え。
 *
 * **なぜ命令として降ろすのか。** 鍵と同じ理由である。runner の環境変数として
 * 配ると値は起動時に凍り、人間が直しても器を作り直すまで届かない。加えて、
 * **runner に記憶ストアを読ませない**という境界がある以上、runner が自分で
 * 取りに行くことはできない（M4 受け入れ基準3）。だから降ろす。
 *
 * 中身は解釈しない。**環境変数の一覧を持たない**のがこの口の要点で、名前検査を
 * 足したくなったら、それは `credentials` の口の仕事である。
 */
export const runnerSetProfileCommandSchema = z.object({
  /** シェルスクリプトそのもの。空文字は「プロファイルを外す」。 */
  script: z.string(),
});

export type RunnerSetProfileCommand = z.infer<typeof runnerSetProfileCommandSchema>;

/** 置いてあるプロファイルの同一性。**本文は返さない。** */
export const runnerProfileFingerprintSchema = z.object({
  /** 人間が書いた本文の sha256（16進）先頭12桁。 */
  sha256: z.string(),
  bytes: z.number(),
  updatedAt: z.string(),
});

export type RunnerProfileFingerprint = z.infer<typeof runnerProfileFingerprintSchema>;

/**
 * 差し替えの結果。**「置けた」で終わらせない。**
 *
 * プロファイルは人間が書いたシェルスクリプトなので、構文を間違えれば読み込みが
 * 失敗する。そのまま置くと、以後すべてのコマンドが壊れた環境で走り、原因は
 * どこにも出ない。だから置いた直後に1度評価して、**結果を人間へ返す**。
 */
export const runnerProfileResultSchema = z.object({
  profile: runnerProfileFingerprintSchema.optional(),
  /** 置いたものが実際に読めたか。 */
  ok: z.boolean(),
  /** 読めなかった理由。 */
  error: z.string().optional(),
  /** プロファイルが出した出力（人間が原因を見るための窓）。 */
  output: z.string().optional(),
  /** 評価の結果、実際に増減した環境変数の名前。**値は返さない。** */
  names: z.array(z.string()).optional(),
});

export type RunnerProfileResult = z.infer<typeof runnerProfileResultSchema>;

export const runnerAnswerCommandSchema = z.object({
  requestId: z.string().min(1),
  message: z.string(),
  decision: z.enum(['allow', 'deny']).optional(),
});

export type RunnerAnswerCommand = z.infer<typeof runnerAnswerCommandSchema>;

// ---------------------------------------------------------------------------
// runner → デーモン（出来事）
// ---------------------------------------------------------------------------

/**
 * runner から降りてくる出来事。
 *
 * ここに流れるのは**事実だけ**である。「これは人間に聞くべきか」といった判断は
 * 混ぜない（判断はクローンが記憶を根拠に行う — PRD「権限境界」）。
 */
export const runnerEventSchema = z.discriminatedUnion('type', [
  /** ストリームの先頭。どの runner に繋がったかを名乗る。 */
  z.object({ type: z.literal('hello'), runnerId: z.string() }),
  z.object({ type: z.literal('session'), managerId: z.string(), sessionId: z.string() }),
  /** SDK が生ログを預けるときの scope。生ログを後から引き当てる鍵になる。 */
  z.object({ type: z.literal('project_key'), managerId: z.string(), projectKey: z.string() }),
  z.object({
    type: z.literal('report'),
    managerId: z.string(),
    text: z.string(),
    status: jobStatusSchema,
  }),
  z.object({
    type: z.literal('ask'),
    managerId: z.string(),
    requestId: z.string(),
    kind: z.enum(['question', 'permission']),
    summary: z.string(),
  }),
  /** 確認が解けた（回答・中断・停止）。デーモン側の待ち行列から外す合図。 */
  z.object({ type: z.literal('settled'), managerId: z.string(), requestId: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    managerId: z.string(),
    /** `manager:<id>` / `worker:<id>:<agent>`。 */
    actor: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  /** SDK のセッション生ログ（SessionStore のミラー）。永続化はデーモンが行う。 */
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
  /** compaction 直前・停止時の全文。デーモンがアーカイブへ落とす。 */
  z.object({ type: z.literal('archive'), managerId: z.string(), body: z.string() }),
  z.object({
    type: z.literal('closed'),
    managerId: z.string(),
    status: jobStatusSchema,
    reason: z.string(),
  }),
]);

export type RunnerEvent = z.infer<typeof runnerEventSchema>;

// ---------------------------------------------------------------------------
// 失敗の種別
// ---------------------------------------------------------------------------

/**
 * runner が返した失敗。**status を落とさずに持ち上げる。**
 *
 * 呼ぶ側が「待てば直る（器の入れ替え中・瞬断）」と「待っても直らない（鍵が違う・
 * 命令の形が悪い）」を区別できないと、設定の誤りを再試行で何分も隠すか、逆に
 * 一時的な失敗で仕事を諦めるかのどちらかになる。**この判断は宛先の実装
 * （HTTP かインプロセスか）に依らない**ので、口の定義と同じ場所に置く。
 */
export class RunnerHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RunnerHttpError';
    this.status = status;
  }
}

/**
 * もう一度投げてよい失敗か。
 *
 * **status が分からない失敗は「待てば直る」側に寄せる。** 経路が切れた
 * （`fetch failed`）・器が起き上がりきっていない、はどちらも status を持たない。
 * ここで諦めると、走行中だった仕事が誰にも拾われないまま `running` で残る。
 *
 * 逆に 4xx は runner が「その命令は受け取れない」と答えているので、同じものを
 * 投げ直しても同じ答えが返る（混雑を表す 408 / 429 だけは別）。
 */
export function isRetryableRunnerError(error: unknown): boolean {
  if (!(error instanceof RunnerHttpError)) return true;
  if (error.status === 408 || error.status === 429) return true;
  return error.status >= 500;
}

// ---------------------------------------------------------------------------
// デーモン側から見た runner
// ---------------------------------------------------------------------------

/**
 * runner への口。HTTP でも同一プロセスでも、デーモンはこれしか知らない。
 *
 * **デーモンは特定 runner の実装やローカルパスを前提にしない。** ローカル実行の
 * インプロセス実装も、コンテナ越しの HTTP 実装も、ここでは同じ顔をしている。
 */
export interface RunnerClient {
  /**
   * 安定した識別子。`manager_id → runner_id → session_id → workspace` の鎖を
   * JobStore に残すためのもので、runner が増えたときの宛先になる。
   */
  readonly runnerId: string;
  /** この runner の既定の作業ディレクトリ（workspace locator の path になる）。 */
  readonly workspacePath: string;
  /** イベントの受け取りを始める。**接続を張るのはデーモン側**である。 */
  connect(onEvent: (event: RunnerEvent) => void): Promise<void>;
  start(command: RunnerStartCommand): Promise<void>;
  resume(command: RunnerResumeCommand): Promise<void>;
  send(managerId: string, text: string): Promise<void>;
  /** `false` = その確認は runner 側に無い（既に解けた / 別の宛先）。 */
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean>;
  stop(managerId: string): Promise<void>;
  /** いま runner が抱えているセッション（再接続時の突き合わせに使う）。 */
  list(): Promise<RunnerManagerState[]>;
  /** runner のローカルにある生ログ。無ければ null。 */
  transcript(managerId: string): Promise<string | null>;
  /**
   * いま runner が配っている鍵の指紋。**値は返らない。**
   *
   * 人間が置いた鍵とマネージャーが握っている鍵が同じかどうかは、これが無いと
   * 誰にも見えない。見えないと「付けた」「付いてない」のすれ違いが起きて、
   * 原因が鍵の権限にあるのか経路にあるのかを誰も切り分けられなくなる。
   */
  credentials(): Promise<RunnerCredentialFingerprint[]>;
  /** 鍵を差し替える。器を作り直さずに鍵を回すための口。 */
  setCredentials(
    credentials: RunnerSetCredentialsCommand['credentials'],
  ): Promise<RunnerCredentialFingerprint[]>;
  /** いま runner に置いてある実行環境プロファイルの指紋。**本文は返らない。** */
  profile(): Promise<RunnerProfileFingerprint | undefined>;
  /**
   * 実行環境プロファイルを差し替える。器を作り直さない。
   *
   * **runner が繋ぎ直すたびに降ろし直すこと。** 器が入れ替われば置いたものは
   * 消えるので、降ろし直さないと「再デプロイしたら鍵が消えた」が起きる。
   */
  setProfile(script: string): Promise<RunnerProfileResult>;
  /**
   * 口を閉じる。
   *
   * インプロセス実装では**セッションごと畳む**（同じプロセスが消えるので）。
   * HTTP 実装では**ストリームを閉じるだけ**で、runner の中のマネージャーは
   * 走り続ける — デーモンの再起動で人の仕事を殺さない。
   */
  close(): Promise<void>;
}

/**
 * runner の名簿。デーモンは**固定 URL ではなくここ**を見る。
 *
 * M4 で登録されるのは1台だけだが、間接層をここに置いておかないと、宛先の決定が
 * 呼び出し側に散らばって M5（複数 runner・水平スケール）で全部書き直しになる。
 *
 * **`select` に人工的な上限を入れないこと。** 「同時に何本まで」は能力の削除で
 * あって配置の判断ではない（north_star 禁止2）。将来ここで見てよいのは、runner が
 * 報告する CPU・メモリ・稼働セッション数といった**実行環境の資源**である。
 */
export interface RunnerRegistry {
  list(): Promise<RunnerClient[]>;
  get(runnerId: string): Promise<RunnerClient | null>;
  /** 新しい委譲をどの runner に置くか。M4 では唯一の1台を返す。 */
  select(input: { cwd?: string }): Promise<RunnerClient>;
}

/**
 * 1台だけの名簿（M4 の既定）。
 *
 * 複数渡せる形にしてあるのは、M5 で `select` の中身だけを差し替えられるように
 * するためである。いまは先頭を返す。
 */
export function createRunnerRegistry(runners: RunnerClient[]): RunnerRegistry {
  return {
    async list() {
      return [...runners];
    },
    async get(runnerId) {
      return runners.find((runner) => runner.runnerId === runnerId) ?? null;
    },
    async select() {
      const first = runners[0];
      if (first === undefined) {
        throw new Error(
          'manager-runner が登録されていない（ALTEROID_RUNNER_URL か同一プロセスの runner が要る）',
        );
      }
      return first;
    },
  };
}
