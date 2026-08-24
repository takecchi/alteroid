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
