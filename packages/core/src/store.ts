import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

import type { AuthStore } from './auth.js';
import type {
  Commitment,
  InboxEvent,
  Job,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PendingApproval,
  SchedulePhase,
  ScheduledRequest,
} from './schema.js';
import type {
  UsageAccumulation,
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageLayer,
  UsageQuery,
  UsageSite,
  UsageSnapshot,
} from './usage.js';

/**
 * ストアのインターフェース（docs/architecture.md「ストレージ」）。
 * ドライバは storage-fs（ローカル）/ storage-pg（M4）で差し替える。
 *
 * 接続情報を持つのはデーモンプロセスだけである（非対称な可視性）。
 * マネージャー子プロセスへこれらの実装を渡してはいけない。
 */

/** 記憶 = 人間がいつでも読んで直せる Markdown 文書群（提供価値1）。 */
export interface PersonaStore {
  list(): Promise<MemoryDocumentMeta[]>;
  read(slug: string): Promise<MemoryDocument | null>;
  /** 全文置換。存在しなければ作る。 */
  write(slug: string, content: string): Promise<MemoryDocument>;
  /** 末尾に追記。存在しなければ作る。 */
  append(slug: string, content: string): Promise<MemoryDocument>;
  remove(slug: string): Promise<void>;
  /**
   * 全文書を本文ごと、`slug` の昇順で返す。
   *
   * **かつてここは `concat(): Promise<string>` だった。** 器の側で1つの文字列に
   * 潰していたので、上の層は「どの文書が変わったか」を問えず、走行中に人間が1行
   * 直しただけで**記憶の全文をもう一度クローンの文脈へ載せていた**（システム
   * プロンプトに載っている分と合わせて二重に載る）。載せ方は
   * `renderMemoryDocuments`（`memory.ts`）が持ち、器は文書を渡すだけにする。
   */
  documents(): Promise<MemoryDocument[]>;

  /**
   * この文書の保護状態（`schema.ts` の `MemoryProtectionStatus`）を返す。
   *
   * **新しい真実ではない。** 実体は日誌（`memory_update.cause`）にあり、ここは
   * その派生値（pg: `memory` テーブルの2列 / fs: `.index.json`）を読んだ結果を
   * 返すだけである。派生値を失った・信用できないとき（fs で索引ファイルが無い・
   * 壊れている／内容のハッシュが `content_sha256` と一致しない＝デーモンを
   * 通さず誰かが書き換えた可能性がある）は `unknown`（守る側）を返す。
   *
   * **誰にも送られない。** HTTP / CLI / 道具のどの入力スキーマにも登場しない
   * — `tools.ts` の distill ガードと、状態を人間可読にする表示のためだけに
   * 内部で使う値である。
   */
  protectionStatus(slug: string): Promise<MemoryProtectionStatus>;

  /**
   * `cause:'human'` の `memory_update`（`action:'write'`）が記録されたことを、
   * 保護状態の派生値へ反映する。
   *
   * 呼ぶのは日誌へ `cause:'human'` を書く箇所（`apps/daemon/src/app.ts` の
   * `PUT /memory/:slug`）と、デーモン起動時の backfill（`apps/daemon/src/storage.ts`）
   * だけである。**新しく配線を増やす場所ではない。**
   *
   * **一度立てたら降ろさない。** `at` はその時点で分かっている human 書き込みの
   * 時刻で、既に持っている値より古ければ何もしない（新しい順に舐める backfill が
   * 呼んでも巻き戻らないため）。実体（`.md` ファイル / `memory` テーブルの行）が
   * 既に無い slug に対して呼ばれても、新しく行を作ってはいけない — 削除済みの
   * slug が空文字の「文書」として `list()` / `read()` に化けて出てくる。
   */
  markHumanTouched(slug: string, at: string): Promise<void>;
}

export interface JournalQuery {
  limit?: number;
  types?: JournalEntryType[];
  /** ISO 8601。この時刻以降のエントリだけ返す。 */
  since?: string;
  /**
   * ISO 8601。この時刻以前のエントリだけ返す。
   *
   * **`since` だけでは過去の一区間を取れない。** 返るのは新しい順なので、
   * 「9時に何があったか」を聞いても手前に積まれた最新のものが `limit` を
   * 食い尽くし、狙った時刻には決して届かない（実際にそれで届かなかった）。
   * 窓の終端を閉じられて初めて、過去の一点を掘れる。
   */
  until?: string;
}

/** 日誌 = 追記専用の記録（PRD「可観測性」）。 */
export interface JournalStore {
  append(entry: JournalEntryInput): Promise<JournalEntry>;
  /** 新しい順に返す。 */
  list(query?: JournalQuery): Promise<JournalEntry[]>;
  /**
   * 1件を id で引く。
   *
   * **一覧を抜粋にするなら、全文への行き先が要る**（`manager_list` ↔
   * `manager_report` と同じ形）。無いと、抜粋にした時点で長い記録は
   * クローンから永久に読めなくなる＝能力の削除（north_star 禁止1）。
   */
  get(id: string): Promise<JournalEntry | null>;
}

/** ジョブと承認待ちキュー。M1 では承認待ちだけを使う。 */
export interface JobStore {
  listJobs(): Promise<Job[]>;
  putJob(job: Job): Promise<void>;

  listApprovals(options?: { pendingOnly?: boolean }): Promise<PendingApproval[]>;
  getApproval(id: string): Promise<PendingApproval | null>;
  putApproval(approval: PendingApproval): Promise<void>;
}

/**
 * 継続中の定期の依頼（PRD「自律」の起点②）。
 *
 * **人間の依頼のうち「これから先ずっと」の部分を持つ器である。** 会話は消え、
 * 受信箱は揮発し、記憶は根拠を持つ場所であって時計を持たない。ここが無いと
 * 「定期的に見ておいて」は次の compaction かデーモン再起動で静かに消える。
 *
 * 人間もここを読んで直せること（CLI / HTTP API）が要件である — 人間の制御手段は
 * 記憶・日誌・境界の3つだが、自分が出した継続の依頼が見えないのは可観測性の穴になる。
 */
export interface ScheduleStore {
  /** kind の昇順。 */
  list(): Promise<ScheduledRequest[]>;
  get(kind: string): Promise<ScheduledRequest | null>;
  /** 同じ kind があれば置き換える（`createdAt` は呼び出し側が引き継ぐ）。 */
  put(entry: ScheduledRequest): Promise<void>;
  remove(kind: string): Promise<void>;
  /**
   * 発火を確定させる。**読むことと記録することを1操作に閉じる。**
   *
   * `expectedUpdatedAt` と同じ版がまだ在るときだけ記録し、**確定した依頼（記録を
   * 進める前の姿）** を返す。消えていた・書き換わっていたら null。
   *
   * **これが2操作に分かれていると、読んでから記録するまでの隙間で人間が消した・
   * 直した依頼が古い本文で走る。** 「本文は処理する瞬間にストアから読む」という
   * 約束は、競合したときにこそ効かないと意味がない（消した依頼が外の世界に手を
   * 出したら取り返せない）。返り値が更新前の姿なのは、呼び出し側が「前回いつ
   * 動いたか」を材料として要るからである。
   *
   * ここで付けるのは **`pendingRun`（引き受けた印）と `lastRunAt`（観測用）だけ**で、
   * 定期の予定の基準（`lastScheduledRunAt`）は `completeRun` まで進めない。claim の
   * 直後に器が落ちたとき、その回が「もう動いた」ことになって消えないようにするため。
   */
  claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<ScheduledRequest | null>;

  /**
   * 引き受けた発火が終わったことを記録する。`pendingRun` を消し、`schedule` なら
   * 定期の予定の基準（`lastScheduledRunAt`）を進める。
   *
   * **`manual` では基準を動かさない**（手で起こした1回で予定をずらさない）。
   * 消えている kind、別の発火の印が付いている場合は何もしない。
   */
  completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void>;

  /**
   * 既定の仕込み（日報・発意 tick）の位相を読む。無ければ null。
   *
   * **依頼（`list()` / `get()`）とは別の器である。** 理由は `schedulePhaseSchema` に
   * 書いてある（1つにまとめると、既定の仕込みがクローンから継続中の依頼に見えて
   * `schedule_remove` で消せる）。**だから `list()` にこれを混ぜないこと。**
   */
  getPhase(kind: string): Promise<SchedulePhase | null>;

  /** 同じ kind があれば置き換える。 */
  putPhase(phase: SchedulePhase): Promise<void>;
}

/**
 * 引き受けたまま終わっていない仕事の台帳（`schema.ts` の `Commitment`）。
 *
 * **受信箱（`InboxStore`）とは守るものが違う。** あちらが持つのは「その合図がまだ
 * モデルに届いていない」という配達の状態で、ターンが終われば消える。こちらが持つのは
 * 「頼まれたことがまだ片付いていない」という**仕事の状態**で、ターンが終わっても
 * 残る。片方でもう片方を代用できないので、両方要る。
 *
 * **省略可能にしないこと**（`schedules` / `inbox` と同じ理由）。ここが任意だと、
 * 片方の器でだけ依頼が黙って消えるという能力差が生まれる（north_star 禁止1）。
 */
export interface CommitmentStore {
  /**
   * 台帳を返す。**未了は古い順**（齢が判断の材料なので、古いものから見せる）、
   * 片付いたものは新しい順で未了の後ろに続く。
   *
   * `includeClosed` を省いたら未了だけ。
   */
  list(options?: { includeClosed?: boolean }): Promise<Commitment[]>;

  get(id: string): Promise<Commitment | null>;

  /**
   * 未了として開く。**同じ id が既に在れば何もしない**（開いたら `true`）。
   *
   * **冪等であることがこの器の要である。** 受信箱の合図は配り直されうるので
   * （`InboxStore` の取引）、その id をそのまま使う自動 open は同じ id で二度呼ばれる。
   * 上書きしてしまうと、**一度片付けた仕事が配り直しのたびに開き直る** — 器が落ちる
   * たびに終わったはずの依頼が蘇り、クローンが同じ仕事を二度起こす。
   */
  open(entry: Commitment): Promise<boolean>;

  /**
   * 片付いたことを記録する。閉じたら `true`、無い id と既に閉じているものは `false`。
   *
   * **行は消さない。** 消すと「何を片付けたか」が日報の材料から落ちる。人間が普段
   * 読むのは日報だけである（PRD「可観測性」）。
   */
  close(id: string, at: string, reason: string): Promise<boolean>;
}

/**
 * まだ処理し終えていない受信箱の合図（PRD「可観測性」/ architecture.md「同時実行モデル」）。
 *
 * **受信箱そのものはインメモリでよい。ここが持つのは「まだ終えていない」という事実だけ**
 * である。デーモンが落ちたとき、`Inbox` の `#queue` に居たものも、`#waiters` へ直接
 * 渡されて一度も queue を通らなかったものも、同じように消える。消えるのは人間の発言・
 * webhook・マネージャーの報告＝**判断の材料**であって、失われたことに気づく手段も無い。
 *
 * **境界は「`post` が受理した時点」であって「queue に入った時点」ではない。** クローンが
 * 暇なときに届いた合図は `Inbox#push` の waiter 経路を通って queue を素通りするので、
 * 「落ちる前に queue を吐き出す」形の永続化はその経路を1件も救わない。
 *
 * **消し込みは「処理を終えた時点」である**（取り出した時点ではない）。取り出した時点で
 * 消すと、処理の途中でプロセスが死んだものが失われる＝いま塞いでいる穴がそのまま残る。
 * したがって同じ合図が二度処理されうるが、**二度届く（雑音）より消える（判断材料の
 * 喪失）方が高い**。二度目だと分かる形にすることでこの取引を成立させる（`deliveries`）。
 *
 * **本文を持つ。** ここは日誌やジョブ台帳と同じ記憶ストアの中で、本文を持つ器は既に
 * ある（新しい露出面ではない）。持たなければ拾い直せないので、持たない選択は無い。
 * ただし**書けなかったときに外へ出す跡には本文を載せない**（`dropped-record.ts`）。
 */
export interface InboxStore {
  /**
   * 受け取った合図を未読として置く。同じ id なら上書きする（配達回数は保つ）。
   *
   * **`post` が受理した順に呼ばれるが、書けた順は保証されない。** 呼び出し側は
   * 消し込みがこの書き込みを追い越さないようにすること（追い越すと、消したはずの
   * 合図が後から書かれて永久に配り直される）。
   */
  put(event: InboxEvent, at: string): Promise<void>;

  /** 処理を終えた合図を消す。無ければ何もしない。 */
  remove(id: string): Promise<void>;

  /**
   * 残っている未読を古い順に返し、**同時に配達回数を1つ進める**。
   *
   * **読むことと回数を進めることを1操作に閉じること**（`ScheduleStore.claimRun` と
   * 同じ作法）。分けると、配り直しの途中で落ちたときに回数が進まず、「何回目の配達か」
   * が嘘になる。回数はクローンが毒（＝配り直すたびに器ごと落ちる合図）を見分ける
   * ための唯一の材料なので、**これは実行回数の制限ではない**（AGENTS.md 地雷2）—
   * 何回目であっても配ることは変わらない。
   */
  claimPending(): Promise<PendingInboxEvent[]>;
}

/** 未読として残っていた合図1件。 */
export interface PendingInboxEvent {
  event: InboxEvent;
  /** `post` が受理した時刻（ISO 8601）。 */
  at: string;
  /**
   * 何度目の配達か。`1` は「初めて配る」＝一度も配られずに器が落ちた。
   * `2` 以上は「前に配ったが、終える前にまた落ちた」。
   */
  deliveries: number;
}

/** セッションの生ログ退避先（PreCompact フックで落とす）。 */
export interface TranscriptArchive {
  /** 退避したアーカイブのパス（または識別子）を返す。 */
  archive(sessionId: string, transcript: string): Promise<string>;
  list(): Promise<string[]>;
  read(id: string): Promise<string | null>;
}

/**
 * 実行環境プロファイル（人間の `.zprofile` / `.zshenv` に当たるもの）。
 *
 * **記憶ではない。** 人格は記憶（Markdown）に宿るのであって、鍵や `PATH` の話は
 * そこに混ぜない。器を作り直しても残るという性質だけが同じなので、同じストアの
 * 一員として持つ。
 *
 * 持つのはデーモンだけである。runner は自分で読みに行かず、**降ってきたものを
 * 器に置くだけ**にしてある（読みに行けるということは、runner から記憶ストアへの
 * 経路があるということで、それは M4 の受け入れ基準3 が無いと言っているものである）。
 */
export interface EnvProfile {
  /** 人間が書いたシェルスクリプトそのもの。器は中身を解釈しない。 */
  script: string;
  updatedAt: string;
}

export interface ProfileStore {
  /** 置かれていなければ null。 */
  read(): Promise<EnvProfile | null>;
  /** 全文置換。空文字は「プロファイルを外す」。 */
  write(script: string): Promise<EnvProfile>;
  /**
   * **取り消した更新をなかったことにする**（本文と更新日時を組で戻す）。
   *
   * `write` で戻すと本文は元に戻っても `updatedAt` が失敗した時刻へ進む。
   * そこは「人間かクローンが最後に**本文を変えた**時刻」であって、`profile status`
   * と `GET /profile` が見せる監査情報である。成功していない更新でそこが動くと、
   * 起動のたびに動いていたときと同じ意味の壊れ方をする。
   *
   * `null` は「置かれていなかった状態へ戻す」。**通常の書き込みに使わないこと** —
   * 更新日時を呼び出し側が決められる口なので、失敗の巻き戻し専用である。
   */
  revert(previous: EnvProfile | null): Promise<void>;
}

/**
 * 利用状況の台帳（`usage.ts`）。
 *
 * **持つのはデーモンだけである。** runner に持たせると記憶ストアの鍵が要る
 * （M4 受け入れ基準3）。runner から降りてくるのは累積スナップショットという
 * 事実だけで、差分にして積むのはここ。
 */
export interface UsageStore {
  /**
   * 累積スナップショットを台帳へ畳み込む。
   *
   * **読むことと書くことを1操作に閉じること。** 基準を読んでから増分を書くまでの
   * 隙間で同じマネージャーの次の `result` が届くと、同じ増分が2回積まれる。
   * pg はトランザクション、fs は1回の書き込みで守る（`auth-service` と同じ作法）。
   *
   * 返すのは**実際に積んだ増分**と、数え直しが起きたならその事実。呼び出し側は
   * それを日誌へ落とす（黙って数え直さない）。
   */
  record(input: {
    /** **誰が**使ったか。モデル id で代用しないこと（`usage.ts` の `usageLayerSchema`）。 */
    layer: UsageLayer;
    /** **どこで**使ったか。 */
    site: UsageSite;
    /** 誰の分か（マネージャーの id か `CLONE_ACTOR_ID`）。 */
    managerId: string;
    /** ローカル時刻の `YYYY-MM-DD`（`usageDate()` で作る）。 */
    date: string;
    at: string;
    snapshot: UsageSnapshot;
    /**
     * 累積の器がどこで閉じるか。**既定を持たせないこと。**
     *
     * 黙って `cumulative` に倒すと、1回で閉じる `query()` の高くついた回だけが
     * 目減りする（`usage.ts` の {@link foldOneshotUsage}）。呼ぶ側が毎回言う。
     */
    accumulation: UsageAccumulation;
  }): Promise<UsageFold>;

  /**
   * 期間の集計。日 × actor × モデル × 層 × 場所の行を返す。
   *
   * **`since` を必ず載せること。** 台帳が始まる前を照会されたら 0 ではなく
   * 「記録が無い」と言えるようにするためである（過去分の掘り起こしはしない）。
   *
   * **`layersSince` も必ず載せること。** 層の軸は台帳より後から入ったので、
   * それより前の行の `layer` / `site` は既定値であって観測ではない。
   */
  aggregate(query: UsageQuery): Promise<UsageAggregate>;

  /**
   * 累積を持つ主体1つの現在の基準（前回読んだ累積）。無ければ null。
   *
   * **鍵は「層 × actor」である。** actor の id だけで引くと、層をまたいで同じ id が
   * 来たときに別の累積が1つの基準を共有し、差分がまるごと嘘になる。
   */
  baseline(layer: UsageLayer, managerId: string): Promise<UsageBaseline | null>;
}

/** クローンのセッション id を跨いで覚えておくための最小の永続化。 */
export interface SessionRegistry {
  getCloneSessionId(): Promise<string | null>;
  setCloneSessionId(sessionId: string | null): Promise<void>;
}

/** デーモンが必要とするストア一式。 */
export interface Stores {
  persona: PersonaStore;
  journal: JournalStore;
  jobs: JobStore;
  /**
   * 継続中の定期の依頼。
   *
   * **省略可能にしないこと。** 器（fs / pg）が違うだけで上の層が見るものは同じで
   * ある、が M4 の要件である。ここを任意にすると、片方の器では「定期的にやって」が
   * 効かないという能力差が生まれる（north_star 禁止1）。
   */
  schedules: ScheduleStore;
  /**
   * まだ処理し終えていない受信箱の合図。
   *
   * **省略可能にしないこと**（`schedules` / `usage` と同じ理由）。ここが任意だと、
   * 片方の器でだけデーモンの死で未読が消えるという能力差が生まれる（north_star 禁止1）。
   */
  inbox: InboxStore;
  /**
   * 引き受けたまま終わっていない仕事の台帳。
   *
   * **省略可能にしないこと**（`inbox` と同じ理由）。ここが任意だと、片方の器でだけ
   * 「その場で着手しなかった依頼が黙って消える」という能力差が生まれる。
   */
  commitments: CommitmentStore;
  archive: TranscriptArchive;
  sessions: SessionRegistry;
  /**
   * ログインしたアカウントと、alteroid を使ってよいかの2値（`auth.ts`）。
   *
   * **これは「誰がこの API に触れるか」の話であって、PRD「権限境界」（クローンが
   * 記憶を根拠に何を人間へ確認するか）とは別の層である。** 混ぜてはいけない。
   */
  auth: AuthStore;
  /**
   * 実行環境プロファイル（`.zprofile` 相当）。**環境変数を器に増やす代わりの口**で
   * あり、用途が増えるたびに実装を直さずに済ませるためにここに置く。
   */
  profile: ProfileStore;
  /**
   * 利用状況の台帳。
   *
   * **省略可能にしないこと**（`schedules` と同じ理由）。器が違うだけで上の層が
   * 見るものは同じである、が M4 の要件で、ここを任意にすると「pg では消費が
   * 見えるが fs では見えない」という能力差が生まれる（north_star 禁止1）。
   */
  usage: UsageStore;
  /**
   * SDK のセッション生ログの預け先（M4 のクラウド構成でだけ付く）。
   *
   * **manager-runner はこれを持たない。** runner から預かった生ログをここへ落とすのは
   * デーモンであり、runner には記憶ストアへ到達する鍵を渡さない
   * （docs/architecture.md「非対称な可視性」）。
   */
  sessionStore?: SessionStore;
}
