import { renderMemoryDocuments } from '@alteroid/core';
import type { Commitment, InboxEvent } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, seedPgWorkspace, type PgStores } from './index.js';

/**
 * pg ドライバの受け入れ確認。
 *
 * **偽物の DB では確かめたことにならない。** PGlite はインプロセスで動く実
 * PostgreSQL なので、SQL・索引・冪等性まで本番と同じ経路で通る（CI に外部 DB を
 * 要求せずに済む）。fs ドライバのテストと同じ振る舞いを、同じ IF に対して問う。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
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

describe('PgPersonaStore', () => {
  it('書いて読める（記憶は Markdown のまま）', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
    expect(doc?.bytes).toBeGreaterThan(0);
  });

  it('外から書き換えられた記憶が次の読み出しに反映される（受け入れ基準3）', async () => {
    await stores.persona.write('values', '# 価値観\n\nもとの内容\n');

    // CLI / HTTP API 経由で人間が書き換える、を模す（キャッシュしていれば落ちる）
    await stores.persona.write('values', '# 価値観\n\n人間が書き換えた\n');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    // クローンの文脈へ載る形（documents → renderMemoryDocuments）にも反映されること。
    // かつては concat() がこの連結まで持っていたが、載せ方は core へ移った。
    expect(renderMemoryDocuments(await stores.persona.documents())).toContain('人間が書き換えた');
  });

  it('append は末尾に足す（fs 版と同じ形）', async () => {
    await stores.persona.write('log', '# ログ\n');
    await stores.persona.append('log', '- 追記された学び\n');

    expect((await stores.persona.read('log'))?.content).toBe('# ログ\n\n- 追記された学び\n');
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
    // 書いた順を slug の昇順とわざと逆にする。挿入順（＝物理的な行順）で
    // 通ってしまわないため。
    await stores.persona.write('b', '# B\n\nい\n');
    await stores.persona.write('a', '# A\n\nあ\n');

    const docs = await stores.persona.documents();

    // 順序と本文の有無は上の層が依存する点である（クローンは走行中に
    // 「どの文書が変わったか」を見出しで指す）。
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

  /**
   * 保護状態（human guard）の派生値。実体は日誌にあり、ここは pg 側の置き場
   * （`memory` テーブルの2列）が正しく振る舞うかを確かめる。「断ることを測る」歯
   * そのもの（distill が断られる／通る）は `packages/core` の `tools.test.ts` が
   * 持つ——ここは `PersonaStore` が返す `protectionStatus` の正しさだけを見る。
   */
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

    // 歯7: write() と append() は独立した2メソッドなので、append 経路でも
    // content_sha256 が更新されることを個別に確かめる（片方だけ直す穴を塞ぐ）。
    it('append 経路でもハッシュが更新される（誤検出しない）', async () => {
      await stores.persona.write('log', '# ログ\n');
      await stores.persona.append('log', '- 追記');

      expect(await stores.persona.protectionStatus('log')).toEqual({ kind: 'clone-only' });
    });

    // 歯6: 道具経由の書き込み直後は unknown にならない（誤検出しない）。
    // 歯5（次のテスト）とは別の it() で測る。
    it('道具経由（write）の直後は unknown にならない', async () => {
      await stores.persona.write('values', '# 価値観\n\n本文\n');

      const status = await stores.persona.protectionStatus('values');

      expect(status).not.toEqual({ kind: 'unknown' });
      expect(status).toEqual({ kind: 'clone-only' });
    });

    // 歯5: 外から書き換えたら unknown に落ちる。pg には mtime 相当が無いので、
    // store を経由しない直接 UPDATE（psql 相当）を模す。
    it('store を通さず直接 UPDATE すると unknown に落ちる', async () => {
      await stores.persona.write('values', '# 価値観\n\nもとの内容\n');
      expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

      await db.execute(
        sql`update memory set content = '# 価値観\n\n外から書き換えた\n' where slug = 'values'`,
      );

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

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-1');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      answeredAt: new Date().toISOString(),
      answer: 'よい',
    });

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(0);
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
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

    expect(await stores.schedules.list()).toEqual([]);
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

    expect(await stores.schedules.list()).toEqual([plan]);
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

    const plans = await stores.schedules.list();
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
    expect(await stores.schedules.list()).toHaveLength(1);
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

    expect(await stores.schedules.list()).toEqual([]);
  });

  it('読めない行を「消された」に潰さない（fs 版と同じく失敗を表へ出す）', async () => {
    // 人間が手で直した・古い形が残っている、を模して不正な plan を直接置く
    await db.execute(
      sql`insert into schedules (kind, created_at, updated_at, plan)
          values ('broken', now(), now(), '{"kind":"broken"}'::jsonb)`,
    );

    // null を返すと、クローンから見て「消された依頼」と区別が付かなくなり、
    // 本文なしの曖昧なターンが走る（clone.ts が読取不能を分けている意味が消える）
    await expect(stores.schedules.get('broken')).rejects.toThrow(/読めない形/);
    // 一覧から黙って落とすと、digest / schedule_list / refresh から消えて
    // 人間にも原因が見えなくなる
    await expect(stores.schedules.list()).rejects.toThrow(/読めない形/);

    // 「無い」ことだけが null である
    expect(await stores.schedules.get('しらない')).toBeNull();
  });
});

/**
 * 引き受けたまま終わっていない仕事の台帳（fs 版と同じ振る舞いになることを問う）。
 */
describe('PgCommitmentStore', () => {
  const commitment = (id: string, at: string, body: string): Commitment => ({
    id,
    at,
    origin: 'human',
    source: 'conv-1',
    body,
  });

  it('開いた仕事は未了として読み戻せる（fs 版と同じ振る舞い）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(await stores.commitments.list()).toEqual([
      commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'),
    ]);
    expect((await stores.commitments.get('c-1'))?.body).toBe('PR を出す');
    expect(await stores.commitments.get('しらない')).toBeNull();
  });

  it('閉じたものは未了から外れ、includeClosed でだけ読める（行は消さない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した')).toBe(
      true,
    );

    expect(await stores.commitments.list()).toEqual([]);
    const all = await stores.commitments.list({ includeClosed: true });
    expect(all).toHaveLength(1);
    // 列だけ直しても読み出しは jsonb からなので、クローンが見る側に入っていること
    expect(all[0]?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(all[0]?.closedReason).toBe('#99 で出した');
  });

  it('同じ id で二度 open しても上書きされない（1回目の本文が残る）', async () => {
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', '最初の依頼')),
    ).toBe(true);

    // 受信箱の合図は配り直されうるので、同じ id の自動 open は普通に二度来る
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-14T00:00:00.000Z', '別の本文')),
    ).toBe(false);

    const entry = await stores.commitments.get('c-1');
    expect(entry?.body).toBe('最初の依頼');
    expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
    expect(await stores.commitments.list()).toHaveLength(1);
  });

  it('閉じた id を open し直しても開き直らない（片付いた仕事が蘇らない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));
    await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した');

    // 器が落ちて合図が配り直された、を模す
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す')),
    ).toBe(false);

    expect(await stores.commitments.list()).toEqual([]);
    expect((await stores.commitments.get('c-1'))?.closedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('close は二度目に false を返す（二重に「いま片付けた」と報告させない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '出した')).toBe(true);
    expect(await stores.commitments.close('c-1', '2026-08-14T00:00:00.000Z', 'また出した')).toBe(
      false,
    );

    // 二度目は記録も動かさない（最初に片付けた事実を書き換えない）
    const entry = await stores.commitments.get('c-1');
    expect(entry?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(entry?.closedReason).toBe('出した');
  });

  it('存在しない id の close は false（勝手に行を作らない）', async () => {
    expect(await stores.commitments.close('しらない', '2026-08-13T00:00:00.000Z', '片付けた')).toBe(
      false,
    );

    expect(await stores.commitments.list({ includeClosed: true })).toEqual([]);
  });

  it('未了は古い順に返り、閉じたものは新しく片付いた順で後ろに続く', async () => {
    await stores.commitments.open(commitment('c-new', '2026-08-14T00:00:00.000Z', '新しい'));
    await stores.commitments.open(commitment('c-old', '2026-08-10T00:00:00.000Z', '古い'));
    await stores.commitments.open(commitment('c-a', '2026-08-11T00:00:00.000Z', 'A'));
    await stores.commitments.open(commitment('c-b', '2026-08-12T00:00:00.000Z', 'B'));
    await stores.commitments.close('c-a', '2026-08-15T00:00:00.000Z', 'A を片付けた');
    await stores.commitments.close('c-b', '2026-08-16T00:00:00.000Z', 'B を片付けた');

    expect((await stores.commitments.list()).map((entry) => entry.id)).toEqual(['c-old', 'c-new']);
    expect(
      (await stores.commitments.list({ includeClosed: true })).map((entry) => entry.id),
    ).toEqual(['c-old', 'c-new', 'c-b', 'c-a']);
  });

  it('同じ id の並行 open は1件しか入らない（読んでから書く形にしていない）', async () => {
    const results = await Promise.all([
      stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', '最初の依頼')),
      stores.commitments.open(commitment('c-1', '2026-08-12T00:00:01.000Z', '二度目')),
      stores.commitments.open(commitment('c-1', '2026-08-12T00:00:02.000Z', '三度目')),
    ]);

    // 「いま自分が開いた」と言えるのは1本だけ
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await stores.commitments.list();
    expect(rows).toHaveLength(1);
    // 後から来たものが先の行を上書きしていない（上書きすると片付いた仕事が蘇る）
    expect(rows[0]?.body).toBe('最初の依頼');
  });

  it('同じ id の並行 close で true は1回だけ返る', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    const results = await Promise.all([
      stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '1本目'),
      stores.commitments.close('c-1', '2026-08-13T00:00:01.000Z', '2本目'),
      stores.commitments.close('c-1', '2026-08-13T00:00:02.000Z', '3本目'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await stores.commitments.list()).toEqual([]);
  });

  it('読めない行を「片付いた」に潰さない（fs 版と同じく失敗を表へ出す）', async () => {
    // 人間が手で直した・古い形が残っている、を模して不正な本体を直接置く
    await db.execute(
      sql`insert into commitments (id, at, commitment)
          values ('broken', now(), '{"id":"broken"}'::jsonb)`,
    );

    // 黙って飛ばすと未了の一覧からも digest からも消え、クローンは引き受けたことを
    // 二度と思い出さない（＝この器が塞いでいる穴がそのまま開く）
    await expect(stores.commitments.get('broken')).rejects.toThrow(/読めない形/);
    await expect(stores.commitments.list()).rejects.toThrow(/読めない形/);

    // 「無い」ことだけが null である
    expect(await stores.commitments.get('しらない')).toBeNull();
  });
});

/**
 * まだ処理し終えていない受信箱の合図（fs 版と同じ振る舞いになることを問う）。
 */
describe('PgInboxStore', () => {
  const human = (id: string, at: string, text: string): InboxEvent => ({
    type: 'human_message',
    id,
    at,
    text,
    conversationId: 'conv-1',
  });

  it('put したものが claimPending で古い順に返る', async () => {
    await stores.inbox.put(
      human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
      '2026-08-11T00:00:00.000Z',
    );
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
      '2026-08-10T00:00:00.000Z',
    );

    const pending = await stores.inbox.claimPending();

    expect(pending.map((entry) => entry.event.id)).toEqual(['evt-1', 'evt-2']);
    expect(pending.every((entry) => entry.deliveries === 1)).toBe(true);
  });

  it('remove したものは返らない。無い id の remove は落ちない', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.remove('evt-1');

    expect(await stores.inbox.claimPending()).toEqual([]);
    await expect(stores.inbox.remove('しらない')).resolves.toBeUndefined();
  });

  it('claimPending を2回呼ぶと deliveries が 1 → 2 と進む（消していないものは何度でも返る）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
      '2026-08-10T00:00:00.000Z',
    );

    const first = await stores.inbox.claimPending();
    const second = await stores.inbox.claimPending();

    expect(first[0]?.deliveries).toBe(1);
    expect(second[0]?.deliveries).toBe(2);
  });

  it('同じ id で put し直しても deliveries が 0 に戻らない（本文だけ差し替わる）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', 'もとの本文'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.claimPending();

    // 同じ id で置き直す（例えばデーモン再起動直後にもう一度届いた、を模す）
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '直した本文'),
      '2026-08-10T00:00:00.000Z',
    );
    const pending = await stores.inbox.claimPending();

    expect(pending[0]?.deliveries).toBe(2);
    expect((pending[0]?.event as { text: string }).text).toBe('直した本文');
  });

  it('本文が欠けずに往復する（human_message の text、external の payload）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '人間の発言'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.put(
      {
        type: 'external',
        id: 'evt-2',
        at: '2026-08-11T00:00:00.000Z',
        source: 'webhook',
        payload: { deep: { nested: [1, 2, 3] }, note: '日本語も' },
      },
      '2026-08-11T00:00:00.000Z',
    );

    const pending = await stores.inbox.claimPending();
    const humanEntry = pending.find((entry) => entry.event.id === 'evt-1');
    const externalEntry = pending.find((entry) => entry.event.id === 'evt-2');

    expect((humanEntry?.event as { text: string }).text).toBe('人間の発言');
    expect((externalEntry?.event as { payload: unknown }).payload).toEqual({
      deep: { nested: [1, 2, 3] },
      note: '日本語も',
    });
  });

  it('読めない行を「消された」に潰さない（fs 版と同じく失敗を表へ出す）', async () => {
    await db.execute(
      sql`insert into inbox_events (id, event, at, deliveries)
          values ('broken', '{"id":"broken"}'::jsonb, now(), 0)`,
    );

    await expect(stores.inbox.claimPending()).rejects.toThrow(/読めない形/);
  });
});

describe('PgTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = await stores.archive.archive('session-1', '{"a":1}\n');

    expect(await stores.archive.list()).toContain(id);
    expect(await stores.archive.read(id)).toBe('{"a":1}\n');
  });

  it('無い id は null', async () => {
    expect(await stores.archive.read('居ない')).toBeNull();
  });
});

/**
 * 実行環境プロファイル。
 *
 * **`revert` は本文と更新日時を組で戻す。** ここは人間が `profile status` で見る
 * 「最後に本文を変えた時刻」であり、取り消された更新でそこが動くと、成功して
 * いない更新が最後の変更として表示される（デーモンを起こすたびに動いていたのと
 * 同じ意味の壊れ方）。**器が違っても同じ振る舞いになること**を fs / pg の両方で問う。
 */
describe('PgProfileStore', () => {
  it('置いて読める。空文字で外れる', async () => {
    expect(await stores.profile.read()).toBeNull();

    await stores.profile.write('export A=1\n');
    expect((await stores.profile.read())?.script).toBe('export A=1\n');

    await stores.profile.write('');
    expect(await stores.profile.read()).toBeNull();
  });

  it('revert は本文だけでなく更新日時も戻す', async () => {
    await stores.profile.write('export WHICH=old\n');
    const before = await stores.profile.read();

    // 時刻が確実に進むまで待ってから、失敗する更新を模す。
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stores.profile.write('export WHICH=new\n');
    expect((await stores.profile.read())?.updatedAt).not.toBe(before?.updatedAt);

    await stores.profile.revert(before);

    // **まるごと一致すること。** 本文だけ戻して時刻が進むと監査情報が嘘になる。
    expect(await stores.profile.read()).toEqual(before);
  });

  it('置かれていなかった状態へも戻せる', async () => {
    await stores.profile.write('export WHICH=new\n');
    await stores.profile.revert(null);
    expect(await stores.profile.read()).toBeNull();
  });
});

describe('PgSessionRegistry', () => {
  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });
});

describe('PgSessionStore（SDK のセッション永続化）', () => {
  const key = { projectKey: 'proj', sessionId: 'sess-1' };

  it('一度も書かれていない key は null（空配列ではない）', async () => {
    expect(await stores.sessionStore.load(key)).toBeNull();
  });

  it('積んだ順に読み戻せる', async () => {
    await stores.sessionStore.append(key, [
      { type: 'user', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z' },
      { type: 'assistant', uuid: 'u2' },
    ]);
    await stores.sessionStore.append(key, [{ type: 'assistant', uuid: 'u3' }]);

    const entries = await stores.sessionStore.load(key);

    expect(entries?.map((entry) => entry.uuid)).toEqual(['u1', 'u2', 'u3']);
  });

  it('同じ uuid の再送で二重にならない（SDK は再送・再取り込みしうる）', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.append(key, [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'u2' },
    ]);

    expect((await stores.sessionStore.load(key))?.map((entry) => entry.uuid)).toEqual(['u1', 'u2']);
  });

  it('uuid の無い行（タイトル・タグ等）は畳まずに積む', async () => {
    await stores.sessionStore.append(key, [{ type: 'title' }]);
    await stores.sessionStore.append(key, [{ type: 'title' }]);

    expect(await stores.sessionStore.load(key)).toHaveLength(2);
  });

  it('中身をそのまま往復させる（アダプタは素通しの器）', async () => {
    const entry = {
      type: 'assistant',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: '日本語もそのまま' }] },
      nested: { deep: [1, 2, { ok: true }] },
    };
    await stores.sessionStore.append(key, [entry]);

    expect((await stores.sessionStore.load(key))?.[0]).toEqual(entry);
  });

  it('セッション一覧と作業者の生ログ（subpath）へ降りられる', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.append({ ...key, subpath: 'worker-1' }, [
      { type: 'user', uuid: 'w1' },
    ]);
    await stores.sessionStore.append({ projectKey: 'proj', sessionId: 'sess-2' }, [
      { type: 'user', uuid: 'x1' },
    ]);

    const listed = await stores.sessionStore.listSessions('proj');

    expect(listed.map((row) => row.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
    expect(listed.every((row) => Number.isInteger(row.mtime))).toBe(true);
    expect(await stores.sessionStore.listSubkeys(key)).toEqual(['worker-1']);
    // subpath は別のトランスクリプト。主のログに混ざらない。
    expect(await stores.sessionStore.load(key)).toHaveLength(1);
  });

  it('消せる（保持期間はアダプタの責任）', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.delete(key);

    expect(await stores.sessionStore.load(key)).toBeNull();
    expect(await stores.sessionStore.listSessions('proj')).toEqual([]);
  });
});

/**
 * ログインとアクセス許可。**fs と pg で同じ振る舞いになること**を両方で問う
 * （器が違うだけで上の層が見るものは同じ、が M4 の要件）。
 */
describe('AuthStore', () => {
  const account = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
  };

  it('アカウントを保存して読み戻せる', async () => {
    await stores.auth.putAccount(account);

    expect(await stores.auth.getAccount('account-1')).toEqual(account);
    expect(await stores.auth.listAccounts()).toEqual([account]);
    expect(await stores.auth.getAccount('居ない')).toBeNull();
  });

  it('許可の2値を書き換えられる（alteroid access grant の実体）', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putAccount({
      ...account,
      grantedAt: '2026-01-02T00:00:00.000Z',
      grantedBy: 'operator',
    });

    const stored = await stores.auth.getAccount('account-1');
    expect(stored?.grantedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(stored?.grantedBy).toBe('operator');
    // 上書きであって増殖ではない
    expect(await stores.auth.listAccounts()).toHaveLength(1);
  });

  it('検証済みメールからアカウントを引ける（相乗りの検査に使う）', async () => {
    await stores.auth.putAccount(account);

    expect((await stores.auth.findAccountByEmail('owner@example.test'))?.id).toBe('account-1');
    expect(await stores.auth.findAccountByEmail('別人@example.test')).toBeNull();
  });

  it('identity は (provider, subject) で一意（同じ人の入り直しで増えない）', async () => {
    await stores.auth.putAccount(account);
    const identity = {
      provider: 'google',
      subject: 'sub-1',
      accountId: 'account-1',
      email: 'owner@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    await stores.auth.putIdentity(identity);
    await stores.auth.putIdentity({ ...identity, lastLoginAt: '2026-01-05T00:00:00.000Z' });

    const identities = await stores.auth.listIdentities('account-1');
    expect(identities).toHaveLength(1);
    expect(identities[0]?.lastLoginAt).toBe('2026-01-05T00:00:00.000Z');
    expect((await stores.auth.findIdentity('google', 'sub-1'))?.accountId).toBe('account-1');
    expect(await stores.auth.findIdentity('google', '別の sub')).toBeNull();
  });

  it('アクセストークンは sha256 で引ける（素の値は持たない）', async () => {
    await stores.auth.putAccount(account);
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    await stores.auth.putAccessToken(token);

    expect(await stores.auth.findAccessTokenBySha256('a'.repeat(64))).toEqual(token);
    expect(await stores.auth.findAccessTokenBySha256('b'.repeat(64))).toBeNull();
    expect(await stores.auth.listAccessTokens('account-1')).toEqual([token]);
  });

  it('ログイン要求を保存して読み戻せる（ブラウザ往復の突き合わせ）', async () => {
    const request = {
      id: 'login-1',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'c'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending' as const,
      accountId: null,
      error: null,
    };
    await stores.auth.putLoginRequest(request);
    expect(await stores.auth.getLoginRequest('login-1')).toEqual(request);

    await stores.auth.putLoginRequest({ ...request, status: 'consumed' as const });
    expect((await stores.auth.getLoginRequest('login-1'))?.status).toBe('consumed');
    expect(await stores.auth.getLoginRequest('居ない')).toBeNull();
  });
  it('ログイン要求の引き取りは1回だけ成功する（並行でも二重発行させない）', async () => {
    const request = {
      id: 'login-2',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'd'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated' as const,
      accountId: 'account-1',
      error: null,
    };
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest(request);

    // 読んでから書く形だと、ここで全部が authenticated を掴んでしまう。
    let issued = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        stores.auth.claimLoginRequest('login-2', (request) => ({
          id: `token-race-${++issued}`,
          accountId: request.accountId ?? '',
          sha256: String(issued).repeat(64).slice(0, 64),
          label: request.label,
          createdAt: '2026-01-02T00:00:00.000Z',
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        })),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-2'))?.status).toBe('consumed');
    // 保存されたトークンも1本だけ（応答が1件でも器に2本あれば通ってしまう）。
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
    // 一度 consumed になったら、あとから何度呼んでも取れない。
    expect(await stores.auth.claimLoginRequest('login-2', () => neverIssued())).toBeNull();
  });

  it('pending のログイン要求は引き取れない（ブラウザ側が終わる前に発行しない）', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-3',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'e'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    expect(await stores.auth.claimLoginRequest('login-3', () => neverIssued())).toBeNull();
    expect((await stores.auth.getLoginRequest('login-3'))?.status).toBe('pending');
    expect(await stores.auth.claimLoginRequest('居ない', () => neverIssued())).toBeNull();
  });
  it('別々のアカウントへ同時に grant しても、持ち主は1人しかできない', async () => {
    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantExclusive('account-1', at, 'operator'),
      stores.auth.grantExclusive('account-2', at, 'operator'),
    ]);

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(1);
    // 器に2人残っていたら、応答が1件でも両方が通ってしまう。
    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(1);
  });

  it('トークンの保存が落ちたら、ログイン要求は authenticated のまま残る', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest({
      id: 'login-4',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'f'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated',
      accountId: 'account-1',
      error: null,
    });

    // 消費だけ先に確定してしまうと、トークンは返らないのに二度と引き取れなくなる。
    await expect(
      stores.auth.claimLoginRequest('login-4', () => {
        throw new Error('トークンを作れなかった');
      }),
    ).rejects.toThrow();
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('authenticated');

    // 直れば、同じ要求をそのまま引き取れる。
    const claimed = await stores.auth.claimLoginRequest('login-4', (request) => ({
      id: 'token-4',
      accountId: request.accountId ?? '',
      sha256: 'b'.repeat(64),
      label: request.label,
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    }));
    expect(claimed?.token.id).toBe('token-4');
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('consumed');
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
  });
  it('交換へ進む権利は1つのリクエストしか取れない', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-5',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'a'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    // 読んでから書く形だと、全部が pending を通過して全部が交換へ進む。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => stores.auth.beginLoginExchange('login-5')),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-5'))?.status).toBe('processing');
    // 一度 processing になったら、あとから何度呼んでも取れない。
    expect(await stores.auth.beginLoginExchange('login-5')).toBeNull();
    expect(await stores.auth.beginLoginExchange('居ない')).toBeNull();
  });
});

/** 引き取れないはずの経路で呼ばれたら、テストとして落とす。 */
function neverIssued(): never {
  throw new Error('引き取れないはずの要求でトークンを作ろうとした');
}
