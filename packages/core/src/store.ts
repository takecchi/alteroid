import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

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
   * SDK のセッション生ログの預け先（M4 のクラウド構成でだけ付く）。
   *
   * **manager-runner はこれを持たない。** runner から預かった生ログをここへ落とすのは
   * デーモンであり、runner には記憶ストアへ到達する鍵を渡さない
   * （docs/architecture.md「非対称な可視性」）。
   */
  sessionStore?: SessionStore;
}
