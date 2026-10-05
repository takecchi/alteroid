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
 * - 「前払いがある」: 同じく除いた本文に `beforeAll(` の呼び出しが在る。**`beforeEach(` は
 *   どのパッケージでも前払いと数えない**（#3034。storage-pg は PR #3035、apps/daemon 以下は
 *   その続き）。packages/storage-pg/src に限り、`./test-db.test-support.js` の import も
 *   前払いと数える（その補助がファイル先頭の `beforeAll` で雛形を前払いする）
 * - 使うのに前払いが無いファイルを落とす
 * - 除外: ファイルのどこかに、行頭から `// pglite-prepay: not-needed（理由）` の1行を書く。
 *   **理由（括弧の中身）が空だと効かない**（理由の無い除外は、忘れと見分けがつかないため）
 *
 * ## 限界（測っていないもの）
 *
 * - **`beforeAll` が雛形の費用を実際に払うかは見ない。** 呼び出しが在れば通す。`beforeAll` が
 *   雛形を温めない別の処理でも通る
 * - （経緯）以前は先例の線引き（`beforeEach` を持つファイルは最初の hook =枠 10000ms が払うので
 *   対象外）に従い、`beforeEach(` も前払いと数えていた。混んだ器ではその最初の1回が
 *   12〜16 秒かかって落ちた（#3034）。PR #3035 で storage-pg だけ数えなくし、apps/daemon に
 *   同じ形の漏れが4本残っていたので、全パッケージで数えなくした
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
/** 理由（全角・半角どちらの括弧でも、中身が空白だけでないこと）が要る。 */
const OPT_OUT = /^[ \t]*\/\/[ \t]*pglite-prepay:[ \t]*not-needed[（(][ \t]*[^\s）)][^）)]*[）)]/m;

/**
 * **`beforeEach` はどのパッケージでも前払いと数えない**（#3034）。`beforeEach` が払うのは
 * hookTimeout（既定 10000ms）の中で、混んだ器では最初の1回が 12〜16 秒かかって落ちた。
 * PR #3035 は storage-pg だけを縛り、apps/daemon に `beforeEach` だけのファイルが4本漏れて
 * いた（`commitment-unreadable-recovery-2148` / `practice-unreadable-recovery-2011` /
 * `practice-version-unreadable-2177` / `practice-versions-slug-pg-1670`）。
 * 前払いと数えるのは `beforeAll(` か、packages/storage-pg/src に限り
 * `test-db.test-support.js` の import（その補助がファイル先頭の `beforeAll` で雛形を前払い
 * する。下の「補助が前払いを持つ」が縛る）。
 */
const STORAGE_PG_TEST = /^packages\/storage-pg\/src\//;
const HAS_BEFORE_ALL = /(?<![.\w])beforeAll\(/;
const IMPORTS_PREPAYING_SUPPORT = /from\s+'\.\/test-db\.test-support\.js'/;

type Verdict = 'uses-with-prepay' | 'uses-without-prepay' | 'opted-out' | 'no-use';

function judgePglitePrepay(src: string, file = ''): Verdict {
  const code = stripCommentsAndStrings(src);
  if (!USES_TEMPLATE.test(code)) return 'no-use';
  if (OPT_OUT.test(src)) return 'opted-out';
  if (HAS_BEFORE_ALL.test(code)) return 'uses-with-prepay';
  if (STORAGE_PG_TEST.test(file) && IMPORTS_PREPAYING_SUPPORT.test(src)) return 'uses-with-prepay';
  return 'uses-without-prepay';
}

/** 走査の結果から、前払いを負っていないファイルを拾う（実走査と陰性対照の両方が通る1本の道）。 */
function findOffenders(entries: readonly { file: string; src: string }[]): string[] {
  return entries
    .filter(({ file, src }) => judgePglitePrepay(src, file) === 'uses-without-prepay')
    .map(({ file }) => file)
    .sort();
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

  // 経緯: 元は「beforeEach でも通る（先例の線引き）」として uses-with-prepay を期待していた。
  // #3034 で beforeEach は前払いと数えなくなった（storage-pg は PR #3035、全パッケージはその続き）
  // ので、期待を反転した。
  it('beforeAll があれば通る。beforeEach だけでは通らない（#3034）', () => {
    expect(judgePglitePrepay(`${HOOK}\nawait createMigratedPglite();`)).toBe('uses-with-prepay');
    expect(judgePglitePrepay(`beforeEach(async () => {});\nnew PGlite();`)).toBe(
      'uses-without-prepay',
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

describe('パッケージごとの判定（beforeEach だけでは前払いと数えない。#3034）', () => {
  const FILE = 'packages/storage-pg/src/x.test.ts';

  // 経緯: PR #3035 では「他のパッケージは従来どおり通す」として apps/daemon に uses-with-prepay を
  // 期待していた。その線の外に apps/daemon の漏れが4本残っていたので、全パッケージで落とす側へ反転した。
  it('beforeEach だけで雛形を使うファイルは、どのパッケージでも落とす', () => {
    const src = `beforeEach(async () => { await createMigratedTestDb(); });`;
    expect(judgePglitePrepay(src, FILE)).toBe('uses-without-prepay');
    expect(judgePglitePrepay(src, 'apps/daemon/src/x.test.ts')).toBe('uses-without-prepay');
    expect(
      judgePglitePrepay(
        `beforeEach(async () => { ({ db } = await createMigratedPglite()); });`,
        'apps/daemon/src/x.test.ts',
      ),
    ).toBe('uses-without-prepay');
  });

  it('test-db.test-support.js の import を前払いと数えるのは storage-pg だけ（その補助が前払いを持つのは storage-pg だけ）', () => {
    const src = `import { createMigratedTestDb } from './test-db.test-support.js';\nbeforeEach(async () => { await createMigratedTestDb(); });`;
    expect(judgePglitePrepay(src, FILE)).toBe('uses-with-prepay');
    expect(judgePglitePrepay(src, 'apps/daemon/src/x.test.ts')).toBe('uses-without-prepay');
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
  const entries = files.map((file) => ({ file, src: readFileSync(path.join(ROOT, file), 'utf8') }));
  const verdicts = entries.map(({ file, src }) => ({
    file,
    verdict: judgePglitePrepay(src, file),
  }));
  const users = verdicts.filter((v) => v.verdict !== 'no-use');
  const offenders = findOffenders(entries);

  it('走査した数と「雛形を使う」と判定した数が下限を下回らない（空の走査で緑にならない）', () => {
    // 下限は実測より少し低く置く（テストが減っても崩れない程度、空の走査は確実に止める）。
    expect(files.length).toBeGreaterThanOrEqual(400);
    expect(users.length).toBeGreaterThanOrEqual(40);
    // 判定の三つ組が全部現れる: 前払い付きが1本も無ければ「使う」の判定が壊れている
    expect(users.some((v) => v.verdict === 'uses-with-prepay')).toBe(true);
    // apps/daemon も走査に入っている（#3034 の漏れはここに在った）
    expect(
      users.filter((v) => v.file.startsWith('apps/daemon/src/')).length,
    ).toBeGreaterThanOrEqual(20);
  });

  /**
   * **陰性対照**（#3034）。実在のファイルを1本だけ「前払いを負っていない」形
   * （`beforeAll(` → `beforeEach(`。今回漏れていた形そのもの）へ書き換えて同じ道に通し、
   * そのファイルが、そのファイルだけが拾われることを確かめる。拾えなければ、下の
   * 「前払いしている」の緑は検査が見ていない緑である。
   */
  describe('陰性対照: 漏れたファイルが1本でもあれば拾う', () => {
    const breakPrepay = (src: string) => src.replace(/(?<![.\w])beforeAll\(/g, 'beforeEach(');
    const withPrepay = entries.filter(
      ({ file, src }) =>
        judgePglitePrepay(src, file) === 'uses-with-prepay' &&
        judgePglitePrepay(breakPrepay(src), file) === 'uses-without-prepay',
    );

    it('#3034 で直した apps/daemon の4本は、前払いを外すとそれぞれ拾われる', () => {
      for (const name of [
        'commitment-unreadable-recovery-2148',
        'practice-unreadable-recovery-2011',
        'practice-version-unreadable-2177',
        'practice-versions-slug-pg-1670',
      ]) {
        const file = `apps/daemon/src/${name}.test.ts`;
        expect(
          withPrepay.map((e) => e.file),
          file,
        ).toContain(file);
        const mutated = entries.map((e) =>
          e.file === file ? { file, src: breakPrepay(e.src) } : e,
        );
        expect(findOffenders(mutated)).toEqual([...offenders, file].sort());
      }
    });

    it('beforeAll で前払いしているどのファイルも、前払いを外せば拾われる', () => {
      // 対照の母数が痩せていないこと（apps/daemon と packages/storage-pg の両方に在る）
      expect(withPrepay.length).toBeGreaterThanOrEqual(20);
      expect(withPrepay.some((e) => e.file.startsWith('apps/daemon/src/'))).toBe(true);
      expect(withPrepay.some((e) => e.file.startsWith('packages/storage-pg/src/'))).toBe(true);
      // 全体を1本ずつ書き換えて走査し直すと重いので、ここは書き換えた1本だけを同じ道に通す
      // （全体へ混ぜて拾えることは上の4本で確かめている）。
      for (const target of withPrepay) {
        expect(
          findOffenders([{ file: target.file, src: breakPrepay(target.src) }]),
          target.file,
        ).toEqual([target.file]);
      }
    });
  });

  it('雛形を使うテストファイルは、beforeAll で前払いしている', () => {
    expect(
      offenders,
      [
        '',
        'PGlite の雛形（createMigratedPglite( / createMigratedTestDb( / createEmptyTestDb( / new PGlite( / migrate( の直呼び）を使うのに、',
        'beforeAll による前払いが無いテストファイルがある（beforeEach は前払いと数えない。#3034）:',
        ...offenders.map((f) => `  - ${f}`),
        '',
        '最初に雛形を作る歯が、WASM の起動 + migrate を歯の本体（既定 5000ms）か、最初の beforeEach',
        '（hookTimeout 既定 10000ms）で払って時間切れになる',
        '（#2360 → PR #2364、#2378 → PR #2384、#3034 → PR #3035。先例 #2339 / #2364 / #2384）。',
        '足す形（ファイル先頭、describe の外）:',
        '',
        "  import { beforeAll } from 'vitest';",
        "  import { migratedTemplate } from './pglite-template.test-support.js';",
        '',
        '  beforeAll(async () => {',
        '    await migratedTemplate();',
        '  }, 60_000);',
        '',
        '（packages/storage-pg/src では同じ名前の補助が packages/storage-pg/src/pglite-template.test-support.ts に在る。',
        ' そこでは ./test-db.test-support.js を import すれば前払いが自動で掛かる）',
        '',
        '本当に要らないときは、ファイルのどこかに行頭から次の1行を書いて外す（理由が空だと効かない）:',
        '',
        '  // pglite-prepay: not-needed（理由）',
        '',
        '限界: このテストは beforeAll の呼び出しが在るかだけを見る（中身が費用を払うかは見ない）。',
        '',
      ].join('\n'),
    ).toEqual([]);
  });
});
