import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CODEX_CLIENT_REQUESTS,
  CODEX_ITEM_TYPES,
  CODEX_PROTOCOL_VERSION,
  CODEX_SCHEMA_ENUMS,
  CODEX_SCHEMA_USES,
  CODEX_SERVER_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  CODEX_UNHANDLED_SERVER_REQUEST_METHODS,
  isCodexServerNotificationMethod,
  isCodexServerRequestMethod,
} from './codex-protocol.js';

/**
 * 手書きの薄い型（`codex-protocol.ts`）が、コミットした生成スキーマ
 * （`codex app-server generate-json-schema` の束。`packages/core/codex-schema/<版>/`）に
 * 実在するメソッド・欄・列挙値だけを触っていることを確かめる。
 *
 * スキーマを読んで突き合わせるだけで、codex の実行も、ネットワークも、新しい依存も要らない。
 * ajv（JSON Schema の検証器）は直接の依存ではなく（MCP SDK が連れてくる推移的依存）、
 * 「各メッセージをスキーマで検証する」ところまでは行かない——ここが測るのは
 * 名前と必須性と列挙値の実在であって、値の型（string か integer か）ではない。
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface SchemaNode {
  $ref?: string;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  enum?: Json[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  definitions?: Record<string, SchemaNode>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(
  here,
  '..',
  'codex-schema',
  CODEX_PROTOCOL_VERSION,
  'codex_app_server_protocol.schemas.json',
);
const bundle = JSON.parse(readFileSync(schemaPath, 'utf8')) as SchemaNode;
const definitions = bundle.definitions as Record<string, SchemaNode>;
const v2 = definitions['v2'] as unknown as Record<string, SchemaNode>;

/** `Foo`（ルート）または `v2/Foo`（v2）で定義を引く。 */
function def(name: string): SchemaNode | undefined {
  return name.startsWith('v2/') ? v2[name.slice(3)] : definitions[name];
}

function refName(ref: string | undefined): string | undefined {
  return ref?.replace('#/definitions/', '');
}

function branches(node: SchemaNode): SchemaNode[] {
  return node.oneOf ?? node.anyOf ?? [];
}

/** 判別共用体の枝（`properties[key].enum` が value を含むもの）。 */
function findVariant(node: SchemaNode, key: string, value: string): SchemaNode | undefined {
  return branches(node).find((b) => b.properties?.[key]?.enum?.includes(value) === true);
}

/** 定義（または枝）が列挙する文字列値をすべて集める（`oneOf` / `anyOf` の入れ子も辿る）。 */
function stringEnumValues(node: SchemaNode): string[] {
  const own = (node.enum ?? []).filter((v): v is string => typeof v === 'string');
  return [...own, ...branches(node).flatMap(stringEnumValues)];
}

function methodsOf(union: SchemaNode): Map<string, SchemaNode> {
  const out = new Map<string, SchemaNode>();
  for (const b of branches(union)) {
    const method = b.properties?.['method']?.enum?.[0];
    if (typeof method === 'string') out.set(method, b);
  }
  return out;
}

describe('生成スキーマの置き場', () => {
  it('コミットしたスキーマは CODEX_PROTOCOL_VERSION の1版だけ', () => {
    const root = path.join(here, '..', 'codex-schema');
    expect(readdirSync(root)).toEqual([CODEX_PROTOCOL_VERSION]);
  });

  it('固定した @openai/codex の版が CODEX_PROTOCOL_VERSION と一致する', () => {
    const require = createRequire(import.meta.url);
    const pkg = JSON.parse(readFileSync(require.resolve('@openai/codex/package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe(CODEX_PROTOCOL_VERSION);
  });

  it('JSON-RPC の封筒に jsonrpc の欄は無い（送らない・要求しない）', () => {
    for (const name of [
      'JSONRPCRequest',
      'JSONRPCNotification',
      'JSONRPCResponse',
      'JSONRPCError',
    ]) {
      const node = def(name);
      expect(node, name).toBeDefined();
      expect(Object.keys(node?.properties ?? {}), name).not.toContain('jsonrpc');
    }
  });
});

describe('メソッド名', () => {
  it('client → server の request: 実在し、params の型名が一致し、result の定義が在る', () => {
    const methods = methodsOf(def('ClientRequest') as SchemaNode);
    for (const [method, { params, result }] of Object.entries(CODEX_CLIENT_REQUESTS)) {
      const branch = methods.get(method);
      expect(branch, method).toBeDefined();
      expect(refName(branch?.properties?.['params']?.$ref), method).toBe(params);
      expect(def(result), `${method} の result ${result}`).toBeDefined();
    }
  });

  it('client → server の通知は initialized だけ', () => {
    const methods = methodsOf(def('ClientNotification') as SchemaNode);
    expect([...methods.keys()]).toEqual(['initialized']);
  });

  it('server → client の通知: 実在し、params の型名が一致する', () => {
    const methods = methodsOf(def('ServerNotification') as SchemaNode);
    for (const [method, params] of Object.entries(CODEX_SERVER_NOTIFICATIONS)) {
      const branch = methods.get(method);
      expect(branch, method).toBeDefined();
      expect(refName(branch?.properties?.['params']?.$ref), method).toBe(params);
    }
  });

  it('server → client の request: 実在し、params の型名が一致し、答えの定義が在る', () => {
    const methods = methodsOf(def('ServerRequest') as SchemaNode);
    for (const [method, { params, result }] of Object.entries(CODEX_SERVER_REQUESTS)) {
      const branch = methods.get(method);
      expect(branch, method).toBeDefined();
      expect(refName(branch?.properties?.['params']?.$ref), method).toBe(params);
      expect(def(result), `${method} の答え ${result}`).toBeDefined();
    }
  });

  it('型に載せない server → client の request も実在する（既定で断る相手の名前が実在する）', () => {
    const methods = methodsOf(def('ServerRequest') as SchemaNode);
    for (const method of CODEX_UNHANDLED_SERVER_REQUEST_METHODS) {
      expect(methods.has(method), method).toBe(true);
    }
  });

  it('型ガードは表と同じ集合を指す', () => {
    for (const m of Object.keys(CODEX_SERVER_NOTIFICATIONS)) {
      expect(isCodexServerNotificationMethod(m)).toBe(true);
    }
    for (const m of Object.keys(CODEX_SERVER_REQUESTS)) {
      expect(isCodexServerRequestMethod(m)).toBe(true);
    }
    expect(isCodexServerNotificationMethod('toString')).toBe(false);
    expect(isCodexServerRequestMethod('item/tool/call')).toBe(false);
  });
});

describe('欄', () => {
  it('表の件数は空でない（表が空で素通りしない）', () => {
    expect(CODEX_SCHEMA_USES.length).toBeGreaterThan(40);
  });

  for (const use of CODEX_SCHEMA_USES) {
    const label = `${use.def}${use.variant ? `#${use.variant.value}` : ''} (${use.direction})`;
    it(label, () => {
      const node = def(use.def);
      expect(node, `定義 ${use.def}`).toBeDefined();
      const target = use.variant
        ? findVariant(node as SchemaNode, use.variant.key, use.variant.value)
        : (node as SchemaNode);
      expect(target, `枝 ${use.variant?.key}=${use.variant?.value}`).toBeDefined();
      // 共用体の枝の外側（定義の直下）にも properties が在る型がある（McpServerElicitationRequestParams）
      const props = { ...(node?.properties ?? {}), ...(target?.properties ?? {}) };
      const required = new Set([...(node?.required ?? []), ...(target?.required ?? [])]);

      for (const [field, kind] of Object.entries(use.fields)) {
        expect(Object.keys(props), `${field} がスキーマに在る`).toContain(field);
        if (use.direction === 'receive' && kind === 'required') {
          expect(required.has(field), `受ける型で必須にした ${field} がスキーマでも必須`).toBe(
            true,
          );
        }
      }
      if (use.direction === 'send') {
        for (const field of required) {
          expect(use.fields[field], `送る型はスキーマの必須欄 ${field} を必須で持つ`).toBe(
            'required',
          );
        }
      }
    });
  }
});

describe('列挙値', () => {
  for (const e of CODEX_SCHEMA_ENUMS) {
    it(e.def, () => {
      const node = def(e.def);
      expect(node, `定義 ${e.def}`).toBeDefined();
      const actual = stringEnumValues(node as SchemaNode);
      for (const value of e.values) {
        expect(actual, `${value} が ${e.def} に在る`).toContain(value);
      }
    });
  }

  it('ThreadItem の type（読み分ける種類）がすべて実在する', () => {
    const item = def('v2/ThreadItem') as SchemaNode;
    for (const type of CODEX_ITEM_TYPES) {
      expect(findVariant(item, 'type', type), type).toBeDefined();
    }
  });
});

describe('番人: codex の語彙は codex-*.ts の中に閉じる', () => {
  /**
   * codex-*.ts の外から codex-*.ts を import してよい組を、ファイル単位で名指しする（広いパターンで緩めない）。
   * - runner.ts → 駆動役（入口）
   * - agent-provider-selection.ts → provider の申告（claude-provider.js と対称）
   */
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    'runner.ts': ['./codex-manager-driver.js'],
    'agent-provider-selection.ts': ['./codex-provider.js'],
    'agent-provider-selection.test.ts': ['./codex-provider.js'],
  };

  it('codex-*.ts 以外が codex-protocol / codex-app-server-client を import していない（名指しの例外のみ）', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(here)) {
      if (!file.endsWith('.ts') || /^codex-/.test(file)) continue;
      const source = readFileSync(path.join(here, file), 'utf8');
      const imports = [...source.matchAll(/from\s+['"](\.\/codex-[^'"]*)['"]/g)].map((m) => m[1]!);
      const allowed = ALLOWED[file] ?? [];
      for (const spec of imports) if (!allowed.includes(spec)) offenders.push(`${file} → ${spec}`);
      if (/from\s+['"]@openai\/codex/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('中立の語彙（agent-*.ts）に codex の綴りの import が無い（登録簿 agent-provider-selection.ts だけ名指しで除く）', () => {
    for (const file of readdirSync(here).filter(
      (f) =>
        /^agent-.*\.ts$/.test(f) &&
        f !== 'agent-provider-selection.ts' &&
        f !== 'agent-provider-selection.test.ts',
    )) {
      const source = readFileSync(path.join(here, file), 'utf8');
      expect(source, file).not.toMatch(/from\s+['"][^'"]*codex/i);
    }
  });

  it('codex-provider.ts（申告だけ）は codex-protocol / codex-app-server-client を import しない', () => {
    const source = readFileSync(path.join(here, 'codex-provider.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]\.\/codex-/);
  });
});
