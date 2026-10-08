import { reasonOf } from './dropped-record.js';
import {
  CREDENTIAL_NAME,
  CREDENTIAL_NAME_MAX_LENGTH,
  ENV_FILE_OWNED_CREDENTIAL_NAMES,
  fingerprintOf,
  isWithheldCredentialName,
  POOL_OWNED_CREDENTIAL_NAMES,
  type CredentialEntry,
  type CredentialFingerprint,
} from './credentials.js';
import type {
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerRegistry,
} from './runner-protocol.js';
import type { StoredCredential, Stores } from './store.js';

export interface CredentialService {
  // 値を返す口を作らない: `GET` の資格が「置く」のと同じ強さを要求することになり、指紋だけ見たい人まで巻き込むため
  fingerprints(): Promise<CredentialFingerprint[]>;
  // 外す指示も配る: 配らないと runner の器に古い鍵が残り続けるため
  apply(entries: readonly CredentialEntry[]): Promise<ApplyCredentialsResult>;
  onPushed?(listener: (results: ApplyCredentialsResult['runners']) => void): () => void;
  // 差があるものだけを降ろす: 全部だと再接続のたびに `recycleForToken` を無意味に叩きうるため
  syncRunner(runner: RunnerClient): Promise<RunnerCredentialFingerprint[] | null>;
  vaultSnapshot(): readonly StoredCredential[];
}

export interface CredentialServiceOptions {
  stores: Stores;
  runners?: RunnerRegistry;
  // 省略可能にしない: 渡し忘れると検査が消えるため
  withheldEnvKeys: readonly string[];
  onApplied?: (changedNames: readonly string[]) => void;
}

export interface ApplyCredentialsResult {
  fingerprints: CredentialFingerprint[];
  runners: {
    runnerId: string;
    ok: boolean;
    error?: string;
    credentials?: RunnerCredentialFingerprint[];
  }[];
}

// この型を投げる文に値を載せない: `message` がそのまま応答へ返るため
export class CredentialEntryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEntryRejectedError';
  }
}

function assertEntries(
  entries: readonly CredentialEntry[],
  withheld: readonly string[],
  existingByName: ReadonlyMap<string, StoredCredential>,
): void {
  if (entries.length === 0) {
    throw new CredentialEntryRejectedError('鍵が1つも渡されていない（置くものが無い）');
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    // 名前そのものをメッセージに含めない: 上限超えの名前は任意の長さになりうるため
    // 空文字（外す）は拒まない: 上限超えの古い行を二度と消せなくなるため
    if (entry.value.length > 0 && entry.name.length > CREDENTIAL_NAME_MAX_LENGTH) {
      throw new CredentialEntryRejectedError(
        `鍵の名前が長すぎる（${entry.name.length} 文字。上限は ${CREDENTIAL_NAME_MAX_LENGTH} ` +
          '文字——runner の受け口と同じ上限）',
      );
    }
    if (!CREDENTIAL_NAME.test(entry.name)) {
      throw new CredentialEntryRejectedError(
        `鍵の名前として認められない: ${JSON.stringify(entry.name)}（英大文字・数字・_ のみ）`,
      );
    }
    if (isWithheldCredentialName(entry.name, withheld)) {
      throw new CredentialEntryRejectedError(
        `${entry.name} は子プロセスへ伏せる鍵なので、鍵として配れない` +
          '（伏せる仕組みを鍵の仕組みで越えさせない）',
      );
    }
    if (POOL_OWNED_CREDENTIAL_NAMES.includes(entry.name)) {
      throw new CredentialEntryRejectedError(
        `${entry.name} の正本は認証トークンのプールである（alteroid token add / PUT /tokens）。` +
          'ここへ置くと撒き手が2つになり、回した鍵をこちらが名乗り直しで上書きして' +
          'ローテーションが黙って効かなくなる',
      );
    }
    // 空文字（外す）は通す: 消し口が `PUT /credentials` だけで、拒むと置かれた行を二度と消せなくなるため
    if (ENV_FILE_OWNED_CREDENTIAL_NAMES.includes(entry.name) && entry.value.length > 0) {
      throw new CredentialEntryRejectedError(
        `${entry.name} の正本は器の生の環境変数（.env / Railway の Service 変数）である。` +
          'ここへ置いても誰にも配られない（正本を2つにしないため、読み出しでも落とす）' +
          '（直すのは railway/setup.sh が置く側、または器の .env）',
      );
    }
    // 重複を落とす: 後の行だけが入り、前の行が黙って捨てられるため
    if (seen.has(entry.name)) {
      throw new CredentialEntryRejectedError(
        `${entry.name} が2回渡されている（どちらが残るかを決めない）`,
      );
    }
    seen.add(entry.name);

    if (entry.value.length > 0 && entry.secret !== undefined) {
      const existing = existingByName.get(entry.name);
      if (existing !== undefined) {
        const existingSecret = existing.secret ?? true;
        if (entry.secret !== existingSecret) {
          throw new CredentialEntryRejectedError(
            `${entry.name} の secret（シークレット可否）は作成時に決まり、後から変更できない` +
              `（いまは ${existingSecret ? 'シークレット' : '非シークレット'}）。` +
              '値を変えたいだけなら secret を省略すること',
          );
        }
      }
    }
  }
}

// 正本に無い名前を器の env で埋めない: 器の env は正本から書き写された値で、正本を消しても古い値が配られ続けるため
export function resolveCredentialRows(
  authoritative: readonly StoredCredential[],
  target: 'clone' | 'manager',
): StoredCredential[] {
  // 上限超えの名前の行を配らない: runner の受け口が1行でもあると配列全体を 400 で弾き、ほかの鍵の配布まで止まるため
  return authoritative.filter(
    (row) =>
      !ENV_FILE_OWNED_CREDENTIAL_NAMES.includes(row.name) &&
      row.name.length <= CREDENTIAL_NAME_MAX_LENGTH &&
      scopeAppliesTo(row.scope, target),
  );
}

function scopeAppliesTo(scope: StoredCredential['scope'], target: 'clone' | 'manager'): boolean {
  const normalized = scope ?? 'all';
  if (normalized === 'all') return true;
  return normalized === 'app' ? target === 'clone' : target === 'manager';
}

function fingerprintOfRow(row: StoredCredential): CredentialFingerprint {
  const secret = row.secret ?? true;
  return {
    name: row.name,
    sha256: fingerprintOf(row.value),
    updatedAt: row.updatedAt,
    scope: row.scope ?? 'all',
    secret,
    ...(secret ? {} : { value: row.value }),
  };
}

function resolveEntryForWrite(
  entry: CredentialEntry,
  existingByName: ReadonlyMap<string, StoredCredential>,
): CredentialEntry {
  if (entry.value.length === 0) return entry;
  const existing = existingByName.get(entry.name);
  return {
    name: entry.name,
    value: entry.value,
    scope: entry.scope ?? existing?.scope ?? 'all',
    secret: entry.secret ?? existing?.secret ?? true,
  };
}

function changedCloneNames(
  before: readonly StoredCredential[],
  after: readonly StoredCredential[],
): string[] {
  const view = (rows: readonly StoredCredential[]): Map<string, string> =>
    new Map(
      resolveCredentialRows(rows, 'clone').map((row) => [row.name, fingerprintOf(row.value)]),
    );
  const was = view(before);
  const now = view(after);
  const names = new Set([...was.keys(), ...now.keys()]);
  return [...names].filter((name) => was.get(name) !== now.get(name)).sort();
}

export function overlongCredentialNames(rows: readonly StoredCredential[]): string[] {
  return rows.map((row) => row.name).filter((name) => name.length > CREDENTIAL_NAME_MAX_LENGTH);
}

export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const { stores, runners, withheldEnvKeys, onApplied } = options;

  let lastOverlongSignature = '';
  function reportOverlong(rows: readonly StoredCredential[]): void {
    const names = overlongCredentialNames(rows);
    const signature = names.join('\n');
    if (signature === lastOverlongSignature) return;
    lastOverlongSignature = signature;
    if (names.length === 0) return;
    process.stderr.write(
      `alteroidd: 名前が ${CREDENTIAL_NAME_MAX_LENGTH} 文字を超える鍵の行が正本に残っており、` +
        `**配っていません**（runner の受け口が配列ごと弾くため）。` +
        `消すには PUT /credentials に { name, value: "" } を送る: ` +
        `${names.map((name) => `${name.slice(0, 32)}…（${name.length} 文字）`).join(', ')}\n`,
    );
  }

  let cachedVaultRows: readonly StoredCredential[] = [];
  function noteVaultSnapshot(rows: readonly StoredCredential[]): void {
    cachedVaultRows = rows;
  }
  // 失敗しても止めない: 空のままでも、次にどれかが呼ばれれば追いつくため
  void stores.credentials
    .list()
    .then(noteVaultSnapshot)
    .catch(() => undefined);

  // 直列にする: 同時に2つ更新が入ると、層ごとに違う値が残るため
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  const pushListeners = new Set<(results: ApplyCredentialsResult['runners']) => void>();

  return {
    vaultSnapshot: () => cachedVaultRows,

    fingerprints: async () => {
      const rows = await stores.credentials.list();
      noteVaultSnapshot(rows);
      return rows.map((row) => fingerprintOfRow(row));
    },

    apply: (entries: readonly CredentialEntry[]) =>
      serial(async () => {
        const existing = await stores.credentials.list();
        const existingByName = new Map(existing.map((row) => [row.name, row]));
        assertEntries(entries, withheldEnvKeys, existingByName);

        const resolved = entries.map((entry) => resolveEntryForWrite(entry, existingByName));

        const rows = await stores.credentials.put(resolved);
        noteVaultSnapshot(rows);
        const changedForClone = changedCloneNames(existing, rows);

        // 正本に在る名前は入力の値ではなく正本の値で配る: 器が値を変えても「配った値＝正本の値」が崩れないため
        const removed = entries
          // 上限超えの名前は外す合図にも載せない: runner の受け口が配列ごと弾くため
          .filter(
            (entry) => entry.value.length === 0 && entry.name.length <= CREDENTIAL_NAME_MAX_LENGTH,
          )
          .map((entry) => ({ name: entry.name, value: '' }));
        reportOverlong(rows);
        const upserted = rows.filter(
          (row) =>
            row.name.length <= CREDENTIAL_NAME_MAX_LENGTH && scopeAppliesTo(row.scope, 'manager'),
        );
        const payload = [...upserted.map(({ name, value }) => ({ name, value })), ...removed];

        const pushed = await pushAll(payload);
        for (const listener of pushListeners) {
          try {
            listener(pushed);
          } catch {
            // 帳面に積めなかっただけで、配布の結果そのものは下で返す。
          }
        }

        // 配布が失敗してもクローンへは知らせる: クローンは正本の写しを直に読むため
        if (changedForClone.length > 0) {
          try {
            onApplied?.(changedForClone);
          } catch {
            // 畳み直しの印を立てられなかっただけで、正本の更新そのものは成功している。
          }
        }

        return { fingerprints: fingerprintsOf(rows), runners: pushed };
      }),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        const rows = await effective();
        // 「全部外せ」とは言わない: 外す指示は `apply` が明示的に送るため
        if (rows.length === 0) return null;

        // 指紋が取れなかったときは差がある側に倒す: 降ろし損なうと鍵が無いまま走るため
        const current = await runner.credentials().catch(() => undefined);
        const held = new Map((current ?? []).map((entry) => [entry.name, entry.sha256]));
        const behind = rows.filter((row) => held.get(row.name) !== fingerprintOf(row.value));
        if (behind.length === 0) return null;

        return runner.setCredentials(behind.map(({ name, value }) => ({ name, value })));
      }),
  };

  async function effective(): Promise<StoredCredential[]> {
    const rows = await stores.credentials.list();
    noteVaultSnapshot(rows);
    reportOverlong(rows);
    return resolveCredentialRows(rows, 'manager');
  }

  function fingerprintsOf(rows: readonly StoredCredential[]): CredentialFingerprint[] {
    return rows.map((row) => fingerprintOfRow(row));
  }

  async function pushAll(
    payload: readonly CredentialEntry[],
  ): Promise<ApplyCredentialsResult['runners']> {
    if (runners === undefined) return [];
    return Promise.all(
      (await runners.list()).map(async (runner) => {
        try {
          return {
            runnerId: runner.runnerId,
            ok: true as const,
            credentials: await runner.setCredentials([...payload]),
          };
        } catch (error) {
          return { runnerId: runner.runnerId, ok: false as const, error: reasonOf(error) };
        }
      }),
    );
  }
}
