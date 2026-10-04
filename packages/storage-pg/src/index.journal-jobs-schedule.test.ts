import {
  captureStderr,
  createManagerPool,
  createRunnerRegistry,
  scanJournalPages,
  verifyCommitmentFoldContract,
  verifyJournalStoreHorizonContract,
  verifyJournalStoreOrderContract,
  verifyJournalStorePageContract,
  verifyJournalStoreQueryEdgeContract,
  verifyJournalStoreSearchContract,
  verifyJournalStoreWithContract,
  verifyPermissionGrantStoreContract,
  verifyPracticeStoreContract,
  verifyStoreIsolationContract,
} from '@alteroid/core';
import type { Job, JournalEntry, ManagerSummary } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, seedPgWorkspace, type PgStores } from './index.js';
import { jobs as jobsTable, journal as journalTable } from './schema.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * pg ドライバの受け入れ確認。
 *
 * **偽物の DB では確かめたことにならない。** PGlite はインプロセスで動く実
 * PostgreSQL なので、SQL・索引・冪等性まで本番と同じ経路で通る（CI に外部 DB を
 * 要求せずに済む）。fs ドライバのテストと同じ振る舞いを、同じ IF に対して問う。
 *
 * **このファイルは `index.test.ts` から移した（分割元は git blame で辿れる）。**
 * 元の1本（5588行・262テスト）は単独で走らせると 564.75s かかり、作業者の
 * Bash の既定タイムアウト（300s）に収まらなかった（2026-09-29 実測、
 * `.claude/skills/test-in-chunks/SKILL.md`）。`vitest --shard` はファイル数で
 * 等分するので、1本のままでは分割にならない——だから最上位の `describe`
 * 単位でファイルを分けた。ここは `migrate` / `seedPgWorkspace` /
 * `PgJournalStore` / `PgJobStore` / `PgPermissionGrantStore` /
 * `PgScheduleStore`、および journal の entry 列の重複防止（#1311）を持つ
 * （この最後の1本は元ファイルでは末尾（`AuthStore` の後）に置かれていたが、
 * 内容は journal store の話なのでここへまとめた）。**`describe` / `it` の
 * 本文・順序は1文字も変えていない**——元ファイルの対応する範囲とこのファイルを
 * 突き合わせれば同一であることが確認できる。冒頭の足場（`beforeEach` で
 * PGlite を都度立てて `migrate` する形、`afterEach` で閉じる形）も元ファイルと
 * 同じものを複製している（分岐は生まない——共有モジュールへ切り出すほどの
 * 複雑さが無かったため、各ファイルへ同じ短い足場を複製する側を選んだ）。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('migrate', () => {
  it('二度通しても壊れない（起動のたびに走る）', async () => {
    await stores.persona.write('values', '# 価値観\n');
    await migrate(db);

    expect((await stores.persona.read('values'))?.content).toContain('価値観');
  });

  it('既にある DB へ当て直しても、記録済みの位相を消さない', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });
    await migrate(db);

    expect((await stores.schedules.getPhase('self_initiative'))?.lastScheduledRunAt).toBe(
      '2026-08-12T01:00:00.000Z',
    );
  });

  it('created_at 列の追加は加算のみ・冪等（記憶の絶対条件6）——値を消さず二度通しても壊れない', async () => {
    await stores.persona.write('values', '# 価値観\n');
    // write() 自身が新規作成時に created_at を入れるようになったため
    // （記憶の createdAt 対応）、markCreatedAt が実際に値を立てる場面を
    // 見るには、一度 null に戻してから呼ぶ必要がある。
    await db.execute(sql`update memory set created_at = null where slug = 'values'`);
    await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

    await migrate(db);
    await migrate(db);

    expect((await stores.persona.read('values'))?.createdAt).toEqual({
      kind: 'known',
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  /**
   * archive の tombstone 列（`removed_at` / `removed_bytes`。#698）の追加は
   * 2回通しても壊れない。
   *
   * **⚠️ 同じ入り口を2回呼ぶだけでは測ったことにならない**（AGENTS.md
   * 「2回通しても壊れないを測るテストは…『2周目でだけ壊れる状態』を挟む
   * こと」）——1周目（`beforeEach` の `migrate(db)`）の後に**実際に行を積み、
   * `remove()` を呼んでから**2周目を当てる。tombstone された行・していない
   * 行の両方が、2周目のあとも壊れていないことを見る。
   */
  it('archive の tombstone 列の追加は2回通しても壊れない（1周目の後に remove() してから2周目を当てる）', async () => {
    const removedId = (await stores.archive.archive('session-migrate-twice-removed', 'BODY\n')).id;
    const removed = await stores.archive.remove(removedId);
    expect(removed.kind).toBe('removed');

    // 2周目——tombstone された行が実在する状態で当てる。
    await migrate(db);

    // 消した行の状態が壊れていない。
    expect(await stores.archive.read(removedId)).toMatchObject({ kind: 'removed' });

    // 消していない行も、2周目のあとに積んでも壊れていない。
    const untouchedId = (await stores.archive.archive('session-migrate-twice-untouched', 'OTHER\n'))
      .id;
    expect(await stores.archive.read(untouchedId)).toEqual({ kind: 'body', body: 'OTHER\n' });
  });
});

describe('seedPgWorkspace', () => {
  it('記憶が空なら種を1枚だけ置く', async () => {
    expect(await seedPgWorkspace(stores)).toBe(true);
    expect(await stores.persona.list()).toHaveLength(1);
  });

  it('既にある記憶は上書きしない（人間の編集を消さない）', async () => {
    await stores.persona.write('about-me', '# 私\n\n手で書いた内容\n');

    expect(await seedPgWorkspace(stores)).toBe(false);
    expect((await stores.persona.read('about-me'))?.content).toContain('手で書いた内容');
  });
});

describe('PgJournalStore', () => {
  it('追記して新しい順に読める', async () => {
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '最初',
    });
    await stores.journal.append({
      type: 'decision',
      decision: '自分で答えた',
      grounds: 'about-me.md にそう書いてある',
    });

    const entries = await stores.journal.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe('decision');
    expect(entries[1]?.type).toBe('exchange');
  });

  it('type と limit で絞れる', async () => {
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'a' });
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'outbound', text: 'b' });
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(1);
    expect(await stores.journal.list({ limit: 2 })).toHaveLength(2);
  });

  it('since で絞れる', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await stores.journal.list({ since: future })).toHaveLength(0);
    expect(await stores.journal.list({ since: '2020-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('until で絞れる（since と組めば過去の一区間だけ取れる）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    const past = '2020-01-01T00:00:00.000Z';
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await stores.journal.list({ until: past })).toHaveLength(0);
    expect(await stores.journal.list({ until: future })).toHaveLength(1);
    expect(await stores.journal.list({ since: past, until: future })).toHaveLength(1);
  });

  it('id で1件引ける（一覧を抜粋にした先の全文の行き先）', async () => {
    const entry = await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.get(entry.id)).toMatchObject({ id: entry.id, decision: 'd' });
    expect(await stores.journal.get('no-such-id')).toBeNull();
  });

  it('同じミリ秒に並んでも追記順が保たれる（日報が順番を失わない）', async () => {
    // 直列に積む。`at` で並べ替える実装に退行すると、同一ミリ秒の分が入れ替わる。
    for (let i = 0; i < 20; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `t${i}`,
      });
    }

    const entries = await stores.journal.list();
    const texts = entries.map((entry) => (entry as { text: string }).text);

    expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => `t${19 - i}`));
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(20);
  });

  it('NUL を含む記録も残す（PostgreSQL は NUL を受け付けない）', async () => {
    // マネージャー・作業者の全ツール実行を落とす以上、バイナリ由来の NUL は来る。
    // ここで挿入ごと落ちると、fs なら残る記録が pg では静かに消える。
    await stores.journal.append({
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Bash',
      input: { command: 'cat /dev/urandom', output: 'a\u0000b' },
    });

    const [entry] = await stores.journal.list({ types: ['tool_use'] });

    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('\u0000');
    expect(JSON.stringify(entry)).toContain('ab');
  });

  /**
   * **回帰: `input` を持たない `tool_use` エントリが、jsonb への直列化を挟むと
   * 跡形もなく消える（#223 と同じ形。日誌エントリ版。Issue #224）。**
   *
   * `append()` に渡すオブジェクトは `input` というキーを値 `undefined` として
   * 持つ（キーは在る）ので、書き込み時の `journalEntrySchema.parse` は通る。
   * しかし pg 版は `stripNulls(entry)` を経て `jsonb` 列へ入れる（`db.insert`）
   * ——値が `undefined` のキーはここで丸ごと落ちる。読み出し時は `journal.entry`
   * 列を `journalEntrySchema.safeParse` に通す（`list`）ので、`input` が必須の
   * ままだと zod 4 の「キーの不在を許さない」規則に引っかかって落ち、**この行が
   * `list()` の結果から丸ごと消える**（`createMemoryStores` は直列化しないので、
   * この壊れ方を再現できない）。
   */
  it('input の無い tool_use エントリが、jsonb への直列化を挟んでも読み出せる（回帰）', async () => {
    const written = await stores.journal.append({
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Bash',
    });

    const entries = await stores.journal.list({ types: ['tool_use'] });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: written.id, actor: 'manager:mgr-1', tool: 'Bash' });
    expect((entries[0] as { input?: unknown }).input).toBeUndefined();
  });

  /**
   * **回帰（静かなほう）: `input` というキーが在って値が `undefined` の形。**
   *
   * これが実機で通る形である —— `manager.ts` の `case 'tool_use'` は
   * `input: event.input` と**必ずキーを書く**ので、`event.input` が
   * `undefined` でも「キーは在る」状態で `append()` へ来る。
   *
   * **上のテストとは壊れ方が違う。** キー自体を書かない形は、`input` が必須の
   * ままだと `append()` の `journalEntrySchema.parse` がその場で投げる（大きな
   * 音がする）。こちらは**書き込みが通ってしまう** —— zod は「キーが在って値が
   * `undefined`」を通すからである。pg 版は `jsonb` 列へ入れるので、直列化でキーが落ち、
   * **読み出しで初めて落ちて、その行が `list()` から黙って消える。**
   * 跡は残らない（Issue #224）。**silent なのはこちらだけなので、この歯を
   * 消さないこと。**
   */
  it('input のキーが在って値が undefined でも、直列化を挟んで読み出せる（回帰・静かなほう）', async () => {
    const written = await stores.journal.append({
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Bash',
      input: undefined,
    });

    const entries = await stores.journal.list({ types: ['tool_use'] });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: written.id, actor: 'manager:mgr-1', tool: 'Bash' });
  });

  /**
   * **スキーマに合わない行を「飛ばすが、跡は残す」（Issue #224）。**
   *
   * fs 版と同じ道具（`journalRowType` / `noteDroppedJournalRow` /
   * `noteDroppedJournalRowsSummary`。`packages/core/src/dropped-record.ts`）を
   * `list()` / `get()` の両方が呼ぶ——**扱いを変えない。**
   *
   * 生 SQL でスキーマ検証を経由せず insert する（`PgCommitmentStore` の
   * 「未知の origin」テストと同じ手口——`append()` 経由では
   * `journalEntrySchema.parse` を通ってしまい、壊れた行をそもそも作れない）。
   */
  describe('スキーマに合わない行の跡（Issue #224）', () => {
    const secret = 'ghp_000000000000000000000000000000000000';

    it('list(): スキーマに合わない行を跡に残しつつ、読めた行はそのまま返る', async () => {
      await stores.journal.append({ type: 'decision', decision: '健全な行', grounds: 'g' });

      await db.execute(
        sql`insert into journal (id, at, type, entry)
            values (
              'broken-1',
              '2026-08-12T00:00:00.000Z',
              'future-type',
              ${JSON.stringify({
                type: 'future-type',
                id: 'broken-1',
                at: '2026-08-12T00:00:00.000Z',
                leakedBody: `秘密は ${secret} だった`,
              })}::jsonb
            )`,
      );

      let entries: JournalEntry[] = [];
      const lines = await captureStderr(async () => {
        entries = await stores.journal.list();
      });

      // 1. 読めた行（健全な1件）は今までどおり返る——回帰。
      expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual([
        '健全な行',
      ]);

      // 2. 跡が stderr に出る。type は安全に取れるので載る。
      const joined = lines.join('');
      expect(joined).toContain('日誌の行を読み出せずに飛ばした');
      expect(joined).toContain('type=future-type');

      // 3. **本文は跡に混ざらない。**
      expect(joined).not.toContain(secret);
    });

    it('get(): スキーマに合わない行なら、跡を残して null を返す（無いのではなく読めない）', async () => {
      await db.execute(
        sql`insert into journal (id, at, type, entry)
            values (
              'broken-1',
              '2026-08-12T00:00:00.000Z',
              'future-type',
              ${JSON.stringify({
                type: 'future-type',
                id: 'broken-1',
                at: '2026-08-12T00:00:00.000Z',
                leakedBody: `秘密は ${secret} だった`,
              })}::jsonb
            )`,
      );

      let found: JournalEntry | null = null;
      const lines = await captureStderr(async () => {
        found = await stores.journal.get('broken-1');
      });

      // `id` は在るが読めない——今までどおり null（`JournalStore.get` の
      // 契約は変えない。存在の有無は id 列で判定できるが、それは別の話）。
      expect(found).toBeNull();
      const joined = lines.join('');
      expect(joined).toContain('type=future-type');
      expect(joined).not.toContain(secret);
    });

    it('get(): 読めた行は跡を残さずそのまま返る（回帰）', async () => {
      const written = await stores.journal.append({
        type: 'decision',
        decision: '探している行',
        grounds: 'g',
      });

      let found: JournalEntry | null = null;
      const lines = await captureStderr(async () => {
        found = await stores.journal.get(written.id);
      });

      expect(found).toMatchObject({ id: written.id, decision: '探している行' });
      expect(lines).toHaveLength(0);
    });

    /**
     * **跡でログを埋めない。** 壊れた行が大量にあるとき、同じ種別なら初出の
     * 1行だけがその場で出て、量は呼び出しの終わりで1行にまとまる。
     */
    it('同じ種別の行が大量にあっても、初出は1行だけ・量は呼び出しの終わりに1行でまとまる', async () => {
      for (let i = 0; i < 20; i += 1) {
        await db.execute(
          sql`insert into journal (id, at, type, entry)
              values (
                ${`broken-${i}`},
                '2026-08-12T00:00:00.000Z',
                'future-type',
                ${JSON.stringify({
                  type: 'future-type',
                  id: `broken-${i}`,
                  at: '2026-08-12T00:00:00.000Z',
                })}::jsonb
              )`,
        );
      }

      const lines = await captureStderr(async () => {
        await stores.journal.list();
      });

      const firstLines = lines.filter((line) => line.includes('初出'));
      expect(firstLines).toHaveLength(1);
      const summaryLines = lines.filter((line) => line.includes('合計'));
      expect(summaryLines).toHaveLength(1);
      expect(summaryLines[0]).toContain('unknown-shape:future-type×20');
      expect(lines).toHaveLength(2);
    });
  });

  /**
   * `JournalStore` の `with` 絞りの契約（issue #418）を、**pg 実装
   * （PGlite = インプロセスの実 PostgreSQL）**に対して測る。同じ形の歯が
   * 3つ在る——インメモリ（`packages/core/src/journal-with-contract.test.ts`）
   * / fs（`packages/storage-fs/src/index.test.ts`）/ pg（このテスト）。1つで
   * 測って3つとも測ったことにしない（#370 と同じ作法）。
   */
  describe('with 契約（issue #418）', () => {
    it('未指定=絞らない／指定=その with だけ／[]=0件／limit より前に効く', async () => {
      await verifyJournalStoreWithContract(stores.journal);
    });

    /**
     * **契約4（limit より前に効く）を、pg の実クエリに対して直接再現する。**
     * `entry ->> 'with'` の式索引（`schema.ts` の `journal_exchange_with_seq_idx`）
     * を使った `where` が `.limit()` より前に効いているかを、実際に PGlite へ
     * 投げて確かめる。**「絞りが効いている」ではなく「窓に食われない」を測る**
     * （`scan` を症状が出るほど小さくし、manager の行を `scan` より多く積む）。
     */
    it('manager の往復を scan より多く積んでも、human の発言は窓に食われない', async () => {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: '人間の質問',
        conversationId: 'conv-1',
      });
      for (let i = 0; i < 10; i += 1) {
        await stores.journal.append({
          type: 'exchange',
          with: i % 2 === 0 ? 'manager' : 'self',
          role: 'inbound',
          text: `noise-${i}`,
        });
      }

      const entries = await stores.journal.list({
        limit: 3,
        types: ['exchange'],
        with: ['human'],
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ with: 'human', text: '人間の質問' });
    });
  });

  /**
   * `JournalStore` の `order` / `after` 契約（issue #432 の2本目）を、
   * **pg 実装（PGlite = インプロセスの実 PostgreSQL）**に対して測る。同じ形の
   * 歯が3つ在る——インメモリ
   * （`packages/core/src/journal-order-with-contract.test.ts`）/ fs
   * （`packages/storage-fs/src/index.test.ts`）/ pg（このテスト）。1つで
   * 測って3つとも測ったことにしない（#418 / with 契約と同じ作法）。
   */
  describe('order/after 契約（issue #432 の2本目）', () => {
    it('order 未指定=desc／asc は正確な逆順／after は絞り・limit より前に効く／同着を飛ばさない', async () => {
      await verifyJournalStoreOrderContract(stores.journal);
    });

    it('畳み込みの契約（#1041。3実装で同じことを測る。⚠ 名乗れるのはプロセス内で原子であることまで）', async () => {
      await verifyCommitmentFoldContract(stores.commitments);
    });

    it('ストアが返す値は書いた側の握りと別物である（#1072。3実装で同じことを測る）', async () => {
      await verifyStoreIsolationContract(stores);
    });

    it('やり方の器の契約（#1055 段3。3実装で同じことを測る）', async () => {
      await verifyPracticeStoreContract(stores.practices, { verifyClear: true });
    });
  });

  /**
   * `JournalQuery` の退化した値（`types: []` / `limit: 0`）の契約
   * （issue #425）を、**pg 実装（PGlite = インプロセスの実 PostgreSQL）**に
   * 対して測る。同じ形の歯が3つ在る——インメモリ
   * （`packages/core/src/journal-query-edge-contract.test.ts`）/ fs
   * （`packages/storage-fs/src/index.test.ts`）/ pg（このテスト）。1つで
   * 測って3つとも測ったことにしない（`with` 契約 / `order` 契約と同じ作法）。
   *
   * **pg だけが持っていた壊れ方**: `types` の絞りだけが
   * `query.types.length === 0` を特別扱いして「絞らない」に倒していた
   * （`journal.ts` の `with` の行はこの特別扱いを持たない）。
   */
  /**
   * **読めない行が `LIMIT` の後で捨てられる実 SQL（PGlite）での、続きの言い方**
   * （Issue #2604 / #2605）。`list()` は 500 件を求めて 499 件、または 0 件で返る
   * ことがあり、そのどちらも「先に行が無い」ではない。
   */
  describe('listPage: 読めない行と頁の境界（Issue #2604 / #2605）', () => {
    /** seq は挿入順。`broken` は schema に合わない種別（未知の版の行）。 */
    async function insertRows(rows: readonly { id: string; broken?: true }[]): Promise<void> {
      for (const [index, row] of rows.entries()) {
        const at = new Date(Date.UTC(2026, 7, 1, 0, 0, index));
        await db.insert(journalTable).values(
          row.broken === true
            ? { id: row.id, at, type: 'future-type', entry: { leaked: 'x' } }
            : {
                id: row.id,
                at,
                type: 'decision',
                entry: { decision: row.id, grounds: 'g' },
              },
        );
      }
    }
    const ids = (entries: readonly JournalEntry[]): string[] => entries.map((e) => e.id);

    it('頁の途中に読めない行があると、entries は短いが next は先の行を指す', async () => {
      await insertRows([{ id: 'g0' }, { id: 'g1' }, { id: 'b2', broken: true }, { id: 'g3' }]);

      // desc の生の頁は [g3, b2]。b2 が捨てられて entries は 1 件だが、g1・g0 が先に在る。
      const page = await stores.journal.listPage({ limit: 2 });

      expect(ids(page.entries)).toEqual(['g3']);
      expect(page.next).toEqual({ id: 'b2', at: '2026-08-01T00:00:02.000Z' });
    });

    it('頁が丸ごと読めなくても entries は空で next が先を指し、next から古い行へ届く', async () => {
      await insertRows([
        { id: 'g0' },
        { id: 'b1', broken: true },
        { id: 'b2', broken: true },
        { id: 'g3' },
      ]);

      const first = await stores.journal.listPage({ limit: 1 });
      expect(ids(first.entries)).toEqual(['g3']);
      expect(first.next?.id).toBe('g3');

      // 生の頁は [b2, b1] で全部読めない。空だが終端ではない。
      const second = await stores.journal.listPage({ limit: 2, after: first.next! });
      expect(second.entries).toEqual([]);
      expect(second.next).toEqual({ id: 'b1', at: '2026-08-01T00:00:01.000Z' });

      // 継続点（捨てた行）は after の錨として引ける。その先に g0 が在る。
      const third = await stores.journal.listPage({ limit: 2, after: second.next! });
      expect(ids(third.entries)).toEqual(['g0']);
      expect(third.next).toBeNull();
    });

    it('本当の終端: 末尾（最古）の読めない行だけが残っているなら next は null', async () => {
      await insertRows([{ id: 'b0', broken: true }, { id: 'g1' }]);

      const page = await stores.journal.listPage({ limit: 2 });

      expect(ids(page.entries)).toEqual(['g1']);
      expect(page.next).toBeNull();
    });

    it('list() は従来どおり（読めた行だけを返す）', async () => {
      await insertRows([{ id: 'g0' }, { id: 'b1', broken: true }, { id: 'g2' }]);

      expect(ids(await stores.journal.list({ limit: 2 }))).toEqual(['g2']);
      expect(ids(await stores.journal.list())).toEqual(['g2', 'g0']);
    });

    it('scanJournalPages: 頁が丸ごと読めなくても、その先の古い行まで読み、探し切ったと言う', async () => {
      await insertRows([
        { id: 'g0' },
        { id: 'g1' },
        { id: 'b2', broken: true },
        { id: 'b3', broken: true },
        { id: 'g4' },
      ]);
      const seen: string[] = [];

      const result = await scanJournalPages(
        stores.journal,
        {},
        (page) => {
          seen.push(...page.map((e) => e.id));
        },
        { pageSize: 2 },
      );

      // 頁は [g4, b3] / [b2, g1] / [g0]。b2 と b3 が別の頁の端でも先を取りこぼさない。
      expect(seen).toEqual(['g4', 'g1', 'g0']);
      expect(result).toEqual({ scanned: 3, truncated: false });
    });

    it('scanJournalPages: 頁が全部読めない行の区間を越えて、古い行に届く', async () => {
      await insertRows([
        { id: 'g0' },
        { id: 'b1', broken: true },
        { id: 'b2', broken: true },
        { id: 'g3' },
        { id: 'g4' },
      ]);
      const seen: string[] = [];

      const result = await scanJournalPages(
        stores.journal,
        {},
        (page) => {
          seen.push(...page.map((e) => e.id));
        },
        { pageSize: 2 },
      );

      // desc の頁は [g4, g3] / [b2, b1]（丸ごと読めない）/ [g0]。空の頁で打ち切ると g0 を逃す。
      expect(seen).toEqual(['g4', 'g3', 'g0']);
      expect(result).toEqual({ scanned: 3, truncated: false });
    });
  });

  describe('listPage 契約（Issue #2604 / #2605）', () => {
    it('entries は list() と同じ／next は本当に先が在るときだけ／next で全件を過不足なく読める', async () => {
      await verifyJournalStorePageContract(stores.journal);
    });
  });

  describe('query edge 契約（issue #425）', () => {
    it('types: []=0件／limit: 0=0件／types 未指定=絞らない／指定=その種別だけ／limit:N(N>=1)はN件で切る／同時指定でも0件', async () => {
      await verifyJournalStoreQueryEdgeContract(stores.journal);
    });
  });

  /**
   * `JournalStore.oldestAt()`（日誌の地平。issue #1510）の契約を、**pg
   * 実装**に対して測る。同じ形の歯が3つ在る——インメモリ
   * （`packages/core/src/journal-horizon-contract.test.ts`）/ fs
   * （`packages/storage-fs/src/index.test.ts`）/ pg（このテスト）。1つで
   * 測って3つとも測ったことにしない（`with` 契約 / `order` 契約 /
   * `query edge` 契約と同じ作法）。
   *
   * pg 実装は `journal_at_idx` に乗る `ORDER BY at ASC LIMIT 1` なので、
   * テーブルの行数に依存しない——ここでは答えが正しいことを測る
   * （索引が実際に使われているかは実行計画の確認が要り、ここでは見ていない）。
   */
  describe('日誌の地平（issue #1510）', () => {
    it('空なら null／1件ならその at／複数件でも最古のまま', async () => {
      await verifyJournalStoreHorizonContract(stores.journal);
    });
  });

  /**
   * `JournalStore` の `q`（本文を語で探す）の契約（issue #250）を、**pg
   * 実装**に対して測る。同じ形の歯が3つ在る——インメモリ
   * （`packages/core/src/journal-search-contract.test.ts`）/ fs
   * （`packages/storage-fs/src/index.test.ts`）/ pg
   * （このファイル、`packages/storage-pg/src/index.journal-jobs-schedule.test.ts`）。
   * 1つで測って3つとも測ったことにしない（`with` 契約 / `order` 契約 / `query edge` 契約と同じ作法）。
   *
   * **pg だけが持ちうる壊れ方**: `ILIKE` のパターンで `%` / `_` を
   * エスケープし忘れると、`q: '50%'` が全件を返す（契約4）。fs /
   * インメモリでは素の部分一致なので、この穴はこの実装にしか開かない。
   */
  describe('q 契約（issue #250）', () => {
    it('未指定=絞らない／部分一致／大文字小文字を区別しない／%_ はワイルドカードでない／""=絞らない／limit より前に効く', async () => {
      await verifyJournalStoreSearchContract(stores.journal);
    });
  });
});

describe('PgJobStore', () => {
  it('ジョブを積んで session_id ごと読み戻せる（再起動後の resume の足がかり）', async () => {
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-1',
      managerId: 'mgr-1',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '依頼',
      request: '依頼の全文',
      cwd: '/work',
      sessionId: 'sess-abc',
    });

    const [job] = await stores.jobs.listJobs();

    expect(job?.sessionId).toBe('sess-abc');
    expect(job?.status).toBe('running');
  });

  it('同じジョブ id は上書きされる', async () => {
    const now = new Date().toISOString();
    const base = {
      id: 'mgr-1',
      createdAt: now,
      updatedAt: now,
      status: 'running' as const,
      summary: 's',
    };
    await stores.jobs.putJob(base);
    await stores.jobs.putJob({ ...base, status: 'done', lastReport: '終わった' });

    const jobs = await stores.jobs.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('done');
    expect(jobs[0]?.lastReport).toBe('終わった');
  });

  it('承認待ちを積んで回答できる', async () => {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これをやってよいか',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-1');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      answeredAt: new Date().toISOString(),
      answer: 'よい',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
  });

  // #963: withdrawn_at 列（answered_at と対の派生列）が pendingOnly の絞り込みに
  // 効くこと。fs / インメモリと同じ契約（`packages/storage-fs/src/index.test.ts`
  // の同名テスト）。
  it('取り下げた承認待ちは pendingOnly から消えるが、getApproval では理由ごと読める', async () => {
    await stores.jobs.putApproval({
      id: 'ap-withdraw',
      createdAt: new Date().toISOString(),
      question: 'これをやってよいか',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-withdraw');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '自分で答えを見つけた',
    });

    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
    expect((await stores.jobs.listApprovals()).entries).toHaveLength(1);
    const after = await stores.jobs.getApproval('ap-withdraw');
    expect(after?.withdrawnReason).toBe('自分で答えを見つけた');
  });

  /**
   * **`listJobs` もスキーマに合わない行を「飛ばすが、跡は残す」（Issue #224）。**
   *
   * `PgJournalStore#list` の「スキーマに合わない行の跡」テストと同じ道具・
   * 同じ手口（生 SQL で `jobSchema.parse` を経由せず挿入する）で揃える。
   * `Job` は判別子の `type` を持たないので、`journalRowType` は
   * `undefined` を返し跡の見分けは `unknown-shape`（type 無し）1本になる。
   */
  describe('スキーマに合わない行の跡（Issue #224）', () => {
    const secret = 'ghp_000000000000000000000000000000000000';

    it('listJobs(): スキーマに合わない行を跡に残しつつ、読めた行はそのまま返る', async () => {
      const now = new Date().toISOString();
      await stores.jobs.putJob({
        id: 'mgr-ok',
        createdAt: now,
        updatedAt: now,
        status: 'running',
        summary: '健全な行',
      });

      await db.execute(
        sql`insert into jobs (id, status, created_at, updated_at, job)
            values (
              'broken-1',
              'future-status',
              '2026-08-12T00:00:00.000Z',
              '2026-08-12T00:00:00.000Z',
              ${JSON.stringify({
                id: 'broken-1',
                status: 'future-status',
                createdAt: '2026-08-12T00:00:00.000Z',
                updatedAt: '2026-08-12T00:00:00.000Z',
                request: `秘密は ${secret} だった`,
              })}::jsonb
            )`,
      );

      let found: Job[] = [];
      const lines = await captureStderr(async () => {
        found = await stores.jobs.listJobs();
      });

      // 1. 読めた行（健全な1件）は今までどおり返る——回帰。
      expect(found.map((job) => job.summary)).toEqual(['健全な行']);

      // 2. 跡が stderr に出る。
      const joined = lines.join('');
      expect(joined).toContain('日誌の行を読み出せずに飛ばした');

      // 3. **本文は跡に混ざらない。**
      expect(joined).not.toContain(secret);
    });

    // **意味は変わっていない**: 上の `listJobs()` の歯は、戻り型を変えていないので
    // そのまま成り立つ。変わったのは、飛ばした行が出力から消えなくなったこと
    // ——`listUnreadableJobs()` が別の口で返す（issue #2345）。
    it('listUnreadableJobs(): 飛ばした行を id（列）と不正な欄名だけで返す。本文は載せない（issue #2345）', async () => {
      const now = new Date().toISOString();
      await stores.jobs.putJob({
        id: 'mgr-ok-u',
        createdAt: now,
        updatedAt: now,
        status: 'running',
        summary: '健全な行',
      });
      await db.execute(
        sql`insert into jobs (id, status, created_at, updated_at, job)
            values (
              'broken-u',
              'future-status',
              '2026-08-12T00:00:00.000Z',
              '2026-08-12T00:00:00.000Z',
              ${JSON.stringify({
                id: 'broken-u',
                status: 'future-status',
                createdAt: '2026-08-12T00:00:00.000Z',
                updatedAt: '2026-08-12T00:00:00.000Z',
                request: `秘密は ${secret} だった`,
              })}::jsonb
            )`,
      );

      let unreadable: Awaited<ReturnType<typeof stores.jobs.listUnreadableJobs>> = [];
      const lines = await captureStderr(async () => {
        unreadable = await stores.jobs.listUnreadableJobs();
        // 覚え（`#cache`）が温まった後の2回目も同じ答えを返す。
        expect(await stores.jobs.listUnreadableJobs()).toEqual(unreadable);
      });

      // この行は `status` が未知で `summary` も無い（不正な欄名だけを並べる）。
      expect(unreadable).toEqual([{ id: 'broken-u', reason: '不正な欄: status,summary' }]);
      expect(JSON.stringify(unreadable)).not.toContain(secret);
      // `listUnreadableJobs()` は「読み飛ばした」の跡を出さない（同じ行を `listJobs()` と
      // 2回数えない）。
      expect(lines.join('')).not.toContain('日誌の行を読み出せずに飛ばした');
    });

    it('対照: 壊れた行が無ければ listUnreadableJobs() は空（issue #2345）', async () => {
      const now = new Date().toISOString();
      await stores.jobs.putJob({
        id: 'mgr-ok-u2',
        createdAt: now,
        updatedAt: now,
        status: 'running',
        summary: '健全な行のみ',
      });
      expect(await stores.jobs.listUnreadableJobs()).toEqual([]);
    });

    it('listJobs(): 壊れた行が無ければ跡は出ない（回帰）', async () => {
      const now = new Date().toISOString();
      await stores.jobs.putJob({
        id: 'mgr-ok2',
        createdAt: now,
        updatedAt: now,
        status: 'running',
        summary: '健全な行のみ',
      });

      const lines = await captureStderr(async () => {
        await stores.jobs.listJobs();
      });

      expect(lines.join('')).not.toContain('日誌の行を読み出せずに飛ばした');
    });
  });

  /**
   * `listJobs()` の行の版メモ（Issue #900）。
   *
   * **狙いは「速くなったこと」ではなく「答えが変わっていないこと」を測ること。**
   * 冷たい覚え（1回目）と温かい覚え（2回目以降）で `listJobs()` の戻りが
   * 並びを含めて一致すること、太った（新しい job が増えた）ときに正しい位置に
   * 出ること、書き換えが温かい覚えにも届くこと、壊れた行の跡が2回目でも
   * 同じ文言で出ること、そして2回目が jsonb を1行も引かないことを撃つ。
   */
  describe('listJobs() の行の版メモ（Issue #900）', () => {
    // **要素を対称にしない。** id・createdAt・status・本文をすべて違う値にし、
    // どれか2つを入れ替えたら少なくとも1つのアサーションが落ちる形にする。
    const t = (offsetMs: number) =>
      new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetMs).toISOString();

    async function seedFour(): Promise<void> {
      await stores.jobs.putJob({
        id: 'zeta',
        createdAt: t(0),
        updatedAt: t(0),
        status: 'running',
        summary: 'zeta の要旨',
        lastReport: 'zeta の最初の報告',
      });
      await stores.jobs.putJob({
        id: 'alpha',
        createdAt: t(1_000),
        updatedAt: t(1_000),
        status: 'done',
        summary: 'alpha の要旨',
        lastReport: 'alpha の最初の報告',
      });
      await stores.jobs.putJob({
        id: 'mid',
        createdAt: t(2_000),
        updatedAt: t(2_000),
        status: 'failed',
        summary: 'mid の要旨',
        lastReport: 'mid の最初の報告',
      });
      await stores.jobs.putJob({
        id: 'beta',
        createdAt: t(3_000),
        updatedAt: t(3_000),
        status: 'lost',
        summary: 'beta の要旨',
        lastReport: 'beta の最初の報告',
      });
    }

    it('答えが同じ（冷たい覚え vs 温かい覚え）——並びを含めて完全一致する', async () => {
      await seedFour();

      const cold = await stores.jobs.listJobs();
      const warm = await stores.jobs.listJobs();

      expect(cold.map((j) => j.id)).toEqual(['zeta', 'alpha', 'mid', 'beta']);
      expect(warm).toEqual(cold);
    });

    it('太る＝緑: 新しい job が正しい位置に出る（覚えが隠さない）', async () => {
      await seedFour();
      await stores.jobs.listJobs(); // 覚えを温める

      // mid（t=2000）より前・alpha（t=1000）より後 ⟹ 正しい位置は alpha と mid の間。
      await stores.jobs.putJob({
        id: 'gamma',
        createdAt: t(1_500),
        updatedAt: t(1_500),
        status: 'running',
        summary: 'gamma の要旨',
      });

      const found = await stores.jobs.listJobs();
      expect(found.map((j) => j.id)).toEqual(['zeta', 'alpha', 'gamma', 'mid', 'beta']);
    });

    it('痩せない側／書き換えが届く＝緑: putJob 後の listJobs() は新しい値を返す（覚えの一番危ない失敗——古い値を返す——を直接撃つ）', async () => {
      await seedFour();
      await stores.jobs.listJobs(); // 覚えを温める（この時点で mid は status=failed）

      await stores.jobs.putJob({
        id: 'mid',
        createdAt: t(2_000),
        updatedAt: t(2_500), // xmin も updated_at も進む
        status: 'done',
        summary: 'mid の要旨',
        lastReport: 'mid の書き換え後の報告',
      });

      const found = await stores.jobs.listJobs();
      const mid = found.find((j) => j.id === 'mid');
      expect(mid?.status).toBe('done');
      expect(mid?.lastReport).toBe('mid の書き換え後の報告');
    });

    it('壊れた行: 2回目の呼び出しでも同じ跡が同じ文言で出る（覚えが「壊れていた」を忘れない）', async () => {
      const bodyMarker = '跡には載ってはいけない本文の目印-QZXW';
      await stores.jobs.putJob({
        id: 'mgr-ok',
        createdAt: t(0),
        updatedAt: t(0),
        status: 'running',
        summary: '健全な行',
      });
      await db.execute(
        sql`insert into jobs (id, status, created_at, updated_at, job)
            values (
              'broken-2',
              'future-status',
              '2026-08-12T00:00:00.000Z',
              '2026-08-12T00:00:00.000Z',
              ${JSON.stringify({
                id: 'broken-2',
                status: 'future-status',
                createdAt: '2026-08-12T00:00:00.000Z',
                updatedAt: '2026-08-12T00:00:00.000Z',
                request: `秘密は ${bodyMarker} だった`,
              })}::jsonb
            )`,
      );

      const first = await captureStderr(async () => {
        await stores.jobs.listJobs();
      });
      const second = await captureStderr(async () => {
        await stores.jobs.listJobs();
      });

      expect(first.join('')).toContain('日誌の行を読み出せずに飛ばした');
      expect(second.join('')).toContain('日誌の行を読み出せずに飛ばした');
      expect(second.join('')).not.toContain(bodyMarker);
    });

    /**
     * 費用の歯: 2回目の呼び出しは jsonb を1行も引かない。
     *
     * **時間では測らない**（器の混雑で偽陽性・偽陰性になる。AGENTS.md
     * 「速くなったを時間で測る歯にしないこと」）。`drizzle(client, { logger })`
     * で実際に発行された SQL 文字列を捕まえ、`job` 列（jsonb）を選ぶ
     * クエリが2回目には1本も出ていないことを見る。
     */
    it('費用の歯: 2回目の呼び出しは jsonb を1行も引かない（発行された SQL で見る）', async () => {
      const queries: string[] = [];
      const localClient = new PGlite();
      const localDb = drizzle(localClient, {
        logger: {
          logQuery(query: string) {
            queries.push(query);
          },
        },
      });
      await migrate(localDb);
      const localStores = createPgStoresFromDb(localDb);

      await localStores.jobs.putJob({
        id: 'a',
        createdAt: t(0),
        updatedAt: t(0),
        status: 'running',
        summary: 'a',
      });
      await localStores.jobs.putJob({
        id: 'b',
        createdAt: t(1_000),
        updatedAt: t(1_000),
        status: 'done',
        summary: 'b',
      });

      queries.length = 0;
      await localStores.jobs.listJobs();
      const firstCallQueries = [...queries];

      queries.length = 0;
      await localStores.jobs.listJobs();
      const secondCallQueries = [...queries];

      // 1回目は段2（jsonb を引く SELECT）が出る。
      expect(firstCallQueries.some((q) => /select .*"job".* from "jobs"/i.test(q))).toBe(true);
      // 2回目は段1（id/xmin/updated_at だけ）しか出ない——jsonb 列を選ぶ形が無い。
      expect(secondCallQueries.some((q) => /select .*"job".* from "jobs"/i.test(q))).toBe(false);
      expect(secondCallQueries.length).toBe(1);

      await localClient.close();
    });

    /**
     * 段2の2つの枝——「全行が stale（冷たい起動。バインド変数の上限
     * 65,535を避けるため `WHERE` を経由しない素の `SELECT`）」と
     * 「一部だけ stale（`WHERE id IN (...)` を経由する）」——の**両方**が
     * 実際に選ばれることを、発行された SQL 文字列で見る。マネージャーの
     * レビュー指摘（2026-09-12）: 元の歯は「全部 stale」か「0件」しか
     * 通しておらず、`WHERE` 付きの枝を1本も撃っていなかった。
     */
    it('段2の分岐: 全行stale(冷たい起動)はWHERE無し・一部staleはWHERE付きのSQLが出る', async () => {
      const queries: string[] = [];
      const localClient = new PGlite();
      const localDb = drizzle(localClient, {
        logger: {
          logQuery(query: string) {
            queries.push(query);
          },
        },
      });
      await migrate(localDb);
      const localStores = createPgStoresFromDb(localDb);

      await localStores.jobs.putJob({
        id: 'a',
        createdAt: t(0),
        updatedAt: t(0),
        status: 'running',
        summary: 'a',
      });
      await localStores.jobs.putJob({
        id: 'b',
        createdAt: t(1_000),
        updatedAt: t(1_000),
        status: 'done',
        summary: 'b',
      });

      // 1回目(冷たい起動): 2件とも stale ⟹ 段2は WHERE を経由しない。
      queries.length = 0;
      await localStores.jobs.listJobs();
      const coldCallQueries = [...queries];
      const coldStage2 = coldCallQueries.filter((q) => /select .*"job".* from "jobs"/i.test(q));
      expect(coldStage2).toHaveLength(1);
      expect(coldStage2[0]).not.toMatch(/where/i);

      // b だけ書き換える ⟹ 2回目は a が温かい・b だけ stale(一部)。
      await localStores.jobs.putJob({
        id: 'b',
        createdAt: t(1_000),
        updatedAt: t(2_000),
        status: 'done',
        summary: 'b',
        lastReport: '書き換え後',
      });

      queries.length = 0;
      await localStores.jobs.listJobs();
      const partialCallQueries = [...queries];
      const partialStage2 = partialCallQueries.filter((q) =>
        /select .*"job".* from "jobs"/i.test(q),
      );
      expect(partialStage2).toHaveLength(1);
      expect(partialStage2[0]).toMatch(/where "jobs"\."id" in/i);

      await localClient.close();
    });

    /**
     * `ManagerPool.list()` 側。**`packages/core/src/manager.ts` は1文字も
     * 変えていない**——`list()` の戻りが同じであることは「`listJobs()` の
     * 戻りが同じ」から従う、という論証をここで実際に確かめる。
     *
     * `#records` に何も載っていない（`ManagerPool` を起こしただけで委譲を
     * 1本も動かしていない）状態なので、すべてのジョブが「台帳にしか無い分」
     * の枝（`manager.ts` の `#load` に相当する fallback 経路）を通る——
     * これは実際の508行の内訳（事前情報）と同じ枝である。
     */
    it('ManagerPool.list(): 2回呼んでも並びを含めて戻りが一致する', async () => {
      await seedFour();

      const pool = createManagerPool({
        stores,
        post: () => {},
        runners: createRunnerRegistry(),
      });

      const first: ManagerSummary[] = await pool.list();
      const second: ManagerSummary[] = await pool.list();

      // list() は startedAt（=job.createdAt）の降順——listJobs() の昇順とは逆順。
      expect(first.map((s) => s.managerId)).toEqual(['beta', 'mid', 'alpha', 'zeta']);
      expect(second).toEqual(first);
    });

    /**
     * マネージャーからの追補（2026-09-12）: 「行が消えない」を覚えの前提に
     * しないことを直接撃つ。
     *
     * **`JobStore` にはいま行を消す口が無い**（`#cache` の doc）ので、ここは
     * `db.delete(jobsTable)` を drizzle で直接呼ぶ——`JobStore` の口を経由
     * しない。**将来 `JobStore` に消す口が生えたときの先取りとしてこの形に
     * してある。**
     */
    it('行が直接 DELETE された後の listJobs() は、消えた id を返さない（並びも崩れない）', async () => {
      await seedFour();
      await stores.jobs.listJobs(); // 覚えを温める（zeta/alpha/mid/beta の4件とも覚えに乗る）

      await db.delete(jobsTable).where(eq(jobsTable.id, 'mid'));

      const found = await stores.jobs.listJobs();
      expect(found.map((j) => j.id)).toEqual(['zeta', 'alpha', 'beta']);
    });
  });
});

describe('PgPermissionGrantStore（issue #863）', () => {
  const GRANT = {
    id: 'grant-1',
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit'],
    denies: ['gh release edit; rm -rf /'],
    approvalId: 'ap-1',
    answer: '許可します',
    grantedAt: '2026-01-01T00:00:00.000Z',
    route: { principalKind: 'account' as const, accountId: 'acc-1' },
  };

  it('put した許可を list / get で読み戻せる', async () => {
    await stores.permissionGrants.put(GRANT);

    expect(await stores.permissionGrants.list()).toEqual([GRANT]);
    expect(await stores.permissionGrants.get('grant-1')).toEqual(GRANT);
  });

  it('器の契約（Issue #863。3実装で同じことを測る）', async () => {
    await verifyPermissionGrantStoreContract(stores.permissionGrants);
  });

  it('無い id の get は null', async () => {
    expect(await stores.permissionGrants.get('no-such-id')).toBeNull();
  });

  it('同じ id への put は置き換える（revoke の実装がこれに乗る）', async () => {
    await stores.permissionGrants.put(GRANT);
    await stores.permissionGrants.put({ ...GRANT, revokedAt: '2026-01-02T00:00:00.000Z' });

    const list = await stores.permissionGrants.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.revokedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('list は grantedAt 昇順で返る', async () => {
    await stores.permissionGrants.put({
      ...GRANT,
      id: 'grant-2',
      grantedAt: '2026-02-01T00:00:00.000Z',
    });
    await stores.permissionGrants.put({
      ...GRANT,
      id: 'grant-1',
      grantedAt: '2026-01-01T00:00:00.000Z',
    });

    expect((await stores.permissionGrants.list()).map((g) => g.id)).toEqual(['grant-1', 'grant-2']);
  });

  it('同じ db ハンドルから作り直しても読み戻せる（永続化）', async () => {
    await stores.permissionGrants.put(GRANT);

    const reopened = createPgStoresFromDb(db);
    expect(await reopened.permissionGrants.list()).toEqual([GRANT]);
  });
});

describe('PgScheduleStore', () => {
  const plan = {
    kind: 'issue-round',
    spec: { type: 'daily' as const, at: '09:00' },
    request: 'open issue を見て実装を進める',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };

  it('既定の仕込みの位相は読み戻せる（fs 版と同じ振る舞い）', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastRunAt: '2026-08-12T01:00:00.000Z',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });

    expect(await stores.schedules.getPhase('self_initiative')).toEqual({
      kind: 'self_initiative',
      lastRunAt: '2026-08-12T01:00:00.000Z',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });
    expect(await stores.schedules.getPhase('daily_report')).toBeNull();
  });

  it('位相は継続中の依頼の一覧に現れない（クローンから消せる依頼に化けない）', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });

    expect((await stores.schedules.list()).entries).toEqual([]);
    expect(await stores.schedules.get('self_initiative')).toBeNull();
  });

  it('同じ kind の位相は置き換わる（別表なので依頼とは干渉しない）', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T02:00:00.000Z',
    });
    await stores.schedules.remove('issue-round');

    expect((await stores.schedules.getPhase('self_initiative'))?.lastScheduledRunAt).toBe(
      '2026-08-12T02:00:00.000Z',
    );
  });

  it('読めない形の位相は投げる（「まだ動いていない」と混ぜない）', async () => {
    await stores.schedules.putPhase({
      kind: 'self_initiative',
      lastScheduledRunAt: '2026-08-12T01:00:00.000Z',
    });
    await db.execute(
      sql`update schedule_phases set phase = '{"kind":"self_initiative","lastScheduledRunAt":"きのう"}'::jsonb where kind = 'self_initiative'`,
    );

    await expect(stores.schedules.getPhase('self_initiative')).rejects.toThrow(
      /読めない形で入っている/,
    );
  });

  it('仕込んだ依頼は読み戻せる（fs 版と同じ振る舞い）', async () => {
    await stores.schedules.put(plan);

    expect((await stores.schedules.list()).entries).toEqual([plan]);
    expect((await stores.schedules.get('issue-round'))?.request).toContain('open issue');
    expect(await stores.schedules.get('しらない')).toBeNull();
  });

  it('同じ kind は置き換わる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.put({
      ...plan,
      request: '直した依頼',
      spec: { type: 'every', minutes: 30 },
    });

    const plans = (await stores.schedules.list()).entries;
    expect(plans).toHaveLength(1);
    expect(plans[0]?.request).toBe('直した依頼');
    expect(plans[0]?.spec).toEqual({ type: 'every', minutes: 30 });
  });

  it('発火の記録は、クローンが読む本文の側にも入る', async () => {
    await stores.schedules.put(plan);
    const claimed = await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );

    // 返るのは更新前の姿（前回いつ動いたかを呼び出し側が要る）
    expect(claimed?.request).toBe(plan.request);
    expect(claimed?.lastRunAt).toBeUndefined();
    // 列だけ直しても読み出しは jsonb からなので、両方が揃っていること
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
    expect((await stores.schedules.get('issue-round'))?.updatedAt).toBe(plan.updatedAt);
    expect((await stores.schedules.list()).entries).toHaveLength(1);
  });

  it('引き受けた印は完了で消える。印が残っていれば配り直せる', async () => {
    await stores.schedules.put(plan);

    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );

    // claim だけでは定期の基準を進めない（ここで進めると、直後に落ちた回が消える）
    const claimed = await stores.schedules.get('issue-round');
    expect(claimed?.pendingRun).toEqual({ at: '2026-08-13T00:00:00.000Z', cause: 'schedule' });
    expect(claimed?.lastScheduledRunAt).toBeUndefined();

    await stores.schedules.completeRun('issue-round', '2026-08-13T00:00:00.000Z', 'schedule');

    const done = await stores.schedules.get('issue-round');
    expect(done?.pendingRun).toBeUndefined();
    expect(done?.lastScheduledRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('別の発火の完了で、いま引き受けている印を消さない', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'schedule',
    );

    // 前の発火（別の時刻）の完了が遅れて届いた
    await stores.schedules.completeRun('issue-round', '2026-08-12T00:00:00.000Z', 'schedule');

    const held = await stores.schedules.get('issue-round');
    expect(held?.pendingRun?.at).toBe('2026-08-13T00:00:00.000Z');
    expect(held?.lastScheduledRunAt).toBeUndefined();
  });

  it('手で起こした分は観測用の前回時刻だけを進める（定期の基準は動かさない）', async () => {
    await stores.schedules.put(plan);

    await stores.schedules.claimRun(
      'issue-round',
      plan.updatedAt,
      '2026-08-13T00:00:00.000Z',
      'manual',
    );
    await stores.schedules.completeRun('issue-round', '2026-08-13T00:00:00.000Z', 'manual');

    const after = await stores.schedules.get('issue-round');
    expect(after?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
    // これを動かすと、再起動した瞬間に定期の予定が手動実行の時刻へずれる
    expect(after?.lastScheduledRunAt).toBeUndefined();
  });

  it('消された・書き換わった依頼は確定できない（条件つき UPDATE）', async () => {
    // 知らない kind
    expect(
      await stores.schedules.claimRun(
        'しらない',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();

    // 読んだ後に消された
    await stores.schedules.put(plan);
    await stores.schedules.remove('issue-round');
    expect(
      await stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();

    // 読んだ後に書き換えられた（版が違う）
    await stores.schedules.put(plan);
    await stores.schedules.put({
      ...plan,
      request: '人間が直した依頼',
      updatedAt: '2026-08-12T10:00:00.000Z',
    });
    expect(
      await stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();
    // 新しい版に古い発火の跡を付けない
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBeUndefined();
    expect((await stores.schedules.get('issue-round'))?.request).toBe('人間が直した依頼');
  });

  it('外せる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.remove('issue-round');

    expect((await stores.schedules.list()).entries).toEqual([]);
  });

  it('読めない行を「消された」に潰さない（fs 版と同じく失敗を表へ出す）', async () => {
    // 人間が手で直した・古い形が残っている、を模して不正な plan を直接置く
    await db.execute(
      sql`insert into schedules (kind, created_at, updated_at, plan)
          values ('broken', now(), now(), '{"kind":"broken"}'::jsonb)`,
    );

    // null を返すと、クローンから見て「消された依頼」と区別が付かなくなり、
    // 本文なしの曖昧なターンが走る（clone.ts が読取不能を分けている意味が消える）。
    // **`get(kind)` はこの区別を今も保つ。**
    await expect(stores.schedules.get('broken')).rejects.toThrow(/読めない形/);

    // **issue #1944 で反転。** 直す前はここも `rejects.toThrow(/読めない形/)`
    // だった——`list()` が行ごとに `parsePlan()` を呼び、1行でも失敗すると
    // そのまま投げていたため、`broken` 1行の不正で一覧全体が例外を投げ、
    // 正しい依頼まで読めなくなっていた（「一覧から黙って落とすと digest /
    // schedule_list / refresh から消えて人間にも原因が見えなくなる」という
    // 直す前の懸念自体は正しかったが、それを「1件の不正で一覧全体を止める」
    // ことで防いでいた）。#1944 は fs 側の #1868 / #1928 の線（1行ずつ検査し、
    // 合わない行は一覧から外して stderr に跡を出す。DB の行そのものは消さない）
    // に pg 側もそろえた——`get('broken')` が読めない行を投げたまま区別を
    // 保っているので（直前の assertion）、`list()` が黙ってではなく跡付きで
    // 飛ばすことと両立する。ここでは他に正しい依頼が無いので `list()` は
    // 空配列を返す。
    expect((await stores.schedules.list()).entries).toEqual([]);

    // 「無い」ことだけが null である
    expect(await stores.schedules.get('しらない')).toBeNull();
  });
});

/**
 * **`entry` に列と重複する `id` / `at` / `type` を書かない（issue #1311 §1-d）。**
 * 読むときは列から組み立て直すので、返る形は1文字も変わらない。
 */
describe('journal の entry は列と重複する欄を持たない（#1311）', () => {
  it('新しい行の entry は id / at / type を持たず、get / list は append が返したものと同じ形を返す', async () => {
    const appended = await stores.journal.append({
      type: 'decision',
      decision: '決めた',
      grounds: '根拠',
    });

    const [raw] = await db
      .select({ entry: journalTable.entry })
      .from(journalTable)
      .where(eq(journalTable.id, appended.id));
    expect(raw?.entry).toEqual({ decision: '決めた', grounds: '根拠' });

    expect(await stores.journal.get(appended.id)).toEqual(appended);
    expect(await stores.journal.list()).toEqual([appended]);
  });

  it('entry に3つを持ったままの古い行も、書いた時点の値のまま読める（追記専用なので古い行は書き換えない）', async () => {
    const old: JournalEntry = {
      id: 'old-row-1',
      at: '2026-09-01T00:00:00.000Z',
      type: 'decision',
      decision: '前に決めた',
      grounds: '前の根拠',
    };
    await db.insert(journalTable).values({
      id: old.id,
      at: new Date(old.at),
      type: old.type,
      entry: old,
    });

    expect(await stores.journal.get(old.id)).toEqual(old);
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([old]);
  });
});
