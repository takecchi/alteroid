import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';

// `instanceof Error` は絞りに数えない: 値を含まないと確かめた自前の例外クラス（`ALLOWED_CUSTOM_CLASSES`）だけを許可するため。
// `apps/cli` は走査しない: 利用者自身の端末へ出す文で、器のログやクローンの文脈へ届かないため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);
const SCAN_ROOTS = ['apps/daemon/src/', 'apps/runner/src/', 'packages/core/src/'];
const ERROR_NAMES = new Set(['e', 'err', 'error', 'cause', 'failure']);
const ALLOWED_CUSTOM_CLASSES = new Set<string>([
  'JournalAnchorNotFoundError',
  'InvalidCursorError',
  'InvalidConversationCursorError',
  'UnreadableApprovalError',
  'CredentialEntryRejectedError',
  'TokenPoolInputError',
  'NulNotAllowedError',
  'InvalidCredentialNameError',
  // 値の載る `reason` を渡すようにするなら、ここから外す: 任意の `reason` は文の末尾に付くため。
  'UnreadableJournalEntryError',
]);
const ALLOWED_NAME_LITERALS = new Set<string>(['InvalidApprovalSelectionsError']);
const REDACTORS = new Set([
  'reasonOf',
  'redactErrorText',
  'redactSecretsInText',
  'collapseErrorCause',
]);
const CLONE_SINK_NAMES = new Set(['announce', 'postToClone']);
const TOOLS_FILE = 'packages/core/src/tools.ts';
const HTTP_FILES = new Set(['apps/daemon/src/app.ts', 'apps/runner/src/app.ts']);

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

function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text.replace(/^#/, '');
  return undefined;
}

function isRedactorCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  return name !== undefined && REDACTORS.has(name);
}

function isNameLiteralCheck(cond: ts.BinaryExpression, id: string): boolean {
  const op = cond.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsToken) {
    return false;
  }
  const isNameOfId = (e: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(e) &&
    e.name.text === 'name' &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === id;
  const isNarrowLiteral = (e: ts.Expression): boolean =>
    ts.isStringLiteralLike(e) && ALLOWED_NAME_LITERALS.has(e.text);
  return (
    (isNameOfId(cond.left) && isNarrowLiteral(cond.right)) ||
    (isNameOfId(cond.right) && isNarrowLiteral(cond.left))
  );
}

function impliesCustomInstanceof(cond: ts.Expression, id: string): boolean {
  if (ts.isParenthesizedExpression(cond)) return impliesCustomInstanceof(cond.expression, id);
  if (ts.isBinaryExpression(cond)) {
    const op = cond.operatorToken.kind;
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      return (
        ts.isIdentifier(cond.left) &&
        cond.left.text === id &&
        ts.isIdentifier(cond.right) &&
        ALLOWED_CUSTOM_CLASSES.has(cond.right.text)
      );
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return impliesCustomInstanceof(cond.left, id) || impliesCustomInstanceof(cond.right, id);
    }
    if (isNameLiteralCheck(cond, id)) return true;
  }
  return false;
}

function impliesNarrowedWhenFalse(cond: ts.Expression, id: string): boolean {
  if (ts.isParenthesizedExpression(cond)) return impliesNarrowedWhenFalse(cond.expression, id);
  if (ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken) {
    return impliesCustomInstanceof(cond.operand, id);
  }
  if (ts.isBinaryExpression(cond) && cond.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return impliesNarrowedWhenFalse(cond.left, id) || impliesNarrowedWhenFalse(cond.right, id);
  }
  return false;
}

function alwaysExits(stmt: ts.Statement): boolean {
  const exits = (st: ts.Statement): boolean => ts.isThrowStatement(st) || ts.isReturnStatement(st);
  return exits(stmt) || (ts.isBlock(stmt) && stmt.statements.some(exits));
}

function isNarrowingEarlyExit(stmt: ts.Statement, id: string): boolean {
  return (
    ts.isIfStatement(stmt) &&
    stmt.elseStatement === undefined &&
    alwaysExits(stmt.thenStatement) &&
    impliesNarrowedWhenFalse(stmt.expression, id)
  );
}

function narrowedToCustomClass(node: ts.Node, id: string): boolean {
  for (
    let child: ts.Node = node, cur = node.parent;
    cur !== undefined;
    child = cur, cur = cur.parent
  ) {
    if (ts.isIfStatement(cur) && cur.thenStatement === child) {
      if (impliesCustomInstanceof(cur.expression, id)) return true;
    } else if (ts.isConditionalExpression(cur) && cur.whenTrue === child) {
      if (impliesCustomInstanceof(cur.condition, id)) return true;
    } else if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isCaseClause(cur)) {
      const stmts = cur.statements;
      const at = stmts.findIndex((st) => st === child);
      if (at > 0 && stmts.slice(0, at).some((st) => isNarrowingEarlyExit(st, id))) return true;
    }
  }
  return false;
}

function isCatchCallbackParam(node: ts.Node, id: string): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isCallExpression(cur.parent) &&
      ts.isPropertyAccessExpression(cur.parent.expression) &&
      cur.parent.expression.name.text === 'catch' &&
      cur.parent.arguments.includes(cur)
    ) {
      const first = cur.parameters[0];
      if (first !== undefined && ts.isIdentifier(first.name) && first.name.text === id) return true;
    }
  }
  return false;
}

// 名前の一覧ではなく束縛で決める: 一覧に無い名前の catch を取りこぼさないため。`ERROR_NAMES` は束縛が無い断片のための補助。
function isErrorRef(node: ts.Node): node is ts.Identifier {
  if (!ts.isIdentifier(node)) return false;
  return (
    ERROR_NAMES.has(node.text) ||
    isCatchVariable(node, node.text) ||
    isCatchCallbackParam(node, node.text) ||
    isErrorAlias(node)
  );
}

function isInside(node: ts.Node, scope: ts.Node): boolean {
  return node.pos >= scope.pos && node.end <= scope.end;
}

function unwrapExpr(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

const aliasesByFile = new WeakMap<ts.SourceFile, Map<string, ts.Node[]>>();

function isErrorAlias(node: ts.Identifier): boolean {
  const scopes = aliasesByFile.get(node.getSourceFile())?.get(node.text) ?? [];
  return scopes.some((scope) => isInside(node, scope));
}

function collectErrorAliases(file: ts.SourceFile): void {
  const aliases = new Map<string, ts.Node[]>();
  aliasesByFile.set(file, aliases);
  const pairs: { name: string; init: ts.Expression; at: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      pairs.push({ name: node.name.text, init: node.initializer, at: node });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      pairs.push({ name: node.left.text, init: node.right, at: node });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (let changed = true; changed;) {
    changed = false;
    for (const { name, init, at } of pairs) {
      const rhs = unwrapExpr(init);
      const scope = scopeOf(at, false);
      if (scope === undefined || !isErrorRef(rhs) || narrowedToCustomClass(rhs, rhs.text)) continue;
      const known = aliases.get(name) ?? [];
      if (known.includes(scope)) continue;
      aliases.set(name, [...known, scope]);
      changed = true;
    }
  }
}

const LEAKY_PROPS = new Set(['message', 'stack', 'cause']);

function bareErrorNodes(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const add = (node: ts.Node, id: ts.Identifier): void => {
    if (!narrowedToCustomClass(node, id.text)) found.push(node);
  };
  const inspect = (node: ts.Node): void => {
    if (isRedactorCall(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (
        ts.isIdentifier(callee) &&
        callee.text === 'String' &&
        node.arguments.length === 1 &&
        arg !== undefined &&
        isErrorRef(arg)
      ) {
        add(node, arg);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'toString' &&
        isErrorRef(callee.expression)
      ) {
        add(node, callee.expression);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'stringify' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'JSON' &&
        arg !== undefined &&
        isErrorRef(arg)
      ) {
        add(node, arg);
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      LEAKY_PROPS.has(node.name.text) &&
      isErrorRef(node.expression)
    ) {
      add(node, node.expression);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      LEAKY_PROPS.has(node.argumentExpression.text) &&
      isErrorRef(node.expression)
    ) {
      add(node, node.expression);
    } else if (ts.isTemplateSpan(node) && isErrorRef(node.expression)) {
      add(node.expression, node.expression);
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && isErrorRef(node.left)) {
        add(node.left, node.left);
      }
      if (isErrorRef(node.right)) add(node.right, node.right);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(root);
  return found;
}

function scopeOf(node: ts.Node, wantClass: boolean): ts.Node | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (wantClass ? ts.isClassLike(cur) : ts.isFunctionLike(cur)) return cur;
  }
  return undefined;
}

function collectTaintedNames(file: ts.SourceFile): Map<string, ts.Node[]> {
  const tainted = new Map<string, ts.Node[]>();
  const add = (name: string, scope: ts.Node | undefined): void => {
    if (scope === undefined) return;
    tainted.set(name, [...(tainted.get(name) ?? []), scope]);
  };
  const addFromPattern = (
    pattern: ts.ObjectBindingPattern,
    source: ts.Expression | undefined,
    scope: ts.Node | undefined,
  ): void => {
    if (source !== undefined) {
      const src = unwrapExpr(source);
      if (!isErrorRef(src) || narrowedToCustomClass(src, src.text)) return;
    }
    for (const el of pattern.elements) {
      const key = el.propertyName ?? el.name;
      if (
        el.dotDotDotToken === undefined &&
        ts.isIdentifier(el.name) &&
        (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
        LEAKY_PROPS.has(key.text)
      ) {
        add(el.name.text, scope);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      addFromPattern(node.name, node.initializer, scopeOf(node, false));
    } else if (
      ts.isCatchClause(node) &&
      node.variableDeclaration !== undefined &&
      ts.isObjectBindingPattern(node.variableDeclaration.name)
    ) {
      addFromPattern(node.variableDeclaration.name, undefined, node.block);
    } else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      node.parent.expression.name.text === 'catch' &&
      node.parent.arguments[0] === node &&
      node.parameters[0] !== undefined &&
      ts.isObjectBindingPattern(node.parameters[0].name)
    ) {
      addFromPattern(node.parameters[0].name, undefined, node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left)
    ) {
      const src = unwrapExpr(node.right);
      if (isErrorRef(src) && !narrowedToCustomClass(src, src.text)) {
        for (const p of node.left.properties) {
          const key =
            ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p) ? p.name : undefined;
          const target = ts.isShorthandPropertyAssignment(p)
            ? p.name
            : ts.isPropertyAssignment(p)
              ? p.initializer
              : undefined;
          if (
            key !== undefined &&
            (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
            LEAKY_PROPS.has(key.text) &&
            target !== undefined &&
            ts.isIdentifier(target)
          ) {
            add(target.text, scopeOf(node, false));
          }
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'push' || node.expression.name.text === 'unshift') &&
      node.arguments.some((a) => bareErrorNodes(a).length > 0)
    ) {
      const target = node.expression.expression;
      if (ts.isIdentifier(target)) add(target.text, scopeOf(node, false));
      else if (
        ts.isPropertyAccessExpression(target) &&
        target.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        add(`this.${target.name.text}`, scopeOf(node, true));
      }
    }
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

function isCatchVariable(node: ts.Node, id: string): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (
      ts.isCatchClause(cur) &&
      cur.variableDeclaration !== undefined &&
      ts.isIdentifier(cur.variableDeclaration.name) &&
      cur.variableDeclaration.name.text === id
    ) {
      return true;
    }
  }
  return false;
}

function sinkArguments(node: ts.Node, rel: string): readonly ts.Node[] {
  if (ts.isCallExpression(node)) {
    if (isStderrWrite(node.expression)) return node.arguments;
    if (
      HTTP_FILES.has(rel) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'json' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'c'
    ) {
      return node.arguments;
    }
    const name = calleeName(node.expression);
    if (name !== undefined && CLONE_SINK_NAMES.has(name)) return node.arguments;
    if (rel === TOOLS_FILE && ts.isIdentifier(node.expression) && node.expression.text === 'text') {
      return node.arguments;
    }
  }
  if (ts.isObjectLiteralExpression(node) && HTTP_FILES.has(rel)) {
    return node.properties.flatMap((p) =>
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === 'error'
        ? [p.initializer]
        : [],
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    const isDeny = node.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ((ts.isIdentifier(p.name) && p.name.text === 'kind') ||
          (ts.isStringLiteral(p.name) && p.name.text === 'kind')) &&
        ts.isStringLiteralLike(p.initializer) &&
        p.initializer.text === 'deny',
    );
    if (isDeny) {
      return node.properties.flatMap((p) => {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'reason') {
          return [p.initializer];
        }
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'reason') return [p.name];
        return [];
      });
    }
  }
  return [];
}

// AST を作る前に口の語が無いソースを弾く: 全ファイルのパースと走査が、混んだ器で vitest の既定の 5 秒を超えたため。
const SINK_NEEDLES = ['stderr', 'writeStderrSync', ...CLONE_SINK_NAMES, 'deny'];

function mayContainSink(source: string, rel: string): boolean {
  if (HTTP_FILES.has(rel) || rel === TOOLS_FILE) return true;
  return SINK_NEEDLES.some((needle) => source.includes(needle));
}

function findBareErrorSinkWrites(source: string, rel = ''): BareErrorHit[] {
  if (!mayContainSink(source, rel)) return [];
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true);
  collectErrorAliases(file);
  const tainted = collectTaintedNames(file);
  const hits: BareErrorHit[] = [];
  const seen = new Set<string>();
  const report = (node: ts.Node, text: string): void => {
    // 重複を畳む: `c.json({ error: … })` は `c.json` の引数と `error` プロパティの両方から見えるため。
    const key = `${String(node.getStart(file))}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    hits.push({ line: line + 1, text });
  };
  const inspectIndirect = (node: ts.Node): void => {
    if (isRedactorCall(node)) return;
    const isLabel =
      (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
      (ts.isPropertyAssignment(node.parent) && node.parent.name === node);
    const asName =
      ts.isIdentifier(node) && !isLabel
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
    if (HTTP_FILES.has(rel) && ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        if (
          ts.isShorthandPropertyAssignment(p) &&
          p.name.text === 'error' &&
          isCatchVariable(p.name, 'error') &&
          !narrowedToCustomClass(p.name, 'error')
        ) {
          report(p.name, '{ error }（catch の変数そのもの）');
        }
      }
    }
    for (const arg of sinkArguments(node, rel)) {
      for (const bare of bareErrorNodes(arg)) report(bare, bare.getText(file));
      inspectIndirect(arg);
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

const count = (src: string, rel = ''): number => findBareErrorSinkWrites(src, rel).length;

describe('findBareErrorSinkWrites（純粋関数）: stderr', () => {
  const write = 'process.stderr.write';
  it('String(error) を stderr の引数に置く形を検出する', () => {
    const src = `${write}(\`x: \${String(error)}\\n\`);`;
    expect(count(src)).toBe(1);
  });
  it('error.message と複数行の引数も検出する', () => {
    const src = `${write}(\n  \`a（\${error.message}）\` +\n    'b',\n);`;
    const hits = findBareErrorSinkWrites(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });
  it('変数名が違っても（e / err）、テンプレートの素の ${error} も検出する', () => {
    expect(count(`${write}(\`\${String(err)}\`);`)).toBe(1);
    expect(count(`writeStderrSync(\`\${String(e)}\`);`)).toBe(1);
    expect(count(`${write}(\`\${error}\`);`)).toBe(1);
  });
  it('reasonOf を通した形・固定文言・stderr 以外への書き込みは検出しない', () => {
    expect(count(`${write}(\`x: \${reasonOf(error)}\`);`)).toBe(0);
    expect(count(`${write}('固定文言\\n');`)).toBe(0);
    expect(count(`process.stdout.write(\`\${String(error)}\`);`)).toBe(0);
    expect(count(`const s = String(error);`)).toBe(0);
  });
  it('一度変数へ入れてから書く形（const / this.#field）も検出する（#2538）', () => {
    const viaConst = `function f() { try {} catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ${write}(\`x: \${message}\\n\`);
    } }`;
    expect(count(viaConst)).toBe(1);
    const viaField = `class C { async f() { try {} catch (error) {
      this.#last = String(error);
      ${write}(\`x: \${this.#last}\\n\`);
    } } }`;
    expect(count(viaField)).toBe(1);
  });
  it('reasonOf を入れた変数・別の関数の同名の変数・stderr へ書かない変数は検出しない', () => {
    const okConst = `function f() { try {} catch (error) {
      const message = reasonOf(error);
      ${write}(\`x: \${message}\\n\`);
    } }`;
    expect(count(okConst)).toBe(0);
    const otherFn = `function a() { const message = String(error); return message; }
      function b(message: string) { ${write}(\`x: \${message}\\n\`); }`;
    expect(count(otherFn)).toBe(0);
    const notWritten = `function f() { const message = String(error); return { message }; }`;
    expect(count(notWritten)).toBe(0);
  });
});

describe('findBareErrorSinkWrites（純粋関数）: クローンへ届く口・deny の理由', () => {
  it('announce / postToClone（this.#・プロパティ経由も）の引数の素のエラーを検出する', () => {
    expect(count('announce(`x: ${String(error)}`);')).toBe(1);
    expect(count('postToClone(`x: ${error.message}`);')).toBe(1);
    expect(count('this.#announce(`x: ${err}`);')).toBe(1);
    expect(count('deps.announce(`x: ${String(e)}`);')).toBe(1);
    expect(count('announce(`x: ${reasonOf(error)}`);')).toBe(0);
    expect(count("announce('固定文言');")).toBe(0);
    expect(count('notify(`x: ${String(error)}`);')).toBe(0);
  });
  it('変数経由の形も新しい口で検出する', () => {
    const src = `function f() { try {} catch (error) {
      const why = String(error);
      announce(\`x: \${why}\`);
    } }`;
    expect(count(src)).toBe(1);
    expect(count(src.replace('String(error)', 'reasonOf(error)'))).toBe(0);
  });
  it('tools.ts の中の text(...) だけを口とみなす', () => {
    const src = 'return text(`x: ${String(error)}`);';
    expect(count(src, 'packages/core/src/tools.ts')).toBe(1);
    expect(count(src, 'packages/core/src/clone.ts')).toBe(0);
    expect(count(src)).toBe(0);
    expect(count('return text(`x: ${reasonOf(error)}`);', 'packages/core/src/tools.ts')).toBe(0);
    expect(count('return text("固定文言");', 'packages/core/src/tools.ts')).toBe(0);
  });
  it("kind: 'deny' を持つオブジェクトの reason の値を検出する", () => {
    expect(count("const d = { kind: 'deny', reason: `x: ${String(error)}` };")).toBe(1);
    expect(count("const d = { kind: 'deny', reason: error.message };")).toBe(1);
    expect(count("const d = { kind: 'deny', reason: `x: ${reasonOf(error)}` };")).toBe(0);
    expect(count("const d = { kind: 'allow', reason: `x: ${String(error)}` };")).toBe(0);
    expect(count("const d = { kind: 'deny', note: `x: ${String(error)}` };")).toBe(0);
    const viaVar = `function f() { try {} catch (error) {
      const reason = String(error);
      return { kind: 'deny', reason };
    } }`;
    expect(count(viaVar)).toBe(1);
  });
});

describe('findBareErrorSinkWrites（純粋関数）: 伏せ字を通した形', () => {
  it.each(['reasonOf', 'redactErrorText', 'redactSecretsInText', 'collapseErrorCause'])(
    '%s の引数の中の素のエラーは検出しない',
    (fn) => {
      expect(count(`announce(${fn}(String(error), process.env));`)).toBe(0);
      expect(count(`process.stderr.write(\`x: \${${fn}(error.message, env)}\`);`)).toBe(0);
      expect(count(`announce(\`x: \${${fn}(\`\${error}\`)}\`);`)).toBe(0);
    },
  );
  it('伏せ字の呼び出しの外に残った素のエラーは検出する', () => {
    expect(count('announce(redactErrorText(String(error), env) + String(error));')).toBe(1);
  });
  it('伏せ字を通した値を入れた変数は検出しない', () => {
    const src = `function f() { try {} catch (error) {
      const reason = redactErrorText(String(error), process.env);
      announce(\`x: \${reasonOf(reason)} \${reason}\`);
    } }`;
    expect(count(src)).toBe(0);
  });
});

describe('findBareErrorSinkWrites（純粋関数）: 型で絞った自前の例外', () => {
  const sink = 'announce';
  it('自前の Class で絞った if の then 側・三項の真の側は検出しない', () => {
    const ifThen = `function f() { try {} catch (error) {
      if (error instanceof TokenPoolInputError) { ${sink}(error.message); }
    } }`;
    expect(count(ifThen)).toBe(0);
    const ifBare = `function f() { try {} catch (error) {
      if (error instanceof TokenPoolInputError) ${sink}(\`x: \${String(error)}\`);
    } }`;
    expect(count(ifBare)).toBe(0);
    const ternary = `${sink}(error instanceof TokenPoolInputError ? error.message : '固定');`;
    expect(count(ternary)).toBe(0);
    const andChain = `${sink}(ok && error instanceof TokenPoolInputError ? error.message : '固定');`;
    expect(count(andChain)).toBe(0);
  });
  it('変数へ入れる式が型で絞った枝の中なら、その変数も検出しない', () => {
    const src = `function f() { try {} catch (error) {
      const m = error instanceof TokenPoolInputError ? error.message : '固定';
      ${sink}(m);
    } }`;
    expect(count(src)).toBe(0);
  });
  it('instanceof Error で絞った形は検出する（対照）', () => {
    expect(count(`${sink}(error instanceof Error ? error.message : '固定');`)).toBe(1);
    const ifThen = `function f() { try {} catch (error) {
      if (error instanceof Error) { ${sink}(error.message); }
    } }`;
    expect(count(ifThen)).toBe(1);
  });
  it('偽の側・else 側・別の識別子で絞った形・|| で繋いだ形は絞りとみなさない', () => {
    expect(count(`${sink}(error instanceof TokenPoolInputError ? '固定' : error.message);`)).toBe(
      1,
    );
    const elseSide = `function f() { try {} catch (error) {
      if (error instanceof TokenPoolInputError) { return; } else { ${sink}(error.message); }
    } }`;
    expect(count(elseSide)).toBe(1);
    expect(count(`${sink}(other instanceof TokenPoolInputError ? error.message : '固定');`)).toBe(
      1,
    );
    expect(
      count(`${sink}(a || error instanceof TokenPoolInputError ? error.message : '固定');`),
    ).toBe(1);
  });
});

describe('findBareErrorSinkWrites（純粋関数）: HTTP の応答（#2570）', () => {
  const daemon = 'apps/daemon/src/app.ts';
  const runner = 'apps/runner/src/app.ts';
  it('c.json(...) の引数の素のエラーを、対象の2ファイルだけで検出する', () => {
    const src = 'return c.json({ error: error.message }, 400);';
    expect(count(src, daemon)).toBe(1);
    expect(count(src, runner)).toBe(1);
    expect(count('return c.json({ ok: false, why: `${String(err)}` });', daemon)).toBe(1);
    expect(count('return c.json({ error: reasonOf(error) }, 400);', daemon)).toBe(0);
    expect(count("return c.json({ error: 'not found' as const }, 404);", daemon)).toBe(0);
  });
  it('対象外のファイル・rel 無しでは c.json も error プロパティも見ない（対照）', () => {
    const src = 'return c.json({ error: error.message }, 400);';
    expect(count(src, 'apps/daemon/src/index.ts')).toBe(0);
    expect(count(src, 'packages/core/src/tools.ts')).toBe(0);
    expect(count(src)).toBe(0);
    expect(count('results.push({ id, error: error.message });', 'apps/daemon/src/other.ts')).toBe(
      0,
    );
  });
  it('c.json 以外の呼び出し（c.req.json() など）は口とみなさない', () => {
    expect(count('const b = c.req.json(String(error));', daemon)).toBe(0);
    expect(count('res.json({ x: error.message });', daemon)).toBe(0);
  });
  it('error プロパティの値を、配列へ積む形でも検出する', () => {
    expect(count('results.push({ id, ok: false, error: error.message });', daemon)).toBe(1);
    expect(count("const r = { 'error': `${err}` };", daemon)).toBe(1);
    expect(count('results.push({ id, ok: false, error: reasonOf(error) });', daemon)).toBe(0);
    expect(count('results.push({ id, ok: false, message: error.message });', daemon)).toBe(0);
  });
  it('c.json の中の error プロパティは二重に数えない', () => {
    expect(count('return c.json({ error: error.message }, 400);', daemon)).toBe(1);
  });
  it('省略形の { error } は catch の変数そのものなら検出する', () => {
    const bare = `function f() { try {} catch (error) { results.push({ id, error }); } }`;
    expect(count(bare, daemon)).toBe(1);
    const other = `function f(error: string) { results.push({ id, error }); }`;
    expect(count(other, daemon)).toBe(0);
    const narrowed = `function f() { try {} catch (error) {
      if (error instanceof TokenPoolInputError) results.push({ id, error });
    } }`;
    expect(count(narrowed, daemon)).toBe(0);
  });
  it(".name === '<リテラル>' で絞った枝は検出しない", () => {
    const tern =
      "error instanceof Error && error.name === 'InvalidApprovalSelectionsError' ? error.message : reasonOf(error)";
    expect(count(`return c.json({ error: ${tern} }, 400);`, daemon)).toBe(0);
    const ifThen = `function f() { try {} catch (error) {
      if (error instanceof Error && error.name === 'InvalidApprovalSelectionsError') {
        return c.json({ error: error.message }, 400);
      }
    } }`;
    expect(count(ifThen, daemon)).toBe(0);
    expect(
      count(
        "c.json({ error: error.name == 'InvalidApprovalSelectionsError' ? error.message : '固定' });",
        daemon,
      ),
    ).toBe(0);
    expect(
      count(
        "c.json({ error: ok && 'InvalidApprovalSelectionsError' === error.name ? error.message : '固定' });",
        daemon,
      ),
    ).toBe(0);
  });
  it(".name を 'Error' と比べる形・別の識別子・偽の側・!== は絞りとみなさない（対照）", () => {
    expect(
      count("c.json({ error: error.name === 'Error' ? error.message : '固定' });", daemon),
    ).toBe(1);
    expect(
      count(
        "c.json({ error: other.name === 'InvalidApprovalSelectionsError' ? error.message : '固定' });",
        daemon,
      ),
    ).toBe(1);
    expect(
      count(
        "c.json({ error: error.name === 'InvalidApprovalSelectionsError' ? '固定' : error.message });",
        daemon,
      ),
    ).toBe(1);
    expect(
      count(
        "c.json({ error: error.name !== 'InvalidApprovalSelectionsError' ? error.message : '固定' });",
        daemon,
      ),
    ).toBe(1);
    expect(count("c.json({ error: error.name === kind ? error.message : '固定' });", daemon)).toBe(
      1,
    );
  });
  it('早期に抜ける形（if (!(error instanceof X)) throw / return）の後の文は検出しない', () => {
    const early = (guard: string): string => `function f() { try {} catch (error) {
      ${guard}
      results.push({ id, ok: false, error: error.message });
    } }`;
    expect(count(early('if (!(error instanceof TokenPoolInputError)) throw error;'), daemon)).toBe(
      0,
    );
    expect(count(early('if (!(error instanceof TokenPoolInputError)) { return; }'), daemon)).toBe(
      0,
    );
    expect(
      count(early("if (!(error.name === 'InvalidApprovalSelectionsError')) throw error;"), daemon),
    ).toBe(0);
    expect(
      count(early('if (!(error instanceof TokenPoolInputError) || !ok) throw error;'), daemon),
    ).toBe(0);
  });
  it('早期に抜ける形の対照: instanceof Error・抜けない・別の識別子・前に無い文は検出する', () => {
    const early = (guard: string): string => `function f() { try {} catch (error) {
      ${guard}
      results.push({ id, ok: false, error: error.message });
    } }`;
    expect(count(early('if (!(error instanceof Error)) throw error;'), daemon)).toBe(1);
    expect(count(early("if (!(error.name === 'Error')) throw error;"), daemon)).toBe(1);
    expect(count(early('if (!(error instanceof TokenPoolInputError)) log(error);'), daemon)).toBe(
      1,
    );
    expect(count(early('if (!(other instanceof TokenPoolInputError)) throw error;'), daemon)).toBe(
      1,
    );
    expect(count(early('if (error instanceof TokenPoolInputError) throw error;'), daemon)).toBe(1);
    expect(
      count(early('if (!(error instanceof TokenPoolInputError)) throw error; else log();'), daemon),
    ).toBe(1);
    const after = `function f() { try {} catch (error) {
      results.push({ id, ok: false, error: error.message });
      if (!(error instanceof TokenPoolInputError)) throw error;
    } }`;
    expect(count(after, daemon)).toBe(1);
  });
});

describe('findBareErrorSinkWrites（純粋関数）: 広げた形・catch の束縛・許可リスト（#2606）', () => {
  const write = 'process.stderr.write';
  it.each([
    ['.stack', `${write}(error.stack);`],
    ['.stack（テンプレート）', `${write}(\`x: \${error.stack}\`);`],
    ['.cause', `${write}(\`x: \${error.cause}\`);`],
    ['toString()', `${write}(error.toString());`],
    ['+ の右辺', `${write}('x ' + error);`],
    ['+ の左辺', `${write}(error + ' x');`],
    ['JSON.stringify', `${write}(JSON.stringify(error));`],
    ["['message']", `${write}(error['message']);`],
    ["['stack']", `${write}(error["stack"]);`],
  ])('%s を検出する', (_label, src) => {
    expect(count(src)).toBe(1);
  });
  it('新しい形も、変数へ入れてから書く形で検出する', () => {
    const src = (init: string): string => `function f() { try {} catch (error) {
      const s = ${init};
      ${write}(s);
    } }`;
    expect(count(src('error.stack'))).toBe(1);
    expect(count(src('error.toString()'))).toBe(1);
    expect(count(src('JSON.stringify(error)'))).toBe(1);
    expect(count(src("'x ' + error"))).toBe(1);
  });
  it('伏せ字を通した新しい形は検出しない', () => {
    expect(count(`${write}(reasonOf(error.stack));`)).toBe(0);
    expect(count(`${write}(redactErrorText(JSON.stringify(error), env));`)).toBe(0);
    expect(count(`${write}(reasonOf(error) + ' x');`)).toBe(0);
    expect(count(`${write}(error.name);`)).toBe(0);
    expect(count(`${write}('x' + 'y');`)).toBe(0);
  });
  it('catch の束縛は名前を問わず検出する（一覧に無い名前）', () => {
    const inCatch = (name: string, body: string): string =>
      `function f() { try {} catch (${name}) { ${body} } }`;
    expect(count(inCatch('caught', `${write}(String(caught));`))).toBe(1);
    expect(count(inCatch('boom', `${write}(\`\${boom.message}\`);`))).toBe(1);
    expect(count(inCatch('ex', `${write}(ex.stack);`))).toBe(1);
    expect(count(inCatch('thrown', `announce('x ' + thrown);`))).toBe(1);
    expect(count(inCatch('oops', `const m = String(oops); announce(m);`))).toBe(1);
  });
  it('.catch((x) => …) の引数も、名前を問わず検出する', () => {
    expect(count(`p.catch((caught) => ${write}(String(caught)));`)).toBe(1);
    expect(count(`p.catch(function (boom) { ${write}(boom.stack); });`)).toBe(1);
  });
  it('束縛の外・別の名前の読みは検出しない（対照）', () => {
    const outside = `function f() { try {} catch (caught) {}
      const caught = 'x'; ${write}(String(caught)); }`;
    expect(count(outside)).toBe(0);
    const otherName = `function f() { try {} catch (caught) { ${write}(String(other)); } }`;
    expect(count(otherName)).toBe(0);
    expect(count(`p.then((value) => ${write}(String(value)));`)).toBe(0);
  });
  it('許可リストにない自前のクラスで絞った枝は検出する', () => {
    const sink = 'announce';
    expect(ALLOWED_CUSTOM_CLASSES.has('SomeUnlistedError')).toBe(false);
    expect(count(`${sink}(error instanceof SomeUnlistedError ? error.message : '固定');`)).toBe(1);
    const ifThen = `function f() { try {} catch (error) {
      if (error instanceof SomeUnlistedError) { ${sink}(error.stack); }
    } }`;
    expect(count(ifThen)).toBe(1);
    expect(count(`${sink}(error instanceof TokenPoolInputError ? error.message : '固定');`)).toBe(
      0,
    );
  });
  it('許可リストにない .name のリテラルで絞った枝は検出する', () => {
    const daemon = 'apps/daemon/src/app.ts';
    expect(ALLOWED_NAME_LITERALS.has('SomeUnlistedError')).toBe(false);
    expect(
      count("c.json({ error: error.name === 'SomeUnlistedError' ? error.message : '' });", daemon),
    ).toBe(1);
    expect(
      count(
        "c.json({ error: error.name === 'InvalidApprovalSelectionsError' ? error.message : '' });",
        daemon,
      ),
    ).toBe(0);
    const early = `function f() { try {} catch (error) {
      if (!(error.name === 'SomeUnlistedError')) throw error;
      results.push({ id, ok: false, error: error.message });
    } }`;
    expect(count(early, daemon)).toBe(1);
  });
});

describe('findBareErrorSinkWrites（純粋関数）: 別名・分割代入・配列（#2621）', () => {
  const write = 'process.stderr.write';
  const inCatch = (body: string): string => `function f() { try {} catch (error) { ${body} } }`;
  it('別名（const / 代入 / 連鎖 / 型表明つき）を通した文字列化を検出する', () => {
    expect(count(inCatch(`const e2 = error; ${write}(String(e2));`))).toBe(1);
    expect(count(inCatch(`const e2 = error; ${write}(e2.message);`))).toBe(1);
    expect(count(inCatch(`const e2 = error; ${write}(\`x \${e2}\`);`))).toBe(1);
    expect(count(inCatch(`let e2; e2 = error; ${write}(e2.stack);`))).toBe(1);
    expect(count(inCatch(`const e2 = error; const e3 = e2; ${write}(String(e3));`))).toBe(1);
    expect(count(inCatch(`const e2 = error as Error; ${write}(e2.message);`))).toBe(1);
    expect(count(inCatch(`const e2 = (error as Error); announce(String(e2));`))).toBe(1);
    expect(count(inCatch(`const e2 = error; const m = e2.message; ${write}(m);`))).toBe(1);
  });
  it('別名の陰性対照: 伏せ字を通す・別の関数の同名・エラーでない値の別名・絞った枝は検出しない', () => {
    expect(count(inCatch(`const e2 = error; ${write}(reasonOf(e2));`))).toBe(0);
    expect(count(inCatch(`const e2 = error; ${write}(e2.name);`))).toBe(0);
    expect(count(inCatch(`const e2 = other; ${write}(String(e2));`))).toBe(0);
    expect(
      count(
        `function a() { try {} catch (error) { const e2 = error; } }
         function b(e2: unknown) { ${write}(String(e2)); }`,
      ),
    ).toBe(0);
    expect(
      count(
        inCatch(
          `if (error instanceof TokenPoolInputError) { const e2 = error; ${write}(e2.message); }`,
        ),
      ),
    ).toBe(0);
    expect(count(inCatch(`const e2 = error; ${write}('固定');`))).toBe(0);
  });
  it('分割代入（message / stack / 別名つき / catch の束縛 / 代入）を通した値を検出する', () => {
    expect(count(inCatch(`const { message } = error; ${write}(message);`))).toBe(1);
    expect(count(inCatch(`const { message, stack } = error; ${write}(\`\${stack}\`);`))).toBe(1);
    expect(count(inCatch(`const { message: m } = error; announce(m);`))).toBe(1);
    expect(count(inCatch(`const { stack: s = '' } = error; ${write}(s);`))).toBe(1);
    expect(count(inCatch(`let message; ({ message } = error); ${write}(message);`))).toBe(1);
    expect(count(inCatch(`const e2 = error; const { message } = e2; ${write}(message);`))).toBe(1);
    expect(count(`try {} catch ({ message }) { ${write}(message); }`)).toBe(1);
    expect(count(`p.catch(({ message }) => ${write}(message));`)).toBe(1);
  });
  it('分割代入の陰性対照: name だけ・伏せ字を通す・エラーでない値・別の関数・絞った枝は検出しない', () => {
    expect(count(inCatch(`const { name } = error; ${write}(name);`))).toBe(0);
    expect(count(inCatch(`const { message } = error; ${write}(reasonOf(message));`))).toBe(0);
    expect(count(inCatch(`const { message } = other; ${write}(message);`))).toBe(0);
    expect(count(inCatch(`const { message } = error; ${write}('固定');`))).toBe(0);
    expect(
      count(
        `function a() { try {} catch (error) { const { message } = error; } }
         function b(message: string) { ${write}(message); }`,
      ),
    ).toBe(0);
    expect(
      count(
        inCatch(
          `if (error instanceof TokenPoolInputError) { const { message } = error; ${write}(message); }`,
        ),
      ),
    ).toBe(0);
    expect(
      count(inCatch(`const { message } = error; ${write}(JSON.stringify({ message: 'x' }));`)),
    ).toBe(0);
  });
  it('配列へ入れて join する形（プロパティアクセスの左辺の読み）を検出する', () => {
    expect(count(inCatch(`const lines = [String(error)]; ${write}(lines.join());`))).toBe(1);
    expect(count(inCatch(`const lines = ['x', error.message]; ${write}(lines.join(','));`))).toBe(
      1,
    );
    expect(
      count(inCatch(`const lines = []; lines.push(String(error)); ${write}(lines.join());`)),
    ).toBe(1);
    expect(count(inCatch(`let lines; lines = [String(error)]; announce(lines.join(' '));`))).toBe(
      1,
    );
    expect(count(inCatch(`const lines = [String(error)]; ${write}(lines[0]);`))).toBe(1);
    expect(count(inCatch(`const m = String(error); ${write}(m.slice(0, 80));`))).toBe(1);
    const viaField = `class C { f() { try {} catch (error) {
      this.#lines = [String(error)]; ${write}(this.#lines.join());
    } } }`;
    expect(count(viaField)).toBe(1);
  });
  it('配列の陰性対照: 伏せ字を通す・固定文言・書かない・別の関数は検出しない', () => {
    expect(count(inCatch(`const lines = [reasonOf(error)]; ${write}(lines.join());`))).toBe(0);
    expect(
      count(inCatch(`const lines = []; lines.push(reasonOf(error)); ${write}(lines.join());`)),
    ).toBe(0);
    expect(count(inCatch(`const lines = ['固定']; ${write}(lines.join());`))).toBe(0);
    expect(count(inCatch(`const lines = [String(error)]; log(lines.join());`))).toBe(0);
    expect(
      count(
        `function a() { try {} catch (error) { const lines = [String(error)]; } }
         function b(lines: string[]) { ${write}(lines.join()); }`,
      ),
    ).toBe(0);
  });
});

describe('findBareErrorSinkWrites: 語の事前判定（#3006）', () => {
  it('口の語が1つも無いソースは、素のエラーの文字列化が在っても走査しない（口が無いので 0 件）', () => {
    const body = 'try { f(); } catch (error) { const m = String(error); g(m); }';
    expect(count(body)).toBe(0);
    expect(count(`${body} process.stderr.write(String(error));`)).toBe(1);
  });

  it('語の事前判定は、各種の口の語（stderr / writeStderrSync / announce / postToClone / deny）を落とさない', () => {
    expect(count('try {} catch (e) { writeStderrSync(String(e)); }')).toBe(1);
    expect(count('try {} catch (e) { announce(String(e)); }')).toBe(1);
    expect(count('try {} catch (e) { postToClone(String(e)); }')).toBe(1);
    expect(count("try {} catch (e) { return { kind: 'deny', reason: String(e) }; }")).toBe(1);
  });
});

describe('外へ出る口へ置く例外の文は reasonOf / redactErrorText を通す（#2512 / #2538 / #2565）', () => {
  it('stderr・announce・postToClone・tools.ts の text・deny の理由に、素の String(error) / error.message が無い（HTTP の応答は daemon / runner の app.ts、#2570）', () => {
    const files = collectRepoFiles(ROOT, EXCLUDE_DIRS).filter(isScannedSource);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((rel) =>
      findBareErrorSinkWrites(readFileSync(path.join(ROOT, rel), 'utf8'), rel).map(
        (hit) => `${rel}:${String(hit.line)}  ${hit.text}`,
      ),
    );
    expect(
      offenders,
      '素のエラーの文字列化が外へ出ている。reasonOf(error)（packages/core/src/dropped-record.ts）か redactErrorText を通すこと（使い分けは両方の doc）',
    ).toEqual([]);
    // この1本だけ上限を15秒にする: 全ファイルのパースと走査は、混んだ器で既定の5秒に迫るため。
  }, 15_000);
});
