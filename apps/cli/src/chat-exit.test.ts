import { describe, expect, it } from 'vitest';

import { endConversationOnExit } from './chat.js';
import type { createClient } from './client.js';
import type { Target } from './target.js';

const target: Target = { baseUrl: 'http://127.0.0.1:1', headers: {}, remote: false, note: null };

/** `POST /chat/:id/end` だけを差し替えたクライアント。呼ばれた id を `calls` に積む。 */
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
});
