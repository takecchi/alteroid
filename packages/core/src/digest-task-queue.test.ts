import { describe, expect, it } from 'vitest';

import { buildActivityDigest, DIGEST_COUNTS_LINE_HEAD, foldDigestCountsLine } from './digest.js';
import { DigestSessionDelta } from './digest-session-delta.js';
import { SELF_INITIATIVE_INSTRUCTIONS } from './prompt.js';
import type { Task } from './schema.js';
import type { Stores, TaskList } from './store.js';
import {
  describeTaskQueueCount,
  describeTaskQueueHead,
  TASK_QUEUE_HEAD_LIMIT,
} from './task-tools.js';
import { createMemoryStores } from './testing.js';

// #5469 P6b: 発意 tick の入力に待ち行列の先頭（件数1行＋先頭3件＋案内1行）を載せ、digest から台帳の2節・件数の4項目・固定注記を消す

let tick = 0;
function makeTask(id: string, over: Partial<Task> = {}): Task {
  tick += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
  return {
    id,
    createdAt: at,
    updatedAt: at,
    status: 'queued',
    origin: 'self',
    title: `title-${id}`,
    body: `body-${id}`,
    ...over,
  };
}

const list = (entries: Task[], unreadable: TaskList['unreadable'] = []): TaskList => ({
  entries,
  unreadable,
});

describe('describeTaskQueueHead（純関数）', () => {
  it('件数の1行に、開いている件の合計と状態別の内訳が出る', () => {
    const entries = [
      makeTask('a', { status: 'needs_decision' }),
      makeTask('b'),
      makeTask('c'),
      makeTask('d', { status: 'waiting' }),
    ];
    expect(describeTaskQueueCount(list(entries))).toBe(
      '待ち行列: 開いている 4 件（queued 2 / waiting 1 / needs_decision 1）',
    );
  });

  it('先頭 limit 件を、渡された並びのまま（id・状態・origin・title）出し、並べ直さない', () => {
    // id の辞書順・状態の順・作成順のどれとも違う並びを渡す
    const entries = [
      makeTask('z-last-id', { origin: 'human', status: 'waiting' }),
      makeTask('m', { origin: 'manager' }),
      makeTask('a-first-id', { origin: 'external', status: 'needs_decision' }),
      makeTask('k'),
      makeTask('b'),
    ];
    const lines = describeTaskQueueHead(list(entries), { limit: 3 });
    expect(lines).toEqual([
      '- 待ち行列: 開いている 5 件（queued 3 / waiting 1 / needs_decision 1）',
      '- z-last-id（状態: waiting（待ち（外の返事・時間待ち）） / origin: human）title-z-last-id',
      '- m（状態: queued（待ち行列） / origin: manager）title-m',
      '- a-first-id（状態: needs_decision（決めてほしい） / origin: external）title-a-first-id',
      '- …ほか 2 件（task_list で全部見える）',
      '（先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）',
    ]);
  });

  it('limit 以下なら省略の行は出ない', () => {
    const lines = describeTaskQueueHead(list([makeTask('a'), makeTask('b')]), { limit: 3 });
    expect(lines.some((line) => line.startsWith('- …ほか'))).toBe(false);
    expect(
      lines.filter((line) => line.startsWith('- a（') || line.startsWith('- b（')),
    ).toHaveLength(2);
  });

  it('0件のときは件数の行だけで、先頭も案内も出さない', () => {
    expect(describeTaskQueueHead(list([]), { limit: 3 })).toEqual([
      '- 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）',
    ]);
  });

  it('読めない行は 0 に丸めず、件数で断る（開いている件数には入れない。終わったのではない）', () => {
    const lines = describeTaskQueueHead(
      list([makeTask('a')], [{ id: 'broken-1', reason: '不正な欄' }, { reason: 'id も無い' }]),
      { limit: 3 },
    );
    expect(lines[0]).toBe('- 待ち行列: 開いている 1 件（queued 1 / waiting 0 / needs_decision 0）');
    expect(lines[1]).toBe(
      '- 読めない task の行が 2 件ある（上の件数には入っていない。終わったのではない）',
    );
    // 読めない行の id・本文は出さない（件数だけ。1行のまま伸びない）
    expect(lines.join('\n')).not.toContain('broken-1');
  });

  it('読めない行だけ在って開いている件が0なら、0件の行と断りの両方が出る', () => {
    const lines = describeTaskQueueHead(list([], [{ reason: '不正' }]), { limit: 3 });
    expect(lines).toEqual([
      '- 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）',
      '- 読めない task の行が 1 件ある（上の件数には入っていない。終わったのではない）',
    ]);
  });

  describe('先頭が waiting だけで埋まるとき（task_set_status で waiting にしても rank は動かない）', () => {
    const waiting = (id: string) => makeTask(id, { status: 'waiting' });

    it('⭐ 表示した先頭に queued も needs_decision も無ければ、最初の動ける1件を「先頭から離れている」断り付きで足す', () => {
      const entries = [
        waiting('w1'),
        waiting('w2'),
        waiting('w3'),
        waiting('w4'),
        makeTask('q1'),
        makeTask('q2'),
        makeTask('n1', { status: 'needs_decision' }),
      ];
      const lines = describeTaskQueueHead(list(entries), { limit: 3 });
      const extra = lines.filter((line) => line.includes('先頭から離れている'));
      expect(extra).toHaveLength(1);
      expect(extra[0]).toContain('q1（状態: queued');
      // 先頭の3件は waiting のまま、足した1件の分だけ「ほか」が減る（7 - 3 - 1 = 3）
      expect(lines).toContain('- …ほか 3 件（task_list で全部見える）');
      expect(lines.join('\n')).not.toContain('- q2（');
    });

    it('needs_decision が最初の動ける件なら、それを足す', () => {
      const entries = [
        waiting('w1'),
        waiting('w2'),
        waiting('w3'),
        makeTask('n1', { status: 'needs_decision' }),
      ];
      const lines = describeTaskQueueHead(list(entries), { limit: 3 });
      expect(lines.find((line) => line.includes('先頭から離れている'))).toContain('n1（');
      expect(lines.some((line) => line.startsWith('- …ほか'))).toBe(false);
    });

    it('先頭3件に queued か needs_decision が1件でも在れば、足さない', () => {
      const entries = [waiting('w1'), makeTask('q1'), waiting('w2'), makeTask('q2')];
      const lines = describeTaskQueueHead(list(entries), { limit: 3 });
      expect(lines.join('\n')).not.toContain('先頭から離れている');
    });

    it('動ける件が無ければ（全部 waiting）、足さない', () => {
      const entries = [waiting('w1'), waiting('w2'), waiting('w3'), waiting('w4')];
      const lines = describeTaskQueueHead(list(entries), { limit: 3 });
      expect(lines.join('\n')).not.toContain('先頭から離れている');
      expect(lines).toContain('- …ほか 1 件（task_list で全部見える）');
    });
  });

  it('閉じた件（done / cancelled）は数えず、先頭にも出さない', () => {
    const entries = [
      makeTask('open-1'),
      makeTask('done-1', { status: 'done', closedAt: '2026-01-02T00:00:00.000Z' }),
      makeTask('cancelled-1', { status: 'cancelled', closedAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const lines = describeTaskQueueHead(list(entries), { limit: 3 });
    expect(lines[0]).toContain('開いている 1 件');
    expect(lines.join('\n')).not.toContain('done-1');
    expect(lines.join('\n')).not.toContain('cancelled-1');
  });

  it('title は1行に畳み、長ければ切る（先頭の描画が伸びない）', () => {
    const lines = describeTaskQueueHead(
      list([makeTask('a', { title: `改行\nを含む ${'長い'.repeat(200)}` })]),
      { limit: 3 },
    );
    const row = lines.find((line) => line.startsWith('- a（')) ?? '';
    expect(row).not.toContain('\n');
    expect(row.length).toBeLessThan(260);
  });
});

async function seedTasks(stores: Stores, entries: Task[]): Promise<void> {
  for (const entry of entries) await stores.tasks.add(entry);
}

const since = () => new Date(Date.now() - 60_000);

describe('digest の待ち行列の先頭の節（full 形）', () => {
  it('先頭 3 件を stores.tasks.list() の並びのまま出し、並べ替え（task_move）は次の digest に反映される', async () => {
    const stores = createMemoryStores();
    await seedTasks(stores, [
      makeTask('t1'),
      makeTask('t2'),
      makeTask('t3'),
      makeTask('t4'),
      makeTask('t5'),
    ]);

    const before = await buildActivityDigest(stores, { since: since() });
    const rowsOf = (digest: string): string[] =>
      digest.split('\n').filter((line) => /^- t\d（/u.test(line));
    expect(rowsOf(before).map((line) => line.slice(0, 5))).toEqual(['- t1（', '- t2（', '- t3（']);
    expect(before).toContain('- …ほか 2 件（task_list で全部見える）');
    expect(before).toContain('開いている 5 件（queued 5 / waiting 0 / needs_decision 0）');

    await stores.tasks.move('t5', { kind: 'front' });
    const after = await buildActivityDigest(stores, { since: since() });
    expect(rowsOf(after).map((line) => line.slice(0, 5))).toEqual(['- t5（', '- t1（', '- t2（']);
  });

  it('先頭件数は TASK_QUEUE_HEAD_LIMIT（3）', () => {
    expect(TASK_QUEUE_HEAD_LIMIT).toBe(3);
  });

  it('待ち行列が空でも節と件数の行は出る（0 は「無かった」という情報）', async () => {
    const digest = await buildActivityDigest(createMemoryStores(), { since: since() });
    expect(digest).toContain(
      '## 待ち行列の先頭\n- 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）',
    );
    expect(digest).not.toContain('先頭が先にやるもの');
  });

  it('読めない task の行は件数で断る', async () => {
    const stores = createMemoryStores();
    const original = stores.tasks.list.bind(stores.tasks);
    stores.tasks.list = async (options) => ({
      ...(await original(options)),
      unreadable: [{ id: 'broken-task', reason: '不正な欄' }],
    });

    const digest = await buildActivityDigest(stores, { since: since() });
    expect(digest).toContain(
      '- 読めない task の行が 1 件ある（上の件数には入っていない。終わったのではない）',
    );
  });
});

describe('digest から台帳の節・注記・件数の4項目が消えている', () => {
  async function ledgerStores(): Promise<Stores> {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.commitments.open({
      id: 'cm-open',
      at: now,
      origin: 'human',
      body: '開いている台帳の行',
    });
    await stores.commitments.open({
      id: 'cm-done',
      at: now,
      origin: 'human',
      body: '片付けた台帳の行',
    });
    await stores.commitments.close('cm-done', now, '済んだ理由', 'clone');
    return stores;
  }

  it('節（引き受けたまま終わっていない仕事・この期間に片付けた仕事）も、順序の固定注記も出ない', async () => {
    const digest = await buildActivityDigest(await ledgerStores(), { since: since() });
    expect(digest).not.toContain('## 引き受けたまま終わっていない仕事');
    expect(digest).not.toContain('## この期間に片付けた仕事');
    expect(digest).not.toContain('順序はここには無い');
    expect(digest).not.toContain('開いている台帳の行');
    expect(digest).not.toContain('片付けた台帳の行');
    expect(digest).not.toContain('済んだ理由');
    expect(digest).not.toMatch(/未了の仕事|片付けた仕事|読めない未了の行|物理削除された/u);
  });

  const LEGACY_HEAD = '- 旧台帳に開いている ';
  const legacyLines = (digest: string): string[] =>
    digest.split('\n').filter((line) => line.startsWith(LEGACY_HEAD));

  it('旧台帳に開いている行があるとき: 件数の1行だけが出る（節ではない）', async () => {
    const digest = await buildActivityDigest(await ledgerStores(), { since: since() });
    expect(legacyLines(digest)).toEqual([
      '- 旧台帳に開いている 1 件は未了で、Task に同じ id が無い。中身は `commitment_list` で読む（人間の依頼は同じ id で Task にも載り、返答で task が done になっても台帳の行は開いたままなので、数えない。数えるのは task の無い行: 人間の回答・自分の記帳・蒸留の未了の問いなど）',
    ]);
  });

  it('旧台帳に開いている行も読めない行も無いとき: 1行も出ない', async () => {
    const stores = createMemoryStores();
    await stores.commitments.open({
      id: 'c',
      at: new Date().toISOString(),
      origin: 'human',
      body: 'x',
    });
    await stores.commitments.close('c', new Date().toISOString(), 'y', 'clone');
    expect(await buildActivityDigest(stores, { since: since() })).not.toContain('旧台帳');
    expect(await buildActivityDigest(createMemoryStores(), { since: since() })).not.toContain(
      '旧台帳',
    );
  });

  it('⭐ 人間の依頼が台帳と Task に同じ id で載るとき、task が done でも数えない。task の無い台帳の行は数える', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    // 返答で task だけが done になり、台帳の行は開いたまま
    await stores.commitments.open({
      id: 'h-done',
      at: now,
      origin: 'human',
      body: '返答済みの依頼',
    });
    await stores.tasks.add(makeTask('h-done', { origin: 'human', status: 'done', closedAt: now }));
    // task がまだ開いている人間の依頼
    await stores.commitments.open({ id: 'h-open', at: now, origin: 'human', body: '続く依頼' });
    await stores.tasks.add(makeTask('h-open', { origin: 'human' }));
    // task の無い行（人間の回答・自分の記帳など）は数える
    await stores.commitments.open({
      id: 'only-ledger',
      at: now,
      origin: 'human',
      body: '台帳だけ',
    });

    const digest = await buildActivityDigest(stores, { since: since() });
    expect(legacyLines(digest)).toHaveLength(1);
    expect(legacyLines(digest)[0]).toContain(
      '- 旧台帳に開いている 1 件は未了で、Task に同じ id が無い。',
    );
  });

  it('台帳の開いている行がすべて同じ id の task を持つなら、1行も出ない', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.commitments.open({ id: 'h1', at: now, origin: 'human', body: '依頼' });
    await stores.tasks.add(makeTask('h1', { origin: 'human', status: 'done', closedAt: now }));
    expect(await buildActivityDigest(stores, { since: since() })).not.toContain('旧台帳');
  });

  it('読めない行だけのとき: 0件で丸めず、読めない件数を断って出る', async () => {
    const stores = createMemoryStores();
    const original = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => ({
      ...(await original(options)),
      unreadable: [{ id: 'cm-broken', at: new Date().toISOString(), reason: '壊れている' }],
    });
    const digest = await buildActivityDigest(stores, { since: since() });
    expect(legacyLines(digest)).toEqual([
      '- 旧台帳に開いている 0 件は未了で、Task に同じ id が無い。読めない行が 1 件ある（片付いたのではない）。中身は `commitment_list` で読む（人間の依頼は同じ id で Task にも載り、返答で task が done になっても台帳の行は開いたままなので、数えない。数えるのは task の無い行: 人間の回答・自分の記帳・蒸留の未了の問いなど）',
    ]);
    expect(digest).not.toContain('cm-broken');
  });
});

describe('counts 形（定期の依頼の tick・日報以外の件数の形）は、待ち行列の件数の1行だけ', () => {
  it('先頭の描画（task の行・案内・節）は出さず、旧台帳は件数の1行', async () => {
    const stores = createMemoryStores();
    await seedTasks(stores, [
      makeTask('t1', { status: 'needs_decision', origin: 'human' }),
      makeTask('t2'),
    ]);
    await stores.commitments.open({
      id: 'cm-1',
      at: new Date().toISOString(),
      origin: 'human',
      body: '台帳の本文',
    });

    const counts = await buildActivityDigest(stores, { since: since() }, undefined, undefined, {
      shape: 'counts',
    });

    expect(counts).toContain(
      '- 待ち行列: 開いている 2 件（queued 1 / waiting 0 / needs_decision 1）',
    );
    expect(counts).not.toContain('- t1（');
    expect(counts).not.toContain('先頭が先にやるもの');
    expect(counts).not.toContain('## 待ち行列');
    expect(counts).toContain('- 旧台帳に開いている 1 件は未了で、Task に同じ id が無い。');
    expect(counts).not.toContain('台帳の本文');
    expect(counts).not.toMatch(/引き受けた仕事 \d|片付けた仕事/u);
  });

  it('読めない task の行は、件数の形の「読めない行」の行に載る。旧台帳の読めない行は旧台帳の1行が持つ', async () => {
    const stores = createMemoryStores();
    const original = stores.tasks.list.bind(stores.tasks);
    stores.tasks.list = async (options) => ({
      ...(await original(options)),
      unreadable: [{ reason: '壊れている' }],
    });
    const counts = await buildActivityDigest(stores, { since: since() }, undefined, undefined, {
      shape: 'counts',
    });
    expect(counts).toContain(
      '- 読めない行（壊れた行。上の件数には入っていない）: 待ち行列の task 1',
    );
  });
});

// 件数の行は位置（`countItem(0..9)`）と表（`COUNT_ITEMS`）で対応する。台帳の4項目（10〜13）を消すとき、表と行の組み立てのどちらかだけを直すと、
// `foldDigestCountsLine` が「項目数が違う」と判定して null を返し、2回目以降の畳みが静かに効かなくなる（落ちずに全文のまま出る）。それを測る
describe('件数の行の位置の対応（#4937 の畳みが項目を消しても壊れない）', () => {
  const countsLineOf = (digest: string): string =>
    digest.split('\n').find((line) => line.startsWith(DIGEST_COUNTS_LINE_HEAD)) ?? '';

  it('⭐ buildActivityDigest が組んだ件数の行は、foldDigestCountsLine が畳める（表と行の項目数・並びが合っている）', async () => {
    const digest = await buildActivityDigest(createMemoryStores(), { since: since() });
    const line = countsLineOf(digest);
    expect(line.split(' / ')).toHaveLength(10);
    expect(foldDigestCountsLine(line)).toBe('- 件数: すべて 0（項目は会話の上の件数の行と同じ）');
  });

  it('⭐ 0 でない項目は、位置がずれずに正しい項目名で残る（継続中の依頼は末尾の項目）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'k',
      spec: { type: 'daily', at: '09:00' },
      request: 'r',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await stores.jobs.putApproval({ id: 'ap', createdAt: new Date().toISOString(), question: 'q' });
    const line = countsLineOf(await buildActivityDigest(stores, { since: since() }));
    expect(foldDigestCountsLine(line)).toBe(
      '- 件数（項目は会話の上の件数の行と同じ。載せていない項目は 0）: 回答待ち 1 / 継続中の依頼 1',
    );
  });

  it('⭐ 同じ会話の2回目の digest は、件数の行が項目名の参照になり、待ち行列の先頭は毎回全文のまま', async () => {
    const stores = createMemoryStores();
    await seedTasks(stores, [makeTask('t1'), makeTask('t2')]);
    const delta = new DigestSessionDelta();

    const first = await buildActivityDigest(stores, { since: since() });
    expect(delta.renderDigest(first, new Date()).text).toContain(countsLineOf(first));
    delta.commit();

    await stores.tasks.move('t2', { kind: 'front' });
    const second = await buildActivityDigest(stores, { since: since() });
    const rendered = delta.renderDigest(second, new Date()).text;

    expect(rendered).toContain('- 件数: すべて 0（項目は会話の上の件数の行と同じ）');
    expect(rendered).not.toContain(countsLineOf(second));
    // 先頭が入れ替わったことが、畳まれずに出る
    const rows = rendered.split('\n').filter((line) => /^- t\d（/u.test(line));
    expect(rows.map((line) => line.slice(0, 5))).toEqual(['- t2（', '- t1（']);
    expect(rendered).not.toMatch(/変わらない節: .*待ち行列/u);
  });

  it('台帳の4項目の消し忘れを、表の側から測る: 件数の行の項目名に台帳の語が無い', async () => {
    const line = countsLineOf(await buildActivityDigest(createMemoryStores(), { since: since() }));
    for (const gone of [
      '未了の仕事',
      '片付けた仕事',
      '読めない未了の行',
      '物理削除された片付き行',
    ]) {
      expect(line).not.toContain(gone);
    }
  });
});

describe('発意 tick の固定の指示（SELF_INITIATIVE_INSTRUCTIONS）', () => {
  it('待ち行列の先頭から始める形で、並べ替え・状態の変更の道具を名指す', () => {
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('待ち行列の先頭');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('先頭から始める');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`task_move`');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`task_set_status`');
    // 「何もしないという結論でよい」を落とさない（無理に仕事を作らせない）
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('何もしないという結論でよい');
  });

  it('⭐ 旧台帳に開いている行の扱い（commitment_list で読む）と、先頭が待ちばかりのときの添え書きを言う', () => {
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('旧台帳に開いている');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`commitment_list`');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('離れた所の動ける task');
  });

  it('⭐ 委譲するとき task の id を manager_start の taskId に渡す（渡さないと先頭に残って二重に委譲しうる）', () => {
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`manager_start`');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`taskId`');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('もう一本委譲しうる');
  });

  it('長さは前の版（約 400 字）と同程度に保つ', () => {
    // 旧台帳の行の扱い・離れた task の添え書き・taskId を渡す指示（各1行）を足したぶん広げた
    expect(SELF_INITIATIVE_INSTRUCTIONS.length).toBeLessThan(900);
  });
});
