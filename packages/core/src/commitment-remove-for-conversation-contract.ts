import type { CommitmentStore } from './store.js';

/**
 * `CommitmentStore.removeForConversation`（会話の削除）の契約を、実装1つに対して測る。
 * fs / pg / インメモリの3つが同じ関数を呼ぶ（`commitment-edit-if-match-contract.ts` と同じ形）。
 *
 * 測る性質:
 * 1. `origin: 'human'` または `'self'` で `source === conversationId` の行を、**未了も片付いた行も**物理的に消す
 *    （`get` が `null`、`list({ includeClosed: true })` に出ない）。返り値は消した件数。
 *    `self` も消す: クローンが会話から載せた行の本文は人間の発言の言い換えを含みうるので、残すと会話を消しても読めてしまうため
 * 2. 別の会話の行・`origin: 'manager'` / `'external'` の行（`source` が同じ文字列でも）・`source` の無い行は残る
 *    （`manager` / `external` の `source` は会話 id ではない）
 * 3. 冪等（2度目は0件）。NUL を含む会話 id は「無い」と同じ（0件・何も消えない）
 *
 * **会話の id はこの関数が決めた固有の値なので、空のストアでなくても測れる。**
 */
export async function verifyCommitmentRemoveForConversationContract(
  store: CommitmentStore,
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`台帳の器の契約違反（removeForConversation）: ${message}`);
  }
  const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
  const target = 'contract-remove-conv-target';
  const other = 'contract-remove-conv-other';

  await store.open({ id: 'crc-open', at: t(0), origin: 'human', source: target, body: '未了' });
  await store.open({
    id: 'crc-closed',
    at: t(1),
    origin: 'human',
    source: target,
    body: '片付いた',
  });
  await store.close('crc-closed', t(2), '済んだ', 'clone');
  await store.open({ id: 'crc-other', at: t(3), origin: 'human', source: other, body: '別の会話' });
  await store.open({
    id: 'crc-self',
    at: t(4),
    origin: 'self',
    source: target,
    body: 'クローン自身の仕事（source が同じ）',
  });
  await store.open({ id: 'crc-nosource', at: t(5), origin: 'human', body: 'source の無い行' });
  await store.open({
    id: 'crc-manager',
    at: t(7),
    origin: 'manager',
    source: target,
    body: 'マネージャー由来（source が同じ文字列）',
  });

  const removed = await store.removeForConversation(target);
  if (removed !== 3) fail(`消した件数が 3 でない（未了1＋片付いた1＋クローンの行1）: ${removed}`);
  for (const id of ['crc-open', 'crc-closed', 'crc-self']) {
    if ((await store.get(id)) !== null) fail(`対象の行（${id}）が get から消えていない`);
  }
  const listed = (await store.list({ includeClosed: true })).entries.map((entry) => entry.id);
  for (const id of ['crc-open', 'crc-closed', 'crc-self']) {
    if (listed.includes(id)) fail(`対象の行（${id}）が list(includeClosed) に残っている`);
  }
  for (const id of ['crc-other', 'crc-manager', 'crc-nosource']) {
    if ((await store.get(id)) === null) fail(`対象でない行（${id}）まで消えた`);
    if (!listed.includes(id)) fail(`対象でない行（${id}）が list から消えた`);
  }

  if ((await store.removeForConversation(target)) !== 0) fail('2度目が 0 件でない（冪等でない）');
  if ((await store.removeForConversation('contract-remove-conv-nothing')) !== 0)
    fail('無い会話が 0 件でない');
  if ((await store.removeForConversation(`${other}\u0000x`)) !== 0)
    fail('NUL を含む会話 id が 0 件でない');
  if ((await store.get('crc-other')) === null) fail('NUL を含む会話 id の呼びが行を消した');

  // 消したあとの id は新しい行として開き直せる（刈られた id のように「在った」扱いで拒まない）。
  const reopened = await store.open({
    id: 'crc-open',
    at: t(6),
    origin: 'human',
    source: other,
    body: '同じ id の開き直し',
  });
  if (!reopened.opened) fail('物理的に消した id が開き直せない');
  if ((await store.removeForConversation(other)) !== 2) fail('別の会話の行が 2 件でない');
}
