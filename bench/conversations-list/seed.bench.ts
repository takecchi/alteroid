import { describe, expect, it } from 'vitest';

import { openStores, openStoresNoWait, nowIso, rawQuery } from './common.js';

// BENCH_STEP で段を選ぶ（README.md）。
//   migrate: 表を作る（createPgStores の migrate）。索引を待たずに閉じる。
//   probe:   本物の `append` で各種別を1行ずつ書き、読み戻して形を確かめる。終わったら journal を空にする。
//   indexes: 起動の後に作る索引を作り終えるまで待つ（load.sql の後に呼ぶ）。
//   verify:  種別ごとに、新しい側・古い側の最大 5,000 行を本物のストアで読み、SQL の行数と突き合わせる（型に合わない行は読み出しで捨てられる）。
const step = process.env['BENCH_STEP'] ?? '';

describe.skipIf(step !== 'migrate')('migrate', () => {
  it('表を作る', async () => {
    const stores = await openStoresNoWait();
    await stores.close();
  });
});

describe.skipIf(step !== 'probe')('probe', () => {
  it('各種別を append して読み戻す', async () => {
    const { stores } = await openStores();
    const j = stores.journal;
    const conv = 'probe-conv-1';
    const written = [
      await j.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: 'こんにちは',
        conversationId: conv,
        clientMessageId: 'cm-probe-1',
      }),
      await j.append({
        type: 'exchange',
        with: 'human',
        role: 'outbound',
        text: 'はい',
        conversationId: conv,
        turnFailure: 'failed',
      }),
      await j.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: '直す',
        conversationId: conv,
        supersedes: 'x',
      }),
      await j.append({
        type: 'exchange',
        with: 'manager',
        role: 'inbound',
        text: 'm',
        managerId: 'mgr-1',
      }),
      await j.append({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: '[判断] 取り下げ',
        conversationId: conv,
        withdrawnClientMessageId: 'cm-probe-1',
      }),
      await j.append({ type: 'tool_use', actor: 'clone', tool: 'Bash', input: { command: 'ls' } }),
      await j.append({
        type: 'memory_update',
        slug: 'note-1',
        cause: 'clone',
        action: 'write',
        bytesBefore: 1,
        bytesAfter: 2,
        summary: 's',
      }),
      await j.append({ type: 'decision', decision: 'd', grounds: 'g' }),
      await j.append({ type: 'daily_report', date: '2026-10-25', body: 'b' }),
      await j.append({ type: 'escalation', question: 'q', approvalId: 'ap-1' }),
      await j.append({
        type: 'turn_timing',
        triggers: ['human_message'],
        batchSize: 1,
        kinds: ['normal'],
        succeeded: true,
        totalMs: 10,
        phases: { queue: 1 },
      }),
      await j.append({
        type: 'http_timing',
        windowStartedAt: nowIso(),
        windowMs: 600000,
        requests: 1,
        routes: [
          {
            route: 'GET /x',
            count: 1,
            errors: 0,
            p50Ms: 1,
            p90Ms: 1,
            maxMs: 1,
            totalMs: 1,
            db: { count: 1, totalMs: 1, wallMs: 1, waitMs: 0 },
            serializeMs: 0,
            bytes: 1,
            maxBytes: 1,
          },
        ],
        slowest: [],
      }),
      await j.append({
        type: 'conversation_deleted',
        deletedConversationId: 'probe-conv-2',
        deletedBy: 'operator',
        hiddenCount: 1,
      }),
    ];
    for (const row of await rawQuery<{ type: string; entry: unknown }>(
      stores,
      'select type, entry from journal order by seq',
    )) {
      console.log(`PROBE ${row.type} ${JSON.stringify(row.entry)}`);
    }
    const listed = await j.list({});
    console.log(`PROBE written=${written.length} listed=${listed.length}`);
    expect(listed.length).toBe(written.length);
    await rawQuery(stores, 'truncate journal restart identity');
    await rawQuery(stores, 'truncate conversation_read');
    for (const name of [
      'journal_human_exchange_seq_idx',
      'journal_human_replies_idx',
      'journal_withdrawals_idx',
      'journal_conversation_seq_idx',
    ]) {
      await rawQuery(stores, `drop index if exists ${name}`);
    }
    await stores.close();
  });
});

describe.skipIf(step !== 'indexes')('indexes', () => {
  it('起動の後に作る索引を作り終える', async () => {
    const t0 = Date.now();
    const { stores, indexes } = await openStores();
    console.log(`INDEXES ${JSON.stringify(indexes)} waited_ms=${Date.now() - t0}`);
    expect(indexes.every((outcome) => outcome.state !== 'failed')).toBe(true);
    await stores.close();
  });
});

describe.skipIf(step !== 'verify')('verify', () => {
  it('SQL の行数と、本物のストアで読めた行数を突き合わせる', async () => {
    const { stores } = await openStores();
    // 墓標が外す行（消された会話の exchange と、名指しされた行）は読み出しから外れるのが正しいので、期待の行数から引く
    const counts = await rawQuery<{ type: string; n: number }>(
      stores,
      `with deleted as (select entry->>'deletedConversationId' as id from journal where type = 'conversation_deleted'),
            named as (select jsonb_array_elements_text(entry->'hiddenEntryIds') as id from journal where type = 'conversation_deleted' and jsonb_typeof(entry->'hiddenEntryIds') = 'array')
       select type, count(*)::int as n from journal j
       where not ((j.type = 'exchange' and coalesce(j.entry->>'conversationId' in (select id from deleted), false)) or j.id in (select id from named))
       group by type order by n desc`,
    );
    let bad = 0;
    for (const { type, n } of counts) {
      const want = Math.min(5000, n);
      const newest = await stores.journal.list({ types: [type as never], limit: 5000 });
      const oldest = await stores.journal.list({
        types: [type as never],
        limit: 5000,
        order: 'asc',
      });
      const ok = newest.length === want && oldest.length === want;
      if (!ok) bad += 1;
      console.log(
        `VERIFY ${type} sql=${n} readable_newest=${newest.length}/${want} readable_oldest=${oldest.length}/${want} ${ok ? 'OK' : 'DROPPED'}`,
      );
    }
    await stores.close();
    expect(bad).toBe(0);
  });
});
