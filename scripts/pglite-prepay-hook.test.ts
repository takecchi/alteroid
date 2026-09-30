import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';

/**
 * **PGlite の雛形を使うテストファイルに、雛形作りの前払い（`beforeAll` / `beforeEach`）が
 * あるかを見る歯**（#2360 → PR #2364、#2378 → PR #2384。先例は #2339 / #2364 / #2384）。
 *
 * ## 何を防ぐか
 *
 * ワーカーの中で最初に PGlite の雛形（WASM の起動 + migrate）を作る歯が、その費用を歯の
 * 本体（既定 5000ms）で払って時間切れになる。同じ揺れが2回続いた。直し方の先例は、ファイル
 * 先頭（`describe` の外）に
 *
 * ```ts
 * beforeAll(async () => {
 *   await migratedTemplate();
 * }, 30_000);
 * ```
 *
 * を置く形。新しい pg のテストを足すたびにこの hook が忘れられて落ちるので、`pnpm test` の
 * 中で忘れを止める。新しい workflow / job は足さない（#1470）。
 *
 * ## 判定
 *
 * 対象は `apps/*` / `packages/*` の `src/` 以下の `*.test.ts` / `*.test.tsx`
 * （`*.test-support.ts` と本番コードは対象外）。
 *
 * - 「雛形を使う」: コメントと文字列リテラルを除いた本文に、`createMigratedPglite(`、
 *   `new PGlite(`、`migrate(`（直呼び。`db.migrate(` のような `.` 付きは除く）のどれかが在る
 * - 「前払いがある」: 同じく除いた本文に `beforeAll(` か `beforeEach(` の呼び出しが在る
 * - 使うのに前払いが無いファイルを落とす
 * - 除外: ファイルのどこかに、行頭から `// pglite-prepay: not-needed（理由）` の1行を書く。
 *   **理由（括弧の中身）が空だと効かない**（理由の無い除外は、忘れと見分けがつかないため）
 *
 * ## 限界（測っていないもの）
 *
 * - **`beforeEach` が雛形の費用を実際に払うかは見ない。** 呼び出しが在れば通す。先例の線引き
 *   （`beforeEach` を持つファイルは最初の hook =枠 10000ms が払うので対象外）に従っている。
 *   `beforeEach` の中身が pg と無関係でも、`beforeAll` が雛形を温めない別の処理でも通る
 * - **hook の枠（30_000）や `migratedTemplate()` を呼んでいるかも見ない**
 * - 「使う」の判定は字面。`migrate(` という名前の別の関数を呼ぶだけのファイルも当たる
 *   （偽陽性。除外の印で外す）。別名 import や間接呼び（他ファイルの helper 経由）は当たらない
 *   （偽陰性）
 * - コメント・文字列の除去は簡易の字句走査で、正規表現リテラルや、`${}` の中に文字列を
 *   持つ入れ子のテンプレートリテラルは正確には扱わない
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

/** apps/<name>/src/**\/*.test.ts(x) と packages/<name>/src/**\/*.test.ts(x) */
const TARGET = /^(?:apps|packages)\/[^/]+\/src\/.+\.test\.tsx?$/;

/**
 * コメント（行・ブロック）と文字列リテラルの中身を空白に置き換える。改行は残す。
 * 文字列の引用符自体は残す（`'...'` の形は保つ）。
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += quote;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '\n') {
          // 単引用・二重引用は行で閉じる（閉じ忘れで以降を飲み込まない）。テンプレートは跨ぐ
          if (quote !== '`') break;
          out += '\n';
        }
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const USES_TEMPLATE =
  /(?<![.\w])createMigratedPglite\(|(?<![.\w])new\s+PGlite\(|(?<![.\w])migrate\(/;
const HAS_PREPAY = /(?<![.\w])(?:beforeAll|beforeEach)\(/;
/** 理由（全角・半角どちらの括弧でも、中身が空白だけでないこと）が要る。 */
const OPT_OUT = /^[ \t]*\/\/[ \t]*pglite-prepay:[ \t]*not-needed[（(][ \t]*[^\s）)][^）)]*[）)]/m;

type Verdict = 'uses-with-prepay' | 'uses-without-prepay' | 'opted-out' | 'no-use';

function judgePglitePrepay(src: string): Verdict {
  const code = stripCommentsAndStrings(src);
  if (!USES_TEMPLATE.test(code)) return 'no-use';
  if (OPT_OUT.test(src)) return 'opted-out';
  return HAS_PREPAY.test(code) ? 'uses-with-prepay' : 'uses-without-prepay';
}

describe('judgePglitePrepay（判定そのもの。合成した文字列で測る）', () => {
  const HOOK = 'beforeAll(async () => { await migratedTemplate(); }, 30_000);';

  it('createMigratedPglite を使い、前払いが無ければ落とす側', () => {
    expect(judgePglitePrepay(`const x = await createMigratedPglite();`)).toBe(
      'uses-without-prepay',
    );
  });

  it('new PGlite( と migrate( の直呼びも「使う」', () => {
    expect(judgePglitePrepay(`const c = new PGlite();`)).toBe('uses-without-prepay');
    expect(judgePglitePrepay(`await migrate(db);`)).toBe('uses-without-prepay');
  });

  it('beforeAll があれば通る。beforeEach でも通る（先例の線引き）', () => {
    expect(judgePglitePrepay(`${HOOK}\nawait createMigratedPglite();`)).toBe('uses-with-prepay');
    expect(judgePglitePrepay(`beforeEach(async () => {});\nnew PGlite();`)).toBe(
      'uses-with-prepay',
    );
  });

  it('コメントの字面だけでは「使う」に当たらない（行・ブロック）', () => {
    expect(judgePglitePrepay(`// createMigratedPglite() を使う\n`)).toBe('no-use');
    expect(judgePglitePrepay(`/* new PGlite() と\n migrate(db) */\nconst a = 1;`)).toBe('no-use');
  });

  it('文字列の字面だけでも「使う」に当たらない', () => {
    expect(judgePglitePrepay(`const s = 'createMigratedPglite(';`)).toBe('no-use');
    expect(judgePglitePrepay('const s = `new PGlite(`;')).toBe('no-use');
  });

  it('コメントの中の beforeAll では前払いを名乗れない', () => {
    expect(judgePglitePrepay(`// beforeAll( で温める\nawait createMigratedPglite();`)).toBe(
      'uses-without-prepay',
    );
  });

  it('文字列の中の // をコメントと取り違えない（以降の本文を落とさない）', () => {
    expect(judgePglitePrepay(`const u = 'http://x';\nawait createMigratedPglite();`)).toBe(
      'uses-without-prepay',
    );
  });

  it('db.migrate( のような . 付きや、別名の一部は「使う」に当たらない', () => {
    expect(judgePglitePrepay(`await db.migrate(x);`)).toBe('no-use');
    expect(judgePglitePrepay(`await runmigrate(x);`)).toBe('no-use');
  });

  it('除外の印は理由があるときだけ効く', () => {
    const body = `await createMigratedPglite();`;
    expect(
      judgePglitePrepay(`// pglite-prepay: not-needed（1本だけで hook を足すと逆に遅い）\n${body}`),
    ).toBe('opted-out');
    expect(judgePglitePrepay(`// pglite-prepay: not-needed(reason)\n${body}`)).toBe('opted-out');
    expect(judgePglitePrepay(`// pglite-prepay: not-needed\n${body}`)).toBe('uses-without-prepay');
    expect(judgePglitePrepay(`// pglite-prepay: not-needed（ ）\n${body}`)).toBe(
      'uses-without-prepay',
    );
    expect(judgePglitePrepay(`// pglite-prepay: not-needed（）\n${body}`)).toBe(
      'uses-without-prepay',
    );
  });
});

describe('実際のテストファイルの走査', () => {
  const files = collectRepoFiles(ROOT, EXCLUDE_DIRS).filter((f) => TARGET.test(f));
  const verdicts = files.map((file) => ({
    file,
    verdict: judgePglitePrepay(readFileSync(path.join(ROOT, file), 'utf8')),
  }));
  const users = verdicts.filter((v) => v.verdict !== 'no-use');

  it('走査した数と「雛形を使う」と判定した数が下限を下回らない（空の走査で緑にならない）', () => {
    // 下限は実測より少し低く置く（テストが減っても崩れない程度、空の走査は確実に止める）。
    expect(files.length).toBeGreaterThanOrEqual(400);
    expect(users.length).toBeGreaterThanOrEqual(40);
    // 判定の三つ組が全部現れる: 前払い付きが1本も無ければ「使う」の判定が壊れている
    expect(users.some((v) => v.verdict === 'uses-with-prepay')).toBe(true);
  });

  it('雛形を使うテストファイルは、beforeAll / beforeEach で前払いしている', () => {
    const offenders = verdicts
      .filter((v) => v.verdict === 'uses-without-prepay')
      .map((v) => v.file);
    expect(
      offenders,
      [
        '',
        'PGlite の雛形（createMigratedPglite( / new PGlite( / migrate( の直呼び）を使うのに、',
        'beforeAll / beforeEach による前払いが無いテストファイルがある:',
        ...offenders.map((f) => `  - ${f}`),
        '',
        '最初に雛形を作る歯が、WASM の起動 + migrate を歯の本体（既定 5000ms）で払って時間切れになる',
        '（#2360 → PR #2364、#2378 → PR #2384。先例 #2339 / #2364 / #2384）。',
        '足す形（ファイル先頭、describe の外）:',
        '',
        "  import { beforeAll } from 'vitest';",
        "  import { migratedTemplate } from './pglite-template.test-support.js';",
        '',
        '  beforeAll(async () => {',
        '    await migratedTemplate();',
        '  }, 30_000);',
        '',
        '（packages/storage-pg/src では同じ名前の補助が packages/storage-pg/src/pglite-template.test-support.ts に在る）',
        '',
        '本当に要らないときは、ファイルのどこかに行頭から次の1行を書いて外す（理由が空だと効かない）:',
        '',
        '  // pglite-prepay: not-needed（理由）',
        '',
        '限界: このテストは beforeAll / beforeEach の呼び出しが在るかだけを見る（中身が費用を払うかは見ない）。',
        '',
      ].join('\n'),
    ).toEqual([]);
  });
});
