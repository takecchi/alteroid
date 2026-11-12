import { describe, expect, it } from 'vitest';

import { buildActivityDigest, DIGEST_COUNTS_LINE_HEAD } from './digest.js';
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

// 滞留の行（waiting / needs_decision の件数と最古の古さ。task-queue-backlog-age.test.ts が逐語を持つ）の古さの基準時刻。ここは先頭の行の描き方を見る試験で、古さの文字列は固定しない
const HEAD_OPTIONS = { limit: 3, nowMs: Date.UTC(2026, 0, 2, 0, 0, 0) };

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
    const lines = describeTaskQueueHead(list(entries), HEAD_OPTIONS);
    // 動いた理由: waiting / needs_decision を含む並びなので、件数の行の次に滞留の1行が入る（逐語は task-queue-backlog-age.test.ts）。それ以外の行は従来のまま
    const backlog = lines.filter((line) => line.startsWith('- 滞留: '));
    expect(backlog).toHaveLength(1);
    expect(lines.filter((line) => !line.startsWith('- 滞留: '))).toEqual([
      '- 待ち行列: 開いている 5 件（queued 3 / waiting 1 / needs_decision 1）',
      '- z-last-id（状態: waiting（待ち（外の返事・時間待ち）） / origin: human）title-z-last-id',
      '- m（状態: queued（待ち行列） / origin: manager）title-m',
      '- a-first-id（状態: needs_decision（決めてほしい） / origin: external）title-a-first-id',
      '- …ほか 2 件（task_list で全部見える）',
      '（先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）',
    ]);
  });

  it('limit 以下なら省略の行は出ない', () => {
    const lines = describeTaskQueueHead(list([makeTask('a'), makeTask('b')]), HEAD_OPTIONS);
    expect(lines.some((line) => line.startsWith('- …ほか'))).toBe(false);
    expect(
      lines.filter((line) => line.startsWith('- a（') || line.startsWith('- b（')),
    ).toHaveLength(2);
  });

  it('0件のときは件数の行だけで、先頭も案内も出さない', () => {
    expect(describeTaskQueueHead(list([]), HEAD_OPTIONS)).toEqual([
      '- 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）',
    ]);
  });

  it('読めない行は 0 に丸めず、件数で断る（開いている件数には入れない。終わったのではない）', () => {
    const lines = describeTaskQueueHead(
      list([makeTask('a')], [{ id: 'broken-1', reason: '不正な欄' }, { reason: 'id も無い' }]),
      HEAD_OPTIONS,
    );
    expect(lines[0]).toBe('- 待ち行列: 開いている 1 件（queued 1 / waiting 0 / needs_decision 0）');
    expect(lines[1]).toBe(
      '- 読めない task の行が 2 件ある（上の件数には入っていない。終わったのではない）',
    );
    // 読めない行の id・本文は出さない（件数だけ。1行のまま伸びない）
    expect(lines.join('\n')).not.toContain('broken-1');
  });

  it('読めない行だけ在って開いている件が0なら、0件の行と断りの両方が出る', () => {
    const lines = describeTaskQueueHead(list([], [{ reason: '不正' }]), HEAD_OPTIONS);
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
      const lines = describeTaskQueueHead(list(entries), HEAD_OPTIONS);
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
      const lines = describeTaskQueueHead(list(entries), HEAD_OPTIONS);
      expect(lines.find((line) => line.includes('先頭から離れている'))).toContain('n1（');
      expect(lines.some((line) => line.startsWith('- …ほか'))).toBe(false);
    });

    it('先頭3件に queued か needs_decision が1件でも在れば、足さない', () => {
      const entries = [waiting('w1'), makeTask('q1'), waiting('w2'), makeTask('q2')];
      const lines = describeTaskQueueHead(list(entries), HEAD_OPTIONS);
      expect(lines.join('\n')).not.toContain('先頭から離れている');
    });

    it('動ける件が無ければ（全部 waiting）、足さない', () => {
      const entries = [waiting('w1'), waiting('w2'), waiting('w3'), waiting('w4')];
      const lines = describeTaskQueueHead(list(entries), HEAD_OPTIONS);
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
    const lines = describeTaskQueueHead(list(entries), HEAD_OPTIONS);
    expect(lines[0]).toContain('開いている 1 件');
    expect(lines.join('\n')).not.toContain('done-1');
    expect(lines.join('\n')).not.toContain('cancelled-1');
  });

  it('title は1行に畳み、長ければ切る（先頭の描画が伸びない）', () => {
    const lines = describeTaskQueueHead(
      list([makeTask('a', { title: `改行\nを含む ${'長い'.repeat(200)}` })]),
      HEAD_OPTIONS,
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

describe('digest に旧台帳の節・件数の行は出ない（台帳の撤去。待ち行列だけを数える）', () => {
  it('task を積んだ digest にも counts 形にも「旧台帳」「commitment_list」が出ない', async () => {
    const stores = createMemoryStores();
    await seedTasks(stores, [makeTask('t1', { origin: 'human' })]);

    const digest = await buildActivityDigest(stores, { since: since() });
    const counts = await buildActivityDigest(stores, { since: since() }, undefined, undefined, {
      shape: 'counts',
    });

    for (const text of [digest, counts]) {
      expect(text).not.toContain('旧台帳');
      expect(text).not.toContain('commitment_list');
    }
  });
});

describe('counts 形（定期の依頼の tick・日報以外の件数の形）は、待ち行列の件数の1行だけ', () => {
  it('先頭の描画（task の行・案内・節）は出さず、件数の1行だけ', async () => {
    const stores = createMemoryStores();
    await seedTasks(stores, [
      makeTask('t1', { status: 'needs_decision', origin: 'human' }),
      makeTask('t2'),
    ]);

    const counts = await buildActivityDigest(stores, { since: since() }, undefined, undefined, {
      shape: 'counts',
    });

    expect(counts).toContain(
      '- 待ち行列: 開いている 2 件（queued 1 / waiting 0 / needs_decision 1）',
    );
    expect(counts).not.toContain('- t1（');
    expect(counts).not.toContain('先頭が先にやるもの');
    expect(counts).not.toContain('## 待ち行列');
    expect(counts).not.toMatch(/引き受けた仕事 \d|片付けた仕事/u);
  });

  it('読めない task の行は、件数の形の「読めない行」の行に載る', async () => {
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

// 件数の行は位置（`countItem(0..9)`）と表（`COUNT_ITEMS`）で対応する。台帳の4項目（10〜13）を消すとき、表と行の組み立てのどちらかだけを直すと項目の数や並びがずれる。それを測る
describe('件数の行の位置の対応', () => {
  const countsLineOf = (digest: string): string =>
    digest.split('\n').find((line) => line.startsWith(DIGEST_COUNTS_LINE_HEAD)) ?? '';

  it('⭐ buildActivityDigest が組んだ件数の行は10項目で、継続中の依頼は末尾の項目', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'k',
      spec: { type: 'daily', at: '09:00' },
      request: 'r',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await stores.jobs.putApproval({ id: 'ap', createdAt: new Date().toISOString(), question: 'q' });
    const parts = countsLineOf(await buildActivityDigest(stores, { since: since() })).split(' / ');
    expect(parts).toHaveLength(10);
    expect(parts[1]).toBe('回答待ち 1');
    expect(parts[9]).toBe('継続中の依頼 1');
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

  it('⭐ 先頭が待ちばかりのときの添え書きを言い、旧台帳の扱いは言わない', () => {
    expect(SELF_INITIATIVE_INSTRUCTIONS).not.toContain('旧台帳');
    expect(SELF_INITIATIVE_INSTRUCTIONS).not.toContain('commitment_list');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('離れた所の動ける task');
  });

  it('⭐ 委譲するとき task の id を manager_start の taskId に渡す（渡さないと先頭に残って二重に委譲しうる）', () => {
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`manager_start`');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`taskId`');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('もう一本委譲しうる');
  });

  it('⭐ 先頭が古い・重複している自分の task は、理由を書いて閉じ、溜まっていれば task_set_status_many でまとめて閉じる', () => {
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('重複している');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('cancelled');
    expect(SELF_INITIATIVE_INSTRUCTIONS).toContain('`task_set_status_many`');
  });

  it('長さは前の版（約 400 字）と同程度に保つ', () => {
    // 離れた task の添え書き・taskId を渡す指示（各1行）を足したぶん広げた。
    // さらに、溜まった自分の task を閉じる促し（1行・約 165 字、計 920 字）を足したので 1000 にした
    expect(SELF_INITIATIVE_INSTRUCTIONS.length).toBeLessThan(1000);
  });
});
