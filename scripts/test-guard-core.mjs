/**
 * `test.mjs` の判定だけを切り出したもの（`verify.mjs` / `verify-core.mjs` と同じ分け方）。
 *
 * #311: `describe.skip` / `it.skip` で全部飛ばしても `pnpm test` が exit 0 のまま
 * 緑になる。直しは2枚に分かれている。
 *
 * - **歯A（実行の側）**: vitest の集計行（`Test Files` / `Tests`）を読み、
 *   `Tests` 行の passed が 0 なら赤くする。集計行そのものが出ていなければ、
 *   それは「1本も走らなかった」であって「1本も通らなかった」ではないので、
 *   別の文言で赤くする（`AGENTS.md`「『判定できない』という3つ目の状態を持つ」。
 *   2値にしない）。歯Aだけでは Issue の症状（1ファイルだけを `describe.skip` で
 *   丸ごと飛ばしても、他が passed なので `passed > 0` のまま）を捕まえられない。
 * - **歯B（ソースの側）**: root の `vitest.config.ts` の `include` に一致する
 *   全テストファイルを静的に走査し、**無条件の** `describe.skip` / `it.skip` /
 *   `test.skip`（`.skip.each` 等の派生を含む）を検出する。**条件付き
 *   （`skipIf` / `runIf` / 実行時の `ctx.skip()`）は対象外** — 正規表現が
 *   `describe.skip` の直後の文字境界を見るので、`describe.skipIf(...)` は
 *   そもそも一致しない（`skip` と `If` の間に単語境界が無い）。**歯Bも2値に
 *   しない** — 走査対象が0ファイルなら「無条件の skip が0件だった」ではなく
 *   「判定できない」（`EXIT_SCAN_EMPTY`）にする（`judgeStaticSkipScan`）。
 *
 * **この判定を vitest の中（テストや `setupFiles`）に置かない。** 置けば
 * `.skip` で判別器自身を黙らせられる。だから `test.mjs`（薄い CLI 層。vitest の
 * 外側の素の node プロセス）がここを呼ぶ形にしてある。**そして歯Bはすべての
 * テストファイルを走査するので、歯Bの単体テスト自身（`test-guard-core.test.ts`）が
 * `.skip` されたら歯Bが捕まえる。** 判別器が自分を守る形になっている。
 *
 * ## 変異試験ハーネスとの関係（実装前に実測して確定させたこと）
 *
 * `.claude/skills/mutation-testing/mutate-core.mjs` の `decideJudgementCategory` は
 * **`testResult.exitCode` を1文字も見ない**。生存/検出は `testsAllPassed`
 * （＝ `Test Files` / `Tests` の集計行の文字列に `passed` / `failed` が
 * 含まれるか）だけで決まる（`exitCode` はフィールドとして保持されるだけで、
 * `decideJudgementCategory` の本体では参照されていない）。**だからこの歯が
 * 追加する exit 1（歯A・「判定できない」・歯B）は、集計行の文字列を書き換え
 * ない限り「検出」に化けない。** `test.mjs` は vitest の生出力を一切改変せず
 * 素通しするので、集計行はいつも vitest 自身が出した本物のままである。
 * 実測は PR 本文へ添えてある。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `scripts/` の1つ上 ＝ リポジトリ根。`process.cwd()` に依存しない
 * （`pnpm --filter <pkg> test` では cwd がそのパッケージ配下になるため）。 */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 変異試験や本物のビルド成果物と同じ理由で、走査から外すもの。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router']);

// ── 歯A: 実行の側（vitest の集計行を読む） ──────────────────────────

/** vitest の生出力（stdout + stderr）から `Test Files` / `Tests` の集計行を取り出す。
 * どちらかが無ければ `null`（＝「判定できない」の材料）。 */
export function parseAggregateLines(rawOutput) {
  const filesLine = rawOutput.match(/^\s*Test Files\s+.+$/m)?.[0]?.trim() ?? null;
  const testsLine = rawOutput.match(/^\s*Tests\s+.+$/m)?.[0]?.trim() ?? null;
  return { filesLine, testsLine };
}

/** `Tests` 行から passed の件数を読む。`passed` という語自体が無ければ 0
 * （例: `Tests  1 skipped (1)` には `passed` が一度も出ない）。 */
export function parsePassedCount(testsLine) {
  if (testsLine === null) return 0;
  const m = testsLine.match(/(\d+)\s+passed/);
  return m ? Number(m[1]) : 0;
}

/** 歯A・「判定できない」用の exit code。vitest 自身の exit code（0/1）と
 * 混ざらないよう、vitest が exit 0 を返した後にだけこの分岐へ入る
 * （vitest が非0で落ちたときは、その exit code をそのまま返す。`test.mjs` 側）。 */
export const EXIT_ZERO_PASSED = 2;
export const EXIT_UNKNOWN = 3;
export const EXIT_STATIC_SKIP = 4;

/**
 * 歯Bの走査そのものが0ファイルしか読めなかったときの exit code。
 *
 * **マネージャーの追加の枷（依頼者経由）**: `include` の glob 展開に失敗した・
 * 走査の起点がずれた・`vitest.config.ts` を読めなかった等で対象が0件になると、
 * 「無条件の静的 skip が0件だった」と**同じ見た目**になる。前者は「見ていない」、
 * 後者は「見て、無かった」で、意味が違う（`AGENTS.md`「`grep` が静かに取りこぼす
 * 形」の `grep -c` が返す 0 と同じ形）。**混ぜない** — `EXIT_STATIC_SKIP` とも
 * `EXIT_UNKNOWN`（歯Aの集計行不在）とも別の exit code にする。
 */
export const EXIT_SCAN_EMPTY = 5;

/** 歯Aの判定そのもの。vitest が exit 0 を返した後に呼ぶ想定
 * （非0はそのまま伝播するので、ここには来ない）。 */
export function judgeExecution(rawOutput) {
  const { filesLine, testsLine } = parseAggregateLines(rawOutput);
  if (filesLine === null || testsLine === null) {
    return {
      ok: false,
      exitCode: EXIT_UNKNOWN,
      message: [
        'test-guard: 判定できない — vitest の集計行（Test Files / Tests）が出ていない。',
        '「1本も通らなかった」のか「1本も走らなかった」のかが区別できない。',
        '器が混雑していると vitest の fork pool が write EPIPE で死に、集計行そのものが',
        '出ないまま exit することがある（AGENTS.md「静かに失敗する道具」）。',
        '--maxWorkers を下げて取り直すこと。',
      ].join('\n'),
    };
  }
  const passed = parsePassedCount(testsLine);
  if (passed === 0) {
    return {
      ok: false,
      exitCode: EXIT_ZERO_PASSED,
      message: [
        `test-guard: 実行の側 — vitest の集計行に passed が無い、または 0 件だった: ${testsLine}`,
        '1本も実行されて成功したテストが無い。describe.skip / it.skip / test.skip で',
        '全部飛ばされていないか、フィルタが空になっていないかを確認すること。',
      ].join('\n'),
    };
  }
  return { ok: true, filesLine, testsLine, passed };
}

// ── 歯B: ソースの側（無条件の静的 skip を走査する） ──────────────────

/**
 * `describe.skip(` / `it.skip(` / `test.skip(` と、その `.each` 等の派生に一致する。
 *
 * **`skipIf` には一致しない。** 正規表現の `\.skip` の直後は `\b` を要求していない
 * かわりに `(\.\w+)?\s*\(` で「`.` + 識別子」または直接`(`のどちらかしか許さないため、
 * `skipIf` のように `skip` の直後に英数字が続く形（`\w+` に吸収されない位置に `I` が
 * 来る）は `(\.\w+)?` にも `\s*\(` にも一致しない。実際に `describe.skipIf(` は
 * 1件もヒットしない（`test-guard-core.test.ts` の歯で固定）。
 */
const SKIP_CALL_RE = /\b(describe|it|test)\.skip(\.\w+)?\s*\(/g;

/**
 * `files`（`{ path, content }` の配列）を走査し、無条件の静的 skip の箇所を返す。
 * ディスクを読まない — 合成した文字列でも試せる
 * （`AGENTS.md`「テストが書けない構造は、テストが無いのと同じ」）。
 */
export function findUnconditionalSkips(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      SKIP_CALL_RE.lastIndex = 0;
      let m;
      while ((m = SKIP_CALL_RE.exec(line)) !== null) {
        hits.push({
          path: file.path,
          line: i + 1,
          matched: m[0].replace(/\(\s*$/, ''),
        });
      }
    }
  }
  return hits;
}

/** 歯Bが落ちたときの文言。ファイル・行・見つかった形と、次の手を書く。 */
export function formatSkipGuardMessage(hits) {
  const lines = hits.map((h) => `  ${h.path}:${h.line}  ${h.matched}`);
  return [
    `test-guard: ソースの側 — 無条件の静的 skip が ${hits.length} 件見つかった:`,
    ...lines,
    '',
    '戻し忘れなら消す。意図的に止めたいなら skipIf で条件を書くか、消して Issue にする。',
  ].join('\n');
}

/**
 * 歯Bの最終判定。**「0ファイルを読んだ」と「読んで、無条件の skip が0件だった」を
 * 混ぜない**（上の `EXIT_SCAN_EMPTY` の doc）。ディスクを読まない純粋関数 —
 * `matchedPaths` / `hits` を合成しても試せる。
 *
 * 3値: `matchedPaths.length === 0` → 判定できない（`EXIT_SCAN_EMPTY`) /
 * `hits.length > 0` → 検出（`EXIT_STATIC_SKIP`) / それ以外 → 合格。
 */
export function judgeStaticSkipScan(matchedPaths, hits) {
  if (matchedPaths.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message: [
        'test-guard: 判定できない — 歯Bの走査対象が0ファイルだった。',
        'root の vitest.config.ts の include に一致するテストファイルが1件も見つからない。',
        'include の glob 展開に失敗した、走査の起点（ROOT）がずれた、などが疑われる。',
        '「無条件の静的 skip が0件だった」と同じ見た目になるが、別の状態である',
        '（見て0件だったのではなく、見ていない）。',
      ].join('\n'),
    };
  }
  if (hits.length > 0) {
    return { ok: false, exitCode: EXIT_STATIC_SKIP, message: formatSkipGuardMessage(hits) };
  }
  return { ok: true, scanned: matchedPaths.length };
}

// ── I/O: include globs の読み取りとファイル走査 ──────────────────────

/**
 * root の `vitest.config.ts` を直接 `import` し、`test.include` を読む。
 * **書き写さない** — `scripts/workspace-test-scripts.test.ts` と同じ理由で、
 * 二重管理はずれる。この repo の node（22.23 系、`mise.toml`）は `.ts` の型
 * ストリッピングを素で解決できるので、ビルドを挟まずに読める（実測済み）。
 */
export async function readIncludeGlobs(root = ROOT) {
  const configPath = path.join(root, 'vitest.config.ts');
  const mod = await import(pathToFileURL(configPath).href);
  return mod.default.test.include;
}

function collectFiles(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, root, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/** repo 全体を走査し、`includeGlobs` に一致するファイルの相対パス（`/` 区切り）を返す。 */
export function collectMatchingTestFiles(root, includeGlobs) {
  const all = [];
  collectFiles(root, root, all);
  return all.filter((f) => includeGlobs.some((g) => path.matchesGlob(f, g)));
}

/** 相対パスの配列を `{ path, content }` へ読み込む（`findUnconditionalSkips` の入力形）。 */
export function readFilesForScan(root, relPaths) {
  return relPaths.map((p) => ({ path: p, content: readFileSync(path.join(root, p), 'utf8') }));
}

/**
 * 歯Bを実際に1回分回す（I/O込みの薄い合成）。`test.mjs` はこれを呼ぶだけにする。
 *
 * `readIncludeGlobs` が例外を投げた場合・`include` が配列でない/空だった場合も
 * `judgeStaticSkipScan([], [])` と同じ「判定できない」（`EXIT_SCAN_EMPTY`）へ倒す
 * ——「見ていない」の入口を1つに絞る。
 */
export async function runStaticSkipGuard(root = ROOT) {
  let includeGlobs;
  try {
    includeGlobs = await readIncludeGlobs(root);
  } catch (err) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message:
        `test-guard: 判定できない — root の vitest.config.ts から include を読めなかった: ` +
        `${err?.message ?? err}`,
    };
  }
  if (!Array.isArray(includeGlobs) || includeGlobs.length === 0) {
    return {
      ok: false,
      exitCode: EXIT_SCAN_EMPTY,
      message:
        'test-guard: 判定できない — vitest.config.ts の test.include が配列でない、または空だった。',
    };
  }
  const matchedPaths = collectMatchingTestFiles(root, includeGlobs);
  const files = readFilesForScan(root, matchedPaths);
  const hits = findUnconditionalSkips(files);
  return judgeStaticSkipScan(matchedPaths, hits);
}
