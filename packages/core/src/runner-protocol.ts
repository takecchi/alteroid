import { z } from 'zod';

import { jobStatusSchema } from './schema.js';
import { rateLimitFactsSchema, usageLimitNoticeSchema } from './usage-limits.js';
import { usageTotalsSchema } from './usage.js';

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
  /**
   * runner の内側で起きた、記録に残すべき事実。
   *
   * マネージャーの発言ではない（`report` と混ぜない）。**runner が何かを落とす
   * ときの口**である — 上限に達して古い記憶を捨てた、といった事実がどこにも
   * 残らないと、後から表に出た異常を誰も原因へ辿れない（黙って落とさない）。
   */
  z.object({ type: z.literal('note'), managerId: z.string(), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    managerId: z.string(),
    /** `manager:<id>` / `worker:<id>:<agent>`。 */
    actor: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  /**
   * SDK が報告した消費量の**累積**（`result.modelUsage` の写し）。
   *
   * **累積のまま降ろす。差分は runner で作らない。** 理由が2つある。
   *
   * - **差分は事実ではなく解釈である。** ここに流すのは事実だけ（このファイルの
   *   冒頭）で、「前回からいくら増えたか」は前回を覚えている側の話である
   * - **累積なら再送に耐える。** 器の入れ替えや瞬断で同じイベントが2回届いても、
   *   受け取った側の増分が 0 になるだけで済む。差分を降ろすと**そのまま二重計上**
   *   になり、しかも数字は増えるだけなので誰も気づけない
   *
   * 台帳へ畳むのはデーモン（`manager.ts` の `#onEvent`）である。runner は記憶
   * ストアの鍵を持たないので、そもそもここでは書けない。
   */
  z.object({
    type: z.literal('usage'),
    managerId: z.string(),
    sessionId: z.string().optional(),
    /** モデル id → その時点の累積。 */
    models: z.record(z.string(), usageTotalsSchema),
  }),
  /**
   * 上限に関する SDK の文言（当たった / 課金枠へ移った / 近づいている / 組織方針）。
   *
   * **文言は言い換えずにそのまま運ぶ。** 人間が検索できる形で残らないと、
   * claude.ai の画面と突き合わせられない。分類だけを添える。
   */
  z.object({
    type: z.literal('usage_notice'),
    managerId: z.string(),
    notice: usageLimitNoticeSchema,
  }),
  /**
   * `rate_limit_event` から読めた枠の事実（アカウント単位）。
   *
   * **ターンを回している間しか届かない。** だから使い捨ての probe による定期観測と
   * 併用する（`usage-snapshot.ts`）。こちらは `status` と
   * `overageDisabledReason` を持っているので、probe では取れないことが分かる。
   */
  z.object({
    type: z.literal('rate_limit'),
    managerId: z.string(),
    facts: rateLimitFactsSchema,
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
  /**
   * 前のセッションを開き直せなかった。
   *
   * **`resume` の応答では表せない。** 命令自体は受理され（HTTP 200）、SDK が
   * 「そんな会話は無い」と答えるのはストリームが開いた後だからである。ここを
   * 事実として降ろさないと、デーモン側は「戻せた」と思ったまま台帳を `running`
   * にし、同じ session_id へ何度でも投げ直す（実機で起きたのはこれ）。
   */
  z.object({
    type: z.literal('resume_failed'),
    managerId: z.string(),
    /** 開き直せなかった session id。 */
    sessionId: z.string(),
    reason: z.string(),
    /**
     * 預かった生ログから新しいセッションで組み立て直せたか。
     *
     * `false` なら**その仕事は止まっている**。黙って引き下がったことにしないため、
     * 成否をイベントの側で持つ（受け取ったデーモンが人間とクローンへ出す）。
     */
    recovered: z.boolean(),
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
 * 名簿に載せる1台。**「開いた接続」ではなく「開き方」を取る。**
 *
 * ここが接続そのものだと、名簿を作る前に runner を開き終える必要があり、
 * デーモンは runner が上がるまで待つことになる（起動時に最大2分待って、その間
 * chat も日誌も承認も止まっていた）。開き方を預かれば、**runner が上がっていなくても
 * 名簿には載せられる** — 開くのは背景の仕事になり、失敗しても名簿の側が挑み直せる。
 */
export interface RunnerSource {
  /**
   * 人間が見る宛先（URL か「同一プロセス」）。
   *
   * **`runnerId` は登録時に要求しない。** 繋がるまで分からないからである
   * （`/health` で runner 自身に名乗らせる）。名簿の中で1台を指す鍵はこの label で、
   * 同じ label を登録し直すのは「その宛先を開き直す」意味になる。
   */
  label: string;
  open: () => Promise<RunnerClient>;
}

/**
 * 名簿から見た1台の様子。**生死と接続状態は別物である。**
 *
 * - `connecting` — いま開いている最中（初回）
 * - `connected` — 開けた。委譲を置ける
 * - `unreachable` — 開けなかったが待てば直る種類の失敗。背景で挑み直している
 * - `unusable` — 挑み直しても同じ答えが返る失敗（鍵違い等）。**挑み直さない**
 */
export type RunnerLiveness = 'connecting' | 'connected' | 'unreachable' | 'unusable';

/**
 * 名簿の1行。**値は返さない**（鍵の指紋と同じ原則で、ここに出るのは状態だけ）。
 *
 * `runnerId` と `workspacePath` が省略されうるのは、**繋がるまで分からない**から
 * である。「登録されているのに繋がっていない」を表せないと、`GET /runners` が
 * 空を返すだけになり、人間には「runner を設定し忘れた」のか「上がってこない」のかが
 * 区別できない。
 */
export interface RunnerEntry {
  label: string;
  state: RunnerLiveness;
  runnerId?: string;
  workspacePath?: string;
  /** 直近の失敗の一行。原因を人間が見るための窓であって、値は載せない。 */
  error?: string;
  /** この状態になった時刻。 */
  since: string;
}

/**
 * runner の名簿。デーモンは**固定 URL ではなくここ**を見る。
 *
 * **動的である**ことがこの層の本体である（roadmap M5）。デーモンは名簿が空のまま
 * 起動してよく、runner は後から載る。載る前に届いた委譲だけが待たされ、chat・日誌・
 * 承認は最初から動く（PRD「自律」— 人間の不在で止まってよいのは承認待ちの仕事だけ）。
 *
 * **`select` に人工的な上限を入れないこと。** 「同時に何本まで」は能力の削除で
 * あって配置の判断ではない（north_star 禁止2）。将来ここで見てよいのは、runner が
 * 報告する CPU・メモリ・稼働セッション数といった**実行環境の資源**である。
 */
export interface RunnerRegistry {
  /** いま開けている runner。**開けていないものは並ばない**（`entries` で見る）。 */
  list(): Promise<RunnerClient[]>;
  get(runnerId: string): Promise<RunnerClient | null>;
  /**
   * 新しい委譲をどの runner に置くか。
   *
   * **必ず返る。** 繋がっていないだけならごく短い猶予のあいだ待つが、それを過ぎたら
   * **分かる形で失敗する** — どの宛先がいまどの状態かを添えて投げる。呼んだ側
   * （クローン）はそれを読んで「少し置いて投げ直す」「人間に知らせる」を選べる。
   *
   * **返らないのは「黙って引き下がる」と同じ欠陥である。** 繋がるまで待つ形にすると、
   * 委譲を呼んだクローンのターンがそのまま張り付き、先に listen した意味が消える
   * （詰まる場所が移るだけになる）。
   *
   * **「常に返す」の意味は、定員で拒まないことである。** 接続がまだ無いことを理由に
   * 失敗するのは定員による拒否ではない。「同時に何本まで」を理由に断ってはいけない
   * （north_star 禁止2）が、宛先が居ないことは隠さずに言う。
   *
   * 失敗は3種類あり、**呼んだ側の対応が変わるので必ず区別する**。
   *
   * - 登録が0台 — 設定の問題。時間では直らない
   * - 登録はあるが、まだどれにも繋がっていない — 時間で解決する可能性がある
   * - 登録が全部 `unusable` — 挑み直さないので、投げ直しても同じ答えが返る
   */
  select(input: { cwd?: string }): Promise<RunnerClient>;
  /**
   * 名簿に載せる。**開き終わるのを待たずに載る。**
   *
   * 最初の1回はここで試す（開ければ戻った時点で使える）が、**失敗しても投げない** —
   * 開けなかったことは名簿の状態になり、待てば直る種類なら背景で挑み直す。
   */
  register(source: RunnerSource): Promise<void>;
  /** 名簿から外す（背景の挑み直しも畳む）。label は `register` に渡したもの。 */
  unregister(label: string): Promise<void>;
  /** 登録されている全部。繋がっていないものも並ぶ（`GET /runners` の材料）。 */
  entries(): RunnerEntry[];
  /**
   * runner が開けたときに呼ばれる。**後から現れた runner に繋ぐための口**である。
   *
   * これが無いと、デーモン側（`ManagerPool`）はイベントの受け口を開く契機を
   * 起動時にしか持てず、後から載った runner の報告も許可確認も永久に届かない。
   */
  subscribe(onOpen: (runner: RunnerClient) => void): () => void;
  /**
   * 背景の挑み直しを畳む。
   *
   * **開いた runner は閉じない。** 閉じる方針は `ManagerPool` が持っている
   * （デーモンの都合で人の仕事を殺さない）。ここで閉じると方針が2箇所に散る。
   */
  stop(): Promise<void>;
}

/** 名簿の外へ出す知らせ（いまは「挑み直しても直らない失敗」だけ）。 */
export interface RunnerRegistryOptions {
  /**
   * 挑み直しても直らないと分かった失敗を、人間とクローンへ知らせる。
   *
   * **黙って挑み続けない。** 鍵違いや命令の形の誤りは待っても直らないので、
   * 背景で無限に叩くと設定の誤りが「なぜか繋がらない」として永久に隠れる。
   */
  notify?: (failure: { label: string; error: string }) => void;
  /** 挑み直しの間隔（倍々で伸びる）。**回数では諦めない。** 主にテスト用。 */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /**
   * `select` が繋がるのを待つ猶予。**主にテスト用で、既定はコードに固定である。**
   *
   * **環境変数の設定項目にしないこと。** 数値をつまみとして外へ出すと、そこが
   * 実質の制限になる（「委譲は N 秒まで」は定員と同じ形をしている）。ここにあるのは
   * 起動直後の数秒をやり過ごすためだけの猶予で、運用でいじる値ではない。
   */
  selectWaitMs?: number;
}

/**
 * 挑み直しの間隔。**これは能力の上限ではなく、混雑を作らないための間隔である。**
 *
 * 上限で頭打ちにするのは、器が長く戻らないときに秒間何度も叩かないためであって、
 * 諦めるためではない（north_star 禁止2 が禁じているのは実行回数の制限である）。
 */
const REGISTRY_RETRY_BASE_MS = 1_000;
const REGISTRY_RETRY_MAX_MS = 30_000;

/**
 * `select` が繋がるのを待つ猶予。**この長さはコードに固定する。**
 *
 * 起動直後は名簿がまだ開いている最中なので、そこで即座に失敗させると使いにくい。
 * かといって待ち続けるのは「黙って引き下がる」と同じ欠陥である（呼んだ側が状況を
 * 知れない）。数秒だけ待って、あとは**状態を添えて失敗する**。
 *
 * **環境変数に出さないこと。** つまみにすると、そこが実質の制限になる。
 */
const SELECT_WAIT_MS = 3_000;

/**
 * 動的な名簿（roadmap M5）。
 *
 * 既に開いてある `RunnerClient` を渡す形も残してある — 既存の呼び出し（テストを
 * 含む）はそのまま動き、渡した分は「常に開ける開き方」として登録される。
 */
export function createRunnerRegistry(
  runners: RunnerClient[] = [],
  options: RunnerRegistryOptions = {},
): RunnerRegistry {
  const registry = new Registry(options);
  for (const runner of runners) registry.adopt(runner);
  return registry;
}

/** 名簿が1台について持つもの。 */
interface RegistryEntry {
  source: RunnerSource;
  state: RunnerLiveness;
  since: string;
  client: RunnerClient | null;
  error?: string;
  /** 開いている最中（**多重に開きに行かない**ための1本）。 */
  opening: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 次に待つ時間。開けたら忘れる。 */
  delay: number;
}

class Registry implements RunnerRegistry {
  readonly #entries = new Map<string, RegistryEntry>();
  readonly #subscribers = new Set<(runner: RunnerClient) => void>();
  /** `select` が繋がるのを待っている分。開けた瞬間に全部起こす。 */
  readonly #waiting = new Set<{
    resolve: (runner: RunnerClient) => void;
    reject: (e: Error) => void;
  }>();
  readonly #notify: ((failure: { label: string; error: string }) => void) | undefined;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #selectWaitMs: number;
  #stopped = false;

  constructor(options: RunnerRegistryOptions) {
    this.#notify = options.notify;
    this.#retryBaseMs = options.retryBaseMs ?? REGISTRY_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxMs ?? REGISTRY_RETRY_MAX_MS;
    this.#selectWaitMs = options.selectWaitMs ?? SELECT_WAIT_MS;
  }

  /** 既に開いてある1台を、開き方として載せる（旧来の呼び出しの受け皿）。 */
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
    });
  }

  async list(): Promise<RunnerClient[]> {
    return [...this.#entries.values()].flatMap((entry) =>
      entry.client === null ? [] : [entry.client],
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
      ...(entry.client === null
        ? {}
        : { runnerId: entry.client.runnerId, workspacePath: entry.client.workspacePath }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
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
    // 開けていない宛先は、**予約を畳んでから**入れ替える。人間が設定を直して
    // 登録し直した場合、古い開き方で挑み続ける予約が残ると直したものが効かない。
    if (existing !== undefined && existing.timer !== null) clearTimeout(existing.timer);

    const entry: RegistryEntry = {
      source,
      state: 'connecting',
      since: new Date().toISOString(),
      client: null,
      opening: null,
      timer: null,
      delay: this.#retryBaseMs,
    };
    this.#entries.set(source.label, entry);
    await this.#open(entry);
  }

  async unregister(label: string): Promise<void> {
    const entry = this.#entries.get(label);
    if (entry === undefined) return;
    this.#entries.delete(label);
    if (entry.timer !== null) clearTimeout(entry.timer);
    // **外した宛先の口は閉じる。** 名簿から消えたのに SSE だけ残ると、誰も宛先と
    // して選べない runner のイベントがデーモンに流れ続ける。
    await entry.client?.close().catch(() => undefined);
  }

  async select(): Promise<RunnerClient> {
    const until = Date.now() + this.#selectWaitMs;
    for (;;) {
      if (this.#stopped) throw new Error('名簿が停止している');

      // **配置の材料は実行環境の資源だけ**である（定員は作らない）。いまは
      // 開けている先頭を返す。資源を見て選ぶのは runner が報告を始めてからの話。
      const open = await this.list();
      const first = open[0];
      if (first !== undefined) return first;

      // **設定の問題と、時間で解決しうる問題を混ぜない。** 呼んだ側の対応が違う。
      if (this.#entries.size === 0) {
        throw new Error(
          'manager-runner が1台も登録されていない。' +
            'これは設定の問題なので、時間を置いても直らない' +
            '（ALTEROID_RUNNER_URLS / ALTEROID_RUNNER_URL か同一プロセスの runner が要る）。',
        );
      }

      // 挑み直す先が1つも無いなら、待っても誰も来ない。**理由を添えて即座に返す** —
      // ここで待つと、鍵を間違えた人間が「なぜか委譲が返ってこない」を見る。
      const pending = [...this.#entries.values()].filter((entry) => entry.state !== 'unusable');
      if (pending.length === 0) {
        throw new Error(
          `登録されている manager-runner がどれも使えない。挑み直しても同じ答えが返る種類の` +
            `失敗なので、名簿は挑み直していない: ${this.#describeEntries()}`,
        );
      }

      // まだ開いている最中（か、挑み直しの合間）。**ごく短い猶予だけ待つ。**
      const remaining = until - Date.now();
      if (remaining <= 0) throw new Error(this.#notConnectedMessage());
      const opened = await this.#waitForOpen(remaining);
      if (opened === null) throw new Error(this.#notConnectedMessage());
    }
  }

  /**
   * 「まだ繋がっていない」の言い方。**状態と直近の失敗を必ず添える。**
   *
   * 呼んだ側（クローン）がこれを読んで「少し置いて投げ直す」「人間に知らせる」を
   * 選べるようにするためのものである。「繋がりません」だけでは何も判断できない。
   */
  #notConnectedMessage(): string {
    return (
      'どの manager-runner にもまだ繋がっていないので、いまは委譲を置けない。' +
      '名簿は背景で挑み直し続けている（回数では諦めない）ので、少し置いて投げ直せば通ることがある: ' +
      this.#describeEntries()
    );
  }

  /** 名簿の内訳を一行に畳む（宛先・状態・直近の失敗。**値は載せない**）。 */
  #describeEntries(): string {
    return [...this.#entries.values()]
      .map(
        (entry) =>
          `${entry.source.label} は ${entry.state}` +
          `${entry.error === undefined ? '' : `（${entry.error}）`}`,
      )
      .join(' / ');
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const entry of this.#entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
    }
    for (const waiter of this.#waiting) waiter.reject(new Error('名簿が停止した'));
    this.#waiting.clear();
    this.#subscribers.clear();
  }

  // -------------------------------------------------------------------------
  // 開く
  // -------------------------------------------------------------------------

  /** 1つの宛先を開く。**同じ宛先へ多重に開きに行かない。** */
  #open(entry: RegistryEntry): Promise<void> {
    const already = entry.opening;
    if (already !== null) return already;

    const opening = (async () => {
      try {
        const client = await entry.source.open();
        if (this.#stopped || this.#entries.get(entry.source.label) !== entry) {
          // 開いている間に外された（か止まった）。**握り潰さずに閉じる。**
          await client.close().catch(() => undefined);
          return;
        }
        entry.client = client;
        entry.state = 'connected';
        entry.since = new Date().toISOString();
        delete entry.error;
        entry.delay = this.#retryBaseMs;
        for (const subscriber of this.#subscribers) subscriber(client);
        for (const waiter of this.#waiting) waiter.resolve(client);
        this.#waiting.clear();
      } catch (error) {
        if (this.#stopped || this.#entries.get(entry.source.label) !== entry) return;
        entry.client = null;
        entry.error = String(error);
        entry.since = new Date().toISOString();
        if (isRetryableRunnerError(error)) {
          // 待てば直る。**回数では諦めない**（諦めた先に残るのは、宛先を失った
          // まま誰にも知らされないデーモンである）。
          entry.state = 'unreachable';
          this.#scheduleOpen(entry);
        } else {
          // 待っても直らない。挑み直さずに知らせる（`select` はこの状態を見る）。
          entry.state = 'unusable';
          this.#notify?.({ label: entry.source.label, error: String(error) });
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
    // 名簿の挑み直しでプロセスの終了を引き延ばさない。
    timer.unref?.();
    entry.timer = timer;
  }

  /**
   * 次にどれかが開けるまで、猶予のあいだだけ待つ。時間切れは `null`。
   *
   * **待ちを名簿に残したまま帰らない。** 残すと、`stop` のときに誰も見ていない
   * 拒否が投げられ、時間切れのたびに待ちが積み上がる。
   */
  #waitForOpen(ms: number): Promise<RunnerClient | null> {
    return new Promise<RunnerClient | null>((resolve, reject) => {
      // 先に宣言しないと待ち手が自分を畳めない（呼ばれるのは必ず設定後である）。
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

  /** 待っている `select` に、もう挑み直す先が無いことを伝える（猶予を待たせない）。 */
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
