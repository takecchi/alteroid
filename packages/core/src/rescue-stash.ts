import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { codePointBoundary } from './excerpt.js';
import { credentialSourceRefusal, resolveCredentialSources } from './file-put.js';
import { secretPatternsInBody } from './redact.js';
import { ensureOwnDirectorySync } from './runner-outbox.js';
import { isSafeRunnerSegment } from './runner-attachments.js';
import type { RunnerRescueFile, RunnerRescueSkipped } from './runner-protocol.js';

/**
 * 未追跡のファイルを、デーモンの非公開の置き場へ預けるための、runner 側の選び方と読み出し（#4863 案A）。
 * 退避 ref は公開 repo へ送らない決定なので、未追跡の中身は別の経路でしか守れない。
 *
 * 読み方は出し箱の取り込み（`runner-outbox.ts` の `takeEntry`）と同じ安全策に揃える: runner（root のことがある）が、
 * 担い手の置いたファイルを開くので、名前を信じない（`O_NOFOLLOW`・通常ファイルか・所有者が担い手か・ハードリンクでないか）。
 * 出し箱と違い、元のファイルは消さない（担い手の作業ツリーの持ち物）。
 * 退避先は出し箱の退避先と分ける: 同じ dir だと、預かりが出し箱の予算（`STAGED_BUDGET_FACTOR`）を食い、成果物が出し箱から出られなくなる。
 */

export const RESCUE_STASH_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** 1周期（1回の退避）に退避先へ写す合計の上限。超えた分は次の周期へ回す。 */
export const RESCUE_STASH_CYCLE_MAX_BYTES = 200 * 1024 * 1024;
/**
 * 退避先（1委譲ぶん）に溜めておける合計の上限。デーモンが取りに来ない（旧い daemon・繋がらない）間に退避先が器のディスクを食わないため。
 * 取りに来れば `DELETE` で減り、来なくても24時間の掃除が消す。
 */
export const RESCUE_STASH_STAGED_MAX_BYTES = 512 * 1024 * 1024;
/** 1回の呼び出しで調べる名前の上限。超えた分は `cycle-budget` として1件にまとめて知らせる。 */
export const RESCUE_STASH_NAMES_PER_CYCLE = 1000;

const SKIPPED_PATH_MAX_LENGTH = 200;
const COPY_CHUNK_BYTES = 64 * 1024;

export function defaultRunnerRescueStagedRoot(): string {
  return join(tmpdir(), 'alteroid-rescue-staged');
}

interface SeenStat {
  readonly size: number;
  readonly mtimeMs: number;
}

interface SentEntry extends SeenStat {
  readonly sha256: string;
}

interface TreeMemory {
  readonly seen: Map<string, SeenStat>;
  readonly sent: Map<string, SentEntry>;
  /** 知らせた「預けなかった」の署名。同じ署名は再び知らせない（毎周期同じ日誌を積まない）。 */
  readonly skipped: Map<string, string>;
  /** 判断が変わらない断り（中身か大きさが変わるまで同じ結論）の署名。読み直さない。 */
  readonly settled: Map<string, string>;
}

/**
 * 届いたかの返事を受けないので、`takeResend` の周期（`RESCUE_RESEND_AFTER_MS`）で「送った」記憶を捨てて運び直す。
 * デーモンが sha256 で重複を捨てる。
 */
export class RescueStashMemory {
  readonly #trees = new Map<string, TreeMemory>();

  tree(repoRoot: string): TreeMemory {
    let tree = this.#trees.get(repoRoot);
    if (tree === undefined) {
      tree = { seen: new Map(), sent: new Map(), skipped: new Map(), settled: new Map() };
      this.#trees.set(repoRoot, tree);
    }
    return tree;
  }

  forgetSent(): void {
    for (const tree of this.#trees.values()) {
      tree.sent.clear();
      tree.skipped.clear();
    }
  }

  retain(repoRoots: ReadonlySet<string>): void {
    for (const root of [...this.#trees.keys()]) {
      if (!repoRoots.has(root)) this.#trees.delete(root);
    }
  }
}

/** 1周期の間、作業ツリーをまたいで共有する予算。 */
export interface RescueStashCycle {
  bytesLeft: number;
}

export function newRescueStashCycle(): RescueStashCycle {
  return { bytesLeft: RESCUE_STASH_CYCLE_MAX_BYTES };
}

export interface RescueStashOptions {
  readonly managerId: string;
  readonly stagedRoot: string;
  /** 所有者の検査。出し箱と同じ: ハードリンクや他人のファイルで、runner の持ち物を読まされないため。`undefined` は uid を持たない環境。 */
  readonly expectedUid: number | undefined;
  /** 秘密の判定に使う env（担い手の子へ渡す env）。 */
  readonly secretEnv: NodeJS.ProcessEnv;
  /** 資格の置き場の判定に使う env（`ALTEROID_CREDENTIAL_DIR`・`*_FILE`）。 */
  readonly credentialEnv: NodeJS.ProcessEnv;
  readonly memory: RescueStashMemory;
  readonly cycle: RescueStashCycle;
  /** 畳む直前の回。安定を待たずに預ける（待つと、畳んだ後の器と一緒に消える）。 */
  readonly final?: boolean;
  readonly signal?: AbortSignal;
}

export interface RescueStashResult {
  readonly files: RunnerRescueFile[];
  readonly skipped: RunnerRescueSkipped[];
}

class Skip extends Error {
  constructor(
    readonly reason: string,
    readonly patterns?: readonly string[],
  ) {
    super(reason);
  }
}

function clip(name: string): string {
  return name.length > SKIPPED_PATH_MAX_LENGTH
    ? `${name.slice(0, codePointBoundary(name, SKIPPED_PATH_MAX_LENGTH))}…`
    : name;
}

async function stagedBytesOf(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info?.isFile() === true) total += info.size;
  }
  return total;
}

async function readAll(handle: FileHandle, size: number): Promise<Buffer | undefined> {
  const out = Buffer.allocUnsafe(size);
  let total = 0;
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  for (;;) {
    // 1バイト余分に読む: 読んでいる間に伸ばされたことを見つけるため
    const { bytesRead } = await handle.read(chunk, 0, COPY_CHUNK_BYTES, null);
    if (bytesRead === 0) break;
    if (total + bytesRead > size) return undefined;
    chunk.copy(out, total, 0, bytesRead);
    total += bytesRead;
  }
  return total === size ? out : undefined;
}

/**
 * `names` は `git ls-files --others` の（`repoRoot` からの相対の）名前。退避 ref の push の成否とは独立に呼ぶ。
 * 預けなかったものは捨てず、パスと理由（秘密の規則は名前だけ）で返す。
 */
export async function stashUntrackedFiles(
  repoRoot: string,
  names: readonly string[],
  options: RescueStashOptions,
): Promise<RescueStashResult> {
  const files: RunnerRescueFile[] = [];
  const skipped: RunnerRescueSkipped[] = [];
  if (!isSafeRunnerSegment(options.managerId)) return { files, skipped };
  const tree = options.memory.tree(repoRoot);
  const present = new Set(names);
  for (const known of [...tree.seen.keys()]) if (!present.has(known)) tree.seen.delete(known);
  for (const known of [...tree.sent.keys()]) if (!present.has(known)) tree.sent.delete(known);
  for (const known of [...tree.skipped.keys()]) if (!present.has(known)) tree.skipped.delete(known);
  for (const known of [...tree.settled.keys()]) if (!present.has(known)) tree.settled.delete(known);
  if (names.length === 0) return { files, skipped };

  ensureOwnDirectorySync(resolve(options.stagedRoot), 0o700, { recursive: true });
  const stagedDir = resolve(options.stagedRoot, options.managerId);
  ensureOwnDirectorySync(stagedDir, 0o700);
  let stagedBytes = await stagedBytesOf(stagedDir);
  const root = resolve(repoRoot);
  const sources = await resolveCredentialSources(options.credentialEnv);

  const report = (path: string, signature: string, skip: Skip): void => {
    if (tree.skipped.get(path) === signature) return;
    tree.skipped.set(path, signature);
    skipped.push({
      path: clip(path),
      reason: skip.reason,
      ...(skip.patterns === undefined ? {} : { patterns: [...skip.patterns] }),
    });
  };

  const sorted = [...names].sort();
  let examined = 0;
  for (const name of sorted) {
    if (options.signal?.aborted === true) break;
    if (examined >= RESCUE_STASH_NAMES_PER_CYCLE) {
      const rest = sorted.length - examined;
      report(
        '(省略)',
        `names:${String(rest)}`,
        new Skip(
          `cycle-budget（1回に調べる名前の上限 ${String(RESCUE_STASH_NAMES_PER_CYCLE)} 件。ほか ${String(rest)} 件は次の周期へ回す）`,
        ),
      );
      break;
    }
    examined += 1;
    const abs = resolve(root, name);
    if (name === '' || name.includes('\0') || isAbsolute(name) || !abs.startsWith(root + sep)) {
      continue;
    }
    let info;
    try {
      info = await lstat(abs);
    } catch {
      tree.seen.delete(name);
      continue;
    }
    const signature = `${String(info.size)}:${String(info.mtimeMs)}`;
    try {
      if (!info.isFile()) throw new Skip('not-regular');
      if (tree.settled.get(name) === signature) continue;
      const sent = tree.sent.get(name);
      if (sent !== undefined && sent.size === info.size && sent.mtimeMs === info.mtimeMs) continue;
      if (info.size === 0) {
        tree.settled.set(name, signature);
        throw new Skip('empty');
      }
      if (info.size > RESCUE_STASH_FILE_MAX_BYTES) {
        tree.settled.set(name, signature);
        throw new Skip('too-large');
      }
      // 書きかけを預けない: 前の周期と同じ (size, mtimeMs) になってから預ける。畳む直前の回は待たない
      const prev = tree.seen.get(name);
      tree.seen.set(name, { size: info.size, mtimeMs: info.mtimeMs });
      if (
        options.final !== true &&
        (prev === undefined || prev.size !== info.size || prev.mtimeMs !== info.mtimeMs)
      ) {
        continue;
      }
      if (
        info.size > options.cycle.bytesLeft ||
        stagedBytes + info.size > RESCUE_STASH_STAGED_MAX_BYTES
      ) {
        throw new Skip('cycle-budget');
      }

      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        continue;
      }
      if (credentialSourceRefusal(real, sources) !== undefined) {
        tree.settled.set(name, signature);
        throw new Skip('credential');
      }

      let handle: FileHandle;
      try {
        handle = await open(
          abs,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENXIO') {
          tree.settled.set(name, signature);
          throw new Skip('not-regular');
        }
        if (code === 'ENOENT') continue;
        throw new Skip('unreadable');
      }
      let buffer: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) {
          tree.settled.set(name, signature);
          throw new Skip('not-regular');
        }
        if (options.expectedUid !== undefined && opened.uid !== options.expectedUid) {
          tree.settled.set(name, signature);
          throw new Skip('not-owner');
        }
        if (opened.nlink > 1) {
          tree.settled.set(name, signature);
          throw new Skip('hardlink');
        }
        if (opened.size === 0 || opened.size > RESCUE_STASH_FILE_MAX_BYTES) {
          throw new Skip('changed');
        }
        const read = await readAll(handle, opened.size);
        if (read === undefined) throw new Skip('changed');
        buffer = read;
      } finally {
        await handle.close();
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      // NUL を含むものはバイナリ: 固有の接頭辞の規則と環境変数の鍵の値だけ見る（形だけの規則に PNG などが当たるため）
      const binary = buffer.includes(0);
      const patterns = secretPatternsInBody(buffer.toString('utf8'), options.secretEnv, { binary });
      if (patterns.length > 0) {
        tree.settled.set(name, signature);
        throw new Skip('secret-like', patterns);
      }
      if (sent !== undefined && sent.sha256 === sha256) {
        tree.sent.set(name, { sha256, size: info.size, mtimeMs: info.mtimeMs });
        continue;
      }

      const fileId = randomBytes(16).toString('hex');
      const stagedPath = join(stagedDir, fileId);
      const out = await open(stagedPath, 'wx', 0o400);
      try {
        await out.writeFile(buffer);
      } catch {
        await rm(stagedPath, { force: true }).catch(() => undefined);
        throw new Skip('unreadable');
      } finally {
        await out.close();
      }
      options.cycle.bytesLeft -= buffer.length;
      stagedBytes += buffer.length;
      tree.sent.set(name, { sha256, size: buffer.length, mtimeMs: info.mtimeMs });
      tree.skipped.delete(name);
      files.push({ fileId, path: name, size: buffer.length, sha256 });
    } catch (error) {
      if (error instanceof Skip) {
        report(name, `${error.reason}:${signature}`, error);
        continue;
      }
      report(name, `unreadable:${signature}`, new Skip('unreadable'));
    }
  }
  return { files, skipped };
}
