import { createHash, randomUUID } from 'node:crypto';
import { chown, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { reasonOf } from './dropped-record.js';
import { excerptLine } from './excerpt.js';

const CREDENTIAL_BATCH_LIST_EXCERPT = 400;

export const DEFAULT_CREDENTIAL_DIR = '/run/alteroid/credentials';

// 環境変数を総なめにしない: 何が鍵かを推測で決めると、鍵でないものを晒すか鍵を取りこぼすため
export const ROTATABLE_CREDENTIAL_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // プールの名前にしない: Codex 側にはプールも枠の回し手も無いため。ChatGPT ログインの auth.json は compare-and-swap が要るので、版を持たないこの袋に入れない
  'CODEX_API_KEY',
] as const;

// 型は union にせず `readonly string[]` のまま `satisfies` で縛る: union だと器の外から来た任意の文字列を `includes` で検査できなくなるため
export const POOL_OWNED_CREDENTIAL_NAMES: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
] satisfies readonly (typeof ROTATABLE_CREDENTIAL_KEYS)[number][];

export const ENV_FILE_OWNED_CREDENTIAL_NAMES: readonly string[] = [
  'ALTEROID_ALLOWED_ORIGINS',
  'ALTEROID_GOOGLE_CLIENT_ID',
  'ALTEROID_GOOGLE_CLIENT_SECRET',
  'ALTEROID_PUBLIC_URL',
  'ALTEROID_AUTH',
  'ALTEROID_CLONE_MODEL',
  'ALTEROID_MANAGER_MODEL',
  'ALTEROID_WORKER_MODEL',
];

// 重ね順を変えず、プロファイル側で名前を禁じない: 順序は `GH_TOKEN` のために正しく、禁じると追加制限になるため。検出して出すだけにする
export function credentialNamesShadowedByProfile(
  names: readonly string[],
  profileEnvNames: readonly string[],
): string[] {
  const declared = new Set(profileEnvNames);
  return names.filter((name) => declared.has(name));
}

// 経路の途中で弾かず名前の定義そのものを狭める: `../../../etc/cron.d/x` のような名前がファイル名になり、器の外へ書けたため
export const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/;

// runner の受け口と同じ値を1か所から読む: 分けると、正本には書けるのに runner へ永久に配れない行が黙って生まれるため
export const CREDENTIAL_NAME_MAX_LENGTH = 128;

// `value` を引数に取らない: zod のエラーをそのまま出すと `received` 等の欄に入力値が混ざりうるため
export function describeSkippedCredentialRow(params: {
  index: number;
  reason: string;
  name?: string;
}): string {
  const nameNote = params.name === undefined ? '' : ` name=${JSON.stringify(params.name)}`;
  return (
    `alteroid: credentials の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${nameNote}`
  );
}

export function isWithheldCredentialName(name: string, withheld: readonly string[]): boolean {
  return withheld.includes(name);
}

export interface CredentialFingerprint {
  name: string;
  sha256: string;
  updatedAt: string;
  scope?: 'all' | 'app' | 'runner';
  secret?: boolean;
  // `secret === false` の行だけ載せる: `undefined` を敷き詰めると「値を確認したが空だった」と区別が付かなくなるため
  value?: string;
}

export interface CredentialEntry {
  name: string;
  value: string;
  scope?: 'all' | 'app' | 'runner';
  secret?: boolean;
}

export interface CredentialStore {
  values(): Record<string, string>;
  env(): Record<string, string>;
  fingerprints(): CredentialFingerprint[];
  set(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]>;
  flush(): Promise<CredentialFingerprint[]>;
  // 名前として成立するものだけ消す: 置き場に他人のファイルが在る構成を壊さないため
  // いま持っている鍵は消さない: 降ろされた直後に呼ばれても、降りた鍵を自分で消さないため
  purge(): Promise<string[]>;
  readonly lastWriteError: string | undefined;
}

export interface CredentialStoreOptions {
  dir?: string;
  seed?: NodeJS.ProcessEnv;
  names?: readonly string[];
  reader?: { uid: number; gid: number };
  now?: () => Date;
  withheldEnvKeys?: readonly string[];
}

export function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  return new Store(options);
}

interface Held {
  value: string;
  updatedAt: string;
}

class Store implements CredentialStore {
  readonly #dir: string;
  readonly #reader: { uid: number; gid: number } | undefined;
  readonly #now: () => Date;
  readonly #held = new Map<string, Held>();
  readonly #names: readonly string[];
  readonly #withheld: readonly string[];
  #lastWriteError: string | undefined;

  constructor(options: CredentialStoreOptions) {
    this.#dir = options.dir ?? DEFAULT_CREDENTIAL_DIR;
    this.#reader = options.reader;
    this.#now = options.now ?? (() => new Date());

    const seed = options.seed ?? process.env;
    const names = options.names ?? ROTATABLE_CREDENTIAL_KEYS;
    this.#withheld = options.withheldEnvKeys ?? [];
    this.#names = names.filter(
      (name) => CREDENTIAL_NAME.test(name) && !isWithheldCredentialName(name, this.#withheld),
    );
    const at = this.#now().toISOString();
    for (const name of this.#names) {
      const value = seed[name];
      // 空文字は「置かれていない」と同じに扱う: 空の鍵を配ると、鍵が無い場合より悪い壊れ方をするため
      if (typeof value !== 'string' || value.length === 0) continue;
      this.#held.set(name, { value, updatedAt: at });
    }
  }

  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, held] of this.#held) out[name] = held.value;
    return out;
  }

  // 表（`#names`）だけでなく降りてきた名前の所在も出す: 出さないと、配ったのに所在を知らせない鍵ができるため
  env(): Record<string, string> {
    const out: Record<string, string> = { ALTEROID_CREDENTIAL_DIR: this.#dir };
    for (const name of new Set([...this.#names, ...this.#held.keys()])) {
      out[`ALTEROID_${name}_FILE`] = join(this.#dir, name);
    }
    return out;
  }

  fingerprints(): CredentialFingerprint[] {
    return [...this.#held].map(([name, held]) => ({
      name,
      sha256: fingerprintOf(held.value),
      updatedAt: held.updatedAt,
    }));
  }

  async set(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]> {
    // 名前は器の中のファイル名になる: パスとして解釈されうる形を受けない
    for (const entry of entries) {
      if (!CREDENTIAL_NAME.test(entry.name)) {
        throw new Error(
          `鍵の名前として認められない: ${JSON.stringify(entry.name)}（英大文字・数字・_ のみ）`,
        );
      }
      if (isWithheldCredentialName(entry.name, this.#withheld)) {
        throw new Error(
          `${entry.name} は子プロセスへ伏せる鍵なので、鍵として配れない` +
            '（伏せる仕組みを鍵の仕組みで越えさせない）',
        );
      }
    }

    const at = this.#now().toISOString();

    // バッチの原子性を装わない: まとめて memory を進めると、途中で失敗したときに戻す先が無いため
    const applied: string[] = [];
    for (const entry of entries) {
      const held = entry.value.length === 0 ? undefined : { value: entry.value, updatedAt: at };
      try {
        await this.#commit(entry.name, held);
      } catch (error) {
        this.#lastWriteError = String(error);
        throw new Error(
          `鍵の差し替えが ${entry.name} で止まった` +
            `（適用済み: ${
              applied.length === 0
                ? 'なし'
                : excerptLine(applied.join(', '), CREDENTIAL_BATCH_LIST_EXCERPT)
            }` +
            ` / 未適用: ${excerptLine(
              entries
                .slice(applied.length)
                .map((rest) => rest.name)
                .join(', '),
              CREDENTIAL_BATCH_LIST_EXCERPT,
            )}）: ${String(error)}`,
          { cause: error },
        );
      }
      applied.push(entry.name);
    }
    this.#lastWriteError = undefined;
    return this.fingerprints();
  }

  // 器へ入ってから memory を進める: 逆だと書けなかった鍵を配ってしまうため
  async #commit(name: string, held: Held | undefined): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o711 });
    const path = join(this.#dir, name);

    if (held === undefined) {
      await rm(path, { force: true });
      this.#held.delete(name);
      return;
    }

    const staging = `${path}.${randomUUID().slice(0, 8)}`;
    try {
      // 改行を足さない: `cat` した値がそのまま鍵になるため
      await writeFile(staging, held.value, { mode: 0o400 });
      if (this.#reader !== undefined) {
        await chown(staging, this.#reader.uid, this.#reader.gid);
      }
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
    this.#held.set(name, held);
  }

  // 書けなくても memory を落とさない: 捨てると、器が用意できないローカルで鍵がまったく配られなくなるため
  async flush(): Promise<CredentialFingerprint[]> {
    for (const [name, held] of [...this.#held]) {
      try {
        await this.#commit(name, held);
        this.#lastWriteError = undefined;
      } catch (error) {
        this.#lastWriteError = String(error);
        process.stderr.write(
          `alteroid-runner: 鍵を器へ書けませんでした（走行中の差し替えは届きません）: ${reasonOf(error)}\n`,
        );
      }
    }
    return this.fingerprints();
  }

  async purge(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#dir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of entries) {
      if (!CREDENTIAL_NAME.test(name)) continue;
      if (this.#held.has(name)) continue;
      try {
        await rm(join(this.#dir, name), { force: true });
        removed.push(name);
      } catch (error) {
        this.#lastWriteError = String(error);
      }
    }
    return removed;
  }

  get lastWriteError(): string | undefined {
    return this.#lastWriteError;
  }
}
