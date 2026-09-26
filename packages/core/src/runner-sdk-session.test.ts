import { describe, expect, it, vi } from 'vitest';

import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { RunnerFenceError } from './runner-protocol.js';
import { RunnerSdkSession } from './runner-sdk-session.js';

/**
 * `runner-sdk-session.ts` の歯。**純粋なクラスなので I/O のモック無しで
 * 全分岐に通せる**（`runner-resume-state.test.ts` / `runner-worker-wait-window.test.ts`
 * と同じ作法。前例は PR #1565 / #1581 ほか）。
 *
 * ここが固定するのは、切り出した15フィールドの**状態の器としての性質**
 * ——`open` / `teardownForRecreate` の順序、`checkFence` の判定、token
 * rotation の小さな状態遷移、入力の待ち行列、`trackClosing` の「自分が
 * 控えた Promise だけ消す」性質である。`RunnerSession` が「いつ開く／畳むか・
 * どの順で畳むか・`#emit` するかどうか」を決める判断は、既存のブラック
 * ボックステスト（`runner-stop.test.ts` / `runner-stop-finish-order.test.ts` /
 * `runner-fence.test.ts` / `runner-closed-system-error.test.ts` 等）が引き続き
 * 持つ——ここでは扱わない。
 */

function fakeQuery(): Query {
  return { close: vi.fn() } as unknown as Query;
}

describe('RunnerSdkSession — 初期状態', () => {
  it('生成直後は query / reader が null、generation が0', () => {
    const s = new RunnerSdkSession();
    expect(s.query).toBeNull();
    expect(s.reader).toBeNull();
    expect(s.generation).toBe(0);
  });

  it('生成直後は stopped が false、status が running', () => {
    const s = new RunnerSdkSession();
    expect(s.stopped).toBe(false);
    expect(s.status).toBe('running');
  });

  it('生成直後は transcriptPath が undefined、liveBackgroundTasks が空配列', () => {
    const s = new RunnerSdkSession();
    expect(s.transcriptPath).toBeUndefined();
    expect(s.liveBackgroundTasks).toEqual([]);
  });

  it('生成直後は unclassifiedFailures が空の Map、leaseTtlMs が undefined', () => {
    const s = new RunnerSdkSession();
    expect(s.unclassifiedFailures.size).toBe(0);
    expect(s.leaseTtlMs).toBeUndefined();
  });

  it('生成直後は wantsTokenRecycle が false、closing が null', () => {
    const s = new RunnerSdkSession();
    expect(s.wantsTokenRecycle).toBe(false);
    expect(s.closing).toBeNull();
  });
});

describe('RunnerSdkSession — open / closeQuery / teardownForRecreate（`#open` / `#reopenForTokenRotation` が呼ぶ）', () => {
  it('open は query と reader をまとめて代入する', () => {
    const s = new RunnerSdkSession();
    const q = fakeQuery();
    const reader = Promise.resolve();
    s.open(q, reader);
    expect(s.query).toBe(q);
    expect(s.reader).toBe(reader);
  });

  it('closeQuery は query.close() を呼ぶ（query が無ければ何もしない）', () => {
    const s = new RunnerSdkSession();
    // query が無い状態で呼んでも例外は投げない。
    expect(() => s.closeQuery()).not.toThrow();

    const q = fakeQuery();
    s.open(q, Promise.resolve());
    s.closeQuery();
    expect(q.close).toHaveBeenCalledTimes(1);
  });

  it('closeQuery は close() が投げても飲み込む（「既に閉じている」）', () => {
    const s = new RunnerSdkSession();
    const q = {
      close: () => {
        throw new Error('already closed');
      },
    } as unknown as Query;
    s.open(q, Promise.resolve());
    expect(() => s.closeQuery()).not.toThrow();
  });

  it('teardownForRecreate は generation を進め、close してから query / reader を null に戻す', () => {
    const s = new RunnerSdkSession();
    const q = fakeQuery();
    s.open(q, Promise.resolve());
    expect(s.generation).toBe(0);
    s.teardownForRecreate();
    expect(s.generation).toBe(1);
    expect(q.close).toHaveBeenCalledTimes(1);
    expect(s.query).toBeNull();
    expect(s.reader).toBeNull();
  });

  it('teardownForRecreate は query が無くても安全（close を試みない）', () => {
    const s = new RunnerSdkSession();
    s.teardownForRecreate();
    expect(s.generation).toBe(1);
    expect(s.query).toBeNull();
  });
});

describe('RunnerSdkSession — stopped / status', () => {
  it('markStopped で stopped が true になる（一方向）', () => {
    const s = new RunnerSdkSession();
    s.markStopped();
    expect(s.stopped).toBe(true);
  });

  it('setStatus で status を書き換えられる', () => {
    const s = new RunnerSdkSession();
    s.setStatus('waiting_human');
    expect(s.status).toBe('waiting_human');
    s.setStatus('done');
    expect(s.status).toBe('done');
  });
});

describe('RunnerSdkSession — transcriptPath', () => {
  it('setTranscriptPath で値を持ち、上書きできる', () => {
    const s = new RunnerSdkSession();
    s.setTranscriptPath('/tmp/a.jsonl');
    expect(s.transcriptPath).toBe('/tmp/a.jsonl');
    s.setTranscriptPath('/tmp/b.jsonl');
    expect(s.transcriptPath).toBe('/tmp/b.jsonl');
  });
});

describe('RunnerSdkSession — liveBackgroundTasks（REPLACE 意味論）', () => {
  it('replaceLiveBackgroundTasks は丸ごと入れ替える（加算ではない）', () => {
    const s = new RunnerSdkSession();
    s.replaceLiveBackgroundTasks([{ id: 'bg-1', taskType: 'shell' }]);
    expect(s.liveBackgroundTasks).toEqual([{ id: 'bg-1', taskType: 'shell' }]);
    s.replaceLiveBackgroundTasks([{ id: 'bg-2', taskType: 'shell' }]);
    expect(s.liveBackgroundTasks).toEqual([{ id: 'bg-2', taskType: 'shell' }]);
  });

  it('resetLiveBackgroundTasks は空配列へ戻す', () => {
    const s = new RunnerSdkSession();
    s.replaceLiveBackgroundTasks([{ id: 'bg-1', taskType: 'shell' }]);
    s.resetLiveBackgroundTasks();
    expect(s.liveBackgroundTasks).toEqual([]);
  });
});

describe('RunnerSdkSession — unclassifiedFailures（生の Map を渡すだけの器）', () => {
  it('返した Map は同一の参照であり、外から直接書き込める（noteUnclassifiedFailure と同じ使い方）', () => {
    const s = new RunnerSdkSession();
    const map = s.unclassifiedFailures;
    map.set('result_is_error:success', 1);
    expect(s.unclassifiedFailures.get('result_is_error:success')).toBe(1);
    expect(s.unclassifiedFailures).toBe(map);
  });
});

describe('RunnerSdkSession — checkFence（fencing token の検査と記録。roadmap M5 PR4）', () => {
  it('lease が undefined なら何もしない', () => {
    const s = new RunnerSdkSession();
    expect(() => s.checkFence(undefined, 'mgr-1')).not.toThrow();
    expect(s.leaseTtlMs).toBeUndefined();
  });

  it('まだ世代を覚えていなければ、拒まずに覚えるだけ', () => {
    const s = new RunnerSdkSession();
    s.checkFence({ fence: 5, ttlMs: 60_000 }, 'mgr-1');
    expect(s.leaseTtlMs).toBe(60_000);
  });

  it('同じ世代は再送として受ける（更新も拒否もしない）', () => {
    const s = new RunnerSdkSession();
    s.checkFence({ fence: 5, ttlMs: 60_000 }, 'mgr-1');
    expect(() => s.checkFence({ fence: 5, ttlMs: 70_000 }, 'mgr-1')).not.toThrow();
    expect(s.leaseTtlMs).toBe(70_000);
  });

  it('新しい世代は覚え直す', () => {
    const s = new RunnerSdkSession();
    s.checkFence({ fence: 5, ttlMs: 60_000 }, 'mgr-1');
    s.checkFence({ fence: 6, ttlMs: 90_000 }, 'mgr-1');
    expect(s.leaseTtlMs).toBe(90_000);
  });

  it('古い世代は RunnerFenceError を投げ、何も書き換えない', () => {
    const s = new RunnerSdkSession();
    s.checkFence({ fence: 5, ttlMs: 60_000 }, 'mgr-1');
    expect(() => s.checkFence({ fence: 4, ttlMs: 1 }, 'mgr-1')).toThrow(RunnerFenceError);
    // 書き換わっていない。
    expect(s.leaseTtlMs).toBe(60_000);
  });

  it('RunnerFenceError は managerId / expected / given を運ぶ', () => {
    const s = new RunnerSdkSession();
    s.checkFence({ fence: 5, ttlMs: 60_000 }, 'mgr-1');
    try {
      s.checkFence({ fence: 3, ttlMs: 1 }, 'mgr-1');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerFenceError);
      const fenceError = error as RunnerFenceError;
      expect(fenceError.managerId).toBe('mgr-1');
      expect(fenceError.expected).toBe(5);
      expect(fenceError.given).toBe(3);
    }
  });
});

describe('RunnerSdkSession — 認証トークンの畳み直し（recycleForToken / endedInputForTokenRotation）', () => {
  it('requestTokenRecycle で wantsTokenRecycle が true になる', () => {
    const s = new RunnerSdkSession();
    s.requestTokenRecycle();
    expect(s.wantsTokenRecycle).toBe(true);
  });

  it('consumeTokenRecycleAtBoundary は wantsTokenRecycle を下ろし、takeEndedForTokenRotation で真になる印を立てる', () => {
    const s = new RunnerSdkSession();
    s.requestTokenRecycle();
    s.consumeTokenRecycleAtBoundary();
    expect(s.wantsTokenRecycle).toBe(false);
    expect(s.takeEndedForTokenRotation()).toBe(true);
  });

  it('takeEndedForTokenRotation は読み出すと同時に false へ戻す（2回目は false）', () => {
    const s = new RunnerSdkSession();
    s.requestTokenRecycle();
    s.consumeTokenRecycleAtBoundary();
    expect(s.takeEndedForTokenRotation()).toBe(true);
    expect(s.takeEndedForTokenRotation()).toBe(false);
  });

  it('立てていなければ takeEndedForTokenRotation は false', () => {
    const s = new RunnerSdkSession();
    expect(s.takeEndedForTokenRotation()).toBe(false);
  });
});

describe('RunnerSdkSession — 入力の待ち行列（enqueueInput / dequeueInput / drainInput / waitForInput / wakeInput）', () => {
  it('enqueueInput → dequeueInput は FIFO', () => {
    const s = new RunnerSdkSession();
    const a = {
      type: 'user',
      message: { role: 'user', content: 'a' },
      parent_tool_use_id: null,
    } as never;
    const b = {
      type: 'user',
      message: { role: 'user', content: 'b' },
      parent_tool_use_id: null,
    } as never;
    s.enqueueInput(a);
    s.enqueueInput(b);
    expect(s.dequeueInput()).toBe(a);
    expect(s.dequeueInput()).toBe(b);
    expect(s.dequeueInput()).toBeUndefined();
  });

  it('drainInput は積んだ順のまま全件返し、待ち行列を空にする', () => {
    const s = new RunnerSdkSession();
    const a = {
      type: 'user',
      message: { role: 'user', content: 'a' },
      parent_tool_use_id: null,
    } as never;
    const b = {
      type: 'user',
      message: { role: 'user', content: 'b' },
      parent_tool_use_id: null,
    } as never;
    s.enqueueInput(a);
    s.enqueueInput(b);
    expect(s.drainInput()).toEqual([a, b]);
    expect(s.dequeueInput()).toBeUndefined();
  });

  it('waitForInput は wakeInput が呼ばれるまで解決しない', async () => {
    const s = new RunnerSdkSession();
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

  it('wakeInput は待っている全員を起こし、待ち行列を空にする（2回目は誰も起きない）', async () => {
    const s = new RunnerSdkSession();
    let count = 0;
    const p1 = s.waitForInput().then(() => {
      count += 1;
    });
    const p2 = s.waitForInput().then(() => {
      count += 1;
    });
    s.wakeInput();
    await Promise.all([p1, p2]);
    expect(count).toBe(2);
    // 2回目の wakeInput は誰も待っていないので何も起きない（例外も投げない）。
    expect(() => s.wakeInput()).not.toThrow();
  });
});

describe('RunnerSdkSession — trackClosing（`stop()` / `#finish()` の畳み中 Promise の追跡）', () => {
  it('run() の Promise を closing として控え、終わったら消す', async () => {
    const s = new RunnerSdkSession();
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracked = s.trackClosing(() => running);
    // まだ終わっていない間は、控えた Promise が読める。
    expect(s.closing).not.toBeNull();
    release();
    await tracked;
    expect(s.closing).toBeNull();
  });

  it('run() が例外を投げても、closing は消え、例外はそのまま伝播する', async () => {
    const s = new RunnerSdkSession();
    await expect(
      s.trackClosing(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(s.closing).toBeNull();
  });

  it('2本が重なって走ったとき、先に終わった側の finally は後から始まった側の closing を奪って消さない', async () => {
    const s = new RunnerSdkSession();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondDone = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    // 1本目が走り始め、#closing を控える。
    const firstTracked = s.trackClosing(() => firstDone);
    const firstClosing = s.closing;
    expect(firstClosing).not.toBeNull();

    // 1本目がまだ終わらないうちに2本目が走り始め、#closing を上書きする
    // （`#finishBody` の同時多重起動と同じ形——`trackClosing` 自体は
    // これを防がない。防いでいるのは呼び出し元の門である）。
    const secondTracked = s.trackClosing(() => secondDone);
    const secondClosing = s.closing;
    expect(secondClosing).not.toBe(firstClosing);

    // 1本目を先に終わらせる。1本目の finally は「自分が控えた Promise
    // （firstClosing）と、いまの #closing（secondClosing）が違う」ので、
    // 2本目がまだ握っている #closing を消さない。
    releaseFirst();
    await firstTracked;
    expect(s.closing).toBe(secondClosing);

    // 2本目を終わらせると、ようやく #closing が消える。
    releaseSecond();
    await secondTracked;
    expect(s.closing).toBeNull();
  });
});
