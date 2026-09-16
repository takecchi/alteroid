import type { CommitmentStore } from './store.js';

/**
 * `CommitmentStore.open` の**畳み込み**の契約を、実装1つに対して測る（issue #1041）。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか。**
 * `commitment-appraisal-contract.ts` の doc と同じ理由 —— `packages/storage-fs` と
 * `packages/storage-pg` は `@alteroid/core` を実行時の依存として読むので、ここを
 * `expect` で書くとその依存を2パッケージへ持ち込むことになる。食い違ったら `throw`
 * する素の関数にして、呼ぶ側が好きな assertion 道具でラップする。
 *
 * ## なぜ3実装で測る必要があるか
 *
 * 畳み込みの規則そのものは `findOpenManagerDuplicate`（`store.ts`）に1本しか無く、
 * in-memory と fs はそれを**そのまま呼ぶ**。**`storage-pg` だけが同じ規則を SQL で
 * 書き直している** —— DB の制約にしないとプロセスを跨げないためである
 * （`PgCommitmentStore.open` の doc）。⟹ **規則が2箇所に在る以上、ずれる。**
 * ここはそのずれを落とすためだけに在る。
 *
 * ## ⛔ この契約が名乗れるのは「プロセス内で原子」までである
 *
 * 7 は**同じ同期区間から2件の `open` を起こして**測るが、それはプロセスの中の話
 * でしかない。**3実装がここで緑になっても「2つのデーモンが同じストアを指しても
 * 割れない」は言えない** —— fs の排他は promise の連鎖でファイルロックではなく、
 * in-memory はそもそもプロセスの中の `Map` である。**プロセスを跨いでも原子なのは
 * `storage-pg` だけ**で、それは DB の部分 unique 索引が守っている（そちらは
 * `packages/storage-pg/src/index.test.ts` の索引の歯が別に測る）。
 *
 * **ここで3つ緑が並ぶことを「デプロイの重なりは塞がれた」と読ませないこと。**
 * 読ませた瞬間に、fs については嘘になる。
 *
 * ## 測る7性質
 *
 * 1. **同一マネージャー×同一本文×未了の2件目は開かない** —— 畳んだ先の id も返す
 * 2. **陰性対照: `source` が違えば畳まない**（別のマネージャーの同じ一言は別の仕事）
 * 3. **陰性対照: 本文が違えば畳まない**
 * 4. **陰性対照: `origin` が `'manager'` でなければ畳まない** —— 2人の人間が同じ
 *    一言を別の会話で送っただけで1件に潰れてはならない
 * 5. **閉じた行と同文は畳まない** —— 一度閉じれば「未了」ではない。「二度と報告
 *    できなくなる」側へ倒さない
 * 6. **同じ id の2回目は `folded: false`** —— 畳み込みを足したことで、元からある
 *    冪等性（配り直された合図が閉じた行を開き直さない）の意味を変えていない
 * 7. **同じ同期区間から2件でも、開くのは1件だけ** —— 判定と書き込みが1操作である
 *    ことそのもの。⚠ **`await` を挟んで直列に呼ぶ形では、これは測れない**
 *    （#1041 の欠陥は「読んでから書く」あいだに割り込まれることなので、割り込む
 *    隙間を作らない呼び方では、壊れた実装でも緑になる）
 */
export async function verifyCommitmentFoldContract(store: CommitmentStore): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`CommitmentStore.open の畳み込みの契約違反: ${message}`);
  };
  const managerEntry = (
    id: string,
    body: string,
    source = 'mgr-fold',
    at = '2026-01-01T00:00:00.000Z',
  ) => ({ id, at, origin: 'manager', source, body }) as const;

  // 1. 同一マネージャー×同一本文×未了の2件目は開かない
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

  // 2. 陰性対照: source が違えば畳まない
  const otherSource = await store.open(
    managerEntry('fold-2', '同じ一言', 'mgr-other', '2026-01-01T00:00:02.000Z'),
  );
  if (!otherSource.opened) fail('別のマネージャーの同文が畳まれた');

  // 3. 陰性対照: 本文が違えば畳まない
  const otherBody = await store.open(
    managerEntry('fold-3', '違う一言', 'mgr-fold', '2026-01-01T00:00:03.000Z'),
  );
  if (!otherBody.opened) fail('本文が違うのに畳まれた');

  // 4. 陰性対照: origin が manager でなければ畳まない
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

  // 5. 閉じた行と同文は畳まない
  await store.close('fold-3', '2026-01-01T00:01:00.000Z', '片付けた', 'clone');
  const afterClose = await store.open(
    managerEntry('fold-5', '違う一言', 'mgr-fold', '2026-01-01T00:00:06.000Z'),
  );
  if (!afterClose.opened) fail('閉じた行と同文なのに畳まれた（二度と報告できなくなる）');

  // 6. 同じ id の2回目は folded: false（元からある冪等性の意味を変えていない）
  const sameId = await store.open(managerEntry('fold-1a', '同じ一言'));
  if (sameId.opened) fail('同じ id の2回目が開いた');
  if (sameId.folded) fail('同じ id の2回目が folded になった（畳んだのではなく既に在る）');

  // 7. ⭐ 同じ同期区間から2件でも、開くのは1件だけ
  //
  // **`await` を挟まないことがこの歯の全部である。** 挟めば、読んでから書く実装
  // （#1041 そのもの）でも緑になる。
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
