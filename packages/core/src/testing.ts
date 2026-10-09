import { MemoryAttachmentStore } from './attachment-memory.js';
import {
  classifyArchiveContinuity,
  fingerprintArchiveBody,
  tallyArchiveContinuity,
  type ArchiveContinuity,
} from './archive-continuity.js';
import { compareCodeUnits } from './code-unit-order.js';
import { assertArchivableSessionId } from './archive-session-id.js';
import { setStderrSinkForTesting } from './dropped-record.js';
import { tailByCodePoints } from './excerpt.js';
import { deriveMemoryFrontmatter, nextDescribedState } from './memory.js';
import { listPageByOverfetch } from './journal-page.js';
import { matchesJournalSearch } from './journal-search.js';
import { compareIsoInstant, earliestIsoInstant } from './iso-instant.js';
import type { ConversationReadPosition } from './conversation-read.js';
import type { CodexChatgptAuthRecord, CodexChatgptAuthStore } from './codex-chatgpt-auth.js';
import type {
  Commitment,
  CommitmentClosedBy,
  CommitmentEditedBy,
  InboxEvent,
  Job,
  JournalEntry,
  JournalEntryInput,
  MemoryCreatedAt,
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PendingApproval,
  PermissionGrant,
  Practice,
  PracticeVersion,
  SchedulePhase,
  ScheduledRequest,
} from './schema.js';
import {
  McpServersConflictError,
  mcpServersVersionOf,
  parseMcpServers,
  prepareMcpServersForWrite,
  sortMcpServers,
  type StoredMcpServers,
} from './mcp-servers.js';
import {
  isValidPluginName,
  parsePluginInput,
  parseStoredPlugin,
  PluginNameConflictError,
  pluginNamesCollide,
  pluginSummaryOf,
  sortPluginSummaries,
  type StoredPlugin,
} from './plugins.js';
import {
  commitmentSchema,
  inboxEventSchema,
  jobSchema,
  journalEntrySchema,
  memorySlugSchema,
  pendingApprovalSchema,
  permissionGrantSchema,
  practiceSchema,
  practiceVersionSchema,
  scheduledRequestSchema,
  schedulePhaseSchema,
} from './schema.js';
import {
  accessTokenRecordSchema,
  authAccountSchema,
  authIdentitySchema,
  loginRequestSchema,
  sha256Hex,
  type AccessTokenRecord,
  type AuthAccount,
  type AuthIdentity,
  type AuthStore,
  type LoginRequest,
} from './auth.js';
import {
  prepareAccessTokenForWrite,
  prepareAccountForWrite,
  prepareIdentityForWrite,
  prepareLoginRequestForWrite,
} from './auth-input.js';
import {
  compareIntegrationKeyOrder,
  integrationKeyRecordSchema,
  prepareIntegrationKeyForWrite,
  type IntegrationKeyRecord,
  type IntegrationKeyStore,
} from './integration-key.js';
import type {
  CredentialVaultStore,
  EnvProfileEntry,
  InboxPeek,
  InboxStore,
  JobStore,
  McpServerStore,
  PluginStore,
  ConversationReadStore,
  PendingInboxEvent,
  JournalQuery,
  JournalStore,
  PersonaStore,
  PermissionGrantStore,
  ProfileStore,
  CommitmentStore,
  PracticeStore,
  ScheduleStore,
  LostSessionGrave,
  SessionRegistry,
  TranscriptGrave,
  Stores,
  StoredCredential,
  TokenPoolStore,
  ArchiveEntry,
  ArchiveSessionSummary,
  ArchiveWrite,
  TranscriptArchive,
  UsageStore,
} from './store.js';
import {
  CommitmentConflictError,
  commitmentVersionMatches,
  compareProfileEntryNames,
  ensureTrailingNewline,
  findOpenManagerDuplicate,
  JournalAnchorNotFoundError,
  MemoryConflictError,
  memoryVersionMatches,
  PracticeConflictError,
  practiceVersionMatches,
  ScheduleConflictError,
  scheduleVersionMatches,
} from './store.js';
import {
  activeAgentTokenSchema,
  agentTokenSchema,
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  tokenRotationSettingsSchema,
  type ActiveAgentToken,
  type AgentToken,
  type TokenRotationSettings,
} from './token-pool.js';
import { assertValidCredentialEntries } from './credential-input.js';
import {
  stripNulFromUnmeteredRecord,
  stripNulFromUsageQuery,
  stripNulFromUsageRecord,
} from './usage-input.js';
import { assertNoNul, hasNul, stripNul, stripNulDeep } from './nul-guard.js';
import { prepareApprovalForWrite, prepareJobForWrite } from './job-input.js';
import { preparePermissionGrantForPut } from './permission-grant-input.js';
import { assertProfileRowWritable } from './profile-input.js';
import { assertValidActiveToken, prepareTokensForReplace } from './token-pool-input.js';
import {
  addUnreadableCounts,
  foldRecordForStore,
  USAGE_ESTIMATE_NOTICE,
  usageDate,
  ZERO_USAGE,
  type UsageBaseline,
  type UsageLayer,
  type UsageRow,
  type UsageSite,
  type UsageTurnRow,
  type UsageUnmeteredRow,
} from './usage.js';

/** 層と場所を鍵から外さない: 同じ actor・日・モデルで意味の違う行が足し込まれ、誤帰属になる。 */
function usageRowKey(
  date: string,
  managerId: string,
  model: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  // 区切りは制御文字、トークンも鍵に入れる（ドライバと同じ）: 変えるとこの器だけ鍵の衝突が本物と違う。
  return `${date}\u0000${managerId}\u0000${model}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

function usageBaselineKey(layer: UsageLayer, managerId: string): string {
  return `${layer}\u0000${managerId}`;
}

function usageTurnKey(
  date: string,
  managerId: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  return `${date}\u0000${managerId}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

/** ドライバ（fs / pg の `isBeforeLedger`）と同じ3分岐にする: 器だけ違う判断をすると本物と違う結果を返す。 */
function isBeforeUsageStart(start: string | null, from: string | undefined): boolean {
  if (start === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(start));
}

/** `TranscriptArchive` にメソッドを足さない: 足すと3実装すべてに要る。この裏口は `seedFingerprintlessArchiveRow` 専用。 */
const archiveInternalsRegistry = new WeakMap<
  TranscriptArchive,
  {
    archives: Map<string, string>;
    archiveMeta: Map<
      string,
      {
        sessionId: string;
        at: string;
        seq: number;
        bodyChars?: number;
        bodyMd5?: string;
        continuity?: ArchiveContinuity;
      }
    >;
  }
>();

/** 指紋を持たない行を直接登録する。`archive()` 経由だと必ず指紋が付くので、指紋導入前の既存行の再現にはこの口が要る。 */
export async function seedFingerprintlessArchiveRow(
  archive: TranscriptArchive,
  sessionId: string,
  body: string,
): Promise<string> {
  const internals = archiveInternalsRegistry.get(archive);
  if (internals === undefined) {
    throw new Error(
      'seedFingerprintlessArchiveRow: createMemoryStores() が作ったインメモリ実装ではない',
    );
  }
  const id = `${sessionId}-fingerprintless-${internals.archiveMeta.size}`;
  internals.archives.set(id, body);
  // bodyChars / bodyMd5 / continuity を入れない: 指紋の無い行を作るのが目的。
  internals.archiveMeta.set(id, {
    sessionId,
    at: new Date().toISOString(),
    seq: internals.archiveMeta.size,
  });
  return id;
}

/** テスト用のインメモリストア。本番の配線には出ない。 */
export function createMemoryStores(): Stores {
  const documents = new Map<string, MemoryDocument>();
  const humanTouchedAt = new Map<string, string>();
  const contentSha256 = new Map<string, string>();
  const describedAt = new Map<string, string>();
  // `describedAt` と必ず同時に進むわけではない: 本文だけの書き込みでも基準点が無ければ立つ。
  const describedBytes = new Map<string, number>();
  const describedBytesAt = new Map<string, string>();
  // 「unknown」という値を書き込まない: 値が無い行は素の optional のまま `read()` / `list()` が組み立てる。
  const createdAtStore = new Map<string, string>();
  const entries: JournalEntry[] = [];
  const jobs = new Map<string, Job>();
  const approvals = new Map<string, PendingApproval>();
  const permissionGrantRows = new Map<string, PermissionGrant>();
  const schedules = new Map<string, ScheduledRequest>();
  const schedulePhases = new Map<string, SchedulePhase>();
  const commitments = new Map<string, Commitment>();
  const practices = new Map<string, Practice>();
  // `practices` の削除に連動しない: `remove()` 後も配列を切り詰めず、番号は消える前の続きから振る。
  const practiceVersions = new Map<string, PracticeVersion[]>();
  const archives = new Map<string, string>();
  const archiveRemovals = new Map<string, { removedAt: string; bytes: number }>();
  // 本文（`archives`）とは別に持つ: tombstone で本文が空になっても `sessionId` と `at` は残る。
  const archiveMeta = new Map<
    string,
    {
      sessionId: string;
      at: string;
      seq: number;
      bodyChars?: number;
      bodyMd5?: string;
      continuity?: ArchiveContinuity;
    }
  >();
  const inboxStore = createMemoryInboxStore();
  let cloneSessionId: string | null = null;
  let transcriptGrave: TranscriptGrave | null = null;
  let lostSessionGrave: LostSessionGrave | null = null;
  let projectKey: string | null = null;
  let envProfile = new Map<string, EnvProfileEntry>();
  let storedMcpServers: StoredMcpServers | null = null;
  let counter = 0;
  const nextId = () => `id-${++counter}`;

  const toMemoryCreatedAt = (at: string | undefined): MemoryCreatedAt =>
    at === undefined ? { kind: 'unknown' } : { kind: 'known', at };

  /** 本物と同じ slug 検査を全メソッドに掛ける（文言も同じ）: 外すと本物で例外になる入力を「書けた」として通す。 */
  const checkMemorySlug = (slug: string): void => {
    if (!memorySlugSchema.safeParse(slug).success) throw new Error(`記憶のスラッグが不正: ${slug}`);
  };

  const persona: PersonaStore = {
    async list(): Promise<MemoryDocumentMeta[]> {
      return [...documents.values()]
        .map(
          ({
            slug,
            title,
            updatedAt,
            bytes,
            frontmatter,
            kind,
            description,
            parent,
            descriptionFreshness,
          }) => ({
            slug,
            title,
            updatedAt,
            // 書き込み時にキャッシュしない: `markCreatedAt` が write() の後に反映されても読み出しに出るようにする。
            createdAt: toMemoryCreatedAt(createdAtStore.get(slug)),
            bytes,
            frontmatter,
            kind,
            description,
            parent,
            descriptionFreshness,
          }),
        )
        .sort((a, b) => compareCodeUnits(a.slug, b.slug));
    },
    async read(slug) {
      checkMemorySlug(slug);
      const doc = documents.get(slug);
      if (doc === undefined) return null;
      return { ...doc, createdAt: toMemoryCreatedAt(createdAtStore.get(slug)) };
    },
    async write(slug, content, options) {
      checkMemorySlug(slug);
      const before = documents.get(slug);
      if (!memoryVersionMatches(before ?? null, options?.ifMatch)) {
        throw new MemoryConflictError(
          slug,
          before === undefined
            ? null
            : { ...before, createdAt: toMemoryCreatedAt(createdAtStore.get(slug)) },
        );
      }
      const updatedAt = new Date().toISOString();
      // 正規化は `PersonaStore.write` の契約（`store.ts`）: 派生値（title / bytes / 要旨 / ハッシュ）も
      // 正規化後の本文から作る。正規化前の長さで `bytes` を数えると fs の `stats.size` と1バイトずれる。
      const body = ensureTrailingNewline(stripNul(content));
      // `createdAt` は文書を作った書き込みでだけ、一度だけ立てる（`markCreatedAt` の backfill とは別）。
      if (before === undefined && !createdAtStore.has(slug)) createdAtStore.set(slug, updatedAt);
      const writtenBytes = Buffer.byteLength(body);
      const next = nextDescribedState({
        priorContent: before?.content ?? null,
        nextContent: body,
        priorDescribedAt: describedAt.get(slug),
        priorDescribedBytes: describedBytes.get(slug),
        priorDescribedBytesAt: describedBytesAt.get(slug),
        priorBytes: before?.bytes,
        priorUpdatedAt: before?.updatedAt,
        writtenAt: updatedAt,
        writtenBytes,
      });
      if (next.describedAt === undefined) describedAt.delete(slug);
      else describedAt.set(slug, next.describedAt);
      if (next.describedBytes === undefined) describedBytes.delete(slug);
      else describedBytes.set(slug, next.describedBytes);
      if (next.describedBytesAt === undefined) describedBytesAt.delete(slug);
      else describedBytesAt.set(slug, next.describedBytesAt);
      const derived = deriveMemoryFrontmatter({
        content: body,
        updatedAt,
        describedAt: next.describedAt,
        describedBytes: next.describedBytes,
        describedBytesAt: next.describedBytesAt,
        currentBytes: writtenBytes,
      });
      const doc: MemoryDocument = {
        slug,
        title: /^#\s+(.+)$/m.exec(body)?.[1] ?? slug,
        updatedAt,
        createdAt: toMemoryCreatedAt(createdAtStore.get(slug)),
        bytes: writtenBytes,
        content: body,
        frontmatter: derived.frontmatter,
        kind: derived.kind,
        description: derived.description,
        parent: derived.parent,
        descriptionFreshness: derived.descriptionFreshness,
      };
      documents.set(slug, doc);
      contentSha256.set(slug, sha256Hex(body));
      return doc;
    },
    async append(slug, content) {
      checkMemorySlug(slug);
      const existing = documents.get(slug);
      // `ensureTrailingNewline` を外さない: `write` の正規化と重複して見えるが、fs / pg と同じ二重の守りに揃えてある。
      return persona.write(
        slug,
        existing ? `${ensureTrailingNewline(existing.content)}\n${content}` : content,
      );
    },
    async remove(slug, options) {
      checkMemorySlug(slug);
      const before = documents.get(slug);
      if (!memoryVersionMatches(before ?? null, options?.ifMatch)) {
        throw new MemoryConflictError(
          slug,
          before === undefined
            ? null
            : { ...before, createdAt: toMemoryCreatedAt(createdAtStore.get(slug)) },
        );
      }
      documents.delete(slug);
      humanTouchedAt.delete(slug);
      contentSha256.delete(slug);
      describedAt.delete(slug);
      describedBytes.delete(slug);
      describedBytesAt.delete(slug);
      createdAtStore.delete(slug);
    },
    async protectionStatus(slug): Promise<MemoryProtectionStatus> {
      checkMemorySlug(slug);
      if (humanTouchedAt.has(slug)) return { kind: 'human' };
      const hash = contentSha256.get(slug);
      if (hash === undefined) return { kind: 'unknown' };
      const doc = documents.get(slug);
      if (doc === undefined) return { kind: 'unknown' };
      return hash === sha256Hex(doc.content) ? { kind: 'clone-only' } : { kind: 'unknown' };
    },
    async markHumanTouched(slug, at) {
      checkMemorySlug(slug);
      if (!documents.has(slug) && !humanTouchedAt.has(slug)) return;
      const prior = humanTouchedAt.get(slug);
      if (prior === undefined || at > prior) humanTouchedAt.set(slug, at);
    },
    async markCreatedAt(slug, at) {
      checkMemorySlug(slug);
      if (!documents.has(slug) && !createdAtStore.has(slug)) return false;
      if (createdAtStore.has(slug)) return false;
      createdAtStore.set(slug, at);
      return true;
    },
    async documents() {
      const metas = await persona.list();
      const found: MemoryDocument[] = [];
      for (const meta of metas) {
        // `read()` を通す: `documents` の生キャッシュには `markCreatedAt` 後の `createdAt` が乗らない。
        const doc = await persona.read(meta.slug);
        if (doc) found.push(doc);
      }
      return found;
    },
    async clear() {
      const removed = documents.size;
      documents.clear();
      humanTouchedAt.clear();
      contentSha256.clear();
      describedAt.clear();
      describedBytes.clear();
      describedBytesAt.clear();
      createdAtStore.clear();
      return removed;
    },
  };

  // 墓標の集合は積んだ行から導く: 別に持つと `clear()` と食い違う。
  const deletedConversationIds = (): Set<string> =>
    new Set(
      entries.flatMap((entry) =>
        entry.type === 'conversation_deleted' ? [entry.deletedConversationId] : [],
      ),
    );

  const journal: JournalStore = {
    async append(input: JournalEntryInput) {
      const entry = journalEntrySchema.parse({
        ...stripNulDeep(input),
        id: nextId(),
        at: new Date().toISOString(),
      });
      entries.push(entry);
      // 写しを返す: 呼び出し元の書き換えで店が汚れるのは fs / pg と違う。
      return isolate(entry);
    },
    async list(query: JournalQuery = {}) {
      // `order` は全順序を決めるところで最初に効かせる: 既定 `desc` は push の逆順、`asc` は push 順そのまま。
      // 件数で切る（下の slice）より後だと反対側の端を切る。
      const order = query.order ?? 'desc';
      let found = (order === 'desc' ? [...entries].reverse() : [...entries]).map(isolate);
      const tombstoned = deletedConversationIds();

      // `after` は絞り込みより前に効かせる: 錨の位置は絞り込み前の全順序で決める。見つからなければ黙って先頭から返さず投げる。
      if (query.after !== undefined) {
        const after = query.after;
        const anchorIndex = found.findIndex(
          (entry) => entry.id === after.id && entry.at === after.at,
        );
        if (anchorIndex === -1) {
          throw new JournalAnchorNotFoundError(
            `after で指定された行（id=${after.id}, at=${after.at}）が見つからない`,
          );
        }
        found = found.slice(anchorIndex + 1);
      }

      if (query.types) found = found.filter((entry) => query.types?.includes(entry.type));
      // 墓標のある会話の `exchange` は `limit` より前で外す: 後ろで外すと窓が短くなり `reachedStart` が誤る。
      found = found.filter(
        (entry) =>
          !(
            entry.type === 'exchange' &&
            entry.conversationId !== undefined &&
            tombstoned.has(entry.conversationId)
          ),
      );
      // `with` は `limit` より前で効かせる。
      if (query.with !== undefined) {
        const withValues = query.with;
        found = found.filter(
          (entry) => entry.type === 'exchange' && withValues.includes(entry.with),
        );
      }
      // 照合は `journal-search.ts` に任せる: 欄の選び方をここへ書き写すと3実装の答えがずれる。
      if (query.q !== undefined) {
        const q = query.q;
        found = found.filter((entry) => matchesJournalSearch(entry, q));
      }
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
    async listPage(query: JournalQuery = {}) {
      return listPageByOverfetch(journal, query);
    },
    async get(id: string) {
      const found = entries.find((entry) => entry.id === id) ?? null;
      if (
        found?.type === 'exchange' &&
        found.conversationId !== undefined &&
        deletedConversationIds().has(found.conversationId)
      ) {
        return null;
      }
      return found;
    },
    async oldestAt() {
      return entries[0]?.at ?? null;
    },
    async clear() {
      const removed = entries.length;
      entries.length = 0;
      return removed;
    },
  };

  /**
   * 境界で写しを取る: fs / pg は JSON を経由して必ず写しになるので、参照を返すと本番でだけ壊れるバグを歯が通す
   * （契約は `store-isolation-contract.ts`）。`JSON.parse(JSON.stringify(...))` にしない:
   * `undefined` の欄が落ち、「無い」と「undefined として在る」の区別が偽物の側だけで消える。
   */
  const isolate = <T>(value: T): T => structuredClone(value);

  const jobStore: JobStore = {
    async listJobs() {
      return [...jobs.values()].map(isolate);
    },
    async listUnreadableJobs() {
      return [];
    },
    async putJob(job) {
      jobs.set(job.id, isolate(prepareJobForWrite(jobSchema.parse(job))));
    },
    // 判定と書き込みのあいだに `await` を挟まない: 同期の `Map` なので、これで fs / pg の排他の代わりになる。
    async updateJob(id, mutate) {
      const found = jobs.get(id);
      if (found === undefined) return null;
      // `mutate` へは写しを渡す: 引数をその場で書き換えて返す形で `parse` が投げても `Map` を汚さない。
      const next = prepareJobForWrite(jobSchema.parse(mutate(isolate(found))));
      jobs.set(id, isolate(next));
      return isolate(next);
    },
    async listApprovals(options = {}) {
      const all = [...approvals.values()].map(isolate);
      // `unreadable` は絞らない。
      const pending = options.pendingOnly
        ? all.filter((a) => a.answeredAt === undefined && a.withdrawnAt === undefined)
        : all;
      return {
        entries:
          options.conversationId === undefined
            ? pending
            : pending.filter((a) => a.conversationId === options.conversationId),
        unreadable: [],
      };
    },
    async getApproval(id) {
      const found = approvals.get(id);
      return found === undefined ? null : isolate(found);
    },
    // 並びは `Map` の挿入順で、pg の `createdAt` 昇順とは違う: 呼び出し側は `order` を明示して揃える。
    async putApproval(approval) {
      approvals.set(
        approval.id,
        isolate(prepareApprovalForWrite(pendingApprovalSchema.parse(approval))),
      );
    },
    async updateApproval(id, mutate) {
      const found = approvals.get(id);
      if (found === undefined) return null;
      const next = mutate(isolate(found));
      if (next === null) return null;
      const parsed = prepareApprovalForWrite(pendingApprovalSchema.parse(next));
      approvals.set(id, isolate(parsed));
      return isolate(parsed);
    },
    async clear() {
      const removed = { jobs: jobs.size, approvals: approvals.size };
      jobs.clear();
      approvals.clear();
      return removed;
    },
  };

  const scheduleStore: ScheduleStore = {
    async list() {
      return {
        entries: [...schedules.values()]
          .sort((a, b) => compareCodeUnits(a.kind, b.kind))
          .map(isolate),
        unreadable: [],
      };
    },
    async get(kind) {
      const found = schedules.get(kind);
      return found === undefined ? null : isolate(found);
    },
    async put(entry, options) {
      const current = schedules.get(entry.kind);
      if (!scheduleVersionMatches(current ?? null, options?.ifMatch)) {
        throw new ScheduleConflictError(
          entry.kind,
          current === undefined ? null : isolate(current),
        );
      }
      schedules.set(
        entry.kind,
        isolate(scheduledRequestSchema.parse({ ...entry, request: stripNul(entry.request) })),
      );
    },
    async remove(kind) {
      schedules.delete(kind);
    },
    async removeIfPresent(kind) {
      // `'unreadable'` を返さない: `Map` には `parse` を通った値しか入らない。
      const found = schedules.get(kind);
      if (found === undefined) return null;
      schedules.delete(kind);
      return isolate(found);
    },
    async editRequest(kind, changes, updatedAt, options) {
      const found = schedules.get(kind);
      if (!scheduleVersionMatches(found ?? null, options?.ifMatch)) {
        throw new ScheduleConflictError(kind, found === undefined ? null : isolate(found));
      }
      if (!found) return null;
      const next = scheduledRequestSchema.parse({
        ...found,
        request: stripNul(changes.request),
        spec: changes.spec,
        updatedAt,
      });
      schedules.set(kind, next);
      return isolate(next);
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
      assertNoNul('schedulePhase.kind', phase.kind);
      // parse を外さない: この足場でだけ通る形の位相を書いたテストが緑になり、fs / pg では落ちる。
      schedulePhases.set(phase.kind, schedulePhaseSchema.parse(phase));
    },
    async clear() {
      const removed = { schedules: schedules.size, phases: schedulePhases.size };
      schedules.clear();
      schedulePhases.clear();
      return removed;
    },
  };

  // `open` の冪等性を本物と同じにする: 「常に上書き」だと、配り直しで閉じた未了が開き直る壊れ方がテストから見えない。
  const commitmentStore: CommitmentStore = {
    async list(options) {
      const all = [...commitments.values()].map(isolate);
      const open = all
        .filter((entry) => entry.closedAt === undefined)
        // 実時刻で比べる: 文字列比較だとオフセット表記の違う行で pg の `asc(at)` と並びが食い違う
        .sort((a, b) => compareIsoInstant(a.at, b.at));
      // `unreadable` は常に空: ここは `commitmentSchema.parse` を経た行しか持たない。
      // `trimmedClosed` も常に `0`: 保持上限も削除経路も無い（fs だけが `CLOSED_HISTORY_LIMIT` を超えた行を消す）。
      // fs だけを踏む歯はこの偽物では書けない。
      if (options?.includeClosed !== true)
        return { entries: open, unreadable: [], trimmedClosed: 0 };
      const closed = all
        .filter((entry) => entry.closedAt !== undefined)
        .sort((a, b) => compareIsoInstant(b.closedAt ?? '', a.closedAt ?? ''));
      return { entries: [...open, ...closed], unreadable: [], trimmedClosed: 0 };
    },
    async get(id) {
      const found = commitments.get(id);
      return found === undefined ? null : isolate(found);
    },
    // 判定と書き込みのあいだに `await` を挟まない: 原子なのは同期のまま書くからで、挟むと2つの `Clone` のあいだで競合が生まれる。
    async open(entry) {
      // id（鍵）の NUL は断り、本文と source（鍵ではない）は落として残す。
      assertNoNul('commitment.id', entry.id);
      const parsed = commitmentSchema.parse({
        ...entry,
        body: stripNul(entry.body),
        ...(entry.source === undefined ? {} : { source: stripNul(entry.source) }),
      });
      if (commitments.has(parsed.id)) return { opened: false, folded: false };
      const duplicate = findOpenManagerDuplicate([...commitments.values()], parsed);
      if (duplicate !== undefined) return { opened: false, folded: true, foldedInto: duplicate.id };
      commitments.set(parsed.id, isolate(parsed));
      return { opened: true, folded: false };
    },
    async close(id, at, reason, by: CommitmentClosedBy) {
      const existing = commitments.get(id);
      if (!existing || existing.closedAt !== undefined) return false;
      commitments.set(id, {
        ...existing,
        closedAt: at,
        closedReason: stripNul(reason),
        closedBy: by,
      });
      return true;
    },
    // 実際に閉じた id だけを返す。重複 id は `Set` で畳む（`CommitmentStore.closeMany` の doc）。
    async closeMany(ids: readonly string[], at, reason, by: CommitmentClosedBy) {
      const closedIds: string[] = [];
      for (const id of new Set(ids)) {
        const existing = commitments.get(id);
        if (!existing || existing.closedAt !== undefined) continue;
        commitments.set(id, {
          ...existing,
          closedAt: at,
          closedReason: stripNul(reason),
          closedBy: by,
        });
        closedIds.push(id);
      }
      return closedIds;
    },
    // `origin` の判定はしない: 呼び出し側（`PATCH /commitments/:id`）が確かめてから呼ぶ（`CommitmentStore.editBody` の doc）。
    async editBody(id, body, at, by: CommitmentEditedBy, options) {
      const existing = commitments.get(id);
      if (!existing && options?.ifMatch !== undefined) throw new CommitmentConflictError(id, null);
      if (!existing || existing.closedAt !== undefined) return false;
      if (!commitmentVersionMatches(existing, options?.ifMatch)) {
        throw new CommitmentConflictError(id, isolate(existing));
      }
      commitments.set(id, { ...existing, body: stripNul(body), editedAt: at, editedBy: by });
      return true;
    },
    async removeForConversation(conversationId) {
      if (hasNul(conversationId)) return 0;
      let removed = 0;
      for (const [id, entry] of [...commitments]) {
        if (entry.origin === 'human' && entry.source === conversationId) {
          commitments.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    async clear() {
      const removed = commitments.size;
      commitments.clear();
      return removed;
    },
  };

  /**
   * 並びは `compareArchiveEntriesNewestFirst`（`archive-id.ts`）と同じ規則（同着は `sessionId` 昇順、
   * 同じセッションなら積んだ順の降順）。共有の関数を使わない: 同じセッション内の同着を `archiveIdBranch` で決められない。
   * `storedBytes` は文字列長で、fs / pg とは単位が違う。
   */
  const buildArchiveEntries = (): ArchiveEntry[] =>
    [...archives.entries()]
      .flatMap(([id, body]) => {
        const meta = archiveMeta.get(id);
        if (meta === undefined) return [];
        const removal = archiveRemovals.get(id);
        const entry: ArchiveEntry = {
          id,
          sessionId: meta.sessionId,
          at: meta.at,
          storedBytes: body.length,
          ...(removal === undefined
            ? {}
            : { removedAt: removal.removedAt, removedBytes: removal.bytes }),
          ...(meta.continuity === undefined ? {} : { continuity: meta.continuity }),
        };
        return [{ entry, seq: meta.seq }];
      })
      .sort((x, y) => {
        if (x.entry.at !== y.entry.at) return x.entry.at < y.entry.at ? 1 : -1;
        if (x.entry.sessionId !== y.entry.sessionId) {
          return x.entry.sessionId < y.entry.sessionId ? -1 : 1;
        }
        return y.seq - x.seq;
      })
      .map(({ entry }) => entry);

  // `removedAt` で絞らない: tombstone された行の指紋も当時の本文を表す。
  const findPreviousArchiveForSession = (
    sessionId: string,
  ): { id: string; bodyChars?: number; bodyMd5?: string } | null => {
    let best: { id: string; at: string; seq: number; bodyChars?: number; bodyMd5?: string } | null =
      null;
    for (const [id, meta] of archiveMeta) {
      if (meta.sessionId !== sessionId) continue;
      if (best === null || meta.at > best.at || (meta.at === best.at && meta.seq > best.seq)) {
        best = { id, at: meta.at, seq: meta.seq, bodyChars: meta.bodyChars, bodyMd5: meta.bodyMd5 };
      }
    }
    return best === null ? null : { id: best.id, bodyChars: best.bodyChars, bodyMd5: best.bodyMd5 };
  };

  const archive: TranscriptArchive = {
    /** 「直前を引く → 判定する → 書く」のあいだに `await` を挟まない: 排他の仕組みは無く、同期の区間だから並行 `archive()` が同じ「直前」を見ない。 */
    async archive(sessionId, transcript): Promise<ArchiveWrite> {
      assertArchivableSessionId(sessionId);
      // id は `archiveIdBranch` が解析できる形（枝番は空いている最小の番号）にする: `${sessionId}-id-${n}` だと同着が字面で決まり `id-10 < id-9` になる。
      const at = new Date().toISOString();
      const base = `${sessionId}-${at.replace(/[:.]/g, '-')}`;
      let id = `${base}.jsonl`;
      for (let attempt = 2; archives.has(id); attempt += 1) id = `${base}-${attempt}.jsonl`;
      const previous = findPreviousArchiveForSession(sessionId);
      const fingerprint = fingerprintArchiveBody(transcript);
      const { continuity, comparedTo } = classifyArchiveContinuity(previous, transcript);
      // 本文の NUL は落とすが、指紋と連続性は生の本文で取る（pg と同じ）。
      archives.set(id, stripNul(transcript));
      archiveMeta.set(id, {
        sessionId,
        at,
        seq: archiveMeta.size,
        bodyChars: fingerprint.bodyChars,
        bodyMd5: fingerprint.bodyMd5,
        continuity,
      });
      return { id, continuity, ...(comparedTo === undefined ? {} : { comparedTo }) };
    },
    async list(): Promise<ArchiveEntry[]> {
      return buildArchiveEntries();
    },
    async sessions(): Promise<ArchiveSessionSummary[]> {
      const bySessionId = new Map<string, ArchiveEntry[]>();
      for (const entry of buildArchiveEntries()) {
        const group = bySessionId.get(entry.sessionId);
        if (group === undefined) bySessionId.set(entry.sessionId, [entry]);
        else group.push(entry);
      }
      const summaries = [...bySessionId.entries()].map(([sessionId, entries]) => {
        const storedBytesList = entries.map((e) => e.storedBytes);
        const atList = entries.map((e) => e.at);
        return {
          sessionId,
          rows: entries.length,
          storedBytes: storedBytesList.reduce((sum, n) => sum + n, 0),
          maxStoredBytes: Math.max(...storedBytesList),
          firstAt: atList.reduce((min, at) => (at < min ? at : min)),
          lastAt: atList.reduce((max, at) => (at > max ? at : max)),
          continuity: tallyArchiveContinuity(entries.map((e) => e.continuity)),
        };
      });
      return summaries.sort(
        (x, y) =>
          y.storedBytes - x.storedBytes ||
          (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0),
      );
    },
    async read(id) {
      // 印（`archiveRemovals`）を先に見る: 本文の中身で判定しない。空の生ログと「消された」を区別できなくなる。
      const removal = archiveRemovals.get(id);
      if (removal !== undefined) return { kind: 'removed', ...removal };
      const body = archives.get(id);
      if (body === undefined) return { kind: 'missing' };
      return { kind: 'body', body };
    },
    // `maxChars` は UTF-16 の `length` / `slice` で数えない: pg の `right()` はコードポイント数で、絵文字で食い違い孤立サロゲートも作る。`tailByCodePoints` に寄せる。
    // 切り詰めるときは `maxChars + 1` を返す（ちょうどにしない）: 呼び出し側の `tailOf` が「切り詰め済み」を「もとから短い」と誤読し、行の途中の窓が蒸留へ渡る（`readTail` interface doc）。
    async readTail(id, maxChars) {
      if (!Number.isInteger(maxChars) || maxChars <= 0) {
        throw new Error(
          `archive.readTail(): maxChars は正の整数でなければならない（渡された値: ${String(maxChars)}）`,
        );
      }
      const removal = archiveRemovals.get(id);
      if (removal !== undefined) return { kind: 'removed', ...removal };
      const body = archives.get(id);
      if (body === undefined) return { kind: 'missing' };
      return { kind: 'body', body: tailByCodePoints(body, maxChars + 1) };
    },
    async remove(id) {
      const removal = archiveRemovals.get(id);
      if (removal !== undefined) return { kind: 'already', ...removal };
      const body = archives.get(id);
      if (body === undefined) return { kind: 'missing' };
      const bytes = Buffer.byteLength(body, 'utf8');
      const removedAt = new Date().toISOString();
      // 行は `archives` から消さない: 本文だけを落とす。
      archives.set(id, '');
      archiveRemovals.set(id, { removedAt, bytes });
      return { kind: 'removed', bytes };
    },
    async clear() {
      const removed = archiveMeta.size;
      archives.clear();
      archiveRemovals.clear();
      archiveMeta.clear();
      return removed;
    },
  };
  // `TranscriptArchive` にメソッドを足さず、`WeakMap` 越しに内部状態を出す（`seedFingerprintlessArchiveRow` 用）。
  archiveInternalsRegistry.set(archive, { archives, archiveMeta });

  const sessions: SessionRegistry = {
    async getCloneSessionId() {
      return cloneSessionId;
    },
    async setCloneSessionId(sessionId) {
      if (sessionId !== null) assertNoNul('session.cloneSessionId', sessionId);
      cloneSessionId = sessionId;
    },
    async getTranscriptGrave() {
      return transcriptGrave;
    },
    async setTranscriptGrave(grave) {
      transcriptGrave = grave;
    },
    // 判定と書き込みの間に `await` を置かない: 同期なら割り込まれる窓が無く、挟むと窓が生まれる（`SessionRegistry.clearTranscriptGraveIf` の doc）。
    async clearTranscriptGraveIf(archiveId) {
      if (transcriptGrave?.archiveId !== archiveId) return false;
      transcriptGrave = null;
      return true;
    },
    async getLostSessionGrave() {
      return lostSessionGrave;
    },
    async setLostSessionGrave(grave) {
      lostSessionGrave = grave;
    },
    async clearLostSessionGraveIf(sessionId) {
      if (lostSessionGrave?.sessionId !== sessionId) return false;
      lostSessionGrave = null;
      return true;
    },
    async getProjectKey() {
      return projectKey;
    },
    async setProjectKey(value) {
      assertNoNul('session.projectKey', value);
      projectKey = value;
    },
    async clear() {
      const removed = [cloneSessionId, transcriptGrave, lostSessionGrave, projectKey].filter(
        (value) => value !== null,
      ).length;
      cloneSessionId = null;
      transcriptGrave = null;
      lostSessionGrave = null;
      projectKey = null;
      return removed;
    },
  };

  const accounts = new Map<string, AuthAccount>();
  const identities = new Map<string, AuthIdentity>();
  const accessTokens = new Map<string, AccessTokenRecord>();
  const loginRequests = new Map<string, LoginRequest>();
  const identityKey = (provider: string, subject: string) => `${provider} ${subject}`;

  // 実時刻で比べる（文字列比較にしない）: `isoDateTime` はオフセット表記が一意でなく、pg の `asc()` と順が食い違う。同着の順は決めないので単独では使わず、下の `compare*Order` を使う。
  const compareCreatedAt = (a: { createdAt: string }, b: { createdAt: string }): number =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt);

  // 挿入順を約束にしない: `Map` の反復順は偶然で、pg は2次キーの無い `ORDER BY` の同着順を保証しない。`id` の2次キーで決める。
  const compareAccountOrder = (a: AuthAccount, b: AuthAccount): number =>
    compareCreatedAt(a, b) || compareCodeUnits(a.id, b.id);

  const compareIdentityOrder = (a: AuthIdentity, b: AuthIdentity): number =>
    compareCreatedAt(a, b) ||
    compareCodeUnits(a.provider, b.provider) ||
    compareCodeUnits(a.subject, b.subject);

  const compareAccessTokenOrder = (a: AccessTokenRecord, b: AccessTokenRecord): number =>
    compareCreatedAt(a, b) || compareCodeUnits(a.id, b.id);

  const integrationKeyRows = new Map<string, IntegrationKeyRecord>();
  const integrationKeys: IntegrationKeyStore = {
    async putIntegrationKey(key) {
      const parsed = prepareIntegrationKeyForWrite(integrationKeyRecordSchema.parse(key));
      if (integrationKeyRows.has(parsed.id)) throw new Error('integration key: 同じ id が既に在る');
      for (const row of integrationKeyRows.values()) {
        if (row.sha256 === parsed.sha256) throw new Error('integration key: 同じ値の鍵が既に在る');
      }
      integrationKeyRows.set(parsed.id, parsed);
    },
    async findIntegrationKeyBySha256(sha256) {
      if (hasNul(sha256)) return null;
      return [...integrationKeyRows.values()].find((row) => row.sha256 === sha256) ?? null;
    },
    async getIntegrationKey(id) {
      if (hasNul(id)) return null;
      return integrationKeyRows.get(id) ?? null;
    },
    async listIntegrationKeys() {
      return [...integrationKeyRows.values()].sort(compareIntegrationKeyOrder);
    },
    async listUnreadableIntegrationKeys() {
      return [];
    },
    async removeUnreadableIntegrationKeys(ids) {
      return { kind: 'unknown', count: new Set(ids).size };
    },
    async markIntegrationKeyUsed(id, at) {
      if (hasNul(id)) return;
      const row = integrationKeyRows.get(id);
      if (row === undefined || row.revokedAt !== null) return;
      integrationKeyRows.set(id, integrationKeyRecordSchema.parse({ ...row, lastUsedAt: at }));
    },
    async revokeIntegrationKey(id, at) {
      if (hasNul(id)) return { status: 'not_found' };
      const row = integrationKeyRows.get(id);
      if (row === undefined) return { status: 'not_found' };
      if (row.revokedAt !== null) return { status: 'already_revoked', key: row };
      const revoked = integrationKeyRecordSchema.parse({ ...row, revokedAt: at });
      integrationKeyRows.set(id, revoked);
      return { status: 'revoked', key: revoked };
    },
  };

  const auth: AuthStore = {
    async listAccounts() {
      return [...accounts.values()].sort(compareAccountOrder);
    },
    async listUnreadableAccounts() {
      return [];
    },
    async getAccount(id) {
      if (hasNul(id)) return null;
      return accounts.get(id) ?? null;
    },
    async findAccountByEmail(email) {
      if (hasNul(email)) return null;
      const needle = email.toLowerCase();
      return (
        [...accounts.values()].find(
          (account) => account.email !== null && account.email.toLowerCase() === needle,
        ) ?? null
      );
    },
    async putAccount(account) {
      const parsed = prepareAccountForWrite(authAccountSchema.parse(account));
      accounts.set(parsed.id, parsed);
    },
    async markAccountLoggedIn(accountId, at) {
      if (hasNul(accountId)) return;
      const account = accounts.get(accountId);
      if (account === undefined) return;
      accounts.set(accountId, authAccountSchema.parse({ ...account, lastLoginAt: at }));
    },
    async removeUnreadableAccounts(ids) {
      return { kind: 'unknown', count: new Set(ids).size };
    },
    async revokeAccountAccess(accountId) {
      if (hasNul(accountId)) return;
      const account = accounts.get(accountId);
      if (account === undefined) return;
      accounts.set(
        accountId,
        authAccountSchema.parse({
          ...account,
          grantedAt: null,
          grantedBy: null,
          ownerDeclaredAt: null,
        }),
      );
    },
    async findIdentity(provider, subject) {
      if (hasNul(provider) || hasNul(subject)) return null;
      return identities.get(identityKey(provider, subject)) ?? null;
    },
    async listIdentities(accountId) {
      if (hasNul(accountId)) return [];
      return [...identities.values()]
        .filter((identity) => identity.accountId === accountId)
        .sort(compareIdentityOrder);
    },
    async putIdentity(identity) {
      const parsed = prepareIdentityForWrite(authIdentitySchema.parse(identity));
      identities.set(identityKey(parsed.provider, parsed.subject), parsed);
    },
    // 検査から書き込みまでの間に await を挟まない: 同じ identity を作ろうとする2本目が割り込む窓ができる。
    async createAccountWithIdentity({ account, identity }) {
      const key = identityKey(identity.provider, identity.subject);
      const existing = identities.get(key);
      if (existing !== undefined) return { created: false, existing };
      const needle = account.email?.toLowerCase() ?? null;
      const emailCollides =
        needle !== null &&
        [...accounts.values()].some(
          (other) => other.email !== null && other.email.toLowerCase() === needle,
        );
      const accountToSave = emailCollides ? { ...account, email: null } : account;
      // account を先に parse する（fs と同じ並び）。
      const parsedAccount = prepareAccountForWrite(authAccountSchema.parse(accountToSave));
      const parsedIdentity = prepareIdentityForWrite(authIdentitySchema.parse(identity));
      accounts.set(parsedAccount.id, parsedAccount);
      identities.set(key, parsedIdentity);
      return { created: true, account: parsedAccount };
    },
    async putAccessToken(token) {
      const parsed = prepareAccessTokenForWrite(accessTokenRecordSchema.parse(token));
      accessTokens.set(parsed.id, parsed);
    },
    async markAccessTokenUsed(id, at) {
      if (hasNul(id)) return;
      const token = accessTokens.get(id);
      if (token === undefined || token.revokedAt !== null) return;
      accessTokens.set(id, accessTokenRecordSchema.parse({ ...token, lastUsedAt: at }));
    },
    async findAccessTokenBySha256(hash) {
      if (hasNul(hash)) return null;
      return [...accessTokens.values()].find((token) => token.sha256 === hash) ?? null;
    },
    async listAccessTokens(accountId) {
      if (hasNul(accountId)) return [];
      return [...accessTokens.values()]
        .filter((token) => token.accountId === accountId)
        .sort(compareAccessTokenOrder);
    },
    async revokeAccessToken(id, at) {
      if (hasNul(id)) return { status: 'not_found' };
      const token = accessTokens.get(id);
      if (token === undefined) return { status: 'not_found' };
      if (token.revokedAt !== null) return { status: 'already_revoked', token };
      const revoked = accessTokenRecordSchema.parse({ ...token, revokedAt: at });
      accessTokens.set(id, revoked);
      return { status: 'revoked', token: revoked };
    },
    async putLoginRequest(request) {
      const parsed = prepareLoginRequestForWrite(loginRequestSchema.parse(request));
      loginRequests.set(parsed.id, parsed);
    },
    async getLoginRequest(id) {
      if (hasNul(id)) return null;
      return loginRequests.get(id) ?? null;
    },
    async beginLoginExchange(id) {
      if (hasNul(id)) return null;
      const found = loginRequests.get(id);
      if (found === undefined || found.status !== 'pending') return null;
      const processing = { ...found, status: 'processing' as const };
      loginRequests.set(id, processing);
      return processing;
    },
    async claimLoginRequest(id, issue) {
      if (hasNul(id)) return null;
      const found = loginRequests.get(id);
      if (found === undefined || found.status !== 'authenticated') return null;
      const consumed = { ...found, status: 'consumed' as const };
      const token = prepareAccessTokenForWrite(accessTokenRecordSchema.parse(issue(consumed)));
      loginRequests.set(id, consumed);
      accessTokens.set(token.id, token);
      return { request: consumed, token };
    },
    async grantAccess(accountId, at, by) {
      if (hasNul(accountId)) return { status: 'not_found' };
      assertNoNul('authAccount.grantedBy', by);
      const account = accounts.get(accountId);
      if (account === undefined) return { status: 'not_found' };
      if (account.grantedAt !== null) return { status: 'granted', account };
      const granted = authAccountSchema.parse({ ...account, grantedAt: at, grantedBy: by });
      accounts.set(accountId, granted);
      return { status: 'granted', account: granted };
    },
    async setAccountOwner(accountId, declaredAt) {
      if (hasNul(accountId)) return { status: 'not_found' };
      // 検査から書き込みまでの間に await を挟まない: 挟むと宣言と許可の不変条件が崩れる窓ができる。
      const account = accounts.get(accountId);
      if (account === undefined) return { status: 'not_found' };
      if (declaredAt !== null && account.grantedAt === null) return { status: 'not_granted' };
      const updated = authAccountSchema.parse({ ...account, ownerDeclaredAt: declaredAt });
      accounts.set(accountId, updated);
      return { status: 'ok', account: updated };
    },
  };

  const permissionGrants: PermissionGrantStore = {
    async list() {
      return [...permissionGrantRows.values()].sort((a, b) =>
        compareIsoInstant(a.grantedAt, b.grantedAt),
      );
    },
    async listUnreadable() {
      return [];
    },
    async get(id) {
      return permissionGrantRows.get(id) ?? null;
    },
    async put(grant) {
      const parsed = preparePermissionGrantForPut(permissionGrantSchema.parse(grant));
      permissionGrantRows.set(parsed.id, parsed);
    },
    async revoke(id, at) {
      const found = permissionGrantRows.get(id);
      if (found === undefined) return null;
      const next = permissionGrantSchema.parse({ ...found, revokedAt: found.revokedAt ?? at });
      permissionGrantRows.set(id, next);
      return next;
    },
    async removeUnreadable(ids) {
      return { kind: 'unknown', count: new Set(ids).size };
    },
    async markUsed(id, at) {
      const found = permissionGrantRows.get(id);
      // 取り消し済みは記録せず、古い時刻では戻さない（`PermissionGrantStore.markUsed` の doc）。
      if (found === undefined || found.revokedAt !== undefined) return false;
      if (found.lastUsedAt !== undefined && compareIsoInstant(found.lastUsedAt, at) >= 0)
        return true;
      const next = permissionGrantSchema.parse({ ...found, lastUsedAt: at });
      permissionGrantRows.set(id, next);
      return true;
    },
  };

  const profile: ProfileStore = {
    async list() {
      return [...envProfile.values()]
        .sort((x, y) => compareProfileEntryNames(x.name, y.name))
        .map((row) => ({ ...row }));
    },
    async set(name, script, scope) {
      assertProfileRowWritable({ name, script });
      const row: EnvProfileEntry = { name, script, scope, updatedAt: new Date().toISOString() };
      envProfile.set(name, row);
      return { ...row };
    },
    async remove(name) {
      return envProfile.delete(name);
    },
    async replaceAll(previous) {
      for (const row of previous) assertProfileRowWritable(row);
      envProfile = new Map(previous.map((row) => [row.name, { ...row }]));
    },
    async clear() {
      const count = envProfile.size;
      envProfile.clear();
      return count;
    },
  };
  let codexAuthRecord: CodexChatgptAuthRecord | null = null;
  const codexAuth: CodexChatgptAuthStore = {
    async get() {
      return codexAuthRecord === null ? null : structuredClone(codexAuthRecord);
    },
    async replace(record) {
      codexAuthRecord = structuredClone(record);
    },
    async compareAndSwap(expectedRevision, next) {
      if (codexAuthRecord === null || codexAuthRecord.revision !== expectedRevision) return false;
      codexAuthRecord = structuredClone(next);
      return true;
    },
    async remove() {
      const had = codexAuthRecord !== null;
      codexAuthRecord = null;
      return had;
    },
  };
  let conversationReadBaseline: string | null = null;
  const conversationReadPositions = new Map<string, ConversationReadPosition>();
  let outboundWatermark: string | null = null;
  const outboundLatest = new Map<string, string>();
  const conversationReads: ConversationReadStore = {
    async readOutboundIndex() {
      return {
        state: 'ok',
        watermark: outboundWatermark,
        lastOutbound: Object.fromEntries(outboundLatest),
      };
    },
    async mergeOutboundIndex(update) {
      for (const id of Object.keys(update.lastOutbound)) assertNoNul('conversation.id', id);
      if (
        update.watermark !== null &&
        (outboundWatermark === null || compareIsoInstant(update.watermark, outboundWatermark) > 0)
      ) {
        outboundWatermark = update.watermark;
      }
      for (const [id, at] of Object.entries(update.lastOutbound)) {
        const known = outboundLatest.get(id);
        if (known === undefined || compareIsoInstant(at, known) > 0) outboundLatest.set(id, at);
      }
    },
    async clearOutboundIndex() {
      outboundWatermark = null;
      outboundLatest.clear();
    },
    async read() {
      return {
        state: 'ok',
        baseline: conversationReadBaseline,
        positions: Object.fromEntries(
          [...conversationReadPositions].map(([id, position]) => [id, { ...position }]),
        ),
      };
    },
    async ensureBaseline(at) {
      conversationReadBaseline ??= at;
      return { state: 'ok', baseline: conversationReadBaseline };
    },
    async advance(conversationId, readThrough) {
      assertNoNul('conversation.id', conversationId);
      const current = conversationReadPositions.get(conversationId);
      if (current !== undefined && compareIsoInstant(readThrough, current.readThrough) <= 0) {
        return { ...current };
      }
      const next = { readThrough, updatedAt: new Date().toISOString() };
      conversationReadPositions.set(conversationId, next);
      return { ...next };
    },
  };

  const mcpServers: McpServerStore = {
    async read() {
      return storedMcpServers === null
        ? null
        : {
            ...storedMcpServers,
            mcpServers: sortMcpServers(structuredClone(storedMcpServers.mcpServers)),
          };
    },
    async write(input, options) {
      const servers = parseMcpServers(prepareMcpServersForWrite(input));
      if (
        options?.ifMatch !== undefined &&
        options.ifMatch !== mcpServersVersionOf(storedMcpServers)
      ) {
        throw new McpServersConflictError(
          storedMcpServers === null
            ? null
            : {
                ...storedMcpServers,
                mcpServers: sortMcpServers(structuredClone(storedMcpServers.mcpServers)),
              },
        );
      }
      const updatedAt = new Date().toISOString();
      storedMcpServers =
        Object.keys(servers).length === 0 ? null : { mcpServers: servers, updatedAt };
      return { mcpServers: sortMcpServers(structuredClone(servers)), updatedAt };
    },
  };

  const pluginRows = new Map<string, StoredPlugin>();
  const clonePlugin = (plugin: StoredPlugin): StoredPlugin =>
    parseStoredPlugin({
      ...plugin,
      files: plugin.files.map((file) => ({ ...file, content: new Uint8Array(file.content) })),
    });
  const plugins: PluginStore = {
    async list() {
      return sortPluginSummaries([...pluginRows.values()].map(pluginSummaryOf));
    },
    async get(name) {
      if (!isValidPluginName(name)) return null;
      const row = pluginRows.get(name);
      return row === undefined ? null : clonePlugin(row);
    },
    async put(input) {
      const plugin = parsePluginInput(input);
      for (const existing of pluginRows.keys()) {
        if (pluginNamesCollide(plugin.name, existing)) {
          throw new PluginNameConflictError(plugin.name, existing);
        }
      }
      pluginRows.set(plugin.name, clonePlugin(plugin));
      return pluginSummaryOf(plugin);
    },
    async remove(name) {
      return isValidPluginName(name) ? pluginRows.delete(name) : false;
    },
  };

  // `put` は全文置換にしない: 空文字は「外す」で、入力に無い名前は触らない。ここだけ全文置換だと本物で他の鍵が消える。
  const credentialRows = new Map<string, StoredCredential>();
  const credentialSeedMarkers = new Set<string>();

  const credentials: CredentialVaultStore = {
    async list() {
      return [...credentialRows.values()].sort((a, b) => compareCodeUnits(a.name, b.name));
    },
    async put(entries) {
      assertValidCredentialEntries(entries);
      const at = new Date().toISOString();
      for (const entry of entries) {
        if (entry.value.length === 0) {
          credentialRows.delete(entry.name);
          continue;
        }
        // 既定値は補わない: 呼び手の `resolveEntryForWrite`（`credential-service.ts`）が scope・secret を解決して渡す。
        credentialRows.set(entry.name, {
          name: entry.name,
          value: entry.value,
          updatedAt: at,
          scope: entry.scope ?? 'all',
          secret: entry.secret ?? true,
        });
      }
      return credentials.list();
    },
    async seedOnce(marker, entries) {
      assertValidCredentialEntries(entries);
      if (credentialSeedMarkers.has(marker)) return [];
      credentialSeedMarkers.add(marker);
      const at = new Date().toISOString();
      const written: string[] = [];
      for (const entry of entries) {
        if (entry.value.length === 0 || credentialRows.has(entry.name)) continue;
        credentialRows.set(entry.name, {
          name: entry.name,
          value: entry.value,
          updatedAt: at,
          scope: entry.scope ?? 'all',
          secret: entry.secret ?? true,
        });
        written.push(entry.name);
      }
      return written;
    },
  };

  let tokenPool: AgentToken[] = [];
  let tokenRotationSettings: TokenRotationSettings | null = null;
  let activeAgentToken: ActiveAgentToken | null = null;

  const tokens: TokenPoolStore = {
    async list() {
      return [...tokenPool].sort((a, b) => a.order - b.order);
    },
    async listUnreadable() {
      return [];
    },
    async removeUnreadable() {
      return [];
    },
    async replace(next) {
      tokenPool = prepareTokensForReplace(next).map((token) => agentTokenSchema.parse(token));
      return tokens.list();
    },
    async readSettings() {
      return tokenRotationSettings ?? DEFAULT_TOKEN_ROTATION_SETTINGS;
    },
    async writeSettings(settings) {
      tokenRotationSettings = tokenRotationSettingsSchema.parse(settings);
      return tokenRotationSettings;
    },
    async readActive() {
      // 無いものを「1本目が現役」で埋めない（`TokenPoolStore.readActive` の doc）。
      return activeAgentToken;
    },
    async writeActive(active) {
      assertValidActiveToken(active);
      activeAgentToken = activeAgentTokenSchema.parse(active);
      return activeAgentToken;
    },
  };

  // 差分も鍵もドライバと共有し、`before*` の真偽もドライバと同じにする: ここだけ別だと本物では二重計上し、「記録が無い」と言うべき場面で「0 だった」と答える実装を通す。
  const usageRows = new Map<string, UsageRow>();
  const usageBaselines = new Map<string, UsageBaseline>();
  const usageTurns = new Map<string, UsageTurnRow>();
  // 無報告の provider のターン（`UsageStore.recordUnmetered`）。値を持たず合計に混ぜない。
  const usageUnmetered = new Map<string, UsageUnmeteredRow>();
  let usageStartedAt: string | null = null;
  let usageLayeredAt: string | null = null;
  let usageTokensAt: string | null = null;
  let usageTurnsAt: string | null = null;

  const usage: UsageStore = {
    async record(input) {
      const { layer, site, managerId, date, at, snapshot, accumulation, tokenId, runner } =
        stripNulFromUsageRecord(input);
      // `oneshot` に基準を持たせない: 前回より高くついた回だけが差に縮んで黙って目減りする。
      const baseKey = usageBaselineKey(layer, managerId);
      const baseline = accumulation === 'oneshot' ? null : (usageBaselines.get(baseKey) ?? null);
      const { fold, nextBaseline } = foldRecordForStore(baseline, {
        layer,
        managerId,
        snapshot,
        at,
        accumulation,
        ...(runner === undefined ? {} : { runner }),
      });
      // 既にある基準は oneshot でも消さない: 同じ主体が cumulative でも記録していることがある。
      if (nextBaseline !== null) usageBaselines.set(baseKey, nextBaseline);
      usageStartedAt ??= at;
      // `usageStartedAt` と揃えて入れない: 台帳のほうが先に始まっている器では別の時刻になる。
      usageLayeredAt ??= at;
      // トークンの軸は帰属が付いた record でだけ始める（ドライバと同じ）: 無条件だとプール無しでも `beforeTokens` が偽になり本物より緩い。
      if (tokenId !== undefined) usageTokensAt ??= at;
      const turned = Object.keys(fold.delta).length > 0;
      // 回数の軸は増分のある record でだけ始める: 空の record で始まると `beforeTurns` が本物より緩くなる。
      if (turned) usageTurnsAt ??= at;
      for (const [model, delta] of Object.entries(fold.delta)) {
        const key = usageRowKey(date, managerId, model, layer, site, tokenId);
        const before = usageRows.get(key)?.totals ?? ZERO_USAGE;
        // `unreadable` も足し込む: ドライバの `addTotals` と同じ算術にしないと本物では取りこぼす。
        const unreadable = addUnreadableCounts(before.unreadable, delta.unreadable);
        usageRows.set(key, {
          date,
          managerId,
          model,
          layer,
          site,
          ...(tokenId === undefined ? {} : { tokenId }),
          totals: {
            inputTokens: before.inputTokens + delta.inputTokens,
            outputTokens: before.outputTokens + delta.outputTokens,
            cacheReadInputTokens: before.cacheReadInputTokens + delta.cacheReadInputTokens,
            cacheCreationInputTokens:
              before.cacheCreationInputTokens + delta.cacheCreationInputTokens,
            webSearchRequests: before.webSearchRequests + delta.webSearchRequests,
            costUsd: before.costUsd + delta.costUsd,
            ...(unreadable === undefined ? {} : { unreadable }),
          },
          updatedAt: at,
        });
      }
      // 1ターンにつき1だけ足す（モデルが何本立っても1。0 の行は作らない）。
      if (turned) {
        const key = usageTurnKey(date, managerId, layer, site, tokenId);
        const before = usageTurns.get(key)?.turns ?? 0;
        usageTurns.set(key, {
          date,
          managerId,
          layer,
          site,
          ...(tokenId === undefined ? {} : { tokenId }),
          turns: before + 1,
          updatedAt: at,
        });
      }
      return {
        delta: fold.delta,
        baseline: nextBaseline,
        reset: fold.reset,
        ...(fold.skipped === undefined ? {} : { skipped: fold.skipped }),
      };
    },
    async aggregate(rawQuery) {
      // 書き込みが鍵列の NUL を落とすので、絞り込みも落としてから引く。
      const query = stripNulFromUsageQuery(rawQuery);
      const rows = [...usageRows.values()]
        .filter((row) => {
          if (query.from !== undefined && row.date < query.from) return false;
          if (query.to !== undefined && row.date > query.to) return false;
          if (query.managerId !== undefined && row.managerId !== query.managerId) return false;
          if (query.layer !== undefined && row.layer !== query.layer) return false;
          if (query.site !== undefined && row.site !== query.site) return false;
          if (query.tokenId !== undefined && row.tokenId !== query.tokenId) return false;
          return true;
        })
        .sort(
          (a, b) =>
            compareCodeUnits(a.date, b.date) ||
            compareCodeUnits(a.managerId, b.managerId) ||
            compareCodeUnits(a.model, b.model) ||
            compareCodeUnits(a.layer, b.layer) ||
            compareCodeUnits(a.site, b.site) ||
            // 帰属の無い行は最後（ドライバと同じ向き）。
            (a.tokenId === b.tokenId
              ? 0
              : a.tokenId === undefined
                ? 1
                : b.tokenId === undefined
                  ? -1
                  : compareCodeUnits(a.tokenId, b.tokenId)),
        );
      const turnRows = [...usageTurns.values()]
        .filter((row) => {
          if (query.from !== undefined && row.date < query.from) return false;
          if (query.to !== undefined && row.date > query.to) return false;
          if (query.managerId !== undefined && row.managerId !== query.managerId) return false;
          if (query.layer !== undefined && row.layer !== query.layer) return false;
          if (query.site !== undefined && row.site !== query.site) return false;
          if (query.tokenId !== undefined && row.tokenId !== query.tokenId) return false;
          return true;
        })
        .sort(
          (a, b) =>
            compareCodeUnits(a.date, b.date) ||
            compareCodeUnits(a.managerId, b.managerId) ||
            compareCodeUnits(a.layer, b.layer) ||
            compareCodeUnits(a.site, b.site) ||
            (a.tokenId === b.tokenId
              ? 0
              : a.tokenId === undefined
                ? 1
                : b.tokenId === undefined
                  ? -1
                  : compareCodeUnits(a.tokenId, b.tokenId)),
        );
      const unmeteredRows = [...usageUnmetered.values()]
        .filter((row) => {
          if (query.from !== undefined && row.date < query.from) return false;
          if (query.to !== undefined && row.date > query.to) return false;
          if (query.managerId !== undefined && row.managerId !== query.managerId) return false;
          if (query.layer !== undefined && row.layer !== query.layer) return false;
          if (query.site !== undefined && row.site !== query.site) return false;
          if (query.tokenId !== undefined && row.tokenId !== query.tokenId) return false;
          return true;
        })
        .sort(
          (a, b) =>
            compareCodeUnits(a.date, b.date) ||
            compareCodeUnits(a.managerId, b.managerId) ||
            compareCodeUnits(a.layer, b.layer) ||
            compareCodeUnits(a.site, b.site) ||
            compareCodeUnits(a.provider, b.provider) ||
            compareCodeUnits(a.tokenId ?? '\uffff', b.tokenId ?? '\uffff'),
        );
      return {
        rows,
        ...(unmeteredRows.length === 0 ? {} : { unmeteredRows }),
        since: usageStartedAt,
        layersSince: usageLayeredAt,
        tokensSince: usageTokensAt,
        beforeLedger: isBeforeUsageStart(usageStartedAt, query.from),
        beforeLayers: isBeforeUsageStart(usageLayeredAt, query.from),
        beforeTokens: isBeforeUsageStart(usageTokensAt, query.from),
        turnRows,
        turnsSince: usageTurnsAt,
        beforeTurns: isBeforeUsageStart(usageTurnsAt, query.from),
        notice: USAGE_ESTIMATE_NOTICE,
      };
    },
    async recordUnmetered(input) {
      const { layer, site, managerId, date, at, provider, tokenId } =
        stripNulFromUnmeteredRecord(input);
      const key = [date, managerId, layer, site, provider, tokenId ?? ''].join('\u0000');
      const existing = usageUnmetered.get(key);
      usageUnmetered.set(key, {
        date,
        managerId,
        layer,
        site,
        provider,
        ...(tokenId === undefined ? {} : { tokenId }),
        turns: (existing?.turns ?? 0) + 1,
        updatedAt: at,
      });
    },
    async baseline(layer, managerId) {
      return usageBaselines.get(usageBaselineKey(layer, stripNul(managerId))) ?? null;
    },
    // 引数を持たず全期間から作る（`store.ts` の `UsageStore.recordedManagerIds` の doc）: 絞り込みを受けると、範囲外の委譲を「記録が無い」と数える事故をこの器だけ検出できない。
    async recordedManagerIds() {
      return new Set([...usageRows.values()].map((row) => row.managerId));
    },
    async clear() {
      const removed = {
        daily: usageRows.size,
        baseline: usageBaselines.size,
        ledger: usageStartedAt === null ? 0 : 1,
        turns: usageTurns.size,
      };
      usageRows.clear();
      usageBaselines.clear();
      usageTurns.clear();
      usageUnmetered.clear();
      usageStartedAt = null;
      usageLayeredAt = null;
      usageTokensAt = null;
      usageTurnsAt = null;
      return removed;
    },
  };

  // 独自に正規化せず `ensureTrailingNewline` を通す: 3実装の1つだけ振る舞いが違うと、単体テストは乖離した側にしか当たらない。
  const practiceStore: PracticeStore = {
    async list() {
      return {
        entries: [...practices.values()]
          .sort((a, b) => compareCodeUnits(a.slug, b.slug))
          .map((entry) =>
            isolate({
              slug: entry.slug,
              kind: entry.kind,
              title: entry.title,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
              chars: entry.chars,
            }),
          ),
        unreadable: [],
      };
    },
    async read(slug) {
      const found = practices.get(slug);
      return found === undefined ? null : isolate(found);
    },
    async write(input, options) {
      // 本文の NUL は検証の前に落とす。slug は下のスキーマが弾く。
      const content = ensureTrailingNewline(stripNul(input.content));
      const kind = stripNul(input.kind);
      const title = stripNul(input.title);
      const now = new Date().toISOString();
      const existing = practices.get(input.slug);
      if (!practiceVersionMatches(existing ?? null, options?.ifMatch)) {
        throw new PracticeConflictError(
          input.slug,
          existing === undefined ? null : isolate(existing),
        );
      }
      const next = practiceSchema.parse({
        slug: input.slug,
        kind,
        title,
        content,
        // 上書きで作成時刻を捏造しない（`PracticeStore.write` の doc）。
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        // コードポイント数で数える（UTF-16 のコード単位数にしない）。
        chars: [...content].length,
      });
      practices.set(input.slug, isolate(next));
      const history = practiceVersions.get(input.slug) ?? [];
      const version = practiceVersionSchema.parse({
        slug: input.slug,
        version: history.length + 1,
        kind,
        title,
        content,
        at: now,
        chars: [...content].length,
      });
      practiceVersions.set(input.slug, [...history, isolate(version)]);
      return isolate(next);
    },
    async remove(slug, options) {
      const existing = practices.get(slug);
      if (
        options?.ifMatch !== undefined &&
        !practiceVersionMatches(existing ?? null, options.ifMatch)
      ) {
        throw new PracticeConflictError(slug, existing === undefined ? null : isolate(existing));
      }
      // 版（`practiceVersions`）は消さない（`PracticeStore.remove` の doc）。
      practices.delete(slug);
    },
    async clear() {
      const removed = practices.size;
      practices.clear();
      // 版もここでは消す: `clear()` は「全部忘れる」リセット専用（`PracticeStore.clear` の doc）。
      practiceVersions.clear();
      return removed;
    },
    async listVersions(slug) {
      return (practiceVersions.get(slug) ?? []).map((entry) =>
        isolate({
          slug: entry.slug,
          version: entry.version,
          kind: entry.kind,
          title: entry.title,
          at: entry.at,
          chars: entry.chars,
        }),
      );
    },
    async readVersion(slug, version) {
      const found = (practiceVersions.get(slug) ?? []).find((entry) => entry.version === version);
      return found === undefined ? null : isolate(found);
    },
  };

  return {
    persona,
    journal,
    jobs: jobStore,
    schedules: scheduleStore,
    commitments: commitmentStore,
    practices: practiceStore,
    inbox: inboxStore,
    archive,
    sessions,
    auth,
    integrationKeys,
    permissionGrants,
    profile,
    credentials,
    mcpServers,
    plugins,
    conversationReads,
    codexAuth,
    tokens,
    usage,
    attachments: new MemoryAttachmentStore(),
  };
}

// `Clone` の内側に持たせない: `Clone` を捨てて同じ `Stores` から作り直す再起動の再現ができなくなる。
function createMemoryInboxStore(): InboxStore {
  const unread = new Map<string, PendingInboxEvent>();

  return {
    async put(event: InboxEvent, at: string): Promise<void> {
      const value = inboxEventSchema.parse(event);
      // 読めない時刻は `RangeError` で拒む（pg の `new Date(at)` と同じ）。
      const normalizedAt = new Date(at).toISOString();
      const deliveries = unread.get(value.id)?.deliveries ?? 0;
      // `set` だけにしない: `Map` は再設定で挿入順を動かさず、再配達された行が元の位置に留まり、fs / pg（末尾へ回る）と同着の並びが食い違う。
      unread.delete(value.id);
      unread.set(value.id, { event: value, at: normalizedAt, deliveries });
    },
    async remove(id: string): Promise<void> {
      unread.delete(id);
    },
    async claimPending(): Promise<PendingInboxEvent[]> {
      const rows = [...unread.values()].sort((a, b) => compareIsoInstant(a.at, b.at));
      return rows.map((row) => {
        const next = { ...row, deliveries: row.deliveries + 1 };
        unread.set(row.event.id, next);
        return next;
      });
    },
    async pending(): Promise<{ count: number; oldestAt?: string }> {
      // `claimPending` と違い `unread` を書き換えない（`InboxStore.pending` の doc）。
      const rows = [...unread.values()];
      const oldest = earliestIsoInstant(rows.map((row) => row.at));
      return { count: rows.length, ...(oldest === undefined ? {} : { oldestAt: oldest }) };
    },
    async peekPending(): Promise<InboxPeek> {
      // `claimPending` と違い `unread` を書き換えない（`InboxStore.peekPending` の doc）。
      return {
        entries: [...unread.values()].sort((a, b) => compareIsoInstant(a.at, b.at)),
        unreadable: [],
      };
    },
    async removeMany(ids: readonly string[]): Promise<string[]> {
      const removedIds: string[] = [];
      for (const id of ids) {
        if (unread.delete(id)) removedIds.push(id);
      }
      return removedIds;
    },
    async clear(): Promise<number> {
      const removed = unread.size;
      unread.clear();
      return removed;
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
 * stderr へ出た行を集める。記録の書き込み失敗の跡は stderr にしか出ない（本文をログへ落とさない）ので、これが無いと「黙って消える」に戻っても気づけない。
 *
 * `process.stderr.write` だけでは足りない: `dropped-record.ts` の `note()` は `fs.writeSync(2, …)` を使うので `setStderrSinkForTesting` でも差し替える。差し替えは `finally` で戻す（戻し忘れると以降のテストの出力が消える）。
 */
export async function captureStderr(body: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setStderrSinkForTesting((line) => {
    lines.push(line);
  });
  try {
    await body();
  } finally {
    process.stderr.write = original;
    setStderrSinkForTesting(null);
  }
  return lines;
}

// 読みは通す: 読みまで落とすと起動そのものが失敗し、「書けなかったときどうなるか」を見られない。
export function failingJournalAppend(stores: Stores, reason: string): Stores {
  return {
    ...stores,
    journal: {
      ...stores.journal,
      append: () => Promise.reject(new Error(reason)),
    },
  };
}

// 読み直しと消し込みは通す。ここが落ちても `post` は落ちてはいけない: 未読を書けないことで合図の処理まで止めると穴が広がる。
export function failingInboxPut(stores: Stores, reason: string): Stores {
  return {
    ...stores,
    inbox: {
      ...stores.inbox,
      put: () => Promise.reject(new Error(reason)),
    },
  };
}

/** `inbox.remove` を最初の `failCount` 回だけ失敗させる（`#forget` の拾い直し用）。呼ばれた `id` は `calls` に積む。 */
export function flakyInboxRemove(
  stores: Stores,
  failCount: number,
  reason: string,
): { stores: Stores; calls: string[] } {
  const calls: string[] = [];
  let remaining = failCount;
  return {
    calls,
    stores: {
      ...stores,
      inbox: {
        ...stores.inbox,
        remove: (id: string) => {
          calls.push(id);
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error(reason));
          }
          return stores.inbox.remove(id);
        },
      },
    },
  };
}

/** `inbox.put` を最初の `failCount` 回だけ失敗させる（`#remember` の拾い直し用）。呼ばれた event の `id` は `calls` に積む。 */
export function flakyInboxPut(
  stores: Stores,
  failCount: number,
  reason: string,
): { stores: Stores; calls: string[] } {
  const calls: string[] = [];
  let remaining = failCount;
  return {
    calls,
    stores: {
      ...stores,
      inbox: {
        ...stores.inbox,
        put: (event, at) => {
          calls.push(event.id);
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error(reason));
          }
          return stores.inbox.put(event, at);
        },
      },
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
