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

/**
 * runner が報告する実行環境の資源（roadmap M5）。
 *
 * **配置の材料であって、定員ではない。** 「同時に何本まで」を決める数をここへ
 * 足さないこと（`maxManagers` のような人工上限は禁止2 の違反であり、M5 の地雷
 * そのものである）。ここに並ぶのは全部**実測**で、詰まっていることは分かるが、
 * 詰まったことを理由に委譲を拒む口はどこにも無い。
 */
export const runnerCapacitySchema = z.object({
  /** 使える CPU（cgroup で絞られていれば小数になる）。 */
  cpuCount: z.number().positive(),
  /** 直近1分の負荷。取れない環境では 0。 */
  load1m: z.number().nonnegative(),
  totalMemoryBytes: z.number().nonnegative(),
  freeMemoryBytes: z.number().nonnegative(),
  /** いま抱えている SDK セッションの本数（実測。上限ではない）。 */
  activeManagers: z.number().int().nonnegative(),
  /** 器が起きてからの秒数。作り直されたことの手がかりになる。 */
  uptimeSeconds: z.number().nonnegative(),
});

export type RunnerCapacity = z.infer<typeof runnerCapacitySchema>;

/**
 * 器が自分に課している貸し出し期限（fencing lease / roadmap M5）。
 *
 * **これが無いと、落ちて見えた器の仕事を別の器へ移せない。** 生存確認が途絶えた
 * ことは「器が死んだ」ことを意味しない — デーモンとの通信だけが切れて、マネージャーは
 * 走り続けている（ネットワーク分断）こともある。そこで同じ session を別の器で
 * resume すると、**1つの仕事が2か所で同時に動く**。共有 workspace への二重書き、
 * `gh pr create` や MCP 越しの外部操作の二重実行が起きる。デーモン側の排他
 * （移送を1本にまとめる類）は同じプロセスの中しか守れないので、ここは器自身が
 * 引き受けるしかない。
 *
 * だから約束はこうである。**`ttlMs` のあいだ `GET /health` が届かなければ、器は
 * 自分が抱えている SDK セッションを畳み始め、遅くとも `ttlMs + graceMs` までに
 * 畳み終える。** デーモンはこれを根拠に、最後に名乗りが返った時刻からこの時間＋
 * 余裕を過ぎたときだけ、別の器で開き直してよい。
 *
 * **`graceMs` を省いてはいけない。** 器が期限切れに気づくのが遅れる分（見張りの
 * 粒度）と、実際に畳み終えるまでの時間を含まないと、デーモンが「もう止まっている」
 * と見なす時刻の方が、器が畳み始める時刻より**先に来る**。そこが二重実行の窓に
 * なる（申告が無ければデーモンは安全側に倒して `ttlMs` ぶん余計に待つ）。
 *
 * **報告しない器は「畳まない器」として扱われる。** その器の仕事は自動では移らず、
 * 人間かクローンの確認を待つ（黙って二重に走らせるよりは止める）。
 */
export const runnerLeaseSchema = z.object({
  /**
   * この時間 `GET /health` が届かなければ、器が自分でセッションを畳み始める（ミリ秒）。
   *
   * **生存確認の間隔より十分長くすること。** 短いと、少し詰まっただけの器が
   * 走っている仕事を自分で殺す。
   */
  ttlMs: z.number().int().positive(),
  /**
   * 期限が切れてから**畳み終わる**までに要りうる時間の上限（ミリ秒）。
   *
   * 器が自分の実装について知っていることを申告する枠である。期限切れの検査が
   * 遅れる分と、セッションを畳むのにかかる時間が入る。ここを 0 と偽ると、
   * デーモンは畳み終える前に別の器で開き直す。
   */
  graceMs: z.number().int().nonnegative().optional(),
  /**
   * 器の**この起動**を指す id（プロセスごとに作り直される）。
   *
   * `runner_id` は器を作り直しても同じ宛先として戻るための**安定した**名前なので、
   * 「いま名乗っているのが、その仕事を置いた器と同じ起動か」はこれでしか分からない。
   * 区別できないと、ローリング更新で入れ替わった新しい器の応答を、分断されたまま
   * 走り続けている古い器の応答と取り違える。
   */
  incarnation: z.string().min(1).optional(),
});

export type RunnerLease = z.infer<typeof runnerLeaseSchema>;

/**
 * runner の名乗り（`GET /health`）。生存判定と配置はこれ1枚で足りる。
 *
 * `capacity` を省略可能にしてあるのは、資源を報告しない古い器が名簿に混ざっても
 * **配置から落とさない**ためである（報告が無いことは能力の欠落ではない）。
 *
 * **`GET /health` は貸し出し期限の更新でもある**（`lease` を見よ）。更新の口を
 * ここ1つに絞ってあるのは、デーモンが「最後に名乗りが返った時刻」から器側の期限を
 * 安全側に見積もれるようにするためである。他の口でも更新すると、器の期限がデーモンの
 * 見立てより後ろにずれ、まだ走っている仕事を移してしまう。
 */
export const runnerHealthSchema = z.object({
  ok: z.literal(true),
  runnerId: z.string().min(1),
  workspacePath: z.string(),
  managers: z.number().int().nonnegative(),
  pendingEvents: z.number().int().nonnegative(),
  capacity: runnerCapacitySchema.optional(),
  lease: runnerLeaseSchema.optional(),
});

export type RunnerHealth = z.infer<typeof runnerHealthSchema>;

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
  /**
   * 名乗りと資源の報告（生存判定の1回分）。
   *
   * **届かなければ例外を投げること。** 「落ちている」を戻り値で表すと、呼び出し側が
   * 生きている器と区別できず、落ちた器へ委譲を置き続ける（M5 受け入れ基準4）。
   */
  health(): Promise<RunnerHealth>;
  /** イベントの受け取りを始める。**接続を張るのはデーモン側**である。 */
  connect(onEvent: (event: RunnerEvent) => void): Promise<void>;
  start(command: RunnerStartCommand): Promise<void>;
  resume(command: RunnerResumeCommand): Promise<void>;
  send(managerId: string, text: string): Promise<void>;
  /** `false` = その確認は runner 側に無い（既に解けた / 別の宛先）。 */
  answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean>;
  /**
   * そのセッションを畳ませる。**`true` = 実際にそこに在って、畳んだ。**
   *
   * これが別の器へ移す前の停止確認になるので、区別を潰さないこと。
   *
   * - 届かない → **例外**（確認は取れていない）
   * - 届いたが、そのセッションはそこに無い → **`false`**
   * - 届いて、畳んだ → `true`
   *
   * **「無かった」を成功にしないのが要点である。** `runner_id` は器を作り直しても
   * 同じ名前で戻るので、ローリング更新後の**新しい器**は、古い器が抱えたままの
   * セッションについて何も知らないまま「畳んだ」と答えられてしまう。それを確認と
   * 扱うと、分断されて走り続けている古い器と二重に動く。
   */
  stop(managerId: string): Promise<boolean>;
  /** いま runner が抱えているセッション（再接続時の突き合わせに使う）。 */
  list(): Promise<RunnerManagerState[]>;
  /** runner のローカルにある生ログ。無ければ null。 */
  transcript(managerId: string): Promise<string | null>;
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
 * 名簿（`RunnerRegistry`）は [runner-registry.ts](./runner-registry.ts) にある。
 *
 * 宛先の決定・生存判定・資源による配置は**振る舞い**なので、この形の定義だけを
 * 置いておくファイルには入れない。デーモンが見るのは名簿だけで、固定 URL も
 * runner のローカルパスも前提にしない（docs/architecture.md「プロセス境界」）。
 */
