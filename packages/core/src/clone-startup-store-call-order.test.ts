import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 起動直後のストア呼び出しの順を固定する（await の段の歯）。
// `#pump` の冒頭は `void this.#restoreUnread()` → `void this.#sweepGraves()` の順で、どちらも最初の `await` までは同期で
// ストアを呼ぶ。だから `createClone` が返った時点で `claimPending`（未読の読み直し）→ `listTranscriptGraves`（墓標の拾い直し）の順に
// 呼び終わっている。墓標の拾い直しを `async` の関数で包み直す・未読の読み直しの前に `await` を足す、のどちらでも、この交互が
// マイクロタスク1つぶん動き、ここが赤くなる（`#restoreUnread` の「`claimPending()` の時機が遅れると二重配達になる」と同じ根）。

function recordingStores(order: string[]): Stores {
  const base = createMemoryStores();
  return {
    ...base,
    inbox: {
      ...base.inbox,
      put: (event, at) => base.inbox.put(event, at),
      remove: (id) => base.inbox.remove(id),
      claimPending: () => {
        order.push('claimPending');
        return base.inbox.claimPending();
      },
      pending: () => base.inbox.pending(),
      peekPending: () => base.inbox.peekPending(),
      removeMany: (ids) => base.inbox.removeMany(ids),
      clear: () => base.inbox.clear(),
    },
    sessions: {
      ...base.sessions,
      listTranscriptGraves: () => {
        order.push('listTranscriptGraves');
        return base.sessions.listTranscriptGraves();
      },
      listLostSessionGraves: () => {
        order.push('listLostSessionGraves');
        return base.sessions.listLostSessionGraves();
      },
    },
  } as Stores;
}

describe('起動直後のストア呼び出しの順（未読の読み直し → 墓標の拾い直し）', () => {
  it('createClone が返った時点で、claimPending → listTranscriptGraves の順に同期で呼び終わっている', async () => {
    const order: string[] = [];
    const stores = recordingStores(order);
    const clone = createClone({
      stores,
      queryFn: (() => {
        throw new Error('この試験はモデルを呼ばない');
      }) as unknown as typeof sdkQuery,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: (() => undefined) as never, env: {} }),
      ]),
    });
    // 待たずに読む: 1マイクロタスクでも後ろへずれたら、ここで見えなくなる
    expect(order).toEqual(['claimPending', 'listTranscriptGraves']);

    await clone.stop();
  });
});
