import { describe, expect, it } from 'vitest';

import { practiceVersion, type Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

interface Harness {
  stores: Stores;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  description(name: string): string;
}

function harness(): Harness {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return {
    stores,
    async call(name, args) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
    description(name) {
      return tools.find((entry) => entry.name === name)?.description ?? '';
    },
  };
}

function versionOf(body: string): string {
  const m = /base_version=([0-9a-f]{64})/.exec(body);
  if (!m) throw new Error(`応答に base_version が無い: ${body}`);
  return m[1]!;
}

const base = { slug: 'review', kind: 'レビュー', title: '題', content: 'クローンが最初に書いた\n' };

describe('practice_write / practice_remove の base_version（#2923）', () => {
  it('再現: 読んだ後の人間の直しを、クローンの全文書き直しが消さない', async () => {
    const h = harness();
    await h.stores.practices.write(base);
    await h.call('practice_read', { slug: 'review' });
    const v = practiceVersion(base);
    await h.stores.practices.write({ ...base, content: '人間が直した\n' });
    const body = await h.call('practice_write', {
      ...base,
      content: 'クローンの全文\n',
      base_version: v,
    });
    expect(body).toContain('何も書いていない');
    expect(body).toContain('その間に変わった');
    expect(body).toContain('practice_read slug=review');
    expect(body).toContain(practiceVersion({ ...base, content: '人間が直した\n' }));
    expect((await h.stores.practices.read('review'))?.content).toBe('人間が直した\n');
    expect(await h.stores.practices.listVersions('review')).toHaveLength(2);
  });

  it('版なしでは既存のやり方を書き直さない', async () => {
    const h = harness();
    await h.stores.practices.write(base);
    const body = await h.call('practice_write', { ...base, content: '新\n' });
    expect(body).toContain('何も書いていない');
    expect(body).toContain('practice_read slug=review');
    expect((await h.stores.practices.read('review'))?.content).toBe(base.content);
  });

  it('新規作成は版なしで通り、応答に版が出る。版を渡せば書き直せ、新しい版が返る', async () => {
    const h = harness();
    const created = await h.call('practice_write', base);
    expect(created).toContain('新しく作った');
    const v1 = versionOf(created);
    const next = await h.call('practice_write', { ...base, content: '二版\n', base_version: v1 });
    expect(next).toContain('書き直した');
    expect(versionOf(next)).toBe(practiceVersion({ ...base, content: '二版\n' }));
    expect((await h.stores.practices.read('review'))?.content).toBe('二版\n');
  });

  it('practice_read の応答の末尾に版が出る（practiceVersion と同じ値）', async () => {
    const h = harness();
    await h.stores.practices.write(base);
    const read = await h.call('practice_read', { slug: 'review' });
    expect(versionOf(read)).toBe(practiceVersion(base));
    expect(read.trimEnd().endsWith('に渡すこと）')).toBe(true);
  });

  it('読んだ後に消えたやり方へ版つきで書くと、書かずに「いまは無い」と返す', async () => {
    const h = harness();
    await h.stores.practices.write(base);
    const v = practiceVersion(base);
    await h.stores.practices.remove('review');
    const body = await h.call('practice_write', { ...base, base_version: v });
    expect(body).toContain('何も書いていない');
    expect(await h.stores.practices.read('review')).toBeNull();
  });

  it('再現: 読んだ後に人間が直したやり方を、practice_remove が消さない', async () => {
    const h = harness();
    await h.stores.practices.write(base);
    await h.call('practice_read', { slug: 'review' });
    const v = practiceVersion(base);
    await h.stores.practices.write({ ...base, content: '人間が直した\n' });
    const body = await h.call('practice_remove', { slug: 'review', base_version: v });
    expect(body).toContain('何も消していない');
    expect(body).toContain('その間に変わった');
    expect(body).toContain('practice_read slug=review');
    expect((await h.stores.practices.read('review'))?.content).toBe('人間が直した\n');
  });

  it('版なしの practice_remove は消さない。合う版なら消す。無い slug は従来どおり', async () => {
    const h = harness();
    await h.stores.practices.write(base);
    const none = await h.call('practice_remove', { slug: 'review' });
    expect(none).toContain('何も消していない');
    expect(await h.stores.practices.read('review')).not.toBeNull();
    const ok = await h.call('practice_remove', {
      slug: 'review',
      base_version: practiceVersion(base),
    });
    expect(ok).toContain('消した');
    expect(await h.stores.practices.read('review')).toBeNull();
    expect(await h.call('practice_remove', { slug: 'review' })).toContain('もともと無かった');
  });

  it('説明文に、先に読んで base_version を渡すこと・新規は版なしで通ることが書かれている', () => {
    const h = harness();
    for (const name of ['practice_write', 'practice_remove']) {
      const d = h.description(name);
      expect(d).toContain('base_version');
      expect(d).toContain('焼き込みの索引だけでは');
      expect(d).toContain('practice_read');
    }
    expect(h.description('practice_write')).toContain('新規作成は版なしで通る');
  });
});
