import { describe, expect, it } from 'vitest';

import { TokenPoolVersionMismatchError } from './token-pool.js';
import { createTokenPoolService } from './token-pool-service.js';
import { createMemoryStores } from './testing.js';

function serviceOf() {
  const stores = createMemoryStores();
  const ids = ['tok-a', 'tok-b', 'tok-c'];
  const service = createTokenPoolService({
    stores,
    now: () => new Date('2026-10-12T00:00:00.000Z'),
    newId: () => ids.shift() ?? 'tok-fallback',
  });
  return { stores, service };
}

async function versionOf(service: ReturnType<typeof serviceOf>['service']): Promise<string> {
  const { version } = await service.list();
  if (version === undefined) throw new Error('list() は版を返すはず');
  return version;
}

describe('プールの版（ifMatch）で、読んだ後の変更を黙って消さない（#4591）', () => {
  it('読んだ後にほかで足された行があれば、読んだ版での全文置換は何も変えずに断る', async () => {
    const { service } = serviceOf();
    await service.replace([{ label: 'a', value: 'fake-a' }]);
    const read = await versionOf(service);

    // 読んだ後に、ほかで b が足される
    await service.replace([
      { id: 'tok-a', label: 'a' },
      { label: 'b', value: 'fake-b' },
    ]);

    // 読んだ時点の一覧（a だけ）から a を消すつもりの全文置換
    await expect(service.replace([], { ifMatch: read })).rejects.toBeInstanceOf(
      TokenPoolVersionMismatchError,
    );
    const { tokens } = await service.list();
    expect(tokens.map((token) => token.id)).toEqual(['tok-a', 'tok-b']);
  });

  it('版が合っていれば、今までどおり置き換える', async () => {
    const { service } = serviceOf();
    await service.replace([
      { label: 'a', value: 'fake-a' },
      { label: 'b', value: 'fake-b' },
    ]);

    const result = await service.replace([{ id: 'tok-b', label: 'b' }], {
      ifMatch: await versionOf(service),
    });

    if (result.kind !== 'replaced') throw new Error('保存後の読み直しは失敗しないはず');
    expect(result.view.tokens.map((token) => token.id)).toEqual(['tok-b']);
  });

  it('対照: ifMatch を渡さなければ、今までどおり比べずに置き換える', async () => {
    const { service } = serviceOf();
    await service.replace([{ label: 'a', value: 'fake-a' }]);
    await service.replace([
      { id: 'tok-a', label: 'a' },
      { label: 'b', value: 'fake-b' },
    ]);

    const result = await service.replace([]);

    if (result.kind !== 'replaced') throw new Error('保存後の読み直しは失敗しないはず');
    expect(result.view.tokens).toEqual([]);
  });

  it('改名・無効化・順の入れ替え・値の差し替えで版が変わる', async () => {
    const { service } = serviceOf();
    await service.replace([
      { label: 'a', value: 'fake-a' },
      { label: 'b', value: 'fake-b' },
    ]);
    const seen = new Set([await versionOf(service)]);
    const steps = [
      [
        { id: 'tok-a', label: 'a2' },
        { id: 'tok-b', label: 'b' },
      ],
      [
        { id: 'tok-a', label: 'a2', disabled: true },
        { id: 'tok-b', label: 'b' },
      ],
      [
        { id: 'tok-b', label: 'b' },
        { id: 'tok-a', label: 'a2' },
      ],
      [
        { id: 'tok-b', label: 'b', value: 'fake-b2' },
        { id: 'tok-a', label: 'a2' },
      ],
    ];
    for (const step of steps) {
      await service.replace(step);
      seen.add(await versionOf(service));
    }
    expect(seen.size).toBe(steps.length + 1);
  });

  it('回し手が書く冷却・拒否の記録では版が変わらない（人の操作が回し手の書き戻しで断られない）', async () => {
    const { service } = serviceOf();
    await service.replace([{ label: 'a', value: 'fake-a' }]);
    const before = await versionOf(service);

    await service.noteUnusable({ id: 'tok-a', message: 'rate limited' });
    await service.noteUsable('tok-a');
    await service.noteUnusable({ id: 'tok-a', message: 'rate limited again' });

    expect(await versionOf(service)).toBe(before);
  });
});
