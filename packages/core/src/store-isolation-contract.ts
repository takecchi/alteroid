import type { Commitment, Job, PendingApproval } from './schema.js';
import type { Stores } from './store.js';

/**
 * **ストアが返す値は、書いた側が握っているオブジェクトと別物であること**を、
 * 実装1つに対して測る（#1072）。
 *
 * ## なぜこれが契約なのか
 *
 * `createMemoryStores()`（`testing.ts`）は3実装の1つとして扱われている —— 台帳の
 * 契約（`verifyCommitmentAppraisalContract`）も日誌の契約群も「3実装すべてが同じ
 * ものを呼ぶこと」と書いてある。**その器が、参照の扱いだけ本物と違っていた。**
 *
 * - **fs / pg は JSON を経由するので必ず写しになる**（ファイルへ書いて読み直す /
 *   jsonb へ入れて取り出す）
 * - **インメモリは `Map` に参照をそのまま入れていた** ⟹ 「台帳から読んで書き換える」
 *   形のコードが、**呼び出し元が握っている同じオブジェクトまで書き換える**
 *
 * ## ⭐ これが実際に歯を殺した（#1054 の作業中に発見）
 *
 * `ManagerPool.appraise` は「走行中の委譲はプールの像を書き、終端した委譲だけ台帳へ
 * 降りる」形にしてある —— 像を見ずに台帳から読むと、プールの次の `#persist` が評定を
 * 黙って踏み消すからである。その性質を測る歯に**わざと壊す変異**を当てたところ、
 * **素のインメモリでは6件とも緑のまま**だった（写しを返す器を噛ませると赤くなる）。
 *
 * ⟹ **歯は在ったが、測っていなかった。** 気づいたのは変異を当てたからである。
 *
 * ## 測っているもの
 *
 * 「書いた値を**あとで書き換えても**、ストアから読み直した値が変わらないこと」だけ
 * である。**読んだ値を書き換えたときにストアが汚れないこと**も同じ性質の裏面なので、
 * 両方向を見る。
 *
 * **vitest に依存しない素の非同期関数にしてある**理由は `journal-order-with-contract.ts`
 * の doc と同じ（`storage-fs` / `storage-pg` へ vitest を持ち込まないため）。
 */
export async function verifyStoreIsolationContract(stores: Stores): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`ストアの参照の隔離の契約違反: ${message}`);
  };

  // --- JobStore（この穴を最初に踏んだ場所） ---
  const job: Job = {
    id: 'isolation-job',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    summary: '隔離の確認',
  };
  await stores.jobs.putJob(job);
  // 書いた側があとで書き換えても、ストアの中身は動かない
  job.summary = '書いた側で書き換えた';
  const storedJob = (await stores.jobs.listJobs()).find((entry) => entry.id === 'isolation-job');
  if (storedJob?.summary !== '隔離の確認') {
    fail(`putJob の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedJob?.summary}`);
  }
  // 読んだ側が書き換えても、ストアの中身は動かない
  if (storedJob !== undefined) storedJob.summary = '読んだ側で書き換えた';
  const reread = (await stores.jobs.listJobs()).find((entry) => entry.id === 'isolation-job');
  if (reread?.summary !== '隔離の確認') {
    fail(`listJobs が返した値を書き換えたら、ストアの中身が動いた: ${reread?.summary}`);
  }

  // --- 承認待ち（同じ器の別の Map） ---
  const approval: PendingApproval = {
    id: 'isolation-approval',
    createdAt: '2026-01-01T00:00:00.000Z',
    question: '隔離の確認',
  };
  await stores.jobs.putApproval(approval);
  approval.question = '書いた側で書き換えた';
  const storedApproval = await stores.jobs.getApproval('isolation-approval');
  if (storedApproval?.question !== '隔離の確認') {
    fail(
      `putApproval の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedApproval?.question}`,
    );
  }

  // --- 台帳 ---
  const commitment: Commitment = {
    id: 'isolation-commitment',
    at: '2026-01-01T00:00:00.000Z',
    origin: 'human',
    body: '隔離の確認',
  };
  await stores.commitments.open(commitment);
  commitment.body = '書いた側で書き換えた';
  const storedCommitment = await stores.commitments.get('isolation-commitment');
  if (storedCommitment?.body !== '隔離の確認') {
    fail(`open の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedCommitment?.body}`);
  }
  // --- 日誌（追記専用。**返した行を書き換えられても店は汚れない**） ---
  const appended = await stores.journal.append({
    type: 'decision',
    decision: '隔離の確認',
    grounds: '隔離の確認',
  });
  // **型を絞ってから書き換える。** `append` の戻り値は日誌の全枝の union なので、
  // `decision` は絞らないと触れない（絞り込み自体がこの歯の主題ではない）。
  if (appended.type !== 'decision') fail('append が別の枝を返した');
  else appended.decision = '返された行を書き換えた';
  const storedEntry = (await stores.journal.list({ types: ['decision'] })).find(
    (entry) => entry.id === appended.id,
  );
  if (storedEntry?.type === 'decision' && storedEntry.decision !== '隔離の確認') {
    fail(`append が返した行を書き換えたら、日誌の中身が動いた: ${storedEntry.decision}`);
  }

  // --- 継続する依頼 ---
  const plan = {
    kind: 'isolation_check',
    spec: { type: 'daily' as const, at: '10:00' },
    request: '隔離の確認',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await stores.schedules.put(plan);
  plan.request = '書いた側で書き換えた';
  const storedPlan = await stores.schedules.get('isolation_check');
  if (storedPlan?.request !== '隔離の確認') {
    fail(`put の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedPlan?.request}`);
  }
}
