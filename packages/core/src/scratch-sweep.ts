import { lstat, readdir, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

import { reasonOf } from './dropped-record.js';
import type { ScratchSweepEvent, ScratchSweepItem } from './runner-protocol.js';
import {
  findGitDirs,
  isManagerScratchDirName,
  matchesManagerScratchDirName,
  runGit,
  type ProcessSpawnFn,
  type ReaddirFn,
} from './unpushed-work.js';

/**
 * runner が `/tmp` 直下に溜まる委譲の作業場（`mgr-<委譲idの先頭>`・`mgr-<…>-wt2`・
 * `mgr-<…>-p10-verify.log` など）を片付ける（Issue #3039）。
 *
 * **背景。** マネージャーは `/tmp` 直下へ clone・worktree・ログを散らし、runner は
 * 消さない。器の一時領域のファイル数上限（Railway）に当たって runner が落ちた。
 * ボリュームは付けない（オーナー決定）ので、片付ける仕組みを持つ。
 *
 * ## 線（依頼者の決定）
 *
 * 1. **対象**は `tmpRoot` 直下で名前が `/^mgr-([0-9a-f]{4,})/` に当たるエントリだけ
 *    （ディレクトリもファイルも）。直下の名前一覧だけを読み、当たらないものへは降りない。
 * 2. **「終わった」**＝その名前が、この runner の生きたどの委譲 id にも当たらない状態が
 *    猶予（既定2時間）以上続いたこと。「誰にも当たらなくなった最初の時刻」はメモリに
 *    持つ。起動時に既に在ったものは起動時刻から数える。`stopped` から再開されうる
 *    委譲を、閉じた直後に消さないための猶予である。
 * 3. **消す前に守る**（ディレクトリ）。下の作業ツリーを `findGitDirs` と同じ探索で探し、
 *    各ツリーを子 UID の git で調べる。未 push のコミット（全ローカル枝と HEAD）・`git stash`
 *    （`refs/stash`）・追跡済みの未コミットの変更が
 *    あれば残す。未追跡のファイルが1つでもあれば残す（`.gitignore` 除外後に残るのは書きかけの成果である見込みが高い）（名前を記録に残す）。
 *    **判定できない（探索の打ち切り・読めない子ディレクトリ・git の失敗/期限切れ）は
 *    残す**——「判定できない」を「消してよい」へ倒さない。
 *    **作業ツリーの依存**: 各リポジトリの `git worktree list` の全ツリーのうち、存在し、
 *    かつ「今回消すと決まった候補」の外に在るものが1つでもあれば、その主リポジトリを
 *    含む候補は残す（linked worktree のコミットは主の object に在る）。不動点まで繰り返す。
 * 4. **シンボリックリンク**は追わない。リンクそのもの（名前が当たったもの）だけを消す
 *    （`rm` はリンクを辿らない。リンク先は消えない）。リンク先を持つ作業場の判定へも
 *    降りない。リンク自身は `/tmp` の1エントリで、残しても得るものが無く、消して失う
 *    ものも無い（リンク先は別の名前で独立に判定される）ため、対象外にするより消す側が安全で
 *    かつ件数を減らせる。
 * 5. 1回の周期で同時に走るのは1本まで。`signal` で止められる（候補の境目で止まる。
 *    `rm` の最中は止められない）。消す直前にもう一度、生きた委譲と突き合わせる。
 *
 * ## `node_modules` の片付け（#3039 続き）
 *
 * 作業場ごとは消さないと決めたもの（この runner が起こした委譲の畳まれた done・stopped・failed、
 * 未 push・追跡済み・未追跡・stash・判定不能・依存で残すもの）でも、**生きたセッションに当たらない
 * 状態が猶予続いた**作業場の中の `node_modules` だけは片付ける（容量とファイル数の大半）。
 * **生きたセッション（ターンの合間の done を含む `#sessions`）の作業場には触らない。**
 * 消すのは、git 作業ツリーの中の、名前が `node_modules` のディレクトリで、所属ツリーの
 * `git check-ignore -q` が exit 0（無視されている）かつ `git ls-files` が空（追跡済みを含まない）
 * ものだけ。exit 1・失敗・期限切れ・symlink・ツリーの外は消さない。`node_modules` の中へは降りない。
 * 消す直前に、基点・「基点直下の `mgr-…` の下」・名前・realpath の一致（{@link unsafeNodeModulesTarget}）と、
 * 生きたセッションとの突き合わせをやり直す。**再開されたら `pnpm install` のやり直しが要る。**
 *
 * ## 孤児の中身（#3039 続き）
 *
 * この runner が知らない（孤児の）`.git` の無いディレクトリは、通常ファイル（`node_modules` の中は
 * 数えない）が1つでもあれば `non-git-content` で残す。孤児のファイルも 0 バイトでなければ残す。
 * 空のディレクトリ・空のファイル・`node_modules` だけのディレクトリは消してよい。
 *
 * ## 既知の限界
 * - 探索は深さ12まで。それより下に降りなかった枝があれば「判定できない」で残す。
 * - `rm` が途中で止まった（失敗・プロセス終了）作業場は、半分壊れたまま残る。次の回は
 *   git が失敗するので「判定できない」で残る（消し切らない）。
 */

export const SCRATCH_SWEEP_GRACE_MS_ENV_KEY = 'ALTEROID_SCRATCH_SWEEP_GRACE_MS';
export const SCRATCH_SWEEP_INTERVAL_MS_ENV_KEY = 'ALTEROID_SCRATCH_SWEEP_INTERVAL_MS';

/** 猶予の既定（2時間）。 */
export const DEFAULT_SCRATCH_SWEEP_GRACE_MS = 2 * 60 * 60_000;
/** 周期の既定（10分）。 */
export const DEFAULT_SCRATCH_SWEEP_INTERVAL_MS = 10 * 60_000;
/** 範囲。猶予は 0 以上、周期は `setInterval` の仕様の範囲（`resolveRescueIntervalMs` と同じ）。 */
export const MIN_SCRATCH_SWEEP_INTERVAL_MS = 1000;
export const MAX_SCRATCH_SWEEP_MS = 2_147_483_647;

/** 未追跡の名前を記録へ残す件数の上限と、1件の長さの上限。 */
export const SCRATCH_SWEEP_UNTRACKED_NAMES_LIMIT = 20;
export const SCRATCH_SWEEP_NAME_MAX_LENGTH = 200;
/**
 * 作業ツリーを探す深さ。`.git` を見落として「無い」と判定しないよう、実質外す値にし、
 * それでも降りなかった枝があれば「判定できない」で残す。
 */
export const SCRATCH_SWEEP_MAX_DEPTH = 12;
/** `.git` の無いディレクトリの通常ファイルを数える上限（これ以上は数えずに残す）と、1作業場で消す `node_modules` の上限。 */
export const SCRATCH_SWEEP_CONTENT_SCAN_LIMIT = 1000;
export const SCRATCH_SWEEP_NODE_MODULES_LIMIT = 100;
/** 片付けの git 1本の期限（ms）。 */
export const SCRATCH_SWEEP_GIT_TIMEOUT_MS = 15_000;

function resolveMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return fallback;
  const parsed = Number(trimmed);
  // 範囲外（数値でない・負・上限超え）は既定へ倒す（`resolveRescueIntervalMs` は
  // 上限・下限へ挟むが、猶予は短すぎる値で作業場を早く消す向きに効くので挟まず既定へ戻す）。
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** 猶予を環境から読む。範囲外・数値でないものは既定（2時間）へ倒す。 */
export function resolveScratchSweepGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMs(
    env[SCRATCH_SWEEP_GRACE_MS_ENV_KEY],
    DEFAULT_SCRATCH_SWEEP_GRACE_MS,
    0,
    MAX_SCRATCH_SWEEP_MS * 1000,
  );
}

/** 周期を環境から読む。範囲外・数値でないものは既定（10分）へ倒す。 */
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
  /** 片付ける親（本番は `/tmp`）。 */
  tmpRoot: string;
  /** git を起こす口（子 UID。`Host#gitSpawnFn`）。 */
  spawn: ProcessSpawnFn;
  env: Record<string, string | undefined>;
  /** いま生きている委譲 id。**呼ぶたびに最新を返すこと**（消す直前にも引き直す）。 */
  liveManagerIds: () => readonly string[];
  /** この runner が過去に知った委譲 id（項目の `managerId` を付けるため。無くてよい）。 */
  knownManagerIds?: () => readonly string[];
  graceMs: number;
  /** 起動時刻（ms）。最初の走査で既に在ったものは、ここから数える。 */
  startedAt: number;
  now?: () => number;
  gitTimeoutMs?: number;
  // 注入口（テスト用。既定は本物の fs）
  readdirFn?: (dir: string) => Promise<readonly ScratchDirEntry[]>;
  /** `findGitDirs` が使う readdir（既定は本物）。 */
  gitReaddirFn?: ReaddirFn;
  /** 作業ツリーを探す深さ（既定 {@link SCRATCH_SWEEP_MAX_DEPTH}。テスト用の口）。 */
  maxDepth?: number;
  existsFn?: (p: string) => Promise<boolean>;
  /** 通常ファイルの大きさ（既定は `lstat`）。孤児のファイルが空かを見る。 */
  sizeFn?: (p: string) => Promise<number>;
  /** 途中に symlink を挟まない確認に使う（既定は `fs.realpath`）。 */
  realpathFn?: (p: string) => Promise<string>;
  rmFn?: (p: string) => Promise<void>;
  statfsFn?: (p: string) => Promise<ScratchSweepStatfs>;
}

interface TreeInspection {
  /** 作業ツリーのパス（絶対）。 */
  readonly root: string;
  /**
   * 未 push のコミット数。意味は「**全ローカル枝と HEAD（detached でも）のうち、origin に無い
   * コミット**」（`rev-list --count HEAD --branches --not --remotes=origin`）。チェックアウトして
   * いない別の枝の未 push も数える（HEAD だけを見ると作業場ごと消えて失われる）。
   */
  readonly unpushed: number | 'unknown';
  readonly tracked: number | 'unknown';
  readonly untracked: readonly string[] | 'unknown';
  readonly worktreePaths: readonly string[] | 'unknown';
  /** `refs/stash` が在るか（`git stash` の変更）。 */
  readonly stash: boolean | 'unknown';
  /** 主リポジトリ（object を持つ側）か。linked worktree（`.git` がファイル）なら false。判定できなければ true（安全側）。 */
  readonly isMain: boolean;
  readonly unknownDetail?: string;
}

interface DirInspection {
  readonly trees: readonly TreeInspection[];
  /** 探索の打ち切り・読めない子ディレクトリ・ルートが読めない。 */
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
    : `${text.slice(0, SCRATCH_SWEEP_NAME_MAX_LENGTH)}…`;
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

/**
 * `node_modules` を消す直前の最後の関門。基点が空でない絶対パスで `/` でないこと、対象が基点の
 * 直下の `mgr-…` ディレクトリの**下**（そのディレクトリ自身ではない）であること、名前が
 * `node_modules` であること、途中に symlink を挟まない（`realpath` が基点の実体＋相対パスと一致。
 * 基点自身が symlink でも通る）こと。満たさなければ理由を返す（消さない）。
 */
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
  /** エントリ名 → 誰にも当たらなくなった最初の時刻（ms）。 */
  readonly #unclaimedSince = new Map<string, number>();
  /** 直近の回で「残した」と知らせた項目の鍵（名前と理由）。 */
  #notifiedKept = new Set<string>();
  #firstScanDone = false;

  constructor(options: ScratchSweeperOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 守る委譲（名前が当たれば猶予で消さない）＝生きた委譲 ∪ この runner が一度でも起こした委譲。
   * 畳まれた done・stopped・failed も、デーモンが `manager_send` で resume しうるので守る。
   * この runner が知らない名前（孤児・runner の再起動前のもの）は猶予で扱う。
   */
  /** 生きたセッションに当たるか（`node_modules` の片付けが触らない集合）。 */
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

  /**
   * 消す直前の最後の関門（変数が空・未設定でも `/` や上位へ広がらない）。基点が空でない絶対
   * パスで `/` でないこと、対象が基点の**直下**（対象 ≠ 基点）であること、対象の名前が
   * `mgr-` 規則に当たることを毎回確かめる。満たさなければ理由を返す（消さない）。
   */
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

  /** `refs/stash` が在るか。`rev-parse --verify --quiet` は無ければ exit 1（それ以外・期限切れは判定できない）。 */
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

  /** 1つの候補ディレクトリの、中身だけで決まる判定（依存は別途）。 */
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
    // 理由の優先は「失われるものが確かに在る」→「判定できない」。
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
    // 未追跡（`.gitignore` 除外後）が残るのは書きかけの成果である見込みが高いので、残す。
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

  /**
   * 1回走らせる。**何も消さず、新しく残したものも無ければ `null`**（送らない）。
   * 投げない。
   */
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

      // 生きたセッションに当たらない状態が猶予続いたもの。`node_modules` の片付けはこの全部が対象。
      // 作業場ごと消すのは、さらに「この runner が一度も起こしていない（孤児）」ものだけ。
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

      // 消すと決まったもの（名前 → 項目＋任意の未追跡）。ディレクトリは判定を経る。
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
          // 孤児のファイル（ログ等）。空（0バイト）でなければ残す。
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
          // `.git` を持たないディレクトリ。通常ファイル（`node_modules` の中は数えない）が1つでも
          // あれば残す。空のディレクトリ・`node_modules` だけのディレクトリは消してよい。
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

      // 作業ツリーの依存（不動点）。
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
            // linked worktree 側は主の object を借りているだけ（消しても主は壊れない）。
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

      // 消す。直前にもう一度、生きた委譲と突き合わせる。
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
      // 作業場ごとは消さなかった（残した・知っている委譲の）作業場でも、猶予後は git が無視する
      // `node_modules` だけを片付ける（生きたセッションの作業場は expired に入らない）。
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

    // 「残した」は、前回までに知らせていない鍵だけ載せる。
    const keptKey = (i: ScratchSweepItem): string => `${i.name}\u0000${i.reason ?? ''}`;
    const currentKeys = new Set(kept.map(keptKey));
    if (scanError !== undefined) currentKeys.add(`__scan__\u0000${scanError}`);
    const scanErrorIsNew =
      scanError !== undefined && !this.#notifiedKept.has(`__scan__\u0000${scanError}`);
    const newKept = kept.filter((i) => !this.#notifiedKept.has(keptKey(i)));
    // 判定を回せなかった（中断・読めなかった）回は、前回の記憶を保つ（消すと次の回で再送になる）。
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

  /** `.git` を持たないディレクトリの通常ファイルを数える（`node_modules` の中は数えない）。 */
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

  /** 作業場の中の、名前が `node_modules` のディレクトリを探す（中へは降りない・symlink は辿らない）。 */
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
        return; // 読めない所は触らない（消さないだけ）。
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue; // symlink は isDirectory が偽（辿らない）
        if (e.name === '.git') continue;
        const child = path.join(d, e.name);
        if (e.name === 'node_modules') {
          found.push(child);
          continue; // 中へは降りない
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

  /**
   * 1つの作業場の `node_modules` を片付ける。消すのは、所属する作業ツリーで
   * `git check-ignore -q` が exit 0（無視されている）かつ `git ls-files` が空（追跡済みを含まない）の
   * ものだけ。それ以外（exit 1・失敗・期限切れ）は消さない。消したものがあれば項目を返す。
   */
  async #sweepNodeModules(
    name: string,
    dir: string,
    insp: DirInspection,
    signal: AbortSignal,
    kept: ScratchSweepItem[],
  ): Promise<ScratchSweepItem | undefined> {
    if (insp.trees.length === 0) return undefined; // git 作業ツリーの外は消さない
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
      // 消す直前にもう一度、生きたセッションと突き合わせる。
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
