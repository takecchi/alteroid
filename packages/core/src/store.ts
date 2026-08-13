import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

import type { AuthStore } from './auth.js';
import type {
  Job,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  MemoryDocument,
  MemoryDocumentMeta,
  PendingApproval,
} from './schema.js';

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
  /** 全文書を1つの文字列に連結する（クローンのシステムプロンプトへ載せる用）。 */
  concat(): Promise<string>;
}

export interface JournalQuery {
  limit?: number;
  types?: JournalEntryType[];
  /** ISO 8601。この時刻以降のエントリだけ返す。 */
  since?: string;
}

/** 日誌 = 追記専用の記録（PRD「可観測性」）。 */
export interface JournalStore {
  append(entry: JournalEntryInput): Promise<JournalEntry>;
  /** 新しい順に返す。 */
  list(query?: JournalQuery): Promise<JournalEntry[]>;
}

/** ジョブと承認待ちキュー。M1 では承認待ちだけを使う。 */
export interface JobStore {
  listJobs(): Promise<Job[]>;
  putJob(job: Job): Promise<void>;

  listApprovals(options?: { pendingOnly?: boolean }): Promise<PendingApproval[]>;
  getApproval(id: string): Promise<PendingApproval | null>;
  putApproval(approval: PendingApproval): Promise<void>;
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
   * SDK のセッション生ログの預け先（M4 のクラウド構成でだけ付く）。
   *
   * **manager-runner はこれを持たない。** runner から預かった生ログをここへ落とすのは
   * デーモンであり、runner には記憶ストアへ到達する鍵を渡さない
   * （docs/architecture.md「非対称な可視性」）。
   */
  sessionStore?: SessionStore;
}
