import type { RunnerResumeCommand } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createHttpRunner, resumeBodyYielding } from './runner-client.js';

const BASE = {
  managerId: 'mgr-1',
  sessionId: 'sess-1',
  cwd: '/workspace',
  request: '続けて',
} as const;

async function parsedBody(command: RunnerResumeCommand, yieldChars: number): Promise<unknown> {
  return JSON.parse(await new Response(resumeBodyYielding(command, yieldChars)).text());
}

describe('resumeBodyYielding（#4630）', () => {
  it('塊に割っても、受け手が読む値は JSON.stringify と同じ（塊の境目で割れる多バイト文字を含む）', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      type: 'assistant',
      uuid: `u-${index}`,
      text: `続き🙂${'あ'.repeat(index * 7)}`,
    }));
    const command = { ...BASE, entries };
    for (const yieldChars of [1, 64, 1024 * 1024]) {
      expect(await parsedBody(command, yieldChars)).toEqual(
        JSON.parse(JSON.stringify(command)) as unknown,
      );
    }
  });

  it('entries が無い・空・undefined を含むときも同じ値になる', async () => {
    const cases: RunnerResumeCommand[] = [
      { ...BASE },
      { ...BASE, entries: [] },
      { ...BASE, entries: [undefined, { a: 1 }] },
    ];
    for (const command of cases) {
      expect(await parsedBody(command, 1)).toEqual(JSON.parse(JSON.stringify(command)) as unknown);
    }
  });
});

// 委譲の resume は生ログの全件を本文に載せる。1回の JSON.stringify にすると、会話の全字数ぶんデーモンのループが塞がる（#4630・#4485）
describe('HttpRunner#resume() は大きな生ログを送る間もループへ順番を返す（#4630）', () => {
  it('8MB の entries を送り終える前に、setImmediate の仕事が回り、runner には元の命令が届く', async () => {
    const entries = Array.from({ length: 64 }, (_, index) => ({
      uuid: `u-${index}`,
      text: 'x'.repeat(128 * 1024),
    }));
    const command = { ...BASE, entries };
    const order: string[] = [];
    let received: unknown;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
      if (path === '/health') return Response.json({ runnerId: 'r', workspacePath: '/workspace' });
      if (path === '/managers/mgr-1/resume') {
        received = JSON.parse(await new Response(init?.body).text());
        order.push('body-done');
        return Response.json({ ok: true, cwd: '/workspace' });
      }
      throw new Error(`想定していないパス: ${path}`);
    }) as typeof fetch;
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: 'test-runner-token',
      fetchFn,
    });

    const resumed = client.resume(command);
    // 送り始めた後に積む: 送り手が順番を返さなければ、本文を作り終えるまでこれは回らない
    setImmediate(() => order.push('immediate'));
    expect(await resumed).toEqual({ cwd: '/workspace' });
    await client.close?.();

    expect(received).toEqual(command);
    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('body-done'));
  });
});
