import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout, pretendTty } from './test-support.js';

/**
 * 戻せない操作の確認でやめたら、終了コードが非 0 になる（#3450）。
 *
 * **commander を通して argv から走らせる。** コマンド関数を直接呼ぶと、入口の最上位
 * （`index.ts` の catch。stderr へ1行言って終了コードを決める）を通らず、「やめたのに 0」を
 * 測れない。ここでは `program.parseAsync(argv)` の失敗を `reportCliFailure`（最上位の catch が
 * 呼ぶもの）へ渡し、返った終了コードと stderr・stdout を見る。
 *
 * 端末で `no` と答えた形を作る（TTY を装い、`readline` の質問に `no` を返す）。
 */
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
      // 成功の文を stdout に出さない（確認の質問は出る）。
      expect(stdoutText()).not.toMatch(/消しました|削除しました|リセットしました/);
      // 何も変えていない（書き換え系の HTTP に出ていない）。
      expect(sent.filter((entry) => entry.method !== 'GET')).toEqual([]);
    },
  );
});
