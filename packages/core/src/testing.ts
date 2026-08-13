import type {
  InboxEvent,
  Job,
  JournalEntry,
  JournalEntryInput,
  MemoryDocument,
  MemoryDocumentMeta,
  PendingApproval,
} from './schema.js';
import type {
  AccessTokenRecord,
  AuthAccount,
  AuthIdentity,
  AuthStore,
  LoginRequest,
} from './auth.js';
import type {
  JobStore,
  JournalQuery,
  JournalStore,
  PersonaStore,
  SessionRegistry,
  Stores,
  TranscriptArchive,
} from './store.js';

/**
 * テスト用のインメモリストア。storage-fs の代わりに core のテストで使う。
 * 本番の配線には出てこない（永続化は必ずドライバ側）。
 */
export function createMemoryStores(): Stores {
  const documents = new Map<string, MemoryDocument>();
  const entries: JournalEntry[] = [];
  const jobs = new Map<string, Job>();
  const approvals = new Map<string, PendingApproval>();
  const archives = new Map<string, string>();
  let cloneSessionId: string | null = null;
  let counter = 0;
  const nextId = () => `id-${++counter}`;

  const persona: PersonaStore = {
    async list(): Promise<MemoryDocumentMeta[]> {
      return [...documents.values()]
        .map(({ slug, title, updatedAt, bytes }) => ({ slug, title, updatedAt, bytes }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
    },
    async read(slug) {
      return documents.get(slug) ?? null;
    },
    async write(slug, content) {
      const doc: MemoryDocument = {
        slug,
        title: /^#\s+(.+)$/m.exec(content)?.[1] ?? slug,
        updatedAt: new Date().toISOString(),
        bytes: Buffer.byteLength(content),
        content,
      };
      documents.set(slug, doc);
      return doc;
    },
    async append(slug, content) {
      const existing = documents.get(slug);
      return persona.write(slug, existing ? `${existing.content}\n${content}` : content);
    },
    async remove(slug) {
      documents.delete(slug);
    },
    async concat() {
      return (await persona.list())
        .map((meta) => documents.get(meta.slug)?.content ?? '')
        .join('\n\n');
    },
  };

  const journal: JournalStore = {
    async append(input: JournalEntryInput) {
      const entry = { ...input, id: nextId(), at: new Date().toISOString() } as JournalEntry;
      entries.push(entry);
      return entry;
    },
    async list(query: JournalQuery = {}) {
      let found = [...entries].reverse();
      if (query.types) found = found.filter((entry) => query.types?.includes(entry.type));
      if (query.since !== undefined) {
        const since = query.since;
        found = found.filter((entry) => entry.at >= since);
      }
      return query.limit === undefined ? found : found.slice(0, query.limit);
    },
  };

  const jobStore: JobStore = {
    async listJobs() {
      return [...jobs.values()];
    },
    async putJob(job) {
      jobs.set(job.id, job);
    },
    async listApprovals(options = {}) {
      const all = [...approvals.values()];
      return options.pendingOnly ? all.filter((a) => a.answeredAt === undefined) : all;
    },
    async getApproval(id) {
      return approvals.get(id) ?? null;
    },
    async putApproval(approval) {
      approvals.set(approval.id, approval);
    },
  };

  const archive: TranscriptArchive = {
    async archive(sessionId, transcript) {
      const id = `${sessionId}-${nextId()}`;
      archives.set(id, transcript);
      return id;
    },
    async list() {
      return [...archives.keys()];
    },
    async read(id) {
      return archives.get(id) ?? null;
    },
  };

  const sessions: SessionRegistry = {
    async getCloneSessionId() {
      return cloneSessionId;
    },
    async setCloneSessionId(sessionId) {
      cloneSessionId = sessionId;
    },
  };

  const accounts = new Map<string, AuthAccount>();
  const identities = new Map<string, AuthIdentity>();
  const accessTokens = new Map<string, AccessTokenRecord>();
  const loginRequests = new Map<string, LoginRequest>();
  const identityKey = (provider: string, subject: string) => `${provider} ${subject}`;

  const auth: AuthStore = {
    async listAccounts() {
      return [...accounts.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async getAccount(id) {
      return accounts.get(id) ?? null;
    },
    async findAccountByEmail(email) {
      return [...accounts.values()].find((account) => account.email === email) ?? null;
    },
    async putAccount(account) {
      accounts.set(account.id, account);
    },
    async findIdentity(provider, subject) {
      return identities.get(identityKey(provider, subject)) ?? null;
    },
    async listIdentities(accountId) {
      return [...identities.values()].filter((identity) => identity.accountId === accountId);
    },
    async putIdentity(identity) {
      identities.set(identityKey(identity.provider, identity.subject), identity);
    },
    async putAccessToken(token) {
      accessTokens.set(token.id, token);
    },
    async findAccessTokenBySha256(hash) {
      return [...accessTokens.values()].find((token) => token.sha256 === hash) ?? null;
    },
    async listAccessTokens(accountId) {
      return [...accessTokens.values()].filter((token) => token.accountId === accountId);
    },
    async putLoginRequest(request) {
      loginRequests.set(request.id, request);
    },
    async getLoginRequest(id) {
      return loginRequests.get(id) ?? null;
    },
    async beginLoginExchange(id) {
      // 検査から書き込みまでの間に await を挟まない（挟むと2本目が割り込む）。
      const found = loginRequests.get(id);
      if (found === undefined || found.status !== 'pending') return null;
      const processing = { ...found, status: 'processing' as const };
      loginRequests.set(id, processing);
      return processing;
    },
    async claimLoginRequest(id, issue) {
      // 検査から書き込みまでの間に await を挟まない（挟むと他の claim が割り込む）。
      const found = loginRequests.get(id);
      if (found === undefined || found.status !== 'authenticated') return null;
      const consumed = { ...found, status: 'consumed' as const };
      const token = issue(consumed);
      loginRequests.set(id, consumed);
      accessTokens.set(token.id, token);
      return { request: consumed, token };
    },
    async grantExclusive(accountId, at, by) {
      const account = accounts.get(accountId);
      if (account === undefined) return { status: 'not_found' };
      if (account.grantedAt !== null) return { status: 'granted', account };
      const owner = [...accounts.values()].find((it) => it.grantedAt !== null);
      if (owner !== undefined) return { status: 'conflict', owner };
      const granted = { ...account, grantedAt: at, grantedBy: by };
      accounts.set(accountId, granted);
      return { status: 'granted', account: granted };
    },
  };

  return { persona, journal, jobs: jobStore, archive, sessions, auth };
}

export function humanMessage(text: string, conversationId = 'conv-1'): InboxEvent {
  return {
    type: 'human_message',
    id: `evt-${text}`,
    at: new Date().toISOString(),
    text,
    conversationId,
  };
}
