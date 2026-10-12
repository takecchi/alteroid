import { describe, expect, it, vi } from 'vitest';

import { createHttpRunner } from './runner-client.js';

const TOKEN = 'test-runner-token';

function pathOf(input: string | URL | Request): string {
  return new URL(typeof input === 'string' ? input : input.toString()).pathname;
}

/**
 * `/events` に、1つの大きなフレームを 64KB ずつに割ったかけらを、最初から全部溜めた状態で渡す。
 * 溜まっている流れの `read()` はマイクロタスクで次々に解決するので、読み手が自分から順番を返さないと、
 * フレームを読み終えるまでタイマーも他の入出力も一度も回らない（#4485）。
 */
function fetchWithBufferedFrame(frame: string): typeof fetch {
  let served = false;
  return (async (input: string | URL | Request) => {
    const path = pathOf(input);
    if (path === '/health') {
      return Response.json({ runnerId: 'runner-yield', workspacePath: '/workspace' });
    }
    if (path === '/events') {
      if (served) return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      served = true;
      const bytes = new TextEncoder().encode(frame);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
              controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
            }
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    throw new Error(`このテストの偽 runner が想定していないパス: ${path}`);
  }) as typeof fetch;
}

// 2026-10-13T16:52〜16:54Z、利用上限で担当が一斉に畳まれた直後に、印の無い 6〜7 秒の停止が続いた。
// 16:54:19Z の回は、155MB のフレームの大きさの印が窓に入って 3166ms 後に付いた（読み込みと組み立ての間、ループが返らなかった）（#4485）
describe('runner の SSE を読む間も、大きな流れの途中でループへ順番を返す（#4485）', () => {
  it('溜まった 4MB のフレームを読み終える前に、setImmediate の仕事が回る', async () => {
    const event = { type: 'note', managerId: 'mgr-1', text: 'x'.repeat(4 * 1024 * 1024) };
    const frame = `id: 1\ndata: ${JSON.stringify(event)}\n\n`;
    const order: string[] = [];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchWithBufferedFrame(frame),
    });

    await client.connect((received) => {
      order.push(`event:${received.type}`);
    });
    // 読み始めた後に積む: 読み手が順番を返さなければ、フレームを渡し終えるまでこれは回らない
    setImmediate(() => order.push('immediate'));
    await vi.waitFor(() => expect(order).toContain('event:note'), { timeout: 10_000 });
    await client.close?.();

    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('event:note'));
  });
});
