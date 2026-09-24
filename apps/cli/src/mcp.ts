import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

import { createClient } from './client.js';
import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';

/**
 * `alteroid mcp` — 人間の MCP 連携の登録（`.mcp.json` の `mcpServers` と同じ形）を
 * 読む・差し替える（#325 段4）。
 *
 * **`GET` / `PUT /mcp-servers` の2本だけを使う。** 経路は足していない —— 段1〜3 で
 * デーモンに在る口を、CLI からも打てるようにしただけである（PRD「インターフェース」:
 * ある入口でできることが別の入口でできない状態を作らない。Web UI の
 * `apps/web/app/routes/mcp-servers.tsx` と対になる）。`clear` も新しい口ではなく、
 * 空の `mcpServers` の `PUT` である。
 *
 * ## 値は既定で出さない
 *
 * 登録の `env` / `headers` には API キーがそのまま入りうる（`packages/core/src/mcp-servers.ts`
 * の doc）。`GET /mcp-servers` は値を丸ごと返すが、端末は画面共有やログに残る
 * ので、**`list` は名前・種類・宛先・鍵の名前だけ、`show` も `--reveal` を付けた
 * ときだけ値を出す。** 伏せる範囲は `env` / `headers` の値に加えて、`args` の要素と
 * URL のクエリ・認証情報まで広げてある —— `--api-key xxx` や `?token=xxx` の形で
 * 鍵が入る登録が実在するからである（どこに鍵があるかを CLI は知りようが無いので、
 * 置ける場所を全部伏せる側へ倒す）。
 *
 * **資格はデーモンの `requireOwner`**（`PUT /credentials` と同じ）。403 は本文で
 * 出し分ける（`request` の doc）。
 */

/** `.mcp.json` の `mcpServers` の1件。CLI は形を検査しない（正本はデーモンの検査）。 */
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

/** 伏せた値の代わりに置く文字列。 */
const MASK = '***';

export async function mcpListCommand(): Promise<void> {
  const target = await resolveTarget();
  const view = await read(target);
  stdout.write(renderMcpList(view));
}

/**
 * 一覧。**値は1文字も出さない**（名前・種類・宛先・鍵の名前と、`args` の個数だけ）。
 * 宛先の URL もクエリと認証情報を落として出す（`maskUrl`）。
 */
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

/**
 * 登録を JSON で出す。**`--reveal` が無ければ値を伏せる**（`maskMcpServers`）。
 * `--reveal` のときは `.mcp.json` にそのまま貼れる形だけを出す（パイプで
 * ファイルへ落として `alteroid mcp set` へ戻せるように、余計な行を足さない）。
 */
export async function mcpShowCommand(options: { reveal?: boolean } = {}): Promise<void> {
  const target = await resolveTarget();
  const view = await read(target);
  if (options.reveal === true) {
    stdout.write(`${JSON.stringify({ mcpServers: view.mcpServers }, null, 2)}\n`);
    return;
  }
  stdout.write(`${JSON.stringify({ mcpServers: maskMcpServers(view.mcpServers) }, null, 2)}\n`);
  stdout.write(
    '（env / headers / args の値と URL のクエリ・認証情報は伏せました。' +
      '全部見るには: alteroid mcp show --reveal）\n',
  );
}

/** ファイル（`-` なら標準入力）の `.mcp.json` で丸ごと置き換える。 */
export async function mcpSetCommand(file: string): Promise<void> {
  const text = file === '-' ? await readAll() : await readFile(file, 'utf8');
  const servers = parseMcpJson(text);
  const target = await resolveTarget();
  const before = await read(target);
  await put(target, servers, Object.keys(before.mcpServers));
}

/**
 * いま置いてあるものを `$EDITOR` で開いて、閉じたら反映する
 * （`alteroid profile edit` と同じ往復。`apps/cli/src/profile.ts` の `profileEditCommand`）。
 */
export async function mcpEditCommand(): Promise<void> {
  const target = await resolveTarget();
  const current = await read(target);
  const original = `${JSON.stringify({ mcpServers: current.mcpServers }, null, 2)}\n`;

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-mcp-'));
  const path = join(dir, 'mcp.json');
  try {
    // 中身は人間が置いた鍵そのものになりうる。一時ファイルでも絞る。
    await writeFile(path, original, { encoding: 'utf8', mode: 0o600 });
    await openEditor(path);
    const edited = await readFile(path, 'utf8');

    if (edited === original) {
      stdout.write('変更はありません。\n');
      return;
    }
    await put(target, parseMcpJson(edited), Object.keys(current.mcpServers));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 登録を外す（空の `mcpServers` の `PUT`）。 */
export async function mcpClearCommand(): Promise<void> {
  const target = await resolveTarget();
  const before = await read(target);
  await put(target, {}, Object.keys(before.mcpServers));
}

/**
 * `.mcp.json` の本文を読む。**形の検査はデーモンに任せる**（`parseMcpServers` が
 * 正本で、ここで写すと二重管理になる）。ここで止めるのは「JSON として読めない」
 * と「`mcpServers` の欄が無い」だけ —— 後者を素通しすると、デーモンの 400 が
 * 「`mcpServers` が不正」としか言えず、人間の手元の `.mcp.json` をそのまま貼った
 * のか中身だけを貼ったのかが区別できない。
 */
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

/**
 * 値を伏せた写し。**鍵の名前・`args` の個数・URL の宛先（オリジンとパス）は残す**
 * —— どの登録に何が入っているかは見えないと、typo も欠けも直せない。
 */
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

/**
 * URL のクエリ・フラグメント・認証情報（`user:pass@`）を伏せる。**読めない URL は
 * 丸ごと伏せる** —— 読めないものの中のどこに鍵があるかは判別できない。
 */
export function maskUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return MASK;
  }
  const hidden = parsed.search !== '' || parsed.hash !== '' || parsed.username !== '';
  return hidden ? `${parsed.origin}${parsed.pathname}?${MASK}` : url;
}

async function put(target: Target, servers: McpServers, beforeNames: string[]): Promise<void> {
  const client = createClient(target.baseUrl, target.headers);
  const response = await client['mcp-servers'].$put({
    // 形の検査はデーモンの正本（`parseMcpServers`）に任せる。型はここで主張しない。
    json: { mcpServers: servers } as never,
  });
  if (!response.ok) await fail(response, target);
  const result = (await response.json()) as McpServersUpdateView;
  stdout.write(renderMcpUpdate(result, beforeNames));
}

/**
 * 差し替えの結果。**足した・外した名前、指紋、runner ごとの成否を全部出す**
 * （`alteroid profile` の `report` と同じ理由 —— 配り損ねた runner を小さく出すと、
 * マネージャーが古い登録のまま走り続けることに誰も気づけない）。
 *
 * runner が返した指紋が保存した指紋と違えば、それも言う（値を見ずに「同じ版が
 * 届いたか」を言える唯一の手がかりである。`mcpServersUpdateResponseSchema` の doc）。
 */
export function renderMcpUpdate(result: McpServersUpdateView, beforeNames: string[]): string {
  const before = new Set(beforeNames);
  const after = new Set(result.names);
  const added = result.names.filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name)).sort();
  const kept = result.names.filter((name) => before.has(name));

  const lines: string[] = [];
  lines.push(
    result.names.length === 0
      ? 'MCP サーバの登録を外しました。'
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
          ? `  ${runner.runnerId}: 受け取る口がありません（古い runner） — ${runner.error ?? '理由不明'}`
          : `  ${runner.runnerId}: 届けられませんでした — ${runner.error ?? '理由不明'}`,
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

/**
 * 失敗を人間が次にやることの分かる文言にして投げる。
 *
 * **403 は本文で出し分ける**（`credential.ts` の `request` と同じ形。門も同じ
 * `requireOwner`）。未宣言（`not_declared_owner`）なら `alteroid access owner`、
 * 未許可（`not_granted`）なら `alteroid access grant` を案内し、判別できないとき
 * （この経路では来ないはずの `not_operator` を含む）は当てずっぽうを出さずに止める
 * （`target.ts` の `ForbiddenKind` の doc）。
 */
async function fail(
  response: { status: number; json(): Promise<unknown> },
  target: Target,
): Promise<never> {
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    const kind = forbiddenKindOf(body);
    if (kind === 'not_declared_owner' || kind === 'not_granted') {
      throw new Error(
        describeAuthFailure(403, target, kind) ??
          'MCP サーバの登録へのアクセスが拒否されました（403）。',
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
    // 400 は「保存していない」。前の登録が残っていることまで言う（直してやり直せばよい）。
    throw new Error(
      response.status === 400 ? `${body.error}\n（前の登録がそのまま残っています）` : body.error,
    );
  }
  throw new Error(`/mcp-servers が失敗しました (${String(response.status)})`);
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function openEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} が異常終了しました (${String(code)})`));
    });
  });
}
