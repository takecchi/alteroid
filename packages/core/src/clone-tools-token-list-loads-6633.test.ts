import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';
import type { AccountUsageState } from './usage-snapshot.js';

const AT = '2026-11-09T12:00:00.000Z';

type Loads = readonly { tokenId: string; state: AccountUsageState }[];

async function callTokenList(loads: (() => Loads) | undefined): Promise<string> {
  const stores = createMemoryStores();
  await stores.tokens.replace([
    { id: 'tok-a', label: 'measured', order: 0, value: 'fake-token-value-a' },
    { id: 'tok-b', label: 'unmeasured', order: 1, value: 'fake-token-value-b' },
    { id: 'tok-c', label: 'failed', order: 2, value: 'fake-token-value-c' },
  ]);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => 'conv-1',
    ...(loads === undefined ? {} : { tokenLoads: loads }),
  });
  const found = tools.find((entry) => entry.name === 'token_list');
  if (!found) throw new Error('token_list が無い');
  const result = await found.handler({} as never, {});
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

// 行ごとの塊を id で切り出す: 隣の行の「枠」を自分の行のものと読まないため
function entryOf(output: string, id: string): string {
  const start = output.indexOf(id);
  if (start < 0) throw new Error(`${id} が出力に無い`);
  const next = ['tok-a', 'tok-b', 'tok-c']
    .map((other) => (other === id ? -1 : output.indexOf(other, start + id.length)))
    .filter((index) => index > start);
  return output.slice(start, next.length === 0 ? undefined : Math.min(...next));
}

describe('token_list: 鍵ごとの枠を出す（#6633）', () => {
  it('測れた鍵は窓ごとの使用率を時刻つきで出し、測っていない鍵は 0% と書かず「まだ測っていない」と言う', async () => {
    const output = await callTokenList(() => [
      {
        tokenId: 'tok-a',
        state: {
          state: 'ok',
          usage: {
            at: AT,
            limitsAvailable: true,
            windows: [
              { kind: 'five_hour', utilization: 42.4 },
              { kind: 'seven_day', utilization: 61 },
            ],
          },
        } as AccountUsageState,
      },
      { tokenId: 'tok-c', state: { state: 'failed', at: AT, reason: 'probe が時間切れ' } },
    ]);

    expect(entryOf(output, 'tok-a')).toContain(`枠: 5時間 42% / 週 61%（${AT} 時点）`);
    expect(entryOf(output, 'tok-b')).toContain('枠: まだ測っていない');
    // 窓の使用率の形（「5時間 0%」など）が無いこと。断りの「0% ではない」は数えない
    expect(entryOf(output, 'tok-b')).not.toMatch(/(5時間|週) \d+%/);
    expect(entryOf(output, 'tok-c')).toContain(`枠: 測れなかった — probe が時間切れ（${AT}）`);
    expect(output).not.toContain('fake-token-value');
  });

  it('口が無い器では、枠の行そのものを出さない（「まだ測っていない」とも言わない）', async () => {
    const output = await callTokenList(undefined);

    expect(output).toContain('tok-a');
    expect(output).not.toContain('枠:');
  });
});
