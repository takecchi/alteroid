import { migrateCommitmentsToTasks } from './commitment-task-migration.js';
import type { CommitmentMigrationStores } from './commitment-task-migration.js';
import type { Commitment, Task } from './schema.js';

// vitest に依存しない素の関数にする（`verifyTaskStoreContract` と同じ理由）。
// 台帳 → Task の移行（#5469 P7a）の契約を、メモリ・fs・pg の3実装で揃える。シナリオごとに空のストアを作り直す。
export interface CommitmentMigrationFixture {
  readonly stores: CommitmentMigrationStores;
  /** 読めない台帳の行を器に直接仕込む。渡さない実装では「読めない行」の歯だけを飛ばす。 */
  readonly plantUnreadableCommitment?: (id: string) => Promise<void>;
  /** 読めない Task の行を器に直接仕込む。同上。 */
  readonly plantUnreadableTask?: (id: string) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}

const NOW = '2026-10-29T00:00:00.000Z';

// 展開（`{ ...store }`）で差し替えない: fs / pg のストアはクラスで、メソッドが prototype に在り `#private` を使うので、展開するとメソッドが落ちる
function override<T extends object>(base: T, patch: Partial<T>): T {
  return new Proxy(base, {
    get(target, prop) {
      if (Reflect.has(patch, prop)) return Reflect.get(patch, prop) as unknown;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

export async function verifyCommitmentTaskMigrationContract(
  makeFixture: () => Promise<CommitmentMigrationFixture>,
): Promise<void> {
  // 型注釈が要る: `never` を返す関数として呼び出し側の絞り込みに効かせるため
  const fail: (message: string) => never = (message) => {
    throw new Error(`台帳→Task 移行の契約違反: ${message}`);
  };
  const scenario = async (
    name: string,
    run: (fixture: CommitmentMigrationFixture) => Promise<void>,
  ): Promise<void> => {
    const fixture = await makeFixture();
    try {
      await run(fixture);
    } catch (error) {
      throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      await fixture.dispose?.();
    }
  };
  const entry = (
    id: string,
    at: string,
    origin: Commitment['origin'],
    extra: Partial<Commitment> = {},
  ): Commitment => ({ id, at, origin, body: `本文-${id}`, ...extra });
  const taskIds = async (stores: CommitmentMigrationStores): Promise<string> =>
    (await stores.tasks.list({ includeClosed: true })).entries.map((task) => task.id).join(',');
  const decisions = async (stores: CommitmentMigrationStores) =>
    (await stores.journal.list()).filter((row) => row.type === 'decision');
  const snapshot = async (stores: CommitmentMigrationStores): Promise<string> =>
    JSON.stringify({
      commitments: await stores.commitments.list({ includeClosed: true }),
      tasks: await stores.tasks.list({ includeClosed: true }),
      journal: (await stores.journal.list()).length,
    });

  await scenario('振り分けと古い順', async ({ stores }) => {
    // at の順とは逆に積む: 古い順に並ぶのが「積んだ順」の偶然でないことを測る
    await stores.commitments.open(
      entry('h2', '2026-10-02T00:00:00.000Z', 'human', { source: 'conv-2' }),
    );
    await stores.commitments.open(
      entry('m1', '2026-10-01T12:00:00.000Z', 'manager', { source: 'mgr-1' }),
    );
    await stores.commitments.open(
      entry('h1', '2026-10-01T00:00:00.000Z', 'human', { body: '一行目\n二行目' }),
    );
    await stores.commitments.open(entry('e1', '2026-10-01T13:00:00.000Z', 'external'));
    await stores.commitments.open(entry('s1', '2026-10-01T14:00:00.000Z', 'self'));
    await stores.commitments.open(entry('hc', '2026-09-30T00:00:00.000Z', 'human'));
    await stores.commitments.close('hc', '2026-09-30T01:00:00.000Z', '元の理由', 'human');

    const report = await migrateCommitmentsToTasks(stores, { dryRun: false, now: NOW });

    if ((await taskIds(stores)) !== 'h1,h2') fail(`Task が h1,h2 でなく ${await taskIds(stores)}`);
    const tasks = (await stores.tasks.list()).entries;
    const h1 = tasks[0];
    const h2 = tasks[1];
    if (h1 === undefined || h2 === undefined) return fail('Task が2件無い');
    if (h1.status !== 'queued' || h1.origin !== 'human') fail('h1 が queued / human でない');
    if (h1.createdAt !== '2026-10-01T00:00:00.000Z' || h1.updatedAt !== NOW) fail('h1 の時刻');
    if (h1.title !== '一行目' || h1.body !== '一行目\n二行目') fail('h1 の title / body');
    if (h2.source !== 'conv-2') fail('h2 の source が引き継がれていない');
    if (h1.originConversationId !== undefined) fail('originConversationId を付けてはいけない');

    const ledger = (await stores.commitments.list({ includeClosed: true })).entries;
    for (const row of ledger) {
      if (row.closedAt === undefined) fail(`${row.id} が開いたまま`);
    }
    const hc = ledger.find((row) => row.id === 'hc');
    if (hc?.closedReason !== '元の理由' || hc.closedBy !== 'human') fail('閉じた行を書き換えた');
    for (const id of ['h1', 'h2']) {
      const row = ledger.find((item) => item.id === id);
      if (row?.closedBy !== 'daemon') fail(`${id} を daemon が閉じていない`);
      if (!row.closedReason?.includes(id)) fail(`${id} の閉じた理由に Task の id が無い`);
    }
    for (const [id, origin] of [
      ['m1', 'manager'],
      ['e1', 'external'],
      ['s1', 'self'],
    ] as const) {
      const row = ledger.find((item) => item.id === id);
      if (row?.closedBy !== 'daemon') fail(`${id} を daemon が閉じていない`);
      if (!row.closedReason?.includes('#5469') || !row.closedReason.includes(origin)) {
        fail(`${id} の閉じた理由に印と元の origin が無い`);
      }
      if ((await stores.tasks.get(id)) !== null) fail(`${id} が Task になった`);
    }

    const journal = await decisions(stores);
    if (journal.length !== 5) fail(`日誌の decision が5件でなく ${journal.length}`);
    const text = journal.map((row) => (row.type === 'decision' ? row.decision : '')).join('\n');
    for (const body of ['一行目\n二行目', '本文-h2', '本文-m1', '本文-e1', '本文-s1']) {
      if (!text.includes(body)) fail(`日誌に本文が逐語で残っていない: ${body}`);
    }

    if (report.execution === undefined) return fail('実行の結果が無い');
    const { migrated, retired, closeOnly, failed, alreadyClosed } = report.execution;
    if (
      migrated !== 2 ||
      retired !== 3 ||
      closeOnly !== 0 ||
      failed.length !== 0 ||
      alreadyClosed !== 0
    ) {
      fail(`実行の集計が違う: ${JSON.stringify(report.execution)}`);
    }
    if (report.summary.skipClosed !== 1) fail('閉じた行を数えていない');
  });

  await scenario('2回目は何も増えない（閉じた行は移さない）', async ({ stores }) => {
    await stores.commitments.open(entry('h1', '2026-10-01T00:00:00.000Z', 'human'));
    await stores.commitments.open(entry('m1', '2026-10-01T01:00:00.000Z', 'manager'));
    await migrateCommitmentsToTasks(stores, { dryRun: false, now: NOW });
    const after = await snapshot(stores);
    const second = await migrateCommitmentsToTasks(stores, {
      dryRun: false,
      now: '2026-10-30T00:00:00.000Z',
    });
    if ((await snapshot(stores)) !== after) fail('2回目で状態が変わった');
    const e = second.execution;
    if (e === undefined || e.migrated + e.retired + e.closeOnly + e.failed.length !== 0) {
      fail('2回目の実行の集計が0でない');
    }
  });

  await scenario(
    '途中で落ちた状態（Task は在るが台帳は開いたまま）から復旧する',
    async ({ stores }) => {
      await stores.commitments.open(entry('h1', '2026-10-01T00:00:00.000Z', 'human'));
      await stores.commitments.open(entry('h2', '2026-10-01T01:00:00.000Z', 'human'));
      // 1周目が h1 の Task を書いたところで落ちた状態。さらに人間が Task を done へ進めている
      await stores.tasks.add({
        id: 'h1',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        status: 'queued',
        origin: 'human',
        title: 'h1',
        body: '本文-h1',
      });
      await stores.tasks.setStatus('h1', 'done', {
        by: 'human',
        at: '2026-10-05T00:00:00.000Z',
        reason: '済んだ',
      });

      const report = await migrateCommitmentsToTasks(stores, { dryRun: false, now: NOW });

      if ((await taskIds(stores)) !== 'h2,h1')
        fail(`Task が二重になった/欠けた: ${await taskIds(stores)}`);
      const h1 = await stores.tasks.get('h1');
      if (h1?.status !== 'done' || h1.closedReason !== '済んだ')
        fail('既に進んだ Task を巻き戻した');
      const open = (await stores.commitments.list()).entries;
      if (open.length !== 0) fail('台帳が開いたまま残った');
      const e = report.execution;
      if (e?.migrated !== 1 || e.closeOnly !== 1) fail(`集計が違う: ${JSON.stringify(e)}`);
      if (report.summary.closeOnly !== 1 || report.summary.toTask !== 1) fail('計画の集計が違う');
    },
  );

  await scenario('dryRun は何も書かず計画と集計だけを返す', async ({ stores }) => {
    await stores.commitments.open(entry('h1', '2026-10-01T00:00:00.000Z', 'human'));
    await stores.commitments.open(entry('m1', '2026-10-01T01:00:00.000Z', 'manager'));
    await stores.commitments.open(entry('hc', '2026-09-01T01:00:00.000Z', 'human'));
    await stores.commitments.close('hc', '2026-09-01T02:00:00.000Z', 'r', 'human');
    const before = await snapshot(stores);
    const report = await migrateCommitmentsToTasks(stores, { dryRun: true, now: NOW });
    if ((await snapshot(stores)) !== before) fail('dryRun が書いた');
    if (!report.dryRun || report.execution !== undefined) fail('dryRun の印・実行の結果が違う');
    const s = report.summary;
    if (s.toTask !== 1 || s.retire !== 1 || s.skipClosed !== 1 || s.closeOnly !== 0) {
      fail(`dryRun の集計が違う: ${JSON.stringify(s)}`);
    }
    if (s.oldestAt !== '2026-10-01T00:00:00.000Z' || s.newestAt !== '2026-10-01T00:00:00.000Z') {
      fail('最古/最新の時刻が違う');
    }
  });

  await scenario('日誌が書けなければ台帳を閉じない。直れば続きから閉じる', async ({ stores }) => {
    await stores.commitments.open(entry('h1', '2026-10-01T00:00:00.000Z', 'human'));
    await stores.commitments.open(entry('m1', '2026-10-01T01:00:00.000Z', 'manager'));
    let broken = true;
    const journal = override(stores.journal, {
      append: (input) => {
        if (broken) return Promise.reject(new Error('journal down'));
        return stores.journal.append(input);
      },
    });
    const flaky: CommitmentMigrationStores = { ...stores, journal };
    const report = await migrateCommitmentsToTasks(flaky, { dryRun: false, now: NOW });
    if (report.execution?.failed.length !== 2) fail('日誌の失敗を failed として数えていない');
    if ((await stores.commitments.list()).entries.length !== 2) fail('日誌が無いのに台帳を閉じた');
    broken = false;
    const again = await migrateCommitmentsToTasks(flaky, { dryRun: false, now: NOW });
    if ((await stores.commitments.list()).entries.length !== 0) fail('復旧後に閉じていない');
    if ((await taskIds(stores)) !== 'h1') fail('復旧で Task が二重になった');
    if (again.execution?.closeOnly !== 1 || again.execution.retired !== 1) {
      fail(`復旧の集計が違う: ${JSON.stringify(again.execution)}`);
    }
  });

  await scenario('1行の失敗で全体を止めず、次の行へ進む', async ({ stores }) => {
    for (const id of ['a', 'b', 'c']) {
      await stores.commitments.open(
        entry(id, `2026-10-01T0${id === 'a' ? 0 : id === 'b' ? 1 : 2}:00:00.000Z`, 'human'),
      );
    }
    const commitments = override(stores.commitments, {
      close: (id, at, reason, by) =>
        id === 'b'
          ? Promise.reject(new Error('close down'))
          : stores.commitments.close(id, at, reason, by),
    });
    const report = await migrateCommitmentsToTasks(
      { ...stores, commitments },
      { dryRun: false, now: NOW },
    );
    const failed = report.execution?.failed ?? [];
    if (failed.length !== 1 || failed[0]?.id !== 'b')
      fail(`失敗の数え方が違う: ${JSON.stringify(failed)}`);
    const open = (await stores.commitments.list()).entries.map((row) => row.id).join(',');
    if (open !== 'b') fail(`開いたまま残るのは b だけのはず: ${open}`);
    if ((await taskIds(stores)) !== 'a,b,c') fail('b の Task は先に書かれている');
  });

  await scenario('既に在る Task の並びの中へ、古い順で入る', async ({ stores }) => {
    const base = (id: string, origin: Task['origin']): Task => ({
      id,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'queued',
      origin,
      title: id,
      body: id,
    });
    await stores.tasks.add(base('H0', 'human'));
    await stores.tasks.add(base('S0', 'self'));
    await stores.commitments.open(entry('h2', '2026-10-02T00:00:00.000Z', 'human'));
    await stores.commitments.open(entry('h1', '2026-10-01T00:00:00.000Z', 'human'));
    await migrateCommitmentsToTasks(stores, { dryRun: false, now: NOW });
    const order = (await stores.tasks.list()).entries.map((task) => task.id).join(',');
    // human 起点は「開いている human 起点の最後の直後」なので、既存の self 起点の前に入る（P2 の既定）
    if (order !== 'H0,h1,h2,S0') fail(`並びが H0,h1,h2,S0 でなく ${order}`);
  });

  await scenario(
    '読めない台帳の行は触らず、id だけを報告する（本文は出さない）',
    async (fixture) => {
      const { stores, plantUnreadableCommitment } = fixture;
      if (plantUnreadableCommitment === undefined) return;
      await stores.commitments.open(entry('h1', '2026-10-01T00:00:00.000Z', 'human'));
      await plantUnreadableCommitment('broken-c');
      const report = await migrateCommitmentsToTasks(stores, { dryRun: false, now: NOW });
      if (report.unreadableCommitments.map((row) => row.id).join(',') !== 'broken-c') {
        fail(`読めない行の id を報告していない: ${JSON.stringify(report.unreadableCommitments)}`);
      }
      if ((await stores.commitments.list()).unreadable.length !== 1)
        fail('読めない行が消えた/閉じた');
      if ((await taskIds(stores)) !== 'h1') fail('読めない行があると他の行が移らない');
      if (JSON.stringify(report).includes('壊れた本文')) fail('報告に読めない行の本文が出た');
    },
  );

  await scenario(
    '読めない Task が同じ id で在るときは existed と同じ扱い（数えて報告する）',
    async (fixture) => {
      const { stores, plantUnreadableTask } = fixture;
      if (plantUnreadableTask === undefined) return;
      await plantUnreadableTask('h1');
      await stores.commitments.open(entry('h1', '2026-10-01T00:00:00.000Z', 'human'));
      const plan = await migrateCommitmentsToTasks(stores, { dryRun: true, now: NOW });
      if (plan.summary.closeOnly !== 1 || plan.summary.toTask !== 0)
        fail('読めない Task を在るものとして数えていない');
      if (plan.unreadableTaskCollisions.join(',') !== 'h1') fail('衝突した id を報告していない');
      const report = await migrateCommitmentsToTasks(stores, { dryRun: false, now: NOW });
      if (report.execution?.closeOnly !== 1) fail('読めない Task があるのに Task を作ろうとした');
      if ((await stores.commitments.list()).entries.length !== 0) fail('台帳を閉じていない');
      if ((await stores.tasks.list()).unreadable.length !== 1) fail('読めない Task を触った');
    },
  );
}
