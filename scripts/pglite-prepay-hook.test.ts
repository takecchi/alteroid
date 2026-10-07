import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';

// `beforeEach(` はどのパッケージでも前払いと数えない: 混んだ器では最初の1回が hookTimeout（既定 10000ms）の中で 12〜16 秒かかって落ちるため。
// 除外の印は理由（括弧の中身）が空だと効かない: 理由の無い除外は忘れと見分けがつかないため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

const TARGET = /^(?:apps|packages)\/[^/]+\/src\/.+\.test\.tsx?$/;

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
          // 単引用・二重引用は行で閉じる: 閉じ忘れで以降を飲み込まないため。
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
const OPT_OUT = /^[ \t]*\/\/[ \t]*pglite-prepay:[ \t]*not-needed[（(][ \t]*[^\s）)][^）)]*[）)]/m;

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
    expect(files.length).toBeGreaterThanOrEqual(400);
    expect(users.length).toBeGreaterThanOrEqual(40);
    expect(users.some((v) => v.verdict === 'uses-with-prepay')).toBe(true);
    expect(
      users.filter((v) => v.file.startsWith('apps/daemon/src/')).length,
    ).toBeGreaterThanOrEqual(20);
  });

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
      expect(withPrepay.length).toBeGreaterThanOrEqual(20);
      expect(withPrepay.some((e) => e.file.startsWith('apps/daemon/src/'))).toBe(true);
      expect(withPrepay.some((e) => e.file.startsWith('packages/storage-pg/src/'))).toBe(true);
      // 書き換えた1本だけを同じ道に通す: 全体を1本ずつ書き換えて走査し直すと重いため。
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
