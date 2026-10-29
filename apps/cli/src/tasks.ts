import { stdout } from './terminal-out.js';

import { createClient } from './client.js';
import { formatElapsedAgo } from './format.js';
import { describeAuthFailure, resolveTarget } from './target.js';
import { redactBody } from './redact.js';

export interface TasksOptions {
  all?: boolean;
}

interface TaskRowView {
  id: string;
  status: string;
  origin: string;
  source?: string | undefined;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | undefined;
  closedReason?: string | undefined;
  closedBy?: string | undefined;
  keep?: boolean | undefined;
}

interface TasksView {
  entries: TaskRowView[];
  unreadable: { id?: string | undefined; reason: string }[];
}

const EXCERPT = 80;

// 本文は先頭の一行だけを抜粋する: 全文は HTTP の応答に在り、端末の一覧に全文を積むと数件で画面が埋まるため
function excerptOf(text: string): string {
  const first = text.split('\n').find((line) => line.trim().length > 0) ?? '';
  const chars = [...first.trim()];
  return chars.length <= EXCERPT ? chars.join('') : `${chars.slice(0, EXCERPT).join('')}…`;
}

export function renderTasks(view: TasksView, now: number = Date.now()): string {
  const lines: string[] = [];
  if (view.entries.length === 0 && view.unreadable.length === 0) {
    return '（task は無い）';
  }
  // 番号は並びの位置: 先頭が先にやるもの。閉じた行は並びに載らないので番号を振らない
  let position = 0;
  for (const task of view.entries) {
    const closed = task.closedAt !== undefined;
    const mark = closed ? '  ✓' : String(++position).padStart(3, ' ');
    // 「続く」の印（返答しても器が自動で done にしない。#5469 P5）はタイトルの後ろに出す
    lines.push(`${mark} [${task.status}] ${task.title}${task.keep === true ? '  （続く）' : ''}`);
    lines.push(
      `      id: ${task.id}  起点: ${task.origin}${task.source === undefined ? '' : `(${task.source})`}` +
        `  作成: ${task.createdAt}（${formatElapsedAgo(task.createdAt, now)}）  更新: ${task.updatedAt}`,
    );
    lines.push(`      ${excerptOf(task.body)}`);
    if (closed) {
      lines.push(
        `      閉じた: ${task.closedAt ?? ''}${task.closedBy === undefined ? '' : `（${task.closedBy}）`}  ${excerptOf(task.closedReason ?? '')}`,
      );
    }
  }
  if (view.unreadable.length > 0) {
    const ids = view.unreadable.map((row) => row.id).filter((id): id is string => id !== undefined);
    lines.push(
      `読めない行が ${view.unreadable.length} 件ある${ids.length > 0 ? `（id: ${ids.join(', ')}）` : ''}。終わったのではない。`,
    );
  }
  return lines.join('\n');
}

export interface TasksMigrateOptions {
  /** 計画を出すだけ。`yes` と一緒には渡せない。 */
  dryRun?: boolean;
  /** 計画を出したあと、確認なしで実行する（指紋つき）。 */
  yes?: boolean;
}

interface OriginCounts {
  toTask: number;
  closeOnly: number;
  retire: number;
  skipClosed: number;
}

interface MigrationPlanView {
  fingerprint: string;
  summary: {
    total: number;
    toTask: number;
    closeOnly: number;
    retire: number;
    skipClosed: number;
    byOrigin: Record<string, OriginCounts>;
    originConversation: { fromConversation: number; fromApproval: number; unresolved: number };
    oldestAt: string | null;
    newestAt: string | null;
  };
  unresolvedOriginIds: string[];
  unreadableCommitments: { id?: string | undefined }[];
  unreadableTasks: number;
  unreadableTaskCollisions: string[];
}

interface MigrationResultView extends MigrationPlanView {
  execution: {
    migrated: number;
    closeOnly: number;
    retired: number;
    alreadyClosed: number;
    ids: { migrated: string[]; closeOnly: string[]; retired: string[]; alreadyClosed: string[] };
    originConversation: { fromConversation: number; fromApproval: number; unresolvedIds: string[] };
    failed: { id: string; step: string; error: string }[];
  };
}

const ORIGIN_ORDER = ['human', 'manager', 'external', 'self'];

function pad(value: string | number, width: number): string {
  return String(value).padStart(width, ' ');
}

const PLAN_TITLE = '台帳 → task の移行の計画（dry-run。何も書いていない）';

export function renderMigrationPlan(view: MigrationPlanView, title: string = PLAN_TITLE): string {
  const { summary } = view;
  const lines = [
    title,
    `  移す（task にして台帳を閉じる）            ${String(summary.toTask)} 件`,
    `  畳む（human 以外。台帳を閉じるだけ）        ${String(summary.retire)} 件`,
    `  既に移した（task が在る。台帳を閉じるだけ）  ${String(summary.closeOnly)} 件`,
    `  移さない（閉じた行。台帳に残す）            ${String(summary.skipClosed)} 件`,
    `  読めない台帳の行（触らない）                ${String(view.unreadableCommitments.length)} 件`,
    '',
    `  ${'起点'.padEnd(10, ' ')}${pad('移す', 6)}${pad('既に移した', 12)}${pad('畳む', 6)}${pad('閉じた', 8)}`,
  ];
  for (const origin of ORIGIN_ORDER) {
    const counts = summary.byOrigin[origin];
    if (counts === undefined) continue;
    lines.push(
      `  ${origin.padEnd(10, ' ')}${pad(counts.toTask, 6)}${pad(counts.closeOnly, 12)}${pad(counts.retire, 6)}${pad(counts.skipClosed, 8)}`,
    );
  }
  lines.push(
    '',
    summary.oldestAt === null
      ? '  移す行: 無い'
      : `  移す行の at: 最古 ${summary.oldestAt} / 最新 ${summary.newestAt ?? ''}`,
  );
  if (summary.toTask > 0) {
    const origin = summary.originConversation;
    lines.push(
      `  移す行の起点の会話: 会話から ${String(origin.fromConversation)} 件 / 承認から ${String(origin.fromApproval)} 件 / 引けない ${String(origin.unresolved)} 件`,
    );
    if (view.unresolvedOriginIds.length > 0) {
      lines.push(
        `  起点の会話を引けない行（付けずに移す。task_say は書けない）: ${view.unresolvedOriginIds.join(', ')}`,
      );
    }
  }
  lines.push(`  計画の指紋: ${view.fingerprint}`);
  const unreadableIds = view.unreadableCommitments
    .map((row) => row.id)
    .filter((id): id is string => id !== undefined);
  if (view.unreadableCommitments.length > 0) {
    lines.push(
      `  読めない台帳の行: ${String(view.unreadableCommitments.length)} 件（id: ${unreadableIds.length > 0 ? unreadableIds.join(', ') : '不明'}）。終わったのではない。`,
    );
  }
  if (view.unreadableTasks > 0) {
    lines.push(
      `  読めない task の行: ${String(view.unreadableTasks)} 件` +
        (view.unreadableTaskCollisions.length > 0
          ? `（うち台帳と同じ id: ${view.unreadableTaskCollisions.join(', ')}。task は作らず台帳を閉じるだけの扱い）`
          : ''),
    );
  }
  return lines.join('\n');
}

const idList = (ids: readonly string[]): string => (ids.length === 0 ? '' : `: ${ids.join(', ')}`);

export function renderMigrationResult(view: MigrationResultView): string {
  const { execution } = view;
  const lines = [
    '台帳 → task の移行を実行した',
    `  移した（task にして台帳を閉じた）  ${String(execution.migrated)} 件${idList(execution.ids.migrated)}`,
    `  畳んだ（human 以外。台帳を閉じた）  ${String(execution.retired)} 件${idList(execution.ids.retired)}`,
    `  既に移した（台帳を閉じただけ）      ${String(execution.closeOnly)} 件${idList(execution.ids.closeOnly)}`,
    `  既に閉じていた（別の書き手が先に）  ${String(execution.alreadyClosed)} 件${idList(execution.ids.alreadyClosed)}`,
    `  失敗                                ${String(execution.failed.length)} 件`,
  ];
  for (const failure of execution.failed) {
    lines.push(`    ${failure.id}: ${failure.step} の段階で ${failure.error}`);
  }
  const origin = execution.originConversation;
  lines.push(
    `  作った task の起点の会話: 会話から ${String(origin.fromConversation)} 件 / 承認から ${String(origin.fromApproval)} 件 / 引けず付けなかった ${String(origin.unresolvedIds.length)} 件${idList(origin.unresolvedIds)}`,
  );
  if (execution.failed.length > 0) {
    lines.push(
      '  失敗した行は移っていない（台帳は開いたまま）。原因を直して、dry-run からやり直すと続きから進む。',
    );
  }
  lines.push(`  計画の指紋: ${view.fingerprint}`);
  return lines.join('\n');
}

async function failureText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? `: ${body.error}` : '';
  } catch {
    return '';
  }
}

// 実行の口は HTTP（`POST /tasks/migrate`）と同時に出した（片方でしかできないことを作らない）。
// `--yes` が無ければ計画を出して書かずに止まる。`--yes` があれば、いま見た計画の指紋を付けて実行する（見たあとに台帳が動いていれば daemon が 409 で断る）。
export async function tasksMigrateCommand(options: TasksMigrateOptions = {}): Promise<void> {
  if (options.dryRun === true && options.yes === true) {
    throw new Error(
      '--dry-run と --yes は同時に使えません（--dry-run は何も書かない。実行するなら --yes だけを付けてください）。',
    );
  }
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks['migration-plan'].$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    throw new Error(
      described ??
        `台帳→task の移行の計画を読めませんでした（HTTP ${String(response.status)}）${await failureText(response)}`,
    );
  }
  const view = (await response.json()) as MigrationPlanView;
  if (options.dryRun === true) {
    stdout.write(`${redactBody(renderMigrationPlan(view))}\n`);
    return;
  }
  if (options.yes !== true) {
    stdout.write(
      `${redactBody(renderMigrationPlan(view, '台帳 → task の移行の計画（まだ何も書いていない）'))}\n\n` +
        '実行するには `alteroid tasks migrate --yes` を打ってください（いま見た計画の指紋を付けて実行します。' +
        '見たあとに台帳が動いていれば、何も書かずに断ります）。\n',
    );
    return;
  }
  stdout.write(
    `${redactBody(renderMigrationPlan(view, '台帳 → task の移行の計画（この計画を、指紋を付けて実行する）'))}\n\n`,
  );
  const executed = await client.tasks.migrate.$post({ json: { fingerprint: view.fingerprint } });
  if (!executed.ok) {
    const described = describeAuthFailure(executed.status, target);
    if (described !== null) throw new Error(described);
    const detail = await failureText(executed);
    throw new Error(
      executed.status === 409
        ? `何も書かずに断られました（計画が変わっています）${detail}`
        : `台帳→task の移行を実行できませんでした（HTTP ${String(executed.status)}）${detail}`,
    );
  }
  const result = (await executed.json()) as MigrationResultView;
  stdout.write(`${redactBody(renderMigrationResult(result))}\n`);
  // 失敗が1行でもあれば非 0: 「全部移った」とスクリプトから読ませないため
  if (result.execution.failed.length > 0) process.exitCode = 1;
}

export async function tasksCommand(options: TasksOptions = {}): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks.$get({
    query: { includeClosed: options.all === true ? 'true' : 'false' },
  });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    throw new Error(
      described ?? `task の一覧を読めませんでした（HTTP ${String(response.status)}）`,
    );
  }
  const view = (await response.json()) as TasksView;
  stdout.write(`${redactBody(renderTasks(view))}\n`);
}
