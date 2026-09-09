import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * **接続先（`apps/web/app/lib/config.ts` が決める、デーモンの所在）を、人間が
 * その場で入力欄へ打った値以外から受け取っていないことを固定する歯。**
 *
 * ## なぜこの歯が要るか（オーナーが引いた線）
 *
 * 接続先を、リンク・クエリ文字列・ハッシュのような「外から渡せる経路」から
 * 受け取ってはならない。**受け取っていいのは、人間がその場で入力欄へ打った値
 * だけ**である。理由は、攻撃者の URL を仕込んだリンクを踏ませれば、次に
 * ログインしたときの資格情報（`apps/web/app/lib/api.tsx` が付ける
 * `Authorization: Bearer`）が攻撃者のサーバへ渡る経路になるからである。
 *
 * **もしこの禁止を犯している経路を見つけても、この歯では直さない。** それは
 * 直ちに人間へ知らせるべき、この歯そのものより重い知らせである。
 *
 * ## この歯の前にあった歯と、その弱さ
 *
 * `apps/web/app/routes/login.test.tsx` の「URL のクエリ文字列・ハッシュから
 * 接続先を受け取らない（本(4)/歯5）」（3本）は、**恒真テストだった。**
 * `?apiBaseUrl=` と `#apiBaseUrl=` という*特定のパラメータ名*で出力（保存値・
 * 表示値）が変わらないことしか見ていないので、将来 `?endpoint=` のような
 * *別の名前*を読む実装が足されても、あの3本は緑のまま何も気づかない。
 *
 * **この歯が測る対象は「特定のパラメータ名での出力」ではなく「読み取り経路
 * そのものの有無」である。** login.test.tsx の3本は削らず残す（人間が実際に
 * 打った値を尊重する側の回帰は、あちらが引き続き見る）。
 *
 * ## なぜ生テキストへの正規表現で書かないか（先例が既に踏んだ穴）
 *
 * `scripts/require-operator-routes.test.ts` が既にこの問題に当たっている
 * （`grep -Fn -- '誤陽性の工場' scripts/require-operator-routes.test.ts`）。
 * あちらの結論を引く: 対象ファイルには日本語の散文コメントが大量に在り、
 * しかもその散文の主題が「配線している／していない」という、判定したい
 * 事実そのものであることが多い。生テキストへの正規表現はコメントを実装と
 * 読み違え、**誤検出で落ちる。そして落ちたとき次に読む人は「歯を直す」の
 * ではなく「歯を弱める」（緩い正規表現にする・除外リストへ足す）方向へ
 * 誘導され、弱められた歯は本当に配線が変わったときに鳴らない。**
 *
 * このファイルが対象にする `apps/web/app/lib/config.ts` /
 * `apps/web/app/components/connection.tsx` も同じ形の散文をすでに大量に
 * 持っている（例: `connection.tsx` は `resolveApiBaseUrl` `hasStoredApiBaseUrl`
 * という語をコメントの中で3回引用しているが、そこはコードではない）。
 * だから抽出も禁止判定も、**コメントが構文木に現れない TypeScript の AST
 * （`import ts from 'typescript'`）で読む**。`require-operator-routes.test.ts`
 * が既に `typescript` を使っているので、この依存を新しく足す必要は無い
 * （実測: `apps/web/package.json` / 根の `package.json` の両方に
 * `"typescript": "catalog:"` が既に在り、`scripts/require-operator-routes.test.ts`
 * が `import ts from 'typescript'` で読めている）。
 *
 * ## 構成
 *
 * - **(A)** 接続先に触るファイルの集合を、AST で抽出して決め打ちのリテラル
 *   一覧と突き合わせる。新しいファイルが接続先に触り始めたら、この歯が落ちて
 *   一覧を更新する瞬間＝人間が理由を読む瞬間が生まれる。
 * - **(B)** (A) で確定した各ファイルに、外から来る読み取り経路
 *   （`location` / `useSearchParams` / `document.referrer` / `window.name` /
 *   `postMessage` / `URLSearchParams`）が1件も無いことを、同じく AST で確かめる。
 * - **(C)** (A)(B) の抽出器・検出器が「黙って何も返さなくなる」壊れ方への
 *   検算。検出器が壊れて緑のまま無力になると、「測っていない」が「測って
 *   合格した」と同じ見た目になるので、これがいちばん危険な壊れ方である。
 *
 * ## ⭐ なぜこれが禁止で、いつ・どうやって先へ進めるか
 *
 * **繰り返す: 接続先を人間の入力以外から受け取ると、資格情報を盗む経路に
 * なる。だからこの読み取り経路は禁止である。**
 *
 * もし将来「正当な理由で `location`（や他の禁止経路）を読みたい」人がこの歯の
 * 前に立ったら——**この歯を消して先に進まないこと。** 消すのではなく、
 * *なぜその読み取りが安全か*（例: 値を検証してから使う・読むだけで
 * 資格情報の送信先には使わない、等）を示す**別の歯**を置き、この歯の
 * `EXPECTED_FILES` / 禁止一覧の側は「なぜ例外にしたか」をコメントで残した
 * うえで直すこと。**理由を名乗らない歯は、次にここへ来た人に「消してよい
 * 警告」に見える。**
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_APP_DIR = path.join(ROOT, 'apps/web/app');
const JOURNAL_PATH = path.join(ROOT, 'apps/web/app/routes/journal.tsx');

/** 変異試験・生成物を対象から外す（`workspace-test-scripts.test.ts` と同じ形）。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router']);

/** `.ts` は `ScriptKind.TS`、`.tsx` は `ScriptKind.TSX` で読む。 */
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

// --- (A) 接続先に触るファイルの抽出 -----------------------------------------

/**
 * 接続先に触っているとみなす識別子。`apps/web/app/lib/config.ts` が公開する
 * 4つの関数の名前そのもの。
 */
const TARGET_IDENTIFIER_NAMES = new Set([
  'storeApiBaseUrl',
  'resolveApiBaseUrl',
  'resolveApiBaseUrlOrigin',
  'hasStoredApiBaseUrl',
]);

/** `config.ts` の `STORAGE_KEY` の値そのもの（他ファイルは import せず直書きしうる）。 */
const TARGET_STORAGE_KEY_LITERAL = 'alteroid.apiBaseUrl';

/**
 * ソース中に、上の識別子または文字列リテラルへの**コードとしての**参照が
 * あるかを判定する。
 *
 * コメント中に同じ語が現れても、TypeScript のパーサはコメントをトリビア
 * （構文木のノードにならない）として扱うので、ここには一切拾われない
 * ——冒頭の doc が説明する「誤陽性の工場」を避ける理由そのもの。
 * 文字列リテラルは `isStringLiteralLike`（`'...'` と `` `...` `` の両方）で見る。
 */
export function referencesApiBaseUrlConfig(sourceText: string, fileName: string): boolean {
  const sourceFile = parseSource(sourceText, fileName);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && TARGET_IDENTIFIER_NAMES.has(node.text)) {
      found = true;
      return;
    }
    if (ts.isStringLiteralLike(node) && node.text === TARGET_STORAGE_KEY_LITERAL) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** `*.test.ts` / `*.test.tsx` か。テストは意図的に接続先の保存キーへ直接触れる
 * （`window.history.pushState` や `localStorage.setItem('alteroid.apiBaseUrl', …)`
 * を使う——`apps/web/app/routes/login.test.tsx` の「コンソールから手で設定した
 * 接続先が、描画しただけで消えない」）ので、禁止の対象は実装側だけに絞る。
 */
function isTestFile(relPath: string): boolean {
  return /\.test\.tsx?$/.test(relPath);
}

/** `dir` 配下の `.ts` / `.tsx` を再帰的に集め、リポジトリ根からの相対パス（`/` 区切り）で返す。 */
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
collectAppFiles(WEB_APP_DIR, allAppFiles);

/**
 * `apps/web/app/**\/*.{ts,tsx}` のうちテストファイルを除いたものの中で、
 * 実際に接続先へ触れているファイル。
 *
 * **`apps/web/app/test-support.tsx` を含む判断について。** このファイルは
 * `*.test.tsx` という*ファイル名の拡張子*には一致しない（テストから import
 * される足場であって、それ自体はテストの集計に乗らない）ので、上の
 * `isTestFile` の除外規則には掛からない。実際 `localStorage.setItem(
 * 'alteroid.apiBaseUrl', url)` を直書きしており、抽出には引っかかる。
 * **これは意図した挙動として EXPECTED_FILES に含めてある** ——
 * 「テストファイルは除く」という依頼の理由（テストは意図的に触れる）は
 * `test-support.tsx` にも当てはまるが、除外規則そのものはファイル名の
 * 拡張子で機械的に決めると依頼で明記されているため、ここは規則の文字どおりに
 * 倒した。実害は無い——(B) はこのファイルに禁止経路が無いことしか要求せず、
 * `test-support.tsx` は `location` 等のどれも読んでいない。
 */
const filesTouchingApiBaseUrlConfig = allAppFiles
  .filter((relPath) => !isTestFile(relPath))
  .filter((relPath) =>
    referencesApiBaseUrlConfig(readFileSync(path.join(ROOT, relPath), 'utf8'), relPath),
  )
  .sort();

/**
 * 決め打ちのリテラル一覧（実測、2026-09-09）。
 *
 * この一覧が変わったら——新しいファイルが接続先に触り始めたか、既存のどれかが
 * 触るのをやめたということである。**ズレを機械的に検出することがこの歯(A)の
 * 役目であって、ズレをどう扱うかは人間が読むこと。** 特に「新しく触り始めた」
 * 側は、(B) の禁止経路を持ち込んでいないかをその場で確認すること。
 */
const EXPECTED_FILES = [
  'apps/web/app/components/connection.tsx',
  'apps/web/app/lib/api.tsx',
  'apps/web/app/lib/config.ts',
  'apps/web/app/test-support.tsx',
];

// --- (B) 外から来る読み取り経路の禁止 ----------------------------------------

export interface ForbiddenReference {
  /** どの禁止経路に当たったか。 */
  rule: string;
  /** 1-based の行番号。 */
  line: number;
}

/**
 * 識別子として現れたら即座に禁止経路とみなす名前。
 *
 * - `location` — `location.search` / `location.hash` / `window.location.href`
 *   等をまとめて捕まえる。`window.location` の `location` はメンバアクセスの
 *   プロパティ名として Identifier ノードに現れるので、これで全部拾える。
 * - `useSearchParams` — react-router のフック。
 * - `URLSearchParams` — ブラウザ組み込みの URL クエリ文字列パーサ。
 * - `postMessage` — `window.postMessage` の呼び出し側・プロパティアクセス側
 *   のどちらもここで拾う（`addEventListener('message', …)` 側は別途判定する）。
 */
const FORBIDDEN_VALUE_IDENTIFIERS = new Set([
  'location',
  'useSearchParams',
  'URLSearchParams',
  'postMessage',
]);

/**
 * 識別子が**型の位置**（`: Location` のような型注釈、`interface` の
 * プロパティ名、`import type` 由来の指定子）にしか現れていないかを判定する。
 *
 * ここが真なら禁止対象から外す——型の位置に現れる識別子は実行時に何も
 * 読まない（build で消える）ので、資格情報の流出経路にはなりえない。
 * 現状 (B) の対象4ファイルにはこの形は無い（後述の合成 fixture で確認する）が、
 * 将来「型としてだけ `Location` を参照する」ような書き方が増えたときに
 * 空振りで落ちないための備え。
 */
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

/** `expr` が（プロパティアクセスの末端として）指定した名前の識別子で終わるか。 */
function expressionEndsWithIdentifier(expr: ts.Expression, name: string): boolean {
  if (ts.isIdentifier(expr)) return expr.text === name;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === name;
  return false;
}

/**
 * ソース中の、外から来る読み取り経路への参照をすべて拾う。
 *
 * `setParentNodes: true` で読む（`isTypeOnlyPosition` が `node.parent` を
 * 見るため）。
 */
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

    // document.referrer / window.document.referrer
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'referrer' &&
      expressionEndsWithIdentifier(node.expression, 'document')
    ) {
      found.push({ rule: 'document.referrer', line: lineOf(node) });
    }

    // window.name（`name` は汎用的すぎる語なので、`window.` 越しのときだけ拾う）
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'name' &&
      expressionEndsWithIdentifier(node.expression, 'window')
    ) {
      found.push({ rule: 'window.name', line: lineOf(node) });
    }

    // addEventListener('message', ...)（呼び出し経路。`postMessage` の識別子検出とは別立て）
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

// --- 合成 fixture（検出器そのものの証明。require-operator-routes.test.ts と同じ形） --

/** `location.search` を実際に読む、最小のソース。 */
const FIXTURE_READS_LOCATION_SEARCH = `
export function readQuery(): string {
  return location.search;
}
`;

/**
 * **このファイルが対象にする実物と同じ形の危険**を再現した fixture:
 * 「`location` を読まない」ことを説明する日本語の散文コメントだけが在り、
 * 実際のコードは無関係な値を返す。正規表現ならここでコメント中の `location`
 * を読み取りと誤検出しかねないが、AST は誤検出しないことを示す。
 */
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

/**
 * `location` という名前が **`interface` のフィールド宣言としてしか現れない**
 * （実行時に一度もその値を読まない）合成ソース。`isTypeOnlyPosition` の
 * `PropertySignature` 除外を確かめる。
 */
const FIXTURE_TYPE_ONLY_LOCATION = `
interface Foo {
  location: string;
}
`;

/**
 * ⚠️ **既知の広い網——`location` という名前を持つ、無関係な値のプロパティを
 * 読んだだけでも検出される。** `x: Foo`（`Foo.location` はただの文字列
 * フィールドで `window.location` とは無関係）を実際に読む `x.location` は、
 * `interface Foo { location: string }` という宣言と構文木の上で見分けが
 * 付かない（型情報までは見ていないため）。**これは検出器の欠陥ではなく、
 * 「疑わしきは検出する」側へ倒した意図的な選択である**——見逃す（偽陰性）
 * より、無関係なコードに一度立ち止まらせる（偽陽性）ほうが、この歯の目的
 * （資格情報の流出経路を見逃さないこと）に照らして安全である。対象は
 * `EXPECTED_FILES` の4ファイルに限られており、そこに `location` という名前の
 * 無関係なフィールドは実在しない（実測、上の(B)の本物のテストが0件で通って
 * いる）。もし将来そのようなフィールドが必要になったら、フィールド名を
 * 変えるのがこの歯を弱めずに済む直し方である。
 */
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

  it('apps/web/app/lib/config.ts は必ず対象集合に入る', () => {
    expect(filesTouchingApiBaseUrlConfig).toContain('apps/web/app/lib/config.ts');
  });

  it('合成 fixture: 実際に識別子・リテラルを参照していれば true', () => {
    expect(referencesApiBaseUrlConfig('storeApiBaseUrl(null);', 'x.ts')).toBe(true);
    expect(referencesApiBaseUrlConfig("localStorage.getItem('alteroid.apiBaseUrl')", 'x.ts')).toBe(
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
    // このファイル自身が対象にしている実物（connection.tsx / config.ts）と同じ形の
    // 危険を再現する——散文の主題が「読まない」ことそのものである comment。
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
    // FIXTURE_UNRELATED_LOCATION_PROPERTY の doc を参照。型情報までは見ていない
    // ので、window.location と無関係な `x.location` も区別できず検出される
    // ——見逃す（偽陰性）より安全側に倒した、意図した挙動である。
    const found = findForbiddenExternalInputReferences(FIXTURE_UNRELATED_LOCATION_PROPERTY, 'x.ts');
    expect(found.map((f) => f.rule)).toContain('location');
  });
});

/**
 * ⚠️ **この対照が落ちたとき、赤の理由は2つある。順番に疑うこと。**
 *
 * この対照は `journal.tsx` という**外部の実装**に依存している。だから
 * 「検出器が壊れた」だけでなく「対照のほうが消えた」でも赤くなる——そして
 * **後者を前者と誤診した人は、対照を別のファイルへ差し替えるか (C) ごと
 * 消す。どちらでもこの自己検査は失われる。**
 *
 * **(1) 先に疑うのは「対照が消えた」ほうである。** `journal.tsx` が検索語 `q` の
 * ために `useSearchParams` / `URLSearchParams` を使うのをやめた・別の実装に
 * 変わった・ファイルが移動または削除された、のいずれか。**この場合、直すのは
 * 検出器ではなく対照である**——同じく「禁止経路を確実に持っている実在の
 * ファイル」を新しく選び直し、`JOURNAL_PATH` を差し替える。(C) を消さないこと。
 *
 * **(2) 検出器そのものが壊れた場合。** ただし**その切り分けは、この (C) の上に
 * ある (B) の合成 fixture 群が既にやっている**——`FIXTURE_READS_LOCATION_SEARCH`
 * 以下の各 fixture は外部の実装に一切依存せず、検出器だけを直接測る。
 *
 * ⟹ **見分け方: 合成 fixture が緑のままここだけ赤いなら (1)。合成 fixture も
 * 一緒に赤いなら (2)。** 合成と実物の両方を持っているのは、この切り分けを
 * 成立させるためである（片方だけでは、赤の理由が1つに絞れない）。
 */
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
    // journal.tsx は useSearchParams / URLSearchParams を検索語 `q`（接続先とは
    // 無関係）のために正当に使っている。(A) の対象は「接続先に触るか」であって
    // 「禁止経路を使っているか」ではないので、ここには入らない——(B) の禁止判定
    // は下のテストで journal.tsx に対して直接かける。
    expect(filesTouchingApiBaseUrlConfig).not.toContain('apps/web/app/routes/journal.tsx');
  });

  it('検出器の自己検証: journal.tsx の正当な useSearchParams / URLSearchParams を実際に検出する', () => {
    // journal.tsx は検索語 `q` のために useSearchParams と URLSearchParams を
    // 正当な理由で使っている（接続先とは無関係）。もし (B) の検出器が壊れて
    // 何も拾わなくなっていたら、対象4ファイルが偶然どれも禁止経路を持たない
    // ことと区別が付かないまま緑になる——それを避けるため、確実に禁止経路を
    // 持っている実在ファイルへ同じ検出器を当てて、実際に鳴ることを確かめる。
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
