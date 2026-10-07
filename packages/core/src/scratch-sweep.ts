import { lstat, readdir, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

import { reasonOf } from './dropped-record.js';
import { codePointBoundary } from './excerpt.js';
import type { ScratchSweepEvent, ScratchSweepItem } from './runner-protocol.js';
import {
  findGitDirs,
  isManagerScratchDirName,
  matchesManagerScratchDirName,
  runGit,
  type ProcessSpawnFn,
  type ReaddirFn,
} from './unpushed-work.js';

export const SCRATCH_SWEEP_GRACE_MS_ENV_KEY = 'ALTEROID_SCRATCH_SWEEP_GRACE_MS';
export const SCRATCH_SWEEP_INTERVAL_MS_ENV_KEY = 'ALTEROID_SCRATCH_SWEEP_INTERVAL_MS';

export const DEFAULT_SCRATCH_SWEEP_GRACE_MS = 2 * 60 * 60_000;
export const DEFAULT_SCRATCH_SWEEP_INTERVAL_MS = 10 * 60_000;
export const MIN_SCRATCH_SWEEP_INTERVAL_MS = 1000;
export const MAX_SCRATCH_SWEEP_MS = 2_147_483_647;

export const SCRATCH_SWEEP_UNTRACKED_NAMES_LIMIT = 20;
export const SCRATCH_SWEEP_NAME_MAX_LENGTH = 200;
// 深さを実質外す値にする: `.git` を見落として「無い」と判定しないため。それでも降りなかった枝は「判定できない」で残す
export const SCRATCH_SWEEP_MAX_DEPTH = 12;
export const SCRATCH_SWEEP_CONTENT_SCAN_LIMIT = 1000;
export const SCRATCH_SWEEP_NODE_MODULES_LIMIT = 100;
export const SCRATCH_SWEEP_GIT_TIMEOUT_MS = 15_000;

function resolveMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return fallback;
  const parsed = Number(trimmed);
  // 範囲へ挟まず既定へ戻す: 猶予は短すぎる値で作業場を早く消す向きに効くため
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function resolveScratchSweepGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMs(
    env[SCRATCH_SWEEP_GRACE_MS_ENV_KEY],
    DEFAULT_SCRATCH_SWEEP_GRACE_MS,
    0,
    MAX_SCRATCH_SWEEP_MS * 1000,
  );
}

export function resolveScratchSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMs(
    env[SCRATCH_SWEEP_INTERVAL_MS_ENV_KEY],
    DEFAULT_SCRATCH_SWEEP_INTERVAL_MS,
    MIN_SCRATCH_SWEEP_INTERVAL_MS,
    MAX_SCRATCH_SWEEP_MS,
  );
}

export interface ScratchDirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ScratchSweepStatfs {
  readonly bsize: number;
  readonly blocks: number;
  readonly bfree: number;
  readonly files: number;
  readonly ffree: number;
}

export interface ScratchSweeperOptions {
  tmpRoot: string;
  spawn: ProcessSpawnFn;
  env: Record<string, string | undefined>;
  liveManagerIds: () => readonly string[];
  knownManagerIds?: () => readonly string[];
  graceMs: number;
  startedAt: number;
  now?: () => number;
  gitTimeoutMs?: number;
  readdirFn?: (dir: string) => Promise<readonly ScratchDirEntry[]>;
  gitReaddirFn?: ReaddirFn;
  maxDepth?: number;
  existsFn?: (p: string) => Promise<boolean>;
  sizeFn?: (p: string) => Promise<number>;
  realpathFn?: (p: string) => Promise<string>;
  rmFn?: (p: string) => Promise<void>;
  statfsFn?: (p: string) => Promise<ScratchSweepStatfs>;
}

interface TreeInspection {
  readonly root: string;
  // HEAD だけを見ない: チェックアウトしていない別の枝の未 push も数えないと、作業場ごと消えて失われるため
  readonly unpushed: number | 'unknown';
  readonly tracked: number | 'unknown';
  readonly untracked: readonly string[] | 'unknown';
  readonly worktreePaths: readonly string[] | 'unknown';
  readonly stash: boolean | 'unknown';
  readonly isMain: boolean;
  readonly unknownDetail?: string;
}

interface DirInspection {
  readonly trees: readonly TreeInspection[];
  readonly searchUnknown?: string;
}

type Verdict =
  | { kind: 'remove'; untracked: string[]; untrackedCount: number }
  | {
      kind: 'keep';
      reason: NonNullable<ScratchSweepItem['reason']>;
      count?: number;
      untracked?: { count: number; names: string[] };
      files?: { count: number; names: string[] };
      detail: string;
    };

function clip(text: string): string {
  return text.length <= SCRATCH_SWEEP_NAME_MAX_LENGTH
    ? text
    : `${text.slice(0, codePointBoundary(text, SCRATCH_SWEEP_NAME_MAX_LENGTH))}…`;
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function unsafeNodeModulesTarget(
  base: string,
  target: string,
  realpathFn: (p: string) => Promise<string>,
): Promise<string | undefined> {
  if (base === '' || !path.isAbsolute(base)) return `基点が空でない絶対パスでない（'${base}'）`;
  const resolvedBase = path.resolve(base);
  if (resolvedBase === path.parse(resolvedBase).root) return '基点が / そのものである';
  const resolved = path.resolve(target);
  const rel = path.relative(resolvedBase, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return '対象が基点の外にある';
  const segs = rel.split(path.sep);
  const first = segs[0] ?? '';
  if (!isManagerScratchDirName(first)) return '対象が mgr- 規則の作業場の下にない';
  if (segs.length < 2) return '対象が作業場そのものである';
  if (path.basename(resolved) !== 'node_modules') return '対象の名前が node_modules でない';
  try {
    const real = await realpathFn(resolved);
    const realBase = await realpathFn(resolvedBase);
    if (real !== path.join(realBase, rel)) return `途中に symlink を挟んでいる（${real}）`;
  } catch (error) {
    return `realpath を取れなかった: ${reasonOf(error)}`;
  }
  return undefined;
}

export class ScratchSweeper {
  readonly #o: ScratchSweeperOptions;
  readonly #now: () => number;
  readonly #unclaimedSince = new Map<string, number>();
  #notifiedKept = new Set<string>();
  #firstScanDone = false;

  constructor(options: ScratchSweeperOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  // 畳まれた done・stopped・failed も守る: デーモンが `manager_send` で resume しうるため
  #liveClaimedBy(name: string): string | undefined {
    return this.#o.liveManagerIds().find((id) => matchesManagerScratchDirName(name, id));
  }

  #claimedBy(name: string): string | undefined {
    return [...this.#o.liveManagerIds(), ...(this.#o.knownManagerIds?.() ?? [])].find((id) =>
      matchesManagerScratchDirName(name, id),
    );
  }

  #knownIdFor(name: string): string | undefined {
    const ids = [...(this.#o.knownManagerIds?.() ?? []), ...this.#o.liveManagerIds()];
    return ids.find((id) => matchesManagerScratchDirName(name, id));
  }

  #unsafeTargetReason(target: string): string | undefined {
    const base = this.#o.tmpRoot;
    if (base === '' || !path.isAbsolute(base)) return `基点が空でない絶対パスでない（'${base}'）`;
    const resolvedBase = path.resolve(base);
    if (resolvedBase === path.parse(resolvedBase).root) return '基点が / そのものである';
    const resolved = path.resolve(target);
    if (resolved === resolvedBase) return '対象が基点そのものである';
    if (path.dirname(resolved) !== resolvedBase) return `対象が基点の直下でない（${resolved}）`;
    if (!isManagerScratchDirName(path.basename(resolved)))
      return '対象の名前が mgr- 規則に当たらない';
    return undefined;
  }

  async #git(
    args: string[],
    cwd: string,
  ): Promise<{ ok: true; out: string } | { ok: false; why: string }> {
    const timeoutMs = this.#o.gitTimeoutMs ?? SCRATCH_SWEEP_GIT_TIMEOUT_MS;
    const r = await runGit(this.#o.spawn, args, cwd, this.#o.env, timeoutMs);
    if (r.timedOut) return { ok: false, why: `git ${args[0]} が期限切れ（${timeoutMs}ms）` };
    if (r.exitCode !== 0) return { ok: false, why: `git ${args[0]} が exit ${String(r.exitCode)}` };
    return { ok: true, out: r.stdout };
  }

  async #stash(root: string): Promise<{ ok: true; present: boolean } | { ok: false; why: string }> {
    const timeoutMs = this.#o.gitTimeoutMs ?? SCRATCH_SWEEP_GIT_TIMEOUT_MS;
    const r = await runGit(
      this.#o.spawn,
      ['rev-parse', '--verify', '--quiet', 'refs/stash'],
      root,
      this.#o.env,
      timeoutMs,
    );
    if (r.timedOut)
      return { ok: false, why: `git rev-parse refs/stash が期限切れ（${timeoutMs}ms）` };
    if (r.exitCode === 0) return { ok: true, present: true };
    if (r.exitCode === 1) return { ok: true, present: false };
    return { ok: false, why: `git rev-parse refs/stash が exit ${String(r.exitCode)}` };
  }

  async #inspectTree(root: string): Promise<TreeInspection> {
    const [rev, status, others, wt, gitDir, stashRef] = [
      await this.#git(
        ['rev-list', '--count', 'HEAD', '--branches', '--not', '--remotes=origin'],
        root,
      ),
      await this.#git(['status', '--porcelain'], root),
      await this.#git(['ls-files', '--others', '--exclude-standard'], root),
      await this.#git(['worktree', 'list', '--porcelain'], root),
      await this.#git(['rev-parse', '--git-dir'], root),
      await this.#stash(root),
    ];
    const whys: string[] = [];
    let unpushed: number | 'unknown' = 'unknown';
    if (rev.ok) {
      const n = Number.parseInt(rev.out.trim(), 10);
      if (Number.isFinite(n)) unpushed = n;
      else whys.push('git rev-list の出力を読めなかった');
    } else whys.push(rev.why);
    let tracked: number | 'unknown' = 'unknown';
    if (status.ok) {
      tracked = status.out.split('\n').filter((l) => l.length > 0 && !l.startsWith('??')).length;
    } else whys.push(status.why);
    let untracked: string[] | 'unknown' = 'unknown';
    if (others.ok) untracked = others.out.split('\n').filter((l) => l.length > 0);
    else whys.push(others.why);
    let stash: boolean | 'unknown' = 'unknown';
    if (stashRef.ok) stash = stashRef.present;
    else whys.push(stashRef.why);
    let worktreePaths: string[] | 'unknown' = 'unknown';
    if (wt.ok) {
      worktreePaths = wt.out
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length));
    } else whys.push(wt.why);
    return {
      root,
      unpushed,
      tracked,
      untracked,
      worktreePaths,
      stash,
      isMain: !gitDir.ok || gitDir.out.trim() === '.git',
      ...(whys.length > 0 ? { unknownDetail: whys.join('、') } : {}),
    };
  }

  async #inspectDir(dir: string, signal: AbortSignal): Promise<DirInspection> {
    const found = await findGitDirs(dir, {
      maxDepth: this.#o.maxDepth ?? SCRATCH_SWEEP_MAX_DEPTH,
      reportDepthLimit: true,
      ...(this.#o.gitReaddirFn === undefined ? {} : { readdirFn: this.#o.gitReaddirFn }),
    });
    if (found.rootUnreadable !== undefined) {
      return { trees: [], searchUnknown: `${dir} を読めなかった: ${found.rootUnreadable}` };
    }
    let searchUnknown: string | undefined;
    if (found.truncatedAtCount !== undefined) {
      searchUnknown = `作業ツリーの探索を ${String(found.truncatedAtCount)} 件で打ち切った`;
    } else if (found.depthLimitedCount !== undefined) {
      searchUnknown = `深さ上限より下に降りなかった子ディレクトリが ${String(found.depthLimitedCount)} 個（${found.depthLimitedSample ?? ''}）`;
    } else if (found.unreadableDirCount !== undefined) {
      searchUnknown = `読めない子ディレクトリが ${String(found.unreadableDirCount)} 個（${found.unreadableDirSample ?? ''}）`;
    }
    const trees: TreeInspection[] = [];
    for (const root of found.paths) {
      if (signal.aborted) {
        searchUnknown ??= '片付けを中断した';
        break;
      }
      trees.push(await this.#inspectTree(root));
    }
    return { trees, ...(searchUnknown === undefined ? {} : { searchUnknown }) };
  }

  #verdictOf(insp: DirInspection): Verdict {
    if (insp.searchUnknown !== undefined) {
      return { kind: 'keep', reason: 'undecidable', detail: insp.searchUnknown };
    }
    let unpushedTotal = 0;
    let unpushedAt: string | undefined;
    let trackedTotal = 0;
    let trackedAt: string | undefined;
    let stashAt: string | undefined;
    let unknownAt: string | undefined;
    const untracked: string[] = [];
    let untrackedCount = 0;
    for (const tree of insp.trees) {
      if (
        tree.unpushed === 'unknown' ||
        tree.tracked === 'unknown' ||
        tree.untracked === 'unknown' ||
        tree.stash === 'unknown' ||
        tree.worktreePaths === 'unknown'
      ) {
        unknownAt ??= `${tree.root}: ${tree.unknownDetail ?? '判定できなかった'}`;
        continue;
      }
      if (tree.unpushed > 0) {
        unpushedTotal += tree.unpushed;
        unpushedAt ??= tree.root;
      }
      if (tree.tracked > 0) {
        trackedTotal += tree.tracked;
        trackedAt ??= tree.root;
      }
      if (tree.stash) stashAt ??= tree.root;
      untrackedCount += tree.untracked.length;
      for (const file of tree.untracked) {
        if (untracked.length >= SCRATCH_SWEEP_UNTRACKED_NAMES_LIMIT) break;
        untracked.push(clip(`${path.basename(tree.root)}/${file}`));
      }
    }
    if (unpushedTotal > 0) {
      return {
        kind: 'keep',
        reason: 'unpushed-commits',
        count: unpushedTotal,
        detail: `未 push のコミット ${String(unpushedTotal)} 件（${unpushedAt ?? ''}）`,
      };
    }
    if (trackedTotal > 0) {
      return {
        kind: 'keep',
        reason: 'tracked-changes',
        count: trackedTotal,
        detail: `追跡済みの未コミットの変更 ${String(trackedTotal)} 行（${trackedAt ?? ''}）`,
      };
    }
    if (stashAt !== undefined) {
      return {
        kind: 'keep',
        reason: 'stash',
        detail: `git stash の変更が在る（${stashAt}）`,
      };
    }
    // 未追跡が1つでもあれば残す: `.gitignore` 除外後に残るのは書きかけの成果である見込みが高いため
    if (untrackedCount > 0) {
      return {
        kind: 'keep',
        reason: 'untracked-files',
        count: untrackedCount,
        untracked: { count: untrackedCount, names: untracked },
        detail: `未追跡のファイル ${String(untrackedCount)} 件`,
      };
    }
    if (unknownAt !== undefined) {
      return { kind: 'keep', reason: 'undecidable', detail: clip(unknownAt) };
    }
    return { kind: 'remove', untracked, untrackedCount };
  }

  async sweep(signal: AbortSignal, runnerId: string): Promise<ScratchSweepEvent | null> {
    const now = this.#now();
    const removed: ScratchSweepItem[] = [];
    const kept: ScratchSweepItem[] = [];
    let scanError: string | undefined;

    try {
      let entries: readonly ScratchDirEntry[];
      try {
        entries = await (this.#o.readdirFn ?? ((d) => readdir(d, { withFileTypes: true })))(
          this.#o.tmpRoot,
        );
      } catch (error) {
        scanError = `${this.#o.tmpRoot} を読めなかった: ${reasonOf(error)}`;
        entries = [];
      }
      const candidates = entries.filter((e) => isManagerScratchDirName(e.name));
      const names = new Set(candidates.map((c) => c.name));
      for (const name of [...this.#unclaimedSince.keys()]) {
        if (!names.has(name)) this.#unclaimedSince.delete(name);
      }
      for (const c of candidates) {
        if (this.#liveClaimedBy(c.name) !== undefined) this.#unclaimedSince.delete(c.name);
        else if (!this.#unclaimedSince.has(c.name)) {
          this.#unclaimedSince.set(c.name, this.#firstScanDone ? now : this.#o.startedAt);
        }
      }
      this.#firstScanDone = true;

      const expired = candidates.filter((c) => {
        const since = this.#unclaimedSince.get(c.name);
        return since !== undefined && now - since >= this.#o.graceMs;
      });
      const wholeCandidates = expired.filter((c) => this.#claimedBy(c.name) === undefined);

      const itemOf = (c: ScratchDirEntry): ScratchSweepItem => {
        const managerId = this.#knownIdFor(c.name);
        return {
          name: c.name,
          kind: c.isSymbolicLink() ? 'symlink' : c.isDirectory() ? 'directory' : 'file',
          ...(managerId === undefined ? {} : { managerId }),
        };
      };

      const planned = new Map<
        string,
        { entry: ScratchDirEntry; untracked?: Verdict & { kind: 'remove' } }
      >();
      const dirInspections = new Map<string, DirInspection>();
      const dirPath = (c: ScratchDirEntry): string => path.join(this.#o.tmpRoot, c.name);

      const keepItem = (c: ScratchDirEntry, verdict: Verdict & { kind: 'keep' }): void => {
        kept.push({
          ...itemOf(c),
          reason: verdict.reason,
          ...(verdict.count === undefined ? {} : { count: verdict.count }),
          ...(verdict.untracked === undefined ? {} : { untracked: verdict.untracked }),
          ...(verdict.files === undefined ? {} : { files: verdict.files }),
          detail: verdict.detail,
        });
      };

      for (const c of wholeCandidates) {
        if (signal.aborted) break;
        if (c.isSymbolicLink()) {
          planned.set(c.name, { entry: c });
          continue;
        }
        if (!c.isDirectory()) {
          const size = await this.#sizeOf(dirPath(c));
          if (typeof size !== 'number') {
            keepItem(c, { kind: 'keep', reason: 'undecidable', detail: clip(size.why) });
          } else if (size > 0) {
            keepItem(c, {
              kind: 'keep',
              reason: 'non-git-content',
              count: 1,
              files: { count: 1, names: [clip(c.name)] },
              detail: `中身のあるファイル（${String(size)} バイト）`,
            });
          } else planned.set(c.name, { entry: c });
          continue;
        }
        const insp = await this.#inspectDir(dirPath(c), signal);
        dirInspections.set(c.name, insp);
        if (insp.trees.length === 0 && insp.searchUnknown === undefined) {
          const content = await this.#scanContent(dirPath(c));
          if (content.unknown !== undefined) {
            keepItem(c, { kind: 'keep', reason: 'undecidable', detail: clip(content.unknown) });
            continue;
          }
          if (content.count > 0) {
            keepItem(c, {
              kind: 'keep',
              reason: 'non-git-content',
              count: content.count,
              files: { count: content.count, names: content.names },
              detail: `git の無いディレクトリに通常ファイル ${String(content.count)} 件`,
            });
            continue;
          }
          planned.set(c.name, {
            entry: c,
            untracked: { kind: 'remove', untracked: [], untrackedCount: 0 },
          });
          continue;
        }
        const verdict = this.#verdictOf(insp);
        if (verdict.kind === 'keep') keepItem(c, verdict);
        else planned.set(c.name, { entry: c, untracked: verdict });
      }

      const exists = this.#o.existsFn ?? defaultExists;
      const dependency = new Map<string, string>();
      let changed = true;
      while (changed && !signal.aborted) {
        changed = false;
        const plannedDirs = [...planned.values()]
          .filter((p) => p.entry.isDirectory() && !p.entry.isSymbolicLink())
          .map((p) => dirPath(p.entry));
        for (const [name, p] of [...planned.entries()]) {
          const insp = dirInspections.get(name);
          if (insp === undefined) continue;
          let outside: string | undefined;
          for (const tree of insp.trees) {
            // linked worktree 側は見ない: 主の object を借りているだけで、消しても主は壊れないため
            if (tree.worktreePaths === 'unknown' || !tree.isMain) continue;
            for (const wtPath of tree.worktreePaths) {
              if (plannedDirs.some((d) => isWithin(wtPath, d))) continue;
              if (await exists(wtPath)) {
                outside = wtPath;
                break;
              }
            }
            if (outside !== undefined) break;
          }
          if (outside !== undefined) {
            planned.delete(name);
            dependency.set(name, outside);
            kept.push({
              ...itemOf(p.entry),
              reason: 'worktree-dependency',
              detail: clip(`残す作業ツリー ${outside} がこのリポジトリのコミットに依存している`),
            });
            changed = true;
            break;
          }
        }
      }

      for (const [name, p] of planned) {
        if (signal.aborted) break;
        if (this.#claimedBy(name) !== undefined) {
          this.#unclaimedSince.delete(name);
          continue;
        }
        const target = dirPath(p.entry);
        const unsafe = this.#unsafeTargetReason(target);
        if (unsafe !== undefined) {
          kept.push({ ...itemOf(p.entry), reason: 'unsafe-target', detail: clip(unsafe) });
          continue;
        }
        try {
          await (this.#o.rmFn ?? ((t) => rm(t, { recursive: true, force: true })))(target);
        } catch (error) {
          kept.push({ ...itemOf(p.entry), reason: 'rm-failed', detail: clip(reasonOf(error)) });
          continue;
        }
        this.#unclaimedSince.delete(name);
        const item = itemOf(p.entry);
        removed.push(
          p.untracked !== undefined && p.untracked.untrackedCount > 0
            ? {
                ...item,
                untracked: { count: p.untracked.untrackedCount, names: p.untracked.untracked },
              }
            : item,
        );
      }
      const removedNames = new Set(removed.map((i) => i.name));
      for (const c of expired) {
        if (signal.aborted) break;
        if (removedNames.has(c.name) || c.isSymbolicLink() || !c.isDirectory()) continue;
        const insp = dirInspections.get(c.name) ?? (await this.#inspectDir(dirPath(c), signal));
        const item = await this.#sweepNodeModules(c.name, dirPath(c), insp, signal, kept);
        if (item !== undefined)
          removed.push({
            ...item,
            ...(this.#knownIdFor(c.name) === undefined
              ? {}
              : { managerId: this.#knownIdFor(c.name) }),
          });
      }
    } catch (error) {
      scanError = `片付けが想定外に失敗した: ${reasonOf(error)}`;
    }

    const keptKey = (i: ScratchSweepItem): string => `${i.name}\u0000${i.reason ?? ''}`;
    const currentKeys = new Set(kept.map(keptKey));
    if (scanError !== undefined) currentKeys.add(`__scan__\u0000${scanError}`);
    const scanErrorIsNew =
      scanError !== undefined && !this.#notifiedKept.has(`__scan__\u0000${scanError}`);
    const newKept = kept.filter((i) => !this.#notifiedKept.has(keptKey(i)));
    // 判定を回せなかった回は前回の記憶を消さない: 消すと次の回で再送になるため
    this.#notifiedKept = signal.aborted
      ? new Set([...this.#notifiedKept, ...currentKeys])
      : currentKeys;

    if (removed.length === 0 && newKept.length === 0 && !scanErrorIsNew) return null;
    return {
      type: 'scratch_sweep',
      runnerId,
      removed,
      kept: newKept,
      ...(scanErrorIsNew ? { scanError } : {}),
      statfs: await this.#statfs(),
    };
  }

  async #sizeOf(p: string): Promise<number | { why: string }> {
    try {
      return await (this.#o.sizeFn ?? (async (x) => (await lstat(x)).size))(p);
    } catch (error) {
      return { why: `大きさを読めなかった: ${reasonOf(error)}` };
    }
  }

  #listDir(): ReaddirFn {
    return this.#o.gitReaddirFn ?? ((dir) => readdir(dir, { withFileTypes: true }));
  }

  async #scanContent(dir: string): Promise<{ count: number; names: string[]; unknown?: string }> {
    const maxDepth = this.#o.maxDepth ?? SCRATCH_SWEEP_MAX_DEPTH;
    const listDir = this.#listDir();
    const names: string[] = [];
    let count = 0;
    let unknown: string | undefined;
    const walk = async (d: string, depth: number): Promise<void> => {
      if (count >= SCRATCH_SWEEP_CONTENT_SCAN_LIMIT) return;
      let entries;
      try {
        entries = await listDir(d);
      } catch (error) {
        unknown ??= `${d} を読めなかった: ${reasonOf(error)}`;
        return;
      }
      for (const e of entries) {
        if (e.name === 'node_modules') continue;
        const isLink = (e as { isSymbolicLink?: () => boolean }).isSymbolicLink?.() === true;
        if (isLink) continue;
        if (e.isDirectory()) {
          if (depth >= maxDepth) {
            unknown ??= `深さ上限より下に降りなかった（${path.join(d, e.name)}）`;
            continue;
          }
          await walk(path.join(d, e.name), depth + 1);
        } else {
          count += 1;
          if (names.length < SCRATCH_SWEEP_UNTRACKED_NAMES_LIMIT) {
            names.push(clip(path.relative(dir, path.join(d, e.name))));
          }
        }
      }
    };
    await walk(dir, 0);
    return { count, names, ...(unknown === undefined ? {} : { unknown }) };
  }

  async #findNodeModules(dir: string): Promise<string[]> {
    const maxDepth = this.#o.maxDepth ?? SCRATCH_SWEEP_MAX_DEPTH;
    const listDir = this.#listDir();
    const found: string[] = [];
    const walk = async (d: string, depth: number): Promise<void> => {
      if (found.length >= SCRATCH_SWEEP_NODE_MODULES_LIMIT) return;
      let entries;
      try {
        entries = await listDir(d);
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === '.git') continue;
        const child = path.join(d, e.name);
        if (e.name === 'node_modules') {
          found.push(child);
          continue;
        }
        if (depth < maxDepth) await walk(child, depth + 1);
      }
    };
    await walk(dir, 0);
    return found;
  }

  #unsafeNodeModulesReason(target: string): Promise<string | undefined> {
    return unsafeNodeModulesTarget(this.#o.tmpRoot, target, this.#o.realpathFn ?? realpath);
  }

  async #sweepNodeModules(
    name: string,
    dir: string,
    insp: DirInspection,
    signal: AbortSignal,
    kept: ScratchSweepItem[],
  ): Promise<ScratchSweepItem | undefined> {
    if (insp.trees.length === 0) return undefined;
    const candidates = await this.#findNodeModules(dir);
    const paths: string[] = [];
    for (const nm of candidates) {
      if (signal.aborted) break;
      const owner = insp.trees
        .filter((tree) => isWithin(nm, tree.root))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (owner === undefined) continue;
      const rel = path.relative(owner.root, nm);
      const ignored = await this.#git(['check-ignore', '-q', '--', rel], owner.root);
      if (!ignored.ok) continue;
      const tracked = await this.#git(['ls-files', '--', rel], owner.root);
      if (!tracked.ok || tracked.out.trim() !== '') continue;
      if (this.#liveClaimedBy(name) !== undefined)
        return paths.length === 0 ? undefined : this.#nodeModulesItem(name, paths);
      const unsafe = await this.#unsafeNodeModulesReason(nm);
      if (unsafe !== undefined) {
        kept.push({ name, kind: 'directory', reason: 'unsafe-target', detail: clip(unsafe) });
        continue;
      }
      try {
        await (this.#o.rmFn ?? ((p) => rm(p, { recursive: true, force: true })))(nm);
      } catch (error) {
        kept.push({ name, kind: 'directory', reason: 'rm-failed', detail: clip(reasonOf(error)) });
        continue;
      }
      paths.push(clip(path.relative(dir, nm)));
    }
    return paths.length === 0 ? undefined : this.#nodeModulesItem(name, paths);
  }

  #nodeModulesItem(name: string, paths: string[]): ScratchSweepItem {
    return {
      name,
      kind: 'node_modules',
      count: paths.length,
      paths: paths.slice(0, SCRATCH_SWEEP_UNTRACKED_NAMES_LIMIT),
    };
  }

  async #statfs(): Promise<NonNullable<ScratchSweepEvent['statfs']>> {
    try {
      const s = await (this.#o.statfsFn ?? ((p) => statfs(p)))(this.#o.tmpRoot);
      return {
        totalBytes: s.blocks * s.bsize,
        usedBytes: (s.blocks - s.bfree) * s.bsize,
        totalInodes: s.files,
        usedInodes: s.files - s.ffree,
      };
    } catch (error) {
      return { unavailable: reasonOf(error) };
    }
  }
}
