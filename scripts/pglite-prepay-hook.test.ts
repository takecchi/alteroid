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
 *   `createMigratedTestDb(` / `createEmptyTestDb(`（#2937。環境変数なしでは PGlite の雛形を使う）、`new PGlite(`、`migrate(`（直呼び。`db.migrate(` のような `.` 付きは除く）のどれかが在る
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
  /(?<![.\w])(?:createMigratedPglite|createMigratedTestDb|createEmptyTestDb)\(|(?<![.\w])new\s+PGlite\(|(?<![.\w])migrate\(/;
const HAS_PREPAY = /(?<![.\w])(?:beforeAll|beforeEach)\(/;
/** 理由（全角・半角どちらの括弧でも、中身が空白だけでないこと）が要る。 */
const OPT_OUT = /^[ \t]*\/\/[ \t]*pglite-prepay:[ \t]*not-needed[（(][ \t]*[^\s）)][^）)]*[）)]/m;

/**
 * **packages/storage-pg は `beforeEach` を前払いと数えない**（#3034）。`beforeEach` が払うのは
 * hookTimeout（既定 10000ms）の中で、混んだ器では最初の1回が 12〜16 秒かかって落ちた。
 * 前払いと数えるのは `beforeAll(` か、`test-db.test-support.js` の import（その補助が
 * ファイル先頭の `beforeAll` で雛形を前払いする。下の「補助が前払いを持つ」が縛る）。
 */
const STORAGE_PG_TEST = /^packages\/storage-pg\/src\//;
const HAS_BEFORE_ALL = /(?<![.\w])beforeAll\(/;
const IMPORTS_PREPAYING_SUPPORT = /from\s+'\.\/test-db\.test-support\.js'/;

type Verdict = 'uses-with-prepay' | 'uses-without-prepay' | 'opted-out' | 'no-use';

function judgePglitePrepay(src: string, file = ''): Verdict {
  const code = stripCommentsAndStrings(src);
  if (!USES_TEMPLATE.test(code)) return 'no-use';
  if (OPT_OUT.test(src)) return 'opted-out';
  if (STORAGE_PG_TEST.test(file)) {
    return HAS_BEFORE_ALL.test(code) || IMPORTS_PREPAYING_SUPPORT.test(src)
      ? 'uses-with-prepay'
      : 'uses-without-prepay';
  }
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

describe('storage-pg の判定（beforeEach だけでは前払いと数えない。#3034）', () => {
  const FILE = 'packages/storage-pg/src/x.test.ts';

  it('beforeEach だけで createMigratedTestDb を使うファイルは落とす（他のパッケージは従来どおり通す）', () => {
    const src = `beforeEach(async () => { await createMigratedTestDb(); });`;
    expect(judgePglitePrepay(src, FILE)).toBe('uses-without-prepay');
    expect(judgePglitePrepay(src, 'apps/daemon/src/x.test.ts')).toBe('uses-with-prepay');
  });

  it('beforeAll か、前払いを持つ補助の import があれば通る', () => {
    expect(
      judgePglitePrepay(`beforeAll(async () => {});\nawait createMigratedTestDb();`, FILE),
    ).toBe('uses-with-prepay');
    expect(
      judgePglitePrepay(
        `import { createMigratedTestDb } from './test-db.test-support.js';\nbeforeEach(async () => { await createMigratedTestDb(); });`,
        FILE,
      ),
    ).toBe('uses-with-prepay');
  });
});

describe('補助が前払いを持つ（packages/storage-pg/src/test-db.test-support.ts。#3034）', () => {
  const code = stripCommentsAndStrings(
    readFileSync(path.join(ROOT, 'packages/storage-pg/src/test-db.test-support.ts'), 'utf8'),
  );

  it('ファイル先頭（行頭）の beforeAll が、雛形を作る（PGlite は migratedTemplate、本物は ensureTemplate）', () => {
    const match = /^beforeAll\(async \(\) => \{([\s\S]*?)^\}, ([\w]+)\);/m.exec(code);
    expect(
      match,
      'test-db.test-support.ts に行頭の beforeAll(async () => {...}, <枠>) が無い',
    ).not.toBeNull();
    expect(match![1]).toMatch(/migratedTemplate\(\)/);
    expect(match![1]).toMatch(/ensureTemplate\(/);
  });

  it('枠は hookTimeout の既定（10000ms）より大きい', () => {
    const src = readFileSync(
      path.join(ROOT, 'packages/storage-pg/src/test-db.test-support.ts'),
      'utf8',
    );
    const m = /TEMPLATE_PREPAY_TIMEOUT_MS = ([\d_]+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1]!.replaceAll('_', ''))).toBeGreaterThanOrEqual(30_000);
  });
});

describe('実際のテストファイルの走査', () => {
  const files = collectRepoFiles(ROOT, EXCLUDE_DIRS).filter((f) => TARGET.test(f));
  const verdicts = files.map((file) => ({
    file,
    verdict: judgePglitePrepay(readFileSync(path.join(ROOT, file), 'utf8'), file),
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
        'PGlite の雛形（createMigratedPglite( / createMigratedTestDb( / createEmptyTestDb( / new PGlite( / migrate( の直呼び）を使うのに、',
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
