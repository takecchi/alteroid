import { describe, expect, it } from 'vitest';

import { createTokenPoolService } from './token-pool-service.js';
import { createMemoryStores } from './testing.js';

/**
 * 認証トークンのプールを**置いて読む**までの1本道（Issue #393「PR1」）。
 *
 * `profile-service.ts` と同じ形——書く操作はすべて直列化された1本の列を通る。
 * ここで固定するのは、その直列化そのものと、**サービスの外へ `value` が
 * 一度も出ないこと**の2つである。
 */

describe('直列化', () => {
  it('2本同時に replace を投げても、後から入ったほうが前のものを見てから走る', async () => {
    const stores = createMemoryStores();
    const ids = ['tok-a'];
    const service = createTokenPoolService({
      stores,
      now: () => new Date('2026-08-24T00:00:00.000Z'),
      newId: () => ids.shift() ?? 'tok-fallback',
    });

    // 1本目は新規行を作る（id は `newId()` が払い出す `tok-a`）。
    const first = service.replace([{ label: 'first', value: 'tok-aaa' }]);
    // 2本目は、1本目が払い出す id をまだ知らないはずなのに、それを**指定して**
    // 呼ぶ——直列化されていなければ、2本目の existing にはまだ `tok-a` が無く
    // `normalizeTokenPool` が Error を投げる（「消えた行を静かに作り直さない」）。
    // 直列化されていれば、2本目は1本目の書き込みが終わった後の existing を
    // 読むので、`tok-a` を「既存の行」として引き継げる。
    const second = service.replace([{ id: 'tok-a', label: 'renamed-by-second' }]);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.tokens[0]?.id).toBe('tok-a');
    expect(secondResult.tokens).toEqual([
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

    // 2本目は1本目の結果を土台に部分更新するので、両方の変更が残る
    // （直列化されていれば必ずこうなる。並行に読んでから書いていたら、
    // 片方が失われうる）。
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

    const { tokens } = await service.replace([{ label: 'a', value: SECRET }]);

    expect(tokens[0]).not.toHaveProperty('value');
    expect(JSON.stringify(tokens)).not.toContain(SECRET);
  });

  it('normalizeTokenPool が投げたら、保存せずにそのまま投げ返す', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({ stores });

    await expect(service.replace([{ id: 'ghost', label: '幽霊', value: 'x' }])).rejects.toThrow();
    // 保存もしていない。
    expect(await stores.tokens.list()).toEqual([]);
  });
});

describe('既定（プールが空のとき）', () => {
  it('list() は空の一覧と既定の設定を返す（受け入れ基準7: 既定の構成を1文字も変えない）', async () => {
    const stores = createMemoryStores();
    const service = createTokenPoolService({ stores });

    const { tokens, settings } = await service.list();

    expect(tokens).toEqual([]);
    expect(settings.rotateOn).toBe('free_exhausted');
  });
});

/**
 * 止まった事実の記録（Issue #393）。**回さない**——記録するだけである。
 */
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
    // 文言から導いた見込み（保存しない。読むたびに導く）。
    expect(noted?.recovery).toBe('time');

    const { tokens } = await service.list();
    const other = tokens.find((token) => token.id === 'tok-b');
    expect(other).not.toHaveProperty('lastRejectedAt');
    expect(other).not.toHaveProperty('cooldownUntil');
  });

  it('resetsAt が無いときは、その列の中で読んだ設定の既定で冷やす', async () => {
    const { service } = await seeded();
    // 既定を変えてから記録する——**呼び出し側が既定を渡す形にしていない**ので、
    // 変えた直後の値がそのまま効く。
    await service.setSettings({ cooldownMs: 60_000 });

    const noted = await service.noteUnusable({ id: 'tok-a', message: MESSAGE });

    expect(noted?.cooldownUntil).toBe(Date.parse(AT) + 60_000);
  });

  it('resetsAt が取れていればそちらを使う（権威ある期限）', async () => {
    const { service } = await seeded();

    const noted = await service.noteUnusable({
      id: 'tok-a',
      message: MESSAGE,
      resetsAt: 1_800_000_000_000,
    });

    expect(noted?.cooldownUntil).toBe(1_800_000_000_000);
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

    // 通知が届くまでの間に人間がその行を消していることは普通に起こる。
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
    // 正本の側では値が保たれている（記録の消去は資格の消去ではない）。
    expect((await stores.tokens.list())[0]?.value).toBe(SECRET);
  });

  it('同じ列を通る（記録と全文置換が混ざらない）', async () => {
    const { service } = await seeded();

    // 記録と、その行を含む全文置換を同時に投げる。直列化されていれば、後から
    // 入った replace は記録済みの行を読んで `lastRejectedReason` を引き継ぐ。
    const noting = service.noteUnusable({ id: 'tok-a', message: MESSAGE });
    const replacing = service.replace([{ id: 'tok-a', label: 'renamed' }]);
    await Promise.all([noting, replacing]);

    const { tokens } = await service.list();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.label).toBe('renamed');
    expect(tokens[0]?.lastRejectedReason).toBe(MESSAGE);
  });
});
