import type {
  InboxEvent,
  Job,
  JournalEntry,
  JournalEntryInput,
  MemoryDocument,
  MemoryDocumentMeta,
  PendingApproval,
  ScheduledRequest,
} from './schema.js';
import type {
  AccessTokenRecord,
  AuthAccount,
  AuthIdentity,
  AuthStore,
  LoginRequest,
} from './auth.js';
import type {
  EnvProfile,
  JobStore,
  JournalQuery,
  JournalStore,
  PersonaStore,
  ProfileStore,
  ScheduleStore,
  SessionRegistry,
  Stores,
  TranscriptArchive,
  UsageStore,
} from './store.js';
import {
  foldUsageSnapshot,
  USAGE_ESTIMATE_NOTICE,
  usageDate,
  ZERO_USAGE,
  type UsageBaseline,
  type UsageRow,
} from './usage.js';

/**
 * テスト用のインメモリストア。storage-fs の代わりに core のテストで使う。
 * 本番の配線には出てこない（永続化は必ずドライバ側）。
 */
export function createMemoryStores(): Stores {
  const documents = new Map<string, MemoryDocument>();
  const entries: JournalEntry[] = [];
  const jobs = new Map<string, Job>();
  const approvals = new Map<string, PendingApproval>();
  const schedules = new Map<string, ScheduledRequest>();
  const archives = new Map<string, string>();
  let cloneSessionId: string | null = null;
  let envProfile: EnvProfile | null = null;
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
      if (query.until !== undefined) {
        const until = query.until;
        found = found.filter((entry) => entry.at <= until);
      }
      return query.limit === undefined ? found : found.slice(0, query.limit);
    },
    async get(id: string) {
      return entries.find((entry) => entry.id === id) ?? null;
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

  const scheduleStore: ScheduleStore = {
    async list() {
      return [...schedules.values()].sort((a, b) => a.kind.localeCompare(b.kind));
    },
    async get(kind) {
      return schedules.get(kind) ?? null;
    },
    async put(entry) {
      schedules.set(entry.kind, entry);
    },
    async remove(kind) {
      schedules.delete(kind);
    },
    async claimRun(kind, expectedUpdatedAt, at, cause) {
      const existing = schedules.get(kind);
      // 消された・書き換わったなら古い本文で動かさない
      if (!existing || existing.updatedAt !== expectedUpdatedAt) return null;
      // updatedAt は版の識別子なので動かさない。定期の基準は completeRun まで進めない
      schedules.set(kind, { ...existing, lastRunAt: at, pendingRun: { at, cause } });
      return existing;
    },
    async completeRun(kind, at, cause) {
      const existing = schedules.get(kind);
      // 別の発火の印が付いているなら触らない
      if (!existing || existing.pendingRun?.at !== at) return;
      const rest = { ...existing };
      delete rest.pendingRun;
      schedules.set(kind, cause === 'schedule' ? { ...rest, lastScheduledRunAt: at } : rest);
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

  const profile: ProfileStore = {
    async read() {
      return envProfile;
    },
    async write(script) {
      envProfile =
        script.trim().length === 0 ? null : { script, updatedAt: new Date().toISOString() };
      return envProfile ?? { script: '', updatedAt: new Date().toISOString() };
    },
    async revert(previous) {
      envProfile = previous;
    },
  };

  /**
   * 利用状況の台帳（インメモリ）。
   *
   * **差分ロジックは本番と共有する** — `foldUsageSnapshot` を呼ぶので、
   * 「テストの器だけ二重計上しない」というずれ方をしない。
   */
  const usageRows = new Map<string, UsageRow>();
  const usageBaselines = new Map<string, UsageBaseline>();
  let usageStartedAt: string | null = null;

  const usage: UsageStore = {
    async record({ managerId, date, at, snapshot }) {
      const fold = foldUsageSnapshot(usageBaselines.get(managerId) ?? null, snapshot, at);
      usageBaselines.set(managerId, { ...fold.baseline, managerId });
      usageStartedAt ??= at;
      for (const [model, delta] of Object.entries(fold.delta)) {
        const key = `${date} ${managerId} ${model}`;
        const before = usageRows.get(key)?.totals ?? ZERO_USAGE;
        usageRows.set(key, {
          date,
          managerId,
          model,
          totals: {
            inputTokens: before.inputTokens + delta.inputTokens,
            outputTokens: before.outputTokens + delta.outputTokens,
            cacheReadInputTokens: before.cacheReadInputTokens + delta.cacheReadInputTokens,
            cacheCreationInputTokens:
              before.cacheCreationInputTokens + delta.cacheCreationInputTokens,
            webSearchRequests: before.webSearchRequests + delta.webSearchRequests,
            costUsd: before.costUsd + delta.costUsd,
          },
          updatedAt: at,
        });
      }
      return fold;
    },
    async aggregate(query) {
      const rows = [...usageRows.values()]
        .filter((row) => (query.from === undefined ? true : row.date >= query.from))
        .filter((row) => (query.to === undefined ? true : row.date <= query.to))
        .filter((row) => (query.managerId === undefined ? true : row.managerId === query.managerId))
        .sort((a, b) => a.date.localeCompare(b.date) || a.managerId.localeCompare(b.managerId));
      return {
        rows,
        since: usageStartedAt,
        // 台帳が始まる前を照会されたら、0 ではなく「記録が無い」と言えるように。
        beforeLedger:
          usageStartedAt !== null &&
          query.from !== undefined &&
          query.from < usageDate(new Date(usageStartedAt)),
        notice: USAGE_ESTIMATE_NOTICE,
      };
    },
    async baseline(managerId) {
      return usageBaselines.get(managerId) ?? null;
    },
  };

  return {
    persona,
    journal,
    jobs: jobStore,
    schedules: scheduleStore,
    archive,
    sessions,
    auth,
    profile,
    usage,
  };
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
