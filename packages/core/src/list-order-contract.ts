import { compareCodeUnits } from './code-unit-order.js';
import type { Stores } from './store.js';
import { ZERO_USAGE } from './usage.js';

// PGlite は照合順が C なので pg 側は偶然通る。本番の PostgreSQL が `en_US.UTF-8` などなら glibc の照合が記号を無視して別の並びになるので、本物の PostgreSQL へ向けても走らせられるよう、vitest に依存しない素の非同期関数にする。
// 空の器に対して呼ぶこと: 接頭辞 `ord` の名前だけを足し、読み出しはその接頭辞で絞る。消しはしない。
export async function verifyListOrderContract(stores: Stores): Promise<void> {
  function fail(message: string): never {
    throw new Error(`一覧の並びの契約違反: ${message}`);
  }

  function expectOrder(
    label: string,
    actual: readonly string[],
    inserted: readonly string[],
  ): void {
    const expected = [...inserted].sort(compareCodeUnits);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(
        `${label} の並びがコード単位の順でない: 実際 ${JSON.stringify(actual)} / 期待 ${JSON.stringify(expected)}`,
      );
    }
  }

  // 挿入順はわざと崩す。
  const slugs = ['ord-ab', 'ord-a_b', 'ord-a1', 'ord-a-b', 'ord-0x', 'ord-a.b', 'ord-b'];

  for (const slug of slugs) await stores.persona.write(slug, '# x\n');
  expectOrder(
    'persona.list()',
    (await stores.persona.list()).map((d) => d.slug).filter((s) => s.startsWith('ord')),
    slugs,
  );
  expectOrder(
    'persona.documents()',
    (await stores.persona.documents()).map((d) => d.slug).filter((s) => s.startsWith('ord')),
    slugs,
  );

  for (const slug of slugs) {
    await stores.practices.write({ slug, kind: '調査', title: 't', content: 'c' });
  }
  expectOrder(
    'practices.list()',
    (await stores.practices.list()).entries.map((p) => p.slug).filter((s) => s.startsWith('ord')),
    slugs,
  );

  const at = '2026-08-12T00:00:00.000Z';
  for (const kind of slugs) {
    await stores.schedules.put({
      kind,
      spec: { type: 'daily', at: '09:00' },
      request: 'r',
      createdAt: at,
      updatedAt: at,
    });
  }
  expectOrder(
    'schedules.list()',
    (await stores.schedules.list()).entries.map((s) => s.kind).filter((k) => k.startsWith('ord')),
    slugs,
  );

  const names = ['ORD_AB', 'ORD_A_B', 'ORD_A1', 'ORD_B', 'ORD_0X', 'ORD__'];
  await stores.credentials.put(names.map((name) => ({ name, value: 'v' })));
  expectOrder(
    'credentials.list()',
    (await stores.credentials.list()).map((c) => c.name).filter((n) => n.startsWith('ORD')),
    names,
  );

  const managers = ['mgr-b', 'mgr_a', 'Mgr-c', 'mgr.a', 'mgr1', 'mgr日本', 'mgr-a'];
  for (const managerId of managers) {
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      managerId,
      date: '2026-08-12',
      at,
      accumulation: 'cumulative',
      snapshot: { models: { m: { ...ZERO_USAGE, outputTokens: 1 } } },
    });
  }
  const aggregate = await stores.usage.aggregate({ from: '2026-08-12', to: '2026-08-12' });
  expectOrder(
    'usage.aggregate().rows の managerId',
    aggregate.rows.map((r) => r.managerId).filter((m) => m.toLowerCase().startsWith('mgr')),
    managers,
  );
  const models = ['claude_x', 'claude-y', 'Claude-z', 'claude.w'];
  await stores.usage.record({
    layer: 'manager',
    site: 'session',
    managerId: 'ord-model',
    date: '2026-08-12',
    at,
    accumulation: 'cumulative',
    snapshot: {
      models: Object.fromEntries(models.map((m) => [m, { ...ZERO_USAGE, outputTokens: 1 }])),
    },
  });
  const byModel = await stores.usage.aggregate({ managerId: 'ord-model' });
  expectOrder(
    'usage.aggregate().rows の model',
    byModel.rows.map((r) => r.model),
    models,
  );
}
