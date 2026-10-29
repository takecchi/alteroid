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
  dryRun?: boolean;
}

interface OriginCounts {
  toTask: number;
  closeOnly: number;
  retire: number;
  skipClosed: number;
}

interface MigrationPlanView {
  summary: {
    total: number;
    toTask: number;
    closeOnly: number;
    retire: number;
    skipClosed: number;
    byOrigin: Record<string, OriginCounts>;
    oldestAt: string | null;
    newestAt: string | null;
  };
  unreadableCommitments: { id?: string | undefined }[];
  unreadableTasks: number;
  unreadableTaskCollisions: string[];
}

const ORIGIN_ORDER = ['human', 'manager', 'external', 'self'];

function pad(value: string | number, width: number): string {
  return String(value).padStart(width, ' ');
}

export function renderMigrationPlan(view: MigrationPlanView): string {
  const { summary } = view;
  const lines = [
    '台帳 → task の移行の計画（dry-run。何も書いていない）',
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

// 実行の口は公開しない: 書く経路を CLI だけ・HTTP だけに先に作ると「片方でしかできないこと」が生まれる。実行は P7 本体が HTTP と CLI の両方へ同時に配線する（#5469）。
export async function tasksMigrateCommand(options: TasksMigrateOptions = {}): Promise<void> {
  if (options.dryRun !== true) {
    throw new Error(
      '--dry-run を付けてください。移行の実行はまだ公開していません（実行は P7 本体で配線します）。計画は `alteroid tasks migrate --dry-run` で見られます。',
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
      described ?? `台帳→task の移行の計画を読めませんでした（HTTP ${String(response.status)}）`,
    );
  }
  const view = (await response.json()) as MigrationPlanView;
  stdout.write(`${redactBody(renderMigrationPlan(view))}\n`);
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
