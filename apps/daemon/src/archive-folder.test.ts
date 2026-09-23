/**
 * `archive-folder.ts`（issue #698）。退避済み生ログ（`archive`）の古い写しを
 * デーモンが定期的に自動で畳む（tombstone する）——選定・保護の判定ロジックは
 * 一切ここで書き直さず、`@alteroid/core` の既存の純関数
 * （`selectArchiveRemovalTargets` / `guardArchiveRemoval`）をそのまま呼ぶ。
 *
 * **`requireContainment: true` を固定していることと、`guardArchiveRemoval` を
 * 通していることが「読めるものは1バイトも減らない」の根拠である**——この2点は
 * 個別の歯だけでなく、下の変異試験でも生の出力を取って確かめる。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMemoryStores,
  type ArchiveEntry,
  type ManagerPool,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_FOLD_EVERY_ENV,
  ARCHIVE_FOLD_GRACE_MS,
  DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES,
  foldArchiveOnce,
  readArchiveFoldConfig,
  startArchiveFolding,
  type FoldArchiveOnceResult,
} from './archive-folder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 猶予より確実に外側になる「未来の現在時刻」。実時間に依存しないよう十分な余白を取る。 */
const FAR_FUTURE = () => new Date(Date.now() + ARCHIVE_FOLD_GRACE_MS + 60_000);

/**
 * 「走行中のマネージャーは1つも無い」という像。`guardArchiveRemoval` は
 * `managers === undefined` を**安全側（`kind: 'unknown'` ⟹ 保護）**に倒すので
 * （`packages/core/src/manager.ts` の doc）、「何も保護しない」ことを確かめたい
 * テストではここを渡す——`managers: undefined` を渡すと全件が `skipped.inUse`
 * に落ちて畳まれず、意図がぼやける。
 */
const noRunningManagers: Pick<ManagerPool, 'runningManagerOwning'> = {
  runningManagerOwning: () => undefined,
};

function fakeManagers(
  runningOwners: Map<string, string>,
): Pick<ManagerPool, 'runningManagerOwning'> {
  return {
    runningManagerOwning: (archiveId) => runningOwners.get(archiveId),
  };
}

/**
 * `runningManagerPinning` まで実装した像——走行中の1マネージャーが
 * `archiveIds` として `ownedIds`（古い順）を抱えている状態を模す。
 * `runningManagerOwning` は全件を保護し（狭める前の広い判定）、
 * `runningManagerPinning` は末尾（`ownedIds.at(-1)`）だけを保護する
 * ——本物の `Pool#runningManagerOwning` / `Pool#runningManagerPinning`
 * （`packages/core/src/manager.ts`）と同じ形の関係を、この道具のテストでは
 * 手で組み立てる（本物の `Pool` を1周走らせるのは `manager.test.ts` の
 * 「runningManagerPinning / guardArchiveRemoval の requireContainment」が
 * 別に持っている）。
 */
function fakeManagersWithPinning(
  ownedIds: readonly string[],
  managerId: string,
): Pick<ManagerPool, 'runningManagerOwning' | 'runningManagerPinning'> {
  const tail = ownedIds.at(-1);
  return {
    runningManagerOwning: (archiveId) => (ownedIds.includes(archiveId) ? managerId : undefined),
    runningManagerPinning: (archiveId) => (archiveId === tail ? managerId : undefined),
  };
}

/** 不変条件: `matched === folded + remaining + skipped5欄の総和 + raced`。 */
function assertInvariant(result: FoldArchiveOnceResult): void {
  const skippedTotal =
    result.skipped.newest +
    result.skipped.alreadyRemoved +
    result.skipped.notContained +
    result.skipped.protected +
    result.skipped.inUse;
  expect(result.matched).toBe(result.folded + result.remaining + skippedTotal + result.raced);
}

/**
 * `continuity` を直接指定した `ArchiveEntry` を注入できる、最小限の
 * `TranscriptArchive` フィクスチャ。
 *
 * **`packages/core/src/archive-prune.test.ts` と同じ作法**——`selectArchiveRemovalTargets`
 * 自身のテストも、`archive()` を経由した実分類ではなく `ArchiveEntry` を直接
 * 組み立てている（`continuity: 'unknown'` の行は、`archive()` を経由すると
 * 「直前の行が指紋を持たない」という前提を作らないと再現できず、その前提を
 * 作る `seedFingerprintlessArchiveRow` は `@alteroid/core` の外部公開 API
 * ではない——doc に「`archive-contract.test.ts` 以外から呼ぶ想定は無い」と
 * 明記されている。ここでは同じ理由で、直接 `ArchiveEntry` を組み立てる）。
 *
 * `list()` / `remove()` だけを実装する——`foldArchiveOnce` が呼ぶのはこの
 * 2つだけである。
 */
function fakeArchiveEntries(initial: readonly ArchiveEntry[]): Stores['archive'] {
  const rows = new Map(initial.map((e) => [e.id, { ...e }]));
  return {
    archive() {
      throw new Error('fakeArchiveEntries: archive() は使わない');
    },
    async list() {
      return [...rows.values()];
    },
    sessions() {
      throw new Error('fakeArchiveEntries: sessions() は使わない');
    },
    async read(id) {
      const row = rows.get(id);
      if (row === undefined) return { kind: 'missing' };
      if (row.removedAt !== undefined) {
        return { kind: 'removed', removedAt: row.removedAt, bytes: row.removedBytes ?? 0 };
      }
      return { kind: 'body', body: '' };
    },
    readTail() {
      throw new Error('fakeArchiveEntries: readTail() は使わない');
    },
    async remove(id) {
      const row = rows.get(id);
      if (row === undefined) return { kind: 'missing' };
      if (row.removedAt !== undefined) {
        return { kind: 'already', removedAt: row.removedAt, bytes: row.removedBytes ?? 0 };
      }
      const removedAt = new Date().toISOString();
      const bytes = row.storedBytes;
      rows.set(id, { ...row, removedAt, removedBytes: bytes });
      return { kind: 'removed', bytes };
    },
    async clear() {
      const n = rows.size;
      rows.clear();
      return n;
    },
  };
}

describe('foldArchiveOnce（issue #698）', () => {
  it('continues の古い行が畳まれ、そのセッションの最新行は残る', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-1', 'A'.repeat(40));
    const row2 = await stores.archive.archive('sess-1', 'A'.repeat(40) + 'B'.repeat(40));
    const row3 = await stores.archive.archive(
      'sess-1',
      'A'.repeat(40) + 'B'.repeat(40) + 'C'.repeat(40),
    );
    expect(row2.continuity).toBe('continues');
    expect(row3.continuity).toBe('continues');

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(result.folded).toBe(2);
    expect(result.skipped.newest).toBe(1);

    expect((await stores.archive.read(row1.id)).kind).toBe('removed');
    expect((await stores.archive.read(row2.id)).kind).toBe('removed');
    // **最新行は残る。**
    expect((await stores.archive.read(row3.id)).kind).toBe('body');
  });

  it('diverged / unknown / continuity を持たない行（門より前の残骸）は畳まれない', async () => {
    const base = createMemoryStores();
    const entries: ArchiveEntry[] = [
      // 門より前に積まれた行（`continuity` 自体が無い＝ absent）。
      { id: 'row-1', sessionId: 'sess-2', at: '2026-01-01T00:00:00.000Z', storedBytes: 100 },
      // 直前の行が指紋を持たないので 'unknown'。
      {
        id: 'row-2',
        sessionId: 'sess-2',
        at: '2026-01-01T00:01:00.000Z',
        storedBytes: 100,
        continuity: 'unknown',
      },
      // 直前と前方一致しないので 'diverged'。このセッションの最新行でもある。
      {
        id: 'row-3',
        sessionId: 'sess-2',
        at: '2026-01-01T00:02:00.000Z',
        storedBytes: 100,
        continuity: 'diverged',
      },
    ];
    const stores: Stores = { ...base, archive: fakeArchiveEntries(entries) };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.newest).toBe(1); // row-3（diverged。だがこのセッションの最新行）
    expect(result.skipped.notContained).toBe(2); // row-1（absent）と row-2（unknown）

    expect((await stores.archive.read('row-1')).kind).toBe('body');
    expect((await stores.archive.read('row-2')).kind).toBe('body');
    expect((await stores.archive.read('row-3')).kind).toBe('body');
  });

  it('墓標（TranscriptGrave.archiveId）が指す行は畳まれない', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-3', 'X'.repeat(40));
    await stores.archive.archive('sess-3', 'X'.repeat(40) + 'Y'.repeat(40));
    // row1 は本来なら畳める（row2 に前方一致で含まれる）が、墓標に指定する。
    await stores.sessions.setTranscriptGrave({ archiveId: row1.id });

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.protected).toBe(1);
    expect(result.skipped.newest).toBe(1);
    expect((await stores.archive.read(row1.id)).kind).toBe('body');
  });

  it('走行中のマネージャーが抱える行は畳まれない（runningManagerOwning）。overrideReason は渡さない', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-4', 'P'.repeat(40));
    await stores.archive.archive('sess-4', 'P'.repeat(40) + 'Q'.repeat(40));

    const runningOwners = new Map<string, string>([[row1.id, 'mgr-running']]);
    const result = await foldArchiveOnce({
      stores,
      managers: fakeManagers(runningOwners),
      now: FAR_FUTURE,
    });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.inUse).toBe(1);
    expect(result.skipped.newest).toBe(1);
    expect((await stores.archive.read(row1.id)).kind).toBe('body');
  });

  /**
   * ⭐ **#698 の直し方の本体を、実際の `foldArchiveOnce` 経由で固定する。**
   *
   * 走行中の1マネージャーが `archiveIds` として `[row1.id, row2.id]`（row2 が
   * 末尾）を抱えている——`row3` はこのセッションの最新行として、狭め判定とは
   * 無関係に `skipped.newest` で守られる。狭め（`runningManagerPinning`）が
   * 効けば、`row1`（末尾より古い・含有が証明済み）は畳め、`row2`（末尾）は
   * 引き続き保護される。
   */
  it('狭めた保護（runningManagerPinning）により、走行中の委譲が抱える古い写しも自動で畳める。末尾は畳まれない（#698）', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-pin', 'F'.repeat(40));
    const row2 = await stores.archive.archive('sess-pin', 'F'.repeat(40) + 'G'.repeat(40));
    const row3 = await stores.archive.archive(
      'sess-pin',
      'F'.repeat(40) + 'G'.repeat(40) + 'H'.repeat(40),
    );
    expect(row2.continuity).toBe('continues');
    expect(row3.continuity).toBe('continues');

    const managers = fakeManagersWithPinning([row1.id, row2.id], 'mgr-pinned');
    const result = await foldArchiveOnce({ stores, managers, now: FAR_FUTURE });
    assertInvariant(result);

    // row1（末尾より古い写し）は畳める——狭めなければ #698 のとおり0件のままだった。
    expect((await stores.archive.read(row1.id)).kind).toBe('removed');
    expect(result.folded).toBe(1);
    // row2（末尾＝いま transcript() が読む本文）は引き続き保護される。
    expect((await stores.archive.read(row2.id)).kind).toBe('body');
    expect(result.skipped.inUse).toBe(1);
    // row3（このセッションの最新行）は狭め判定と無関係に安全弁で守られる。
    expect((await stores.archive.read(row3.id)).kind).toBe('body');
    expect(result.skipped.newest).toBe(1);
  });

  /**
   * 直上のテストと対——`runningManagerPinning` を持たない像（この repo の
   * 既存スタブの多く、`fakeManagers` を含む）では、狭めが効かず row1 も
   * row2 も保護されたままである（安全側フォールバック。#698 が直る前の形）。
   */
  it('runningManagerPinning を持たない像では、古い写しも末尾も保護されたまま（安全側フォールバック）', async () => {
    const stores = createMemoryStores();
    const row1 = await stores.archive.archive('sess-nopin', 'F'.repeat(40));
    const row2 = await stores.archive.archive('sess-nopin', 'F'.repeat(40) + 'G'.repeat(40));

    const runningOwners = new Map<string, string>([
      [row1.id, 'mgr-nopin'],
      [row2.id, 'mgr-nopin'],
    ]);
    const result = await foldArchiveOnce({
      stores,
      managers: fakeManagers(runningOwners),
      now: FAR_FUTURE,
    });
    assertInvariant(result);

    expect(result.folded).toBe(0);
    expect(result.skipped.inUse).toBe(1); // row1 のみが matched（row2 は最新行で skipped.newest）
    expect((await stores.archive.read(row1.id)).kind).toBe('body');
  });

  it('overrideReason を渡す経路がこのファイルに存在せず、第4引数（requireContainment）は常に true（自動の口は開けない・#698）', () => {
    const source = readFileSync(join(__dirname, 'archive-folder.ts'), 'utf8');
    const guardCalls = [...source.matchAll(/guardArchiveRemoval\(([^)]*)\)/g)];
    // 判定所（guardArchiveRemoval）を呼ぶ箇所は1つだけ。
    expect(guardCalls.length).toBe(1);
    const args = (guardCalls[0]?.[1] ?? '').split(',').map((a) => a.trim());
    // 第3引数（overrideReason）は必ずリテラルの `undefined` であること——
    // 変数を経由して非 undefined を渡せる経路が無いことを、字面で固定する。
    expect(args[2]).toBe('undefined');
    // 第4引数（requireContainment）は必ずリテラルの `true` であること——
    // 対象は `selectArchiveRemovalTargets` へ `requireContainment: true` 固定で
    // 渡した行だけ（含有が証明済み）なので、保護の狭めを常に有効にしてよい。
    // `false` を渡せる経路が無いことを字面で固定する（証明の無い行を狭めて
    // 保護から外すと、走行中の委譲の生ログを消す方向に壊れるため）。
    expect(args[3]).toBe('true');
    // `overrideReason` という名の関数引数・フィールド・変数を1つも宣言していない
    // こと（コメントでこの語に触れることまでは禁じない——禁じたいのは
    // 「値を持ち回れる経路」であって、語そのものではない）。
    expect(source).not.toMatch(/\boverrideReason\s*[:=]/);
  });

  it('猶予（grace）より新しい行は畳まれない', async () => {
    const stores = createMemoryStores();
    await stores.archive.archive('sess-5', 'N'.repeat(40));
    await stores.archive.archive('sess-5', 'N'.repeat(40) + 'M'.repeat(40));

    // `now` を省略——実時刻のまま。行はいま作ったばかりなので猶予の内側。
    const result = await foldArchiveOnce({ stores, managers: noRunningManagers });
    assertInvariant(result);

    expect(result.totalRows).toBe(2);
    expect(result.matched).toBe(0);
    expect(result.folded).toBe(0);
  });

  /**
   * 冪等 + 「2周目でだけ壊れる状態」を挟む（AGENTS.md「テストを弱めずに直す」の
   * 規約。逐語: `grep -Fn -- '「2回通しても壊れない」を測るテストは' AGENTS.md`）。
   * 1周目の後に同じセッションへ新しい行を積み、2周目でその直前の行だけが
   * 畳まれることまで撃つ——同じ入り口を2回呼ぶだけの歯にしない。
   */
  it('冪等: 1周目の後に新しい行を積むと、2周目はその直前の行だけを畳む', async () => {
    const stores = createMemoryStores();
    const rowA = await stores.archive.archive('sess-6', 'first'.repeat(10));
    const rowB = await stores.archive.archive('sess-6', 'first'.repeat(10) + 'second'.repeat(10));

    // --- 1周目: rowA が畳まれ、rowB はこの時点の最新行として残る ---
    const first = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(first);
    expect(first.folded).toBe(1);
    expect((await stores.archive.read(rowA.id)).kind).toBe('removed');
    expect((await stores.archive.read(rowB.id)).kind).toBe('body');

    // --- 同じ入り口をもう一度呼ぶだけなら、ここで「何も変わらない」ことしか
    //     測れない。AGENTS.md の規約どおり、ここで状態を変える。 ---
    const rowC = await stores.archive.archive(
      'sess-6',
      'first'.repeat(10) + 'second'.repeat(10) + 'third'.repeat(10),
    );

    // --- 2周目: rowA は再び消しに行かない（alreadyRemoved に落ちる）。
    //     rowB は「直前の行」——rowC が新しい最新行として現れたことで、
    //     初めて畳める対象になる。 ---
    const second = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(second);

    expect(second.folded).toBe(1);
    expect(second.skipped.alreadyRemoved).toBe(1); // rowA
    expect(second.skipped.newest).toBe(1); // rowC

    expect((await stores.archive.read(rowB.id)).kind).toBe('removed');
    expect((await stores.archive.read(rowC.id)).kind).toBe('body');
  });

  it('1件も畳まなかった周は、日誌へ1行も書かない', async () => {
    const base = createMemoryStores();
    // 「diverged/unknown」テストと同じ形——matched > 0 だが folded === 0。
    const entries: ArchiveEntry[] = [
      { id: 'row-1', sessionId: 'sess-7', at: '2026-01-01T00:00:00.000Z', storedBytes: 100 },
      {
        id: 'row-2',
        sessionId: 'sess-7',
        at: '2026-01-01T00:01:00.000Z',
        storedBytes: 100,
        continuity: 'unknown',
      },
    ];
    const stores: Stores = { ...base, archive: fakeArchiveEntries(entries) };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers });
    expect(result.matched).toBeGreaterThan(0);
    expect(result.folded).toBe(0);

    const journalEntries = await stores.journal.list({ types: ['decision'] });
    expect(journalEntries.length).toBe(0);
  });

  /**
   * `raced`（guard までは通ったが、実際に `remove()` する間に他経路が先に
   * 消していた）が0件でも欄を省かないことと、実際に非0でも不変条件が保つ
   * ことを両方測る——`archive.remove` を差し替えて競合を模擬する。
   */
  it('raced（guard 通過後に他経路が先に消していた）を隠さず数える', async () => {
    const base = createMemoryStores();
    const rowA = await base.archive.archive('sess-8', 'r'.repeat(30));
    await base.archive.archive('sess-8', 'r'.repeat(30) + 's'.repeat(30));

    let removeCalls = 0;
    const stores: Stores = {
      ...base,
      archive: {
        ...base.archive,
        async remove(id) {
          removeCalls += 1;
          if (id === rowA.id) return { kind: 'missing' };
          return base.archive.remove(id);
        },
      },
    };

    const result = await foldArchiveOnce({ stores, managers: noRunningManagers, now: FAR_FUTURE });
    assertInvariant(result);

    expect(removeCalls).toBe(1); // rowA だけが対象（rowB は最新行）
    expect(result.raced).toBe(1);
    expect(result.folded).toBe(0);
    // raced だけの塊は「畳んだ」件数が0なので日誌へは書かない。
    const journalEntries = await stores.journal.list({ types: ['decision'] });
    expect(journalEntries.length).toBe(0);
  });
});

describe('readArchiveFoldConfig（issue #698）', () => {
  it('既定は DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES', () => {
    const config = readArchiveFoldConfig({});
    expect(config.everyMinutes).toBe(DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES);
    expect(config.notes).toEqual([]);
  });

  it.each(['off', 'none', 'false', '0', 'OFF', 'None'])(
    '%s で周期を仕込まない（null）',
    (spelling) => {
      const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: spelling });
      expect(config.everyMinutes).toBeNull();
    },
  );

  it('数として読めない値は既定へ倒し、注意を残す', () => {
    const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: 'いつか' });
    expect(config.everyMinutes).toBe(DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES);
    expect(config.notes.length).toBe(1);
  });

  it('分数を読む', () => {
    const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: '15' });
    expect(config.everyMinutes).toBe(15);
  });
});

describe('startArchiveFolding（issue #698）', () => {
  it('ALTEROID_ARCHIVE_FOLD_EVERY=off 相当（everyMinutes: null）で1度も走らない', async () => {
    const stores = createMemoryStores();
    let listCalls = 0;
    const wrapped: Stores = {
      ...stores,
      archive: {
        ...stores.archive,
        async list() {
          listCalls += 1;
          return stores.archive.list();
        },
      },
    };

    const folder = startArchiveFolding({
      stores: wrapped,
      managers: noRunningManagers,
      everyMinutes: null,
    });
    // 起動直後の1回・タイマー、どちらも仕込まれていないはず。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listCalls).toBe(0);

    const refreshed = await folder.refresh();
    expect(refreshed).toBeNull();
    expect(listCalls).toBe(0);

    folder.stop(); // off でも stop() は安全に呼べる。
  });

  it('everyMinutes が指定されていれば起動直後に1回、待たずに叩く', async () => {
    const stores = createMemoryStores();
    const folder = startArchiveFolding({
      stores,
      managers: noRunningManagers,
      everyMinutes: 1,
      intervalMs: 10_000,
      now: FAR_FUTURE,
    });

    const result = await folder.refresh();
    expect(result).not.toBeNull();

    folder.stop();
  });

  it('止めたら以後取りに行かない', async () => {
    const stores = createMemoryStores();
    let listCalls = 0;
    const wrapped: Stores = {
      ...stores,
      archive: {
        ...stores.archive,
        async list() {
          listCalls += 1;
          return stores.archive.list();
        },
      },
    };
    const folder = startArchiveFolding({
      stores: wrapped,
      managers: noRunningManagers,
      everyMinutes: 1,
      intervalMs: 5,
    });
    await folder.refresh();
    folder.stop();

    const after = listCalls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(listCalls).toBe(after);
  });
});
