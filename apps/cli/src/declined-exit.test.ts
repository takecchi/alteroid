import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout, pretendTty } from './test-support.js';

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: () => Promise.resolve('no'),
    close: () => undefined,
  }),
}));

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({ baseUrl: 'http://127.0.0.1:4517', headers: {}, note: null, remote: false }),
}));

const { program, reportCliFailure } = await import('./index.js');

let sent: { method: string; path: string }[];
let originalFetch: typeof fetch;
let restoreTty: () => void;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const request = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : (request.url ?? String(input));
    const method = init?.method ?? request.method ?? 'GET';
    const path = new URL(url).pathname;
    sent.push({ method, path });
    const body =
      path === '/tokens'
        ? { tokens: [{ id: 't1' }] }
        : path === '/memory/x'
          ? { document: { slug: 'x', content: 'a', version: 'v1' } }
          : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  restoreTty = pretendTty(true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreTty();
  vi.restoreAllMocks();
});

describe('戻せない操作の確認でやめたときの終了コード（#3450）', () => {
  it.each([
    ['memory remove', ['memory', 'remove', 'x']],
    ['token remove', ['token', 'remove', 't1']],
    ['reset', ['reset']],
  ])(
    '%s: yes 以外の答えなら、何も変えずに非 0 で終わり、stderr に1行で言う',
    async (_name, argv) => {
      const stdoutText = captureStdout();
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });

      let code = 0;
      await program.parseAsync(['node', 'alteroid', ...argv]).catch((error: unknown) => {
        code = reportCliFailure(error);
      });

      expect(code).not.toBe(0);
      expect(stderr.join('')).toBe('alteroid: 取り消しました。何も変更していません。\n');
      expect(stdoutText()).not.toMatch(/消しました|削除しました|リセットしました/);
      expect(sent.filter((entry) => entry.method !== 'GET')).toEqual([]);
    },
  );
});
