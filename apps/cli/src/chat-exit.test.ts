import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { endConversationOnExit } from './chat.js';
import type { createClient } from './client.js';
import type { Target } from './target.js';

const target: Target = { baseUrl: 'http://127.0.0.1:1', headers: {}, remote: false, note: null };

function endClient(reply: () => Promise<Response>) {
  const calls: string[] = [];
  const client = {
    chat: {
      ':conversationId': {
        end: {
          $post: ({ param }: { param: { conversationId: string } }) => {
            calls.push(param.conversationId);
            return reply();
          },
        },
      },
    },
  } as unknown as ReturnType<typeof createClient>;
  return { client, calls };
}

async function run(reply: () => Promise<Response>) {
  const { client, calls } = endClient(reply);
  const written: string[] = [];
  await endConversationOnExit(client, target, 'c1', (t) => written.push(t));
  return { calls, text: written.join('') };
}

// 開発機の ALTEROID_URL が「手元のデーモン」の文を変えないようにする
beforeEach(() => {
  vi.stubEnv('ALTEROID_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('REPL を抜けるときの会話終了', () => {
  it('成功したら、要求の後に「蒸留しています」と言う', async () => {
    const { calls, text } = await run(() => Promise.resolve(new Response('{}', { status: 200 })));
    expect(calls).toEqual(['c1']);
    expect(text).toContain('（学びを記憶へ蒸留しています…）');
    expect(text).not.toContain('終えられませんでした');
  });

  it('非 ok（500）なら、終わっておらず蒸留も走っていないこと・あとで終える手段を出す', async () => {
    const { text } = await run(() =>
      Promise.resolve(new Response(JSON.stringify({ error: '壊れた' }), { status: 500 })),
    );
    expect(text).not.toContain('蒸留しています');
    expect(text).toContain('会話 c1 を終えられませんでした（壊れた）');
    expect(text).toContain('会話は終わっておらず');
    expect(text).toContain('「会話を終える」');
    expect(text).toContain('/end');
  });

  it('401 は認証の案内を理由にする', async () => {
    const { text } = await run(() => Promise.resolve(new Response('{}', { status: 401 })));
    expect(text).not.toContain('蒸留しています');
    expect(text).toContain('認証されませんでした');
  });

  it('例外（デーモンに届かない）でも握りつぶさず、同じ断りを出す', async () => {
    const { text } = await run(() => Promise.reject(new Error('fetch failed')));
    expect(text).not.toContain('蒸留しています');
    expect(text).toContain('会話 c1 を終えられませんでした（fetch failed）');
  });

  it('デーモンに繋がらない接続の失敗は、繋がらないことと直し方を言う（#4003）', async () => {
    const error = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const { text } = await run(() => Promise.reject(error));
    expect(text).not.toContain('蒸留しています');
    expect(text).toContain('会話 c1 を終えられませんでした');
    expect(text).toContain('手元のデーモンに繋がりませんでした（接続を断られました）');
    expect(text).toContain('alteroid daemon start');
    expect(text).not.toContain('（fetch failed）');
    expect(text).toContain('会話は終わっておらず');
  });

  it('接続先を ALTEROID_URL で指していれば、その値の確認を言う（#4003）', async () => {
    vi.stubEnv('ALTEROID_URL', 'http://remote.example:4517/path');
    const { text } = await run(() => Promise.reject(new TypeError('fetch failed')));
    expect(text).toContain('接続先（http://remote.example:4517）に繋がりませんでした');
    expect(text).toContain('ALTEROID_URL の値が合っているか');
  });
});
