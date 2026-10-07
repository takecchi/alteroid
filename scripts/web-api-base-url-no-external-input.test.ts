import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 接続先は人間が入力欄へ打った値以外から受け取らない: リンクやクエリ文字列に仕込まれた攻撃者の URL へ、次のログインの資格情報（`Authorization: Bearer`）が渡る経路になるため。
// この歯を消して先へ進まない: 正当な理由で `location` などを読みたいなら、その読み取りが安全な理由を示す別の歯を置き、`EXPECTED_FILES` / 禁止一覧の側に例外にした理由を残す。
// 生テキストへの正規表現にせず AST で読む: 対象ファイルの散文コメントを実装と読み違えて誤検出し、歯を弱める方向へ誘導されるため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 切り出したパッケージの `src` を走査の根から外さない: `config.ts` は `packages/logic`、`api.tsx` は `packages/swr` に在り、外すと守りたい2ファイルが走査から黙って消えるため。
const WEB_UI_SOURCE_DIRS = [
  'apps/web/app',
  'packages/ui/src',
  'packages/logic/src',
  'packages/swr/src',
].map((dir) => path.join(ROOT, dir));
const JOURNAL_PATH = path.join(ROOT, 'apps/web/app/routes/journal.tsx');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router']);

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parseSource(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
}

const TARGET_IDENTIFIER_NAMES = new Set([
  'storeApiBaseUrl',
  'resolveApiBaseUrl',
  'resolveApiBaseUrlOrigin',
  'hasStoredApiBaseUrl',
  // 一覧の側の識別子も含める: 含めないと、一覧だけを触るファイルが (A) の抽出から漏れ、(B) の禁止が当たらないまま増えるため。
  'listEndpoints',
  'parseBuildTimeEndpoints',
  'readStoredEndpoints',
  'storeEndpoints',
  'sanitizeEndpoints',
  'upsertEndpoint',
  'withoutEndpoint',
  'migrateSelectionIntoStoredEndpoints',
  'normalizeEndpointUrl',
]);

// 選択（`alteroid.apiBaseUrl`）と一覧（`alteroid.endpoints`）の鍵の両方を見る: 片方だけだと、一覧を直接書き換えるファイルが抽出から漏れるため。
const TARGET_STORAGE_KEY_LITERALS = new Set(['alteroid.apiBaseUrl', 'alteroid.endpoints']);

export function referencesApiBaseUrlConfig(sourceText: string, fileName: string): boolean {
  const sourceFile = parseSource(sourceText, fileName);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && TARGET_IDENTIFIER_NAMES.has(node.text)) {
      found = true;
      return;
    }
    if (ts.isStringLiteralLike(node) && TARGET_STORAGE_KEY_LITERALS.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

// 禁止の対象は実装側だけに絞る: テストは意図的に接続先の保存キーへ直接触れるため。
function isTestFile(relPath: string): boolean {
  return /\.test\.tsx?$/.test(relPath);
}

function collectAppFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectAppFiles(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
}

const allAppFiles: string[] = [];
for (const dir of WEB_UI_SOURCE_DIRS) collectAppFiles(dir, allAppFiles);

// `packages/swr/src/test-support.tsx` は `EXPECTED_FILES` に含める: 拡張子では `isTestFile` の除外に掛からず、接続先の保存キーを直書きしているため。
const filesTouchingApiBaseUrlConfig = allAppFiles
  .filter((relPath) => !isTestFile(relPath))
  .filter((relPath) =>
    referencesApiBaseUrlConfig(readFileSync(path.join(ROOT, relPath), 'utf8'), relPath),
  )
  .sort();

const EXPECTED_FILES = [
  'apps/web/app/components/connection.tsx',
  'packages/swr/src/api.tsx',
  'packages/logic/src/config.ts',
  'packages/swr/src/test-support.tsx',
];

export interface ForbiddenReference {
  rule: string;
  line: number;
}

const FORBIDDEN_VALUE_IDENTIFIERS = new Set([
  'location',
  'useSearchParams',
  'URLSearchParams',
  'postMessage',
]);

// 型の位置にしか現れない識別子は禁止対象から外す: 実行時に何も読まないため。
function isTypeOnlyPosition(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isTypeReferenceNode(parent) && parent.typeName === node) return true;
  if ((ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === node) {
    return true;
  }
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) && parent.isTypeOnly) return true;
  return false;
}

function expressionEndsWithIdentifier(expr: ts.Expression, name: string): boolean {
  if (ts.isIdentifier(expr)) return expr.text === name;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === name;
  return false;
}

// `setParentNodes: true` で読む: `isTypeOnlyPosition` が `node.parent` を見るため。
export function findForbiddenExternalInputReferences(
  sourceText: string,
  fileName: string,
): ForbiddenReference[] {
  const sourceFile = parseSource(sourceText, fileName);
  const found: ForbiddenReference[] = [];

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_VALUE_IDENTIFIERS.has(node.text)) {
      if (!isTypeOnlyPosition(node)) {
        found.push({ rule: node.text, line: lineOf(node) });
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'referrer' &&
      expressionEndsWithIdentifier(node.expression, 'document')
    ) {
      found.push({ rule: 'document.referrer', line: lineOf(node) });
    }

    // `name` は汎用的すぎる語なので、`window.` 越しのときだけ拾う。
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'name' &&
      expressionEndsWithIdentifier(node.expression, 'window')
    ) {
      found.push({ rule: 'window.name', line: lineOf(node) });
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addEventListener' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === 'message'
    ) {
      found.push({ rule: "addEventListener('message', ...)", line: lineOf(node) });
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const FIXTURE_READS_LOCATION_SEARCH = `
export function readQuery(): string {
  return location.search;
}
`;

const FIXTURE_COMMENT_ONLY_MENTIONS_LOCATION = `
/**
 * 接続先は location を読まない。クエリ文字列やハッシュから受け取ることは
 * 絶対にしない——ここに location という語が出てくるのは、この関数が
 * location を読んでいないことを説明するためだけである。
 */
export function readNothingExternal(): string {
  return 'fixed-value';
}
`;

const FIXTURE_TYPE_ONLY_LOCATION = `
interface Foo {
  location: string;
}
`;

// 無関係な `x.location` も検出する: 型情報を見ておらず、見逃すより立ち止まらせる側へ倒したため。そのようなフィールドが必要になったら、歯を弱めずフィールド名を変える。
const FIXTURE_UNRELATED_LOCATION_PROPERTY = `
interface Foo {
  location: string;
}
export function readUnrelatedField(x: Foo): string {
  return x.location;
}
`;

const FIXTURE_DOCUMENT_REFERRER = `
export function readReferrer(): string {
  return document.referrer;
}
`;

const FIXTURE_WINDOW_NAME = `
export function readWindowName(): string {
  return window.name;
}
`;

const FIXTURE_POST_MESSAGE_CALL = `
export function send(): void {
  window.postMessage('hi', '*');
}
`;

const FIXTURE_ADD_EVENT_LISTENER_MESSAGE = `
export function listen(): void {
  window.addEventListener('message', () => {});
}
`;

const FIXTURE_URL_SEARCH_PARAMS = `
export function parse(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}
`;

describe('(A) 接続先に触るファイルの集合が、決め打ちの一覧と一致する', () => {
  it('抽出結果が EXPECTED_FILES と一致する（ズレたら一覧かコードのどちらかを直す）', () => {
    const extracted = filesTouchingApiBaseUrlConfig;
    const expected = [...EXPECTED_FILES].sort();

    const missing = expected.filter((f) => !extracted.includes(f));
    const extra = extracted.filter((f) => !expected.includes(f));

    expect(
      { extracted, missing, extra },
      missing.length === 0 && extra.length === 0
        ? ''
        : [
            missing.length > 0 ? `一覧に在るが抽出から消えたファイル: ${missing.join(', ')}` : '',
            extra.length > 0
              ? `新しく接続先へ触れ始めた（一覧に無い）ファイル: ${extra.join(', ')}` +
                ' —— (B) の禁止経路を持ち込んでいないか確認したうえで EXPECTED_FILES を更新すること。'
              : '',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
    ).toEqual({ extracted: expected, missing: [], extra: [] });
  });

  it('packages/logic/src/config.ts は必ず対象集合に入る', () => {
    expect(filesTouchingApiBaseUrlConfig).toContain('packages/logic/src/config.ts');
  });

  it('合成 fixture: 実際に識別子・リテラルを参照していれば true', () => {
    expect(referencesApiBaseUrlConfig('storeApiBaseUrl(null);', 'x.ts')).toBe(true);
    expect(referencesApiBaseUrlConfig("localStorage.getItem('alteroid.apiBaseUrl')", 'x.ts')).toBe(
      true,
    );
    expect(referencesApiBaseUrlConfig('listEndpoints();', 'x.ts')).toBe(true);
    expect(referencesApiBaseUrlConfig("localStorage.getItem('alteroid.endpoints')", 'x.ts')).toBe(
      true,
    );
  });

  it('合成 fixture: コメントの中にしか語が現れなければ false（誤陽性の工場を避ける）', () => {
    expect(
      referencesApiBaseUrlConfig(
        '// storeApiBaseUrl はここでは呼んでいない（alteroid.apiBaseUrl も同様）\nexport const x = 1;',
        'x.ts',
      ),
    ).toBe(false);
  });
});

describe('(B) 抽出したファイルのどれにも、外から来る読み取り経路が無い', () => {
  it('location / useSearchParams / document.referrer / window.name / postMessage / URLSearchParams のいずれも参照していない', () => {
    const violations = filesTouchingApiBaseUrlConfig.flatMap((relPath) => {
      const sourceText = readFileSync(path.join(ROOT, relPath), 'utf8');
      return findForbiddenExternalInputReferences(sourceText, relPath).map((ref) => ({
        file: relPath,
        ...ref,
      }));
    });

    expect(
      violations,
      violations.length === 0
        ? ''
        : [
            '接続先に触るファイルの中に、外から来る読み取り経路への参照が見つかった:',
            ...violations.map((v) => `  - ${v.file}:${v.line} ${v.rule}`),
            '',
            'これは資格情報が攻撃者のサーバへ渡る経路になりうる（このファイル冒頭の doc）。',
            'この歯を弱めて（対象から外す・禁止一覧を削る）通す前に、まず人間へ報告すること。',
            '正当な理由があるなら、この歯を消すのではなく「なぜ安全か」を示す別の歯を置くこと。',
          ].join('\n'),
    ).toEqual([]);
  });

  it('合成 fixture: location.search を読むソースは検出される', () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_READS_LOCATION_SEARCH, 'x.ts');
    expect(found.map((f) => f.rule)).toContain('location');
  });

  it('合成 fixture: document.referrer を読むソースは検出される', () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_DOCUMENT_REFERRER, 'x.ts');
    expect(found.map((f) => f.rule)).toContain('document.referrer');
  });

  it('合成 fixture: window.name を読むソースは検出される', () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_WINDOW_NAME, 'x.ts');
    expect(found.map((f) => f.rule)).toContain('window.name');
  });

  it('合成 fixture: window.postMessage の呼び出しは検出される', () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_POST_MESSAGE_CALL, 'x.ts');
    expect(found.map((f) => f.rule)).toContain('postMessage');
  });

  it("合成 fixture: addEventListener('message', ...) は検出される", () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_ADD_EVENT_LISTENER_MESSAGE, 'x.ts');
    expect(found.map((f) => f.rule)).toContain("addEventListener('message', ...)");
  });

  it('合成 fixture: new URLSearchParams(...) は検出される', () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_URL_SEARCH_PARAMS, 'x.ts');
    expect(found.map((f) => f.rule)).toContain('URLSearchParams');
  });

  it('合成 fixture: コメントの中で「location を読まない」と説明しているだけなら検出しない', () => {
    const found = findForbiddenExternalInputReferences(
      FIXTURE_COMMENT_ONLY_MENTIONS_LOCATION,
      'x.ts',
    );
    expect(found).toEqual([]);
  });

  it('合成 fixture: location という名前が interface のフィールド宣言にしか無ければ検出しない', () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_TYPE_ONLY_LOCATION, 'x.ts');
    expect(found).toEqual([]);
  });

  it('合成 fixture（既知の広い網）: 無関係な値の location フィールドを読んでも検出される', () => {
    const found = findForbiddenExternalInputReferences(FIXTURE_UNRELATED_LOCATION_PROPERTY, 'x.ts');
    expect(found.map((f) => f.rule)).toContain('location');
  });
});

// この対照が赤いときは、検出器より先に対照（`journal.tsx`）が消えていないか疑う: 消えていたら (C) を消さず、禁止経路を確実に持つ別の実在ファイルへ `JOURNAL_PATH` を差し替える。
const DIAGNOSIS_WHEN_CONTROL_FAILS = [
  'この対照が落ちた理由は2つある。まず「対照が消えた」ほうを疑うこと:',
  '  (1) journal.tsx が useSearchParams / URLSearchParams を使わなくなった・',
  '      移動した・削除された → 直すのは検出器ではなく対照。同じく禁止経路を',
  '      確実に持つ実在ファイルを選び直して JOURNAL_PATH を差し替える。',
  '      (C) を消さないこと。',
  '  (2) 検出器そのものが壊れた。',
  '⟹ 見分け方: 上の合成 fixture 群が緑のままここだけ赤いなら (1)。',
  '   合成 fixture も一緒に赤いなら (2)。',
].join('\n');

describe('(C) 検出器・抽出器が「黙って何も返さなくなる」壊れ方への検算', () => {
  it('(A) の抽出結果は空でない（検出器が壊れて何も拾わなくなっていないか）', () => {
    expect(filesTouchingApiBaseUrlConfig.length).toBeGreaterThan(0);
  });

  it('journal.tsx は接続先に触っていないので (A) の一覧に入らない', () => {
    expect(filesTouchingApiBaseUrlConfig).not.toContain('apps/web/app/routes/journal.tsx');
  });

  it('検出器の自己検証: journal.tsx の正当な useSearchParams / URLSearchParams を実際に検出する', () => {
    // 禁止経路を確実に持つ実在ファイルへ同じ検出器を当てる: 検出器が壊れて何も拾わなくなっても、対象4ファイルが偶然どれも禁止経路を持たないことと区別が付かず緑になるため。
    const journalSource = readFileSync(JOURNAL_PATH, 'utf8');
    const found = findForbiddenExternalInputReferences(journalSource, 'journal.tsx');

    expect(
      found.map((f) => f.rule),
      DIAGNOSIS_WHEN_CONTROL_FAILS,
    ).toContain('useSearchParams');
    expect(
      found.map((f) => f.rule),
      DIAGNOSIS_WHEN_CONTROL_FAILS,
    ).toContain('URLSearchParams');
  });
});
