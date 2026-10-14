import type { SSEStreamingApi } from 'hono/streaming';
import { describe, expect, it } from 'vitest';

import { guardSseWrites } from './sse-write-deadline.js';

function fakeStream(write: () => Promise<void>) {
  const state = { aborted: false, aborts: 0 };
  const stream = {
    get aborted() {
      return state.aborted;
    },
    closed: false,
    abort() {
      state.aborted = true;
      state.aborts += 1;
    },
    writeSSE: () => write(),
    write: async () => {
      await write();
      return stream;
    },
  };
  return { stream: stream as unknown as SSEStreamingApi, state };
}

describe('SSE の書き出しの期限（#4671）', () => {
  it('⭐ 返らない書き出しは期限で戻り、流れを畳み、知らせる', async () => {
    const { stream, state } = fakeStream(() => new Promise<void>(() => undefined));
    const expired: string[] = [];
    const guarded = guardSseWrites(stream, 20, (what) => expired.push(what));

    await guarded.writeSSE({ data: 'x' });
    expect(state.aborts).toBe(1);
    expect(guarded.aborted).toBe(true);
    await guarded.write('y');
    // 畳んだ後は二度目の abort をしない
    expect(state.aborts).toBe(1);
    expect(expired).toEqual(['writeSSE']);
  });

  it('期限内に終わる書き出しはそのまま通り、失敗はそのまま投げる', async () => {
    const ok = fakeStream(async () => undefined);
    const guarded = guardSseWrites(ok.stream, 1_000, () => {
      throw new Error('呼ばれないはず');
    });
    await guarded.writeSSE({ data: 'x' });
    expect(ok.state.aborts).toBe(0);

    const failing = fakeStream(() => Promise.reject(new Error('書けなかった')));
    await expect(
      guardSseWrites(failing.stream, 1_000, () => undefined).writeSSE({ data: 'x' }),
    ).rejects.toThrow('書けなかった');
  });
});
