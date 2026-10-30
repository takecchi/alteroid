// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useAction } from './use-action';

afterEach(cleanup);

function mount() {
  const seen: { current: ReturnType<typeof useAction> | undefined } = { current: undefined };
  function Probe() {
    seen.current = useAction();
    return null;
  }
  render(<Probe />);
  return () => {
    if (seen.current === undefined) throw new Error('マウントされていない');
    return seen.current;
  };
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useAction', () => {
  it('実行中だけ busy が立ち、成功すれば failure は空のまま下りる', async () => {
    const action = mount();
    const pending = deferred();
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = action().run(() => pending.promise);
    });
    expect(action().busy).toBe(true);
    expect(action().failure).toBeUndefined();

    await act(async () => {
      pending.resolve();
      await done;
    });
    expect(action().busy).toBe(false);
    expect(action().failure).toBeUndefined();
  });

  it('投げられた値をそのまま failure に入れ、busy を下ろし、呼び元へは投げ直さない', async () => {
    const action = mount();
    const boom = new Error('断られた');
    await act(async () => {
      await action().run(() => Promise.reject(boom));
    });
    expect(action().failure).toBe(boom);
    expect(action().busy).toBe(false);
  });

  it('次の実行の始めに前の failure を消す（失敗の注記は送り直した瞬間に消える）', async () => {
    const action = mount();
    await act(async () => {
      await action().run(() => Promise.reject(new Error('1回目')));
    });
    expect(action().failure).toBeInstanceOf(Error);

    const pending = deferred();
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = action().run(() => pending.promise);
    });
    expect(action().failure).toBeUndefined();
    expect(action().busy).toBe(true);

    await act(async () => {
      pending.resolve();
      await done;
    });
  });

  it('action の中で投げられた値だけでなく、同期に投げた値も failure になる', async () => {
    const action = mount();
    const sync = new Error('同期');
    await act(async () => {
      await action().run(() => {
        throw sync;
      });
    });
    expect(action().failure).toBe(sync);
    expect(action().busy).toBe(false);
  });

  it('setFailure で呼び元が failure を直接消せる（開き直しなど）', async () => {
    const action = mount();
    await act(async () => {
      await action().run(() => Promise.reject(new Error('x')));
    });
    act(() => action().setFailure(undefined));
    expect(action().failure).toBeUndefined();
  });

  it('門を持たない: busy 中でも run は呼ばれた回数だけ action を走らせる', async () => {
    const action = mount();
    const first = deferred();
    let calls = 0;
    let firstDone: Promise<void> = Promise.resolve();
    let secondDone: Promise<void> = Promise.resolve();
    act(() => {
      firstDone = action().run(() => {
        calls += 1;
        return first.promise;
      });
    });
    act(() => {
      secondDone = action().run(() => {
        calls += 1;
        return Promise.resolve();
      });
    });
    expect(calls).toBe(2);
    await act(async () => {
      first.resolve();
      await Promise.all([firstDone, secondDone]);
    });
  });
});
