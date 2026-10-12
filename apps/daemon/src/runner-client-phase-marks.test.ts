import { describe, expect, it, vi } from 'vitest';

// 印そのものだけを差し替える: 見張りの本体は使わない
const phases = vi.hoisted(() => [] as string[]);
vi.mock('@alteroid/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alteroid/core')>()),
  notePhase: (label: string) => {
    phases.push(label);
  },
}));

const { createHttpRunner } = await import('./runner-client.js');

const TOKEN = 'test-runner-token';

function pathOf(input: string | URL | Request): string {
  return new URL(typeof input === 'string' ? input : input.toString()).pathname;
}

/** `/events` は渡したフレームを1回だけ流して閉じる。2回目以降の接続は開いたまま何も流さない（閉じた後の再接続で試験を回し続けない）。 */
function fetchWithFrames(frames: string[]): typeof fetch {
  let served = false;
  return (async (input: string | URL | Request) => {
    const path = pathOf(input);
    if (path === '/health') {
      return Response.json({ runnerId: 'runner-marks', workspacePath: '/workspace' });
    }
    if (path === '/events') {
      if (served) return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      served = true;
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    throw new Error(`このテストの偽 runner が想定していないパス: ${path}`);
  }) as typeof fetch;
}

function sse(id: number, event: unknown): string {
  return `id: ${String(id)}\ndata: ${JSON.stringify(event)}\n\n`;
}

// 本番の `loop-stall`（2026-10-13）で「直前の印: runner-event:tool_use・窓の中に印なし」の 2〜4 秒の停止が続いた。
// 止めていたのが解析か、受けた後の処理（日誌への書き込み）か、どの大きさの出来事かを、印から分けられなかった（#4485）。
describe('runner の出来事の印は、大きさと種類と、受けた後の処理の終わりを残す（#4485）', () => {
  it('種類の印にバイト数を添え、受けた後の同期の処理を抜けたところにも印を打つ', async () => {
    phases.length = 0;
    const input = { file_path: '/work/a.txt', content: 'x'.repeat(5000) };
    const event = {
      type: 'tool_use',
      managerId: 'mgr-1',
      actor: 'manager:mgr-1',
      tool: 'Write',
      input,
    };
    const data = JSON.stringify(event);
    const handled: string[] = [];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn: fetchWithFrames([sse(1, event)]),
    });

    await client.connect((received) => {
      // 受けた後の処理の中で打たれた印（日誌への書き込みなど）は、抜けた印より前に並ぶ
      phases.push('inside-handler');
      handled.push(received.type);
    });
    await vi.waitFor(() => expect(handled).toEqual(['tool_use']), { timeout: 5_000 });
    await client.close?.();

    const ours = phases.filter(
      (label) => label.startsWith('runner-') || label === 'inside-handler',
    );
    expect(ours).toEqual([
      `runner-event:${String(data.length)}B`,
      `runner-event:tool_use:${String(data.length)}B`,
      'inside-handler',
      'runner-event-handled:tool_use',
    ]);
  });
});
