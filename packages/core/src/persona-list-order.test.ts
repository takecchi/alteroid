import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('PersonaStore.list は slug の昇順で返す（#662 の継続点の前提）', () => {
  it('挿入順が slug 順と食い違っていても、slug の昇順で返る', async () => {
    const stores = createMemoryStores();
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

    // 自然順ソートにしない: pg の `asc(memory.slug)` が文字列順なので食い違う。
    expect(listed.map((doc) => doc.slug)).toEqual(['a-10', 'a-2', 'b-2']);
  });
});
