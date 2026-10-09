// 値は子の環境変数に置かない。知らせ（出来事）には指紋と版だけを載せ、値はデーモンが制御面で取りに来る: 出来事の流れに秘密を載せないため。
// runner は値をメモリにだけ持つ: 記憶ストアの鍵を持たない境界のため。

import { createHash } from 'node:crypto';
import { chown, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CodexAuthPush = { value: string; revision: string } | null;

export type CodexAuthNotice =
  | { kind: 'changed'; baseRevision: string; fingerprint: string }
  | { kind: 'failed'; baseRevision: string; reason: string };

export interface CodexAuthWriteBack {
  value: string;
  baseRevision: string;
  fingerprint: string;
}

export interface CodexAuthMirrorFs {
  mkdir(path: string): Promise<void>;
  // rename の前に一時ファイルの持ち主を変える: 走っている Codex が持ち主の違うファイルを掴む窓を作らないため。
  writeFile(path: string, data: string, owner?: { uid: number; gid: number }): Promise<void>;
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

// `fingerprintOf` を使わずここで計算する: runner の依存を増やさないため。
export function codexAuthFingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

export interface CodexAuthMirrorOptions {
  codexHome: string;
  owner?: { uid: number; gid: number };
  fs?: CodexAuthMirrorFs;
  onNotice: (notice: CodexAuthNotice) => void;
}

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
  #placed: { value: string; revision: string; fingerprint: string } | null = null;
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

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  set(push: CodexAuthPush): Promise<void> {
    return this.#serial(async () => {
      // 上書きする前に、まだ知らせていない書き換えを拾う: 失わないため。
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
        // 古い正本で上書きしない: 手元には Codex が更新した新しい中身があり、書き戻しの最中のため。
        return;
      }
      this.#placed = { value: push.value, revision: push.revision, fingerprint };
      this.#pending = null;
      const onDisk = await this.#fs.readFile(this.#path);
      if (onDisk !== null && codexAuthFingerprintOf(onDisk) === fingerprint) {
        this.#known = fingerprint;
        return;
      }
      await this.#writeFile(push.value);
      this.#known = fingerprint;
    });
  }

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

  check(): Promise<void> {
    return this.#serial(() => this.#checkNow());
  }

  takeWriteBack(fingerprint: string): CodexAuthWriteBack | null {
    const pending = this.#pending;
    if (pending === null || pending.fingerprint !== fingerprint) return null;
    return pending;
  }

  // reason は伏せ字を通したものを渡すこと: 値を知らせに載せないため。
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
      return;
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
