/**
 * runner の側で、Codex の ChatGPT ログイン（正本はデーモン）を `CODEX_HOME/auth.json` に写し、
 * Codex が書き換えた（トークンを更新した）ことを見つけてデーモンへ知らせる（#3939）。
 *
 * ## 流れ
 *
 * 1. デーモンが正本を降ろす（{@link CodexAuthMirror.set}。値と版）。runner はメモリにだけ持つ
 *    （記憶ストアの鍵を持たない。`cloud-deployment` の境界）。
 * 2. peer の Codex を起こすとき、駆動役が {@link CodexAuthMirror.prepare} を呼ぶ。ログインが
 *    降りていれば `CODEX_HOME/auth.json`（0600・子の UID）を書き出してその `CODEX_HOME` を返す。
 *    **値は子の環境変数には置かない**（`CODEX_API_KEY` を子の env から外しているのと同じ考え）。
 * 3. Codex がトークンを更新すると `auth.json` が書き換わる。{@link CodexAuthMirror.check}
 *    （セッションの終わり・`account/updated`・定期の見回り）がそれを見つけ、**指紋と読んだ版だけ**を
 *    出来事で知らせる。値はデーモンが制御面で取りに来る（{@link CodexAuthMirror.takeWriteBack}）。
 *    出来事の流れに秘密を載せないため。
 * 4. デーモンは「読んだ版と同じなら上書き」で正本へ書き戻し、新しい版を全 runner へ降ろし直す。
 *    負けた runner には正本の値が降りてきて、ファイルが上書きされる（古い値が新しい値を潰さない）。
 *
 * **ログインが降りていなければ何もしない**（ファイルも `CODEX_HOME` も触らない）。
 */

import { createHash } from 'node:crypto';
import { chown, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** デーモンが降ろす正本（値と版）。`null` はログインしていない（外す）。 */
export type CodexAuthPush = { value: string; revision: string } | null;

/** runner からデーモンへの知らせ（値は載せない）。 */
export type CodexAuthNotice =
  | { kind: 'changed'; baseRevision: string; fingerprint: string }
  | { kind: 'failed'; baseRevision: string; reason: string };

export interface CodexAuthWriteBack {
  value: string;
  baseRevision: string;
  fingerprint: string;
}

/** ファイルまわり（テストの差し替え口）。 */
export interface CodexAuthMirrorFs {
  mkdir(path: string): Promise<void>;
  /**
   * `path` に `data` を 0600 で置く（同じディレクトリの一時ファイルから rename）。`owner` が在れば
   * **rename の前に**一時ファイルの持ち主を変える（走っている Codex が持ち主の違うファイルを掴む窓を作らない）。
   */
  writeFile(path: string, data: string, owner?: { uid: number; gid: number }): Promise<void>;
  /** 無ければ `null`。 */
  readFile(path: string): Promise<string | null>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  rm(path: string): Promise<void>;
}

const defaultFs: CodexAuthMirrorFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  writeFile: async (path, data, owner) => {
    const tmp = `${path}.alteroid-${String(process.pid)}.tmp`;
    await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    try {
      if (owner !== undefined) await chown(tmp, owner.uid, owner.gid);
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  },
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  chown: (path, uid, gid) => chown(path, uid, gid),
  rm: (path) => rm(path, { force: true }),
};

/** 値の指紋（sha256 の先頭12桁。`fingerprintOf` と同じ形。runner の依存を増やさないためここで計算する）。 */
export function codexAuthFingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

export interface CodexAuthMirrorOptions {
  /** `CODEX_HOME`。runner ごとに1か所。 */
  codexHome: string;
  /** 子の UID / GID（別 UID で起こす器のとき）。置いたファイルとディレクトリをその持ち主にする。 */
  owner?: { uid: number; gid: number };
  fs?: CodexAuthMirrorFs;
  /** デーモンへの知らせ（出来事）。 */
  onNotice: (notice: CodexAuthNotice) => void;
}

/** 状態の見え方（制御面の `GET` 用。値は持たない）。 */
export interface CodexAuthMirrorStatus {
  placed: boolean;
  revision: string | null;
  fingerprint: string | null;
}

export class CodexAuthMirror {
  readonly #codexHome: string;
  readonly #path: string;
  readonly #owner: { uid: number; gid: number } | undefined;
  readonly #fs: CodexAuthMirrorFs;
  readonly #onNotice: (notice: CodexAuthNotice) => void;
  /** 降りている正本（無ければ `null`）。 */
  #placed: { value: string; revision: string; fingerprint: string } | null = null;
  /** いまファイルに在るはずの中身の指紋（自分が書いた・既に知らせた）。 */
  #known: string | null = null;
  #pending: CodexAuthWriteBack | null = null;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: CodexAuthMirrorOptions) {
    this.#codexHome = options.codexHome;
    this.#path = join(options.codexHome, 'auth.json');
    this.#owner = options.owner;
    this.#fs = options.fs ?? defaultFs;
    this.#onNotice = options.onNotice;
  }

  get codexHome(): string {
    return this.#codexHome;
  }

  status(): CodexAuthMirrorStatus {
    return {
      placed: this.#placed !== null,
      revision: this.#placed?.revision ?? null,
      fingerprint: this.#placed?.fingerprint ?? null,
    };
  }

  /** 1本の列で順に（降ろし直し・見回り・書き出しが重ならない）。 */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** デーモンが正本を降ろす。`null` はログアウト（ファイルを消す）。 */
  set(push: CodexAuthPush): Promise<void> {
    return this.#serial(async () => {
      // 降ろし直しで上書きする前に、まだ知らせていない書き換えを拾う（失わない）。
      await this.#checkNow();
      if (push === null) {
        const had = this.#placed !== null;
        this.#placed = null;
        this.#known = null;
        this.#pending = null;
        if (had) await this.#fs.rm(this.#path);
        return;
      }
      const fingerprint = codexAuthFingerprintOf(push.value);
      const pending = this.#pending;
      if (
        this.#placed?.revision === push.revision &&
        pending !== null &&
        pending.baseRevision === push.revision
      ) {
        // 同じ版の降ろし直し（名乗り直し等）だが、手元には Codex が更新した新しい中身があり、
        // 書き戻しの最中である。古い正本で上書きしない（書き戻しが通れば新しい版が降りてくる）。
        return;
      }
      this.#placed = { value: push.value, revision: push.revision, fingerprint };
      // 版が進んだ（自分の書き戻しが通った・他の runner の更新が勝った）。手元の書き戻しは古い。
      this.#pending = null;
      const onDisk = await this.#fs.readFile(this.#path);
      if (onDisk !== null && codexAuthFingerprintOf(onDisk) === fingerprint) {
        // 同じ中身（自分の書き戻しが通って戻ってきた等）。版だけを進める。
        this.#known = fingerprint;
        return;
      }
      await this.#writeFile(push.value);
      this.#known = fingerprint;
    });
  }

  /**
   * Codex を起こす直前に呼ぶ。ログインが降りていれば `auth.json` を（無ければ）書き出し、
   * `CODEX_HOME` を返す。降りていなければ `undefined`（何も触らない）。
   */
  prepare(): Promise<string | undefined> {
    return this.#serial(async () => {
      const placed = this.#placed;
      if (placed === null) return undefined;
      await this.#checkNow();
      const onDisk = await this.#fs.readFile(this.#path);
      if (onDisk === null) {
        await this.#writeFile(placed.value);
        this.#known = placed.fingerprint;
      }
      return this.#codexHome;
    });
  }

  /** Codex が `auth.json` を書き換えたかを見る。書き換わっていれば知らせる。 */
  check(): Promise<void> {
    return this.#serial(() => this.#checkNow());
  }

  /** デーモンが書き戻しの値を取りに来る。指紋が一致するものだけを渡す。 */
  takeWriteBack(fingerprint: string): CodexAuthWriteBack | null {
    const pending = this.#pending;
    if (pending === null || pending.fingerprint !== fingerprint) return null;
    return pending;
  }

  /** 認証が切れた・失効した・更新に失敗した、を知らせる。理由は伏せ字を通したものを渡すこと。 */
  reportFailure(reason: string): void {
    const placed = this.#placed;
    if (placed === null) return;
    this.#onNotice({ kind: 'failed', baseRevision: placed.revision, reason });
  }

  async #checkNow(): Promise<void> {
    const placed = this.#placed;
    if (placed === null) return;
    let onDisk: string | null;
    try {
      onDisk = await this.#fs.readFile(this.#path);
    } catch {
      return; // 読めない回は次の見回りで。
    }
    if (onDisk === null) return;
    const fingerprint = codexAuthFingerprintOf(onDisk);
    if (fingerprint === this.#known) return;
    this.#known = fingerprint;
    this.#pending = { value: onDisk, baseRevision: placed.revision, fingerprint };
    this.#onNotice({ kind: 'changed', baseRevision: placed.revision, fingerprint });
  }

  async #writeFile(value: string): Promise<void> {
    await this.#fs.mkdir(this.#codexHome);
    if (this.#owner !== undefined) {
      await this.#fs.chown(this.#codexHome, this.#owner.uid, this.#owner.gid);
    }
    await this.#fs.writeFile(this.#path, value, this.#owner);
  }
}
