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
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

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
 * 一時 index に `git add -A` して `git write-tree` し、そのときの作業ツリーの
 * 中身を tree の sha として得る（Issue #1763・#1192 の N7）。
 *
 * ## なぜ tree なのか（`fingerprint` の `HEAD` と対になる問題）
 *
 * `fingerprint` は `HEAD` の sha を畳んでいる（`feed('HEAD', …)`）。ふつうの
 * 順序は「直す → `pnpm verify` → commit → push」なので、commit した瞬間に
 * `HEAD` が動き、指紋は必ず一致しなくなる——**指紋をそのまま「push した
 * commit の中身が検証済みか」の判定へ転用すると、正しい順序で作業しても
 * 毎回「未検証」になる（偽陽性しか出ない）。** tree の sha は commit を
 * 作っても変わらない（commit は既存の tree に親と作者情報を付けるだけの
 * こともある）ので、`pnpm check:verified-head`（`check-verified-head-core.mjs`）
 * は `HEAD` ではなく tree を比べる。
 *
 * ## 本物の index も作業ツリーも動かさない
 *
 * `GIT_INDEX_FILE` を差し替えた環境だけを渡すことで、書き込み先を一時
 * ファイルへそらす——本物の `.git/index` は**コピー元として読むだけで、
 * 書き込みは一度もしない**（下の「一時 index の初期状態」参照。読むのは
 * `copyFileSync` の1回きりで、その後の `git add -A` / `git write-tree` は
 * すべて一時ファイルの上で完結する）。一時ファイル名は呼ぶたびに乱数を
 * 混ぜる（`AGENTS.md`「同一の git 作業ツリーを複数のプロセスが同時に
 * 書き換えることがある」——マネージャーと作業者が同じツリーで並行して
 * `pnpm verify` を走らせても、固定名だと一時 index を取り合う）。
 *
 * ## 一時 index の初期状態（Issue #1785）
 *
 * **一時 index は、空からではなく「いまの本物の index の写し」から始める。**
 * 空から始めると（この関数のかつての実装）、一時 index の視点からは
 * すべてのパスが「まだ一度も追跡されていない」ものに見える。すると
 * **追跡済みで、かつ .gitignore にも当たるファイル**まで、その一時 index の
 * 上では「新規の・ignore されたファイル」に化けて `git add -A` に拾われず、
 * tree から漏れる——一方 `fingerprint` が使う `git ls-files -co
 * --exclude-standard` は、追跡済みなら ignore の規則に関わらず常に挙げる。
 * 実際に踏むと、force-add 済みのファイルにパターンが後から掛かる・既存の
 * 追跡ファイルへ `.gitignore` が後から足される、といったよくある形で
 * **`pnpm check:verified-head` が、verify した直後の HEAD ですら「不一致」と
 * 言う**（歯1の前提が崩れる。再現は
 * `scripts/t3-check-verified-head-tracked-ignored.repro.test.ts`）。
 *
 * 本物の index の写しから始めれば、そこに載っている追跡済みパスは
 * **ignore の規則に関わらず**最初から一時 index に存在する。以降の
 * `git add -A` は、そのパスを「既に追跡されている」ものとして中身・
 * モードの更新（や、作業ツリーから消えていれば削除）を行うだけで、
 * ignore 判定はそこを一度も通らない——`git ls-files -c` が ignore を
 * 素通りするのと構造的に同じ経路を辿る形にしてある。
 *
 * **`fingerprint` と見る範囲を揃えてある。** `fingerprint` は `git ls-files -co
 * --exclude-standard` が挙げる集合（追跡なら ignore を問わず全部・未追跡は
 * ignore を除く）を畳む。一時 index を本物の index の写しから始めたうえでの
 * `git add -A` も、**追跡済みパス（写しに載っている）は ignore を問わず
 * 更新し、未追跡の新規パスは `--exclude-standard` 相当で ignore されたものを
 * 拾わない**——両者が見る集合は一致する。
 *
 * 本物の index がまだ存在しない（1回も `git add` していない、コミット0の
 * 裸の repo）場合は、写す元が無いので一時 index は空から始まる——その時点で
 * 追跡済みのパスはそもそも1つも無いので、この空スタートは以前の実装と
 * 同じ意味になる（漏れが起きようがない）。
 *
 * ## `skip-worktree` / `assume-unchanged` は開く側の穴になる（Issue #1785 レビュー）
 *
 * **写しから始める形そのものが、別の穴を持ち込む。** 本物の index の写しには
 * `skip-worktree` / `assume-unchanged` の印もそのまま付いてくる。**印の付いた
 * パスは、`git add -A` が作業ツリーの中身と突き合わせない**（git 自身がその
 * パスを「作業ツリーを見なくてよい」ものとして最適化している——`skip-worktree`
 * は sparse checkout で実体が無いことがある前提、`assume-unchanged` は
 * 「変わっていないと信じてよい」という明示の申告）。
 *
 * ⟹ 作業ツリーの中身が index（＝直近の commit）と食い違ったまま `pnpm verify`
 * を通すと（`fingerprint` はディスクを直接読むので、そのずれを畳んでしまう）、
 * `writeTreeFor` の tree には **古い（index のままの）中身**が入る。もし
 * その中身がたまたま `HEAD^{tree}` と一致すれば、`pnpm check:verified-head`
 * は「verify が測った中身」と「push した commit の中身」が違うのに
 * **「一致」と言う**——このファイルの他の穴（Issue #1785 本体）とは逆向きの、
 * より危険な「開く側」の欠陥である。
 *
 * **対策: 印が1つでも付いていれば `null`（判定できない）へ倒す。** 印を
 * 外してから進める案もあるが採らない——`skip-worktree` は sparse checkout の
 * ように**作業ツリーに実体そのものが無い**ことがある前提の印なので、外して
 * 「作業ツリーを見に行かせる」と、その前提を壊す（存在しないファイルとして
 * 削除されるなど、呼び出し側が意図していない書き換えを本物の index の外で
 * 起こしうる）。判定できない側へ倒せば、`recordFor` の `tree` 引数が
 * `undefined` になり、`compareVerifiedHead` は「旧形式の記録（tree を持たない）」
 * と同じ経路で `undecidable` を返す（歯4と同じ向き。新しく分岐を増やして
 * いない）。
 *
 * **検出方法**: 写した直後の一時 index に対して `git ls-files -v` を呼ぶ
 * （`-t` と同じタグを行頭に出し、`assume-unchanged` の対象は**小文字**に
 * なる）。行頭が `S`（skip-worktree）か、英小文字（`assume-unchanged`）なら
 * 検出。**`git add -A` の前に見る**——印が付いたパスは `add -A` を経ても
 * 状態が変わらないので、前後どちらで見ても同じだが、無駄な `add -A` を
 * 走らせる前に安全側へ倒せるほうを選んだ。
 *
 * 取れなければ `null`（呼ぶ側は記録しない側へ倒す——`decideSkip` / `decideRecord`
 * と同じ「判定できないを都合のよい側へ倒さない」向き）。
 *
 * **測っていないこと**: 大きなツリーで `git add -A` が一時 index に掛かる
 * 時間（本物の index の写しを1回コピーする分、わずかに増えるはずだが
 * 実測はしていない）。`pnpm verify` 一式（数分）に比べれば軽いと見込んで
 * いるだけである（Issue #1763 が自分で挙げている留保）。symlink・実行ビット・
 * `.gitattributes` の正規化（CRLF 等）は、tracked/untracked のどちらであっても
 * `git add -A` 自身の扱いは変わらない（写しから始めるかどうかは「ignore
 * 判定を経由するかどうか」だけを変える）ので、この修正で新たに崩れる・
 * 揃う性質ではない——手で確認した実測は PR 本文に記す。
 */
/**
 * `git ls-files -v` の出力から、`skip-worktree` / `assume-unchanged` の印が
 * 付いたパスが1本でもあるかを読む（`writeTreeFor` の doc「`skip-worktree` /
 * `assume-unchanged` は開く側の穴になる（Issue #1785 レビュー）」）。
 *
 * **タグは行頭の1文字**（`git ls-files -t` と同じタグ集合）。`skip-worktree`
 * は `S`（大文字）。`assume-unchanged` は、対象のタグ文字を**小文字**にする
 * （`-v` の man page どおり）——だから「行頭が `S` か、英小文字」で両方を
 * まとめて拾える。
 *
 * **純関数として切り出した。** `git` を実際に起こさなくても歯が書けるように
 * するため（`AGENTS.md`「テストが書けない構造は、テストが無いのと同じ」）。
 * `writeTreeFor` からは、実際に起こした `git ls-files -v` の標準出力を渡すだけ。
 */
export function hasSkipWorktreeOrAssumeUnchanged(lsFilesVOutput) {
  return lsFilesVOutput.split('\n').some((line) => {
    if (line.length === 0) return false;
    const tag = line[0];
    return tag === 'S' || (tag >= 'a' && tag <= 'z');
  });
}

export function writeTreeFor(repo) {
  const dir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (dir.status !== 0) return null;
  const gitDir = dir.stdout.trim();
  if (gitDir === '') return null;

  const indexFile = join(
    gitDir,
    'alteroid-verify-index.' + process.pid + '.' + randomBytes(6).toString('hex'),
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    // **一時 index を、いまの本物の index の写しから始める**（上の doc「一時 index の
    // 初期状態（Issue #1785）」）。本物の index は読むだけで、一切書き込まない
    // （`copyFileSync` の src 側）。コピーできなければ、以降の `git add -A` が
    // どちらの範囲を見ているか保証できないので、判定できない側（`null`）へ倒す。
    const realIndexFile = join(gitDir, 'index');
    if (existsSync(realIndexFile)) {
      try {
        copyFileSync(realIndexFile, indexFile);
      } catch {
        return null;
      }
    }

    // Issue #1785 レビュー: 写した一時 index に `skip-worktree` /
    // `assume-unchanged` の印が付いたパスがあれば、これから走らせる
    // `git add -A` はその作業ツリーの中身を見ない（上の doc「`skip-worktree` /
    // `assume-unchanged` は開く側の穴になる」）。`add -A` の前に見て、
    // 見つかったら判定できない側（`null`）へ倒す。
    const lsFilesV = spawnSync('git', ['ls-files', '-v'], { cwd: repo, env, encoding: 'utf8' });
    if (lsFilesV.status !== 0) return null;
    if (hasSkipWorktreeOrAssumeUnchanged(lsFilesV.stdout)) return null;

    const add = spawnSync('git', ['add', '-A'], { cwd: repo, env });
    if (add.status !== 0) return null;
    const write = spawnSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' });
    if (write.status !== 0) return null;
    return write.stdout.trim();
  } finally {
    // **後片付けは finally で、失敗を無視する。** コピーや `git add -A` が一時 index を
    // 作る前に落ちた場合、消すものが無いだけなので例外を握り潰してよい。
    try {
      unlinkSync(indexFile);
    } catch {
      // 意図的に無視（上のコメント）。
    }
  }
}

/**
 * 今日の日付を `'YYYY-MM-DD'`（UTC）で作る。**I/O 層でだけ呼ぶ**
 * （`scripts/test-guard-core.mjs` の `todayUtc` と同じ作法）——`decideSkip` の
 * 既定引数の中だけで使い、それ以外の場所（`decideRecord` / `recordFor` の
 * 純粋なロジック）では絶対に `new Date()` を呼ばない。理由は Issue #1191:
 * 「日付依存の検査を数え上げてキャッシュ判定の外へ出す」形は、**vitest の
 * スイートの内側に在る日付依存のテスト（`scripts/test-guard-core.test.ts` の
 * 「`today` を渡さなければ既定値（現在時刻）で回る」）まで数え上げないと
 * 閉じない**——それは原理的に不可能である（歯Cの単体テストが、歯C自身の
 * 判定対象である `today` を固定引数で確かめている以上、`test` という1つの
 * 手順の中に日付依存が何本在るかを外側から数え切ることはできない）。
 * だから「日付依存の検査を列挙する」のではなく、**「記録した日」と「いま」を
 * 突き合わせて、日が変わったら指紋が一致しても走り直す**形にした。
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 無料で返してよいか。
 *
 * **倒す先は常に「走る」である。** 指紋が取れない・記録が無い・記録が壊れている・
 * `--force` — どれも `skip: false` になる。**「判定できない」を「変わっていない」へ
 * 倒さないこと**（倒すと、いちばん危ないときに黙って緑を名乗る）。
 *
 * **`today` を追加した（Issue #1191）。** 指紋が一致しても、記録した日
 * （`saved.day`）が今日と違えば走る（`reason: 'stale-day'`）。**旧形式の記録
 * （`day` を持たない・文字列でない）も同じ側へ倒す**——安全側であり、次に
 * 一式が通れば `recordFor` が新形式で書き直すので自然に入れ替わる。
 *
 * **粒度は日までである。** 同じ日の中で判定が変わる検査（時刻単位で倒れる
 * もの）には効かない（`verify.mjs` 冒頭 doc の「指紋が見ていないもの」と
 * 同じ性質の限界）。
 *
 * **いまの一式にそれが在るかは、2026-09-23 に抜き取りで測った（Issue #1274）。**
 * JS の `Date` だけを同じ UTC 日の中の別の時刻（器の `TZ=Asia/Tokyo` での
 * ローカル日付の切り替わり 15:00Z の前後を含む）へずらして全テストを回し、
 * 結果が変わったのは「ずらした `Date`」と「ずらせない実時計（fs の mtime・
 * 子プロセス）」を突き合わせるテストだけだった＝測定の細工による見かけで、
 * 時刻で倒れる検査は見つからなかった。**抜き取りなので不在の証明ではない**
 * ——測った位置・範囲と測っていない範囲は #1274 に在る。
 */
export function decideSkip({ repo, recordPath, force = false, today = todayUtc() }) {
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
      if (typeof saved.day !== 'string' || saved.day !== today) {
        return {
          skip: false,
          reason: 'stale-day',
          fingerprint: current,
          at: saved.at,
          day: saved.day,
          // **判定に使った `today` を返す。** 呼ぶ側が表示のために自分で
          // `new Date()` を引き直すと、真夜中を跨いだ瞬間に「判定が使った日」と
          // 「表示した日」が食い違いうる（出力だけが嘘になる形）。
          today,
        };
      }
      return { skip: true, reason: 'unchanged', fingerprint: current, at: saved.at };
    }
    return { skip: false, reason: 'changed', fingerprint: current };
  } catch {
    // 記録が壊れていたら走る側へ倒す（読めない記録を信じない）。
    return { skip: false, reason: 'broken-record', fingerprint: current };
  }
}

/**
 * ANSI エスケープシーケンス（色付け）を取り除く。
 *
 * #392: `testRan` は以前、剥がさずに `^\s*Test Files\s+/m` へ直接掛けていた。
 * `^\s*` は行頭の空白しか許さないので、色が付くと行頭の SGR に一致せず、
 * **完走して緑でも「1本も走っていない」（`not-run`）に化ける** —— しかも
 * `classifyTest` の doc 自身が名指しで禁じている倒れ方（「器が混んでいる。
 * 並列度を下げろ」という原因と無関係な助言）をこの経路から出す。
 *
 * **同じ穴は既に2箇所で直っている**（`scripts/test-guard-core.mjs` の
 * `stripAnsi` — #311 / PR #355、`.claude/skills/mutation-testing/mutate-core.mjs`
 * の `stripAnsi` — #372 / PR #374）。**ここも同じ正規表現・同じ関数名・同じ順序
 * （剥がしてから match）に揃える。** 揃える理由は「3箇所が別々の形にならないこと」
 * そのものであり、**この形が最善だと確かめたわけではない** —— 確かめたのは
 * 他2箇所の現物の形であって、その形の妥当性ではない（PR #374 が #355 に対して
 * 採った立場と同じ）。
 *
 * **⚠️ この経路（`verify.mjs` → `runTest` → `testRan`）で実際に色付きの出力を
 * 受け取ったという観測は無い。** Issue #392 自身が「根拠は静的な読み（同じ
 * 正規表現・ANSI 除去なし）だけである」「踏んだ観測は無い」と断っている。
 * ここで固定しているのは「色が付いても倒れない」であって「実際に色が付く」
 * ではない（`scripts/verify-core.test.ts` のフィクスチャの doc も参照）。
 */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- ANSI エスケープの検出そのものが目的
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * テストが「走った」かを、件数ではなく**行の不在**で見る。
 *
 * **「落ちた」と「1本も走らなかった」はどちらも exit 1 である**（`AGENTS.md`「自分が
 * 走っている器」）。`Test Files` / `Tests` の行が出ていなければ、通ったのでも落ちたのでも
 * なく**走っていない**。
 *
 * **剥がしてから match する（#392）。** ただし「剥がせば何でも読める」には緩めて
 * いない —— 探す語（`Test Files` / `Tests`）は1文字も変えていないので、集計行が
 * 本当に無い入力では剥がした後も `false` のままである（#311 が守っている性質。
 * `scripts/verify-core.test.ts` の回帰）。
 */
export function testRan(output) {
  const plain = stripAnsi(output);
  return /^\s*Test Files\s+/m.test(plain) && /^\s*Tests\s+/m.test(plain);
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
    name: 'web-bundle-size',
    cmd: 'pnpm',
    args: ['check:web-bundle-size'],
    hint:
      'apps/web の生成物（apps/web/build/client/assets/*.js）がチャンクのサイズ予算を超えた。' +
      '閾値を上げる前に、増えた原因を特定すること（scripts/check-web-bundle-size.mjs の doc、' +
      'https://github.com/takecchi/alteroid/issues/335）',
  },
  {
    name: 'web-css-comment-classnames',
    cmd: 'pnpm',
    args: ['check:web-css-comment-classnames'],
    hint:
      'apps/web の生成物の CSS に、コメント中のプレースホルダ記法（`...` / `…`）がクラス名として' +
      '拾われて生まれた不正な宣言が入っている。プレースホルダを含む例をコメントへ書いていないか' +
      '確認すること（scripts/check-web-css-comment-classnames-core.mjs の doc、#317）',
  },
  {
    name: 'web-css-no-inline-fonts',
    cmd: 'pnpm',
    args: ['check:web-css-no-inline-fonts'],
    hint:
      'apps/web の生成物の CSS にフォントの base64 埋め込み（`data:font/`）が入っている。' +
      'apps/web/vite.config.ts の build.assetsInlineLimit（フォントを埋め込まない関数形）が' +
      '外れていないか確認すること。埋め込むと unicode-range に関係なく CSS と一緒に最初に' +
      '落ちてくる（scripts/check-web-css-no-inline-fonts-core.mjs の doc）',
  },
  {
    name: 'openapi',
    cmd: 'git',
    args: ['diff', '--exit-code', 'HEAD', '--', 'apps/daemon/openapi.json'],
    hint: 'apps/daemon/openapi.json が古い。`pnpm build` の結果を commit すること',
  },
  {
    name: 'sdk-quotes',
    cmd: 'pnpm',
    args: ['check:sdk-quotes'],
    hint:
      '同梱 SDK の型定義から逐語で引いたコメント（sdk-verbatim の印が付いた行）が、' +
      'いまの版に当たらなくなった。引用を書き換える前に、その引用を根拠にしている判断が' +
      'まだ成り立つかを確かめること（scripts/check-sdk-quotes-core.mjs の doc）',
  },
  {
    name: 'stale-token-restart-advice',
    cmd: 'pnpm',
    args: ['check:stale-token-restart-advice'],
    hint:
      '「世代ずれなら起こし直せ」の助言が、生成元の外に書かれている。字面の生成元は' +
      'packages/core/src/usage-limits.ts の STALE_TOKEN_RESTART_ADVICE 1箇所である' +
      '（scripts/check-stale-token-restart-advice-core.mjs の doc、#1175）',
  },
  {
    name: 'restart-before-check-advice',
    cmd: 'pnpm',
    args: ['check:restart-before-check-advice'],
    hint:
      '「manager_start で起こし直す前に確かめろ」の助言が、生成元の外に書かれている。' +
      '字面の生成元は packages/core/src/usage-limits.ts の RESTART_BEFORE_CHECK_ADVICE / ' +
      'RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN 1箇所である' +
      '（scripts/check-restart-before-check-advice-core.mjs の doc、#1287）',
  },
  {
    name: 'no-env-passthrough',
    cmd: 'pnpm',
    args: ['check:no-env-passthrough'],
    hint:
      'テストのコードか変異試験ハーネスが、子プロセスへ親の process.env を丸ごと渡す形' +
      '（...process.env / env: process.env / Object.assign(…, process.env)）を書いている。' +
      '必要な鍵だけを明示的に組み立てる（gitChildEnv() / mutateCliChildEnv() 等）か、' +
      'わざとの場合は理由付きで scripts/check-no-env-passthrough-core.mjs の ALLOWLIST へ' +
      '載せること（scripts/check-no-env-passthrough-core.mjs の doc、Issue #1935 / #1854）',
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

// ── Issue #1191: 「範囲を絞った成功」を「全体の成功」として記録しない ──────

/**
 * `pnpm test` へ渡す引数のうち、**絞り込みにならないと分かっているもの**の許可リスト。
 * `{ flag, takesValue }` の並び。
 *
 * **これは許可リストであって拒否リストではない。** 理由は Issue #1191:
 * **知らない引数は「絞る」側へ倒す**——`classifyTestScope` が `narrowing` へ入れて
 * 記録しない側（＝安全側）にする。ここが腐って（vitest が新しいフラグを足して）
 * 見逃しても、帰結は「余分に一式を走らせる」だけで、**緑の側へは絶対に倒れない**。
 * 逆に拒否リストにすると、知らない引数が黙って「絞り込まない」側へ回り、
 * 実際には絞り込んでいるのに全体の成功として記録されうる——それは直そうと
 * している当の欠陥そのものである。
 *
 * 最小で始める。**vitest のフラグ全部を調べたわけではない**（Issue #1191
 * 「確かめていないこと」）。
 */
export const TEST_ARGS_THAT_DO_NOT_NARROW = [
  { flag: '--maxWorkers', takesValue: true },
  { flag: '--minWorkers', takesValue: true },
  { flag: '--reporter', takesValue: true },
  { flag: '--silent', takesValue: false },
  { flag: '--no-color', takesValue: false },
  { flag: '--color', takesValue: false },
];

/**
 * その要素が「フラグらしい」か。**値必須フラグの値として飲んでよいかの判定に
 * だけ使う**（Issue #1273）。
 *
 * `-` で始まるものはフラグとみなし、値として飲まない。**倒す向きは
 * `TEST_ARGS_THAT_DO_NOT_NARROW` の doc と同じ安全側である** —— 飲まなければ
 * その要素は許可リストと突き合わされ、載っていなければ `narrowing` へ入る。
 * 帰結は「余分に一式を走らせる」だけで、緑の側へは倒れない。
 *
 * ⚠️ **負の数を値に取るフラグが将来足されたら、この判定は安全側へ外す**
 * （`--maxWorkers -1` の `-1` をフラグとみなし、`narrowing` に入れて
 * `full: false` にする）。記録を余分に見送るだけなので害は無いが、**その形を
 * 実際に測ってはいない**——いま許可リストに在る6つに負の数を取るものは無い。
 *
 * 末尾（`undefined`）も「飲まない」側へ倒す。`--reporter` で引数列が終わる形で
 * あり、飲む値がそもそも存在しない。
 */
function isFlagLike(arg) {
  return arg === undefined || arg.startsWith('-');
}

/**
 * `pnpm test` へ渡る引数（`splitVerifyArgs` の `passthrough`）が、実行範囲を
 * **絞り込む形か**を判定する。
 *
 * **`--flag=値` は `=` の前で引く。** 値ありのフラグが `--flag 値` の形で単体で
 * 来たら、**次の要素も一緒に飛ばす**（`--maxWorkers 4` の `4` を、絞り込みの
 * パス指定と読み違えないため）。**ただし飛ばすのは `-` で始まらない要素だけで
 * ある**（`isFlagLike`。Issue #1273）——`--reporter --changed` の `--changed` は
 * 値ではなくフラグなので飲まず、`narrowing` へ残す。それ以外の引数はすべて
 * `narrowing` へ入る（テストファイルのパス・`-t`（名前フィルタ）・`--changed`・
 * `--bail` など）。
 *
 * `full = narrowing.length === 0`。**「絞り込みが実際に効いたか（vitest が
 * 実際に何本選んだか）は見ていない。** 見ているのは引数の**形**だけである**
 * ——`splitVerifyArgs` が引数の宛先を形だけで決めているのと同じ制約。
 */
export function classifyTestScope(passthrough) {
  const narrowing = [];
  for (let i = 0; i < passthrough.length; i += 1) {
    const arg = passthrough[i];
    const eqIdx = arg.indexOf('=');
    const head = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const known = TEST_ARGS_THAT_DO_NOT_NARROW.find((entry) => entry.flag === head);
    if (known === undefined) {
      narrowing.push(arg);
      continue;
    }
    // `--flag=値` の形は、この1要素で完結している（値を飛ばす必要が無い）。
    if (eqIdx !== -1) continue;
    // `--flag 値` の形（値ありで `=` を使っていない）。次の要素（値）も飛ばす。
    // **ただし飲むのは「値らしい」ものだけである**（Issue #1273）。次の要素が
    // `-` で始まるならそれはフラグであって値ではない、とみなして飲まない——
    // 飲むと `--reporter --changed` の `--changed` が消え、絞り込みが
    // `full: true` に化ける（`decideRecord` が「全体成功」を記録する）。
    if (known.takesValue && !isFlagLike(passthrough[i + 1])) i += 1;
  }
  return { full: narrowing.length === 0, narrowing };
}

/**
 * 全体の成功記録を書いてよいか。**判定はすべてここへ寄せる**
 * （このファイル冒頭 doc の方針どおり。`verify.mjs` は呼ぶだけにする）。
 *
 * 優先順（先に当たったものを返す）:
 * 1. `moved`（走行中にツリーが動いた） → `'tree-moved'`
 * 2. `!scope.full`（実行範囲を絞った） → `'narrowed'`（Issue #1191 の核心）
 * 3. `recordPath` が無い（置き場が取れない器） → `'no-record-path'`
 * 4. それ以外 → 記録してよい（`'ok'`）
 *
 * **`moved` を最優先にするのは意図である。** 絞り込んでいなくても、走行中に
 * 誰かがツリーを直していたら、それは「検証していないものを検証済みとして
 * 記録する」という、この一式がいちばん恐れている形である（`verify.mjs` の
 * 該当 doc と同じ理由）。
 */
export function decideRecord({ scope, moved, recordPath }) {
  if (moved) return { record: false, reason: 'tree-moved' };
  if (!scope.full) return { record: false, reason: 'narrowed', narrowing: scope.narrowing };
  if (recordPath === null || recordPath === undefined) {
    return { record: false, reason: 'no-record-path' };
  }
  return { record: true, reason: 'ok' };
}

/**
 * 書き込む記録そのものを組み立てる。**`at`（時刻）と `day`（日付）を同じ
 * `now` から作ることを1箇所で保証する**——2箇所で別々に `new Date()` を
 * 呼ぶと、ミリ秒単位でずれた `now` から作られた `at` と `day` が理論上
 * 矛盾しうる（`at` は昨日の23:59:59.999、`day` は今日、のような形）。
 *
 * `now` は引数で受ける（既定値だけが `new Date()` を呼ぶ）。純粋なロジック
 * （`decideRecord` 等）からは呼ばれない——`verify.mjs` が一式の終わりに
 * 一度だけ呼ぶ想定。
 *
 * **`tree`（Issue #1763・#1192 の N7）は任意である。** 渡さなければ（`undefined`）
 * 従来どおり `fingerprint` / `at` / `day` の3つだけの記録を返す——**既存の呼び出し
 * （`scripts/verify-core.test.ts` の `recordFor('abc123', now)` 等）を1文字も
 * 壊さない。** 渡した場合だけ `tree` を足す。`tree` が無い記録（旧形式）は
 * `pnpm check:verified-head` から見ると「判定できない」に倒れる
 * （`check-verified-head-core.mjs` の `compareVerifiedHead`）——`decideSkip` の
 * 「旧形式の記録も安全側（走る）へ倒す」と同じ向き。
 */
export function recordFor(fingerprint, now = new Date(), tree = undefined) {
  const record = { fingerprint, at: now.toISOString(), day: now.toISOString().slice(0, 10) };
  return tree === undefined ? record : { ...record, tree };
}
