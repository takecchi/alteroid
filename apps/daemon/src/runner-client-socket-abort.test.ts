import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createHttpRunner } from './runner-client.js';

// `/health` と `/managers` に答え、`/managers` は `mode` で返し方を変える runner（#5960）。届いた要求の数を数える
type Mode = 'ok' | 'never-answer' | 'stall-body';
let server: Server | undefined;
let managersRequests = 0;
const open = new Set<ServerResponse>();
afterEach(async () => {
  for (const res of open) res.destroy();
  open.clear();
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  server = undefined;
  managersRequests = 0;
});

async function runner(mode: Mode): Promise<string> {
  const socketPath = join(makeTempDirSync('alteroid-sock-abort-'), 'runner.sock');
  server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runnerId: 'runner-abort' }));
      return;
    }
    managersRequests += 1;
    open.add(res);
    if (mode === 'never-answer') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'ok') {
      res.end(JSON.stringify({ managers: [] }));
      return;
    }
    res.write('{"managers":');
  });
  await new Promise<void>((resolve) => server?.listen({ path: socketPath }, resolve));
  return `unix:${socketPath}`;
}

async function connect(mode: Mode) {
  return createHttpRunner({ baseUrl: await runner(mode), token: 'token' });
}

describe('Unix ソケットの runner への要求の中断（#5960）', () => {
  it('⭐ 中断済みの合図なら、runner へ要求を送らず、合図の理由で拒否する', async () => {
    const client = await connect('ok');
    const reason = new Error('もう要らない');
    const controller = new AbortController();
    controller.abort(reason);
    await expect(client.list({ signal: controller.signal })).rejects.toBe(reason);
    expect(managersRequests).toBe(0);
  });

  it('⭐ 応答が来る前に中断したら、合図の理由で拒否で決着する（`socket hang up` に化けない）', async () => {
    const client = await connect('never-answer');
    const reason = new Error('期限');
    const controller = new AbortController();
    const settled = client.list({ signal: controller.signal });
    const outcome = expect(settled).rejects.toBe(reason);
    await waitUntil(() => managersRequests === 1);
    controller.abort(reason);
    await outcome;
  });

  it('⭐ 本文を流している途中で中断したら、本文の読みが合図の理由で失敗する', async () => {
    const client = await connect('stall-body');
    const reason = new Error('途中で中断');
    const controller = new AbortController();
    const settled = client.list({ signal: controller.signal });
    const outcome = expect(settled).rejects.toBe(reason);
    await waitUntil(() => managersRequests === 1);
    // 見出しが届いて本文が止まったあとに中断する（実時間では待たず、ループを何周か回して届くのを待つ）
    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(reason);
    await outcome;
  });

  it('合図に理由を付けない中断（`abort()`）は、既定の `AbortError` で拒否する', async () => {
    const client = await connect('never-answer');
    const controller = new AbortController();
    const settled = client.list({ signal: controller.signal });
    const outcome = expect(settled).rejects.toMatchObject({ name: 'AbortError' });
    await waitUntil(() => managersRequests === 1);
    controller.abort();
    await outcome;
  });

  it('合図を渡した普通の要求は、今までどおり応答を返す', async () => {
    const client = await connect('ok');
    const controller = new AbortController();
    await expect(client.list({ signal: controller.signal })).resolves.toEqual([]);
    expect(managersRequests).toBe(1);
  });

  it('合図を渡さない普通の要求も、今までどおり応答を返す', async () => {
    const client = await connect('ok');
    await expect(client.list()).resolves.toEqual([]);
  });

  it('決着した要求の合図に、abort の listener を残さない', async () => {
    const client = await connect('ok');
    const controller = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      (add as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof add;
    controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      (remove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof remove;
    await client.list({ signal: controller.signal });
    await waitUntil(() => removed.includes('abort'));
    expect(added.filter((type) => type === 'abort')).toHaveLength(1);
    expect(removed.filter((type) => type === 'abort')).toHaveLength(1);
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!condition()) throw new Error('条件が満たされなかった');
  });
}
