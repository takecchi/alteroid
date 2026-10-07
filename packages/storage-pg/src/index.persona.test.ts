import {
  MemoryConflictError,
  memoryVersion,
  renderMemoryDocuments,
  verifyPersonaNulContract,
} from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { memory } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('PgPersonaStore', () => {
  it('本文の NUL の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyPersonaNulContract(stores.persona);
  });

  describe('write の前提の版 ifMatch（Issue #2743。fs・pg・インメモリで同じ挙動）', () => {
    it('読んだ版と同じなら書ける。違えば書かずに MemoryConflictError（current は書かれている文書）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const read = await stores.persona.read('values');
      const v1 = memoryVersion(read?.content ?? '');
      await stores.persona.write('values', '# 価値観\n\nV1\n\nクローンの判断\n');

      const error = await stores.persona
        .write('values', '# 価値観\n\n人間の編集\n', { ifMatch: v1 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current?.content).toContain('クローンの判断');
      expect((await stores.persona.read('values'))?.content).toContain('クローンの判断');

      const latest = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const ok = await stores.persona.write('values', '# 価値観\n\n人間の編集\n', {
        ifMatch: latest,
      });
      expect(ok.content).toBe('# 価値観\n\n人間の編集\n');
    });

    it('null は「無かった」: 無ければ作れ、在れば書かない。在るものを null 前提で書かない', async () => {
      await stores.persona.write('values', '# A\n', { ifMatch: null });
      const error = await stores.persona
        .write('values', '# B\n', { ifMatch: null })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((await stores.persona.read('values'))?.content).toBe('# A\n');
    });

    it('文書が無いのに版を指定したら 409（current は null）。書かれない', async () => {
      const error = await stores.persona
        .write('values', '# B\n', { ifMatch: memoryVersion('# 昔あった\n') })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current).toBeNull();
      expect(await stores.persona.read('values')).toBeNull();
    });

    it('同じ版を前提にした2つの書き込みが重なっても、勝つのは1つだけ', async () => {
      await stores.persona.write('values', '# 価値観\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const results = await Promise.allSettled([
        stores.persona.write('values', '# 一\n', { ifMatch: v }),
        stores.persona.write('values', '# 二\n', { ifMatch: v }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('ifMatch を付けなければ従来どおり後勝ち（後方互換）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      await stores.persona.write('values', '# 価値観\n\nV2\n');
      await stores.persona.write('values', '# 価値観\n\nV3\n', {});
      expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n\nV3\n');
    });
  });

  describe('remove の前提の版 ifMatch（Issue #2881。fs・pg・インメモリで同じ挙動）', () => {
    it('読んだ後に別の書き手が書いたなら、消さずに MemoryConflictError（current は書かれている文書）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const v1 = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      await stores.persona.write('values', '# 価値観\n\nV1\n\nクローンの判断\n');

      const error = await stores.persona.remove('values', { ifMatch: v1 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current?.content).toContain('クローンの判断');
      expect((await stores.persona.read('values'))?.content).toContain('クローンの判断');
    });

    it('版が合えば消せる。無い文書に版を指定したら MemoryConflictError（current は null）', async () => {
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      await stores.persona.remove('values', { ifMatch: v });
      expect(await stores.persona.read('values')).toBeNull();

      const error = await stores.persona.remove('values', { ifMatch: v }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current).toBeNull();
    });

    it('同じ版を前提にした書き込みと削除が重なっても、勝つのは1つだけ', async () => {
      await stores.persona.write('values', '# 価値観\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const results = await Promise.allSettled([
        stores.persona.write('values', '# 一\n', { ifMatch: v }),
        stores.persona.remove('values', { ifMatch: v }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('ifMatch を付けなければ従来どおり無条件に消す（後方互換）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.remove('values');
      expect(await stores.persona.read('values')).toBeNull();
    });
  });

  it('書いて読める（記憶は Markdown のまま）', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
    expect(doc?.bytes).toBeGreaterThan(0);
  });

  it('外から書き換えられた記憶が次の読み出しに反映される（受け入れ基準3）', async () => {
    const BEFORE_CONTENT = '# 価値観\n\nもとの内容\n';
    await stores.persona.write('values', BEFORE_CONTENT);

    await stores.persona.write('values', '# 価値観\n\n人間が書き換えた\n');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    const cardBefore = renderMemoryDocuments([{ slug: 'values', content: BEFORE_CONTENT }]);
    const cardAfter = renderMemoryDocuments(await stores.persona.documents());
    expect(cardAfter).not.toBe(cardBefore);
    expect(cardAfter).toContain('# 価値観');
    expect(cardAfter).not.toContain('人間が書き換えた');
    expect(cardAfter).not.toContain('もとの内容');
  });

  it('write した本文は、末尾の改行が正規化されて読み戻る', async () => {
    const written = await stores.persona.write('values', '# 価値観');

    expect(written.content).toBe('# 価値観\n');
    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n');
  });

  it('append は末尾に足す（fs 版と同じ形）', async () => {
    await stores.persona.write('log', '# ログ\n');
    await stores.persona.append('log', '- 追記された学び\n');

    expect((await stores.persona.read('log'))?.content).toBe('# ログ\n\n- 追記された学び\n');
  });

  it('末尾の行が見出しの文書へ追記しても、その見出しの行が壊れない', async () => {
    await stores.persona.write('log', '# ログ\n\n## 最後の節');
    const doc = await stores.persona.append('log', '追記した1行');

    expect(doc.content.split('\n')).toContain('## 最後の節');
    expect(doc.content).toContain('追記した1行');
  });

  it('同時に追記しても取りこぼさない（蒸留は並行して同じ文書に書く）', async () => {
    await stores.persona.write('log', '# ログ\n');

    await Promise.all([
      stores.persona.append('log', '- AAA'),
      stores.persona.append('log', '- BBB'),
      stores.persona.append('log', '- CCC'),
    ]);

    const content = (await stores.persona.read('log'))?.content ?? '';
    expect(content).toContain('AAA');
    expect(content).toContain('BBB');
    expect(content).toContain('CCC');
  });

  it('存在しない記憶は null / 経路をまたぐスラッグは拒む', async () => {
    expect(await stores.persona.read('nope')).toBeNull();
    await expect(stores.persona.write('../escape', 'x')).rejects.toThrow(/スラッグ/);
  });

  it('documents は全文書を本文つき・slug 昇順で返す（fs 版と同じ形）', async () => {
    await stores.persona.write('b', '# B\n\nい\n');
    await stores.persona.write('a', '# A\n\nあ\n');

    const docs = await stores.persona.documents();

    expect(docs.map((d) => d.slug)).toEqual(['a', 'b']);
    expect(docs.map((d) => d.content)).toEqual(['# A\n\nあ\n', '# B\n\nい\n']);

    const all = renderMemoryDocuments(docs);

    expect(all).toContain('memory: a.md');
    expect(all).toContain('memory: b.md');
  });

  it('消せる', async () => {
    await stores.persona.write('tmp', '# 一時\n');
    await stores.persona.remove('tmp');

    expect(await stores.persona.read('tmp')).toBeNull();
  });

  describe('protectionStatus（保護状態の派生値）', () => {
    it('行そのものが無ければ unknown（守る側の既定）', async () => {
      expect(await stores.persona.protectionStatus('nope')).toEqual({ kind: 'unknown' });
    });

    it('markHumanTouched を呼んだ文書は human になる', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('write() だけの文書は clone-only になる（human 印が無い）', async () => {
      await stores.persona.write('values', '# 価値観\n');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
    });

    it('索引（content_sha256）が確定した後の write でも、ハッシュ更新は heal に頼らない', async () => {
      await stores.persona.write('values', '# 版1\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      await stores.persona.write('values', '# 版2\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });
    });

    it('append 経路でもハッシュが更新される（誤検出しない）', async () => {
      await stores.persona.write('log', '# ログ\n');
      await stores.persona.append('log', '- 追記');

      expect(await stores.persona.protectionStatus('log')).toEqual({ kind: 'clone-only' });
    });

    it('道具経由（write）の直後は unknown にならない', async () => {
      await stores.persona.write('values', '# 価値観\n\n本文\n');

      const status = await stores.persona.protectionStatus('values');

      expect(status).not.toEqual({ kind: 'unknown' });
      expect(status).toEqual({ kind: 'clone-only' });
    });

    it('外部から本文が変わったとき、保護状態が古いまま返らない（unknown になる）', async () => {
      await stores.persona.write('values', '# 価値観\n\nもとの内容\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      await db.execute(
        sql`update memory set content = '# 価値観\n\n外から書き換えた\n' where slug = 'values'`,
      );

      expect((await stores.persona.read('values'))?.content).toContain('外から書き換えた');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'unknown' });
    });

    it('human 印は外部編集があっても降りない（human が unknown より優先）', async () => {
      await stores.persona.write('values', '# 価値観\n\n人間が書いた\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      await db.execute(
        sql`update memory set content = '# 価値観\n\n外から書き換えた\n' where slug = 'values'`,
      );

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('markHumanTouched は降ろさない（古い時刻を渡しても human のまま）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', '2026-01-02T00:00:00.000Z');
      await stores.persona.markHumanTouched('values', '2020-01-01T00:00:00.000Z');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
    });

    it('remove() で保護状態も一緒に消える（実体の無い印を残さない）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.markHumanTouched('values', new Date().toISOString());

      await stores.persona.remove('values');

      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'unknown' });
    });

    it('markHumanTouched は削除済みの slug に行を作らない（空文字の「文書」を生まない）', async () => {
      await stores.persona.markHumanTouched('ghost', new Date().toISOString());

      expect(await stores.persona.read('ghost')).toBeNull();
      expect(await stores.persona.protectionStatus('ghost')).toEqual({ kind: 'unknown' });
    });
  });

  describe('createdAt（作成時刻の派生値）', () => {
    it('write() は新規作成のとき、backfill を通さずその場で created_at を known にする（updatedAt と一致）', async () => {
      const doc = await stores.persona.write('values', '# 価値観\n');

      const read = await stores.persona.read('values');

      expect(read?.createdAt).toEqual({ kind: 'known', at: doc.updatedAt });
      expect(read?.createdAt).toEqual({ kind: 'known', at: read?.updatedAt });
    });

    it('既存の文書を更新しても created_at は変わらない（updatedAt は進む）', async () => {
      const first = await stores.persona.write('values', '# 価値観\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await stores.persona.write('values', '# 価値観\n\n書き直した\n');

      expect(second.createdAt).toEqual(first.createdAt);
      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect((await stores.persona.read('values'))?.createdAt).toEqual(first.createdAt);
    });

    it('append() が文書を新規作成したときも created_at が付く', async () => {
      const doc = await stores.persona.append('notes', '最初のメモ');

      expect(doc.createdAt).toEqual({ kind: 'known', at: doc.updatedAt });
      expect((await stores.persona.read('notes'))?.createdAt).toEqual(doc.createdAt);
    });

    it('append() が既存の文書へ追記したときは created_at が変わらない', async () => {
      const first = await stores.persona.write('notes', '# ノート\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await stores.persona.append('notes', '追記した行');

      expect(second.createdAt).toEqual(first.createdAt);
      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect((await stores.persona.read('notes'))?.createdAt).toEqual(first.createdAt);
    });

    it('削除して同じ slug を作り直すと、新しい created_at になる', async () => {
      const first = await stores.persona.write('values', '# 価値観\n');
      await new Promise((resolve) => setTimeout(resolve, 10));

      await stores.persona.remove('values');
      const second = await stores.persona.write('values', '# 価値観\n\n書き直した\n');

      expect(second.createdAt.kind).toBe('known');
      expect(second.createdAt).not.toEqual(first.createdAt);
      expect((await stores.persona.read('values'))?.createdAt).toEqual(second.createdAt);
    });

    it('markCreatedAt を呼んだ文書は known になる（read() にも list() にも出る）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await db.execute(sql`update memory set created_at = null where slug = 'values'`);

      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
      const meta = (await stores.persona.list()).find((entry) => entry.slug === 'values');
      expect(meta?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });

    it('markCreatedAt は一度きりの確定——2回目は無視される（冪等・絶対条件2）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await db.execute(sql`update memory set created_at = null where slug = 'values'`);

      const first = await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');
      const second = await stores.persona.markCreatedAt('values', '2020-01-01T00:00:00.000Z');

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
    });

    it('同じ引数で2回走らせても結果は変わらない（backfill の再実行を模す）', async () => {
      await stores.persona.write('values', '# 価値観\n');
      await db.execute(sql`update memory set created_at = null where slug = 'values'`);

      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');
      await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

      expect((await stores.persona.read('values'))?.createdAt).toEqual({
        kind: 'known',
        at: '2026-01-02T03:04:05.000Z',
      });
    });

    it('markCreatedAt は削除済みの slug に行を作らない（空文字の「文書」を生まない）', async () => {
      const wrote = await stores.persona.markCreatedAt('ghost', new Date().toISOString());

      expect(wrote).toBe(false);
      expect(await stores.persona.read('ghost')).toBeNull();
    });

    it('markCreatedAt は createdAt 以外を1つも書き換えない', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'),
      );
      await db.execute(sql`update memory set created_at = null where slug = 'runbook'`);
      await stores.persona.markHumanTouched('runbook', '2020-01-01T00:00:00.000Z');
      const before = await stores.persona.read('runbook');
      const beforeProtection = await stores.persona.protectionStatus('runbook');

      await stores.persona.markCreatedAt('runbook', '2026-01-02T03:04:05.000Z');

      const after = await stores.persona.read('runbook');
      const afterProtection = await stores.persona.protectionStatus('runbook');
      expect(after?.content).toBe(before?.content);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.description).toBe(before?.description);
      expect(after?.kind).toBe(before?.kind);
      expect(after?.parent).toBe(before?.parent);
      expect(afterProtection).toEqual(beforeProtection);
      expect(before?.createdAt).toEqual({ kind: 'unknown' });
      expect(after?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });

    it('markCreatedAt は human 印を経由しない場合でも created_at 以外を書き換えない（describedAt 側）', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'),
      );
      await db.execute(sql`update memory set created_at = null where slug = 'runbook'`);

      const before = await stores.persona.read('runbook');
      const beforeProtection = await stores.persona.protectionStatus('runbook');
      expect(beforeProtection).toEqual({ kind: 'clone-only' });
      expect(before?.descriptionFreshness).toEqual({ kind: 'fresh' });
      expect(before?.createdAt).toEqual({ kind: 'unknown' });

      const wrote = await stores.persona.markCreatedAt('runbook', '2026-01-02T03:04:05.000Z');

      const after = await stores.persona.read('runbook');
      const afterProtection = await stores.persona.protectionStatus('runbook');
      expect(wrote).toBe(true);
      expect(after?.content).toBe(before?.content);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.description).toBe(before?.description);
      expect(afterProtection).toEqual(beforeProtection);
      expect(after?.descriptionFreshness).toEqual(before?.descriptionFreshness);
      expect(after?.createdAt).toEqual({ kind: 'known', at: '2026-01-02T03:04:05.000Z' });
    });

    it('markCreatedAt は content_sha256 の列を直接読んでも書き換えない（healRow を経由しない計器）', async () => {
      await stores.persona.write(
        'runbook',
        ['---', 'description: 手順', '---', '# 手順書', '', '本文'].join('\n'),
      );
      await db.execute(sql`update memory set created_at = null where slug = 'runbook'`);

      const beforeRows = await db
        .select({ contentSha256: memory.contentSha256 })
        .from(memory)
        .where(eq(memory.slug, 'runbook'));
      const beforeSha256 = beforeRows[0]?.contentSha256;
      expect(beforeSha256).not.toBeNull();

      const wrote = await stores.persona.markCreatedAt('runbook', '2026-01-02T03:04:05.000Z');

      // `protectionStatus()` を差し込まない: `#healRow` が列を埋め直し、変異が生存してこの歯が緑のまま何も測らなくなるため。
      const afterRows = await db
        .select({ contentSha256: memory.contentSha256 })
        .from(memory)
        .where(eq(memory.slug, 'runbook'));
      const afterSha256 = afterRows[0]?.contentSha256;

      expect(wrote).toBe(true);
      expect(afterSha256).toBe(beforeSha256);
    });
  });

  describe('describedAt（要旨の鮮度の派生値）', () => {
    it('description を書いた直後は fresh になる（describedAt === updatedAt）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'fresh' });
      expect(doc?.description).toBe('費用の推移');
      expect(doc?.kind).toBe('fact');
    });

    it('本文だけを書き直すと stale になる（description は本文の変更に追従しない）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.staleForMs).toBeGreaterThan(0);
      }
      expect(doc?.description).toBe('費用の推移');
    });

    it('stale になった後、description を書き直すと fresh に戻る', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );
      const staleDoc = await stores.persona.read('runbook');
      expect(staleDoc?.descriptionFreshness.kind).toBe('stale');
      if (staleDoc?.descriptionFreshness.kind === 'stale') {
        expect(staleDoc.descriptionFreshness.staleForMs).toBeGreaterThan(0);
      }

      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移（書き直した）\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      expect((await stores.persona.read('runbook'))?.descriptionFreshness).toEqual({
        kind: 'fresh',
      });
    });

    it('description を書かなければ absent のまま（premise の既定と同じ安全側）', async () => {
      await stores.persona.write('about-me', '# 私\n\n前提の本文\n');

      const doc = await stores.persona.read('about-me');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'absent' });
      expect(doc?.kind).toBe('premise');
    });

    it('append でも describedAt が更新される（write と同じ通り道を通る）', async () => {
      await stores.persona.write(
        'log',
        '---\ndescription: 学びの記録\ntype: fact\n---\n# ログ\n最初の行\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.append('log', '追記した行');

      const doc = await stores.persona.read('log');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.staleForMs).toBeGreaterThan(0);
      }
    });
  });

  describe('describedBytes（本文の変化量の派生値、#913）', () => {
    it('要旨を書いた直後は drift の deltaBytes が厳密に0（describedBytes と bytes の測り方が揃っている）', async () => {
      const written = await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness).toEqual({ kind: 'fresh' });
      expect(doc?.bytes).toBe(written.bytes);
    });

    it('append の後、describedAt/describedBytes は据え置きで、deltaBytes は追記したバイト数と一致する', async () => {
      const before = await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n本文\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const appended = '追記した1行';
      await stores.persona.append('runbook', appended);

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.drift).toEqual({
          kind: 'measured',
          describedBytes: before.bytes,
          currentBytes: doc.bytes,
          deltaBytes: doc.bytes - before.bytes,
        });
        if (doc.descriptionFreshness.drift.kind === 'measured') {
          expect(doc.descriptionFreshness.drift.deltaBytes).toBeGreaterThanOrEqual(
            Buffer.byteLength(appended, 'utf8'),
          );
        }
      }
    });

    it('described_at はあるが described_bytes が無い既存の行は unrecorded になり、deltaBytes: 0 にならない', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      const before = await stores.persona.read('runbook');
      expect(before?.descriptionFreshness.kind).toBe('stale');
      if (before?.descriptionFreshness.kind === 'stale') {
        expect(before.descriptionFreshness.drift.kind).toBe('measured');
      }

      await db.execute(sql`update memory set described_bytes = null where slug = 'runbook'`);

      const doc = await stores.persona.read('runbook');
      expect(doc?.descriptionFreshness.kind).toBe('stale');
      if (doc?.descriptionFreshness.kind === 'stale') {
        expect(doc.descriptionFreshness.drift).toEqual({ kind: 'unrecorded' });
      }
    });

    it('described_bytes が無い既存の行へ append すると、その場で基準点が立ち drift が at-least になる（deltaBytes は0にならない、#821 残課題）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );

      await db.execute(
        sql`update memory set described_bytes = null, described_bytes_at = null where slug = 'runbook'`,
      );

      const before = await stores.persona.read('runbook');
      expect(before?.descriptionFreshness.kind).toBe('stale');
      if (before?.descriptionFreshness.kind === 'stale') {
        expect(before.descriptionFreshness.drift).toEqual({ kind: 'unrecorded' });
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
      const appended = '基準点を立てるための追記';
      await stores.persona.append('runbook', appended);

      const after = await stores.persona.read('runbook');
      expect(after?.descriptionFreshness.kind).toBe('stale');
      if (after?.descriptionFreshness.kind === 'stale') {
        expect(after.descriptionFreshness.drift.kind).toBe('at-least');
        if (after.descriptionFreshness.drift.kind === 'at-least') {
          expect(after.descriptionFreshness.drift.deltaBytes).not.toBe(0);
          expect(after.descriptionFreshness.drift.deltaBytes).toBeGreaterThanOrEqual(
            Buffer.byteLength(appended, 'utf8'),
          );
        }
      }
    });

    it('一度立った基準点は、2回目の append で動かない（#821 残課題、pg）', async () => {
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版1\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.write(
        'runbook',
        '---\ndescription: 費用の推移\ntype: fact\n---\n# 定点観測\n版2（本文だけ変えた）\n',
      );
      await db.execute(
        sql`update memory set described_bytes = null, described_bytes_at = null where slug = 'runbook'`,
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.append('runbook', '1回目の追記');
      const afterFirst = await stores.persona.read('runbook');
      expect(afterFirst?.descriptionFreshness.kind).toBe('stale');
      if (afterFirst?.descriptionFreshness.kind !== 'stale') throw new Error('unreachable');
      expect(afterFirst.descriptionFreshness.drift.kind).toBe('at-least');
      if (afterFirst.descriptionFreshness.drift.kind !== 'at-least') throw new Error('unreachable');
      const firstBaselineBytes = afterFirst.descriptionFreshness.drift.baselineBytes;
      const firstBaselineAt = afterFirst.descriptionFreshness.drift.baselineAt;

      await new Promise((resolve) => setTimeout(resolve, 5));
      await stores.persona.append('runbook', '2回目の追記');
      const afterSecond = await stores.persona.read('runbook');
      expect(afterSecond?.descriptionFreshness.kind).toBe('stale');
      if (afterSecond?.descriptionFreshness.kind !== 'stale') throw new Error('unreachable');
      expect(afterSecond.descriptionFreshness.drift.kind).toBe('at-least');
      if (afterSecond.descriptionFreshness.drift.kind !== 'at-least')
        throw new Error('unreachable');
      expect(afterSecond.descriptionFreshness.drift.baselineBytes).toBe(firstBaselineBytes);
      expect(afterSecond.descriptionFreshness.drift.baselineAt).toBe(firstBaselineAt);
      expect(afterSecond.descriptionFreshness.drift.deltaBytes).toBeGreaterThan(
        afterFirst.descriptionFreshness.drift.deltaBytes,
      );
    });
  });
});
