import { expectNulRejected } from './nul-contract-support.js';
import type { CommitmentStore } from './store.js';

// vitest に依存しない素の関数にする: storage-fs と storage-pg は core を実行時の依存として読むので、expect を書くとその依存を2パッケージへ持ち込むため
// 3実装が緑でも「2つのデーモンが同じストアを指しても割れない」とは読ませない: 7 は同じ同期区間の1プロセスの中しか測らないため
export async function verifyCommitmentFoldContract(
  store: CommitmentStore,
  options: { readonly concurrent?: boolean } = {},
): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`CommitmentStore.open の畳み込みの契約違反: ${message}`);
  };
  const managerEntry = (
    id: string,
    body: string,
    source = 'mgr-fold',
    at = '2026-01-01T00:00:00.000Z',
  ) => ({ id, at, origin: 'manager', source, body }) as const;

  const first = await store.open(managerEntry('fold-1a', '同じ一言'));
  if (!first.opened) fail('1件目が開いていない');
  if (first.folded) fail('1件目が畳まれた（畳む相手が居ない）');
  const second = await store.open(
    managerEntry('fold-1b', '同じ一言', 'mgr-fold', '2026-01-01T00:00:01.000Z'),
  );
  if (second.opened) fail('同一マネージャー×同一本文×未了の2件目が開いた');
  if (!second.folded) fail('2件目が畳まれていない（folded が偽）');
  if (second.foldedInto !== 'fold-1a')
    fail(`畳んだ先の id が違う（期待: fold-1a、実際: ${String(second.foldedInto)}）`);
  if ((await store.get('fold-1b')) !== null) fail('畳んだはずの行が台帳に在る');

  const otherSource = await store.open(
    managerEntry('fold-2', '同じ一言', 'mgr-other', '2026-01-01T00:00:02.000Z'),
  );
  if (!otherSource.opened) fail('別のマネージャーの同文が畳まれた');

  const otherBody = await store.open(
    managerEntry('fold-3', '違う一言', 'mgr-fold', '2026-01-01T00:00:03.000Z'),
  );
  if (!otherBody.opened) fail('本文が違うのに畳まれた');

  const human = {
    id: 'fold-4a',
    at: '2026-01-01T00:00:04.000Z',
    origin: 'human',
    body: '人間の同じ一言',
  } as const;
  const humanTwin = { ...human, id: 'fold-4b', at: '2026-01-01T00:00:05.000Z' };
  if (!(await store.open(human)).opened) fail('人間起点の1件目が開いていない');
  if (!(await store.open(humanTwin)).opened)
    fail('人間起点の同文が畳まれた（別々の発言が1件に潰れている）');

  await store.close('fold-3', '2026-01-01T00:01:00.000Z', '片付けた', 'clone');
  const afterClose = await store.open(
    managerEntry('fold-5', '違う一言', 'mgr-fold', '2026-01-01T00:00:06.000Z'),
  );
  if (!afterClose.opened) fail('閉じた行と同文なのに畳まれた（二度と報告できなくなる）');

  const sameId = await store.open(managerEntry('fold-1a', '同じ一言'));
  if (sameId.opened) fail('同じ id の2回目が開いた');
  if (sameId.folded) fail('同じ id の2回目が folded になった（畳んだのではなく既に在る）');

  {
    const nulId = 'commit-nul-8\u0000id';
    const nulEntry = {
      id: nulId,
      at: '2026-01-02T00:00:00.000Z',
      origin: 'human',
      body: '本文',
    } as const;
    await expectNulRejected(fail, 'open(NULを含むid)', () => store.open(nulEntry), 'commit-nul-8');
    const bodyId = 'commit-nul-8-body';
    const opened = await store.open({
      id: bodyId,
      at: '2026-01-02T00:00:01.000Z',
      origin: 'human',
      body: '本\u0000文',
    });
    if (!opened.opened) fail('本文にNULを含む行が開かない');
    const readBody = await store.get(bodyId);
    if (readBody?.body !== '本文')
      fail(`open の本文の NUL が残る: ${JSON.stringify(readBody?.body)}`);

    const readOutcomes: Array<[string, () => Promise<unknown>, unknown]> = [
      ['get(NULを含むid)はnull', () => store.get(nulId), null],
      [
        'close(NULを含むid)はfalse',
        () => store.close(nulId, '2026-01-03T00:00:00.000Z', 'r', 'clone'),
        false,
      ],
      [
        'editBody(NULを含むid)はfalse',
        () => store.editBody(nulId, 'x', '2026-01-03T00:00:00.000Z', 'clone'),
        false,
      ],
    ];
    for (const [label, call, expected] of readOutcomes) {
      let outcome: unknown;
      try {
        outcome = await call();
      } catch (error) {
        fail(`${label}（投げた: ${error instanceof Error ? error.name : typeof error}）`);
      }
      if (outcome !== expected) fail(`${label}（実際: ${JSON.stringify(outcome)}）`);
    }

    const edited = await store.editBody(bodyId, '直\u0000し', '2026-01-03T00:00:00.000Z', 'clone');
    if (!edited) fail('editBody が通らない');
    if ((await store.get(bodyId))?.body !== '直し') fail('editBody の本文の NUL が残る');

    let closedMany: string[] = [];
    try {
      closedMany = await store.closeMany(
        [nulId, bodyId],
        '2026-01-04T00:00:00.000Z',
        '終\u0000わり',
        'clone',
      );
    } catch (error) {
      fail(
        `closeMany(NULを含むidを混ぜる)は投げない（${error instanceof Error ? error.name : typeof error}）`,
      );
    }
    if (JSON.stringify(closedMany) !== JSON.stringify([bodyId]))
      fail(`closeMany がNULを含むidを無いものとして扱わない: ${JSON.stringify(closedMany)}`);
    const closedRow = await store.get(bodyId);
    if (closedRow?.closedReason !== '終わり')
      fail(`closeMany の理由の NUL が残る: ${JSON.stringify(closedRow?.closedReason)}`);

    const reasonId = 'commit-nul-8-reason';
    await store.open({ id: reasonId, at: '2026-01-02T00:00:02.000Z', origin: 'human', body: 'r' });
    if (!(await store.close(reasonId, '2026-01-04T00:00:00.000Z', '閉\u0000じ', 'clone')))
      fail('close が通らない');
    if ((await store.get(reasonId))?.closedReason !== '閉じ') fail('close の理由の NUL が残る');

    if ((await store.get(nulId)) !== null) fail('断ったはずのNUL idの行が在る');
    const srcA = await store.open({
      id: 'commit-nul-8-src-a',
      at: '2026-01-02T00:00:03.000Z',
      origin: 'manager',
      source: 'mgr-nul-\u0000src',
      body: 'source の NUL の一言',
    });
    if (!srcA.opened) fail('sourceにNULを含む行が開かない');
    const srcRow = await store.get('commit-nul-8-src-a');
    if (srcRow?.source !== 'mgr-nul-src')
      fail(`source の NUL が残る: ${JSON.stringify(srcRow?.source)}`);
    const srcB = await store.open({
      id: 'commit-nul-8-src-b',
      at: '2026-01-02T00:00:04.000Z',
      origin: 'manager',
      source: 'mgr-nul-src',
      body: 'source の NUL の一言',
    });
    if (srcB.opened || !srcB.folded)
      fail(`NULを落とした source が同じ行を畳まない: ${JSON.stringify(srcB)}`);
    const srcC = await store.open({
      id: 'commit-nul-8-src-c',
      at: '2026-01-02T00:00:05.000Z',
      origin: 'manager',
      source: 'mgr-nul-\u0000src',
      body: 'source の NUL の一言',
    });
    if (srcC.opened || !srcC.folded)
      fail(`NULを含む source が同じ行を畳まない: ${JSON.stringify(srcC)}`);
  }

  // source の無い行どうしを畳まない: 「同じマネージャー」とは言えないため
  {
    const noSource = {
      id: 'fold-9a',
      at: '2026-01-03T00:00:00.000Z',
      origin: 'manager',
      body: '出所の無い同じ一言',
    } as const;
    const noSourceTwin = { ...noSource, id: 'fold-9b', at: '2026-01-03T00:00:01.000Z' };
    const a = await store.open(noSource);
    if (!a.opened) fail(`source の無い1件目が開いていない: ${JSON.stringify(a)}`);
    const b = await store.open(noSourceTwin);
    if (!b.opened || b.folded)
      fail(
        `source の無い同文が畳まれた（出所の分からない行どうしを同一視した）: ${JSON.stringify(b)}`,
      );
  }

  // concurrent: false では同時の2件を測らない: 弾くのは DB の部分 unique 索引で、索引を落とした DB では同時の2件が両方開くため
  if (options.concurrent === false) return;

  // await を挟まない: 挟むと、読んでから書く実装でも緑になるため
  const race = await Promise.all([
    store.open(managerEntry('fold-7a', '同時に来た一言', 'mgr-race', '2026-01-01T00:00:07.000Z')),
    store.open(managerEntry('fold-7b', '同時に来た一言', 'mgr-race', '2026-01-01T00:00:08.000Z')),
  ]);
  const opened = race.filter((result) => result.opened);
  if (opened.length !== 1)
    fail(`同じ同期区間から起こした2件のうち ${opened.length} 件が開いた（1件であること）`);
  const foldedRace = race.filter((result) => result.folded);
  if (foldedRace.length !== 1)
    fail(`畳まれたと答えた件数が ${foldedRace.length} 件（1件であること）`);
  const raceRows = (await store.list()).entries.filter((entry) => entry.source === 'mgr-race');
  if (raceRows.length !== 1)
    fail(`同時に来た2件で台帳が ${raceRows.length} 行になった（1行であること）`);
}
