import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  describeUnreadableUsage,
  modelUsageOf,
  summarizeUsage,
  type UsageSnapshot,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { FsUsageStore } from './usage.js';

let dir: string;
let store: FsUsageStore;

beforeEach(async () => {
  dir = await makeTempDir('alteroid-usage-unmetered-');
  store = new FsUsageStore(dir);
});

const BASE = {
  layer: 'manager',
  site: 'session',
  managerId: 'mgr-1',
  date: '2026-10-01',
  accumulation: 'cumulative',
} as const;

const UNMETERED = {
  layer: 'clone',
  site: 'session',
  managerId: 'clone',
  date: '2026-10-01',
  provider: 'codex',
} as const;

function snapshot(models: Record<string, unknown>): UsageSnapshot {
  const read = modelUsageOf({ modelUsage: models });
  if (read === undefined) throw new Error('modelUsage が読めない');
  return { models: read };
}

const FULL = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0.25,
};

const WITHOUT_COST = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
};

async function readFileJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8')) as Record<string, unknown>;
}

describe('費用の欄が無い使用量は、0 として合計に混ざらず「取れなかった」になる（fs）', () => {
  it('costUSD が無い区間は costUsd=0 の行になり、unreadable.costUsd に数えられ、表示が取れなかったと言う', async () => {
    const withoutCost = WITHOUT_COST;
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: withoutCost }),
    });

    const { rows, turnRows } = await store.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.inputTokens).toBe(100);
    expect(rows[0]?.totals.costUsd).toBe(0);
    expect(rows[0]?.totals.unreadable).toEqual({ costUsd: 1 });

    expect(describeUnreadableUsage(summarizeUsage(rows, turnRows).total)).toEqual([
      '⚠ 一部の区切りで SDK から値が取れなかった（0 ではなく取れなかった。取れなかった数: 費用 1回）。',
    ]);
  });

  it('費用が読めた区間には unreadable が付かない（対照）', async () => {
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    const { rows } = await store.aggregate({});
    expect(rows[0]?.totals.costUsd).toBe(0.25);
    expect(rows[0]?.totals).not.toHaveProperty('unreadable');
  });
});

describe('FsUsageStore.recordUnmetered（無報告の provider のターン）', () => {
  it('無報告の行が無ければ、aggregate に unmeteredRows の鍵ごと無く、usage.json にも unmetered 欄を書かない', async () => {
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    expect(await store.aggregate({})).not.toHaveProperty('unmeteredRows');
    expect(await readFileJson()).not.toHaveProperty('unmetered');
  });

  it('1回数えると1行（turns=1）。rows / turns / baselines / 台帳の始点は1つも増えない（0 を積まない）', async () => {
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    const fileBefore = await readFileJson();
    const before = await store.aggregate({});

    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });

    const { unmeteredRows, ...rest } = await store.aggregate({});
    expect(rest).toEqual(before);
    expect(unmeteredRows).toEqual([
      {
        date: '2026-10-01',
        managerId: 'clone',
        layer: 'clone',
        site: 'session',
        provider: 'codex',
        turns: 1,
        updatedAt: '2026-10-01T11:00:00.000Z',
      },
    ]);
    const { unmetered, ...fileRest } = await readFileJson();
    expect(fileRest).toEqual(fileBefore);
    expect(Object.keys(unmetered as object)).toHaveLength(1);
  });

  it('無報告だけの器でも、台帳の行・始点は動かない（since は null のまま）', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    const aggregate = await store.aggregate({});
    expect(aggregate.rows).toEqual([]);
    expect(aggregate.turnRows).toEqual([]);
    expect(aggregate.since).toBeNull();
    expect(aggregate.unmeteredRows).toHaveLength(1);
  });

  it('同じ鍵は足し込み、provider とトークンが違えば別の行になる', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T12:00:00.000Z' });
    await store.recordUnmetered({
      ...UNMETERED,
      provider: 'other',
      at: '2026-10-01T12:00:00.000Z',
    });
    await store.recordUnmetered({ ...UNMETERED, tokenId: 'tok-1', at: '2026-10-01T12:00:00.000Z' });

    const { unmeteredRows } = await store.aggregate({});
    expect(unmeteredRows?.map((row) => [row.provider, row.tokenId ?? null, row.turns])).toEqual([
      ['codex', 'tok-1', 1],
      ['codex', null, 2],
      ['other', null, 1],
    ]);
  });

  it('照会の絞り込み（日・層）が効く。範囲外なら鍵ごと無い', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    expect((await store.aggregate({ from: '2026-10-02' })).unmeteredRows).toBeUndefined();
    expect((await store.aggregate({ layer: 'manager' })).unmeteredRows).toBeUndefined();
    expect((await store.aggregate({ layer: 'clone' })).unmeteredRows).toHaveLength(1);
  });

  it('clear() は無報告の行も消す（返り値の型は広げない）', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    const removed = await store.clear();
    expect(Object.keys(removed).sort()).toEqual(['baseline', 'daily', 'ledger', 'turns']);
    expect((await store.aggregate({})).unmeteredRows).toBeUndefined();
    expect(await readFileJson()).not.toHaveProperty('unmetered');
  });
});

describe('unmetered 欄が無い古い usage.json（fs）', () => {
  it('古いファイルを読んでも aggregate が変わらず、無報告を足しても既存の欄・合計は増えない', async () => {
    await store.record({
      ...BASE,
      at: '2026-10-01T10:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    await store.record({
      ...BASE,
      layer: 'clone',
      managerId: 'clone',
      tokenId: 'tok-1',
      at: '2026-10-01T10:30:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    const legacyFile = await readFileJson();
    expect(legacyFile).not.toHaveProperty('unmetered');

    const fresh = new FsUsageStore(dir);
    const reference = await store.aggregate({});
    expect(await fresh.aggregate({})).toEqual(reference);

    await fresh.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    const { unmeteredRows, ...rest } = await fresh.aggregate({});
    expect(rest).toEqual(reference);
    expect(unmeteredRows).toHaveLength(1);
    expect(summarizeUsage(rest.rows, rest.turnRows)).toEqual(
      summarizeUsage(reference.rows, reference.turnRows),
    );
    const fileRest = Object.fromEntries(
      Object.entries(await readFileJson()).filter(([key]) => key !== 'unmetered'),
    );
    expect(fileRest).toEqual(legacyFile);
  });

  it('record（Claude の通常の積み）が、既にある unmetered 欄を落とさない', async () => {
    await store.recordUnmetered({ ...UNMETERED, at: '2026-10-01T11:00:00.000Z' });
    await store.record({
      ...BASE,
      at: '2026-10-01T12:00:00.000Z',
      snapshot: snapshot({ opus: FULL }),
    });
    expect((await store.aggregate({})).unmeteredRows).toHaveLength(1);
  });
});
