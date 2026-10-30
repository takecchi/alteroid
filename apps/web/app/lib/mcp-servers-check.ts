import {
  mcpHttpServerConfigSchema,
  mcpServerNameSchema,
  mcpSseServerConfigSchema,
  mcpStdioServerConfigSchema,
} from '@alteroid/core/mcp-servers-schema';

// MCP サーバの登録を送る前に、daemon が使うのと同じ core のスキーマで形を見る。
// 規則は core のスキーマそのもの（欄の名前・型・未知の欄の扱いを web に写さない）。ここが作るのは、直し方の文だけ。
// zod の英語の message はそのまま出さない: 「どのサーバのどの欄がどう違うか」を、issue の path と期待の型から画面の語で組む

const BRANCHES = {
  stdio: mcpStdioServerConfigSchema,
  http: mcpHttpServerConfigSchema,
  sse: mcpSseServerConfigSchema,
};

// 枝を選ぶ type の値。スキーマの literal から取る（綴りを写さない）
const TYPE_NAMES = [
  mcpStdioServerConfigSchema.shape.type.unwrap().value,
  mcpHttpServerConfigSchema.shape.type.value,
  mcpSseServerConfigSchema.shape.type.value,
];

const TYPE_JA: Record<string, string> = {
  string: '文字列',
  number: '数値',
  int: '整数',
  boolean: 'true か false',
  array: '配列（[ … ]）',
  object: 'オブジェクト（{ … }）',
  record: 'オブジェクト（{ … }）',
};

function describeActual(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '配列';
  switch (typeof value) {
    case 'string':
      return '文字列';
    case 'number':
      return '数値';
    case 'boolean':
      return '真偽値';
    case 'object':
      return 'オブジェクト';
    default:
      return '不明な型';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${String(part)}]`;
    const key = String(part);
    return text === '' ? key : `${text}.${key}`;
  }, '');
}

function valueAt(entry: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = entry;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
}

// 送らずに止めるときの直し方の文。形に合っていれば undefined
export function describeMcpServersProblem(servers: Record<string, unknown>): string | undefined {
  for (const [name, entry] of Object.entries(servers)) {
    const nameResult = mcpServerNameSchema.safeParse(name);
    if (!nameResult.success) {
      return `サーバの名前「${name}」は使えない。${nameResult.error.issues[0]?.message ?? ''}`;
    }
    if (!isPlainObject(entry)) {
      return `${name} は { … } のオブジェクトで書く（いまは${describeActual(entry)}）。`;
    }

    const type = entry.type;
    const branch =
      type === undefined || type === 'stdio'
        ? BRANCHES.stdio
        : type === 'http'
          ? BRANCHES.http
          : type === 'sse'
            ? BRANCHES.sse
            : undefined;
    if (branch === undefined) {
      return `${name} の type は ${TYPE_NAMES.join('・')} のどれかで書く（いまは${describeActual(type)}）。`;
    }
    // type が無いのに url がある: 欄を1つずつ直す前に、読み方の食い違いを言う
    if (type === undefined && 'url' in entry && !('command' in entry)) {
      return `${name} は type が無いので、コマンドで起動する形（${TYPE_NAMES[0]}）として読むが、url がある。url で繋ぐ形なら type に ${TYPE_NAMES[1]} か ${TYPE_NAMES[2]} を書く。`;
    }

    const result = branch.safeParse(entry);
    if (result.success) continue;
    const issue = result.error.issues[0];
    if (issue === undefined) return `${name} の登録の形が不正。`;

    if (issue.code === 'unrecognized_keys') {
      return `${name} に使えない欄がある: ${issue.keys.join('、')}。綴りを確かめる（未知の欄は保存できない）。`;
    }
    const field = pathText(issue.path);
    const actual = valueAt(entry, issue.path);
    if (issue.code === 'invalid_type') {
      const expected = TYPE_JA[issue.expected] ?? issue.expected;
      return actual === undefined
        ? `${name} の ${field} が無い。${expected}で書く。`
        : `${name} の ${field} は${expected}で書く（いまは${describeActual(actual)}）。`;
    }
    if (issue.code === 'too_small' && typeof actual === 'string') {
      return `${name} の ${field} が空。値を書く。`;
    }
    if (issue.code === 'too_small' && typeof actual === 'number') {
      return `${name} の ${field} は 0 より大きい整数で書く。`;
    }
    if (issue.code === 'custom') {
      // core の検査が日本語で持つ理由（NUL だけの値など）。そのまま添える
      return `${name} の ${field} が使えない。${issue.message}`;
    }
    return `${name} の ${field === '' ? '登録' : field} の形が不正。`;
  }
  return undefined;
}
