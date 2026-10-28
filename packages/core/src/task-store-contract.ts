import { UnreadableTaskError } from './store.js';
import type { TaskStore } from './store.js';
import type { Task, TaskStatus } from './schema.js';

// vitest に依存しない素の関数にする（`verifyCommitmentReopenContract` と同じ理由）。
// 空のストアを渡すこと。Task の並び・状態遷移・closed の扱い・読めない行の分離の契約を、メモリ・fs・pg の3実装で揃える（#5469 P2）。
export interface TaskStoreContractOptions {
  /**
   * 読めない行を器に直接仕込む（スキーマに合わない生の値を、指定した id で入れる）。
   * 渡さない実装（メモリ: `taskSchema` を通った行しか持てない）では「読めない行」の歯だけを飛ばす。
   */
  readonly plantUnreadable?: (id: string) => Promise<void>;
}

export async function verifyTaskStoreContract(
  store: TaskStore,
  options: TaskStoreContractOptions = {},
): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`TaskStore の契約違反: ${message}`);
  };
  let tick = 0;
  const at = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1))).toISOString();
  const make = (id: string, origin: Task['origin'], extra: Partial<Task> = {}): Task => ({
    id,
    createdAt: at(),
    updatedAt: at(),
    status: 'queued',
    origin,
    title: `title-${id}`,
    body: `body-${id}`,
    ...extra,
  });
  const ids = async (includeClosed = false): Promise<string> =>
    (await store.list({ includeClosed })).entries.map((task) => task.id).join(',');
  const expectOrder = async (expected: string, label: string, includeClosed = false) => {
    const actual = await ids(includeClosed);
    if (actual !== expected) fail(`${label}: 並びが ${expected} でなく ${actual}`);
  };
  const addOk = async (task: Task, placement?: Parameters<TaskStore['add']>[1]) => {
    const result = await store.add(task, placement);
    if (result.kind !== 'added') fail(`${task.id} が追加できない: ${result.kind}`);
  };

  if ((await store.list()).entries.length !== 0) fail('空のストアを渡すこと');

  // 既定の挿入: human 起点は「開いている human 起点の最後の直後」（無ければ先頭）、それ以外は末尾
  await addOk(make('s1', 'self'));
  await addOk(make('s2', 'self'));
  await expectOrder('s1,s2', 'self は末尾へ届いた順');
  await addOk(make('h1', 'human'));
  await expectOrder('h1,s1,s2', '開いている human が無いとき human は先頭');
  await addOk(make('h2', 'human'));
  await expectOrder('h1,h2,s1,s2', 'human は開いている human の最後の直後');
  await addOk(make('m1', 'manager'));
  await addOk(make('e1', 'external'));
  await expectOrder('h1,h2,s1,s2,m1,e1', 'human 以外は末尾');

  // 追加の冪等と明示の位置
  const existed = await store.add(make('s1', 'self', { title: '上書きされてはいけない' }));
  if (existed.kind !== 'existed') fail(`同じ id の追加が existed にならない: ${existed.kind}`);
  if ((await store.get('s1'))?.title !== 'title-s1') fail('同じ id の追加が行を書き換えた');
  const noAnchor = await store.add(make('x0', 'self'), { kind: 'after', anchorId: 'nope' });
  if (noAnchor.kind !== 'anchor-not-found')
    fail(`無いアンカーが anchor-not-found にならない: ${noAnchor.kind}`);
  if ((await store.get('x0')) !== null) fail('アンカーが無いのに行が入った');
  await addOk(make('x1', 'self'), { kind: 'front' });
  await addOk(make('x2', 'self'), { kind: 'before', anchorId: 's1' });
  await addOk(make('x3', 'self'), { kind: 'after', anchorId: 's2' });
  // human 以外にする: 以降の「最後の human」の判定を x4 が動かさないため
  await addOk(make('x4', 'external'), { kind: 'back' });
  await expectOrder(
    'x1,h1,h2,x2,s1,s2,x3,m1,e1,x4',
    '明示の位置（front / before / after / back）が既定より優先される',
  );

  // move
  const moves: [string, Parameters<TaskStore['move']>[1], string][] = [
    ['x4', { kind: 'front' }, 'x4,x1,h1,h2,x2,s1,s2,x3,m1,e1'],
    ['x4', { kind: 'back' }, 'x1,h1,h2,x2,s1,s2,x3,m1,e1,x4'],
    ['e1', { kind: 'before', anchorId: 'x1' }, 'e1,x1,h1,h2,x2,s1,s2,x3,m1,x4'],
    ['e1', { kind: 'after', anchorId: 'h2' }, 'x1,h1,h2,e1,x2,s1,s2,x3,m1,x4'],
  ];
  for (const [id, placement, expected] of moves) {
    const moved = await store.move(id, placement);
    if (moved.kind !== 'moved') fail(`${id} が動かない: ${moved.kind}`);
    await expectOrder(expected, `move ${id} ${placement.kind}`);
  }
  if ((await store.move('s1', { kind: 'after', anchorId: 's1' })).kind !== 'anchor-is-self')
    fail('自分自身をアンカーにした move が anchor-is-self にならない');
  if ((await store.move('s1', { kind: 'after', anchorId: 'nope' })).kind !== 'anchor-not-found')
    fail('無いアンカーの move が anchor-not-found にならない');
  if ((await store.move('nope', { kind: 'front' })).kind !== 'not-found')
    fail('無い id の move が not-found にならない');
  if ((await store.move('nu\u0000ll', { kind: 'front' })).kind !== 'not-found')
    fail('NUL を含む id の move が not-found にならない');
  await expectOrder('x1,h1,h2,e1,x2,s1,s2,x3,m1,x4', '失敗した move は並びを変えない');

  // 状態遷移
  const setStatus = (id: string, status: TaskStatus, reason?: string) =>
    store.setStatus(id, status, {
      by: 'clone',
      at: at(),
      ...(reason === undefined ? {} : { reason }),
    });
  for (const status of [
    'waiting',
    'needs_decision',
    'queued',
    'needs_decision',
    'waiting',
  ] as const) {
    const result = await setStatus('s1', status);
    if (result.kind !== 'changed' || result.task.status !== status)
      fail(`queued / waiting / needs_decision の相互の遷移が通らない: -> ${status} ${result.kind}`);
  }
  await expectOrder(
    'x1,h1,h2,e1,x2,s1,s2,x3,m1,x4',
    '開いている状態どうしの遷移は並びを動かさない',
  );
  const same = await setStatus('s1', 'waiting');
  if (same.kind !== 'unchanged') fail(`同じ状態への遷移が unchanged にならない: ${same.kind}`);
  if ((await setStatus('nope', 'done', 'r')).kind !== 'not-found')
    fail('無い id の setStatus が not-found にならない');
  if ((await setStatus('nu\u0000ll', 'done', 'r')).kind !== 'not-found')
    fail('NUL を含む id の setStatus が not-found にならない');

  // closed: list の既定から外れ、並びの計算（アンカー・human の最後）からも外れる
  const closedResult = await setStatus('h2', 'done', '終わった');
  if (closedResult.kind !== 'changed') return fail(`done にできない: ${closedResult.kind}`);
  const closed = closedResult.task;
  if (
    closed.closedReason !== '終わった' ||
    closed.closedBy !== 'clone' ||
    closed.closedAt === undefined
  )
    fail(`閉じた記録が残らない: ${JSON.stringify(closed)}`);
  await expectOrder('x1,h1,e1,x2,s1,s2,x3,m1,x4', 'closed は list の既定に出ない');
  await expectOrder(
    'x1,h1,e1,x2,s1,s2,x3,m1,x4,h2',
    'includeClosed は閉じた行を開いた行の後ろに出す',
    true,
  );
  if ((await store.get('h2'))?.status !== 'done') fail('closed の行が get で読めない');
  if ((await store.move('h2', { kind: 'front' })).kind !== 'closed')
    fail('closed の move が closed にならない');
  const closedAnchor = await store.add(make('c1', 'self'), { kind: 'after', anchorId: 'h2' });
  if (closedAnchor.kind !== 'anchor-not-found')
    fail(`closed をアンカーにできた: ${closedAnchor.kind}`);
  if ((await store.move('s1', { kind: 'before', anchorId: 'h2' })).kind !== 'anchor-not-found')
    fail('closed をアンカーにした move が anchor-not-found にならない');
  await addOk(make('h3', 'human'));
  await expectOrder(
    'x1,h1,h3,e1,x2,s1,s2,x3,m1,x4',
    'closed の human は「最後の human」に数えない（h1 の直後に入る）',
  );

  // 不正遷移は結果で返し、行を変えない
  for (const status of ['waiting', 'needs_decision', 'cancelled'] as const) {
    const rejected = await setStatus('h2', status, 'r');
    if (rejected.kind !== 'rejected' || rejected.from !== 'done' || rejected.to !== status)
      fail(`done から ${status} が rejected にならない: ${rejected.kind}`);
  }
  if ((await store.get('h2'))?.closedReason !== '終わった')
    fail('rejected が閉じた記録を書き換えた');
  const cancelled = await setStatus('s2', 'cancelled', '要らなくなった');
  if (cancelled.kind !== 'changed') return fail(`cancelled にできない: ${cancelled.kind}`);
  if ((await setStatus('s2', 'done', 'r')).kind !== 'rejected')
    fail('cancelled から done が rejected にならない');
  if ((await setStatus('s2', 'cancelled', 'r')).kind !== 'unchanged')
    fail('cancelled への同じ遷移が unchanged にならない');

  // reopen: queued へだけ戻せる。閉じた記録を外し、既定の規則（human は開いている human の最後の直後）で置き直す
  const reopened = await setStatus('h2', 'queued');
  if (reopened.kind !== 'changed') return fail(`reopen できない: ${reopened.kind}`);
  if (reopened.before.closedReason !== '終わった') fail('reopen の before が閉じた行の写しでない');
  const after = await store.get('h2');
  if (
    after === null ||
    after.status !== 'queued' ||
    after.closedAt !== undefined ||
    after.closedReason !== undefined ||
    after.closedBy !== undefined
  )
    fail(`reopen が閉じた記録を外さない: ${JSON.stringify(after)}`);
  await expectOrder(
    'x1,h1,h3,h2,e1,x2,s1,x3,m1,x4',
    'reopen した human は開いている human の最後の直後に置き直される',
  );
  const afterCancelled = await store.get('s2');
  if (afterCancelled?.status !== 'cancelled') fail('cancelled の行が読めない');

  // 隙間が尽きても順序が守られる（同じアンカーの直後へ何度も割り込む）
  await addOk(make('g-left', 'self'), { kind: 'back' });
  await addOk(make('g-right', 'self'), { kind: 'back' });
  const gapIds: string[] = [];
  for (let i = 0; i < 120; i += 1) {
    const id = `g${i}`;
    await addOk(make(id, 'self'), { kind: 'after', anchorId: 'g-left' });
    gapIds.unshift(id);
  }
  await expectOrder(
    `x1,h1,h3,h2,e1,x2,s1,x3,m1,x4,g-left,${gapIds.join(',')},g-right`,
    '同じ隙間への割り込みを繰り返しても並びが崩れない',
  );

  // NUL
  let nulRejected = false;
  try {
    await store.add(make('nu\u0000l', 'self'));
  } catch {
    nulRejected = true;
  }
  if (!nulRejected) fail('NUL を含む id の add が断られない');
  if ((await store.get('nu\u0000l')) !== null) fail('NUL を含む id の get が null にならない');
  await addOk(make('nul-body', 'self', { title: 'a\u0000b', body: 'c\u0000d' }));
  const stripped = await store.get('nul-body');
  if (stripped?.title !== 'ab' || stripped.body !== 'cd')
    fail('title / body の NUL が落ちて残らない');
  await addOk(make('lone-surrogate', 'self', { body: 'x\ud800y' }));
  if ((await store.get('lone-surrogate'))?.body !== 'x�y')
    fail('孤立サロゲートが3実装で同じ形に直らない（pg は jsonb に入れる前に必ず直す）');

  // 読めない行は専用エラー・一覧の unreadable。一覧を丸ごと潰さない
  if (options.plantUnreadable !== undefined) {
    const before = await ids();
    await options.plantUnreadable('broken-1');
    const listed = await store.list({ includeClosed: true });
    if (!listed.unreadable.some((row) => row.id === 'broken-1'))
      fail('読めない行が unreadable に出ない');
    if (listed.entries.some((task) => task.id === 'broken-1')) fail('読めない行が entries に出た');
    if ((await ids()) !== before) fail('読めない行が読める行の並びを変えた');
    for (const [label, run] of [
      ['get', () => store.get('broken-1')],
      ['move', () => store.move('broken-1', { kind: 'front' })],
      ['setStatus', () => setStatus('broken-1', 'done', 'r')],
    ] as const) {
      let thrown: unknown;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }
      if (!(thrown instanceof UnreadableTaskError))
        fail(`読めない行の ${label} が UnreadableTaskError を投げない`);
    }
    if ((await store.add(make('broken-1', 'self'))).kind !== 'existed')
      fail('読めない行と同じ id の add が existed にならない');
  }

  // clear
  const total = (await store.list({ includeClosed: true })).entries.length;
  const planted = options.plantUnreadable === undefined ? 0 : 1;
  const cleared = await store.clear();
  if (cleared !== total + planted) fail(`clear の件数が ${total + planted} でなく ${cleared}`);
  const empty = await store.list({ includeClosed: true });
  if (empty.entries.length !== 0 || empty.unreadable.length !== 0) fail('clear の後に行が残った');
}
