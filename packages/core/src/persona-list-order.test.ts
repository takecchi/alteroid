import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

/**
 * `PersonaStore.list()` が **slug の昇順**で返すことの歯（#662）。
 *
 * **なぜ要るか**: `memory_list` の継続点（`memory-cursor.ts`）は「一覧が
 * 並んでいる」ことに全面的に依拠する。錨より後ろを切り出す操作は、並びが
 * 呼ぶたびに変わるなら**行を飛ばすか、同じ行を繰り返す。** ⟹ 継続点を
 * 足す前に、並びを契約にしておかなければならない
 * （`schedule-cursor.ts` が `ScheduleStore.list()` の「kind の昇順。」に
 * 依拠しているのと同じ形。逐語: `grep -Fn -- 'kind の昇順。' packages/core/src/store.ts`）。
 *
 * ⚠️ **この歯は最初から緑だった。** 3実装とも既に slug 順である
 * （pg: `.orderBy(asc(memory.slug))`、fs: `names.sort()`、in-memory:
 * `.sort((a, b) => a.slug.localeCompare(b.slug))`）。⟹ **欠けていたのは
 * 振る舞いではなく、interface の契約そのものである**——`PersonaStore.list()`
 * には並びの doc が1行も無く、3実装が偶然揃っているだけだった。
 * **だからこの歯は「直した証拠」ではなく「これから依拠する前提の固定」である。**
 *
 * ⚠️ **照合順序の差は残る。** in-memory は `localeCompare`、fs はコード
 * ポイント順、pg は `asc` の照合順序。**厳密な一致は保証されていない**
 * （`schedule-cursor.ts` の「第二の手段の限界」と同じ）。⟹ 継続点は
 * **位置の探索を第一の手段にする**ので、通常経路はこの差に晒されない。
 *
 * ⚠️ **ここで固定するのは in-memory だけである。** fs / pg は別パッケージに
 * 歯が在り、この層からはストアを作れない（DB も一時ディレクトリも要る）。
 * ⟹ **「3実装とも満たす」を機械で言い切ってはいない**——言えているのは
 * 「interface に契約が在る」ことと「in-memory がそれを満たす」ことである。
 */
describe('PersonaStore.list は slug の昇順で返す（#662 の継続点の前提）', () => {
  it('挿入順が slug 順と食い違っていても、slug の昇順で返る', async () => {
    const stores = createMemoryStores();
    // わざと slug 順と逆に入れる。
    for (const slug of ['zebra', 'apple', 'mango']) {
      await stores.persona.write(slug, `# ${slug}\n\n本文\n`);
    }

    const listed = await stores.persona.list();

    expect(listed.map((doc) => doc.slug)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('数字と記号を含む slug でも、昇順の契約は崩れない', async () => {
    const stores = createMemoryStores();
    for (const slug of ['b-2', 'a-10', 'a-2']) {
      await stores.persona.write(slug, `# ${slug}\n\n本文\n`);
    }

    const listed = await stores.persona.list();

    // ⚠ 文字列の昇順である（`a-10` が `a-2` より前）。**数値の順ではない。**
    // 契約を「slug の昇順」と書いた以上、ここを自然順ソートへ変えないこと
    // ——変えると pg の `asc(memory.slug)` と食い違う。
    expect(listed.map((doc) => doc.slug)).toEqual(['a-10', 'a-2', 'b-2']);
  });
});
