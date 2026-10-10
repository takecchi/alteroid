import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 正規表現ではなく TypeScript の AST を読む: 生テキストだと `requireOperator` を含む散文を配線と読み違える誤爆の工場になり、歯を弱める方向へ誘導されるため。
// `*-core.mjs` に切り出さず `.test.ts` に直書きする: vitest 専用の突き合わせで、他から叩く理由が無いため。
// `requireOperator` の参照数を別ルートで数えて経路数と検算する: 抽出が新しい配線の書き方を拾い損ねても、黙って緑のままになるため。
// `EXPECTED_OPERATOR_ROUTES` と `EXPECTED_OWNER_ROUTES` の両方を同時に見る: 強い門から弱い門へ経路が移っても合計本数では分からないため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_TS_PATH = path.join(ROOT, 'apps/daemon/src/app.ts');

const OPERATOR_MIDDLEWARE_NAME = 'requireOperator';

const OWNER_MIDDLEWARE_NAME = 'requireOwner';

const HTTP_METHOD_NAMES = new Set(['get', 'post', 'put', 'delete', 'patch']);

export interface RouteDeclaration {
  route: string;
  wired: boolean;
}

// `setParentNodes: true` を渡す: `countRequireOperatorReferences` が `node.parent` を読むため。
function parseSource(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function findRouteDeclarations(
  sourceText: string,
  fileName = 'app.ts',
  middlewareName: string = OPERATOR_MIDDLEWARE_NAME,
): RouteDeclaration[] {
  const sourceFile = parseSource(sourceText, fileName);
  const routes: RouteDeclaration[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      HTTP_METHOD_NAMES.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text;
      const firstArg = node.arguments[0];
      if (firstArg !== undefined && ts.isStringLiteral(firstArg) && firstArg.text.startsWith('/')) {
        // 完全一致にする: `requireOperatorOrDirectGrant` は `requireOperator` を接頭辞に持ち、前方一致だと2つの門が畳まれるため。
        const wired = node.arguments.some(
          (arg) => ts.isIdentifier(arg) && arg.text === middlewareName,
        );
        routes.push({ route: `${method.toUpperCase()} ${firstArg.text}`, wired });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
}

export function findOperatorWiredRoutes(sourceText: string, fileName = 'app.ts'): string[] {
  return findRouteDeclarations(sourceText, fileName, OPERATOR_MIDDLEWARE_NAME)
    .filter((entry) => entry.wired)
    .map((entry) => entry.route);
}

export function findOwnerWiredRoutes(sourceText: string, fileName = 'app.ts'): string[] {
  return findRouteDeclarations(sourceText, fileName, OWNER_MIDDLEWARE_NAME)
    .filter((entry) => entry.wired)
    .map((entry) => entry.route);
}

export function countRequireOperatorReferences(
  sourceText: string,
  fileName = 'app.ts',
  middlewareName: string = OPERATOR_MIDDLEWARE_NAME,
): number {
  const sourceFile = parseSource(sourceText, fileName);
  let count = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === middlewareName) {
      const isDeclarationName = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!isDeclarationName) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

// 一覧を変えたら `docs/architecture.md` の表も直す必要があるが、`docs/` は正典で AI が単独で書き換えないため、人間へ上げる。この歯は doc を検査しない。
const EXPECTED_OPERATOR_ROUTES = [
  'POST /access/:accountId/owner',
  'POST /access/:accountId/owner/revoke',
];

// ここへ経路を足すのは `requireOperator` から外すのと同じ重さの判断: 足す前に `docs/architecture.md` と食い違わないかを人間へ上げる。
// /codex の書く3口は 2026-10-07 オーナー確認済み。資格を書く口なので PUT /credentials と揃える。
// DELETE /conversations/:id は 2026-10-08 のオーナーの依頼で `/reset` と同じ門にする。
const EXPECTED_OWNER_ROUTES = [
  'DELETE /conversations/:id',
  'DELETE /plugins/:name',
  'DELETE /codex/auth',
  'DELETE /codex/login/:id',
  'DELETE /profile/:name',
  'POST /codex/login',
  // クローンの文脈の連続性を切る口なので、POST /reset と揃える。
  'POST /clone/session/reopen',
  'GET /mcp-servers',
  'GET /plugins',
  'GET /profile',
  'POST /plugins',
  'POST /plugins/preview',
  'POST /reset',
  'PUT /credentials',
  'PUT /mcp-servers',
  'PUT /profile',
  'PUT /profile/:name',
];

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

const FIXTURE_TWO_ROUTES = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  .get(
    '/health',
    (c) => c.json({ ok: true }),
  )
  .get(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .put(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  );
`;

const FIXTURE_THREE_ROUTES = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  .get(
    '/health',
    (c) => c.json({ ok: true }),
  )
  .get(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .put(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .delete(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  );
`;

const FIXTURE_ONE_ROUTE = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  .get(
    '/health',
    (c) => c.json({ ok: true }),
  )
  .get(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .put(
    '/profile',
    (c) => c.json({}),
  );
`;

const FIXTURE_COMMENT_ONLY = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });

/**
 * 実行環境の持ち主だけに絞る門（本物の app.ts には実在するが、この fixture では
 * どの経路にも配線しない——コメントに名前だけ現れる状態を再現する）。
 */
const requireOperator = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  /**
   * 資格は authenticate だけ（requireOperator は付けない）。
   */
  .get(
    '/tokens',
    authenticate,
    (c) => c.json({}),
  );
`;

const FIXTURE_BOTH_GATES = `
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';

const base = new Hono();
const authenticate = createMiddleware(async (c, next) => { await next(); });
const requireOperator = createMiddleware(async (c, next) => { await next(); });
const requireOperatorOrDirectGrant = createMiddleware(async (c, next) => { await next(); });

export const app = base
  .use('*', authenticate)
  .get(
    '/profile',
    requireOperator,
    (c) => c.json({}),
  )
  .put(
    '/credentials',
    requireOperatorOrDirectGrant,
    (c) => c.json({}),
  )
  .post(
    '/reset',
    requireOperatorOrDirectGrant,
    (c) => c.json({}),
  );
`;

describe('2つの門（requireOperator / requireOwner）の配線が、決め打ちの一覧と一致する', () => {
  const appTsSource = readFileSync(APP_TS_PATH, 'utf8');

  it('前提: apps/daemon/src/app.ts が読める', () => {
    expect(appTsSource.length).toBeGreaterThan(0);
  });

  it('本物: 抽出した集合がリテラル一覧と一致する（ズレたら app.ts かこのテストのどちらかを直す）', () => {
    const extracted = sorted(findOperatorWiredRoutes(appTsSource));
    const expected = sorted(EXPECTED_OPERATOR_ROUTES);

    const missing = expected.filter((route) => !extracted.includes(route));
    const extra = extracted.filter((route) => !expected.includes(route));

    expect(
      { extracted, missing, extra },
      missing.length === 0 && extra.length === 0
        ? ''
        : [
            missing.length > 0
              ? `リテラル一覧に在るが配線から消えた経路: ${missing.join(', ')}`
              : '',
            extra.length > 0
              ? `配線に新しく現れたがリテラル一覧に無い経路: ${extra.join(', ')}`
              : '',
            'app.ts の requireOperator の配線が変わったなら、このファイルの ' +
              'EXPECTED_OPERATOR_ROUTES を直し、docs/architecture.md の「通る資格は3種類である」の ' +
              '表も直す必要がないか人間へ確認すること（この歯は doc を検査していない）。',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
    ).toEqual({ extracted: expected, missing: [], extra: [] });
  });

  it('本物: requireOperator の参照数（宣言を除く）が、経路へ紐付けられた数と一致する（抽出漏れの検算）', () => {
    const wiredCount = findOperatorWiredRoutes(appTsSource).length;
    const referenceCount = countRequireOperatorReferences(appTsSource);

    expect(
      referenceCount,
      referenceCount === wiredCount
        ? ''
        : `requireOperator の参照数（${referenceCount}）と、経路として拾えた数（${wiredCount}）が ` +
            '一致しない。配線が在るのに経路として拾えていない可能性が高い —— ' +
            '「配線が増えた」ではなく「抽出の定義が現物に追いついていない」と読むこと ' +
            '（findRouteDeclarations の CallExpression の条件を app.ts の現物と見比べること）。',
    ).toBe(wiredCount);
  });

  it('合成 fixture: 経路を1本足すと抽出結果も1本増える', () => {
    const before = sorted(findOperatorWiredRoutes(FIXTURE_TWO_ROUTES));
    const after = sorted(findOperatorWiredRoutes(FIXTURE_THREE_ROUTES));

    expect(before).toEqual(['GET /profile', 'PUT /profile']);
    expect(after).toEqual(['DELETE /profile', 'GET /profile', 'PUT /profile']);
  });

  it('合成 fixture: 経路を1本消すと抽出結果も1本減る', () => {
    const before = sorted(findOperatorWiredRoutes(FIXTURE_TWO_ROUTES));
    const after = sorted(findOperatorWiredRoutes(FIXTURE_ONE_ROUTE));

    expect(before).toEqual(['GET /profile', 'PUT /profile']);
    expect(after).toEqual(['GET /profile']);
  });

  it('合成 fixture: コメントの中の requireOperator を配線と読み違えない（AST を採った理由そのものの検証）', () => {
    expect(findOperatorWiredRoutes(FIXTURE_COMMENT_ONLY)).toEqual([]);
    expect(countRequireOperatorReferences(FIXTURE_COMMENT_ONLY)).toBe(0);
  });

  it('本物: requireOwner の配線がリテラル一覧と一致する', () => {
    const extracted = sorted(findOwnerWiredRoutes(appTsSource));
    const expected = sorted(EXPECTED_OWNER_ROUTES);

    const missing = expected.filter((route) => !extracted.includes(route));
    const extra = extracted.filter((route) => !expected.includes(route));

    expect(
      { extracted, missing, extra },
      missing.length === 0 && extra.length === 0
        ? ''
        : [
            missing.length > 0
              ? `リテラル一覧に在るが配線から消えた経路: ${missing.join(', ')}`
              : '',
            extra.length > 0
              ? `配線に新しく現れたがリテラル一覧に無い経路: ${extra.join(', ')}`
              : '',
            'この門を1本増やすことは、requireOperator から1本外すのと同じ重さの判断である。' +
              'EXPECTED_OWNER_ROUTES を直す前に、docs/architecture.md の「実行環境の持ち主だけ」の' +
              '段落と食い違わないかを人間へ確認すること（この歯は doc を検査していない）。',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
    ).toEqual({ extracted: expected, missing: [], extra: [] });
  });

  it('本物: requireOwner の参照数（宣言を除く）が、経路へ紐付けられた数と一致する（抽出漏れの検算）', () => {
    const wiredCount = findOwnerWiredRoutes(appTsSource).length;
    const referenceCount = countRequireOperatorReferences(appTsSource, 'app.ts', 'requireOwner');

    expect(
      referenceCount,
      `requireOwner の参照数（${referenceCount}）と、経路として拾えた数` +
        `（${wiredCount}）が一致しない。配線が在るのに経路として拾えていない可能性が高い。`,
    ).toBe(wiredCount);
  });

  it('合成 fixture: 接頭辞が衝突する名前でも、完全一致の抽出は取り違えない', () => {
    // `findOwnerWiredRoutes` は使わない: 現物の名前 `requireOwner` に固定した関数で、fixture の衝突名 `requireOperatorOrDirectGrant` を扱えないため。
    expect(findOperatorWiredRoutes(FIXTURE_BOTH_GATES)).toEqual(['GET /profile']);
    const collidingWired = findRouteDeclarations(
      FIXTURE_BOTH_GATES,
      'app.ts',
      'requireOperatorOrDirectGrant',
    )
      .filter((entry) => entry.wired)
      .map((entry) => entry.route);
    expect(sorted(collidingWired)).toEqual(['POST /reset', 'PUT /credentials']);
    expect(countRequireOperatorReferences(FIXTURE_BOTH_GATES)).toBe(1);
    expect(
      countRequireOperatorReferences(FIXTURE_BOTH_GATES, 'app.ts', 'requireOperatorOrDirectGrant'),
    ).toBe(2);
  });
});
