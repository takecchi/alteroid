import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';

/**
 * **デーモン・runner・core が stderr へ書く例外の文は `reasonOf(error)` を通す、を固定する歯**（#2512 / #2538）。
 *
 * `packages/core/src/dropped-record.ts` の `reasonOf` の doc が決めている:
 * 「記録の失敗をログへ出すところは、すべてここを通すこと」。drizzle の
 * `DrizzleQueryError` は `message` の2行目に `params: <束縛パラメータ>` を置き、
 * 書こうとした値がそのまま並ぶ。stderr は器のログ（Railway 等）に残る。
 * 素の `String(error)` / `error.message` を1か所でも置くと、そこだけが無防備になる。
 *
 * ## 何を見るか
 * `apps/daemon/src` と `apps/runner/src` と `packages/core/src` の（テストでない）ソースで、
 * `stderr.write(...)` / `writeStderrSync(...)` の**引数の中**に、次のどれかが在れば落とす。
 * - `String(<e|err|error|cause|failure>)`
 * - `<e|err|error|cause|failure>.message`
 * - テンプレートの `${<e|err|error|cause|failure>}`
 *
 * **一度別の変数へ入れてから書く形も見る**（#2538）。同じ関数（`this.#x` の形は同じクラス）の中で、
 * 素のエラーの文字列化を含む式を `const message = …` / `this.#last = …` へ入れ、その
 * `message` / `this.#last` を stderr への書き込みの引数へ置いたら落とす。
 *
 * ## 何を見ないか（取りこぼす形）
 * - 関数へ文字列を渡し、その先が stderr へ書く形（`onError(...)` / `warn(...)` / `announce(...)`）
 * - 関数をまたぐ受け渡し（引数・戻り値・別の関数が読むフィールド）。同じ関数内の代入だけを追う
 * - `apps/cli`（利用者自身の端末へ出す文）
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);
const SCAN_ROOTS = ['apps/daemon/src/', 'apps/runner/src/', 'packages/core/src/'];
const ERROR_NAMES = new Set(['e', 'err', 'error', 'cause', 'failure']);

interface BareErrorHit {
  line: number;
  text: string;
}

function isStderrWrite(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === 'writeStderrSync';
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'write' &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'stderr'
  );
}

/** 式の部分木に在る、素のエラーの文字列化（String(error) / error.message / ${error}）。 */
function bareErrorNodes(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const inspect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]!) &&
      ERROR_NAMES.has(node.arguments[0].text)
    ) {
      found.push(node);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'message' &&
      ts.isIdentifier(node.expression) &&
      ERROR_NAMES.has(node.expression.text)
    ) {
      found.push(node);
    } else if (
      ts.isTemplateSpan(node) &&
      ts.isIdentifier(node.expression) &&
      ERROR_NAMES.has(node.expression.text)
    ) {
      found.push(node.expression);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(root);
  return found;
}

/** 変数・`this.` のフィールドへ入れた値の持ち主（その名前が有効な範囲）。 */
function scopeOf(node: ts.Node, wantClass: boolean): ts.Node | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (wantClass ? ts.isClassLike(cur) : ts.isFunctionLike(cur)) return cur;
  }
  return undefined;
}

/** 素のエラーの文字列化を含む式を入れた名前（`message` / `this.#last`）を、範囲つきで集める。 */
function collectTaintedNames(file: ts.SourceFile): Map<string, ts.Node[]> {
  const tainted = new Map<string, ts.Node[]>();
  const add = (name: string, scope: ts.Node | undefined): void => {
    if (scope === undefined) return;
    tainted.set(name, [...(tainted.get(name) ?? []), scope]);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      bareErrorNodes(node.initializer).length > 0
    ) {
      add(node.name.text, scopeOf(node, false));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      bareErrorNodes(node.right).length > 0
    ) {
      if (ts.isIdentifier(node.left)) add(node.left.text, scopeOf(node, false));
      else if (
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        add(`this.${node.left.name.text}`, scopeOf(node, true));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return tainted;
}

/** stderr への書き込みの引数の中にある、素のエラーの文字列化（直接と、変数へ入れてから）を返す。 */
function findBareErrorStderrWrites(source: string): BareErrorHit[] {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true);
  const tainted = collectTaintedNames(file);
  const hits: BareErrorHit[] = [];
  const report = (node: ts.Node, text: string): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    hits.push({ line: line + 1, text });
  };
  const isInside = (node: ts.Node, scope: ts.Node): boolean =>
    node.pos >= scope.pos && node.end <= scope.end;
  /** 引数の中で、素のエラーを入れた名前を読んでいる所。 */
  const inspectIndirect = (node: ts.Node): void => {
    const asName =
      ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)
        ? node.text
        : ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword
          ? `this.${node.name.text}`
          : undefined;
    if (
      asName !== undefined &&
      (tainted.get(asName) ?? []).some((scope) => isInside(node, scope))
    ) {
      report(node, `${node.getText(file)}（素のエラーの文字列化を入れた変数）`);
    }
    ts.forEachChild(node, inspectIndirect);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isStderrWrite(node.expression)) {
      for (const arg of node.arguments) {
        for (const bare of bareErrorNodes(arg)) report(bare, bare.getText(file));
        inspectIndirect(arg);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function isScannedSource(rel: string): boolean {
  if (!SCAN_ROOTS.some((prefix) => rel.startsWith(prefix))) return false;
  if (!rel.endsWith('.ts')) return false;
  return !/\.test(-support)?\.ts$/.test(rel) && !rel.endsWith('/testing.ts');
}

describe('findBareErrorStderrWrites（純粋関数）', () => {
  const write = 'process.stderr.write';
  it('String(error) を stderr の引数に置く形を検出する', () => {
    const src = `${write}(\`x: \${String(error)}\\n\`);`;
    expect(findBareErrorStderrWrites(src)).toHaveLength(1);
  });
  it('error.message と複数行の引数も検出する', () => {
    const src = `${write}(\n  \`a（\${error.message}）\` +\n    'b',\n);`;
    const hits = findBareErrorStderrWrites(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });
  it('変数名が違っても（e / err）、テンプレートの素の ${error} も検出する', () => {
    expect(findBareErrorStderrWrites(`${write}(\`\${String(err)}\`);`)).toHaveLength(1);
    expect(findBareErrorStderrWrites(`writeStderrSync(\`\${String(e)}\`);`)).toHaveLength(1);
    expect(findBareErrorStderrWrites(`${write}(\`\${error}\`);`)).toHaveLength(1);
  });
  it('reasonOf を通した形・固定文言・stderr 以外への書き込みは検出しない', () => {
    expect(findBareErrorStderrWrites(`${write}(\`x: \${reasonOf(error)}\`);`)).toHaveLength(0);
    expect(findBareErrorStderrWrites(`${write}('固定文言\\n');`)).toHaveLength(0);
    expect(findBareErrorStderrWrites(`process.stdout.write(\`\${String(error)}\`);`)).toHaveLength(
      0,
    );
    expect(findBareErrorStderrWrites(`const s = String(error);`)).toHaveLength(0);
  });
  it('一度変数へ入れてから書く形（const / this.#field）も検出する（#2538）', () => {
    const viaConst = `function f() { try {} catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ${write}(\`x: \${message}\\n\`);
    } }`;
    expect(findBareErrorStderrWrites(viaConst)).toHaveLength(1);
    const viaField = `class C { async f() { try {} catch (error) {
      this.#last = String(error);
      ${write}(\`x: \${this.#last}\\n\`);
    } } }`;
    expect(findBareErrorStderrWrites(viaField)).toHaveLength(1);
  });
  it('reasonOf を入れた変数・別の関数の同名の変数・stderr へ書かない変数は検出しない', () => {
    const okConst = `function f() { try {} catch (error) {
      const message = reasonOf(error);
      ${write}(\`x: \${message}\\n\`);
    } }`;
    expect(findBareErrorStderrWrites(okConst)).toHaveLength(0);
    const otherFn = `function a() { const message = String(error); return message; }
      function b(message: string) { ${write}(\`x: \${message}\\n\`); }`;
    expect(findBareErrorStderrWrites(otherFn)).toHaveLength(0);
    const notWritten = `function f() { const message = String(error); return { message }; }`;
    expect(findBareErrorStderrWrites(notWritten)).toHaveLength(0);
  });
});

describe('デーモン・runner・core のソースが stderr へ書く例外の文は reasonOf を通す（#2512 / #2538）', () => {
  it('stderr.write / writeStderrSync の引数に素の String(error) / error.message が無い', () => {
    const files = collectRepoFiles(ROOT, EXCLUDE_DIRS).filter(isScannedSource);
    // 走査が空振りして「0件で緑」にならないようにする
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((rel) =>
      findBareErrorStderrWrites(readFileSync(path.join(ROOT, rel), 'utf8')).map(
        (hit) => `${rel}:${String(hit.line)}  ${hit.text}`,
      ),
    );
    expect(
      offenders,
      '素のエラーの文字列化が stderr へ出ている。reasonOf(error)（packages/core/src/dropped-record.ts）を通すこと',
    ).toEqual([]);
  });
});
