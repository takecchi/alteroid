import { deriveMemoryFrontmatter, nextDescribedAt } from './memory.js';
import type {
  Commitment,
  InboxEvent,
  Job,
  JournalEntry,
  JournalEntryInput,
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PendingApproval,
  SchedulePhase,
  ScheduledRequest,
} from './schema.js';
import { schedulePhaseSchema } from './schema.js';
import {
  sha256Hex,
  type AccessTokenRecord,
  type AuthAccount,
  type AuthIdentity,
  type AuthStore,
  type LoginRequest,
} from './auth.js';
import type {
  EnvProfile,
  InboxStore,
  JobStore,
  PendingInboxEvent,
  JournalQuery,
  JournalStore,
  PersonaStore,
  ProfileStore,
  CommitmentStore,
  ScheduleStore,
  SessionRegistry,
  Stores,
  TranscriptArchive,
  UsageStore,
} from './store.js';
import {
  foldOneshotUsage,
  foldUsageSnapshot,
  USAGE_ESTIMATE_NOTICE,
  usageDate,
  ZERO_USAGE,
  type UsageBaseline,
  type UsageLayer,
  type UsageRow,
  type UsageSite,
} from './usage.js';

/**
 * 台帳の行の鍵。**層と場所を鍵から外さないこと。**
 *
 * クローンは自分のセッション本体と要約の蒸留の両方で使うので、同じ actor・同じ日・
 * 同じモデルで意味の違う行が2つ立つ。鍵が足りないと増分が先にある行へ足し込まれ、
 * 層と場所は先に入った側の値のまま残る ＝ 出力から見分けられない誤帰属になる
 * （`@alteroid/storage-fs` の `rowKey` / pg の一意索引と同じ話）。
 */
function usageRowKey(
  date: string,
  managerId: string,
  model: string,
  layer: UsageLayer,
  site: UsageSite,
): string {
  // **区切りもドライバと同じ制御文字にする。** 空白にすると、id に空白を含む actor で
  // この器だけが鍵をぶつける（あるいはぶつけない）＝ 本物と違う結果を静かに返す。
  return `${date}\u0000${managerId}\u0000${model}\u0000${layer}\u0000${site}`;
}

/** 累積の基準の鍵。**主体は「層 × actor」である**（`usage.ts` の `usageBaselineSchema`）。 */
function usageBaselineKey(layer: UsageLayer, managerId: string): string {
  return `${layer}\u0000${managerId}`;
}

/**
 * 照会範囲の一部でも始点より前にかかっていたか（台帳の始点にも層の軸の始点にも使う）。
 *
 * **ドライバと同じ3分岐にすること。** 一度も記録していなければ始まっている期間が
 * そもそも無いので常に真、下限の無い照会（`from` 省略）はその前を含みうるので真、
 * 下限があるときだけ始点の日付と比べる。fs / pg の `isBeforeLedger` と同じ判断で、
 * 器ごとに置いてあるのも同じ理由である（どちらのドライバの内部実装にも属さない補助）。
 */
function isBeforeUsageStart(start: string | null, from: string | undefined): boolean {
  if (start === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(start));
}

/**
 * テスト用のインメモリストア。storage-fs の代わりに core のテストで使う。
 * 本番の配線には出てこない（永続化は必ずドライバ側）。
 */
export function createMemoryStores(): Stores {
  const documents = new Map<string, MemoryDocument>();
  // 保護状態（human guard）の派生値。fs / pg と同じ形（新しい真実ではなく、
  // journal.append(cause:'human') 相当の呼び出しから反映される派生値）。
  const humanTouchedAt = new Map<string, string>();
  const contentSha256 = new Map<string, string>();
  // #170（記憶の目次化）の派生値。fs の `.index.json` / pg の `described_at`
  // 列と同じ形——書き手は書けず、write() が新旧の description を比べて進める。
  const describedAt = new Map<string, string>();
  const entries: JournalEntry[] = [];
  const jobs = new Map<string, Job>();
  const approvals = new Map<string, PendingApproval>();
  const schedules = new Map<string, ScheduledRequest>();
  const schedulePhases = new Map<string, SchedulePhase>();
  const commitments = new Map<string, Commitment>();
  const archives = new Map<string, string>();
  const inboxStore = createMemoryInboxStore();
  let cloneSessionId: string | null = null;
  let envProfile: EnvProfile | null = null;
  let counter = 0;
  const nextId = () => `id-${++counter}`;

  const persona: PersonaStore = {
    async list(): Promise<MemoryDocumentMeta[]> {
      return [...documents.values()]
        .map(({ slug, title, updatedAt, bytes, frontmatter, kind, description, parent, descriptionFreshness }) => ({
          slug,
          title,
          updatedAt,
          bytes,
          frontmatter,
          kind,
          description,
          parent,
          descriptionFreshness,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
    },
    async read(slug) {
      return documents.get(slug) ?? null;
    },
    async write(slug, content) {
      const before = documents.get(slug);
      const updatedAt = new Date().toISOString();
      // **write() と append()（下）の唯一の通り道。** fs / pg と同じく、誰が
      // 書いたかを問わずここでハッシュ・describedAt を更新する。human 印には
      // 触らない。describedAt は書き手が書けない（`nextDescribedAt` の doc）。
      const next = nextDescribedAt({
        priorContent: before?.content ?? null,
        nextContent: content,
        priorDescribedAt: describedAt.get(slug),
        writtenAt: updatedAt,
      });
      if (next === undefined) describedAt.delete(slug);
      else describedAt.set(slug, next);
      const derived = deriveMemoryFrontmatter({ content, updatedAt, describedAt: next });
      const doc: MemoryDocument = {
        slug,
        title: /^#\s+(.+)$/m.exec(content)?.[1] ?? slug,
        updatedAt,
        bytes: Buffer.byteLength(content),
        content,
        frontmatter: derived.frontmatter,
        kind: derived.kind,
        description: derived.description,
        parent: derived.parent,
        descriptionFreshness: derived.descriptionFreshness,
      };
      documents.set(slug, doc);
      contentSha256.set(slug, sha256Hex(content));
      return doc;
    },
    async append(slug, content) {
      const existing = documents.get(slug);
      return persona.write(slug, existing ? `${existing.content}\n${content}` : content);
    },
    async remove(slug) {
      documents.delete(slug);
      // fs / pg と同じく、実体が消えれば派生値も消える（過去に human で書かれた
      // 事実そのものは journal に残るので、backfill が立て直す）。
      humanTouchedAt.delete(slug);
      contentSha256.delete(slug);
      describedAt.delete(slug);
    },
    async protectionStatus(slug): Promise<MemoryProtectionStatus> {
      if (humanTouchedAt.has(slug)) return { kind: 'human' };
      const hash = contentSha256.get(slug);
      if (hash === undefined) return { kind: 'unknown' };
      const doc = documents.get(slug);
      if (doc === undefined) return { kind: 'unknown' };
      return hash === sha256Hex(doc.content) ? { kind: 'clone-only' } : { kind: 'unknown' };
    },
    async markHumanTouched(slug, at) {
      // 実体も索引も無い slug には新しく行を作らない（fs / pg と同じ約束）。
      if (!documents.has(slug) && !humanTouchedAt.has(slug)) return;
      const prior = humanTouchedAt.get(slug);
      if (prior === undefined || at > prior) humanTouchedAt.set(slug, at);
    },
    // **`slug` 昇順で、本文ごと返す。** ここが本物（fs / pg）と同じ順序・同じ中身で
    // ないと、上の層の「どの文書が変わったか」がテストでは確かめられない。
    // かつてここは `concat()` で、しかも本物と違って `<!-- memory: slug.md -->` の
    // 見出しを付けていなかった（AGENTS.md「固定値を返すスタブはテストを緑にしたまま
    // 分岐を殺す」の一例。載せ方が core へ移ったので、この食い違いは構造的に消えた）。
    async documents() {
      const metas = await persona.list();
      const found: MemoryDocument[] = [];
      for (const meta of metas) {
        const doc = documents.get(meta.slug);
        if (doc) found.push(doc);
      }
      return found;
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
    async getPhase(kind) {
      return schedulePhases.get(kind) ?? null;
    },
    async putPhase(phase) {
      // **本物と同じく parse を通す。** 通さないと、この足場でだけ通る形の位相を
      // 書いたテストが緑になり、fs / pg では落ちる（動くのに嘘をつくスタブ）。
      schedulePhases.set(phase.kind, schedulePhaseSchema.parse(phase));
    },
  };

  /**
   * 引き受けたまま終わっていない仕事の台帳。
   *
   * **`open` の冪等性を本物と同じにしてあること。** ここを「常に上書き」にすると、
   * 配り直しで閉じた未了が開き直る壊れ方がテストから見えなくなる（本物の器では
   * 起きるのに、テストは緑のまま通る）。
   */
  const commitmentStore: CommitmentStore = {
    async list(options) {
      const all = [...commitments.values()];
      const open = all
        .filter((entry) => entry.closedAt === undefined)
        .sort((a, b) => a.at.localeCompare(b.at));
      if (options?.includeClosed !== true) return open;
      const closed = all
        .filter((entry) => entry.closedAt !== undefined)
        .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
      return [...open, ...closed];
    },
    async get(id) {
      return commitments.get(id) ?? null;
    },
    async open(entry) {
      if (commitments.has(entry.id)) return false;
      commitments.set(entry.id, entry);
      return true;
    },
    async close(id, at, reason) {
      const existing = commitments.get(id);
      if (!existing || existing.closedAt !== undefined) return false;
      commitments.set(id, { ...existing, closedAt: at, closedReason: reason });
      return true;
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
   * **差分ロジックも鍵の作り方もドライバと共有する** — 差分は
   * `foldUsageSnapshot` / `foldOneshotUsage` を呼び、行の鍵は
   * 日 × actor × モデル × 層 × 場所、基準の鍵は 層 × actor で作る。ここだけ
   * 別の算術や別の鍵を持つと、「テストの器では通るのに本物では二重計上する」
   * というずれ方をする（`@alteroid/storage-fs` の `usage.ts` と同じ形）。
   *
   * **`beforeLedger` / `beforeLayers` の真偽もドライバと同じにすること。**
   * ここが緩いと、テストは緑のまま「記録が無い」と言うべき場面で「0 だった」と
   * 言う実装を通す — #45 の要件そのものが黙って消える。実際に `from` 省略時の
   * `beforeLedger` がドライバ（真）と食い違って偽を返していた。
   */
  const usageRows = new Map<string, UsageRow>();
  const usageBaselines = new Map<string, UsageBaseline>();
  let usageStartedAt: string | null = null;
  let usageLayeredAt: string | null = null;

  const usage: UsageStore = {
    async record({ layer, site, managerId, date, at, snapshot, accumulation }) {
      // 累積の器は `query()` 呼び出しの寿命で閉じる（`usage.ts` の
      // `usageAccumulationSchema`）。1回で閉じる呼び出しに基準を持たせると、
      // 前回より高くついた回だけが差に縮んで黙って目減りする。
      const baseKey = usageBaselineKey(layer, managerId);
      const baseline = accumulation === 'oneshot' ? null : (usageBaselines.get(baseKey) ?? null);
      const fold =
        accumulation === 'oneshot'
          ? foldOneshotUsage(snapshot)
          : foldUsageSnapshot(baseline, snapshot, at);
      // foldUsageSnapshot は基準が無ければ layer / managerId を空で返す
      // （呼び出し側が知っている値を後から入れる契約 — usage.ts 参照）。
      const nextBaseline: UsageBaseline | null =
        fold.baseline === null ? null : { ...fold.baseline, layer, managerId };
      // `oneshot` は基準を持たない。既にある基準を消しもしない
      // （同じ主体が cumulative でも記録していることがある）。
      if (nextBaseline !== null) usageBaselines.set(baseKey, nextBaseline);
      usageStartedAt ??= at;
      // 層の軸の始点も1度だけ。**`usageStartedAt` と揃えて入れない** — 台帳の
      // ほうが先に始まっている器では別の時刻になる。
      usageLayeredAt ??= at;
      for (const [model, delta] of Object.entries(fold.delta)) {
        const key = usageRowKey(date, managerId, model, layer, site);
        const before = usageRows.get(key)?.totals ?? ZERO_USAGE;
        usageRows.set(key, {
          date,
          managerId,
          model,
          layer,
          site,
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
      return { delta: fold.delta, baseline: nextBaseline, reset: fold.reset };
    },
    async aggregate(query) {
      const rows = [...usageRows.values()]
        .filter((row) => {
          if (query.from !== undefined && row.date < query.from) return false;
          if (query.to !== undefined && row.date > query.to) return false;
          if (query.managerId !== undefined && row.managerId !== query.managerId) return false;
          if (query.layer !== undefined && row.layer !== query.layer) return false;
          if (query.site !== undefined && row.site !== query.site) return false;
          return true;
        })
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.managerId.localeCompare(b.managerId) ||
            a.model.localeCompare(b.model) ||
            a.layer.localeCompare(b.layer) ||
            a.site.localeCompare(b.site),
        );
      return {
        rows,
        since: usageStartedAt,
        layersSince: usageLayeredAt,
        // 台帳が始まる前を照会されたら、0 ではなく「記録が無い」と言えるように。
        beforeLedger: isBeforeUsageStart(usageStartedAt, query.from),
        // 層の軸が始まる前の行の layer / site は既定値であって観測ではない。
        beforeLayers: isBeforeUsageStart(usageLayeredAt, query.from),
        notice: USAGE_ESTIMATE_NOTICE,
      };
    },
    async baseline(layer, managerId) {
      return usageBaselines.get(usageBaselineKey(layer, managerId)) ?? null;
    },
  };

  return {
    persona,
    journal,
    jobs: jobStore,
    schedules: scheduleStore,
    commitments: commitmentStore,
    inbox: inboxStore,
    archive,
    sessions,
    auth,
    profile,
    usage,
  };
}

/**
 * 未読の受信箱をインメモリで持つ器。
 *
 * **「プロセスが死ぬ」をテストで再現するための土台**でもある。`Clone` を捨てて
 * 同じ `Stores` から作り直せば、器だけが入れ替わった再起動と同じ形になる
 * （ここを `Clone` の内側に持たせると、その再現ができなくなる）。
 */
function createMemoryInboxStore(): InboxStore {
  const unread = new Map<string, PendingInboxEvent>();

  return {
    async put(event: InboxEvent, at: string): Promise<void> {
      // 配達回数は保つ（本文だけを差し替える）。
      const deliveries = unread.get(event.id)?.deliveries ?? 0;
      unread.set(event.id, { event, at, deliveries });
    },
    async remove(id: string): Promise<void> {
      unread.delete(id);
    },
    async claimPending(): Promise<PendingInboxEvent[]> {
      const rows = [...unread.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      // 読むことと回数を進めることを1操作に閉じる（`InboxStore.claimPending`）。
      return rows.map((row) => {
        const next = { ...row, deliveries: row.deliveries + 1 };
        unread.set(row.event.id, next);
        return next;
      });
    },
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

/**
 * `process.stderr` へ出た行を集める。
 *
 * 記録の書き込みに失敗したときの跡は stderr にしか出ない（本文をログへ
 * 落とさないため、日誌にもストアにも残せない）。**そこを見る手段が無いと、
 * 「黙って消える」に戻っていても誰も気づけない。**
 *
 * 差し替えは `finally` で必ず戻すこと。戻し忘れると以降のテストの出力が
 * 丸ごと消え、失敗の理由が読めなくなる。
 */
export async function captureStderr(body: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

/**
 * 特定のストア操作だけを失敗させる。
 *
 * 片付けの途中（ストアを閉じた後）に書き込みが落ちる形を、実際に閉じずに
 * 再現するためのもの。**読みは通す** — 読みまで落とすと、起動そのものが
 * 失敗して「書けなかったときどうなるか」を見られない。
 */
export function failingJournalAppend(stores: Stores, reason: string): Stores {
  return {
    ...stores,
    journal: {
      ...stores.journal,
      append: () => Promise.reject(new Error(reason)),
    },
  };
}

/**
 * 未読の書き出しだけを失敗させる（読み直しと消し込みは通す）。
 *
 * ここが落ちても `post` は落ちてはいけない — 未読を書けないことでその合図の処理
 * まで止めたら、いま塞いでいる穴より広い穴になる。跡は stderr にしか出ない。
 */
export function failingInboxPut(stores: Stores, reason: string): Stores {
  return {
    ...stores,
    inbox: {
      ...stores.inbox,
      put: () => Promise.reject(new Error(reason)),
    },
  };
}

/** ジョブ台帳の書き込みだけを失敗させる（読みは通す）。 */
export function failingJobWrite(stores: Stores, reason: string): Stores {
  return {
    ...stores,
    jobs: {
      ...stores.jobs,
      putJob: () => Promise.reject(new Error(reason)),
    },
  };
}
