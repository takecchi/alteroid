/**
 * `check-dockerfile-railway.mjs` の判定だけを切り出したもの（Issue #2685）。
 *
 * ## 何を塞ぐために在るか
 *
 * #2678 で Dockerfile に `RUN --mount=type=bind,...` を入れた。CI の `image`
 * ジョブ（buildx / BuildKit）は緑だったが、Railway の3環境は開始から約13秒で
 * failure になり、#2683 で `COPY` に替えて通った。**CI が緑でも Railway で通る
 * 保証にならない** ——ビルダが違うのではなく、Railway がビルドの前に `--mount` を
 * 自前で検査しているため、buildx をどの版で焼いても再現しない。
 *
 * ## 規則（根拠のあるものだけ）
 *
 * **`RUN` 命令の `--mount`（type は問わない）を禁止する。**
 *
 * 根拠（どちらも Railway 側の発言・文書で、**ビルドログは誰も見ていない**。
 * 原因の確定ではなく強い間接証拠である）:
 *
 * - Railway 社員 brody「railway does not support bind mounts.」（2024-09-02、
 *   https://station.railway.com/questions/cache-mounts-must-be-in-the-format-mou-b5bbf3a2 ）。
 *   そのときのエラー文は「Cache mounts MUST be in the format --mount=type=cache,id=...」。
 * - 公式 https://docs.railway.com/builds/dockerfiles ：cache mount は
 *   `id=s/<service id>-<target path>` の形だけが許され、id に変数は使えない。
 *   この repo は Railway の3環境（service ID が別々）で同じ Dockerfile を焼くので、
 *   cache mount も事実上書けない。
 *
 * ## 禁止していないもの（不明なので入れていない。Railway で落ちたら、ここに足す）
 *
 * heredoc（`RUN <<EOF`）・`# syntax=` 行・`COPY --link` など、Railway の対応が
 * 公開情報では分からない書き方。**根拠の無い規則は入れない**（入れると、本当に
 * 通る書き方まで止める）。落ちた事実が出たら、その書き方をここへ足す。
 *
 * ## 命令の単位で見る
 *
 * 行ではなく命令で読む:
 *
 * - 行継続（`\`。`# escape=` 行で指定した文字も）で続く行を1命令として扱う。
 *   `--mount` が継続行に在っても拾う。
 * - 命令名の大小文字は無視する（`run`）。`ONBUILD RUN` も見る。
 * - コメント行は読まない。継続の途中のコメント行・空行は Docker と同じく飛ばす。
 * - **`RUN` のフラグ位置だけを見る。** `RUN` の直後から、`--` で始まる語が続く間が
 *   フラグで、最初の `--` で始まらない語からはシェル本文。本文に `--mount` という
 *   字面（例: `echo --mount`、`mount --bind`）が在っても誤検知しない。
 * - **迷ったら検知する側に倒す**: フラグ名は大小文字を無視し、`--mount=...` も
 *   `--mount` 単独（値が次の語）も拾う。heredoc の本文は専用の解析をせず、
 *   本文の行が命令に見えるならそのまま命令として読む（本文を読み飛ばす解析の
 *   誤りで見逃すより、まれな誤検知のほうが安い）。
 *
 * ## 対象
 *
 * - git が追跡している（`git ls-files`）Dockerfile 全部: 名前が `Dockerfile`、
 *   `Dockerfile.*`、`*.Dockerfile`、`*.dockerfile`（大小文字は無視）。
 * - `railway/*.json` の `build.dockerfilePath` が指すファイル（repo ルートからの相対）。
 *   読めない・JSON として壊れている・指す先が無いときは、**緑にせず赤くする**
 *   （fail-closed。検査できなかったものを「問題なし」と言わない）。
 */

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

/** 失敗時に必ず出す理由。出典 URL と、#2683 での直し方を含む。 */
export const REASON =
  'Railway は RUN --mount を受け付けない（Railway のビルドが約13秒で落ちる。#2678 → #2683。' +
  'https://station.railway.com/questions/cache-mounts-must-be-in-the-format-mou-b5bbf3a2 、' +
  'https://docs.railway.com/builds/dockerfiles ）。' +
  '#2683 では COPY で入れて、同じ RUN の中で消した';

const DEFAULT_ESCAPE = '\\';

/** `# escape=X` / `# escape = X` の構文指令。先頭の指令ブロックの中だけで効く。 */
function readEscapeDirective(lines) {
  for (const line of lines) {
    const m = /^\s*#\s*([A-Za-z][\w-]*)\s*=\s*(\S+)\s*$/.exec(line);
    if (m === null) break; // 指令ブロックは最初の非指令行（コメント・空行・命令）で終わる
    if (m[1].toLowerCase() === 'escape' && (m[2] === '\\' || m[2] === '`')) return m[2];
  }
  return DEFAULT_ESCAPE;
}

/**
 * Dockerfile を命令に切る。各命令は `{ pieces: [{ line, text }] }`（`line` は1始まりの
 * 物理行番号。`text` は継続文字を落とした行の中身）。
 */
export function splitInstructions(content) {
  const lines = content.split(/\r?\n/);
  const escape = readEscapeDirective(lines);
  const instructions = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    // コメント行は、継続の途中でも命令の前でも飛ばす。
    if (trimmed.startsWith('#')) continue;
    if (trimmed === '') continue; // 継続の途中の空行は飛ばす。命令の前なら元々何も無い

    const continues = trimmed.endsWith(escape);
    const text = continues ? trimmed.slice(0, -1) : trimmed;
    if (current === null) current = { pieces: [] };
    current.pieces.push({ line: i + 1, text });
    if (!continues) {
      instructions.push(current);
      current = null;
    }
  }
  // 末尾が継続のまま終わった命令も、捨てずに読む。
  if (current !== null) instructions.push(current);
  return { instructions, escape };
}

/**
 * 1ファイル分の中身から `RUN --mount` を探す。
 * @returns {{ line: number, text: string, flag: string }[]}
 */
export function findRunMounts(content) {
  const lines = content.split(/\r?\n/);
  const { instructions } = splitInstructions(content);
  const hits = [];

  for (const ins of instructions) {
    const tokens = [];
    for (const piece of ins.pieces) {
      for (const word of piece.text.split(/\s+/)) {
        if (word !== '') tokens.push({ word, line: piece.line });
      }
    }
    let at = 0;
    if (tokens[at]?.word.toLowerCase() === 'onbuild') at++;
    if (tokens[at]?.word.toLowerCase() !== 'run') continue;
    at++;
    for (; at < tokens.length; at++) {
      const { word, line } = tokens[at];
      if (!word.startsWith('--')) break; // ここから先はシェル本文（またはJSON形式）
      if (/^--mount(=|$)/i.test(word)) {
        hits.push({ line, text: lines[line - 1], flag: word });
      }
    }
  }
  return hits;
}

/** Dockerfile らしい名前か（パスの末尾の要素で見る）。 */
export function isDockerfileName(path) {
  const base = path.split('/').pop() ?? '';
  return /^dockerfile(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base);
}

/** `railway/*.json` の中身から `build.dockerfilePath` を取る。無ければ `null`。壊れていれば投げる。 */
export function readDockerfilePath(jsonText) {
  const parsed = JSON.parse(jsonText);
  const p = parsed?.build?.dockerfilePath;
  return typeof p === 'string' && p !== '' ? p.replace(/^\.\//, '') : null;
}

/**
 * 検査の対象（Dockerfile のパス）と、対象を決められなかった理由を返す。
 * @param {string} root
 * @param {{ readFile: (path: string) => string, exists: (path: string) => boolean }} io
 */
export function collectTargets(root, io) {
  const tracked = listGitScannableFiles({ cwd: root });
  const targets = new Map(); // path -> 出所
  const problems = [];

  for (const path of tracked.filter(isDockerfileName)) {
    if (io.exists(path)) targets.set(path, 'git が追跡している Dockerfile');
  }

  for (const path of tracked.filter((p) => /^railway\/.*\.json$/.test(p))) {
    if (!io.exists(path)) continue;
    let dockerfilePath;
    try {
      dockerfilePath = readDockerfilePath(io.readFile(path));
    } catch (error) {
      problems.push({ path, message: `JSON として読めない: ${error}` });
      continue;
    }
    if (dockerfilePath === null) continue;
    if (!io.exists(dockerfilePath)) {
      problems.push({
        path,
        message: `build.dockerfilePath が指す ${dockerfilePath} が無い`,
      });
      continue;
    }
    if (!targets.has(dockerfilePath))
      targets.set(dockerfilePath, `${path} の build.dockerfilePath`);
  }
  return { targets, problems };
}

/** 本物の git ファイル一覧は使わず、渡された一覧と中身で全体を判定する（テスト用の入口）。 */
export function evaluateFiles(files) {
  const violations = [];
  for (const { path, content } of files) {
    for (const hit of findRunMounts(content)) violations.push({ path, ...hit });
  }
  return violations;
}

/** 失敗時の出力。ファイル名・行番号・該当行・理由。 */
export function formatViolations(violations) {
  const out = [`check-dockerfile-railway: NG — RUN --mount が ${violations.length}件ある:`];
  for (const v of violations) {
    out.push(`  ${v.path}:${v.line}: ${v.text.trim()}`);
  }
  out.push(`理由: ${REASON}`);
  return out.join('\n');
}
