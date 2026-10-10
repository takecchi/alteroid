import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { stdout } from './terminal-out.js';

import { maskUrl } from '@alteroid/core/mask-url';
import { hasMcpPushProblem } from '@alteroid/logic';

import { confirmIrreversible } from './confirm.js';
import { createClient } from './client.js';
import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { redactError } from './redact.js';
import { keepDraftOnFailure, openEditorKeepingEdits, readInputFile } from './input-errors.js';
import { shellQuote } from './shell-quote.js';

interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

type McpServers = Record<string, McpServerEntry>;

interface McpServersView {
  mcpServers: McpServers;
  updatedAt?: string;
  // 古いデーモンは返さない: その間は ifMatch を送らず、従来どおり無条件で置き換える
  version?: string;
}

interface McpServersRunnerResult {
  runnerId: string;
  ok: boolean;
  mcpServers?: { names: string[]; sha256: string };
  unsupported?: true;
  error?: string;
}

interface McpServersUpdateView {
  names: string[];
  updatedAt: string;
  sha256?: string;
  appliesFrom: string;
  runners: McpServersRunnerResult[];
}

// `args` の要素と URL のクエリ・認証情報も伏せる: `--api-key xxx` や `?token=xxx` の形で鍵が入る登録が実在するため
const MASK = '***';

export async function mcpListCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const view = await read(target);
  stdout.write(renderMcpList(view));
}

export function renderMcpList(view: McpServersView): string {
  const names = Object.keys(view.mcpServers).sort();
  if (names.length === 0) {
    return 'MCP サーバの登録はありません。\n置くには: alteroid mcp edit\n';
  }
  const lines = [
    `MCP サーバの登録: ${String(names.length)} 件` +
      (view.updatedAt === undefined ? '' : `（更新 ${view.updatedAt}）`),
  ];
  for (const name of names) {
    const entry = view.mcpServers[name] ?? {};
    const transport = entry.type ?? 'stdio';
    const where =
      typeof entry.url === 'string' ? maskUrl(entry.url) : (entry.command ?? '（宛先なし）');
    lines.push(`  ${name}  ${transport}  ${where}`);
    const args = entry.args ?? [];
    if (args.length > 0) lines.push(`    args: ${String(args.length)} 個（値は伏せた）`);
    const envKeys = Object.keys(entry.env ?? {}).sort();
    if (envKeys.length > 0) lines.push(`    env: ${envKeys.join(', ')}`);
    const headerKeys = Object.keys(entry.headers ?? {}).sort();
    if (headerKeys.length > 0) lines.push(`    headers: ${headerKeys.join(', ')}`);
  }
  lines.push('値を見るには: alteroid mcp show --reveal');
  return `${lines.join('\n')}\n`;
}

export async function mcpShowCommand(options: { reveal?: boolean } = {}): Promise<void> {
  const target = await resolveTarget();
  // 例外にする: note を標準出力へ書くと、`show > f; set f` で note が登録として撒かれるため
  if (target.note !== null) throw new Error(target.note);
  const view = await read(target);
  if (options.reveal === true) {
    stdout.writeRaw(`${JSON.stringify({ mcpServers: view.mcpServers }, null, 2)}\n`);
    return;
  }
  stdout.writeRaw(`${JSON.stringify({ mcpServers: maskMcpServers(view.mcpServers) }, null, 2)}\n`);
  stdout.write(
    '（env / headers / args の値と URL のクエリ・認証情報は伏せました。' +
      '全部見るには: alteroid mcp show --reveal）\n',
  );
}

export async function mcpSetCommand(file: string, options: { yes?: boolean } = {}): Promise<void> {
  // 標準入力を読む前に断る: 読み切ってから落ちると、渡した本文が無駄になり理由も遅れるため
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  const text =
    file === '-'
      ? await readAll()
      : await readInputFile(file, '引数 <file>', '<file>（.mcp.json）、または標準入力（-）');
  const servers = parseMcpJson(text);
  const before = await read(target);
  const beforeNames = Object.keys(before.mcpServers);
  if (beforeNames.length > 0 && stableJson(before.mcpServers) !== stableJson(servers)) {
    await confirmIrreversible(
      `MCP の登録（${beforeNames.join('・')}）を、渡された内容で丸ごと置き換えます。いまの値は残りません` +
        '（控えるなら alteroid mcp show --reveal）。',
      options,
    );
  }
  await put(target, servers, beforeNames, before.version);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export async function mcpEditCommand(): Promise<void> {
  const target = await resolveTarget();
  // エディタを開く前に断る: 書き終えてから落ちると、書いた本文が無駄になるため
  if (target.note !== null) throw new Error(target.note);
  const current = await read(target);
  const original = `${JSON.stringify({ mcpServers: current.mcpServers }, null, 2)}\n`;

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-mcp-'));
  const path = join(dir, 'mcp.json');
  const resume = `alteroid mcp set ${shellQuote(path)}`;
  await openEditorKeepingEdits({
    dir,
    path,
    initial: original,
    // 一時ファイルでも 0600 にする: 中身は人間が置いた鍵そのものになりうるため
    mode: 0o600,
    resume,
    alternative: 'alteroid mcp set <file>',
  });
  await keepDraftOnFailure(dir, path, resume, async () => {
    const edited = await readFile(path, 'utf8');

    if (edited === original) {
      stdout.write('変更はありません。\n');
      return;
    }
    // エディタを開く前に読んだ版を送る: 開いている間にクローンや Web が書いた登録を、黙って消さないため
    await put(target, parseMcpJson(edited), Object.keys(current.mcpServers), current.version);
  });
}

export async function mcpClearCommand(options: { yes?: boolean } = {}): Promise<void> {
  const target = await resolveTarget();
  // 確認を出す前に断る: 未ログインのまま「外してよいか」を聞くのは無意味なため
  if (target.note !== null) throw new Error(target.note);
  const before = await read(target);
  const beforeNames = Object.keys(before.mcpServers);
  if (beforeNames.length > 0) {
    await confirmIrreversible(
      `MCP の登録（${beforeNames.join('・')}）を全部外します。いまの値は残りません` +
        '（控えるなら alteroid mcp show --reveal）。',
      options,
    );
  }
  await put(target, {}, beforeNames, before.version);
}

// 形の検査を写さない: `parseMcpServers` が正本で二重管理になるため（`mcpServers` の欄の有無だけ見る）
export function parseMcpJson(text: string): McpServers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `JSON として読めませんでした（何も保存していません）: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const servers =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { mcpServers?: unknown }).mcpServers
      : undefined;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error(
      '`{ "mcpServers": { … } }` の形で書いてください（.mcp.json と同じ形。何も保存していません）',
    );
  }
  return servers as McpServers;
}

export function maskMcpServers(servers: McpServers): McpServers {
  const masked: McpServers = {};
  for (const [name, entry] of Object.entries(servers)) {
    const copy: McpServerEntry = { ...entry };
    if (entry.args !== undefined) copy.args = entry.args.map(() => MASK);
    if (entry.env !== undefined) copy.env = maskValues(entry.env);
    if (entry.headers !== undefined) copy.headers = maskValues(entry.headers);
    if (typeof entry.url === 'string') copy.url = maskUrl(entry.url);
    masked[name] = copy;
  }
  return masked;
}

function maskValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(values).map((key) => [key, MASK]));
}

export { maskUrl };

async function put(
  target: Target,
  servers: McpServers,
  beforeNames: string[],
  ifMatch?: string,
): Promise<void> {
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['mcp-servers'].$put({
    json: (ifMatch === undefined
      ? { mcpServers: servers }
      : { mcpServers: servers, ifMatch }) as never,
  });
  // 409 は版の衝突だけ: この口に他の 409 は無いため。current は値を含むので、名前だけを出す
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { current?: McpServersView };
    const names = Object.keys(body.current?.mcpServers ?? {}).sort();
    stdout.write(
      [
        '置き換えていません: あなたが読んだ後に、ほかで MCP の登録が変わっています（クローンや Web などの別の書き手）。',
        `  いまの登録: ${names.length === 0 ? '（無し）' : names.join('・')}`,
        '  続けるには: `alteroid mcp show` でいまの登録を確かめてから、もう一度 `alteroid mcp set <file>` / `alteroid mcp edit` をやり直してください。',
        '',
      ].join('\n'),
    );
    throw new Error('MCP の登録が読んだ後に変わっていたので置き換えませんでした');
  }
  if (!response.ok) await fail(response, target);
  const result = (await response.json()) as McpServersUpdateView;
  stdout.write(renderMcpUpdate(result, beforeNames));
  if (hasMcpPushProblem(result)) {
    throw new Error(
      'runner への反映が一部失敗しました（MCP 連携の登録の保存は済んでいます。失敗した runner へは次に名乗ったときに降ろし直します）',
    );
  }
}

// runner ごとの成否を畳まない: 配り損ねた runner を小さく出すと、古い登録のまま走り続けることに誰も気づけないため
export function renderMcpUpdate(result: McpServersUpdateView, beforeNames: string[]): string {
  const before = new Set(beforeNames);
  const after = new Set(result.names);
  const added = result.names.filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name)).sort();
  const kept = result.names.filter((name) => before.has(name));

  const lines: string[] = [];
  const partial = hasMcpPushProblem(result);
  lines.push(
    result.names.length === 0
      ? partial
        ? '警告: MCP サーバの登録を外しましたが、一部の runner へ反映できていません。'
        : 'MCP サーバの登録を外しました。'
      : partial
        ? `警告: MCP サーバの登録を保存しましたが、一部の runner へ反映できていません (sha256 ${result.sha256 ?? '?'})`
        : `MCP サーバの登録を差し替えました (sha256 ${result.sha256 ?? '?'})`,
  );
  if (added.length > 0) lines.push(`  足した: ${added.join(', ')}`);
  if (removed.length > 0) lines.push(`  外した: ${removed.join(', ')}`);
  if (kept.length > 0) lines.push(`  置き直した: ${kept.join(', ')}`);

  if (result.runners.length === 0) {
    lines.push(
      '  runner: いま配った先はありません（繋がった runner へは、名乗り直したときに降ろします）',
    );
  }
  for (const runner of result.runners) {
    if (!runner.ok) {
      lines.push(
        runner.unsupported === true
          ? `  ${runner.runnerId}: 受け取る口がありません（古い runner） — ${runner.error === undefined ? '理由不明' : redactError(runner.error)}`
          : `  ${runner.runnerId}: 届けられませんでした — ${runner.error === undefined ? '理由不明' : redactError(runner.error)}`,
      );
      continue;
    }
    if (runner.mcpServers === undefined) {
      lines.push(
        result.names.length === 0
          ? `  ${runner.runnerId}: 外しました`
          : `  ${runner.runnerId}: 届きました（指紋は返りませんでした）`,
      );
      continue;
    }
    const same = result.sha256 === undefined || runner.mcpServers.sha256 === result.sha256;
    lines.push(
      same
        ? `  ${runner.runnerId}: 届きました（sha256 ${runner.mcpServers.sha256}）`
        : `  ${runner.runnerId}: 届きましたが指紋が違います（runner ${runner.mcpServers.sha256} / 保存 ${result.sha256 ?? '?'}）`,
    );
  }
  lines.push(`いつから効くか: ${result.appliesFrom}`);
  return `${lines.join('\n')}\n`;
}

async function read(target: Target): Promise<McpServersView> {
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['mcp-servers'].$get();
  if (!response.ok) await fail(response, target);
  return (await response.json()) as McpServersView;
}

async function fail(
  response: { status: number; json(): Promise<unknown> },
  target: Target,
): Promise<never> {
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    const kind = forbiddenKindOf(body);
    if (kind === 'not_granted') {
      throw new Error(
        describeAuthFailure(403, target) ?? 'MCP サーバの登録へのアクセスが拒否されました（403）。',
      );
    }
    throw new Error(
      'MCP サーバの登録へのアクセスが拒否されました（403）。理由を判別できなかったため、' +
        '次にすべきことは案内しません。',
    );
  }
  const described = describeAuthFailure(response.status, target);
  if (described !== null) throw new Error(described);
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (typeof body.error === 'string') {
    throw new Error(
      response.status === 400
        ? `${redactError(body.error)}\n（前の登録がそのまま残っています）`
        : redactError(body.error),
    );
  }
  throw new Error(`/mcp-servers が失敗しました (${String(response.status)})`);
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
