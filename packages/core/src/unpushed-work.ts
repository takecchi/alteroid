import type { ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { reasonOf } from './dropped-record.js';
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
 *    **⚠️ 2026-09-24、クローンの決定で、探索の起点に『その委譲の id で
 *    名前が付いた `/tmp` 直下のディレクトリ』を足した（オーナー
 *    〔takecchi〕の決定ではない。詳細は下の「3.6.」）。** 理由は実測の
 *    数字である——2026-09-24T21Z ごろの観測で、委譲の作業場は
 *    `/tmp/mgr-c654`（委譲 `mgr-c654e049-…`。clone `repo` 1本）と
 *    `/tmp/mgr-e195ae40`（委譲 `mgr-e195ae40…`。clone `mnemora` 1本＋その
 *    worktree `wt-340`・`wt-498` の2本、全部 `/tmp/mgr-e195ae40` の中）の
 *    2つが在ったが、`/workspace` の下の `.git` は0本、`/tmp` のうち
 *    `mgr-*` 以外（`/tmp` 直下153ディレクトリ中）の `.git` も0本——
 *    ⟹ `job.cwd`（本番は `/workspace`）だけを探す従来の起点では、どの
 *    作業ツリーも見えていなかった。同日19:30Zに枠で落ちた4本の委譲は、
 *    どれも「見つかった作業ツリー0本」と観測されたが、実際には
 *    `/tmp/mgr-<id>/…` に作業ツリーが在り、未コミットの変更も残っていた。
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
 *    **例外が1つある（オーナー決定 2026-10-05、Issue #1266）: 未追跡の
 *    パスは、退避されなかったものとして名前だけを出す**（`rescue-ref.ts`
 *    が `Job.lastRescue.worktrees[].untracked` へ。件数と、上限つきのパスの
 *    名前。中身は出さない。この `computeUnpushedWork` の戻り値の形は変えて
 *    いない——名前を出すのは退避 ref の台帳だけである）。
 *
 * ## 3.5. Issue #1376 B2 で、上の境界に1点だけ穴を開けた
 *
 * workspace locator が `unknown` の委譲が別の runner へ移送されたとき、
 * 枝名だけでは移送先が「どの repo を clone し直せばよいか」を言えなかった
 * （移送先は元のマネージャーとは別の repo で動いているかもしれない）。
 * だから、**origin remote の URL から host と path だけ**を追加で取る
 * （`git remote get-url origin`。ネットワークは使わない——読むだけで
 * `fetch` も `ls-remote` もしない）。**広げたのはこの1点だけである。**
 *
 * 落とすもの（⛔ 一切出さない）:
 * - userinfo（`https://<token>@host/…`・`https://user:pass@host/…`・
 *   `ssh://git@host/…`・scp 形式 `git@host:owner/repo.git` のどれも、
 *   `@` より前は一切含めない）
 * - クエリ文字列（`?token=…` 等）・フラグメント
 * - 資格情報そのもの、および生の URL 文字列
 *
 * 解釈できない・上記を確実に落とせない形は、値ごと省く（`undefined`）
 * ——**生の文字列を出すくらいなら、何も出さない**（`parseRemoteOriginUrl`）。
 *
 * ## 3.6. Issue #1376 / #1266 の続きで、探索の起点を1つ足した
 *
 * **⚠️ これはクローンの決定であって、オーナー（takecchi）の決定ではない。**
 * 上の点1に書いた実測（2026-09-24T21Z 観測）を受け、担い手（マネージャー）が
 * `job.cwd`（本番は `/workspace`）を避けて `/tmp/mgr-<自分の委譲 id の先頭>`
 * へ clone や worktree を作る運用——依頼文がそう指示している——が実在する
 * 一方、この探索は `job.cwd` の下しか見ていなかったため、その種の作業ツリーが
 * 一つも観測に載っていなかった。
 *
 * **足したのは `job.cwd` に加えて、その観測を要求した委譲自身の id
 * （{@link ComputeUnpushedWorkOptions.managerId}）で名前が付いた `/tmp`
 * 直下のディレクトリである**（{@link findManagerScratchRoots}）。当てはめる
 * 規則は `/^mgr-([0-9a-f]{4,})/`——`/tmp` 直下のディレクトリ名がこれに
 * マッチし、マッチした `mgr-<16進>` が委譲の id の先頭と一致するものだけを
 * 起点に足す（{@link matchesManagerScratchDirName}）。例: 委譲
 * `mgr-c654e049-…` に対しては `mgr-c654` と `mgr-c654e049` と
 * `mgr-c654-scratch` は当たるが、`mgr-e195ae40` と `mgr-c65`（16進が4文字
 * 未満）は当たらない。
 *
 * **`/tmp` について行うのは、直下の名前の一覧を読むことだけである。**
 * 当たらなかったディレクトリの中へは降りない（stat もしない）。当たった
 * ディレクトリの下は、既存の {@link findGitDirs} と同じ深さ上限・件数上限・
 * `node_modules` 除外で探す——**他の委譲の場所や `/tmp` 全体を再帰的に
 * 探すことはしない。**
 *
 * `managerId` を渡さなかった呼び出し（省略時）は、この起点を一切足さない
 * ——`job.cwd` の下だけを探す、この変更より前の挙動と1バイトも変わらない。
 *
 * **重複の除去**: `job.cwd` 自体が `/tmp/mgr-…` の中に在る場合など、
 * `job.cwd` の下の探索と `/tmp` 直下の起点の探索が同じ作業ツリーを二重に
 * 見つけることがある。{@link computeUnpushedWork} は見つかったパスを
 * `path.resolve` で正規化してから重複を除く——同じツリーを2回は数えない。
 * 件数の上限（打ち切ったら名乗る、という点1の約束）は、この重複除去の後、
 * 起点を合わせた全体に対して効く。
 *
 * **出力パスの形が変わる**: `relativePath`（{@link UnpushedWorkTree}）は
 * 元々 `job.cwd` からの相対パスだったが、`/tmp` 直下の起点経由で見つかった
 * ツリーは `job.cwd` の外に在りうる。`job.cwd` の外に在るツリーは
 * `path.relative` が `..` で始まる値を返す——そのまま出すと読みにくい
 * （`../tmp/mgr-abcd/repo` 等）ので、**`job.cwd` の外で見つかったツリーは
 * `relativePath` に絶対パスを入れる**（{@link describeWorktreePath}）。
 * **スキーマ（`relativePath: z.string()`）そのものは変えていない**——
 * 文字列という形は保ったまま、中身が相対か絶対かで場合分けするだけである。
 * `job.cwd` の下で見つかったツリー（従来どおりの経路）の出力は1文字も
 * 変えていない。
 *
 * ⛔ **確かめていないこと**: 本番の `/tmp` に本当に `mgr-<id>` の形の
 * ディレクトリが実在し続けるかは、この変更を入れた時点の観測（上の点1）に
 * しか根拠が無い。命名規則が変われば、この起点は何も見つけなくなる
 * （エラーにはならない——`findManagerScratchRoots` は該当ディレクトリが
 * 無ければ空配列を返すだけである）。
 *
 * ## 3.7. Issue #1865 で、起点より下（子ディレクトリ）の読み失敗も数えるようにした
 *
 * Issue #1826 / PR #1838 は探索の**起点そのもの**（`job.cwd`）が読めない
 * ケースを塞いだが、**起点より下の子ディレクトリ**の読み失敗は「黙って
 * 諦める」設計のまま、失敗した事実そのものが戻り値のどこにも残らなかった
 * （{@link findGitDirs} の `walk` の `catch { return; }`）。件数の上限に
 * 当たったときは {@link FindGitDirsResult.truncatedAtCount} で「打ち切った」
 * と名乗るのに、権限・競合で読めなかった場合だけ何も名乗らず「0本」と
 * 区別が付かなかった——`manager-auto-fold.ts` の自動畳み込みの安全弁は
 * `worktrees` が全部 clean（または0本）なら `'clear'` を返すので、
 * 読めなかった子ディレクトリの下に残っていたかもしれない未 push の実装を
 * 検知しないまま自動で畳んでしまう（**許しすぎる側**の穴）。
 *
 * **子ディレクトリの読み失敗を黙って諦める設計そのものは変えていない**——
 * 見つかった分（`paths`）を正として返す約束は保ったまま、失敗した延べ
 * 回数だけを {@link FindGitDirsResult.unreadableDirCount} に数える。0件の
 * ときは省略する（`truncatedAtCount` と同じ「黙って0の行を作らない」
 * 作法）。呼び出し元（`manager-auto-fold.ts` の安全弁・`tools.ts` の
 * `describeUnpushedWork`）は、これを `scratchRootsUnknown` /
 * `truncatedAtCount` / `stoppedEarly` と同じ強さで「確かめられなかった」
 * 側に倒す。
 *
 * ⚠️ **`chmod 000` は非 root では効くが、root で走る CI では効かない**
 * （権限ビットを root は無視できる。同じ注意は既存の `rootUnreadable` の
 * 歯にも書いてある）。root かどうかに関係なく子ディレクトリの読み失敗を
 * 再現するため、`readdir` 自体を差し替えられるようにした
 * （{@link ReaddirFn}、{@link ComputeUnpushedWorkOptions.readdirFn}）。
 * 本番は既定（実物の `readdir`）のままで1バイトも変わらない。
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

/**
 * `node:fs/promises` の `Dirent` が満たせる、`findGitDirs` の `walk` が
 * 実際に使う最小の形（`name` と `isDirectory()` だけ）。
 *
 * **なぜ差し替え可能にするか（Issue #1865）** — 子ディレクトリの `readdir`
 * 失敗を歯で確かめたいが、`chmod 000` は非 root では効いても **root で走る
 * CI では効かない**（root は権限ビットを無視できる。同じ注意は
 * `unpushed-work.test.ts` の「起点（job.cwd）に読み取り権限が無い」の歯にも
 * 書いてある）。root かどうかに関係なく同じ結果を得るため、実際の
 * ディレクトリ権限には触れず、`readdir` の呼び出し自体を差し替えられるように
 * する——本番は既定（実物の `readdir`）のまま1バイトも変わらない。
 */
export interface DirEntryLike {
  readonly name: string;
  isDirectory(): boolean;
}

/** {@link DirEntryLike} の一覧を返す口。既定は実物の `readdir`。 */
export type ReaddirFn = (dir: string) => Promise<readonly DirEntryLike[]>;

const defaultReaddirFn: ReaddirFn = (dir) => readdir(dir, { withFileTypes: true });

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
  /**
   * **探索の起点そのもの（`root` 自身）を `readdir` できなかったときだけ
   * 載る理由**（Issue #1826）。省略 = 起点は読めた（`paths` が空でも
   * 「起点の下に0本だった」と確かめられている）。
   *
   * **起点より下の子ディレクトリの読み失敗とは別軸である。** あちらは
   * 意図して黙って諦める設計のまま変えていない（下の doc「読めない
   * ディレクトリ……」）——見つからなかった子ツリーが在っても、見つかった
   * 分だけを正としてよいという前提はそこでは壊れていない。**起点自身が
   * 読めないと、その前提そのものが成り立たない**（1本も見えていないので、
   * `paths` は常に空になる）。だからここだけ別の欄で名乗る。
   */
  readonly rootUnreadable?: string;
  /**
   * **起点より下（子ディレクトリ）**で `readdir` に失敗した延べ回数
   * （Issue #1865）。省略 = 0件（子ディレクトリの読み失敗は無かった）。
   *
   * ⚠️ **{@link rootUnreadable} とは別軸のまま**——起点自身の失敗はここに
   * 含めない。子ディレクトリの読み失敗そのものを黙って諦める設計（下の
   * doc「読めないディレクトリ……」）はこの PR でも変えていない。**`paths`
   * は「見つかった分」のまま返す**——この件数は「見つかった分が全体を
   * 尽くしているとは限らない」ことを示す添え物であって、`paths` から何かを
   * 差し引く材料ではない。
   */
  readonly unreadableDirCount?: number;
  /**
   * 上の失敗のうち最初の1件（`<パス>: <エラーメッセージ>`）。診断用の
   * サンプル1件であって、全件の一覧ではない——{@link unreadableDirCount} が
   * 載っているときだけ載る。
   */
  readonly unreadableDirSample?: string;
  /**
   * 深さ上限に当たって**降りなかった**子ディレクトリの数とサンプル（`reportDepthLimit: true` を
   * 渡したときだけ載る。既存の呼び出し元は渡さず、挙動は変わらない）。この下に `.git` が在るかは
   * 分からない——片付け（`scratch-sweep.ts`）は「判定できない」として残す。
   */
  readonly depthLimitedCount?: number;
  readonly depthLimitedSample?: string;
}

/**
 * `root` の下を深さ `maxDepth` まで探索し、`.git` を持つディレクトリを**全部**
 * 返す。`root` 自身が `.git` を持つ場合も拾う。
 *
 * - `node_modules` という名のディレクトリはその中へ潜らない。
 * - `.git` を見つけたら、その中へは潜らない（`.git` の中身は探索対象ではない）。
 * - **子ディレクトリ**が読めない（権限・競合で消えた等）は黙って諦める——
 *   探索そのものは止めない（見つかった分だけを正としてよい。全体が
 *   「確かめられなかった」に落ちる話ではない。**この PR では変えていない**）。
 *   ただし失敗した延べ回数だけは {@link FindGitDirsResult.unreadableDirCount}
 *   に数える（Issue #1865）——「見つかった分」と「見つかった分が全体かどうか
 *   分からない、という事実」は両立する。
 * - **起点（`root` 自身）**が読めないときだけは別扱いにする（Issue #1826）。
 *   ここが読めないと「見つかった分だけを正としてよい」という前提そのものが
 *   崩れる——1本も見ていないのに `paths: []` を返すと、「探索して0本
 *   だった」と「探索できなかった」が同じ形になる。{@link FindGitDirsResult.rootUnreadable}
 *   に理由を残す（`paths` は常に空）。
 */
export async function findGitDirs(
  root: string,
  options: {
    maxDepth?: number;
    maxCount?: number;
    readdirFn?: ReaddirFn;
    reportDepthLimit?: boolean;
  } = {},
): Promise<FindGitDirsResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCount = options.maxCount ?? DEFAULT_MAX_WORKTREES;
  const readdirFn = options.readdirFn ?? defaultReaddirFn;
  const found: string[] = [];
  let truncated = false;
  let rootUnreadable: string | undefined;
  let unreadableDirCount = 0;
  let unreadableDirSample: string | undefined;
  let depthLimitedCount = 0;
  let depthLimitedSample: string | undefined;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdirFn(dir);
    } catch (error) {
      // **起点そのもの（`dir === root`）だけを特別扱いする。** 子ディレクトリの
      // 読み失敗はこれまでどおり黙って諦める（このファイルの他の呼び出し元
      // ——`findManagerScratchRoots` 経由の `/tmp` スクラッチ探索・より深い
      // 階層——には一切影響しない）。**ただし件数だけは数える**（Issue #1865。
      // 起点の失敗は既に別の欄（`rootUnreadable`）で名乗っているので、ここには
      // 二重に含めない）。
      if (dir === root) {
        rootUnreadable = reasonOf(error);
      } else {
        unreadableDirCount += 1;
        if (unreadableDirSample === undefined) {
          unreadableDirSample = `${dir}: ${reasonOf(error)}`;
        }
      }
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
    if (depth >= maxDepth) {
      if (options.reportDepthLimit === true && subdirs.length > 0) {
        depthLimitedCount += subdirs.length;
        depthLimitedSample ??= path.join(dir, subdirs[0] ?? '');
      }
      return;
    }
    for (const name of subdirs) {
      if (truncated) return;
      await walk(path.join(dir, name), depth + 1);
    }
  }

  await walk(root, 0);
  if (rootUnreadable !== undefined) return { paths: found, rootUnreadable };
  return {
    paths: found,
    ...(truncated ? { truncatedAtCount: maxCount } : {}),
    ...(unreadableDirCount > 0 ? { unreadableDirCount, unreadableDirSample } : {}),
    ...(depthLimitedCount > 0 ? { depthLimitedCount, depthLimitedSample } : {}),
  };
}

/** `/tmp` 直下のディレクトリ名を、委譲の id と結び付けるための当てはめ規則。 */
const MANAGER_SCRATCH_DIR_NAME_PATTERN = /^mgr-([0-9a-f]{4,})/;

/**
 * 委譲の作業場を探す `/tmp` の位置。**`os.tmpdir()` は使わない**——担い手は
 * 依頼文に従って文字どおりの `/tmp/mgr-<id の先頭>` に作業場を作るので、
 * runner の `TMPDIR` が別の場所を指していても、探す先は `/tmp` でなければ当たらない。
 */
const MANAGER_SCRATCH_TMP_ROOT = '/tmp';

/**
 * `/tmp` 直下のディレクトリ名 `name` が、委譲 `managerId` のスクラッチ
 * ディレクトリとして当たるかどうか（冒頭の doc「3.6.」）。
 *
 * `name` が `mgr-` に16進4文字以上で続く形で始まり、その `mgr-<16進>` が
 * `managerId` の先頭と一致するときだけ `true`。**16進部分は正規表現の貪欲
 * マッチが自然に最長一致を取る**ので、`mgr-c654-scratch` のような
 * サフィックス付きの名前も `mgr-c654` の部分で当たる。
 */
export function matchesManagerScratchDirName(name: string, managerId: string): boolean {
  const match = MANAGER_SCRATCH_DIR_NAME_PATTERN.exec(name);
  if (match === null) return false;
  const hex = match[1];
  if (hex === undefined) return false;
  return managerId.startsWith(`mgr-${hex}`);
}

/**
 * 名前が「マネージャーの作業場」の規則（`mgr-<hex 4桁以上>…`）に当たるか。特定の
 * 委譲 id を問わない版（`/tmp` の片付け `scratch-sweep.ts` が候補を選ぶのに使う）。
 */
export function isManagerScratchDirName(name: string): boolean {
  return MANAGER_SCRATCH_DIR_NAME_PATTERN.test(name);
}

/** {@link findManagerScratchRoots} の戻り値。 */
export interface FindManagerScratchRootsResult {
  /** 当たったディレクトリの絶対パス。`unknownReason` が載っているときは常に空。 */
  readonly paths: readonly string[];
  /**
   * `tmpRootDir` 自体を読めなかった（存在しない・権限が無い等）ときの理由。
   * **省略 = 読めた**（`paths` が空でも「無かった」と確認できている）。
   *
   * ⚠️ **`findGitDirs` の「読めないディレクトリは黙って諦める」とは狙いが
   * 違う。** あちらは探索途中の任意の1階層の読み取り失敗で、見つかった分を
   * そのまま正としてよい（未探索の枝が在っても全体の答えは変わらない設計）。
   * こちらは探索の**起点そのもの**（`tmpRootDir` 自体）が読めない場合で、
   * 読めなければ「当たるディレクトリが1つも無かった」のか「そもそも見えて
   * いない」のかを`paths: []` だけでは呼び出し側が区別できない——
   * だから理由を別の欄に残す（#1765 段2。呼び出し側 `computeUnpushedWork`
   * はこれを `UnpushedWorkResult.scratchRootsUnknown` へそのまま伝える）。
   */
  readonly unknownReason?: string;
}

/**
 * `tmpRootDir`（既定は実際の `/tmp`）の直下を読み、`managerId` のスクラッチ
 * ディレクトリとして当たるものの絶対パスを返す（冒頭の doc「3.6.」）。
 *
 * **`tmpRootDir` の直下の名前一覧を読む以外、何もしない。** 当たらなかった
 * エントリの中へは降りない・stat もしない。**`tmpRootDir` 自体を読めなければ
 * `paths: []` へ静かに畳まず、`unknownReason` に理由を残す**——ここを `[]`
 * に潰すと、呼び出し側（`computeUnpushedWork` → `manager-auto-fold.ts` の
 * 自動畳み込みの安全弁）が「他マネージャー/作業者のスクラッチディレクトリに
 * 未 push の実装は無かった」と読んでしまい、実際には確かめられていないだけの
 * ケースを見落とす（#1765 段2）。
 */
export async function findManagerScratchRoots(
  tmpRootDir: string,
  managerId: string,
  options: { readdirFn?: ReaddirFn } = {},
): Promise<FindManagerScratchRootsResult> {
  const readdirFn = options.readdirFn ?? defaultReaddirFn;
  let entries;
  try {
    entries = await readdirFn(tmpRootDir);
  } catch (error) {
    // 例外の素の文は reasonOf（1行目だけ・伏せ字・長さ切り）を通す（#2607）。
    const detail = reasonOf(error);
    return {
      paths: [],
      unknownReason: `確かめられなかった（${tmpRootDir} を読めなかった: ${detail}）`,
    };
  }
  const paths = entries
    .filter((entry) => entry.isDirectory() && matchesManagerScratchDirName(entry.name, managerId))
    .map((entry) => path.join(tmpRootDir, entry.name));
  return { paths };
}

/**
 * 複数の起点（`job.cwd` と、当たった `/tmp` スクラッチディレクトリ）を
 * またいで `.git` を探し、重複を除いたうえで件数上限を全体に効かせる
 * （冒頭の doc「3.6.」の「重複の除去」）。
 *
 * 起点は渡された順に探索する。ある起点の探索が `findGitDirs` 自身の件数
 * 上限（`maxCount - (それまでに見つかった件数)`）に当たったら、以降の起点は
 * 探索せずに打ち切る——上限は起点ごとではなく全体に効く約束だからである。
 * 重複除去は `path.resolve` で正規化した文字列の同一性で行う（シンボリック
 * リンクの解決まではしない——`findGitDirs` 自身がしていないのと同じ理由）。
 *
 * **呼び出し元（`computeUnpushedWork`）は常に `[cwd, ...scratchRoots.paths]`
 * の形で渡す——1本目（`roots[0]`）は必ず `job.cwd` である**（Issue #1826）。
 * その1本目が {@link FindGitDirsResult.rootUnreadable} を持って返ってきたら、
 * 残りの起点を探索せずに即座に `rootUnreadable` を上へ運ぶ——`job.cwd` が
 * 読めないなら、そこから先に集めた `paths` は「見つかった分だけを正として
 * よい」という前提が既に崩れているので、部分的な結果を混ぜて返さない。
 * **2本目以降（`/tmp` スクラッチ起点）が読めるかどうかは、起点そのものが
 * 「列挙できたか」（`findManagerScratchRoots` の入口・`tmpRootDir` 自体）と
 * 「列挙で当たった個々のディレクトリが実際に読めるか」の別の問いである
 * （Issue #1891）。前者は既に `scratchRootsUnknown` が名乗っているが、後者は
 * 別で、`findGitDirs` が返す `rootUnreadable` をここで捨てずに数えないと
 * どちらの欄にも出ない——「探しきって0本だった」と区別が付かなくなる。
 * ⟹ 2本目以降の `rootUnreadable` は例外へは運ばず（1本目とは違い、探索
 * 自体は続ける）、`unreadableDirCount` へ1件として合算する。
 *
 * **`unreadableDirCount`（Issue #1865 / #1891）は起点をまたいで合算する。**
 * どの起点で起きた失敗も同じ意味（「見つかった分が全体かどうか分からない」）
 * を持つので、起点ごとに分けて持ち回る理由が無い。`unreadableDirSample` は
 * 最初に見つかった1件だけを残す（複数の起点をまたいで最初の1件、という
 * 意味は `findGitDirs` 単体のときと変わらない）。
 */
async function findGitDirsAcrossRoots(
  roots: readonly string[],
  options: { maxDepth?: number; maxCount?: number; readdirFn?: ReaddirFn },
): Promise<FindGitDirsResult> {
  const maxCount = options.maxCount ?? DEFAULT_MAX_WORKTREES;
  const seen = new Set<string>();
  const found: string[] = [];
  let truncated = false;
  let unreadableDirCount = 0;
  let unreadableDirSample: string | undefined;

  for (const [index, root] of roots.entries()) {
    if (found.length >= maxCount) {
      truncated = true;
      break;
    }
    const remaining = maxCount - found.length;
    const result = await findGitDirs(root, {
      maxDepth: options.maxDepth,
      maxCount: remaining,
      readdirFn: options.readdirFn,
    });
    if (index === 0 && result.rootUnreadable !== undefined) {
      return { paths: [], rootUnreadable: result.rootUnreadable };
    }
    if (index !== 0 && result.rootUnreadable !== undefined) {
      // 2本目以降の起点そのもの（`/tmp` スクラッチ起点）が読めない場合。
      // 1本目とは違い、ここでは探索を打ち切らず・例外へも運ばない——
      // `unreadableDirCount` に数えて、探索は残りの起点へ続ける（Issue #1891）。
      unreadableDirCount += 1;
      unreadableDirSample ??= `${root}: ${result.rootUnreadable}`;
    }
    if (result.unreadableDirCount !== undefined) {
      unreadableDirCount += result.unreadableDirCount;
      unreadableDirSample ??= result.unreadableDirSample;
    }
    for (const p of result.paths) {
      const resolved = path.resolve(p);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      found.push(resolved);
    }
    if (result.truncatedAtCount !== undefined) {
      truncated = true;
      break;
    }
  }

  return {
    paths: found,
    ...(truncated ? { truncatedAtCount: maxCount } : {}),
    ...(unreadableDirCount > 0 ? { unreadableDirCount, unreadableDirSample } : {}),
  };
}

export interface GitRunResult {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** `git` を1回、期限つきで起こして出力を集める。例外は投げない。 */
export async function runGit(
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
 * ⛔ 出してよいのは有無・件数・枝名と、origin remote の host/path まで
 * である（host/path は Issue #1376 B2 で足した。userinfo・クエリ・
 * フラグメント・資格・生の URL 文字列は出さない——冒頭の doc「3.5.」と
 * `parseRemoteOriginUrl`）。ファイル名・差分の中身・
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

/**
 * `git remote get-url origin` の出力から host と path だけを取り出す
 * （Issue #1376 B2）。**userinfo・クエリ・フラグメントは必ず落とす。**
 * 解釈できない・落とし切れる自信が無い形は `undefined` を返す——**生の
 * 文字列の断片を1バイトも漏らさないことを、この関数の外側の呼び出し元が
 * 信じられる形にする**（このファイル冒頭の doc「3.5.」を見よ）。
 *
 * 対応する2形:
 * 1. **`scheme://…` 形**（`https://` / `ssh://` / `git://` 等） — `URL` で
 *    解く。`URL#hostname` は userinfo（`username`/`password`）を含まない
 *    ので、そこだけを host として使えば userinfo は自動的に落ちる。
 *    `URL#pathname` はクエリ・フラグメントを含まないので、同様に自動で
 *    落ちる。
 * 2. **scp 形式**（`[user@]host:path`、例 `git@github.com:acme/widgets.git`）
 *    — `://` を持たない。`@` より前（あれば）は読み捨て、`:` の前後だけを
 *    host / path として使う。
 *
 *    ⚠️ **レビューで見つかった2つの漏れ（塞いだ）**:
 *    - **host の文字クラスから `@` も除く。** 除く前は `tok@en@github.com:…`
 *      のような（壊れた、または細工された）入力で、1個目の `@` までを
 *      userinfo として読み捨てた後、`en@github.com` を丸ごと host として
 *      拾ってしまっていた——`en@` は本来 userinfo の断片で、漏れていた。
 *      `@` を host の文字クラスからも除くと、`@` が2個以上ある形は
 *      正規表現そのものが一致しなくなり（userinfo 側で1個消費した残りに
 *      また `@` が挟まると host が `:` まで届かない）、`undefined` に
 *      自然に倒れる——「2個以上は undefined」を別条件で書き足す必要は
 *      無かった。
 *    - **scp 形式でもクエリ・フラグメントを落とす。** `scheme://` 形は
 *      `URL#pathname` が自動でクエリ・フラグメントを除くが、scp 形式は
 *      `:` の後ろを丸ごと path として読んでいたため、
 *      `git@host:owner/repo.git?token=…` のような形で漏れていた。
 *      **「undefined にする」ではなく「`?`/`#` 以降を切り落とす」を選んだ**
 *      ——scp 形式に本来クエリ・フラグメントの構文は無い（git 自身も
 *      構文として解釈しない）ので、後ろに付いた分は同じ文字列の続きとして
 *      巻き込まれただけの可能性が高く、`scheme://` 形と同じ「host/path は
 *      残し、クエリ・フラグメントだけ削る」という挙動に揃えるほうが
 *      一貫する。
 *
 * どちらにも当たらない（コロンが無い・`URL` が投げる等）ローカルパスや
 * 壊れた文字列は `undefined`。
 */
export function parseRemoteOriginUrl(raw: string): { host: string; path: string } | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.hostname.length === 0) return undefined;
    const path = url.pathname.replace(/^\/+/, '');
    if (path.length === 0) return undefined;
    return { host: url.hostname, path };
  }

  // scp 形式: `[user@]host:path`。host に `/` を含む場合はローカルパス
  // （例 `/a/b:c`）との誤認を避けるため対象にしない。**host の文字クラスから
  // `@` も除く** — `@` が2個以上ある入力で userinfo の断片が host へ漏れるのを
  // 防ぐ（上の doc の「レビューで見つかった2つの漏れ」を見よ）。
  const scpMatch = /^(?:[^@\s/]+@)?([^@:\s/]+):(.+)$/.exec(trimmed);
  if (scpMatch !== null) {
    const host = scpMatch[1] ?? '';
    // クエリ・フラグメントを落とす（`scheme://` 形の `URL#pathname` と
    // 挙動を揃える。上の doc を見よ）。
    const rawPath = (scpMatch[2] ?? '').split(/[?#]/)[0] ?? '';
    const path = rawPath.replace(/^\/+/, '');
    if (host.length > 0 && path.length > 0) {
      return { host, path };
    }
  }

  return undefined;
}

async function probeRemoteOrigin(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ host: string; path: string } | undefined> {
  const result = await runGit(spawnFn, ['remote', 'get-url', 'origin'], repoRoot, env, timeoutMs);
  if (result.timedOut || result.exitCode !== 0) return undefined;
  return parseRemoteOriginUrl(result.stdout.trim());
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
  /**
   * この観測を要求した委譲自身の id（`RunnerSession` の id）。渡すと、
   * `cwd` に加えてこの id で名前が付いた `/tmp` 直下のディレクトリも探索の
   * 起点にする（冒頭の doc「3.6.」、{@link findManagerScratchRoots}）。
   *
   * **省略すると、この起点は一切足さない**——`cwd` の下だけを探す、この
   * 機能を足す前の挙動と1バイトも変わらない。
   */
  managerId?: string;
  /**
   * `/tmp` の位置。省略時は文字どおりの `/tmp`（{@link MANAGER_SCRATCH_TMP_ROOT}）。
   * テストでは一時ディレクトリへ差し替える。`managerId` を渡さないときは参照されない。
   */
  tmpRootDir?: string;
  /**
   * `.git` を探す `readdir` の呼び口。省略時は実物の `readdir`
   * （{@link ReaddirFn} の doc）。**テスト以外で渡す理由は無い**——子
   * ディレクトリの読み失敗（Issue #1865）を、root かどうかに関係なく
   * 決定的に再現するための差し替え口である。
   */
  readdirFn?: ReaddirFn;
}

/**
 * `job.cwd` からの相対パスを出す——`repoRoot` が `cwd` の外に在るときは
 * 絶対パスを出す（冒頭の doc「3.6.」の「出力パスの形が変わる」。
 * `path.relative` が `..` で始まる値を返す形をそのまま出すと読みにくい
 * ため）。`cwd` の下で見つかったツリー（従来どおりの経路）はここまで
 * 1文字も変わらない。
 */
function describeWorktreePath(cwd: string, repoRoot: string): string {
  const relativePath = path.relative(cwd, repoRoot);
  if (relativePath.length === 0) return '.';
  if (relativePath.startsWith(`..${path.sep}`) || relativePath === '..') return repoRoot;
  return relativePath;
}

/**
 * `cwd` の下（と、`options.managerId` を渡したときはそれに当たる `/tmp`
 * 直下のスクラッチディレクトリ——冒頭の doc「3.6.」）を探索し、見つかった
 * 作業ツリーそれぞれについて未 push の実装と未コミットの変更を数える。
 * **個々の git 呼び出しが失敗しても投げない**——その1本だけが「確かめられ
 * なかった」を名乗り、他の作業ツリーの結果には影響しない。
 *
 * **この約束は `findManagerScratchRoots` の入口（`tmpRootDir` 自体が読める
 * か）までは元々及んでいなかった（#1765 段2で塞いだ穴）。** `managerId` を
 * 渡したのに `/tmp` 直下を読めなかった場合は、`worktrees` を空にするのでは
 * なく `result.scratchRootsUnknown` に理由を残す——ここも「個々の呼び出しが
 * 確かめられなかったを名乗る」対象に含める。
 *
 * **⚠️ ただし探索の起点（`cwd` 自身）が `readdir` できないときだけは例外**
 * **として投げる**（Issue #1826）。他の欄（`scratchRootsUnknown` /
 * `stoppedEarly` / `truncatedAtCount`）と同じように新しい欄を足す形も
 * 検討したが採らなかった——`cwd` は `job.cwd` そのもので、これが読めない
 * ということは他のどの欄も足場を持たない（1本も見ていないので、部分的な
 * `worktrees` すら作れない）。**この関数はワイヤー形（`UnpushedWorkResult`）
 * を返す約束なので、値としての `unavailable` は作らず、例外で「取れな
 * かった」を運ぶ**——呼び出し元は3箇所とも、既にこの形（例外 →
 * `kind: 'unavailable'`）を扱う口を持っている:
 * - `RunnerSession#finish()` / `#stop()`（`runner.ts`）は
 *   `#finishUnpushedWorkFn(...).then(...).catch((error) => ({ kind:
 *   'unavailable', reason: … }))` を既に持つ（`closed.unpushedWork` /
 *   `shutdown_unpushed_work.unpushedWork` のどちらも）
 * - `apps/runner/src/app.ts` の `GET /managers/:id/unpushed-work` は
 *   catch を持たないので Hono の既定エラーハンドラ（500）へ落ちる。
 *   `apps/daemon/src/runner-client.ts` の `RunnerClient#unpushedWork()` は
 *   非 2xx を含めあらゆる失敗を `catch { return undefined; }` で拾い、
 *   `packages/core/src/manager.ts` の `#probeUnpushedWork` が
 *   `result === undefined` を `kind: 'unavailable'` に変換する——この経路は
 *   3箇所とも変更していない（現物を読んで確かめた。PR 本文に逐語を残す）。
 */
export async function computeUnpushedWork(
  cwd: string,
  options: ComputeUnpushedWorkOptions,
): Promise<UnpushedWorkResult> {
  const scratchRoots: FindManagerScratchRootsResult =
    options.managerId === undefined
      ? { paths: [] }
      : await findManagerScratchRoots(
          options.tmpRootDir ?? MANAGER_SCRATCH_TMP_ROOT,
          options.managerId,
        );
  const found = await findGitDirsAcrossRoots([cwd, ...scratchRoots.paths], {
    maxDepth: options.maxDepth,
    maxCount: options.maxWorktrees,
    readdirFn: options.readdirFn,
  });
  if (found.rootUnreadable !== undefined) {
    throw new Error(
      `未 push の観測の探索起点（job.cwd）を読めなかった: ${cwd} — ${found.rootUnreadable}`,
    );
  }
  const timeoutMs = options.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const worktrees: UnpushedWorkTree[] = [];
  let stoppedEarly = false;
  for (const repoRoot of found.paths) {
    const relative = describeWorktreePath(cwd, repoRoot);
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
    const [branch, unpushed, uncommitted, remoteOrigin] = await Promise.all([
      probeBranch(options.spawn, repoRoot, options.env, timeoutMs),
      probeUnpushedCommitCount(options.spawn, repoRoot, options.env, timeoutMs),
      probeUncommittedChangeCount(options.spawn, repoRoot, options.env, timeoutMs),
      probeRemoteOrigin(options.spawn, repoRoot, options.env, timeoutMs),
    ]);
    worktrees.push({
      relativePath: relative,
      branch,
      ...unpushed,
      ...uncommitted,
      ...(remoteOrigin === undefined ? {} : { remoteOrigin }),
    });
  }
  return {
    cwd,
    worktrees,
    ...(found.truncatedAtCount === undefined ? {} : { truncatedAtCount: found.truncatedAtCount }),
    ...(stoppedEarly ? { stoppedEarly: true } : {}),
    ...(found.unreadableDirCount === undefined
      ? {}
      : {
          unreadableDirCount: found.unreadableDirCount,
          ...(found.unreadableDirSample === undefined
            ? {}
            : { unreadableDirSample: found.unreadableDirSample }),
        }),
    ...(scratchRoots.unknownReason === undefined
      ? {}
      : { scratchRootsUnknown: scratchRoots.unknownReason }),
  };
}

/**
 * 退避 ref（`rescue-ref.ts`、Issue #1266）が作業ツリーを列挙する口。
 * `computeUnpushedWork` と**同じ探索**（`cwd` と、`managerId` に当たる `/tmp`
 * スクラッチ）で、絶対パスと `describeWorktreePath` の相対パスの組を返す。
 * `computeUnpushedWork` は絶対パスを返さない約束なので別の口にした。
 * `cwd` が読めなければ `unreadable` に理由を載せて空で返す（投げない）。
 */
export async function listWorktreeRoots(
  cwd: string,
  options: {
    managerId: string;
    tmpRootDir?: string;
    maxWorktrees?: number;
    readdirFn?: ReaddirFn;
  },
): Promise<{
  worktrees: { repoRoot: string; relativePath: string }[];
  truncatedAtCount?: number;
  unreadable?: string;
}> {
  const scratchRoots = await findManagerScratchRoots(
    options.tmpRootDir ?? MANAGER_SCRATCH_TMP_ROOT,
    options.managerId,
  );
  const found = await findGitDirsAcrossRoots([cwd, ...scratchRoots.paths], {
    maxCount: options.maxWorktrees,
    readdirFn: options.readdirFn,
  });
  if (found.rootUnreadable !== undefined) {
    return { worktrees: [], unreadable: found.rootUnreadable };
  }
  return {
    worktrees: found.paths.map((repoRoot) => ({
      repoRoot,
      relativePath: describeWorktreePath(cwd, repoRoot),
    })),
    ...(found.truncatedAtCount === undefined ? {} : { truncatedAtCount: found.truncatedAtCount }),
  };
}
