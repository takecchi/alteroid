import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { fenceSessions } from './index.js';
import { SessionLease } from './lease.js';

/**
 * 畳めなかったことを、畳めたことと同じに扱わないこと。
 *
 * デーモンは runner の申告（と申告した期限）だけを根拠に、別の器で同じ session を
 * 開き直してよいと判断する。**畳めていないのに畳めたと言えば、そのまま二重実行に
 * なる** — 分断されている以上、後から訂正を届ける経路も無い。
 */

function fakeQuery(onClose?: () => void): typeof sdkQuery {
  return (() => {
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => {
        onClose?.();
        finish?.();
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

/**
 * 停止が**例外で終わる**器。
 *
 * `RunnerSession.stop()` が reject する経路は実在する（生ログの送出は try/catch の
 * 外にあり、`transcript()` の読み出しも `emit` も失敗しうる）が、実物の器で狙って
 * 起こすには生ログの実体が要る。ここで確かめたいのは**申告する側のふるまい**
 * なので、器の停止だけを差し替える。`fenceSessions` は本番のものそのままである。
 *
 * なお `stop()` が**返らない**場合（SDK の畳みが固まる）は、猶予切れとして
 * 既に固定してある（`lease.test.ts` の「猶予の内に畳み終えられなければ…」）。
 */
function hostWithFailingStop(): Pick<RunnerHost, 'list' | 'stop'> {
  const alive = new Set(['mgr-1']);
  return {
    list: () => [...alive].map((managerId) => ({ managerId })) as ReturnType<RunnerHost['list']>,
    stop: async () => {
      throw new Error('生ログを渡せなかった');
    },
  };
}

describe('セッションを畳む申告', () => {
  it('畳めたら、その id を返す（実物の器で）', async () => {
    const host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/tmp',
      emit: () => undefined,
      queryFn: fakeQuery(),
      env: {},
    });
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: '/tmp' });

    await expect(fenceSessions(host)).resolves.toEqual(['mgr-1']);
    expect(host.list()).toEqual([]);
  });

  it('停止が例外で終わったら、畳めたことにしない', async () => {
    const host = hostWithFailingStop();

    // **握り潰さない。** ここが resolve すると、残っている仕事を「止まった」と申告する
    await expect(fenceSessions(host)).rejects.toThrow();
    // 実際、そのセッションはまだ器に残っている
    expect(host.list().map((state) => state.managerId)).toEqual(['mgr-1']);
  });

  it('例外が出なくても、残っていれば畳めたことにしない', async () => {
    // 「呼んだ」ことを申告の根拠にすると、ここが素通りする
    const stubborn = {
      list: () => [{ managerId: 'mgr-1' }] as ReturnType<RunnerHost['list']>,
      stop: async () => true,
    };

    await expect(fenceSessions(stubborn)).rejects.toThrow('畳み切れていない');
  });

  it('畳めない器は、畳めたと報告せずに降りる側へ落ちる（fail-closed）', async () => {
    const host = hostWithFailingStop();

    let now = 0;
    let exceeded = 0;
    const fenced: string[][] = [];
    const lease = new SessionLease({
      ttlMs: 1_000,
      graceMs: 5_000,
      now: () => now,
      fence: () => fenceSessions(host),
      onFenced: (ids) => fenced.push(ids),
      onGraceExceeded: () => {
        exceeded += 1;
      },
    });

    now = 2_000;
    await expect(lease.check()).rejects.toThrow();

    // 畳めたとは報告しない（デーモンはこの報告を停止の裏付けに使う）
    expect(fenced).toEqual([]);
    // 猶予の**内**に失敗しても、器ごと降りる側へ落ちる。ここで生き続けるのが
    // いちばん危ない — デーモン側の期限だけが進み、裏付け無しに移送される
    expect(exceeded).toBe(1);
  });
});
