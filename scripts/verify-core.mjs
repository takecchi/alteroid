/**
 * `pnpm verify` の判定だけを切り出したもの（指紋・畳むか・テストの結末の読み方）。
 *
 * **切り出したのはテストのためである。** 判定を `verify.mjs` の中に置いたままだと、
 * 歯を書くには `pnpm build` から始まる一式を実際に走らせるしかなく、**測りたいもの
 * （判定）より桁違いに重いものを毎回走らせることになる。**
 *
 * **だから判定はすべてここへ置く。** `verify.mjs` は「呼んで、出力して、終了コードを
 * 決める」だけにする。**当初は `testRan` だけ `verify.mjs` に残っていたが、それは
 * この PR の看板（「走っていない」を3つ目の状態にする）が、まさに歯の無い側に
 * 置かれているという形だった** — 一式を走らせない限り触れないので、テストが書けない。
 * **テストが書けない構造は、テストが無いのと同じである**（`AGENTS.md`）。
 *
 * 範囲・なぜその範囲か・見ていないものは `verify.mjs` の冒頭に在る。**あちらが正本。**
 */

// グローバルの `Buffer` に頼らない（`verify.mjs` が `process` をそう扱うのと同じ理由。
// この repo の script はどれもこの形で揃えてあり、eslint の `no-undef` もそう要求する）。
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ツリーの指紋。**読めなければ `null`** を返し、呼ぶ側は必ず走る側へ倒す
 * （「判定できない」を「変わっていない」へ倒さない）。
 *
 * ## 畳むもの
 *
 * 各ファイルについて **パス・モード・中身**の3つを畳む。**モードを入れてあるのは意図
 * である** — git は `100644` / `100755` / `120000`（symlink）を区別するので、実行ビットを
 * 立てただけでも `git diff` は差分として見せる。**中身だけを見ていると、それが指紋から
 * 漏れる。**
 *
 * **symlink は追いかけない**（`readlinkSync` で行き先の文字列そのものを畳む）。
 * `readFileSync` は symlink を追うので、行き先を差し替えても中身が同じなら指紋が
 * 動かない。**この repo は実際に `.idea` の symlink を main へ入れて2commit 前に外して
 * いる**（#160 → #190）ので、症状の出る形が現に在る。
 *
 * ## なぜ長さを前置するのか
 *
 * **前置しないと、違うツリーが同じ指紋になる。** `パス\0中身\0` を並べる形だと、
 * 「NUL を含む1つのファイル」と「空の2ファイル」が同じバイト列に畳まれる。
 * 実測（2026-08-22、この実装の前の版）:
 *
 *     A: 1ファイル `a` の中身が 00 62 00      → 99cde42e1e79…
 *     B: 空ファイル `a` と `b`                 → 99cde42e1e79…   （一致）
 *
 * どちらも `61 00 00 62 00 00` に畳まれていた。**NUL を含むファイルは仮定ではない** —
 * この repo は生の NUL が入った `chat.tsx` を実際に main へ入れている（PR #92、#102 が撤去）。
 * だから区切りではなく**長さ**で境界を作る。
 */
export function fingerprint(repo) {
  const list = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repo,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (list.status !== 0 || head.status !== 0) return null;

  const hash = createHash('sha256');
  /** **長さを前置してから畳む**（上の doc「なぜ長さを前置するのか」）。 */
  const feed = (label, value) => {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    hash.update(label + ':' + buf.length + ':');
    hash.update(buf);
  };

  feed('HEAD', head.stdout.trim());

  // **パスはバイト列のまま扱う。** utf8 として読むと、不正なバイトが U+FFFD へ畳まれて
  // 別のパスと衝突しうる（`git ls-files -z` は生のバイトを出す）。
  const paths = list.stdout
    .toString('binary')
    .split('\0')
    .filter(Boolean)
    // **並びを固定する。** git の出力順に依存させると、環境で答えが変わりうる。
    .sort();

  for (const path of paths) {
    const full = join(repo, Buffer.from(path, 'binary').toString('utf8'));
    feed('path', Buffer.from(path, 'binary'));
    try {
      const st = lstatSync(full);
      feed('mode', st.isSymbolicLink() ? '120000' : (st.mode & 0o111) !== 0 ? '100755' : '100644');
      // symlink は行き先の文字列を畳む（**追いかけない**。上の doc）。
      feed('body', st.isSymbolicLink() ? readlinkSync(full) : readFileSync(full));
    } catch {
      // 消えた・読めないファイルも「その状態」として指紋へ畳む（無視しない）。
      // **`mode` と `body` の両方へ入れる** — 片方だけだと、中身が偶然この文言と同じ
      // ファイルと衝突しうる。
      feed('mode', '<unreadable>');
      feed('body', '<unreadable>');
    }
  }
  return hash.digest('hex');
}

/**
 * 記録の置き場を git 自身に聞く。
 *
 * **`<repo>/.git` を直に組み立てないこと。** `git worktree` で作られた作業ツリーでは
 * `.git` は**ディレクトリではなく1行のファイル**である（`gitdir: …` と書いてある）。
 * そこへ `join(repo, '.git', '…')` で書こうとすると `ENOTDIR` で例外になる。
 *
 * **実測（2026-08-22）**: `.codiva/worktrees/pr-187` で
 * `ls -ld .git` → `-rw-r--r-- 1 … 73 .git`（`file` は `ASCII text` と答える）。
 * `git rev-parse --absolute-git-dir` は
 * `/…/alteroid/.git/worktrees/pr-187` を返す。**この形の作業ツリーは実際に約80本ある。**
 *
 * これを踏むと、**一式が全部通った後に**記録の書き込みだけが落ちる ＝ 通ったのに
 * 「落ちた」と見える。しかも記録が永久に残らないので、**この PR の看板（通し直しを
 * 無料にする）が、その器では一度も効かない。**
 *
 * 取れなければ `null`（呼ぶ側は記録せず、次も必ず走る）。
 */
export function recordPathFor(repo) {
  const dir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (dir.status !== 0) return null;
  const trimmed = dir.stdout.trim();
  if (trimmed === '') return null;
  return join(trimmed, 'alteroid-verify.json');
}

/**
 * 無料で返してよいか。
 *
 * **倒す先は常に「走る」である。** 指紋が取れない・記録が無い・記録が壊れている・
 * `--force` — どれも `skip: false` になる。**「判定できない」を「変わっていない」へ
 * 倒さないこと**（倒すと、いちばん危ないときに黙って緑を名乗る）。
 */
export function decideSkip({ repo, recordPath, force = false }) {
  const current = fingerprint(repo);
  if (force) return { skip: false, reason: 'force', fingerprint: current };
  if (current === null) return { skip: false, reason: 'no-fingerprint', fingerprint: null };
  // 置き場が取れない器（`recordPathFor` が `null`）でも走る側へ倒す。
  if (recordPath === null || recordPath === undefined) {
    return { skip: false, reason: 'no-record-path', fingerprint: current };
  }
  if (!existsSync(recordPath)) return { skip: false, reason: 'no-record', fingerprint: current };
  try {
    const saved = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (saved.fingerprint === current) {
      return { skip: true, reason: 'unchanged', fingerprint: current, at: saved.at };
    }
    return { skip: false, reason: 'changed', fingerprint: current };
  } catch {
    // 記録が壊れていたら走る側へ倒す（読めない記録を信じない）。
    return { skip: false, reason: 'broken-record', fingerprint: current };
  }
}

/**
 * テストが「走った」かを、件数ではなく**行の不在**で見る。
 *
 * **「落ちた」と「1本も走らなかった」はどちらも exit 1 である**（`AGENTS.md`「自分が
 * 走っている器」）。`Test Files` / `Tests` の行が出ていなければ、通ったのでも落ちたのでも
 * なく**走っていない**。
 */
export function testRan(output) {
  return /^\s*Test Files\s+/m.test(output) && /^\s*Tests\s+/m.test(output);
}

/**
 * テストの結末を読む。**4つある。**
 *
 * | 返す `state`  | 意味                             | `verify.mjs` の終了コード |
 * | ------------- | -------------------------------- | ------------------------- |
 * | `passed`      | 走って、通った                   | （次の手順へ）            |
 * | `failed`      | 走って、落ちた                   | 1                         |
 * | `not-run`     | **1本も走っていない**            | 3                         |
 * | `undecidable` | **走ったかどうかが分からない**   | 4                         |
 *
 * **`undecidable` を `not-run` へ混ぜないこと。** signal で殺された場合、テストは走った
 * かもしれないし走っていないかもしれない。ここを `not-run` に倒すと、**「器が混んでいる。
 * 並列度を下げて取り直せ」という、原因と関係のない助言を出す** — 並列度を下げても直らない
 * ので、読んだ人はそれを繰り返すことになる。
 *
 * **2値にしないのと同じ理由で、3値にもしない**（`AGENTS.md`「『判定できない』という
 * 3つ目の状態を持つ」）。分からないものは、分からないと言う。
 */
export function classifyTest({ status, signal, output }) {
  // 殺された（`status` は null になる）。走ったかは**この情報では決まらない。**
  if (signal !== null && signal !== undefined) {
    return { state: 'undecidable', reason: 'signal', signal, ran: testRan(output) };
  }
  if (status === null || status === undefined) {
    return { state: 'undecidable', reason: 'no-status', ran: testRan(output) };
  }
  if (!testRan(output)) return { state: 'not-run', reason: 'no-summary-lines' };
  return status === 0 ? { state: 'passed' } : { state: 'failed', code: status };
}

/**
 * 一式。**順序に意味がある**（`build` が先。`verify.mjs` の冒頭 doc）。
 *
 * **ここに置いてあるのは歯のためである**（このファイルの冒頭 doc と同じ理由）。
 * 「build の手順にだけ `PNPM_CONFIG_WORKSPACE_CONCURRENCY` が渡る」という保証は、
 * **実際の手順の定義と突き合わせないと測ったことにならない** — テスト側で手順を
 * でっち上げて測ると、`verify.mjs` の側でフラグを付け忘れても緑のままになる。
 *
 * `openapi` だけ `pnpm` ではなく `git` なのは、生成物が最新かを見る検査だからである
 * （`pnpm build` が書き換えた後に差分が残っていれば、commit し忘れている）。
 *
 * **`HEAD` を明示するのは意図である。** CI は `actions/checkout` の直後なので index と
 * `HEAD` が必ず一致していて、素の `git diff` でも「`HEAD` と作業ツリーの差」を意味する。
 * **手元では index が汚れているのが普通なので、同じコマンドが違う意味になる** —
 * `pnpm build` が生成物を書き換えた後に `git add` だけしてソースだけを commit すると、
 * `HEAD` は古い生成物を持ったまま素の `git diff` は 0 を返す（**手元は緑、CI は赤**）。
 * 実測（2026-08-22、`HEAD`=旧 / index=新 / 作業ツリー=新）:
 *
 *     git diff --exit-code -- f        → 0   （素の形。差分を見落とす）
 *     git diff --exit-code HEAD -- f   → 1   （実際の乖離）
 *
 * **`workspaceConcurrencyEnv` を持つ手順にだけ env が足される**（`envForStep`）。
 * いま持っているのは `build` だけである。**手順の名前で分岐しないのは意図である** —
 * 名前で分岐すると、手順を増やしたり名前を変えたときに、静かに外れる。
 */
export const STEPS = [
  { name: 'build', cmd: 'pnpm', args: ['build'], workspaceConcurrencyEnv: true },
  {
    name: 'web-bundle-node-traces',
    cmd: 'pnpm',
    args: ['check:web-bundle-node-traces'],
    hint:
      'apps/web の生成物に Node 専用の痕跡（createRequire / node: 指定子 / process.cwd / Bun.）が' +
      '混入している。@alteroid/core（や他の依存）から値を import してサーバ専用コードを引き込んで' +
      'いないか確認すること（scripts/check-web-bundle-node-traces.mjs の doc）',
  },
  {
    name: 'openapi',
    cmd: 'git',
    args: ['diff', '--exit-code', 'HEAD', '--', 'apps/daemon/openapi.json'],
    hint: 'apps/daemon/openapi.json が古い。`pnpm build` の結果を commit すること',
  },
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'lint', cmd: 'pnpm', args: ['lint'] },
  { name: 'format:check', cmd: 'pnpm', args: ['format:check'], hint: '`pnpm format` で直る' },
  { name: 'test', cmd: 'pnpm', args: ['test'], isTest: true },
];

/** `--workspace-concurrency` のフラグ名（`=` 形も空白区切りも、この1つから作る）。 */
const WORKSPACE_CONCURRENCY_FLAG = '--workspace-concurrency';

/**
 * `--workspace-concurrency` を読む。**`=` の形と空白区切りの形の両方を受ける。**
 *
 * **両方受けるのは #331（→ PR #344）の差し戻しと同じ理由である** — あちらは
 * `--max-workers=2` の `=` 形が**静かに無視されて既定へ落ちていた**。渡した側からは
 * 「効かない」ことが出力に出ないので、片方だけ実装すると同じ穴が空く。
 *
 * **既定を持たない。** 無ければ `undefined` を返し、呼ぶ側は環境変数を1つも足さない
 * （`verify.mjs` の doc「既定を数で固定しない。数を持たず、渡せる口だけを開ける」）。
 *
 * **1以上の整数でなければ落とす**（`readMaxWorkers` と同じ形）。黙って既定へ倒すと、
 * 打ち間違いが「効かなかった」という無言の形で出る。
 */
export function readWorkspaceConcurrency(args) {
  const eqPrefix = WORKSPACE_CONCURRENCY_FLAG + '=';
  const eqArg = args.find((a) => a.startsWith(eqPrefix));
  let raw;
  if (eqArg !== undefined) {
    raw = eqArg.slice(eqPrefix.length);
  } else {
    const idx = args.indexOf(WORKSPACE_CONCURRENCY_FLAG);
    if (idx === -1) return undefined;
    raw = args[idx + 1];
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `${WORKSPACE_CONCURRENCY_FLAG} には1以上の整数を渡すこと` +
        `（${WORKSPACE_CONCURRENCY_FLAG} <n> または ${WORKSPACE_CONCURRENCY_FLAG}=<n> の形。` +
        `実際: ${JSON.stringify(raw)}）`,
    );
  }
  return n;
}

/**
 * `pnpm verify -- …` に渡された引数を、宛先ごとに分ける。
 *
 * | 引数                        | 宛先                                                       |
 * | --------------------------- | ---------------------------------------------------------- |
 * | `--workspace-concurrency`   | **build の手順の env**（`envForStep`）                     |
 * | `--` / `--force`            | どこへも行かない（`verify.mjs` 自身のもの）                |
 * | それ以外                    | **test の手順の引数**（`--maxWorkers=4` の既存の挙動）     |
 *
 * **`--workspace-concurrency` を `passthrough` に残さないこと。** 残すと `pnpm test
 * --workspace-concurrency=2` になる — #362 が報告した欠陥そのものである（build へ
 * 届かないだけでなく、**test のほうへ付いていた**）。空白区切りの形では値の側も
 * 落とす（落とさないと、裸の数字が vitest へ渡ってパスの絞り込みとして解釈される）。
 *
 * **素の `--` を落とす理由は `verify.mjs` の `passthrough` の doc に在る**（`pnpm verify
 * -- --maxWorkers=4` と打つと pnpm が `--` ごと渡してくるので、そのまま足すと
 * `pnpm test -- --maxWorkers=4` になり vitest へ届かない）。
 */
export function splitVerifyArgs(argv) {
  const workspaceConcurrency = readWorkspaceConcurrency(argv);
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--' || arg === '--force') continue;
    if (arg.startsWith(WORKSPACE_CONCURRENCY_FLAG + '=')) continue;
    if (arg === WORKSPACE_CONCURRENCY_FLAG) {
      // 値の側も落とす（`--workspace-concurrency 2` の `2`）。
      i += 1;
      continue;
    }
    passthrough.push(arg);
  }
  return { workspaceConcurrency, passthrough };
}

/**
 * その手順へ渡す環境変数。
 *
 * **⚠️ build へ「引数として」渡さないこと。** `pnpm build -- --workspace-concurrency=2`
 * の形は、フラグが**各パッケージの build スクリプトの引数**になる。`tsup` は黙って
 * 無視するが、`react-router build`（`apps/web`）は `--` を位置引数のルートディレクトリ
 * と解釈して `Could not find a root route module in the app directory as "app/root.tsx"`
 * で落ちる。しかも並列度は既定のままである（実測は `AGENTS.md`「自分が走っている器」）。
 * **だから環境変数で渡す。**
 *
 * `pnpm` が読むのは `PNPM_CONFIG_*` / `pnpm_config_*` であって `NPM_CONFIG_*` ではなく、
 * **大文字なら全部大文字、小文字なら全部小文字でなければ無視される**（同じく
 * `AGENTS.md`）。だから大文字の形だけを足す。
 *
 * **既定を持たない。** `workspaceConcurrency` が `undefined` なら `baseEnv` を**そのまま**
 * 返す（1文字も足さない）。器の外で `PNPM_CONFIG_WORKSPACE_CONCURRENCY` を設定している
 * 人の値を、この口が黙って上書きしないためでもある。
 */
export function envForStep(step, { workspaceConcurrency, baseEnv }) {
  if (workspaceConcurrency === undefined || step.workspaceConcurrencyEnv !== true) return baseEnv;
  return { ...baseEnv, PNPM_CONFIG_WORKSPACE_CONCURRENCY: String(workspaceConcurrency) };
}
