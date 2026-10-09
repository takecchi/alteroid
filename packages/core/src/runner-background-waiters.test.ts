import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunnerBackgroundWaiters } from './runner-background-waiters.js';

describe('RunnerBackgroundWaiters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('呼んだ時点で条件が真なら、待たずに settled', async () => {
    const waiters = new RunnerBackgroundWaiters();
    await expect(waiters.wait(() => true, 1000)).resolves.toBe('settled');
    expect(waiters.waitingCount).toBe(0);
  });

  it('条件が偽の間は解けず、recheck で真になった時点で settled になる', async () => {
    const waiters = new RunnerBackgroundWaiters();
    let done = false;
    const result = vi.fn();
    void waiters.wait(() => done, 60_000).then(result);
    await vi.advanceTimersByTimeAsync(10_000);
    waiters.recheck();
    expect(result).not.toHaveBeenCalled();
    expect(waiters.waitingCount).toBe(1);
    done = true;
    waiters.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toHaveBeenCalledWith('settled');
    expect(waiters.waitingCount).toBe(0);
  });

  it('noteFinished は控えた id を isFinished / outputFileOf で返し、待っている者の条件を見直す', async () => {
    const waiters = new RunnerBackgroundWaiters();
    const result = vi.fn();
    void waiters.wait(() => waiters.isFinished('bg-1'), 60_000).then(result);
    expect(waiters.outputFileOf('bg-1')).toBeNull();
    waiters.noteFinished('bg-1', '/tmp/out.txt');
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toHaveBeenCalledWith('settled');
    expect(waiters.outputFileOf('bg-1')).toBe('/tmp/out.txt');
    waiters.noteFinished('bg-2', null);
    expect(waiters.isFinished('bg-2')).toBe(true);
    expect(waiters.outputFileOf('bg-2')).toBeNull();
  });

  it('時間の上限で timeout になる（偽の時計で上限ちょうどに達したとき）', async () => {
    const waiters = new RunnerBackgroundWaiters();
    const result = vi.fn();
    void waiters.wait(() => false, 30 * 60_000).then(result);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(result).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toHaveBeenCalledWith('timeout');
    expect(waiters.waitingCount).toBe(0);
  });

  it('releaseAll は待っている者を全員 released で解き、タイマーも残さない', async () => {
    const waiters = new RunnerBackgroundWaiters();
    const a = vi.fn();
    const b = vi.fn();
    void waiters.wait(() => false, 60_000).then(a);
    void waiters.wait(() => false, 60_000).then(b);
    waiters.releaseAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(a).toHaveBeenCalledWith('released');
    expect(b).toHaveBeenCalledWith('released');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('check が例外を投げた待ちは released で解く（フックを宙に浮かせず、他の待ちも巻き込まない）', async () => {
    const waiters = new RunnerBackgroundWaiters();
    const bad = vi.fn();
    const good = vi.fn();
    let boom = false;
    void waiters
      .wait(() => {
        if (boom) throw new Error('壊れた');
        return false;
      }, 60_000)
      .then(bad);
    let done = false;
    void waiters.wait(() => done, 60_000).then(good);
    boom = true;
    done = true;
    waiters.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(bad).toHaveBeenCalledWith('released');
    expect(good).toHaveBeenCalledWith('settled');
  });
});
