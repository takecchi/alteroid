import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

vi.mock('./target.js', async () => {
  const actual = await vi.importActual<typeof import('./target.js')>('./target.js');
  return {
    ...actual,
    resolveTarget: vi.fn(() =>
      Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
    ),
  };
});

const { tasksCommand, renderTasks } = await import('./tasks.js');

let sent: string[] = [];
let originalFetch: typeof fetch;
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  reply = { status: 200, body: { entries: [], unreadable: [] } };
  globalThis.fetch = ((input: unknown) => {
    const request = input as { url?: string };
    sent.push(typeof input === 'string' ? input : (request.url ?? String(input)));
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const AT = '2026-10-01T00:00:00.000Z';
const row = (overrides: Record<string, unknown>) => ({
  id: 't',
  status: 'queued',
  origin: 'self',
  title: 'タイトル',
  body: '本文',
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

describe('renderTasks', () => {
  it('開いている行には並びの番号を振り、閉じた行には番号を振らず閉じた理由を出す', () => {
    const out = renderTasks(
      {
        entries: [
          row({ id: 'a', title: '一つ目' }),
          row({ id: 'b', title: '二つ目', status: 'waiting' }),
          row({
            id: 'c',
            title: '済んだ',
            status: 'done',
            closedAt: AT,
            closedReason: '済んだ理由',
          }),
        ],
        unreadable: [],
      },
      Date.parse(AT),
    );
    expect(out).toMatch(/^ {2}1 \[queued\] 一つ目/m);
    expect(out).toMatch(/^ {2}2 \[waiting\] 二つ目/m);
    expect(out).toMatch(/^ {2}✓ \[done\] 済んだ/m);
    expect(out).toContain('済んだ理由');
  });

  it('本文は先頭の一行を80字で切り、全文は出さない', () => {
    const out = renderTasks({
      entries: [row({ body: `${'あ'.repeat(200)}\n二行目の印` })],
      unreadable: [],
    });
    expect(out).toContain('…');
    expect(out).not.toContain('二行目の印');
  });

  it('空のときは空と言い、読めない行は「終わったのではない」と添える', () => {
    expect(renderTasks({ entries: [], unreadable: [] })).toBe('（task は無い）');
    expect(renderTasks({ entries: [], unreadable: [{ id: 'x', reason: 'r' }] })).toContain(
      '終わったのではない',
    );
  });
});

describe('alteroid tasks', () => {
  it('既定は includeClosed=false で GET /tasks を叩く', async () => {
    reply = { status: 200, body: { entries: [row({ title: '見える' })], unreadable: [] } };
    const read = captureStdout();
    await tasksCommand();
    expect(sent[0]).toContain('/tasks');
    expect(sent[0]).toContain('includeClosed=false');
    expect(read()).toContain('見える');
  });

  it('--all は includeClosed=true', async () => {
    const read = captureStdout();
    await tasksCommand({ all: true });
    expect(sent[0]).toContain('includeClosed=true');
    read();
  });

  it('HTTP の失敗は黙らず例外にする', async () => {
    reply = { status: 500, body: {} };
    await expect(tasksCommand()).rejects.toThrow(/HTTP 500/);
  });
});
