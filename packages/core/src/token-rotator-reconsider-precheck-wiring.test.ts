import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createTokenRotator } from './token-rotator.js';
import type { AgentToken } from './token-pool.js';

// `token-rotator-reconsider-precheck-pin.test.ts` が縛れていなかった、呼び元（`reconsiderLocked`）が切り出した関数の結果を使う側の 2 点を、外から見える結果で縛る。
// 期待の値は、切り出し前（origin/main）の作りで同じ場面を流して確かめたもの（仕様を先に書いたものではない）。
//   - 回す判定へ進むときに、読めた設定（cooldownMs）を `sweepCandidates` へそのまま渡すこと（指名なしの回・現役が通らない回の両方）
//   - reopened の枝で、覚え（announcedReopen）を先に書いてから ISO の日時を作ること（日時にならない値で投げても、同じ期限は 2 回目に出さない）

const NOW = Date.parse('2026-08-25T03:00:00.000Z');
const HOUR = 3_600_000;
const COOLDOWN_MS = 7_000;

function row(id: string, order: number, extra: Partial<AgentToken> = {}): AgentToken {
  return { id, label: id, value: `value-${id}`, order, ...extra };
}

async function rigOf(rows: AgentToken[], active: { tokenId: string; generation: number } | null) {
  const stores = createMemoryStores();
  await stores.tokens.replace(rows);
  await stores.tokens.writeSettings({ rotateOn: 'free_exhausted', cooldownMs: COOLDOWN_MS });
  if (active !== null) {
    await stores.tokens.writeActive({ ...active, rotatedAt: new Date(NOW).toISOString() });
  }
  const rotator = createTokenRotator({
    stores,
    // 期限（retryAt）を言わない unusable: 冷却の長さは設定の cooldownMs だけで決まる
    probe: { probe: () => Promise.resolve({ verdict: 'unusable', reason: '枠切れ' }) },
    spread: { spread: () => Promise.resolve([{ target: 'runner-primary', ok: true }]) },
    now: () => new Date(NOW),
  });
  return { stores, rotator };
}

describe('回す判定へ進むときの設定の素通し', () => {
  it('指名なし: sweepCandidates の冷却の既定は読めた設定の cooldownMs', async () => {
    const { stores, rotator } = await rigOf([row('a', 0), row('b', 1)], null);
    await rotator.reconsider({ reason: 'startup' });
    const rows = await stores.tokens.list();
    expect(rows.map((one) => one.cooldownUntil)).toStrictEqual([
      NOW + COOLDOWN_MS,
      NOW + COOLDOWN_MS,
    ]);
  });

  it('現役が通らない: sweepCandidates の冷却の既定は読めた設定の cooldownMs', async () => {
    const { stores, rotator } = await rigOf(
      [row('a', 0, { cooldownUntil: NOW + HOUR }), row('b', 1)],
      { tokenId: 'a', generation: 1 },
    );
    await rotator.reconsider({ reason: 'tick' });
    const rows = await stores.tokens.list();
    expect(rows.find((one) => one.id === 'b')?.cooldownUntil).toBe(NOW + COOLDOWN_MS);
  });
});

describe('reopened の覚えは日時を作る前に書く', () => {
  it('日時にならない期限は RangeError で投げるが、同じ期限は次の回に出し直さない', async () => {
    // Date にならない（-8.64e15 より小さい）が、`cooldownUntil > at` ではないので ready として入る
    const invalid = -8.64e15 - 1;
    const { rotator } = await rigOf([row('a', 0, { cooldownUntil: invalid }), row('b', 1)], {
      tokenId: 'a',
      generation: 1,
    });
    await expect(rotator.reconsider({ reason: 'tick' })).rejects.toThrow(RangeError);
    const second = await rotator.reconsider({ reason: 'tick' });
    expect(second.kind).toBe('ignored');
    expect('reopened' in second).toBe(false);
  });
});
