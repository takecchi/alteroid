import {
  checkMcpServers,
  MCP_NUL_ONLY_RULE,
  MCP_TYPE_HTTP,
  MCP_TYPE_SSE,
  MCP_TYPE_STDIO,
  type JsonKind,
  type McpExpected,
} from '@alteroid/core/mcp-servers-schema';

// MCP サーバの登録を送る前に、core の checkMcpServers（daemon の zod スキーマと同じ判定。試験で突き合わせてある）で形を見る。
// 規則（欄の名前・型・未知の欄の扱い）は web に写さない。ここが作るのは、どのサーバのどの欄がどう違うかの、画面の語の文だけ

const EXPECTED_JA: Record<McpExpected, string> = {
  string: '文字列',
  number: '数値',
  int: '整数',
  boolean: 'true か false',
  array: '配列（[ … ]）',
  record: 'オブジェクト（{ … }）',
};

const ACTUAL_JA: Record<JsonKind, string> = {
  undefined: '不明な型',
  null: 'null',
  array: '配列',
  string: '文字列',
  number: '数値',
  boolean: '真偽値',
  object: 'オブジェクト',
};

function pathText(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${String(part)}]`;
    return text === '' ? part : `${text}.${part}`;
  }, '');
}

// 送らずに止めるときの直し方の文。形に合っていれば undefined
export function describeMcpServersProblem(servers: Record<string, unknown>): string | undefined {
  const issue = checkMcpServers(servers);
  if (issue === undefined) return undefined;
  const name = issue.server;

  switch (issue.kind) {
    case 'name':
      return `サーバの名前「${name}」は使えない。${issue.reason}`;
    case 'not-object':
      return `${name} は { … } のオブジェクトで書く（いまは${ACTUAL_JA[issue.actual]}）。`;
    case 'type':
      return `${name} の type は ${MCP_TYPE_STDIO}・${MCP_TYPE_HTTP}・${MCP_TYPE_SSE} のどれかで書く（いまは${ACTUAL_JA[issue.actual]}）。`;
    default:
      break;
  }

  // type が無いのに url がある: 欄を1つずつ直す前に、読み方の食い違いを言う
  const entry = servers[name];
  if (
    typeof entry === 'object' &&
    entry !== null &&
    !('type' in entry) &&
    'url' in entry &&
    !('command' in entry)
  ) {
    return `${name} は type が無いので、コマンドで起動する形（${MCP_TYPE_STDIO}）として読むが、url がある。url で繋ぐ形なら type に ${MCP_TYPE_HTTP} か ${MCP_TYPE_SSE} を書く。`;
  }

  switch (issue.kind) {
    case 'unknown-keys':
      return `${name} に使えない欄がある: ${issue.keys.join('、')}。綴りを確かめる（未知の欄は保存できない）。`;
    case 'wrong-type': {
      const field = pathText(issue.path);
      const expected = EXPECTED_JA[issue.expected];
      return issue.actual === 'undefined'
        ? `${name} の ${field} が無い。${expected}で書く。`
        : `${name} の ${field} は${expected}で書く（いまは${ACTUAL_JA[issue.actual]}）。`;
    }
    case 'empty':
      return `${name} の ${issue.field} が空。値を書く。`;
    case 'not-positive':
      return `${name} の ${issue.field} は 0 より大きい整数で書く。`;
    case 'nul-only':
      return `${name} の ${issue.field} が使えない。${MCP_NUL_ONLY_RULE}`;
    default:
      return `${name} の登録の形が不正。`;
  }
}
