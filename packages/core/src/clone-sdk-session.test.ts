import { describe, expect, it, vi } from 'vitest';

import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { Turn } from './clone.js';
import { CloneSdkSession } from './clone-sdk-session.js';

/**
 * `clone-sdk-session.ts` の歯。**純粋なクラスなので I/O のモック無しで
 * 全分岐に通せる**（`runner-sdk-session.test.ts` / `clone-redelivery-state.test.ts`
 * と同じ作法。前例は #1611）。
 *
 * ここが固定するのは、切り出した13フィールドの**状態の器としての性質**
 * ——`open` の2行のまとめ、`finishTurn` の4フィールドをまたぐ一括処理、
 * token / 文脈窓の recycle の「消費する読み」、入力の待ち行列（高々1本の
 * 待ち手）である。`Clone` が「いつ開く／畳むか・ターンをどう回すか・畳みの
 * 順序」を決める判断は、既存のブラックボックステスト（`clone.test.ts` の
 * SDK セッションを名指しする `describe`/`it`）が引き続き持つ——ここでは
 * 扱わない。
 */

function fakeQuery(): Query {
  return { close: vi.fn() } as unknown as Query;
}

describe('CloneSdkSession — 初期状態', () => {
  it('生成直後は query / reader / pumpLoop が null', () => {
    const s = new CloneSdkSession();
    expect(s.query).toBeNull();
    expect(s.reader).toBeNull();
    expect(s.pumpLoop).toBeNull();
  });

  it('生成直後は stopped が false、turn が null', () => {
    const s = new CloneSdkSession();
    expect(s.stopped).toBe(false);
    expect(s.turn).toBeNull();
  });

  it('生成直後は recycle の意図がどちらも立っていない', () => {
    const s = new CloneSdkSession();
    expect(s.wantsTokenRecycle).toBe(false);
    expect(s.wantsContextWindowRecycle).toBe(false);
  });

  it('生成直後は resumedFrom が null、sawInit が false', () => {
    const s = new CloneSdkSession();
    expect(s.resumedFrom).toBeNull();
    expect(s.sawInit).toBe(false);
  });

  it('生成直後は sdkSessionId が null、sessionTokenIdentity が undefined', () => {
    const s = new CloneSdkSession();
    expect(s.sdkSessionId).toBeNull();
    expect(s.sessionTokenIdentity).toBeUndefined();
  });
});

describe('CloneSdkSession — open / clearQuery / closeQuery（`#ensureQuery` / `#read` / `stop()` が呼ぶ）', () => {
  it('open は query と reader をまとめて代入する', () => {
    const s = new CloneSdkSession();
    const q = fakeQuery();
    const reader = Promise.resolve();
    s.open(q, reader);
    expect(s.query).toBe(q);
    expect(s.reader).toBe(reader);
  });

  it('clearQuery は query だけを null に戻す（reader には触れない）', () => {
    const s = new CloneSdkSession();
    const q = fakeQuery();
    const reader = Promise.resolve();
    s.open(q, reader);
    s.clearQuery();
    expect(s.query).toBeNull();
    expect(s.reader).toBe(reader);
  });

  it('closeQuery は query.close() を呼び、query は null に戻さない', () => {
    const s = new CloneSdkSession();
    const q = fakeQuery();
    s.open(q, Promise.resolve());
    s.closeQuery();
    expect(q.close).toHaveBeenCalledTimes(1);
    expect(s.query).toBe(q);
  });

  it('closeQuery は query が無くても安全', () => {
    const s = new CloneSdkSession();
    expect(() => s.closeQuery()).not.toThrow();
  });

  it('closeQuery は close() が投げても飲み込む（「既に閉じている」）', () => {
    const s = new CloneSdkSession();
    const q = {
      close: () => {
        throw new Error('already closed');
      },
    } as unknown as Query;
    s.open(q, Promise.resolve());
    expect(() => s.closeQuery()).not.toThrow();
  });
});

describe('CloneSdkSession — beginPumpLoop（コンストラクタが1度だけ呼ぶ）', () => {
  it('控えた Promise がそのまま読み出せる', () => {
    const s = new CloneSdkSession();
    const p = Promise.resolve();
    s.beginPumpLoop(p);
    expect(s.pumpLoop).toBe(p);
  });
});

describe('CloneSdkSession — stopped', () => {
  it('markStopped で true になる（一方向）', () => {
    const s = new CloneSdkSession();
    s.markStopped();
    expect(s.stopped).toBe(true);
  });
});

describe('CloneSdkSession — turn（beginTurn / finishTurn）', () => {
  function fakeTurn(overrides: Partial<{ resolve: () => void }> = {}): Turn {
    return {
      conversationId: null,
      approvalId: null,
      text: '',
      streamed: false,
      rejected: null,
      failure: null,
      compactions: [],
      resolve: overrides.resolve ?? (() => undefined),
      kind: 'normal',
    };
  }

  it('beginTurn で turn を読める', () => {
    const s = new CloneSdkSession();
    const turn = fakeTurn();
    s.beginTurn(turn);
    expect(s.turn).toBe(turn);
  });

  it('finishTurn はターンを null に戻し、resolve() を呼ぶ', () => {
    const s = new CloneSdkSession();
    const resolve = vi.fn();
    s.beginTurn(fakeTurn({ resolve }));
    s.finishTurn();
    expect(s.turn).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('turn が無くても finishTurn は安全（resolve を呼ばない）', () => {
    const s = new CloneSdkSession();
    expect(() => s.finishTurn()).not.toThrow();
  });

  it('recycle の印が何も立っていなければ、finishTurn は入力待ちを起こさない', async () => {
    const s = new CloneSdkSession();
    let resolved = false;
    const waiting = s.waitForInput().then(() => {
      resolved = true;
    });
    s.beginTurn(fakeTurn());
    s.finishTurn();
    await Promise.resolve();
    expect(resolved).toBe(false);
    // 後始末: 待ちを残さない。
    s.wakeInput();
    await waiting;
  });

  it('wantsTokenRecycle が立っていれば、finishTurn は入力待ちを起こす', async () => {
    const s = new CloneSdkSession();
    s.requestTokenRecycle();
    const waiting = s.waitForInput();
    let resolved = false;
    void waiting.then(() => {
      resolved = true;
    });
    s.beginTurn(fakeTurn());
    s.finishTurn();
    await waiting;
    expect(resolved).toBe(true);
    // 消費はしない（`finishTurn` は読むだけ）。
    expect(s.wantsTokenRecycle).toBe(true);
  });

  it('wantsContextWindowRecycle が立っていれば、finishTurn は入力待ちを起こす', async () => {
    const s = new CloneSdkSession();
    s.armContextWindowRecycle();
    const waiting = s.waitForInput();
    let resolved = false;
    void waiting.then(() => {
      resolved = true;
    });
    s.beginTurn(fakeTurn());
    s.finishTurn();
    await waiting;
    expect(resolved).toBe(true);
  });
});

describe('CloneSdkSession — 入力の待ち行列（enqueueInput / dequeueInput / waitForInput / wakeInput）', () => {
  it('enqueueInput → dequeueInput は FIFO', () => {
    const s = new CloneSdkSession();
    const a: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: 'a' },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    const b: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: 'b' },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    s.enqueueInput(a);
    s.enqueueInput(b);
    expect(s.dequeueInput()).toBe(a);
    expect(s.dequeueInput()).toBe(b);
    expect(s.dequeueInput()).toBeUndefined();
  });

  it('waitForInput は wakeInput が呼ばれるまで解決しない', async () => {
    const s = new CloneSdkSession();
    let resolved = false;
    const p = s.waitForInput().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    s.wakeInput();
    await p;
    expect(resolved).toBe(true);
  });

  it('wakeInput は待ち手が居なければ何もしない（例外を投げない）', () => {
    const s = new CloneSdkSession();
    expect(() => s.wakeInput()).not.toThrow();
  });

  it('待ち手は高々1本——2度目の waitForInput は1本目の待ち手を上書きする', async () => {
    const s = new CloneSdkSession();
    let firstResolved = false;
    let secondResolved = false;
    const first = s.waitForInput().then(() => {
      firstResolved = true;
    });
    const second = s.waitForInput().then(() => {
      secondResolved = true;
    });
    s.wakeInput();
    await second;
    expect(secondResolved).toBe(true);
    expect(firstResolved).toBe(false);
    void first;
  });
});

describe('CloneSdkSession — 認証トークンの recycle（requestTokenRecycle / wantsTokenRecycle / takeTokenRecycle）', () => {
  it('requestTokenRecycle で true になる', () => {
    const s = new CloneSdkSession();
    s.requestTokenRecycle();
    expect(s.wantsTokenRecycle).toBe(true);
  });

  it('takeTokenRecycle は読んで、無条件に false へ戻す', () => {
    const s = new CloneSdkSession();
    s.requestTokenRecycle();
    expect(s.takeTokenRecycle()).toBe(true);
    expect(s.wantsTokenRecycle).toBe(false);
    expect(s.takeTokenRecycle()).toBe(false);
  });
});

describe('CloneSdkSession — 文脈窓の recycle（armContextWindowRecycle / wantsContextWindowRecycle / takeContextWindowRecycle）', () => {
  it('armContextWindowRecycle で true になる', () => {
    const s = new CloneSdkSession();
    s.armContextWindowRecycle();
    expect(s.wantsContextWindowRecycle).toBe(true);
  });

  it('takeContextWindowRecycle は読んで、無条件に false へ戻す', () => {
    const s = new CloneSdkSession();
    s.armContextWindowRecycle();
    expect(s.takeContextWindowRecycle()).toBe(true);
    expect(s.wantsContextWindowRecycle).toBe(false);
    expect(s.takeContextWindowRecycle()).toBe(false);
  });

  it('token の recycle とは独立している', () => {
    const s = new CloneSdkSession();
    s.requestTokenRecycle();
    expect(s.wantsContextWindowRecycle).toBe(false);
    s.armContextWindowRecycle();
    expect(s.wantsTokenRecycle).toBe(true);
    expect(s.wantsContextWindowRecycle).toBe(true);
  });
});

describe('CloneSdkSession — resume の試みと init の観測（beginSession / markSawInit）', () => {
  it('beginSession は resumedFrom を立て、sawInit を false へ戻す', () => {
    const s = new CloneSdkSession();
    s.markSawInit();
    s.beginSession('session-1');
    expect(s.resumedFrom).toBe('session-1');
    expect(s.sawInit).toBe(false);
  });

  it('beginSession(null) は resumedFrom を null のままにする', () => {
    const s = new CloneSdkSession();
    s.beginSession(null);
    expect(s.resumedFrom).toBeNull();
  });

  it('markSawInit で true になる', () => {
    const s = new CloneSdkSession();
    s.markSawInit();
    expect(s.sawInit).toBe(true);
  });
});

describe('CloneSdkSession — init が報告した SDK セッション id（setSdkSessionId）', () => {
  it('文字列を渡すと読める', () => {
    const s = new CloneSdkSession();
    s.setSdkSessionId('sess-1');
    expect(s.sdkSessionId).toBe('sess-1');
  });

  it('null を渡すと null に戻る（#forgetObservedFacts が呼ぶ形）', () => {
    const s = new CloneSdkSession();
    s.setSdkSessionId('sess-1');
    s.setSdkSessionId(null);
    expect(s.sdkSessionId).toBeNull();
  });
});

describe('CloneSdkSession — このセッションが起きたときのトークンの身元（captureSessionTokenIdentity）', () => {
  it('捕まえた身元がそのまま読める', () => {
    const s = new CloneSdkSession();
    s.captureSessionTokenIdentity({ tokenId: 'tok-1', generation: 3 });
    expect(s.sessionTokenIdentity).toEqual({ tokenId: 'tok-1', generation: 3 });
  });

  it('undefined を渡すと undefined に戻る', () => {
    const s = new CloneSdkSession();
    s.captureSessionTokenIdentity({ tokenId: 'tok-1', generation: 3 });
    s.captureSessionTokenIdentity(undefined);
    expect(s.sessionTokenIdentity).toBeUndefined();
  });
});
