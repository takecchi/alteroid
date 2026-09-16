import { describeCommitmentAppraisal } from './schema.js';
import type { CommitmentStore } from './store.js';

/**
 * `CommitmentStore.appraise` の契約を、実装1つに対して測る（#1054。自己改善の段1）。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか。**
 * `journal-order-with-contract.ts` の doc と同じ理由 —— `packages/storage-fs` と
 * `packages/storage-pg` は `@alteroid/core` を実行時の依存として読むので、ここを
 * `expect` で書くとその依存を2パッケージへ持ち込むことになる。食い違ったら
 * `throw` する素の関数にして、呼ぶ側が好きな assertion 道具でラップする。
 *
 * **測る5性質。3実装（`packages/core/src/testing.ts` のインメモリ /
 * `packages/storage-fs/src/commitments.ts` / `packages/storage-pg/src/commitments.ts`）
 * すべてがこれを呼ぶこと。**
 *
 * 1. **未評定は欄そのものが無い** —— `good` にも `bad` にも寄せない
 * 2. **未了の行にも付く** —— 「片付いてから」を器が強制しない
 * 3. **片付いた行にも付く** —— 評定の本題はこちら
 * 4. **⭐ `reason` を渡さない上書きは、前の理由を消す** —— 残すと、人間が理由
 *    無しで覆したときに**クローンが `good` と書いた理由が `bad` の理由として
 *    残る**。値だけ入れ替わって、説明が前の書き手のものになる
 * 5. **無い id は `false`** —— 「書けた」と嘘をつかない
 *
 * **⚠️ 4 は「2回書けば消える」ではなく「状態が残っているところへ2回目を当てる」
 * 形でしか出ない。** 1回目で理由を書き、2回目で理由を省く —— 空の台帳に1回
 * 当てるだけのテストでは絶対に出ない（AGENTS.md「2回通しても壊れない」を測る
 * テストは、1周目と2周目のあいだに「2周目でだけ壊れる状態」を挟むこと）。
 */
export async function verifyCommitmentAppraisalContract(store: CommitmentStore): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`CommitmentStore.appraise の契約違反: ${message}`);
  };

  const openId = 'contract-appraise-open';
  const closedId = 'contract-appraise-closed';
  await store.open({
    id: openId,
    at: '2026-01-01T00:00:00.000Z',
    origin: 'human',
    body: '未了のまま評定する件',
  });
  await store.open({
    id: closedId,
    at: '2026-01-01T00:00:00.000Z',
    origin: 'human',
    body: '片付けてから評定する件',
  });

  // 1. 未評定は欄そのものが無い
  const fresh = await store.get(openId);
  if (fresh === null) fail('開いた直後の行が読めない');
  if (fresh?.appraisal !== undefined)
    fail(`評定していない行に appraisal が在る: ${fresh.appraisal}`);
  if (describeCommitmentAppraisal(fresh ?? {}) !== null) {
    fail('未評定の行が字面を持っている（印が無いことが未評定の表し方である）');
  }

  // 2. 未了の行にも付く
  if (
    !(await store.appraise(openId, '2026-01-02T00:00:00.000Z', 'unclear', 'clone', '材料が無い'))
  ) {
    fail('未了の行に評定を付けられなかった');
  }
  const appraisedOpen = await store.get(openId);
  if (appraisedOpen?.appraisal !== 'unclear') fail('未了の行の評定が書かれていない');
  if (appraisedOpen?.appraisedBy !== 'clone') fail('appraisedBy が書かれていない');
  if (appraisedOpen?.appraisalReason !== '材料が無い') fail('appraisalReason が書かれていない');
  if (appraisedOpen?.closedAt !== undefined) fail('評定が行を閉じてしまっている');

  // 3. 片付いた行にも付く
  await store.close(closedId, '2026-01-02T00:00:00.000Z', '終わった', 'clone');
  if (
    !(await store.appraise(closedId, '2026-01-03T00:00:00.000Z', 'good', 'clone', 'うまくいった'))
  ) {
    fail('片付いた行に評定を付けられなかった');
  }
  const appraisedClosed = await store.get(closedId);
  if (appraisedClosed?.appraisal !== 'good') fail('片付いた行の評定が書かれていない');
  if (appraisedClosed?.closedReason !== '終わった') fail('評定が closedReason を潰している');

  // 4. ⭐ reason を渡さない上書きは、前の理由を消す
  if (!(await store.appraise(closedId, '2026-01-04T00:00:00.000Z', 'bad', 'human'))) {
    fail('人間の覆しが通らなかった');
  }
  const overturned = await store.get(closedId);
  if (overturned?.appraisal !== 'bad') fail('覆した値が書かれていない');
  if (overturned?.appraisedBy !== 'human') fail('覆した主体が書かれていない');
  if (overturned?.appraisalReason !== undefined) {
    fail(
      `理由を渡さない覆しの後に前の理由が残っている: ${overturned?.appraisalReason} ` +
        '（値だけ入れ替わって、説明が前の書き手のものになる）',
    );
  }

  // 5. 無い id は false
  if (
    await store.appraise('contract-appraise-missing', '2026-01-05T00:00:00.000Z', 'good', 'human')
  ) {
    fail('台帳に無い id へ評定を付けて true を返した');
  }
}
