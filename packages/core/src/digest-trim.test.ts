import { describe, expect, it } from 'vitest';

import { buildActivityDigest, DIGEST_COUNTS_TOOLS_NOTE } from './digest.js';
import { buildSelfInitiativePrompt, buildTimerPrompt } from './prompt.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// #4938 の案1（担当の節を手を動かしているものに絞る）・案2（定期の tick には担当の節と継続中の依頼の節だけ中身ごと出し、他は件数の行）の測定。
// 道具立ては #4937 と同じ（担当30本・継続中の依頼10本・記憶の更新50件・回答待ち4件・外部イベント20件・引き受けた仕事14件）。

const STATUS_MIX = [
  ...Array.from({ length: 4 }, () => 'running' as const),
  'waiting_human' as const,
  'failed' as const,
  'lost' as const,
  ...Array.from({ length: 23 }, () => 'done' as const),
];

async function seedLikeIssue(stores: Stores): Promise<void> {
  const now = new Date().toISOString();
  for (const [i, status] of STATUS_MIX.entries()) {
    await stores.jobs.putJob({
      id: `mgr-${String(i).padStart(3, '0')}`,
      createdAt: now,
      updatedAt: now,
      status,
      summary: `担当 ${i} の仕事`,
      request: `担当 ${i} の仕事。${'依頼の説明が続く。'.repeat(8)}`,
      lastReport: `担当 ${i} の途中経過。${'報告の本文が続く。'.repeat(10)}`,
    });
  }
  for (let i = 0; i < 14; i += 1) {
    await stores.commitments.open({
      id: `cm-${i}`,
      at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString(),
      origin: 'human',
      body: `引き受けた仕事 ${i}。${'本文が続く。'.repeat(20)}`,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    await stores.jobs.putApproval({
      id: `ap-${i}`,
      createdAt: now,
      question: `人間への問い ${i}。${'確かめたいことが続く。'.repeat(6)}`,
    });
  }
  for (let i = 0; i < 20; i += 1) {
    await stores.journal.append({
      type: 'external_event',
      source: i % 2 === 0 ? 'github' : 'ci',
      summary: `届いた出来事 ${i}。${'要旨が続く。'.repeat(8)}`,
    });
  }
  for (let i = 0; i < 50; i += 1) {
    await stores.journal.append({
      type: 'memory_update',
      slug: `fact-${i}`,
      cause: 'clone',
      action: 'write',
      bytesBefore: i,
      bytesAfter: i + 10,
      summary: `記憶を直した ${i}。${'内容が続く。'.repeat(6)}`,
    });
  }
  for (let i = 0; i < 10; i += 1) {
    await stores.schedules.put({
      kind: `standing-${i}`,
      spec: { type: 'daily', at: '09:00' },
      request: `継続中の依頼 ${i}。${'依頼の本文が続く。'.repeat(12)}`,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
  }
}

function sectionOf(digest: string, heading: string): string {
  const start = digest.indexOf(heading);
  if (start === -1) return '';
  const rest = digest.slice(start);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}

const window = () => ({ since: new Date(Date.now() - 60_000) });

describe('マネージャーの節は、手を動かしている担当だけを1本ずつ出す（#4938 の案1）', () => {
  it('done・stopped は本数と id だけの1行になり、依頼と報告の本文は載らない', async () => {
    const stores = createMemoryStores();
    await seedLikeIssue(stores);
    await stores.jobs.putJob({
      id: 'mgr-stopped',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'stopped',
      summary: '止めた担当',
      request: '止めた担当の依頼の本文',
      lastReport: '止めた担当の報告の本文',
    });

    const digest = await buildActivityDigest(stores, window());
    const section = sectionOf(digest, '## マネージャー');

    // done 23 本 + stopped 1 本。id は `MAX_ITEMS`（15）まで、残りは件数だけ
    const folded = section.split('\n').filter((line) => line.startsWith('- 手が止まっている担当'));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatch(/^- 手が止まっている担当（done・stopped）24 本: /u);
    expect(folded[0]).toContain('…ほか 9 件');
    expect(folded[0]?.split(', ')).toHaveLength(15);
    expect(section).toContain(
      '依頼と直近の報告は、ここには載せていない。`manager_list`（`q` で依頼文から探せる）/ `manager_report`（依頼文・報告の全文）で引ける。',
    );
    // done・stopped の依頼と報告は載らない
    expect(section).not.toContain('担当 10 の途中経過');
    expect(section).not.toMatch(/- mgr-010 \[/u);
    expect(section).not.toContain('止めた担当の報告の本文');
    // 前置きの本数は今どおり（畳んだ分も数える）
    expect(digest).toContain('- マネージャーへの委譲（この期間に動いたもの）: 31 本');
  });

  it('running・返事待ち・failed・lost は今どおり1本ずつ、依頼と直近の報告つきで出る', async () => {
    const stores = createMemoryStores();
    await seedLikeIssue(stores);

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');

    for (const [i, status] of STATUS_MIX.entries()) {
      if (status === 'done') continue;
      const id = `mgr-${String(i).padStart(3, '0')}`;
      expect(section).toMatch(
        new RegExp(`- ${id} \\[${status}/セッション不明\\] 担当 ${i} の仕事`, 'u'),
      );
      expect(section).toContain(`直近の報告: 担当 ${i} の途中経過`);
    }
  });

  it('done でも、直近のターンが失敗で終わっている・背景処理を待っているものは1本ずつ出る', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-done-failed-turn',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      summary: '失敗で終わった回',
      lastFailure: { code: 'sentinel-code', via: 'sentinel-via', at: now },
    });
    await stores.jobs.putJob({
      id: 'mgr-done-background',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      summary: '背景処理を待っている',
    });
    await stores.jobs.putJob({
      id: 'mgr-done-plain',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      summary: '終わった',
    });

    const digest = await buildActivityDigest(
      stores,
      window(),
      undefined,
      new Map([
        [
          'mgr-done-background',
          { tasks: 2, withheldReports: 0, breakdown: '', since: '2026-10-16T00:00:00.000Z' },
        ],
      ]),
    );

    expect(digest).toContain('- mgr-done-failed-turn [done/セッション不明] 失敗で終わった回');
    expect(digest).toContain('sentinel-code');
    expect(digest).toContain('- mgr-done-background [done/セッション不明/背景処理待ち×2');
    expect(digest).toContain('- 手が止まっている担当（done・stopped）1 本: mgr-done-plain');
  });
});

describe('件数の形の要約（#4938 の案2）', () => {
  it('担当の節と継続中の依頼の節は中身つきで出し、他の節は件数の行だけにする', async () => {
    const stores = createMemoryStores();
    await seedLikeIssue(stores);

    const full = await buildActivityDigest(stores, window());
    const counts = await buildActivityDigest(stores, window(), undefined, undefined, {
      shape: 'counts',
    });

    // 出す節は、全体の形と同じ文面（同じ担当が別の言い方で出ない）
    expect(sectionOf(counts, '## マネージャー')).toBe(sectionOf(full, '## マネージャー'));
    expect(sectionOf(counts, '## 継続中の依頼')).toBe(sectionOf(full, '## 継続中の依頼'));
    expect(counts).toMatch(/- mgr-000 \[running\/セッション不明\] 担当 0 の仕事/u);
    expect(counts).toContain('直近の報告: 担当 0 の途中経過');
    expect(counts).toContain('- standing-0（');
    expect(counts).toContain('継続中の依頼 0。');
    // 他の節は見出しごと無く、件数の行だけが残る
    const headings = counts.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual([
      expect.stringContaining('## 継続中の依頼'),
      expect.stringContaining('## マネージャー'),
    ]);
    expect(counts).not.toContain('人間への問い 0');
    expect(counts).not.toContain('引き受けた仕事 0。');
    expect(counts).not.toContain('記憶を直した 0');
    expect(counts).not.toContain('届いた出来事 0');
    expect(counts).toContain(
      '- 引き受けた仕事 14 / 回答待ち 4 / エスカレーション 0 / 聞かずに決めたこと 0' +
        ' / 記憶の更新 50 / 外部イベント 20 / 片付けた仕事 0 / 人間からの発言 0',
    );
    // 中身を出した2節と重なる数（担当の status 別・継続中の依頼の数）は、件数の行に重ねない
    expect(counts).not.toContain('担当 running');
    expect(counts).not.toMatch(/継続中の依頼 \d+ \//u);
    expect(counts).toContain(DIGEST_COUNTS_TOOLS_NOTE);
    expect(counts).not.toContain('読めない行');
  });

  it('読めない行の件数は、中身を出さない節の分だけ件数の行の後ろに残る', async () => {
    const stores = createMemoryStores();
    await seedLikeIssue(stores);
    const listApprovals = stores.jobs.listApprovals.bind(stores.jobs);
    stores.jobs = {
      ...stores.jobs,
      listUnreadableJobs: async () => [{ id: 'broken-job', reason: '壊れている' }],
      listApprovals: async (options) => ({
        ...(await listApprovals(options)),
        unreadable: [{ id: 'broken-approval', reason: '壊れている' }],
      }),
    };

    const counts = await buildActivityDigest(stores, window(), undefined, undefined, {
      shape: 'counts',
    });

    // 委譲の読めない行は担当の節が自分の断りで言うので、件数の行には載せない。承認待ちは載せる
    expect(sectionOf(counts, '## マネージャー')).toContain('broken-job');
    expect(counts).toContain('- 読めない行（壊れた行。上の件数には入っていない）: 承認待ち 1');
  });
});

describe('#4938 の測定（担当30本・継続中の依頼10本など）', () => {
  it('前と後の字数を標準エラーへ出す', async () => {
    const stores = createMemoryStores();
    await seedLikeIssue(stores);

    const full = await buildActivityDigest(stores, window());
    const counts = await buildActivityDigest(stores, window(), undefined, undefined, {
      shape: 'counts',
    });
    const managerSection = sectionOf(full, '## マネージャー');
    const timerPrompt = buildTimerPrompt({ kind: 'standing-0', request: '依頼', digest: counts });
    const selfPrompt = buildSelfInitiativePrompt({ reason: '定期 tick', digest: full });

    // 前（この変更の前のコードで同じ道具立てを測った値。2026-10-16）: 要約の全体 11591 字 / マネージャーの節 3385 字 / 定期の tick 12007 字 / 自発の tick 11996 字
    process.stderr.write(
      `[#4938 測定] 要約の全体 ${full.length} 字 / マネージャーの節 ${managerSection.length} 字 / ` +
        `件数の形 ${counts.length} 字 / 定期の tick ${timerPrompt.length} 字 / 自発の tick ${selfPrompt.length} 字\n`,
    );
    // 前の節は上限の15本だけを載せていたので、減り方は Issue の見込み（30本を全部載せている前提で6〜7割）より小さい
    expect(managerSection.length).toBeLessThan(3385 * 0.6);
    // 定期の tick は担当の節と継続中の依頼の節を中身ごと出すので、件数の行だけだった頃（872 字）より長い。それでも自発の tick より短い
    expect(timerPrompt.length).toBeLessThan(selfPrompt.length);
    expect(timerPrompt.length).toBeLessThan(12007 * 0.6);
  });
});
