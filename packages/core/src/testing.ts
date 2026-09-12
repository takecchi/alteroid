import {
  classifyArchiveContinuity,
  fingerprintArchiveBody,
  type ArchiveContinuity,
} from './archive-continuity.js';
import { setStderrSinkForTesting } from './dropped-record.js';
import { deriveMemoryFrontmatter, nextDescribedAt } from './memory.js';
import { matchesJournalSearch } from './journal-search.js';
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
  CredentialVaultStore,
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
import { ensureTrailingNewline, JournalAnchorNotFoundError } from './store.js';
import {
  DEFAULT_TOKEN_ROTATION_SETTINGS,
  type ActiveAgentToken,
  type AgentToken,
  type TokenRotationSettings,
} from './token-pool.js';
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
  type UsageTurnRow,
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
  tokenId: string | undefined,
): string {
  // **区切りもドライバと同じ制御文字にする。** 空白にすると、id に空白を含む actor で
  // この器だけが鍵をぶつける（あるいはぶつけない）＝ 本物と違う結果を静かに返す。
  //
  // **トークンも鍵に入れる**（ドライバと同じ）。外すと、回した前後の増分が同じ行へ
  // 足し込まれる形をこの器だけが通してしまい、誤帰属のテストが緑になる。
  return `${date}\u0000${managerId}\u0000${model}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

/** 累積の基準の鍵。**主体は「層 × actor」である**（`usage.ts` の `usageBaselineSchema`）。 */
function usageBaselineKey(layer: UsageLayer, managerId: string): string {
  return `${layer}\u0000${managerId}`;
}

/**
 * 「起きた回数」の鍵。**`model` を持たない4軸+トークン**（ドライバの `turnKey` /
 * `usageTurns` の一意索引と同じ軸。`usage.ts` の `usageTurnRowSchema` の doc）。
 */
function usageTurnKey(
  date: string,
  managerId: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  return `${date}\u0000${managerId}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
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
 * `createMemoryStores()` が作った `archive`（`TranscriptArchive`）ごとの内部
 * 状態への裏口（#698）。**`TranscriptArchive` interface にはメソッドを足さ
 * ない**——足すと3実装（インメモリ / fs / pg）すべてに同じメソッドが要ることに
 * なる。この `WeakMap` は `seedFingerprintlessArchiveRow` のためだけに在る。
 */
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

/**
 * インメモリ実装（`createMemoryStores().archive`）に、**指紋を持たない行**を
 * 直接登録する（#698）。`archive()` を経由すると必ず指紋が付くので、
 * この機能より前に積まれた行（本番の5.4GBの既存行）を再現するにはこの口が
 * 要る——`verifyTranscriptArchiveContract` の `seedFingerprintlessRow` に渡す
 * ためのものであり、`archive-contract.test.ts` 以外から呼ぶ想定は無い。
 *
 * `createMemoryStores()` が作った `archive` 以外を渡すと例外を投げる。
 */
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
  // **意図して bodyChars / bodyMd5 / continuity を入れない**——指紋を持たない
  // 行を再現するのがこの関数の目的である。
  internals.archiveMeta.set(id, {
    sessionId,
    at: new Date().toISOString(),
    seq: internals.archiveMeta.size,
  });
  return id;
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
  // 記憶の `createdAt`。fs の `.index.json` / pg の `created_at` 列と同じ形
  // ——素の optional。「unknown」という値をここへ書き込まない。値が無いのは
  // (1) この配線より前に作られ (2) 日誌にも根拠が無い、両方を満たす昔の行
  // だけである（`read()` / `list()` が組み立てる）。値が入る経路は2つ——
  // `write()` がその場で立てる（第一の出所）か、`markCreatedAt`（backfill）
  // が日誌から埋めるかのどちらか。
  const createdAtStore = new Map<string, string>();
  const entries: JournalEntry[] = [];
  const jobs = new Map<string, Job>();
  const approvals = new Map<string, PendingApproval>();
  const schedules = new Map<string, ScheduledRequest>();
  const schedulePhases = new Map<string, SchedulePhase>();
  const commitments = new Map<string, Commitment>();
  const archives = new Map<string, string>();
  /** tombstone（#698）。行（`archives` のキー）は消さず、ここへ印だけを持つ。 */
  const archiveRemovals = new Map<string, { removedAt: string; bytes: number }>();
  /**
   * `list()` / `sessions()` が返すメタ（#698）。**本文（`archives`）とは別に持つ**
   * ——tombstone で本文が `''` になっても `sessionId` と `at` は残る（pg 側で
   * 列が残るのと同じ）。`seq` は積んだ順で、`at` が同じミリ秒に並んだときの
   * 並びを決めるためだけに在る（pg 側の `order by at desc, id desc` の代わり）。
   */
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
  let envProfile: EnvProfile | null = null;
  let counter = 0;
  const nextId = () => `id-${++counter}`;

  const toMemoryCreatedAt = (at: string | undefined): MemoryCreatedAt =>
    at === undefined ? { kind: 'unknown' } : { kind: 'known', at };

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
            // **書き込み時にキャッシュした値ではなく、その場で組み立てる。**
            // fs（索引を都度読む） / pg（列を都度 SELECT する）と同じく、
            // `markCreatedAt` が write() の後に別途反映されても読み出しに
            // 反映されるようにするため。
            createdAt: toMemoryCreatedAt(createdAtStore.get(slug)),
            bytes,
            frontmatter,
            kind,
            description,
            parent,
            descriptionFreshness,
          }),
        )
        .sort((a, b) => a.slug.localeCompare(b.slug));
    },
    async read(slug) {
      const doc = documents.get(slug);
      if (doc === undefined) return null;
      return { ...doc, createdAt: toMemoryCreatedAt(createdAtStore.get(slug)) };
    },
    async write(slug, content) {
      const before = documents.get(slug);
      const updatedAt = new Date().toISOString();
      // **保存する形へ正規化してから、以降は正規化した本文だけを使う。**
      // `PersonaStore.write` の契約（`store.ts`）であり、fs（`#writeNow` が
      // `writeFile` へ渡す直前）/ pg（`write` が `body` を作る所）と同じ位置に
      // ある。**ここが無かったせいで、同じ `write` に対して `read` が返す値が
      // インメモリだけ違っていた**（#370）。派生値（title / bytes / 要旨 /
      // ハッシュ）も本物と同じく正規化した後の本文から作る——`bytes` は fs では
      // ファイルの `stats.size` なので、正規化前の長さを数えると本物と1バイト
      // ずれる。
      const body = ensureTrailingNewline(content);
      // **write() と append()（下）の唯一の通り道。** fs / pg と同じく、誰が
      // 書いたかを問わずここでハッシュ・describedAt を更新する。human 印には
      // 触らない。describedAt は書き手が書けない（`nextDescribedAt` の doc）。
      // **`createdAt` は本物（fs / pg）と同じく、この書き込みが文書を作った
      // ときだけ立てる。** `before === undefined`（＝この slug の実体が
      // 無かった）かつ、まだ値を持っていないときだけ set する——一度立てたら
      // 二度と触らない一度きりの確定（`markCreatedAt` による backfill は昔の
      // 行の後始末で、ここでは何もしない）。
      if (before === undefined && !createdAtStore.has(slug)) createdAtStore.set(slug, updatedAt);
      const next = nextDescribedAt({
        priorContent: before?.content ?? null,
        nextContent: body,
        priorDescribedAt: describedAt.get(slug),
        writtenAt: updatedAt,
      });
      if (next === undefined) describedAt.delete(slug);
      else describedAt.set(slug, next);
      const derived = deriveMemoryFrontmatter({ content: body, updatedAt, describedAt: next });
      const doc: MemoryDocument = {
        slug,
        title: /^#\s+(.+)$/m.exec(body)?.[1] ?? slug,
        updatedAt,
        createdAt: toMemoryCreatedAt(createdAtStore.get(slug)),
        bytes: Buffer.byteLength(body),
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
      const existing = documents.get(slug);
      // **既存の本文を `ensureTrailingNewline` に通してから連結する。** 上の
      // `write` が既に正規化しているので冗長に見えるが、fs
      // （`ensureTrailingNewline(existing.content)` ＋ `#writeNow` の正規化）/
      // pg（`right(content, 1) = E'\n'` の場合分け ＋ `write` の正規化）と
      // 同じ二重の守りに揃えてある。**片方だけ外しても追記の歯は落ちない**
      // ——落ちないことは「守られていない」ではなく、もう片方が効いていると
      // いう意味である（#354 の変異試験が fs / pg で実測した形）。
      return persona.write(
        slug,
        existing ? `${ensureTrailingNewline(existing.content)}\n${content}` : content,
      );
    },
    async remove(slug) {
      documents.delete(slug);
      // fs / pg と同じく、実体が消えれば派生値も消える（過去に human で書かれた
      // 事実そのものは journal に残るので、backfill が立て直す）。
      humanTouchedAt.delete(slug);
      contentSha256.delete(slug);
      describedAt.delete(slug);
      createdAtStore.delete(slug);
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
    async markCreatedAt(slug, at) {
      // 実体も index も無い slug には新しく行を作らない（`markHumanTouched` と
      // 同じ約束）。**一度きりの確定**——既に値が入っていれば何もしない
      // （絶対条件2「埋めるのは値が無いときだけ」。fs / pg と同じ）。
      if (!documents.has(slug) && !createdAtStore.has(slug)) return false;
      if (createdAtStore.has(slug)) return false;
      createdAtStore.set(slug, at);
      return true;
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
        // `read()` を通す——`documents` の生キャッシュには `markCreatedAt` が
        // 別途反映した最新の `createdAt` が乗っていない（`read()` の doc）。
        const doc = await persona.read(meta.slug);
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
      // **`order` は全順序を決めるところで最初に効かせる。** 既定 `desc` は
      // 従来どおり push の逆順（新しい順）。`asc` は push 順そのまま。
      const order = query.order ?? 'desc';
      let found = order === 'desc' ? [...entries].reverse() : [...entries];

      // **`after` は `types` / `with` / `since` / `until` / `limit` より前に
      // 効かせる**（`JournalQuery.after` の doc、issue #432 の2本目）。錨の
      // 位置は絞り込み前の全順序の中で決める——見つからなければ
      // `JournalAnchorNotFoundError` を投げる（黙って先頭から返さない）。
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
      // **`with` は `limit`（下の slice）より前で効かせる**（issue #418 の穴の本体）。
      // `with` を持つのは `exchange` だけなので、非 exchange はここで落ちる —
      // `types` を明示していなくても、`with` を指定した時点で絞られる。
      if (query.with !== undefined) {
        const withValues = query.with;
        found = found.filter(
          (entry) => entry.type === 'exchange' && withValues.includes(entry.with),
        );
      }
      // **`q` も `limit`（下の slice）より前で効かせる**（issue #250。
      // `with` と同じ段）。照合そのものは `journal-search.ts` が持つ —— 3実装が
      // 同じ答えを出すために、欄の選び方をここへ書き写さない。
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
      // **この偽物は `unreadable` を常に空にする。** ここが持つのは常に
      // `commitmentSchema.parse` を経た `Commitment` だけで（`open()` を見よ）、
      // 保存層のように行が壊れた形で入る経路が無い。`entries` /
      // `unreadable` という型そのものは本物と揃えること（issue #296。
      // `CommitmentStore.list` の返り値、`store.ts` の `CommitmentList`）。
      //
      // **`trimmedClosed` も常に `0`。** ここは `Map` に溜まるだけで、
      // 保持上限も削除経路も無い——fs 版（`storage-fs/src/commitments.ts`）
      // だけが `CLOSED_HISTORY_LIMIT` を超えた片付き行を物理削除する
      // （issue #416）。ここを揃えていないので、fs だけを踏む歯はこの
      // 偽物では書けない（`packages/storage-fs/src/index.test.ts` 側で書く）。
      if (options?.includeClosed !== true)
        return { entries: open, unreadable: [], trimmedClosed: 0 };
      const closed = all
        .filter((entry) => entry.closedAt !== undefined)
        .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
      return { entries: [...open, ...closed], unreadable: [], trimmedClosed: 0 };
    },
    async get(id) {
      return commitments.get(id) ?? null;
    },
    async open(entry) {
      if (commitments.has(entry.id)) return false;
      commitments.set(entry.id, entry);
      return true;
    },
    async close(id, at, reason, by: CommitmentClosedBy) {
      const existing = commitments.get(id);
      if (!existing || existing.closedAt !== undefined) return false;
      commitments.set(id, { ...existing, closedAt: at, closedReason: reason, closedBy: by });
      return true;
    },
    // **本物（fs / pg）と同じ意味論——実際に閉じた id だけを返す。** 存在しない
    // id・既に閉じている id は戻り値に含めない。`ids` が空なら何も変えずに
    // `[]` を返す（本物と同じく、この偽物も `Map` へ一切触れない）。同じ id が
    // 重複していても `Map` の1エントリを一度書き換えるだけなので、二重に閉じる
    // ことも戻り値に重複が出ることも無い（`CommitmentStore.closeMany` の doc）。
    async closeMany(ids: readonly string[], at, reason, by: CommitmentClosedBy) {
      const closedIds: string[] = [];
      for (const id of new Set(ids)) {
        const existing = commitments.get(id);
        if (!existing || existing.closedAt !== undefined) continue;
        commitments.set(id, { ...existing, closedAt: at, closedReason: reason, closedBy: by });
        closedIds.push(id);
      }
      return closedIds;
    },
    // **`origin` の判定はしない**（`CommitmentStore.editBody` の doc）。呼び出し側
    // （`apps/daemon/src/app.ts` の `PATCH /commitments/:id`）が確かめてから呼ぶ。
    async editBody(id, body, at, by: CommitmentEditedBy) {
      const existing = commitments.get(id);
      if (!existing || existing.closedAt !== undefined) return false;
      commitments.set(id, { ...existing, body, editedAt: at, editedBy: by });
      return true;
    },
  };

  /**
   * `list()` と `sessions()` が共通で使う1行の組み立て（#698）。2箇所に同じ
   * 組み立てを書くと、片方だけ直したときに黙ってズレるため1つにまとめてある。
   *
   * **`storedBytes` は文字列長である**（この置き場がこの行に使っている量）。
   * pg の圧縮後バイト数・fs のファイル長とは単位が違う——`ArchiveEntry` の
   * doc のとおり、置き場をまたいで比較してはならない。
   *
   * 並びは新しい順（`at` の降順、同じミリ秒なら積んだ順の降順）。
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
      .sort((x, y) => (x.entry.at < y.entry.at ? 1 : x.entry.at > y.entry.at ? -1 : y.seq - x.seq))
      .map(({ entry }) => entry);

  /**
   * 「直前の退避」＝同じ `sessionId` の行のうち `at` が最大（同値なら `seq`
   * が最大）のもの（#698）。**`removedAt` で絞らない**——tombstone された
   * 行の指紋も、当時の本文を表す有効な情報である（pg / fs 実装の doc と
   * 同じ理由）。`archiveMeta` だけを見る（`archives` の本文には触れない）。
   */
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
    async archive(sessionId, transcript): Promise<ArchiveWrite> {
      const id = `${sessionId}-${nextId()}`;
      const previous = findPreviousArchiveForSession(sessionId);
      const fingerprint = fingerprintArchiveBody(transcript);
      const { continuity, comparedTo } = classifyArchiveContinuity(previous, transcript);
      archives.set(id, transcript);
      archiveMeta.set(id, {
        sessionId,
        at: new Date().toISOString(),
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
      const bySession = new Map<string, ArchiveSessionSummary>();
      for (const entry of buildArchiveEntries()) {
        const existing = bySession.get(entry.sessionId);
        if (existing === undefined) {
          bySession.set(entry.sessionId, {
            sessionId: entry.sessionId,
            rows: 1,
            storedBytes: entry.storedBytes,
            maxStoredBytes: entry.storedBytes,
            firstAt: entry.at,
            lastAt: entry.at,
          });
          continue;
        }
        bySession.set(entry.sessionId, {
          sessionId: entry.sessionId,
          rows: existing.rows + 1,
          storedBytes: existing.storedBytes + entry.storedBytes,
          maxStoredBytes: Math.max(existing.maxStoredBytes, entry.storedBytes),
          firstAt: entry.at < existing.firstAt ? entry.at : existing.firstAt,
          lastAt: entry.at > existing.lastAt ? entry.at : existing.lastAt,
        });
      }
      return [...bySession.values()].sort(
        (x, y) =>
          y.storedBytes - x.storedBytes ||
          (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0),
      );
    },
    async read(id) {
      // **印（`archiveRemovals`）を先に見る。** `archives.get(id)` が `''`
      // （空の生ログ）を返す場合と「消された」を区別するのはこの順序である
      // ——本文の中身では判定しない（`ArchiveRead` interface doc）。
      const removal = archiveRemovals.get(id);
      if (removal !== undefined) return { kind: 'removed', ...removal };
      const body = archives.get(id);
      if (body === undefined) return { kind: 'missing' };
      return { kind: 'body', body };
    },
    async remove(id) {
      const removal = archiveRemovals.get(id);
      if (removal !== undefined) return { kind: 'already', ...removal };
      const body = archives.get(id);
      if (body === undefined) return { kind: 'missing' };
      const bytes = Buffer.byteLength(body, 'utf8');
      const removedAt = new Date().toISOString();
      // **行は残す**（`archives` から消さない）。本文だけを落とす。
      archives.set(id, '');
      archiveRemovals.set(id, { removedAt, bytes });
      return { kind: 'removed', bytes };
    },
  };
  // **テストが指紋を持たない行を作れるようにする口**（#698。
  // `seedFingerprintlessArchiveRow` の doc）。`TranscriptArchive` interface に
  // メソッドを足すと3実装すべてに同じメソッドが要ることになるので、この
  // インメモリ実装だけが持つ内部状態への出入口を、`archive` オブジェクトを鍵に
  // した `WeakMap` 越しに公開する。
  archiveInternalsRegistry.set(archive, { archives, archiveMeta });

  const sessions: SessionRegistry = {
    async getCloneSessionId() {
      return cloneSessionId;
    },
    async setCloneSessionId(sessionId) {
      cloneSessionId = sessionId;
    },
    async getTranscriptGrave() {
      return transcriptGrave;
    },
    async setTranscriptGrave(grave) {
      transcriptGrave = grave;
    },
    async getLostSessionGrave() {
      return lostSessionGrave;
    },
    async setLostSessionGrave(grave) {
      lostSessionGrave = grave;
    },
    async getProjectKey() {
      return projectKey;
    },
    async setProjectKey(value) {
      projectKey = value;
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
    async grantAccess(accountId, at, by) {
      const account = accounts.get(accountId);
      if (account === undefined) return { status: 'not_found' };
      if (account.grantedAt !== null) return { status: 'granted', account };
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
   * マネージャーへ降ろす環境変数の正本（インメモリ）。
   *
   * **3実装（インメモリ / fs / pg）で同じ答えにすること。** 空文字は「外す」で、
   * `put` は入力に無い名前を触らない（部分更新である）。ここだけ全文置換にすると、
   * 「テストの器では通るのに本物では他の鍵が消える」というずれ方をする。
   */
  const credentialRows = new Map<string, StoredCredential>();

  const credentials: CredentialVaultStore = {
    async list() {
      return [...credentialRows.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async put(entries) {
      const at = new Date().toISOString();
      for (const entry of entries) {
        if (entry.value.length === 0) {
          credentialRows.delete(entry.name);
          continue;
        }
        credentialRows.set(entry.name, { name: entry.name, value: entry.value, updatedAt: at });
      }
      return credentials.list();
    },
  };

  /**
   * 認証トークンのプール（インメモリ）。**回さない**——ここも fs / pg と同じく
   * 器と口だけを持つ（Issue #393「PR1 プールの器」）。
   */
  let tokenPool: AgentToken[] = [];
  let tokenRotationSettings: TokenRotationSettings | null = null;
  let activeAgentToken: ActiveAgentToken | null = null;

  const tokens: TokenPoolStore = {
    async list() {
      return [...tokenPool].sort((a, b) => a.order - b.order);
    },
    async replace(next) {
      tokenPool = [...next];
      return tokens.list();
    },
    async readSettings() {
      return tokenRotationSettings ?? DEFAULT_TOKEN_ROTATION_SETTINGS;
    },
    async writeSettings(settings) {
      tokenRotationSettings = settings;
      return settings;
    },
    async readActive() {
      // **無いものを「1本目が現役」で埋めない**（`TokenPoolStore.readActive` の doc）。
      // 3実装（インメモリ / fs / pg）で同じ答えでなければ、上の層が器によって
      // 違う挙動になる。
      return activeAgentToken;
    },
    async writeActive(active) {
      activeAgentToken = active;
      return active;
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
   *
   * **回数（`turnRows` / `turnsSince` / `beforeTurns`）も同じ形で持つ。** 鍵は
   * `model` を抜いた4軸+トークンで、増分が空の record（`fold.delta` が空）は
   * 数えない——ドライバ2つと同じ判定（`usage.ts` の `usageTurnRowSchema` の doc）。
   */
  const usageRows = new Map<string, UsageRow>();
  const usageBaselines = new Map<string, UsageBaseline>();
  const usageTurns = new Map<string, UsageTurnRow>();
  let usageStartedAt: string | null = null;
  let usageLayeredAt: string | null = null;
  let usageTokensAt: string | null = null;
  let usageTurnsAt: string | null = null;

  const usage: UsageStore = {
    async record({ layer, site, managerId, date, at, snapshot, accumulation, tokenId }) {
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
      // **トークンの軸は帰属が付いた record でだけ始まる**（ドライバと同じ）。
      // `??= at` だけにすると、この器はプールを持たない構成でも「トークン軸を
      // 観測している」と答え、`beforeTokens` が偽になる ＝ 本物より緩い。
      if (tokenId !== undefined) usageTokensAt ??= at;
      // **「起きた（＝ターン1回）」の判定。** 台帳の行が動いた回（`fold.delta` が
      // 空でない回）だけを1回と数える——ドライバ2つと同じ判定。
      const turned = Object.keys(fold.delta).length > 0;
      // 回数の軸は「起きた record」でだけ始まる。`usageLayeredAt` と揃えて
      // `??= at` にすると、増分が空の record でも軸が始まったことになる
      // ＝ 本物より緩い（ドライバ2つと同じ判断）。
      if (turned) usageTurnsAt ??= at;
      for (const [model, delta] of Object.entries(fold.delta)) {
        const key = usageRowKey(date, managerId, model, layer, site, tokenId);
        const before = usageRows.get(key)?.totals ?? ZERO_USAGE;
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
          },
          updatedAt: at,
        });
      }
      // **回数を足し込む。`turned` のときだけ**（0 の行は作らない）。鍵は
      // `usage_daily` から `model` を抜いた4軸+トークン——1ターンにつき
      // ちょうど1だけ足す（モデルが何本立ってもここは1のまま）。
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
          if (query.tokenId !== undefined && row.tokenId !== query.tokenId) return false;
          return true;
        })
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.managerId.localeCompare(b.managerId) ||
            a.model.localeCompare(b.model) ||
            a.layer.localeCompare(b.layer) ||
            a.site.localeCompare(b.site) ||
            // 帰属の無い行は最後（ドライバ2つと同じ向き。`@alteroid/storage-fs` の
            // `compareTokenId` / pg の `nullif(...) asc nulls last`）。
            (a.tokenId === b.tokenId
              ? 0
              : a.tokenId === undefined
                ? 1
                : b.tokenId === undefined
                  ? -1
                  : a.tokenId.localeCompare(b.tokenId)),
        );
      // **`rows` と同じ述語で絞る**（ドライバ2つと同じ——`UsageQuery` はモデルの
      // 絞りを持たないので、この2つの照会は完全に同じ条件になる）。
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
            a.date.localeCompare(b.date) ||
            a.managerId.localeCompare(b.managerId) ||
            a.layer.localeCompare(b.layer) ||
            a.site.localeCompare(b.site) ||
            (a.tokenId === b.tokenId
              ? 0
              : a.tokenId === undefined
                ? 1
                : b.tokenId === undefined
                  ? -1
                  : a.tokenId.localeCompare(b.tokenId)),
        );
      return {
        rows,
        since: usageStartedAt,
        layersSince: usageLayeredAt,
        tokensSince: usageTokensAt,
        // 台帳が始まる前を照会されたら、0 ではなく「記録が無い」と言えるように。
        beforeLedger: isBeforeUsageStart(usageStartedAt, query.from),
        // 層の軸が始まる前の行の layer / site は既定値であって観測ではない。
        beforeLayers: isBeforeUsageStart(usageLayeredAt, query.from),
        // **トークンの軸は始まっていないことが正常でありうる**（プールを使って
        // いない構成）。ここが偽を返すと「帰属が取れている」と読める。
        beforeTokens: isBeforeUsageStart(usageTokensAt, query.from),
        turnRows,
        turnsSince: usageTurnsAt,
        // **回数の軸も始まっていないことが正常でありうる**（増分が空の record
        // しか無い期間）。ここが偽を返すと「回数が取れている」と読める。
        beforeTurns: isBeforeUsageStart(usageTurnsAt, query.from),
        notice: USAGE_ESTIMATE_NOTICE,
      };
    },
    async baseline(layer, managerId) {
      return usageBaselines.get(usageBaselineKey(layer, managerId)) ?? null;
    },
    /**
     * **ドライバと同じく、引数を持たず全期間から作る**（`store.ts` の
     * `UsageStore.recordedManagerIds` の doc）。ここが `aggregate()` の絞り込みを
     * 受け付ける形だと、テストの器だけが「照会範囲の外の委譲を記録が無いに
     * 数える」事故を検出できなくなる。
     */
    async recordedManagerIds() {
      return new Set([...usageRows.values()].map((row) => row.managerId));
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
    credentials,
    tokens,
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
    async pending(): Promise<{ count: number; oldestAt?: string }> {
      // **`claimPending` と違い、`unread` を1文字も書き換えない**
      // （`InboxStore.pending` の doc）。
      const rows = [...unread.values()];
      const oldest = rows.reduce<string | undefined>(
        (min, row) => (min === undefined || row.at < min ? row.at : min),
        undefined,
      );
      return { count: rows.length, ...(oldest === undefined ? {} : { oldestAt: oldest }) };
    },
    async peekPending(): Promise<PendingInboxEvent[]> {
      // **`claimPending` と違い、`unread` を1文字も書き換えない**
      // （`InboxStore.peekPending` の doc。`pending()` と同じ倒れ先）。
      return [...unread.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
 * stderr へ出た行を集める。
 *
 * 記録の書き込みに失敗したときの跡は stderr にしか出ない（本文をログへ
 * 落とさないため、日誌にもストアにも残せない）。**そこを見る手段が無いと、
 * 「黙って消える」に戻っていても誰も気づけない。**
 *
 * **2本の経路を両方差し替える。**
 * - `process.stderr.write`（`note()` 以外がまだ直接呼んでいる経路。今回は
 *   これは無い想定だが、将来また増えても拾えるように残す）
 * - `dropped-record.ts` の `note()` が使う `fs.writeSync(2, …)`（#248）。
 *   これは `process.stderr.write` の差し替えを**通らない**ので、
 *   `setStderrSinkForTesting` で別に差し替える。
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

/**
 * `inbox.remove` を最初の `failCount` 回だけ失敗させ、それ以降は本物へ委ねる。
 *
 * **`#forget` の拾い直し（issue #256、`FORGET_RETRY_ATTEMPTS`）を試すためのもの。**
 * `#forget` は「消せると確定するまでメモリ上の印を消さない」ので、`remove` が
 * 一時的に失敗しても拾い直せば実際に消える——これを黒箱（`stores.inbox` の
 * 中身）から確かめる。呼ばれた `id` は `calls` に積む。
 */
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
