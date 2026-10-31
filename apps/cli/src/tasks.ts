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

async function failureText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? `: ${body.error}` : '';
  } catch {
    return '';
  }
}

// ---- 人間が task を書く口（#5469 P7c-1）。HTTP の `GET/POST /tasks`・`/tasks/:id/{close,reopen,move}`・`PATCH /tasks/:id` と1対1 ----

export interface TaskPlacementOptions {
  front?: boolean;
  back?: boolean;
  before?: string;
  after?: string;
}

type PlacementBody =
  | { kind: 'front' }
  | { kind: 'back' }
  | { kind: 'before'; anchorId: string }
  | { kind: 'after'; anchorId: string };

// 置き場所の指定は高々1つ。2つ以上は黙って片方を採らずに断る
function placementOf(options: TaskPlacementOptions): PlacementBody | undefined {
  const given: PlacementBody[] = [
    ...(options.front === true ? [{ kind: 'front' as const }] : []),
    ...(options.back === true ? [{ kind: 'back' as const }] : []),
    ...(options.before === undefined
      ? []
      : [{ kind: 'before' as const, anchorId: options.before }]),
    ...(options.after === undefined ? [] : [{ kind: 'after' as const, anchorId: options.after }]),
  ];
  if (given.length > 1) {
    throw new Error(
      '置き場所は --front / --back / --before <id> / --after <id> のうち1つだけ指定してください。',
    );
  }
  return given[0];
}

export interface TasksAddOptions extends TaskPlacementOptions {
  title?: string;
  body?: string;
  /** 起点の会話の id。 */
  source?: string;
}

export interface TasksCloseOptions {
  status?: string;
  reason?: string;
}

export interface TasksReopenOptions {
  reason?: string;
}

export interface TasksEditOptions {
  title?: string;
  body?: string;
  /** `tasks show` で読んだ版（`editedAt` が在ればそれ、無ければ `createdAt`）。違えば書かずに断る。 */
  ifMatch?: string;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} を指定してください。`);
  }
  return value;
}

async function failedWith(
  response: Response,
  target: Awaited<ReturnType<typeof resolveTarget>>,
  what: string,
): Promise<Error> {
  const detail = await failureText(response);
  // `PATCH /tasks/:id` の 403 は「origin が human ではない」という行の話で、アカウントの許可の話（describeAuthFailure）ではない
  const rowForbidden = response.status === 403 && detail.includes("origin:'");
  const described = rowForbidden ? null : describeAuthFailure(response.status, target);
  if (described !== null) return new Error(described);
  return new Error(`${what}（HTTP ${String(response.status)}）${detail}`);
}

export function renderTaskDetail(task: TaskRowView & { editedAt?: string | undefined }): string {
  const lines = [
    `[${task.status}] ${task.title}`,
    `  id: ${task.id}  起点: ${task.origin}${task.source === undefined ? '' : `(${task.source})`}`,
    `  作成: ${task.createdAt}  更新: ${task.updatedAt}` +
      (task.editedAt === undefined ? '' : `  編集: ${task.editedAt}`) +
      `  版（--if-match）: ${task.editedAt ?? task.createdAt}`,
  ];
  if (task.closedAt !== undefined) {
    lines.push(
      `  閉じた: ${task.closedAt}${task.closedBy === undefined ? '' : `（${task.closedBy}）`}  ${task.closedReason ?? ''}`,
    );
  }
  lines.push('', task.body);
  return lines.join('\n');
}

export async function tasksShowCommand(id: string): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks[':id'].$get({ param: { id } });
  if (!response.ok) {
    throw await failedWith(response, target, `task ${id} を読めませんでした`);
  }
  const { entry } = (await response.json()) as { entry: TaskRowView };
  stdout.write(`${redactBody(renderTaskDetail(entry))}\n`);
}

export async function tasksAddCommand(options: TasksAddOptions = {}): Promise<void> {
  const title = required(options.title, '--title');
  const body = required(options.body, '--body');
  const placement = placementOf(options);
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks.$post({
    json: {
      title,
      body,
      ...(options.source === undefined ? {} : { source: options.source }),
      ...(placement === undefined ? {} : { placement }),
    },
  });
  if (!response.ok) {
    throw await failedWith(response, target, 'task を積めませんでした');
  }
  const { id } = (await response.json()) as { id: string };
  stdout.write(`積んだ（積むだけで、クローンのターンは起こさない）。id: ${id}\n`);
}

export async function tasksCloseCommand(
  id: string,
  options: TasksCloseOptions = {},
): Promise<void> {
  const status = options.status;
  if (status !== 'done' && status !== 'cancelled') {
    throw new Error('--status は done か cancelled を指定してください。');
  }
  const reason = required(options.reason, '--reason');
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks[':id'].close.$post({
    param: { id },
    json: { status, reason },
  });
  if (!response.ok) {
    throw await failedWith(response, target, `task ${id} を閉じられませんでした`);
  }
  stdout.write(`閉じた（${status}）。id: ${id}\n`);
}

export async function tasksReopenCommand(
  id: string,
  options: TasksReopenOptions = {},
): Promise<void> {
  const reason = required(options.reason, '--reason');
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks[':id'].reopen.$post({ param: { id }, json: { reason } });
  if (!response.ok) {
    throw await failedWith(response, target, `task ${id} を開き直せませんでした`);
  }
  stdout.write(`開き直した（queued）。id: ${id}\n`);
}

export async function tasksMoveCommand(
  id: string,
  options: TaskPlacementOptions = {},
): Promise<void> {
  const placement = placementOf(options);
  if (placement === undefined) {
    throw new Error(
      '置き場所を --front / --back / --before <id> / --after <id> のどれかで指定してください。',
    );
  }
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks[':id'].move.$post({ param: { id }, json: { placement } });
  if (!response.ok) {
    throw await failedWith(response, target, `task ${id} を動かせませんでした`);
  }
  stdout.write(`動かした。id: ${id}\n`);
}

export async function tasksEditCommand(id: string, options: TasksEditOptions = {}): Promise<void> {
  if (options.title === undefined && options.body === undefined) {
    throw new Error('--title か --body の少なくとも一方を指定してください。');
  }
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.tasks[':id'].$patch({
    param: { id },
    json: {
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
    },
  });
  if (!response.ok) {
    throw await failedWith(response, target, `task ${id} を直せませんでした`);
  }
  stdout.write(`直した。id: ${id}\n`);
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
