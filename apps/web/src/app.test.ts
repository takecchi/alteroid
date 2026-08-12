import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createWebApp } from './app.js';

/**
 * WebUI の器のテスト。
 *
 * 確かめたいのは「デーモンの API がそのまま前へ通ること」と、「通す過程で
 * 境界を薄めないこと」の2つである。画面の見た目ではない。
 */

const DAEMON = 'http://daemon.invalid:4517';
// 束ねる前の置き場（配信時は dist/public。中身の同じものを見ている）
const ASSETS = fileURLToPath(new URL('../public', import.meta.url));

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** 偽のデーモン。受け取ったものをそのまま記録して返す。 */
function stubDaemon(respond?: (request: Recorded) => Response): {
  calls: Recorded[];
  fetchImpl: typeof fetch;
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body =
      init?.body === undefined
        ? ''
        : new TextDecoder().decode(new Uint8Array(init.body as ArrayBuffer));
    const recorded = { url: String(input), method: init?.method ?? 'GET', headers, body };
    calls.push(recorded);
    return respond?.(recorded) ?? Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function appWith(fetchImpl: typeof fetch) {
  return createWebApp({ daemonOrigin: DAEMON, assetsDir: ASSETS, fetchImpl });
}

describe('createWebApp', () => {
  it('/api/* をパスと問い合わせごとデーモンへ通す', async () => {
    const { calls, fetchImpl } = stubDaemon(() => Response.json({ managers: [] }));
    const response = await appWith(fetchImpl).request('/api/managers?limit=3');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ managers: [] });
    expect(calls[0]?.url).toBe(`${DAEMON}/managers?limit=3`);
    expect(calls[0]?.method).toBe('GET');
  });

  it('POST の本文と content-type をそのまま渡す', async () => {
    const { calls, fetchImpl } = stubDaemon();
    await appWith(fetchImpl).request('/api/approvals/abc/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'いいよ' }),
    });

    expect(calls[0]?.url).toBe(`${DAEMON}/approvals/abc/answer`);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ answer: 'いいよ' });
  });

  /**
   * デーモンは本文の無い POST に `application/json` を要求する。それが
   * 「ブラウザの単純リクエストで他人がクローンのターンを起こせない」境界である。
   * プロキシが気を利かせて付け足すと、その境界がここで消える。
   */
  it('content-type を補わない（デーモン側の境界を薄めない）', async () => {
    const { calls, fetchImpl } = stubDaemon();
    await appWith(fetchImpl).request('/api/schedule/daily_report/run', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: 'x',
    });

    expect(calls[0]?.headers['content-type']).toBe('text/plain;charset=UTF-8');
  });

  it('本文の無い POST をそのまま（本文なしで）通す', async () => {
    const { calls, fetchImpl } = stubDaemon();
    await appWith(fetchImpl).request('/api/chat/conv-1/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toBe('');
  });

  it('CORS ヘッダを足さない（別オリジンの画面からは読めないまま）', async () => {
    const { fetchImpl } = stubDaemon();
    const response = await appWith(fetchImpl).request('/api/managers', {
      headers: { origin: 'http://evil.invalid' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('SSE を読み切らずに流す', async () => {
    let push: ((chunk: string) => void) | null = null;
    let finish: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => {
          controller.enqueue(encoder.encode(chunk));
        };
        finish = () => {
          controller.close();
        };
      },
    });
    const { fetchImpl } = stubDaemon(
      () =>
        new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        }),
    );

    const response = await appWith(fetchImpl).request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'やあ' }),
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // 応答が終わる前に、届いた分だけ読めること（読み切ってから返すと
    // クローンの返答が終わるまで画面に一文字も出ない）
    push!('event: open\ndata: {"conversationId":"c1"}\n\n');
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"conversationId":"c1"');

    push!('event: text\ndata: {"type":"text","text":"はい"}\n\n');
    const second = await reader.read();
    expect(decoder.decode(second.value)).toContain('はい');

    finish!();
    expect((await reader.read()).done).toBe(true);
  });

  it('デーモンへ繋がらなければ 502 で理由を返す', async () => {
    const fetchImpl = (() => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const response = await appWith(fetchImpl).request('/api/managers');

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('ECONNREFUSED') });
  });

  it('デーモンの状態コードを握りつぶさない', async () => {
    const { fetchImpl } = stubDaemon(() => Response.json({ error: 'not found' }, { status: 404 }));
    const response = await appWith(fetchImpl).request('/api/reports/2026-01-01');

    expect(response.status).toBe(404);
  });

  it('画面を配る', async () => {
    const { fetchImpl } = stubDaemon();
    const app = appWith(fetchImpl);

    const page = await app.request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>alteroid</title>');

    const styles = await app.request('/styles.css');
    expect(styles.status).toBe(200);
    expect(styles.headers.get('content-type')).toContain('text/css');
  });

  it('列挙していないパスは配らない', async () => {
    const { calls, fetchImpl } = stubDaemon();
    const response = await appWith(fetchImpl).request('/../package.json');

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
