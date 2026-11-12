import { clipWithEllipsis } from '@alteroid/core/cli-light';
import type { InferRequestType, InferResponseType } from 'hono/client';

import { confirmProceed, type ConfirmIo } from './confirm.js';
import { createClient, type DaemonClient } from './client.js';
import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { redactError } from './redact.js';
import { stdout } from './terminal-out.js';

/**
 * 確定はプレビューで預かった中身をそのまま保存する（取り直さない）: 見せた中身と違うものを入れないため。
 * プレビューの文字列は外から来るので、端末への書き出しは `terminal-out.ts` の口を通して制御文字を落とす。
 */

const SCOPES = ['all', 'app', 'runner'] as const;
type Scope = (typeof SCOPES)[number];

// デーモンの応答の型から導く（型付きクライアントの `InferResponseType`）: 手で写さない。欄が増えたら tsc が教える
type PluginsView = InferResponseType<DaemonClient['plugins']['$get'], 200>;
type PluginRow = PluginsView['plugins'][number];
type SourceView = PluginRow['source'];
type PreviewView = InferResponseType<DaemonClient['plugins']['preview']['$post'], 200>;
type PreviewSummary = PreviewView['summary'];
type Presence = PreviewSummary['hooks'];
type InstallView = InferResponseType<DaemonClient['plugins']['$post'], 200>;
type RemoveView = InferResponseType<DaemonClient['plugins'][':name']['$delete'], 200>;
type RunnerResult = RemoveView['runners'][number];
type PreviewRequest = InferRequestType<DaemonClient['plugins']['preview']['$post']>['json'];

interface PluginAddOptions {
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
  if (!response.ok) return fail(response, target);
  const body = await response.json();
  stdout.write(renderPluginList(body.plugins));
}

function renderPluginList(plugins: PluginRow[]): string {
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

function shortDescription(text: string): string {
  return clipWithEllipsis(text, MAX_DESCRIPTION_CHARS);
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
  const previewResponse = await client.plugins.preview.$post({ json: body });
  if (!previewResponse.ok) return fail(previewResponse, target);
  const preview: PreviewView = await previewResponse.json();
  stdout.write(renderPluginPreview(preview.summary, { enableHooks: options.enableHooks === true }));

  // 置き換えの有無はプレビューの応答から取る（預かりと結び付いた時点の値。確定の突き合わせと同じもの。#4797）
  const existing = preview.replaces;

  const enableHooks = options.enableHooks === true;
  const enableMcp = options.enableMcp === true;
  const replacing =
    existing === undefined
      ? ''
      : `同じ名前の plugin が既にあり、確定するとそれを置き換えます（取り元: ${sourceWhere(existing.source)}、SHA: ${existing.sha} → ${preview.summary.sha}、入れた日時: ${existing.installedAt}）。`;
  // 確認の文には混ぜない: --yes では確認の文が出ず、置き換えの通知が消える。
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
  if (!response.ok) return fail(response, target);
  const result: InstallView = await response.json();
  stdout.write(renderInstall(result));
  throwOnPushProblem(result.runners);
}

export async function pluginRemoveCommand(name: string): Promise<void> {
  const target = await resolveTarget();
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.plugins[':name'].$delete({ param: { name } });
  if (!response.ok) return fail(response, target);
  const result: RemoveView = await response.json();
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

function buildPreviewRequest(source: string, options: PluginAddOptions): PreviewRequest {
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

function renderPluginPreview(summary: PreviewSummary, flags: { enableHooks: boolean }): string {
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
  // 「その場で走る」と書かない: 実測では読み込みでは走らず、モデルへの実行の指示に変わり、マネージャー・作業者では確認なしで実行されたため
  if (summary.shellExecution.present) {
    lines.push(
      '!! 警告: skills / commands の本文に、シェルを実行する記法（!` や ```!）があります' +
        '（読み込んだ時点では走りませんが、呼び出されるとモデルへの「このコマンドを実行せよ」という指示に変わり、' +
        'マネージャー・作業者では確認なしで実行されえます。クローンでも止まる保証はありません。本文は落としません）',
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
    return `  ${runner.runnerId}: 届けられませんでした — ${reason}`;
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

async function fail(
  response: { status: number; json(): Promise<unknown> },
  target: Target,
): Promise<never> {
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    const kind = forbiddenKindOf(body);
    if (kind === 'not_granted') {
      throw new Error(
        describeAuthFailure(403, target) ?? 'plugin の口へのアクセスが拒否されました（403）。',
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
