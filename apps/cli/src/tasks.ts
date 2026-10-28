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
    lines.push(`${mark} [${task.status}] ${task.title}`);
    lines.push(
      `      id: ${task.id}  起点: ${task.origin}${task.source === undefined ? '' : `(${task.source})`}` +
        `  作成: ${task.createdAt}（${formatElapsedAgo(task.createdAt, now)}）  更新: ${task.updatedAt}`,
    );
    lines.push(`      ${excerptOf(task.body)}`);
    if (closed) {
      lines.push(`      閉じた: ${task.closedAt ?? ''}  ${excerptOf(task.closedReason ?? '')}`);
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
