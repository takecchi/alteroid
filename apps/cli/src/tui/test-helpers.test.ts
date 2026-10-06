import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitFor } from './test-helpers.js';

describe('waitFor（時間切れで throw する。#3520）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('条件が成り立っていれば待たずに戻る', async () => {
    await expect(waitFor(() => true)).resolves.toBeUndefined();
  });

  it('待っている間に条件が成り立てば、そこで戻る', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 100);
    const done = waitFor(() => ready, { tickMs: 20, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(120);
    await expect(done).resolves.toBeUndefined();
  });

  it('時間切れまでに成り立たなければ throw し、説明が文言に出る', async () => {
    const done = waitFor(() => false, {
      tickMs: 20,
      timeoutMs: 500,
      description: '承認待ちの件数が 3 になる',
    });
    const caught = done.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600);
    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('500ms');
    expect((error as Error).message).toContain('承認待ちの件数が 3 になる');
  });

  it('説明が無ければ、条件の式が文言に出る', async () => {
    const caught = waitFor(() => 1 + 1 === 3, { timeoutMs: 100 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    expect(((await caught) as Error).message).toContain('1 + 1 === 3');
  });
});
