import { countCodePoints } from '@alteroid/core';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

// `readTail` を、1文で最大 2000 行を引いていた形から keyset の束読みへ替えた（束は 16 行から倍に増やす）。
// 返す値が変わらないこと、束の境目で壊れないこと、満ちたらそれ以上の行を引かないことを測る。
const TAIL_SCAN_ROWS = 2_000;
const KEY = { projectKey: 'proj-tail', sessionId: 'sess-tail' };

let db: Db;
let stores: PgStores;
// 1回の `select ... limit` ごとに、返ってきた行数を積む。
let pulled: number[] = [];
// n 回目の問い合わせを投げる直前に走らせる（束と束の間への割り込み）。
let beforeQuery: ((n: number) => Promise<void>) | undefined;

function wrapBuilder(builder: object): object {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const next: object = (value as (...a: unknown[]) => object).apply(target, args);
        if (prop !== 'limit') return wrapBuilder(next);
        return (async () => {
          await beforeQuery?.(pulled.length + 1);
          const rows = (await next) as unknown[];
          pulled.push(rows.length);
          return rows;
        })();
      };
    },
  });
}

function countingDb(inner: Db): Db {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'select') {
        return (...args: unknown[]) =>
          wrapBuilder((target.select as (...a: unknown[]) => object)(...args));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

let counted: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
  counted = createPgStoresFromDb(countingDb(db));
  pulled = [];
  beforeQuery = undefined;
});

function entry(i: number, body: string): SessionStoreEntry {
  return { type: 'assistant', uuid: `u${String(i).padStart(5, '0')}`, body };
}

async function appendMany(entries: SessionStoreEntry[]): Promise<void> {
  // 1文のパラメータ数の上限へ当たらないよう、分けて積む（順序は保たれる）。
  for (let i = 0; i < entries.length; i += 200) {
    await stores.sessionStore.append(KEY, entries.slice(i, i + 200));
  }
}

// 今までの `readTail` と同じ計算を、全行を読んだうえで素朴に当てた参照。
async function referenceTail(maxChars: number): Promise<string | null> {
  const all = (await stores.sessionStore.load(KEY)) ?? [];
  const newestFirst = all.slice(-TAIL_SCAN_ROWS).reverse();
  if (newestFirst.length === 0) return null;
  const lines: string[] = [];
  let chars = 0;
  for (const row of newestFirst) {
    const line = JSON.stringify(row);
    lines.push(line);
    chars += countCodePoints(line) + 1;
    if (chars > maxChars + 1) break;
  }
  return lines.reverse().join('\n');
}

describe('PgSessionStore.readTail() — keyset の束読み', () => {
  it('束の境目をまたぐ（最初の束では足りない）とき、全行を読む形と同じ結果になる', async () => {
    await appendMany(
      Array.from({ length: 300 }, (_, i) => entry(i, `body-${i}-${'x'.repeat(80)}`)),
    );
    // 1行は約 130 字。16 行（最初の束）で約 2100 字、48 行（16+32）で約 6300 字。
    for (const maxChars of [1_000, 2_500, 6_000, 9_000, 20_000, 1_000_000]) {
      pulled = [];
      const tail = await counted.sessionStore.readTail(KEY, maxChars);
      expect(tail).toBe(await referenceTail(maxChars));
      expect(pulled.length).toBeGreaterThan(0);
    }
    pulled = [];
    await counted.sessionStore.readTail(KEY, 6_000);
    expect(pulled.length).toBeGreaterThan(1);
  });

  it('1行が巨大なとき、最初の束の中で打ち切る（束の中の続きの行を JSON 化しない・次の束も引かない）', async () => {
    await appendMany(Array.from({ length: 100 }, (_, i) => entry(i, `small-${i}`)));
    await appendMany([entry(100, 'H'.repeat(300_000))]);

    const tail = await counted.sessionStore.readTail(KEY, 1_000);

    expect(tail).toBe(await referenceTail(1_000));
    expect(tail?.split('\n')).toHaveLength(1);
    expect(pulled).toEqual([16]);
  });

  it('行数が TAIL_SCAN_ROWS を超えても、上限で止まる（読む行の合計が 2000）', async () => {
    await appendMany(Array.from({ length: TAIL_SCAN_ROWS + 150 }, (_, i) => entry(i, 'a')));

    const tail = await counted.sessionStore.readTail(KEY, 100_000_000);

    const lines = tail?.split('\n') ?? [];
    expect(lines).toHaveLength(TAIL_SCAN_ROWS);
    expect(lines.at(-1)).toContain(`u${String(TAIL_SCAN_ROWS + 149).padStart(5, '0')}`);
    expect(lines[0]).toContain(`u${String(150).padStart(5, '0')}`);
    expect(tail).toBe(await referenceTail(100_000_000));
    expect(pulled.reduce((sum, n) => sum + n, 0)).toBe(TAIL_SCAN_ROWS);
    // 倍々で増える: 16, 32, 64, 128, 256, 512, そして残りの 992。
    expect(pulled).toEqual([16, 32, 64, 128, 256, 512, 992]);
  });

  it('行数がちょうど TAIL_SCAN_ROWS のとき、全部読んで止まる（余分な問い合わせをしない）', async () => {
    await appendMany(Array.from({ length: TAIL_SCAN_ROWS }, (_, i) => entry(i, 'a')));

    const tail = await counted.sessionStore.readTail(KEY, 100_000_000);

    expect(tail?.split('\n')).toHaveLength(TAIL_SCAN_ROWS);
    expect(pulled.reduce((sum, n) => sum + n, 0)).toBe(TAIL_SCAN_ROWS);
    expect(pulled.at(-1)).toBeGreaterThan(0);
  });

  it('補助面の文字（絵文字）が束の境目に絡んでも、コードポイントで数えて今と同じ結果になる', async () => {
    await appendMany(Array.from({ length: 80 }, (_, i) => entry(i, '\u{1F600}'.repeat(20))));
    const line = JSON.stringify(entry(0, '\u{1F600}'.repeat(20)));
    const cp = countCodePoints(line);
    expect(line.length).toBeGreaterThan(cp);

    // 16 行ちょうどで `chars > maxChars + 1` にならない（17 行目が要る）: 境目を1行またぐ。
    const exactlyFirstBatch = 16 * (cp + 1) - 1;
    const tailA = await counted.sessionStore.readTail(KEY, exactlyFirstBatch);
    expect(tailA).toBe(await referenceTail(exactlyFirstBatch));
    expect(tailA?.split('\n')).toHaveLength(17);
    expect([...(tailA ?? '')].length).toBeGreaterThan(exactlyFirstBatch);
    expect(pulled).toEqual([16, 32]);

    // 16 行目で超える: 最初の束の中で止まる。
    pulled = [];
    const tailB = await counted.sessionStore.readTail(KEY, exactlyFirstBatch - 1);
    expect(tailB).toBe(await referenceTail(exactlyFirstBatch - 1));
    expect(tailB?.split('\n')).toHaveLength(16);
    expect(pulled).toEqual([16]);
  });

  it('⭐ maxChars を満たしたら、それ以上の行を引かない', async () => {
    await appendMany(
      Array.from({ length: 1_000 }, (_, i) => entry(i, `body-${i}-${'x'.repeat(80)}`)),
    );

    await counted.sessionStore.readTail(KEY, 500);
    expect(pulled).toEqual([16]);

    // 約 130 字 × 40 行 ≒ 5200 字: 16 行では足りず、48 行（16+32）で満ちる。64 の束は引かない。
    pulled = [];
    const tail = await counted.sessionStore.readTail(KEY, 5_000);
    expect(pulled).toEqual([16, 32]);
    expect(tail).toBe(await referenceTail(5_000));
  });

  it('行が無いときは null、最初の束に満たない行数ならそのまま全部を返す', async () => {
    expect(await counted.sessionStore.readTail(KEY, 1_000)).toBeNull();
    expect(pulled).toEqual([0]);

    await appendMany([entry(1, 'a'), entry(2, 'b')]);
    pulled = [];
    const tail = await counted.sessionStore.readTail(KEY, 1_000_000);
    expect(tail?.split('\n')).toHaveLength(2);
    expect(pulled).toEqual([2]);
  });

  it('束と束の間に行が積まれても、最初の束より後ろの行は混ざらず、同じ行を二度読まない', async () => {
    await appendMany(
      Array.from({ length: 100 }, (_, i) => entry(i, `body-${i}-${'x'.repeat(80)}`)),
    );
    const expected = await referenceTail(5_000);
    expect(expected?.split('\n').length).toBeGreaterThan(16);

    beforeQuery = async (n) => {
      if (n !== 2) return;
      await stores.sessionStore.append(KEY, [entry(900, 'LATE-A'), entry(901, 'LATE-B')]);
    };
    const tail = await counted.sessionStore.readTail(KEY, 5_000);

    expect(pulled.length).toBeGreaterThan(1);
    expect(tail).not.toContain('LATE');
    expect(tail).toBe(expected);
    const uuids = (tail ?? '')
      .split('\n')
      .map((line) => (JSON.parse(line) as { uuid: string }).uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });
});
