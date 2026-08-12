import { createHash, randomUUID } from 'node:crypto';
import { chown, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * マネージャーの道具の鍵を、**走行中でも差し替えられる形**で持つ器。
 *
 * **なぜ環境変数ではだめなのか。** 鍵を `process.env` から子へ配ると、値は
 * runner のプロセスが起動した瞬間に凍る。プラットフォームは走っているプロセスの
 * 環境変数を書き換えられないので、人間が鍵を直しても**再起動するまで届かない**。
 * しかも env で渡す以上、**既に走っている SDK 子プロセスには永久に届かない**
 * （プロセスの環境変数は外から書き換えられない）。
 *
 * その結果どうなるかは実際に起きた: 人間は鍵を正しく差し替え、マネージャーは
 * 正しく 403 を報告し、両方とも正しいまま何時間も噛み合わなかった。直す手段が
 * 再起動しかない以上、**「鍵を直す」と「走行中の仕事を失う」が同じ操作**になる。
 *
 * だから鍵は器（ファイル）に置く。`git` も `gh` も**呼ばれるたびに読み直す**ので、
 * 差し替えは走行中のマネージャーにも次の呼び出しから届く。ここにあるのは鍵の
 * 置き場と経路だけで、判断は無い。
 *
 * **これは能力の制限ではない。** 下（外の世界）へ手を伸ばす鍵は渡すのが正しく
 * （AGENTS.md）、変えているのは配り方だけである。伏せるのは上（記憶）へ到達する
 * 鍵だけで、そちらは `WITHHELD_ENV_KEYS` の仕事である。
 */

/** 既定の置き場。`Dockerfile` の `gh` シムが見るのと同じ場所である。 */
export const DEFAULT_CREDENTIAL_DIR = '/run/alteroid/credentials';

/**
 * 起動時に環境変数から器へ移す鍵。
 *
 * ここに挙げたものだけを扱う。**環境変数を総なめにしない** — 何が鍵かを推測で
 * 決めると、鍵でないものを鍵として晒すか、鍵を取りこぼすかのどちらかになる。
 */
export const ROTATABLE_CREDENTIAL_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * 鍵が合っているかを、**値を出さずに**照合するための指紋。
 *
 * 人間が置いた鍵とマネージャーが握っている鍵が同じかどうかは、これが無いと
 * 誰にも見えない。見えなければ「付けた」「付いてない」のすれ違いが起きる。
 */
export interface CredentialFingerprint {
  name: string;
  /** sha256（16進）の先頭12桁。**値そのものは決して出さない。** */
  sha256: string;
  updatedAt: string;
}

export interface CredentialEntry {
  name: string;
  /** 空文字は「鍵を外す」の意味（未設定へ戻す）。 */
  value: string;
}

export interface CredentialStore {
  /** 子へ配る現在値。env のスナップショットに**上書きで**重ねる。 */
  values(): Record<string, string>;
  /** 器の所在を子へ知らせる環境変数（パスは凍っても構わない。中身が動く）。 */
  env(): Record<string, string>;
  /** いま持っている鍵の指紋。値は出さない。 */
  fingerprints(): CredentialFingerprint[];
  /** 差し替える。走行中のマネージャーにも次の `git` / `gh` 呼び出しから届く。 */
  set(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]>;
  /** 起動時に、環境変数から拾った分を器へ書き出す。 */
  flush(): Promise<CredentialFingerprint[]>;
  /** 直近の書き込みに失敗していれば理由。器が無い構成を黙って隠さないための窓。 */
  readonly lastWriteError: string | undefined;
}

export interface CredentialStoreOptions {
  /** 置き場。既定は `DEFAULT_CREDENTIAL_DIR`。 */
  dir?: string;
  /** 起動時の種。既定は `process.env`。 */
  seed?: NodeJS.ProcessEnv;
  /** 扱う鍵の名前。既定は `ROTATABLE_CREDENTIAL_KEYS`。 */
  names?: readonly string[];
  /**
   * 読める主体。SDK 子プロセスを別 UID へ降ろしているなら、その UID を渡す。
   * 渡さなければ chown しない（同じ UID で走るローカル構成）。
   */
  reader?: { uid: number; gid: number };
  /** 現在時刻。テストで固定するため。 */
  now?: () => Date;
}

/** 値そのものを出さずに同一性だけ見せる。 */
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
  /** 器へ書けなかったことを、黙って握り潰さないための印。 */
  #lastWriteError: string | undefined;

  constructor(options: CredentialStoreOptions) {
    this.#dir = options.dir ?? DEFAULT_CREDENTIAL_DIR;
    this.#reader = options.reader;
    this.#now = options.now ?? (() => new Date());

    const seed = options.seed ?? process.env;
    const names = options.names ?? ROTATABLE_CREDENTIAL_KEYS;
    const at = this.#now().toISOString();
    for (const name of names) {
      const value = seed[name];
      // 空文字は「置かれていない」と同じに扱う。空の鍵を配ると、鍵が無い場合より
      // 悪い壊れ方（`empty ident` 相当の即死）をする経路がある。
      if (typeof value !== 'string' || value.length === 0) continue;
      this.#held.set(name, { value, updatedAt: at });
    }
  }

  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, held] of this.#held) out[name] = held.value;
    return out;
  }

  env(): Record<string, string> {
    const out: Record<string, string> = { ALTEROID_CREDENTIAL_DIR: this.#dir };
    // `gh` のシムが見る所在。名前ごとに1ファイルなので、パスは名前から決まる。
    if (this.#held.has('GH_TOKEN') || this.#held.size === 0) {
      out.ALTEROID_GH_TOKEN_FILE = join(this.#dir, 'GH_TOKEN');
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
    const at = this.#now().toISOString();
    for (const entry of entries) {
      if (entry.value.length === 0) {
        this.#held.delete(entry.name);
        continue;
      }
      this.#held.set(entry.name, { value: entry.value, updatedAt: at });
    }
    // **差し替えは黙って落とさない。** 器へ届かなければ走行中のマネージャーには
    // 永久に届かず、「差し替えたのに直らない」という元の病気に戻る。
    await this.#write(
      entries.map((entry) => entry.name),
      { strict: true },
    );
    return this.fingerprints();
  }

  async flush(): Promise<CredentialFingerprint[]> {
    // 起動は器が無くても続ける（ローカルでは置き場が作れないことがある）。
    // その場合も env 経由の経路は残るので、新しいマネージャーには鍵が渡る。
    await this.#write([...this.#held.keys()], { strict: false });
    return this.fingerprints();
  }

  /** 直近の書き込みに失敗していれば理由。成功していれば undefined。 */
  get lastWriteError(): string | undefined {
    return this.#lastWriteError;
  }

  async #write(names: readonly string[], options: { strict: boolean }): Promise<void> {
    if (names.length === 0) return;
    try {
      // 中を覗けるのは読める主体だけでよい。一覧はできなくてよいので 0o711。
      await mkdir(this.#dir, { recursive: true, mode: 0o711 });
      for (const name of names) await this.#writeOne(name);
      this.#lastWriteError = undefined;
    } catch (error) {
      this.#lastWriteError = String(error);
      process.stderr.write(
        `alteroid-runner: 鍵を器へ書けませんでした（走行中の差し替えは届きません）: ${this.#lastWriteError}\n`,
      );
      if (options.strict) throw error;
    }
  }

  /**
   * 1件を器へ落とす。**書いてから名前を差し替える**（rename は不可分）。
   *
   * 直接上書きしないのは2つの理由による。1つは 0400 のファイルは所有者でも開き
   * 直せないこと（ここを踏んで差し替えが黙って落ちた）。もう1つは、読む側が
   * `cat` した瞬間に**書きかけの鍵**を掴む窓を作らないためである。
   */
  async #writeOne(name: string): Promise<void> {
    const path = join(this.#dir, name);
    const held = this.#held.get(name);
    if (held === undefined) {
      await rm(path, { force: true });
      return;
    }
    const staging = `${path}.${randomUUID().slice(0, 8)}`;
    try {
      // 改行を足さない。`cat` した値がそのまま鍵になる。
      await writeFile(staging, held.value, { mode: 0o400 });
      if (this.#reader !== undefined) {
        await chown(staging, this.#reader.uid, this.#reader.gid);
      }
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
