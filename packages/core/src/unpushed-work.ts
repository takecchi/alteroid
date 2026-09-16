import type { ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { UnpushedWorkResult, UnpushedWorkTree } from './runner-protocol.js';

/**
 * `manager_stop` が「running を畳むと何が失われるか」を一般論ではなく実物の
 * 数字で言うための下請け（Issue #1039）。
 *
 * ## 決まっている3点（依頼者が決めた。ここで動かさない）
 *
 * 1. **作業ツリーの特定方式** — `job.cwd` の下を深さ上限3で `.git` を探す。
 *    見つかった分は**全部**返す（1本目だけを返すと、マネージャーが作業者へ
 *    別ツリーを切る運用——AGENTS.md が許容している——の2本目以降を静かに
 *    落とす）。`node_modules` は探索しない。件数に上限を置き、打ち切ったら
 *    打ち切ったと名乗る（黙って切らない。AGENTS.md「取れない軸に0の行を作る」）。
 * 2. **「未 push」の定義** — `git rev-list --count HEAD --not --remotes=origin`。
 *    `@{u}` は使わない——upstream 未設定の枝（一度も push されていない枝）を
 *    見落とす（実測: 8本中2本が該当）。**⚠️ この式は fetch していない
 *    remote-tracking ref を基準にするので、実際には push 済みのコミットを
 *    「未 push」と多めに数えることがある。これは安全側（失われるものを多めに
 *    言う）の誤りであって、その逆（実際に未 push なのに 0 と出る）は起きない。**
 *    `fetch` も `git ls-remote` もしない——ネットワークを一切使わない。
 * 3. **出す粒度** — 作業ツリーのパス（相対）・枝名・未 push コミット数・
 *    未コミットの変更の件数まで。**⛔ ファイル名・差分の中身・コミット
 *    メッセージ・author は一切出さない。**
 *
 * ## テスト可能にするための切り出しである
 *
 * `git` の起動そのものは呼び出し側（`packages/core/src/runner.ts` の
 * `RunnerSession`）が別 UID（`#spawnAsChildUser`）で行うので、ここは
 * その起動関数を注入で受け取るだけの純粋なロジックにしてある——出力・挙動は
 * 1文字も変えず、実際の子プロセス起動から判定ロジックを剥がしただけである
 * （AGENTS.md「テストが書けない構造は、テストが無いのと同じ」）。
 *
 * ## この探索自身が Issue #1067 の形を持っていた
 *
 * この探索は `job.cwd` の下に見つかった**全ツリー**——多くは他人（走行中の
 * 作業者）が使っている作業ツリー——の中で `git` を撃つ。**このファイルが
 * 撃つ3コマンドのうち、素の `git status --porcelain` だけが `.git/index` を
 * 書く**（実測: git 2.47.3、`.git/index` の mtime を 2020-01-01 へ落として
 * から1コマンド打ち、mtime が動くかを見た。`git status --porcelain` は
 * 動く＝書く。`git --no-optional-locks status --porcelain` では 2020-01-01
 * のまま動かない＝書かない。`git rev-list --count HEAD --not --remotes=origin`
 * と `git rev-parse --abbrev-ref HEAD`（このファイルが撃つ残り2本）は
 * どちらも動かない＝元から書いていない。`git diff HEAD` /
 * `git ls-files --others --exclude-standard` / `git log --oneline -1` も
 * 動かない＝書かない——後述の「退避」の設計判断はここに乗っている）。
 * **また `git status --porcelain` は差分の有無に関係なく毎回書く**（実測:
 * `commit` 直後の何も変更が無いツリーで mtime を落として3回連続で打ち、
 * 3回とも現在時刻になった。「差分が在るときだけ」ではなく無条件である）。
 * ⟹ **未 push を数えるこの機構自身が、「マネージャーと作業者が同じ作業ツリーを
 * 共有する」という Issue #1067 の形をそのまま持っていた**——持ち主でない層が
 * 他人の生きたツリーの `.git/index` を書いていた。
 *
 * だから `runGit` は全コマンドの env に `GIT_OPTIONAL_LOCKS: '0'` を渡す。
 * **効くのはこの3本のうち1本（`git status --porcelain`）だけだが、引数
 * ではなく env に一括で置く**（`--no-optional-locks` という引数ではなく env
 * にしたのは、この先ここへ git コマンドが1本足されたときに引数方式だと
 * 静かに漏れるため——env は `runGit` を通る全コマンドに効くので、次に足す
 * コマンドが index を書く種類であっても塞げる。git のドキュメントは
 * `GIT_OPTIONAL_LOCKS=0` と `--no-optional-locks` を等価だと明記している）。
 *
 * ⛔ **測っていないこと**: この書き込みが実際に作業者の git 操作を落とした
 * 観測は無い。塞いだのは「書く」ことであって「落ちた」ことではない
 * ——`index.lock` が既に在る状態で素の `git status` を打っても exit 0 で
 * 返る（実測）ので、**衝突は失敗として現れるとは限らない**。**`git push` が
 * index を動かさないことも未測定である**（リモートが要るので使い捨て
 * リポジトリでは確かめていない）。
 *
 * ⚠️ **`GIT_OPTIONAL_LOCKS=0` が塞ぐのは index への書き込みだけである。**
 * HEAD・作業ツリーの中身を動かす git（`checkout` / `commit` / `reset` 等）は
 * この探索からは1つも撃っていないので、そもそも対象外である。
 */

/** `spawnAsUser` / 素の `spawn` のどちらも満たせる、最小の起動口。 */
export type ProcessSpawnFn = (options: {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}) => ChildProcess;

/** `.git` の探索の既定値。 */
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_WORKTREES = 20;
/**
 * git 1コマンドあたりのタイムアウトの既定値。
 *
 * **⚠️ 実測に基づく値ではない。** Issue #1039 が測った「1本 6ms 強 / 8本
 * 49〜51ms」は器の中のローカルな `git` の実行時間だけで、別 UID への子プロセス
 * 起動の費用は含んでいない。ここは安全側に長めに取った未検証の既定値である。
 */
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 3_000;

export interface FindGitDirsResult {
  /** 見つかった `.git` を持つディレクトリの絶対パス（.git 自身ではなく親）。 */
  readonly paths: readonly string[];
  /**
   * 件数の上限に当たって打ち切ったときだけ載る（省略 = 打ち切っていない）。
   * **黙って切らない**——値は上限そのもの（何件で打ち切ったか）。
   */
  readonly truncatedAtCount?: number;
}

/**
 * `root` の下を深さ `maxDepth` まで探索し、`.git` を持つディレクトリを**全部**
 * 返す。`root` 自身が `.git` を持つ場合も拾う。
 *
 * - `node_modules` という名のディレクトリはその中へ潜らない。
 * - `.git` を見つけたら、その中へは潜らない（`.git` の中身は探索対象ではない）。
 * - 読めないディレクトリ（権限・競合で消えた等）は黙って諦める——「読めなかった」
 *   ことをこの関数の戻り値の形では表現しない（見つかった分だけを正としてよい。
 *   全体が「確かめられなかった」に落ちる話ではない）。
 */
export async function findGitDirs(
  root: string,
  options: { maxDepth?: number; maxCount?: number } = {},
): Promise<FindGitDirsResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCount = options.maxCount ?? DEFAULT_MAX_WORKTREES;
  const found: string[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === 'node_modules') continue;
      if (entry.name === '.git') {
        found.push(dir);
        if (found.length >= maxCount) {
          truncated = true;
          return;
        }
        continue;
      }
      if (entry.isDirectory()) subdirs.push(entry.name);
    }
    if (depth >= maxDepth) return;
    for (const name of subdirs) {
      if (truncated) return;
      await walk(path.join(dir, name), depth + 1);
    }
  }

  await walk(root, 0);
  return truncated ? { paths: found, truncatedAtCount: maxCount } : { paths: found };
}

interface GitRunResult {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** `git` を1回、期限つきで起こして出力を集める。例外は投げない。 */
async function runGit(
  spawnFn: ProcessSpawnFn,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<GitRunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const child = spawnFn({
      command: 'git',
      args,
      cwd,
      // **ネットワークを一切使わないコマンドしかここからは呼ばない**が、
      // 万一のプロンプト待ちで固まらないよう念のため塞ぐ。
      // `GIT_OPTIONAL_LOCKS: '0'` は Issue #1067 対応——このファイル冒頭の
      // doc「この探索自身が Issue #1067 の形を持っていた」を見よ。
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      signal: controller.signal,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', () => {
      // stderr は読み捨てる。理由(exit code)は返すが、本文（git のエラー文言に
      // ファイルパスやコミットメッセージの断片が混ざりうる）は外へ出さない。
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    return { stdout, exitCode, timedOut: false };
  } catch {
    return { stdout: '', exitCode: null, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⛔ 出してよいのは有無・件数・枝名までである。ファイル名・差分の中身・
 * コミットメッセージ・author は一切含めない（Issue #1039。
 * `apps/runner/src/tasks.ts` が生きているプロセスの素性について引いている線
 * ——`cmdline` / `cwd` / `environ` を読まない——と同じ強さの線をここに引く）。
 *
 * **型そのものは `runner-protocol.ts` の `unpushedWorkTreeSchema` /
 * `unpushedWorkResultSchema` から輸入する**（ここで再定義しない）——
 * デーモン・runner の境界を跨ぐ値の形は、その境界を持つファイルが1か所で
 * 決める（AGENTS.md「リポジトリの約束」の数え上げの持ち主を1か所にする、と
 * 同じ理由）。ここは輸入した形に沿って値を作るだけである。
 */
async function probeBranch(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string | null> {
  const result = await runGit(
    spawnFn,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoRoot,
    env,
    timeoutMs,
  );
  if (result.timedOut || result.exitCode !== 0) return null;
  const branch = result.stdout.trim();
  // `HEAD` はそのものが detached HEAD の印（`git rev-parse --abbrev-ref HEAD`
  // が枝を指していないときに返す文字列）。枝名としては出さない。
  return branch.length === 0 || branch === 'HEAD' ? null : branch;
}

async function probeUnpushedCommitCount(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Pick<UnpushedWorkTree, 'unpushedCommitCount' | 'unpushedCommitCountUnknown'>> {
  const result = await runGit(
    spawnFn,
    ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
    repoRoot,
    env,
    timeoutMs,
  );
  if (result.timedOut) {
    return { unpushedCommitCountUnknown: `確かめられなかった（タイムアウト ${timeoutMs}ms）` };
  }
  if (result.exitCode !== 0) {
    return {
      unpushedCommitCountUnknown:
        `確かめられなかった（git rev-list が exit ${String(result.exitCode)}——` +
        'HEAD が無効（コミットが一度も無い）である可能性が高い）',
    };
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return {
      unpushedCommitCountUnknown: '確かめられなかった（git の出力を数値として読めなかった）',
    };
  }
  return { unpushedCommitCount: parsed };
}

async function probeUncommittedChangeCount(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Pick<UnpushedWorkTree, 'uncommittedChangeCount' | 'uncommittedChangeCountUnknown'>> {
  const result = await runGit(spawnFn, ['status', '--porcelain'], repoRoot, env, timeoutMs);
  if (result.timedOut) {
    return { uncommittedChangeCountUnknown: `確かめられなかった（タイムアウト ${timeoutMs}ms）` };
  }
  if (result.exitCode !== 0) {
    return {
      uncommittedChangeCountUnknown: `確かめられなかった（git status が exit ${String(result.exitCode)}）`,
    };
  }
  const count = result.stdout.split('\n').filter((line) => line.length > 0).length;
  return { uncommittedChangeCount: count };
}

export interface ComputeUnpushedWorkOptions {
  /** git を起こす口（別 UID を通すかどうかは呼び出し側が決める）。 */
  spawn: ProcessSpawnFn;
  env: Record<string, string | undefined>;
  maxDepth?: number;
  maxWorktrees?: number;
  /** 1 git コマンドあたりのタイムアウト（既定 {@link DEFAULT_GIT_COMMAND_TIMEOUT_MS}）。 */
  gitCommandTimeoutMs?: number;
  /**
   * 呼び出し元（デーモン）がもう待っていないことを伝える期限。
   *
   * **中断しても、走っている git コマンドは止めない**（`apps/daemon/src/
   * runner-client.ts` の `#call` と同じ「相手は止めない」作法。期限は待つのを
   * やめるためだけにある）。ここで見るのは**次の作業ツリーへ進む前**だけ——
   * 既に始めた1本の3コマンドを取りやめにはしない。
   *
   * 中断が見つかった時点で、**残りの作業ツリーも一覧からは落とさない**
   * （見つかった `.git` を全部返す、という約束を打ち切りでも破らない）。
   * その代わり、まだ調べていない旨を理由付きで載せる（`stoppedEarly` も
   * `true` になる）。
   */
  signal?: AbortSignal;
}

/**
 * `cwd` の下を探索し、見つかった作業ツリーそれぞれについて未 push の実装と
 * 未コミットの変更を数える。**この関数自体は例外を投げない**——個々の git
 * 呼び出しが失敗しても、その1本だけが「確かめられなかった」を名乗り、他の
 * 作業ツリーの結果には影響しない。
 */
export async function computeUnpushedWork(
  cwd: string,
  options: ComputeUnpushedWorkOptions,
): Promise<UnpushedWorkResult> {
  const found = await findGitDirs(cwd, {
    maxDepth: options.maxDepth,
    maxCount: options.maxWorktrees,
  });
  const timeoutMs = options.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const worktrees: UnpushedWorkTree[] = [];
  let stoppedEarly = false;
  for (const repoRoot of found.paths) {
    const relativePath = path.relative(cwd, repoRoot);
    const relative = relativePath.length === 0 ? '.' : relativePath;
    if (options.signal?.aborted === true) {
      stoppedEarly = true;
      const reason =
        '確かめられなかった（呼び出し元の期限切れで、この作業ツリーへ進む前に打ち切った）';
      worktrees.push({
        relativePath: relative,
        branch: null,
        unpushedCommitCountUnknown: reason,
        uncommittedChangeCountUnknown: reason,
      });
      continue;
    }
    const [branch, unpushed, uncommitted] = await Promise.all([
      probeBranch(options.spawn, repoRoot, options.env, timeoutMs),
      probeUnpushedCommitCount(options.spawn, repoRoot, options.env, timeoutMs),
      probeUncommittedChangeCount(options.spawn, repoRoot, options.env, timeoutMs),
    ]);
    worktrees.push({ relativePath: relative, branch, ...unpushed, ...uncommitted });
  }
  return {
    cwd,
    worktrees,
    ...(found.truncatedAtCount === undefined ? {} : { truncatedAtCount: found.truncatedAtCount }),
    ...(stoppedEarly ? { stoppedEarly: true } : {}),
  };
}
