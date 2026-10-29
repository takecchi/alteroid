import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { json, Providers } from '~/test-support';
import type { Task } from '@alteroid/logic';

import Tasks from './tasks';
import TaskDetail from './tasks-detail';

export const CREATED = '2026-09-01T00:00:00.000Z';

export function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    createdAt: CREATED,
    updatedAt: CREATED,
    status: 'queued',
    origin: 'human',
    title: '週次レビューを出す',
    body: '金曜までにレビューを出す。\n詳細は本文に書く。',
    ...over,
  };
}

export interface Sent {
  method: string;
  path: string;
  body: unknown;
}

type Placement =
  | { kind: 'front' }
  | { kind: 'back' }
  | { kind: 'before'; anchorId: string }
  | { kind: 'after'; anchorId: string };

/** デーモンの `/tasks` の口の最小の写し。並び（`rows` の順）と閉じた行を持ち、書く口の呼びを `sent` に残す。 */
export function stubTasksServer(initial: Task[]) {
  let rows: Task[] = [...initial];
  const sent: Sent[] = [];
  const gets: string[] = [];
  let nextId = 1;
  // 次の書く口を決まった応答で断らせる: 403・409 の見せ方を試すため
  let refuseNext: { status: number; body: unknown } | undefined;
  const openRows = () => rows.filter((row) => row.status !== 'done' && row.status !== 'cancelled');
  const closedRows = () =>
    rows.filter((row) => row.status === 'done' || row.status === 'cancelled');

  function place(row: Task, placement: Placement | undefined) {
    const others = rows.filter((entry) => entry.id !== row.id);
    const open = others.filter((entry) => entry.status !== 'done' && entry.status !== 'cancelled');
    const closed = others.filter(
      (entry) => entry.status === 'done' || entry.status === 'cancelled',
    );
    let index = open.length;
    if (placement?.kind === 'front') index = 0;
    if (placement?.kind === 'before') index = open.findIndex((e) => e.id === placement.anchorId);
    if (placement?.kind === 'after') index = open.findIndex((e) => e.id === placement.anchorId) + 1;
    open.splice(index, 0, row);
    rows = [...open, ...closed];
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const match = /\/tasks(?:\/([^/]+))?(?:\/(close|reopen|move))?$/.exec(url.pathname);
    if (match === null) throw new TypeError(`Failed to fetch: ${request.url}`);
    const [, id, verb] = match;
    if (request.method === 'GET') {
      gets.push(`${url.pathname}${url.search}`);
      if (id !== undefined) {
        const found = rows.find((row) => row.id === id);
        return found === undefined ? json({ error: 'not found' }, 404) : json({ entry: found });
      }
      const includeClosed = url.searchParams.get('includeClosed') === 'true';
      return json({
        entries: includeClosed ? [...openRows(), ...closedRows()] : openRows(),
        unreadable: [],
      });
    }
    const body = (await request.json()) as Record<string, unknown>;
    sent.push({ method: request.method, path: url.pathname, body });
    if (refuseNext !== undefined) {
      const refused = refuseNext;
      refuseNext = undefined;
      return json(refused.body, refused.status);
    }
    if (request.method === 'POST' && id === undefined) {
      const created = task({
        id: `new-${nextId++}`,
        title: String(body.title),
        body: String(body.body),
      });
      place(created, body.placement as Placement | undefined);
      return json({ ok: true, id: created.id });
    }
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return json({ error: 'not found' }, 404);
    const row = rows[index]!;
    if (verb === 'close') {
      rows[index] = {
        ...row,
        status: body.status as Task['status'],
        closedAt: '2026-09-05T00:00:00.000Z',
        closedReason: String(body.reason),
        closedBy: 'human',
      };
      rows = [...openRows(), ...closedRows()];
      return json({ ok: true });
    }
    if (verb === 'reopen') {
      const reopened: Task = { ...row, status: 'queued' };
      delete reopened.closedAt;
      delete reopened.closedReason;
      delete reopened.closedBy;
      place(reopened, undefined);
      return json({ entry: rows.find((entry) => entry.id === id) });
    }
    if (verb === 'move') {
      place(row, body.placement as Placement);
      return json({ ok: true });
    }
    // PATCH
    if (body.ifMatch !== undefined && body.ifMatch !== (row.editedAt ?? row.createdAt)) {
      return json(
        { error: 'task が読んだ後に変わっています（書き換えていません）', current: row },
        409,
      );
    }
    rows[index] = {
      ...row,
      ...(body.title === undefined ? {} : { title: String(body.title) }),
      ...(body.body === undefined ? {} : { body: String(body.body) }),
      editedAt: '2026-09-04T00:00:00.000Z',
    };
    return json({ ok: true });
  }) as typeof fetch;

  return {
    gets,
    writes: () => sent,
    rows: () => rows,
    /** 別のタブ・CLI がこの行を書き換えた。 */
    changeBehind: (id: string, change: Partial<Task>) => {
      rows = rows.map((row) =>
        row.id === id ? { ...row, ...change, editedAt: '2026-09-03T00:00:00.000Z' } : row,
      );
    },
    refuseNext: (status: number, body: unknown) => {
      refuseNext = { status, body };
    },
  };
}

export function renderTasksAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/tasks', Component: Tasks },
      { path: '/tasks/:id', Component: TaskDetail },
    ],
    { initialEntries: [path] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}
