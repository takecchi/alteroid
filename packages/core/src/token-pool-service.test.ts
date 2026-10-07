import { describe, expect, it } from 'vitest';

import { createTokenPoolService } from './token-pool-service.js';
import { createMemoryStores } from './testing.js';

describe('直列化', () => {
  it('2本同時に replace を投げても、後から入ったほうが前のものを見てから走る', async () => {
    const stores = createMemoryStores();
    const ids = ['tok-a'];
    const service = createTokenPoolService({
      stores,
      now: () => new Date('2026-08-24T00:00:00.000Z'),
      newId: () => ids.shift() ?? 'tok-fallback',
    });

    const first = service.replace([{ label: 'first', value: 'tok-aaa' }]);
    const second = service.replace([{ id: 'tok-a', label: 'renamed-by-second' }]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    if (firstResult.kind !== 'replaced' || secondResult.kind !== 'replaced') {
      throw new Error('保存後の読み直しは失敗しないはず');
    }

    expect(firstResult.view.tokens[0]?.id).toBe('tok-a');
    expect(secondResult.view.tokens).toEqual([
      expect.objectContaining({ id: 'tok-a', label: 'renamed-by-second' }),
    ]);
  });

  it('setSettings も同じ列を通る（後勝ちが正しく反映される）', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({
      stores,
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });

    const [firstResult, secondResult] = await Promise.all([
      service.setSettings({ rotateOn: 'overage_exhausted' }),
      service.setSettings({ cooldownMs: 1_000 }),
    ]);

    expect(secondResult).toEqual({
      rotateOn: 'overage_exhausted',
      cooldownMs: 1_000,
      updatedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(firstResult.rotateOn).toBe('overage_exhausted');
  });
});

describe('外へ出す顔', () => {
  it('list() の返り値に value が無い（JSON化しても値が現れない）', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({ stores });
    const SECRET = 'tok-super-secret-value';

    await service.replace([{ label: 'a', value: SECRET }]);
    const { tokens } = await service.list();

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toHaveProperty('value');
    expect(JSON.stringify(tokens)).not.toContain(SECRET);
  });

  it('replace() の返り値にも value が無い', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({ stores });
    const SECRET = 'tok-another-secret';

    const result = await service.replace([{ label: 'a', value: SECRET }]);
    if (result.kind !== 'replaced') throw new Error('保存後の読み直しは失敗しないはず');
    const { tokens } = result.view;

    expect(tokens[0]).not.toHaveProperty('value');
    expect(JSON.stringify(tokens)).not.toContain(SECRET);
  });

  it('normalizeTokenPool が投げたら、保存せずにそのまま投げ返す', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({ stores });

    await expect(service.replace([{ id: 'ghost', label: '幽霊', value: 'x' }])).rejects.toThrow();
    expect(await stores.tokens.list()).toEqual([]);
  });
});

describe('既定（プールが空のとき）', () => {
  it('list() は空の一覧と既定の設定を返す（受け入れ基準7: 既定の構成を1文字も変えない）', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({ stores });

    const { tokens, settings } = await service.list();

    expect(tokens).toEqual([]);
    if (settings === undefined)
      throw new Error('settings が読めなかった（このテストでは読めるはず）');
    expect(settings.rotateOn).toBe('free_exhausted');
  });
});

describe('noteUnusable / noteUsable', () => {
  const AT = '2026-08-25T03:00:00.000Z';
  const MESSAGE = "You've hit your org's monthly spend limit";

  async function seeded() {
    const stores = createMemoryStores();
    const ids = ['tok-a', 'tok-b'];
    const service = createTokenPoolService({
      stores,
      now: () => new Date(AT),
      newId: () => ids.shift() ?? 'tok-fallback',
    });
    await service.replace([
      { label: 'first', value: 'tok-aaa' },
      { label: 'second', value: 'tok-bbb' },
    ]);
    return { stores, service };
  }

  it('指した1行にだけ記録する（他の行は動かない）', async () => {
    const { service } = await seeded();

    const noted = await service.noteUnusable({ id: 'tok-a', message: MESSAGE });

    expect(noted?.lastRejectedAt).toBe(AT);
    expect(noted?.lastRejectedReason).toBe(MESSAGE);
    expect(noted?.recovery).toBe('time');

    const { tokens } = await service.list();
    const other = tokens.find((token) => token.id === 'tok-b');
    expect(other).not.toHaveProperty('lastRejectedAt');
    expect(other).not.toHaveProperty('cooldownUntil');
  });

  it('resetsAt が無いときは、その列の中で読んだ設定の既定で冷やす', async () => {
    const { service } = await seeded();
    await service.setSettings({ cooldownMs: 60_000 });

    const noted = await service.noteUnusable({ id: 'tok-a', message: MESSAGE });

    expect(noted?.cooldownUntil).toBe(Date.parse(AT) + 60_000);
  });

  it('resetsAt が取れていればそちらを使う（権威ある期限）', async () => {
    const { service } = await seeded();

    const noted = await service.noteUnusable({
      id: 'tok-a',
      message: MESSAGE,
      resets: { at: 1_800_000_000_000, source: 'quota_reset' },
    });

    expect(noted?.cooldownUntil).toBe(1_800_000_000_000);
    expect(noted?.cooldownSource).toBe('quota_reset');
  });

  it('使えたことを確かめられたら記録を消す', async () => {
    const { service } = await seeded();
    await service.noteUnusable({ id: 'tok-a', message: MESSAGE });

    const cleared = await service.noteUsable('tok-a');

    expect(cleared).not.toHaveProperty('lastRejectedAt');
    expect(cleared).not.toHaveProperty('lastRejectedReason');
    expect(cleared).not.toHaveProperty('cooldownUntil');
    expect(cleared).not.toHaveProperty('recovery');
  });

  it('居ない行を指したら undefined を返す（投げない）', async () => {
    const { service } = await seeded();

    expect(await service.noteUnusable({ id: 'ghost', message: MESSAGE })).toBeUndefined();
    expect(await service.noteUsable('ghost')).toBeUndefined();
  });

  it('返り値に value が無い（記録の経路も値を外へ出さない）', async () => {
    const stores = createMemoryStores();
    const SECRET = 'tok-secret-in-note-path';
    const service = createTokenPoolService({
      stores,
      now: () => new Date(AT),
      newId: () => 'tok-a',
    });
    await service.replace([{ label: 'a', value: SECRET }]);

    const noted = await service.noteUnusable({ id: 'tok-a', message: MESSAGE });

    expect(noted).not.toHaveProperty('value');
    expect(JSON.stringify(noted)).not.toContain(SECRET);
    expect((await stores.tokens.list())[0]?.value).toBe(SECRET);
  });

  it('同じ列を通る（記録と全文置換が混ざらない）', async () => {
    const { service } = await seeded();

    const noting = service.noteUnusable({ id: 'tok-a', message: MESSAGE });
    const replacing = service.replace([{ id: 'tok-a', label: 'renamed' }]);
    await Promise.all([noting, replacing]);

    const { tokens } = await service.list();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.label).toBe('renamed');
    expect(tokens[0]?.lastRejectedReason).toBe(MESSAGE);
  });
});

describe('プールが変わったことを知らせる（onChanged）', () => {
  it('全文置換が保存できたら pool として知らせる', async () => {
    const stores = createMemoryStores();
    const changes: string[] = [];
    const service = createTokenPoolService({
      stores,
      onChanged: (change) => changes.push(change),
    });

    await service.replace([{ label: 'first', value: 'value-a' }]);

    expect(changes).toEqual(['pool']);
  });

  it('設定を変えたら settings として知らせる', async () => {
    const stores = createMemoryStores();
    const changes: string[] = [];
    const service = createTokenPoolService({
      stores,
      onChanged: (change) => changes.push(change),
    });

    await service.setSettings({ rotateOn: 'free_exhausted' });

    expect(changes).toEqual(['settings']);
  });

  it('検証で落ちた入力では知らせない（保存できていないので）', async () => {
    const stores = createMemoryStores();
    const changes: string[] = [];
    const service = createTokenPoolService({
      stores,
      onChanged: (change) => changes.push(change),
    });

    await expect(
      service.replace([{ id: 'tok-gone', label: 'first', value: 'value-a' }]),
    ).rejects.toThrow();

    expect(changes).toEqual([]);
  });

  it('聞き手が投げても保存の結果を巻き添えにしない', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({
      stores,
      onChanged: () => {
        throw new Error('見張りが落ちた');
      },
    });

    const result = await service.replace([{ label: 'first', value: 'value-a' }]);
    if (result.kind !== 'replaced') throw new Error('保存後の読み直しは失敗しないはず');
    const { tokens } = result.view;

    expect(tokens).toHaveLength(1);
    expect((await stores.tokens.list())[0]?.value).toBe('value-a');
  });

  it('記録の更新（noteUnusable / noteUsable）では知らせない', async () => {
    const stores = createMemoryStores();
    const changes: string[] = [];
    const service = createTokenPoolService({
      stores,
      onChanged: (change) => changes.push(change),
    });
    const replaced = await service.replace([{ label: 'first', value: 'value-a' }]);
    if (replaced.kind !== 'replaced') throw new Error('保存後の読み直しは失敗しないはず');
    const { tokens } = replaced.view;
    changes.length = 0;
    const id = tokens[0]?.id ?? '';

    await service.noteUnusable({ id, message: '上限' });
    await service.noteUsable(id);

    expect(changes).toEqual([]);
  });
});
