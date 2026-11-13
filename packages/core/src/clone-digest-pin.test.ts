import { describe, expect, it } from 'vitest';

import { setup, waitFor, waitForTerminal } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';
import { fakeManagerPool } from './manager-pool.test-support.js';
import type { ManagerSummary } from './manager.js';
import { measureMemoryFloor } from './memory.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// B1（要約の組み立て: `#memoryFloorDigestLine` / `#recentDigestBare` / `#managerDigestAxes`）の出力の固定。
// ⚠️ ここの期待の文字列は、仕様を先に書いたものではない。切り出し（`clone-digest.ts`）の前の作りの出力を
// `vitest -u` で生成し、目で読んで確かめたものである。切り出しで一字も変わってはならない。

const noteWithSummary = (summaryChars: number) =>
  `---\ndescription: ${'a'.repeat(summaryChars)}\n---\n\n# Note\n\n本文\n`;

let seq = 0;

function selfTick(s: Setup, cause?: 'manual'): void {
  seq += 1;
  s.clone.post({
    type: 'self_initiative',
    id: `evt-digest-pin-${String(seq)}`,
    at: new Date().toISOString(),
    reason: '定期 tick',
    ...(cause === undefined ? {} : { cause }),
  });
}

const flat = (s: Setup): string[] => s.calls.flatMap((call) => call.inputs);

const floorLine = (input: string | undefined): string =>
  (input ?? '').split('\n').find((line) => line.startsWith('記憶の床:')) ?? '(行無し)';

describe('B1 要約の組み立ての固定 — 記憶の床の行（全文）', () => {
  it('基準がまだ無い（0）・前回の tick が無い最初の tick', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('note', noteWithSummary(1_000));
    const s = setup(() => 'わかった', stores);
    selfTick(s);
    await waitFor(() => flat(s).length === 1, '1本目');
    expect(floorLine(flat(s)[0])).toMatchInlineSnapshot(
      `"記憶の床: いまの記憶の総量（現在値）: 1,162 文字。 ⚠️ セッション構築時点の値（\`self_status\` が「システムプロンプトへ焼き込んだ記憶の文字数」として出す数）がこの呼び出しからは引けなかったため、これはセッション構築時点との差ではなく現在値である。 前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。 基準がまだ無いので線の判定は出せない。"`,
    );
    await s.clone.stop();
  });

  it('線に達する（+10% 以上）。recordTick の副作用で、次の呼びが前回の値を見る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('note', noteWithSummary(1_000));
    const s = setup(() => 'わかった', stores);
    selfTick(s);
    await waitFor(() => flat(s).length === 1, '1本目');
    const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;
    await stores.persona.write('note', noteWithSummary(1_000 + Math.ceil(baseline * 0.2) + 50));
    selfTick(s, 'manual');
    await waitFor(() => flat(s).length === 2, '2本目');
    expect(floorLine(flat(s)[0])).toMatchInlineSnapshot(
      `"記憶の床: いまの記憶の総量（現在値）: 1,162 文字。 ⚠️ セッション構築時点の値（\`self_status\` が「システムプロンプトへ焼き込んだ記憶の文字数」として出す数）がこの呼び出しからは引けなかったため、これはセッション構築時点との差ではなく現在値である。 前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。 基準がまだ無いので線の判定は出せない。"`,
    );
    expect(floorLine(flat(s)[1])).toMatchInlineSnapshot(
      `"記憶の床: 次に組み立て直されたら焼かれる量（セッション構築時点との差）: セッション構築時点 1,162 文字 → いま 1,445 文字（+283 文字（+24.4%）、増える見込み）。 前回の tick から +283 文字。 ⚠️ 線（セッション構築時点から +10%）に達している。"`,
    );
    await s.clone.stop();
  });

  it('読めない回は recordTick を書かない（次の tick はまだ最初の tick と名乗る）', async () => {
    const base = createMemoryStores();
    await base.persona.write('note', noteWithSummary(1_000));
    let calls = 0;
    const stores: Stores = {
      ...base,
      persona: {
        ...base.persona,
        documents: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error('persona 読み込み失敗（実測を模す）'))
            : base.persona.documents();
        },
      },
    };
    const s = setup(() => 'わかった', stores);
    selfTick(s);
    await waitFor(() => flat(s).length === 1, '1本目');
    selfTick(s, 'manual');
    await waitFor(() => flat(s).length === 2, '2本目');
    expect(floorLine(flat(s)[0])).toMatchInlineSnapshot(
      `"記憶の床: 測れなかった（理由: Error: persona 読み込み失敗（実測を模す））。"`,
    );
    expect(floorLine(flat(s)[1])).toMatchInlineSnapshot(
      `"記憶の床: 次に組み立て直されたら焼かれる量（セッション構築時点との差）: セッション構築時点（1,162 文字）から変わっていない。 前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。"`,
    );
    await s.clone.stop();
  });

  it('セッションが組み直されて基準が取り直された', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('note', `# Note\n\n${'a'.repeat(80)}\n`);
    const s = setup(() => 'わかった', stores, { endSessionAfterTurn: 0 });
    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    await stores.persona.write('note', `# Note\n\n${'a'.repeat(500)}\n`);

    selfTick(s);
    await waitFor(() => flat(s).length === 2, '1本目の tick');
    selfTick(s, 'manual');
    await waitFor(() => flat(s).length === 3, '2本目の tick');
    expect(floorLine(flat(s)[1])).toMatchInlineSnapshot(
      `"記憶の床: 次に組み立て直されたら焼かれる量（セッション構築時点との差）: セッション構築時点 243 文字 → いま 244 文字（+1 文字（+0.4%）、増える見込み）。 前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。"`,
    );
    expect(floorLine(flat(s)[2])).toMatchInlineSnapshot(
      `"記憶の床: 次に組み立て直されたら焼かれる量（セッション構築時点との差）: セッション構築時点（244 文字）から変わっていない。 前回の tick から +0 文字。 ⚠️ セッションが組み直されて基準が 243 → 244 文字へ取り直された（% が下がったのは畳んだからではない）。"`,
    );
    await s.clone.stop();
  });
});

describe('B1 要約の組み立ての固定 — 失敗の文面と出し分け', () => {
  const failingJobs = async (): Promise<Stores> => {
    const stores = createMemoryStores();
    stores.jobs.listJobsWithUnreadable = () => Promise.reject(new Error('委譲の台帳が読めない'));
    const at = '2026-01-01T00:00:00.000Z';
    await stores.tasks.add({
      id: 'task-0',
      createdAt: at,
      updatedAt: at,
      status: 'queued',
      origin: 'self',
      title: '待ち行列の仕事 0',
      body: '本文 0',
    });
    return stores;
  };
  const afterFloor = (input: string | undefined): string => {
    const text = input ?? '';
    return text.slice(text.indexOf('（直近の状況をまとめられなかった'));
  };

  it('発意の tick（shape full）: 失敗の行のあとに待ち行列の先頭が付く（全文）', async () => {
    const s = setup(() => 'わかった', await failingJobs());
    selfTick(s);
    await waitFor(() => flat(s).length === 1, '1本目');
    expect(afterFloor(flat(s)[0]).split('\n\n').slice(0, 2)).toMatchInlineSnapshot(`
      [
        "（直近の状況をまとめられなかった: Error: 委譲の台帳が読めない）",
        "## 待ち行列の先頭
      - 待ち行列: 開いている 1 件（queued 1 / waiting 0 / needs_decision 0）
      - task-0（状態: queued（待ち行列） / origin: self）待ち行列の仕事 0
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）",
      ]
    `);
    await s.clone.stop();
  });

  it('定期の依頼の tick（shape counts）: 失敗の行だけで、先頭は足さない（全文）', async () => {
    const stores = await failingJobs();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: '何かする',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
    const s = setup(() => 'わかった', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-digest-pin-timer',
      at: new Date().toISOString(),
      kind: 'issue-round',
      cause: 'manual',
    });
    await waitFor(() => flat(s).length === 1, '1本目');
    const text = flat(s)[0] ?? '';
    const start = text.indexOf('（直近の状況をまとめられなかった');
    expect(text.slice(start, start + 80)).toMatchInlineSnapshot(
      `"（直近の状況をまとめられなかった: Error: 委譲の台帳が読めない）"`,
    );
    expect(text).not.toContain('## 待ち行列の先頭');
    await s.clone.stop();
  });

  it('待ち行列も読めないとき、先頭の代わりに読めなかったと名乗る（全文）', async () => {
    const stores = await failingJobs();
    stores.tasks.list = () => Promise.reject(new Error('task 台帳が壊れている'));
    const s = setup(() => 'わかった', stores);
    selfTick(s);
    await waitFor(() => flat(s).length === 1, '1本目');
    expect(afterFloor(flat(s)[0]).split('\n\n').slice(0, 2)).toMatchInlineSnapshot(`
      [
        "（直近の状況をまとめられなかった: Error: 委譲の台帳が読めない）",
        "## 待ち行列の先頭
      - 待ち行列を読めなかった（理由: Error: task 台帳が壊れている）。開いている仕事が 0 件だったのではない。読み直す手は \`task_list\` である。",
      ]
    `);
    await s.clone.stop();
  });
});

describe('B1 要約の組み立ての固定 — 管理者の軸（#managerDigestAxes）', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const summaryOf = (managerId: string, extra: Partial<ManagerSummary>): ManagerSummary => ({
    managerId,
    status: 'running',
    live: true,
    cwd: '/work',
    request: '仕事',
    startedAt: now,
    updatedAt: now,
    waiting: [],
    ...extra,
  });
  const putJob = async (stores: Stores, id: string): Promise<void> => {
    const at = new Date().toISOString();
    await stores.jobs.putJob({
      id,
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: `仕事 ${id}`,
      request: `仕事 ${id}`,
    });
  };
  const jobLines = (input: string | undefined): string[] =>
    // 同じ ms に作った行は並びが揺れるので、行そのものを固定して順は固定しない
    (input ?? '')
      .split('\n')
      .filter((line) => line.startsWith('- mgr-'))
      .sort();

  it('生きている／切断／背景処理待ちが行ごとに出る', async () => {
    const stores = createMemoryStores();
    for (const id of ['mgr-a', 'mgr-b', 'mgr-c']) await putJob(stores, id);
    const pool = fakeManagerPool({
      list: () =>
        Promise.resolve([
          summaryOf('mgr-a', { live: true }),
          summaryOf('mgr-b', { live: false }),
          summaryOf('mgr-c', {
            live: true,
            awaitingBackground: {
              tasks: 2,
              withheldReports: 0,
              breakdown: 'pin',
              since: '2026-01-01T00:00:00.000Z',
            },
          }),
        ]),
    });
    const s = setup(() => 'わかった', stores, {}, {}, { managers: pool });
    selfTick(s);
    await waitFor(() => flat(s).length === 1, '1本目');
    expect(jobLines(flat(s)[0])).toMatchInlineSnapshot(`
      [
        "- mgr-a [running] 仕事 mgr-a",
        "- mgr-b [running/セッション切断] 仕事 mgr-b",
        "- mgr-c [running/背景処理待ち×2（2026-01-01T00:00:00.000Z から）] 仕事 mgr-c",
      ]
    `);
    await s.clone.stop();
  });

  it('list() が失敗しても要約は壊れず、全件 /セッション不明 になる', async () => {
    const stores = createMemoryStores();
    for (const id of ['mgr-a', 'mgr-b']) await putJob(stores, id);
    const pool = fakeManagerPool({ list: () => Promise.reject(new Error('台帳が読めない')) });
    const s = setup(() => 'わかった', stores, {}, {}, { managers: pool });
    selfTick(s);
    await waitFor(() => flat(s).length === 1, '1本目');
    expect(jobLines(flat(s)[0])).toMatchInlineSnapshot(`
      [
        "- mgr-a [running/セッション不明] 仕事 mgr-a",
        "- mgr-b [running/セッション不明] 仕事 mgr-b",
      ]
    `);
    expect(flat(s)[0]).not.toContain('まとめられなかった');
    await s.clone.stop();
  });
});
