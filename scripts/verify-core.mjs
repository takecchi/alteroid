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
