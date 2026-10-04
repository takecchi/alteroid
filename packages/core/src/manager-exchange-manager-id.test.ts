/**
 * **クローンがマネージャーへ渡した指示（委譲・追送）の `exchange` は、相手の
 * `managerId` を構造として持つ。** 稼働の地図（`GET /topology`）が「どの線に
 * 指示が流れたか」を数える鍵で、`text` の先頭の `[managerId]` を読ませない
 * （表示の文言は変わるが、構造は変わらない）。`text` は従来のまま。
 */
import type { query as sdkQuery, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/** 受け答えだけする最小の偽 SDK（委譲の中身は見ない。`close()` で終わる）。 */
function idleSdk(): typeof sdkQuery {
  return ((params: { prompt: unknown }) => {
    let finish: (() => void) | null = null;
    void (async () => {
      for await (const input of params.prompt as AsyncIterable<unknown>) void input;
    })();
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('exchange.managerId（委譲・追送の outbound）', () => {
  it('start と send のどちらの outbound にも managerId が載り、text は従来の形のまま', async () => {
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([
      createLocalRunner({
        runnerId: 'runner-topology',
        workspacePath: '/work/project',
        queryFn: idleSdk(),
        env: { PATH: '/usr/bin' },
      }),
    ]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const started = await pool.start({ request: '調べて' });
    const sent = await pool.send(started.managerId, '続けて');
    expect(sent.outcome).not.toBe('unknown');
    await pool.stop();

    const rows = await stores.journal.list({ types: ['exchange'], order: 'asc' });
    const outbound = rows.filter(
      (row) => row.type === 'exchange' && row.with === 'manager' && row.role === 'outbound',
    );
    const texts = outbound.map((row) => (row.type === 'exchange' ? row.text : ''));
    expect(texts.some((text) => text.includes(`[${started.managerId}] 調べて`))).toBe(true);
    expect(texts.some((text) => text.includes(`[${started.managerId}] 続けて`))).toBe(true);
    for (const row of outbound) {
      if (row.type !== 'exchange') throw new Error('exchange 以外');
      if (!row.text.includes(`[${started.managerId}]`)) continue;
      expect(row.managerId).toBe(started.managerId);
    }
  });
});
