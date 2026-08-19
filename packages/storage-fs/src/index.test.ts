import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Commitment, InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { CLOSED_HISTORY_LIMIT, createFsStores, initWorkspace } from './index.js';

let root: string;
let stores: ReturnType<typeof createFsStores>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'alteroid-test-'));
  stores = createFsStores(root);
});

describe('initWorkspace', () => {
  it('人格データディレクトリを生成する（受け入れ基準1）', async () => {
    const result = await initWorkspace(root);

    expect(await readdir(root)).toEqual(
      expect.arrayContaining([
        'memory',
        'journal',
        'jobs',
        'archive',
        'state',
        'auth',
        'README.md',
      ]),
    );
    expect(result.created.some((p) => p.endsWith('about-me.md'))).toBe(true);
  });

  it('二度目は既存ファイルを上書きしない（人間の編集を消さない）', async () => {
    await initWorkspace(root);
    await stores.persona.write('about-me', '# 私\n\n手で書いた内容\n');

    const second = await initWorkspace(root);

    expect(second.created).toEqual([]);
    expect((await stores.persona.read('about-me'))?.content).toContain('手で書いた内容');
  });
});

describe('FsPersonaStore', () => {
  it('書いて読める', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
  });

  it('人間がファイルを手で書き換えると次の読み出しに反映される（受け入れ基準3）', async () => {
    await stores.persona.write('values', '# 価値観\n\nもとの内容\n');

    // クローンを介さずエディタで直接書き換える、を模す
    await writeFile(join(root, 'memory', 'values.md'), '# 価値観\n\n人間が書き換えた\n', 'utf8');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    expect(await stores.persona.concat()).toContain('人間が書き換えた');
  });

  it('append は末尾に足す', async () => {
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

  it('書き込みは一時ファイル経由（人間に壊れた途中経過を読ませない）', async () => {
    await stores.persona.write('values', '# 価値観\n');

    // .tmp が残っていない = rename で置き換わっている
    expect((await readdir(join(root, 'memory'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await stores.persona.list()).toHaveLength(1);
  });

  it('存在しない記憶は null', async () => {
    expect(await stores.persona.read('nope')).toBeNull();
  });

  it('経路をまたぐスラッグを拒む', async () => {
    await expect(stores.persona.write('../escape', 'x')).rejects.toThrow(/スラッグ/);
  });

  it('concat は全文書を連結する', async () => {
    await stores.persona.write('a', '# A\n\nあ\n');
    await stores.persona.write('b', '# B\n\nい\n');

    const all = await stores.persona.concat();

    expect(all).toContain('memory: a.md');
    expect(all).toContain('memory: b.md');
  });
});

describe('FsJournalStore', () => {
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

  it('JSONL として人間が読める形で残る', async () => {
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    const files = await readdir(join(root, 'journal'));
    const raw = await readFile(join(root, 'journal', files[0] as string), 'utf8');

    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(JSON.parse(raw.trim())).toMatchObject({ type: 'decision', decision: 'd' });
  });

  it('since より古い日のファイルは読まない（日報・要約が毎回全部を読まないため）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    const journalDir = join(root, 'journal');
    // 過去の日誌を手で置く。読まれてしまうなら壊れた行で気づける。
    await writeFile(join(journalDir, '2020-01-01.jsonl'), 'これは JSON ではない\n', 'utf8');
    const old = join(journalDir, '2020-01-02.jsonl');
    await writeFile(
      old,
      `${JSON.stringify({
        type: 'decision',
        id: 'old',
        at: '2020-01-02T00:00:00.000Z',
        decision: '昔の分',
        grounds: 'g',
      })}\n`,
      'utf8',
    );

    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const entries = await stores.journal.list({ since });
    expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual(['今日の分']);

    // since を外せば古い分まで見える（打ち切りは読み飛ばしであって欠落ではない）
    expect(await stores.journal.list()).toHaveLength(2);
  });

  it('同時追記でも行が壊れない', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: `t${i}` }),
      ),
    );

    expect(await stores.journal.list()).toHaveLength(20);
  });

  it('until で窓の終端を閉じられる（新しい日のファイルを跨いで過去へ届く）', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    // 過去の1日を手で置く。**新しい日から走査が始まる**ので、`until` で
    // 打ち切る実装だとここへ辿り着けない（読み飛ばしでなければならない）。
    const journalDir = join(root, 'journal');
    await writeFile(
      join(journalDir, '2020-01-02.jsonl'),
      `${JSON.stringify({
        type: 'decision',
        id: 'old',
        at: '2020-01-02T00:00:00.000Z',
        decision: '昔の分',
        grounds: 'g',
      })}\n`,
      'utf8',
    );

    const entries = await stores.journal.list({ until: '2020-01-03T00:00:00.000Z' });
    expect(entries.map((entry) => (entry as { decision?: string }).decision)).toEqual(['昔の分']);
  });

  it('id で1件引ける（一覧を抜粋にした先の全文の行き先）', async () => {
    const entry = await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.get(entry.id)).toMatchObject({ id: entry.id, decision: 'd' });
    expect(await stores.journal.get('no-such-id')).toBeNull();
  });
});

describe('FsJobStore', () => {
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

  it('同じ id は上書きされる', async () => {
    const base = { id: 'j-1', createdAt: '2026-01-01T00:00:00.000Z', question: 'q' };
    await stores.jobs.putApproval(base);
    await stores.jobs.putApproval({ ...base, question: 'q2' });

    expect(await stores.jobs.listApprovals()).toHaveLength(1);
  });
});

describe('FsScheduleStore', () => {
  const plan = {
    kind: 'issue-round',
    spec: { type: 'daily' as const, at: '09:00' },
    request: 'open issue を見て実装を進める',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };

  it('仕込んだ依頼は読み戻せる（デーモンを作り直しても残る）', async () => {
    await stores.schedules.put(plan);

    expect(await stores.schedules.list()).toEqual([plan]);
    expect((await stores.schedules.get('issue-round'))?.request).toContain('open issue');
    expect(await stores.schedules.get('しらない')).toBeNull();
  });

  it('同じ kind は置き換わる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.put({ ...plan, request: '直した依頼' });

    const plans = await stores.schedules.list();
    expect(plans).toHaveLength(1);
    expect(plans[0]?.request).toBe('直した依頼');
  });

  it('発火を確定できる。返るのは更新前の姿（前回いつ動いたかが分かる）', async () => {
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
    // updatedAt は「依頼が書き換えられた時刻」＝版の識別子なので発火では動かない
    expect((await stores.schedules.get('issue-round'))?.updatedAt).toBe(plan.updatedAt);
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

  it('消された・書き換わった依頼は確定できない（古い本文で走らせない）', async () => {
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
    // 記録もされていない（新しい版に古い発火の跡を付けない）
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBeUndefined();
  });

  it('読んでから確定するまでに remove / put が割り込んでも、古い版では確定しない', async () => {
    await stores.schedules.put(plan);

    // 「読んだ直後に人間が消した」を、同じ排他区間へ同時に投げて作る
    const [claimedAfterRemove] = await Promise.all([
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
      stores.schedules.remove('issue-round'),
    ]);
    // どちらの順で直列化されても、「消えた後に確定した」ことにはならない
    if (claimedAfterRemove !== null) {
      expect(await stores.schedules.get('issue-round')).toBeNull();
    }

    // 「読んだ直後に人間が直した」も同様に、古い版では確定しない
    await stores.schedules.put(plan);
    const edited = { ...plan, request: '直した依頼', updatedAt: '2026-08-12T10:00:00.000Z' };
    await Promise.all([
      stores.schedules.put(edited),
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
    ]);
    const after = await stores.schedules.get('issue-round');
    expect(after?.request).toBe('直した依頼');
    expect(after?.lastRunAt).toBeUndefined();
  });

  it('同時に書いても取りこぼさない（人間の書き換えと発火の確定は並行して来る）', async () => {
    await stores.schedules.put(plan);

    await Promise.all([
      stores.schedules.put({ ...plan, kind: 'a', request: 'A の依頼' }),
      stores.schedules.put({ ...plan, kind: 'b', request: 'B の依頼' }),
      stores.schedules.claimRun(
        'issue-round',
        plan.updatedAt,
        '2026-08-13T00:00:00.000Z',
        'schedule',
      ),
      stores.schedules.remove('しらない'),
    ]);

    const plans = await stores.schedules.list();
    expect(plans.map((entry) => entry.kind)).toEqual(['a', 'b', 'issue-round']);
    expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('外せる', async () => {
    await stores.schedules.put(plan);
    await stores.schedules.remove('issue-round');

    expect(await stores.schedules.list()).toEqual([]);
  });

  it('読めない中身を「消された」に潰さない（pg 版と同じ振る舞い）', async () => {
    // 人間が手で直した・古い形が残っている、を模す
    await initWorkspace(root);
    await writeFile(
      join(root, 'jobs', 'schedules.json'),
      JSON.stringify({ schedules: [{ kind: 'broken' }] }),
      'utf8',
    );

    // null / 空配列に潰すと、クローンから見て「消された依頼」と区別が付かず、
    // 本文なしの曖昧なターンが走る（clone.ts が読取不能を分けている意味が消える）
    await expect(stores.schedules.get('broken')).rejects.toThrow();
    await expect(stores.schedules.list()).rejects.toThrow();
  });
});

/**
 * 引き受けたまま終わっていない仕事の台帳（`store.ts` の `CommitmentStore`）。
 *
 * fs / pg で同じ振る舞いになることを両方で問う（`store.ts`「省略可能にしないこと」）。
 */
describe('FsCommitmentStore', () => {
  const commitment = (id: string, at: string, body: string): Commitment => ({
    id,
    at,
    origin: 'human',
    source: 'conv-1',
    body,
  });

  it('開いた仕事は未了として読み戻せる（デーモンを作り直しても残る）', async () => {
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
    // 「閉じた」だけを残さない（何をもって終わりとしたかが無いと人間が否定できない）
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

  it('未了は古い順に返る（齢が判断の材料なので放置されているものから見せる）', async () => {
    await stores.commitments.open(commitment('c-new', '2026-08-14T00:00:00.000Z', '新しい'));
    await stores.commitments.open(commitment('c-old', '2026-08-10T00:00:00.000Z', '古い'));
    await stores.commitments.open(commitment('c-mid', '2026-08-12T00:00:00.000Z', '中'));

    expect((await stores.commitments.list()).map((entry) => entry.id)).toEqual([
      'c-old',
      'c-mid',
      'c-new',
    ]);
  });

  it('閉じたものは未了の後ろに、新しく片付いた順で続く', async () => {
    await stores.commitments.open(commitment('c-open', '2026-08-14T00:00:00.000Z', 'まだ'));
    await stores.commitments.open(commitment('c-a', '2026-08-10T00:00:00.000Z', 'A'));
    await stores.commitments.open(commitment('c-b', '2026-08-11T00:00:00.000Z', 'B'));
    await stores.commitments.close('c-a', '2026-08-12T00:00:00.000Z', 'A を片付けた');
    await stores.commitments.close('c-b', '2026-08-13T00:00:00.000Z', 'B を片付けた');

    expect(
      (await stores.commitments.list({ includeClosed: true })).map((entry) => entry.id),
    ).toEqual(['c-open', 'c-b', 'c-a']);
  });

  it('閉じた行は上限で切られるが、未了は件数によらず1件も落ちない', async () => {
    const overflow = 5;
    // 未了を先に置く（切り詰めの対象にならないことを、閉じた行が上限を超えた後で見る）
    for (let index = 0; index < 3; index += 1) {
      await stores.commitments.open(
        commitment(`open-${index}`, `2026-08-01T00:00:0${index}.000Z`, `未了 ${index}`),
      );
    }

    for (let index = 0; index < CLOSED_HISTORY_LIMIT + overflow; index += 1) {
      const id = `closed-${String(index).padStart(4, '0')}`;
      await stores.commitments.open(
        commitment(id, '2026-08-02T00:00:00.000Z', `片付ける ${index}`),
      );
      // closedAt が切り詰めの並び順を決める（古く片付いたものから落ちる）
      await stores.commitments.close(
        id,
        new Date(Date.UTC(2026, 7, 3, 0, 0, 0) + index * 1000).toISOString(),
        `片付けた ${index}`,
      );
    }

    const all = await stores.commitments.list({ includeClosed: true });
    const open = all.filter((entry) => entry.closedAt === undefined);
    const closed = all.filter((entry) => entry.closedAt !== undefined);

    // 未了は1件も切らない（切ったらこの器の目的そのものが消える）
    expect(open.map((entry) => entry.id)).toEqual(['open-0', 'open-1', 'open-2']);
    expect(closed).toHaveLength(CLOSED_HISTORY_LIMIT);
    // 落ちるのは古く片付いたものから。新しい側は残る
    expect(closed.at(0)?.id).toBe(
      `closed-${String(CLOSED_HISTORY_LIMIT + overflow - 1).padStart(4, '0')}`,
    );
    expect(closed.at(-1)?.id).toBe(`closed-${String(overflow).padStart(4, '0')}`);
    expect(await stores.commitments.get('closed-0000')).toBeNull();
  });
});

/**
 * まだ処理し終えていない受信箱の合図（デーモンが死んでも消えないこと）。
 *
 * fs / pg で同じ振る舞いになることを両方で問う（`store.ts`「省略可能にしないこと」）。
 */
describe('FsInboxStore', () => {
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
});

describe('FsTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = await stores.archive.archive('session-1', '{"a":1}\n');

    expect(await stores.archive.list()).toContain(id);
    expect(await stores.archive.read(id)).toBe('{"a":1}\n');
  });

  it('ディレクトリ外は読ませない', async () => {
    expect(await stores.archive.read('../../etc/passwd')).toBeNull();
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
describe('FsProfileStore', () => {
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

describe('FsSessionRegistry', () => {
  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
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
