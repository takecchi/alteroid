import {
  captureStderr,
  createManagerPool,
  createRunnerRegistry,
  scanJournalPages,
  verifyCommitmentEditIfMatchContract,
  verifyCommitmentRemoveForConversationContract,
  verifyCommitmentEditUnreadableContract,
  verifyCommitmentFoldContract,
  verifyCommitmentTieOrderContract,
  verifyJournalStoreHorizonContract,
  verifyConversationPageContract,
  verifyJournalStoreOrderContract,
  verifyJournalStorePageContract,
  verifyJournalStoreQueryEdgeContract,
  verifyJournalStoreUnreadableGetContract,
  UnreadableJournalEntryError,
  verifyJournalStoreSearchContract,
  verifyJournalStoreDeletedConversationContract,
  verifyJournalStoreWithdrawnContract,
  verifyJournalStoreWithContract,
  verifyPermissionGrantStoreContract,
  verifyPracticeStoreContract,
  verifyJobNulContract,
  verifyScheduleNulContract,
  verifyScheduleIfMatchContract,
  verifyScheduleUnreadableContract,
  verifyStoreIsolationContract,
} from '@alteroid/core';
import type { Job, JournalEntry, ManagerSummary } from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, seedPgWorkspace, type PgStores } from './index.js';
import {
  commitments as commitmentsTable,
  jobs as jobsTable,
  journal as journalTable,
  schedules as schedulesTable,
} from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 偽物の DB を使わない: PGlite は実 PostgreSQL で、SQL・索引・冪等性まで本番と同じ経路を通るから。
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
    // write() が created_at を入れるので、markCreatedAt が値を立てる場面を作るには一度 null に戻す。
    await db.execute(sql`update memory set created_at = null where slug = 'values'`);
    await stores.persona.markCreatedAt('values', '2026-01-02T03:04:05.000Z');

    await migrate(db);
    await migrate(db);

    expect((await stores.persona.read('values'))?.createdAt).toEqual({
      kind: 'known',
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  // 同じ入り口を2回呼ぶだけにしない: 1周目の後に行を積み `remove()` してから2周目を当てないと、2周目でだけ壊れる状態を測れないから。
  it('archive の tombstone 列の追加は2回通しても壊れない（1周目の後に remove() してから2周目を当てる）', async () => {
    const removedId = (await stores.archive.archive('session-migrate-twice-removed', 'BODY\n')).id;
    const removed = await stores.archive.remove(removedId);
    expect(removed.kind).toBe('removed');

    await migrate(db);

    expect(await stores.archive.read(removedId)).toMatchObject({ kind: 'removed' });

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

  // 消さない: 書き込みは通り、読み出しで初めて落ちて行が `list()` から黙って消えるのはこの形だけだから。
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

  // 生 SQL で insert する: `append()` 経由では `journalEntrySchema.parse` を通ってしまい、壊れた行を作れないから。
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

      expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual([
        '健全な行',
      ]);

      const joined = lines.join('');
      expect(joined).toContain('日誌の行を読み出せずに飛ばした');
      expect(joined).toContain('type=future-type');

      expect(joined).not.toContain(secret);
    });

    it('get(): スキーマに合わない行なら、跡を残して UnreadableJournalEntryError を投げる（無いのではなく読めない）', async () => {
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

      let thrown: unknown;
      const lines = await captureStderr(async () => {
        try {
          await stores.journal.get('broken-1');
        } catch (error) {
          thrown = error;
        }
      });

      // null を返さない: 在る行を null と返すと、呼び出し元が「まだ書かれていない」と言ってしまうから。
      expect(thrown).toBeInstanceOf(UnreadableJournalEntryError);
      expect((thrown as UnreadableJournalEntryError).id).toBe('broken-1');
      expect((thrown as Error).message).not.toContain(secret);
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

  describe('取り下げの印の契約（issue #3990）', () => {
    it('印の行が書き戻せ、同じ会話の印だけが集まり、since より前は外れ、頁をまたいでも読み落とさない', async () => {
      await verifyJournalStoreWithdrawnContract(stores.journal);
    });
  });

  describe('墓標の契約（issue #4218）', () => {
    it('墓標の後は list/listPage/get/q/with から外れる／別の会話と墓標は外れない／limit より前に効く／墓標の後の行も外れる', async () => {
      await verifyJournalStoreDeletedConversationContract(stores.journal);
    });
  });

  describe('with 契約（issue #418）', () => {
    it('未指定=絞らない／指定=その with だけ／[]=0件／limit より前に効く', async () => {
      await verifyJournalStoreWithContract(stores.journal);
    });

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

  describe('order/after 契約（issue #432 の2本目）', () => {
    it('order 未指定=desc／asc は正確な逆順／after は絞り・limit より前に効く／同着を飛ばさない', async () => {
      await verifyJournalStoreOrderContract(stores.journal);
    });

    it('会話の一覧の頁送り（日誌の継続点の上の組み立て）が、頁の連結=全件・窓より小さい頁・同着・使えない継続点で揃う', async () => {
      await verifyConversationPageContract(stores.journal);
    });

    it('畳み込みの契約（#1041。3実装で同じことを測る。⚠ 名乗れるのはプロセス内で原子であることまで）', async () => {
      await verifyCommitmentFoldContract(stores.commitments);
    });

    it('同じ at の未了の並びの契約（#3285。3実装で同じことを測る。入れた順のまま、editBody・close・closeMany の後も）', async () => {
      await verifyCommitmentTieOrderContract(stores.commitments);
    });

    it('editBody の ifMatch の契約（#3786。3実装で同じことを測る）', async () => {
      await verifyCommitmentEditIfMatchContract(stores.commitments);
    });

    it('removeForConversation の契約（#4218。3実装で同じことを測る。human かつ source 一致の行だけを未了・片付いたとも物理的に消す）', async () => {
      await verifyCommitmentRemoveForConversationContract(stores.commitments);
    });

    it('読めない行への editBody の契約（#4064。fs と pg で同じことを測る。インメモリは読めない行を持てない）', async () => {
      await captureStderr(async () => {
        await verifyCommitmentEditUnreadableContract(stores.commitments, async (id) => {
          // `open` は形を断るので、表へ直に書く。
          const at = new Date('2026-01-01T00:00:00.000Z');
          await db.insert(commitmentsTable).values({
            id,
            at,
            commitment: { id, at: at.toISOString(), origin: 'future-origin', body: '壊れた行' },
          });
        });
      });
    });

    it('ストアが返す値は書いた側の握りと別物である（#1072。3実装で同じことを測る）', async () => {
      await verifyStoreIsolationContract(stores);
    });

    it('やり方の器の契約（#1055 段3。3実装で同じことを測る）', async () => {
      await verifyPracticeStoreContract(stores.practices, { verifyClear: true });
    });
  });

  describe('listPage: 読めない行と頁の境界（Issue #2604 / #2605）', () => {
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

      const second = await stores.journal.listPage({ limit: 2, after: first.next! });
      expect(second.entries).toEqual([]);
      expect(second.next).toEqual({ id: 'b1', at: '2026-08-01T00:00:01.000Z' });

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

      // 空の頁で打ち切らない: g0 を逃すから。
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

  describe('get の「在るが読めない」契約（issue #3288）', () => {
    it('読めない行の get は UnreadableJournalEntryError／無い id は null／読める行と list は巻き込まれない', async () => {
      await verifyJournalStoreUnreadableGetContract(stores.journal, async () => {
        const id = 'unreadable-contract-1';
        await db.execute(
          sql`insert into journal (id, at, type, entry)
              values (${id}, '2026-08-12T00:00:00.000Z', 'no-such-type', ${JSON.stringify({
                type: 'no-such-type',
                id,
                at: '2026-08-12T00:00:00.000Z',
              })}::jsonb)`,
        );
        return id;
      });
    });
  });

  describe('日誌の地平（issue #1510）', () => {
    it('空なら null／1件ならその at／複数件でも最古のまま', async () => {
      await verifyJournalStoreHorizonContract(stores.journal);
    });
  });

  describe('q 契約（issue #250）', () => {
    it('未指定=絞らない／部分一致／大文字小文字を区別しない／%_ はワイルドカードでない／""=絞らない／limit より前に効く', async () => {
      await verifyJournalStoreSearchContract(stores.journal);
    });
  });
});

describe('PgJobStore', () => {
  it('NUL の契約（issue #3011。3実装で同じことを測る）', async () => {
    await verifyJobNulContract(stores.jobs);
  });

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

      expect(found.map((job) => job.summary)).toEqual(['健全な行']);

      const joined = lines.join('');
      expect(joined).toContain('日誌の行を読み出せずに飛ばした');

      expect(joined).not.toContain(secret);
    });

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
        expect(await stores.jobs.listUnreadableJobs()).toEqual(unreadable);
      });

      expect(unreadable).toEqual([{ id: 'broken-u', reason: '不正な欄: status,summary' }]);
      expect(JSON.stringify(unreadable)).not.toContain(secret);
      // 跡を出さない: 同じ行を `listJobs()` と2回数えないため。
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

  describe('listJobs() の行の版メモ（Issue #900）', () => {
    // 要素を対称にしない: どれか2つを入れ替えたら少なくとも1つのアサーションが落ちる形にするため。
    const t = (offsetMs: number) =>
      new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetMs).toISOString();

    // パラメータは載せない: 秘密が失敗メッセージへ出るから。
    const dump = (label: string, qs: readonly string[]): string =>
      `${label}: ${qs.length} 本\n${qs.map((q, i) => `  [${i}] ${q}`).join('\n')}`;

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
      await stores.jobs.listJobs();

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
      await stores.jobs.listJobs();

      await stores.jobs.putJob({
        id: 'mid',
        createdAt: t(2_000),
        updatedAt: t(2_500),
        status: 'done',
        summary: 'mid の要旨',
        lastReport: 'mid の書き換え後の報告',
      });

      const found = await stores.jobs.listJobs();
      const mid = found.find((j) => j.id === 'mid');
      expect(mid?.status).toBe('done');
      expect(mid?.lastReport).toBe('mid の書き換え後の報告');
    });

    it('同じ updatedAt（同じミリ秒）で書き換えても、覚えは古い値を返さない（xmin が版を分ける）', async () => {
      const base = {
        id: 'same-ms',
        createdAt: t(0),
        updatedAt: t(0),
        status: 'running' as const,
        summary: '同じ要旨',
      };
      await stores.jobs.putJob({ ...base, lastReport: '最初の報告' });
      expect((await stores.jobs.listJobs())[0]?.lastReport).toBe('最初の報告');

      await stores.jobs.putJob({ ...base, lastReport: '書き換え後の報告' });

      expect((await stores.jobs.listJobs())[0]?.lastReport).toBe('書き換え後の報告');
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

    // 時間では測らない: 器の混雑で偽陽性・偽陰性になるから。発行された SQL 文字列で見る。
    it('費用の歯: 2回目の呼び出しは jsonb を1行も引かない（発行された SQL で見る）', async () => {
      const queries: string[] = [];
      const localDb = client.withLogger({ logQuery: (query: string) => queries.push(query) });
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

      expect(
        firstCallQueries.some((q) => /select .*"job".* from "jobs"/i.test(q)),
        dump('1回目', firstCallQueries),
      ).toBe(true);
      expect(
        secondCallQueries.some((q) => /select .*"job".* from "jobs"/i.test(q)),
        dump('2回目', secondCallQueries),
      ).toBe(false);
      expect(secondCallQueries.length, dump('2回目', secondCallQueries)).toBe(1);
    });

    it('段2の分岐: 全行stale(冷たい起動)はWHERE無し・一部staleはWHERE付きのSQLが出る', async () => {
      const queries: string[] = [];
      const localDb = client.withLogger({ logQuery: (query: string) => queries.push(query) });
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
      const coldCallQueries = [...queries];
      const coldStage2 = coldCallQueries.filter((q) => /select .*"job".* from "jobs"/i.test(q));
      expect(coldStage2, dump('冷たい1回目', coldCallQueries)).toHaveLength(1);
      expect(coldStage2[0], dump('冷たい1回目', coldCallQueries)).not.toMatch(/where/i);

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
      expect(partialStage2, dump('一部 stale の2回目', partialCallQueries)).toHaveLength(1);
      expect(partialStage2[0], dump('一部 stale の2回目', partialCallQueries)).toMatch(
        /where "jobs"\."id" in/i,
      );
    });

    it('ManagerPool.list(): 2回呼んでも並びを含めて戻りが一致する', async () => {
      await seedFour();

      const pool = createManagerPool({
        stores,
        post: () => {},
        runners: createRunnerRegistry(),
      });

      const first: ManagerSummary[] = await pool.list();
      const second: ManagerSummary[] = await pool.list();

      expect(first.map((s) => s.managerId)).toEqual(['beta', 'mid', 'alpha', 'zeta']);
      expect(second).toEqual(first);
    });

    // `JobStore` に行を消す口が無いので、`db.delete(jobsTable)` で直接消す。
    it('行が直接 DELETE された後の listJobs() は、消えた id を返さない（並びも崩れない）', async () => {
      await seedFour();
      await stores.jobs.listJobs();

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
  it('NUL の契約（issue #3011。3実装で同じことを測る）', async () => {
    await verifyScheduleNulContract(stores.schedules);
  });

  it('ifMatch の契約（Issue #3821。3実装で同じことを測る）', async () => {
    await verifyScheduleIfMatchContract(stores.schedules);
  });

  it('読めない行の契約（Issue #3859。fs と pg で同じことを測る。インメモリは読めない行を持てない）', async () => {
    await captureStderr(async () => {
      await verifyScheduleUnreadableContract(stores.schedules, async (kind) => {
        // `put` は形を断るので、表へ直に書く。
        const at = new Date('2026-01-01T00:00:00.000Z');
        const plan = {
          kind,
          spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
          request: '壊れた行',
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        };
        await db
          .insert(schedulesTable)
          .values({ kind, createdAt: at, updatedAt: at, plan })
          .onConflictDoUpdate({ target: schedulesTable.kind, set: { plan } });
      });
    });
  });

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

    expect(claimed?.request).toBe(plan.request);
    expect(claimed?.lastRunAt).toBeUndefined();
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

    // claim で定期の基準を進めない: 直後に落ちた回が消えるから。
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
    // 動かさない: 再起動した瞬間に定期の予定が手動実行の時刻へずれるから。
    expect(after?.lastScheduledRunAt).toBeUndefined();
  });

  it('消された・書き換わった依頼は確定できない（条件つき UPDATE）', async () => {
    expect(
      await stores.schedules.claimRun(
        'しらない',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ).toBeNull();

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
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBeUndefined();
    expect((await stores.schedules.get('issue-round'))?.request).toBe('人間が直した依頼');
  });

  it('外せる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.remove('issue-round');

    expect((await stores.schedules.list()).entries).toEqual([]);
  });

  it('読めない行を「消された」に潰さない（fs 版と同じく失敗を表へ出す）', async () => {
    await db.execute(
      sql`insert into schedules (kind, created_at, updated_at, plan)
          values ('broken', now(), now(), '{"kind":"broken"}'::jsonb)`,
    );

    // null を返さない: クローンから「消された依頼」と区別が付かず、本文なしの曖昧なターンが走るから。
    await expect(stores.schedules.get('broken')).rejects.toThrow(/読めない形/);

    expect((await stores.schedules.list()).entries).toEqual([]);

    expect(await stores.schedules.get('しらない')).toBeNull();
  });
});

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
