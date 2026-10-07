import { confirmProceed, type ConfirmIo } from './confirm.js';
import { createClient } from './client.js';
import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { redactError } from './redact.js';
import { stdout } from './terminal-out.js';

/**
 * `alteroid plugin` — plugin を入れる・外す口（`GET` / `POST /plugins/preview` / `POST /plugins` /
 * `DELETE /plugins/:name`）。経路は足していない。デーモンに在る口を CLI から打てるようにしただけで、
 * `alteroid mcp`（`mcp.ts`）と同じ型で書いてある。
 *
 * ## add は「プレビュー → 確認 → 確定」の2段
 *
 * 取り元（任意の https の Git URL / 公式 marketplace の名前）から取った中身を**先に見せ**、確認の後に
 * 確定する。確定は**プレビューで預かった中身をそのまま保存する**（取り直さない）。確認は
 * `confirm.ts` の流儀（端末なら `yes` の全文、`--yes` で飛ばす、非対話で `--yes` が無ければ実行しない）。
 *
 * **プレビューの文字列は外から来る**（取り元の README・SKILL.md・path）。端末への書き出しは
 * `terminal-out.ts` の口を通し、制御文字を落とす。
 *
 * **資格はデーモンの `requireOwner`**。403 は本文で出し分ける（`mcp.ts` の `fail` と同じ）。
 */

const SCOPES = ['all', 'app', 'runner'] as const;
type Scope = (typeof SCOPES)[number];

interface SourceView {
  kind: string;
  url: string;
  path?: string;
  sha: string;
  version?: string;
  marketplace?: string;
  plugin?: string;
}

interface Presence {
  present: boolean;
  paths: string[];
}

interface PreviewSummary {
  name: string;
  description?: string;
  source: SourceView;
  sha: string;
  fileCount: number;
  totalBytes: number;
  files: { path: string; size: number; executable: boolean }[];
  counts: { skills: number; agents: number; commands: number };
  hooks: Presence;
  modules: Presence;
  lspServers: Presence;
  mcp: Presence;
  executables: { extracted: string[]; notExtracted: string[] };
  shellExecution: Presence;
  skipped: { path: string; reason: string }[];
  extractorDrops: { path: string; reason: string }[];
  skillExcerpts: { path: string; excerpt: string; truncated: boolean }[];
}

interface PreviewView {
  previewId: string;
  expiresAt: string;
  summary: PreviewSummary;
}

interface PluginRow {
  name: string;
  description?: string;
  source: SourceView;
  scope: string;
  enableHooks: boolean;
  enableMcp: boolean;
  fileCount: number;
  totalBytes: number;
  installedAt: string;
}

interface RunnerResult {
  runnerId: string;
  ok: boolean;
  unsupported?: true;
  error?: string;
}

interface InstallView {
  plugin: PluginRow;
  appliesFrom: string;
  runners: RunnerResult[];
}

interface RemoveView {
  name: string;
  appliesFrom: string;
  runners: RunnerResult[];
}

export interface PluginAddOptions {
  path?: string;
  sha?: string;
  ref?: string;
  scope?: string;
  enableHooks?: boolean;
  enableMcp?: boolean;
  yes?: boolean;
}

const MAX_LISTED_FILES = 40;

export async function pluginListCommand(): Promise<void> {
  const target = await resolveTarget();
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.plugins.$get();
  if (!response.ok) await fail(response, target);
  const body = (await response.json()) as { plugins: PluginRow[] };
  stdout.write(renderPluginList(body.plugins));
}

export function renderPluginList(plugins: PluginRow[]): string {
  if (plugins.length === 0) {
    return 'plugin は入っていません。\n入れるには: alteroid plugin add <url|marketplace名>\n';
  }
  const lines = [`plugin: ${String(plugins.length)} 件`];
  for (const plugin of plugins) {
    lines.push(
      `  ${plugin.name}  scope=${plugin.scope}  hooks:${plugin.enableHooks ? '有効' : '無効'}  ` +
        `.mcp.json:${plugin.enableMcp ? '有効' : '無効'}  ${sourceText(plugin.source)}`,
    );
    if (plugin.description !== undefined) {
      lines.push(`    説明: ${shortDescription(plugin.description)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const MAX_DESCRIPTION_CHARS = 100;

/** 一覧の1行に収める。全文は web の画面で読む。制御文字は stdout の口が落とす。 */
function shortDescription(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_DESCRIPTION_CHARS
    ? text
    : `${chars.slice(0, MAX_DESCRIPTION_CHARS).join('')}…`;
}

function sourceWhere(source: SourceView): string {
  const base = source.kind === 'marketplace' ? `marketplace ${source.plugin ?? '?'} ` : '';
  return `${base}${source.url}${source.path === undefined ? '' : ` (path: ${source.path})`}`;
}

function sourceText(source: SourceView): string {
  return `${sourceWhere(source)}@${source.sha.slice(0, 12)}`;
}

export async function pluginAddCommand(
  source: string,
  options: PluginAddOptions,
  io?: ConfirmIo,
): Promise<void> {
  const scope = parseScope(options.scope);
  const body = buildPreviewRequest(source, options);

  const target = await resolveTarget();
  const client = createClient(target.baseUrl, target.headers);
  const previewResponse = await client.plugins.preview.$post({ json: body as never });
  if (!previewResponse.ok) await fail(previewResponse, target);
  const preview = (await previewResponse.json()) as PreviewView;
  stdout.write(renderPluginPreview(preview.summary, { enableHooks: options.enableHooks === true }));

  const listResponse = await client.plugins.$get();
  if (!listResponse.ok) await fail(listResponse, target);
  const installed = ((await listResponse.json()) as { plugins?: PluginRow[] }).plugins ?? [];
  const existing = installed.find((p) => p.name === preview.summary.name);

  const enableHooks = options.enableHooks === true;
  const enableMcp = options.enableMcp === true;
  const replacing =
    existing === undefined
      ? ''
      : `既に入っている「${preview.summary.name}」を置き換えます（SHA ${existing.source.sha} → ${preview.summary.sha}）。`;
  // 確認の文（`confirmProceed`）には混ぜない。--yes では確認の文が出ないので、出力へ別に残す。
  if (replacing !== '') stdout.write(`${replacing}\n`);
  await confirmProceed(
    `plugin「${preview.summary.name}」（SHA ${preview.summary.sha}）を、scope=${scope}・` +
      `hooks ${enableHooks ? '有効' : '無効'}・.mcp.json ${enableMcp ? '有効' : '無効'} で入れます。`,
    options,
    io,
  );

  const response = await client.plugins.$post({
    json: { previewId: preview.previewId, scope, enableHooks, enableMcp },
  });
  if (!response.ok) await fail(response, target);
  const result = (await response.json()) as InstallView;
  stdout.write(renderInstall(result));
  throwOnPushProblem(result.runners);
}

export async function pluginRemoveCommand(name: string): Promise<void> {
  const target = await resolveTarget();
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.plugins[':name'].$delete({ param: { name } });
  if (!response.ok) await fail(response, target);
  const result = (await response.json()) as RemoveView;
  stdout.write(
    [
      `plugin「${result.name}」を外しました。`,
      ...runnerLines(result.runners),
      `いつから効くか: ${result.appliesFrom}`,
    ].join('\n') + '\n',
  );
  throwOnPushProblem(result.runners);
}

function parseScope(value: string | undefined): Scope {
  if (value === undefined) return 'all';
  if ((SCOPES as readonly string[]).includes(value)) return value as Scope;
  throw new Error(
    `--scope は ${SCOPES.join(' / ')} のどれかで指定してください（何も打っていません）`,
  );
}

function buildPreviewRequest(source: string, options: PluginAddOptions): Record<string, unknown> {
  if (/^https:\/\//i.test(source)) {
    if (options.sha !== undefined && !/^[0-9a-f]{40}$/.test(options.sha)) {
      throw new Error(
        '--sha は小文字40桁の commit SHA で指定してください。ブランチ・タグは --ref で指定します' +
          '（取得時に一度だけ SHA へ解決して固定します）',
      );
    }
    return {
      kind: 'url',
      url: source,
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      ...(options.sha === undefined ? {} : { sha: options.sha }),
    };
  }
  if (/:\/\/|^git@|^[^\s]*\//.test(source)) {
    throw new Error(
      '取り元は https の URL か、公式 marketplace の plugin 名で指定してください（何も打っていません）',
    );
  }
  if (options.sha !== undefined || options.path !== undefined || options.ref !== undefined) {
    throw new Error(
      'marketplace の plugin には --sha / --path / --ref を添えられません' +
        '（実体の取り元と SHA は marketplace の索引から解決します）',
    );
  }
  return { kind: 'marketplace', plugin: source };
}

function presenceLine(label: string, presence: Presence, note: string): string[] {
  if (!presence.present) return [];
  return [`  ${label}: ${presence.paths.join(', ')}  ${note}`];
}

export function renderPluginPreview(
  summary: PreviewSummary,
  flags: { enableHooks: boolean },
): string {
  const lines: string[] = [];
  lines.push(`plugin: ${summary.name}`);
  if (summary.description !== undefined) lines.push(`説明: ${summary.description}`);
  lines.push(`取り元: ${sourceWhere(summary.source)}`);
  lines.push(`SHA: ${summary.sha}（この commit で固定。自動更新しない）`);
  if (summary.source.version !== undefined) lines.push(`版: ${summary.source.version}`);
  lines.push(`ファイル: ${String(summary.fileCount)} 個 / ${String(summary.totalBytes)} バイト`);
  lines.push(
    `  skills ${String(summary.counts.skills)} / agents ${String(summary.counts.agents)} / ` +
      `commands ${String(summary.counts.commands)}`,
  );

  if (summary.hooks.present) {
    lines.push(
      '!! 警告: hooks を含みます（plugin が実行の途中に割り込むコードを持ち込めます）',
      `  hooks: ${summary.hooks.paths.join(', ')}`,
      flags.enableHooks
        ? '  --enable-hooks を付けても、hooks は展開されません（監査との関係を確かめるまで出さない）'
        : '  既定は無効です。--enable-hooks を付けても、hooks は展開されません',
    );
  }
  lines.push(
    ...presenceLine('.mcp.json / mcpServers', summary.mcp, '（--enable-mcp を付けたときだけ展開）'),
    ...presenceLine('modules', summary.modules, '（展開されない）'),
    ...presenceLine('lspServers', summary.lspServers, '（展開されない）'),
  );
  if (summary.shellExecution.present) {
    lines.push(
      '!! 警告: skills / commands の本文に、シェルを実行する記法（!` や ```!）があります' +
        '（呼び出されたとき、その場でコマンドが走りうる。本文は落としません）',
      `  該当: ${summary.shellExecution.paths.join(', ')}`,
    );
  }
  if (summary.executables.extracted.length > 0) {
    lines.push(
      `  実行ファイル（展開される）: ${summary.executables.extracted.join(', ')}` +
        '  （skills / agents / commands 配下。plugin の中から呼ばれうる）',
    );
  }
  if (summary.executables.notExtracted.length > 0) {
    lines.push(`  実行ファイル（展開されない）: ${summary.executables.notExtracted.join(', ')}`);
  }
  if (summary.skipped.length > 0) {
    lines.push(
      `取らなかったもの: ${summary.skipped.map((s) => `${s.path}（${s.reason}）`).join(', ')}`,
    );
  }
  const drops = summary.extractorDrops.filter((d) => d.reason !== 'invalid-path');
  if (drops.length > 0) {
    lines.push('展開されないもの（有効にしても落とす）:');
    for (const drop of drops.slice(0, MAX_LISTED_FILES))
      lines.push(`  ${drop.path}  (${drop.reason})`);
    if (drops.length > MAX_LISTED_FILES) {
      lines.push(`  …ほか ${String(drops.length - MAX_LISTED_FILES)} 件`);
    }
  }
  if (summary.skillExcerpts.length > 0) {
    lines.push('SKILL.md の冒頭:');
    for (const excerpt of summary.skillExcerpts) {
      lines.push(`  ${excerpt.path}`);
      for (const line of excerpt.excerpt.split('\n')) lines.push(`    ${line}`);
      if (excerpt.truncated) lines.push('    …');
    }
  }
  lines.push('ファイル一覧:');
  for (const file of summary.files.slice(0, MAX_LISTED_FILES)) {
    lines.push(`  ${file.path}  ${String(file.size)}B${file.executable ? '  (実行ビット)' : ''}`);
  }
  if (summary.files.length > MAX_LISTED_FILES) {
    lines.push(`  …ほか ${String(summary.files.length - MAX_LISTED_FILES)} 個`);
  }
  return `${lines.join('\n')}\n`;
}

function runnerLines(runners: RunnerResult[]): string[] {
  if (runners.length === 0) {
    return [
      '  runner: いま配った先はありません（繋がった runner へは、名乗り直したときに降ろします）',
    ];
  }
  return runners.map((runner) => {
    if (runner.ok) return `  ${runner.runnerId}: 届きました`;
    const reason = runner.error === undefined ? '理由不明' : redactError(runner.error);
    return runner.unsupported === true
      ? `  ${runner.runnerId}: 受け取る口がありません（古い runner） — ${reason}`
      : `  ${runner.runnerId}: 届けられませんでした — ${reason}`;
  });
}

function renderInstall(result: InstallView): string {
  const p = result.plugin;
  return (
    [
      `plugin「${p.name}」を入れました（scope=${p.scope}、hooks ${p.enableHooks ? '有効' : '無効'}、` +
        `.mcp.json ${p.enableMcp ? '有効' : '無効'}、SHA ${p.source.sha}）`,
      ...runnerLines(result.runners),
      `いつから効くか: ${result.appliesFrom}`,
    ].join('\n') + '\n'
  );
}

function throwOnPushProblem(runners: RunnerResult[]): void {
  if (runners.some((runner) => !runner.ok)) {
    throw new Error(
      'runner への反映が一部失敗しました（plugin の保存は済んでいます。失敗した runner へは次に名乗ったときに降ろし直します）',
    );
  }
}

/** 失敗を、人間が次にやることの分かる文言にして投げる（`mcp.ts` の `fail` と同じ形）。 */
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
          'plugin の口へのアクセスが拒否されました（403）。',
      );
    }
    throw new Error(
      'plugin の口へのアクセスが拒否されました（403）。理由を判別できなかったため、' +
        '次にすべきことは案内しません。',
    );
  }
  const described = describeAuthFailure(response.status, target);
  if (described !== null) throw new Error(described);
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (typeof body.error === 'string') throw new Error(redactError(body.error));
  throw new Error(`/plugins が失敗しました (${String(response.status)})`);
}
