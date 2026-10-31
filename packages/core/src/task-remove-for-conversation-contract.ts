import type { Task } from './schema.js';
import type { TaskStore } from './store.js';

export interface TaskRemoveForConversationContractOptions {
  /**
   * 読めない行（`taskSchema` に合わない生の値）を、指定した id・指定した欄で器に直接仕込む。
   * 渡さない実装（メモリ: `taskSchema` を通った行しか持てない）では「読めない行」の歯だけを飛ばす。
   */
  readonly plantUnreadable?: (id: string, fields: Record<string, unknown>) => Promise<void>;
}

/**
 * `TaskStore.removeForConversation`（会話の削除）の契約を、実装1つに対して測る。
 * fs / pg / インメモリの3つが同じ関数を呼ぶ。
 *
 * 測る性質:
 * 1. `originConversationId === conversationId` の Task を、**未了も閉じた行も**物理的に消す（`get` が `null`、`list({ includeClosed: true })` に出ない）。
 *    返り値は消した件数。`origin` は問わない: `self` の task は、本文に人間の発言の言い換えを含みうるため
 * 2. 起点の欄を持たない移行前の形の行（`origin: 'human'` / `'self'` で `source === conversationId`）も消す。台帳から移した行は `originConversationId` を持たず、
 *    本文は人間の発言そのものなので、欄で引くだけでは会話を消しても残る
 * 3. 別の会話の行・`origin: 'manager'` / `'external'` で `source` だけが同じ行・どちらの欄も無い行は残る
 * 4. 読めない行（`list()` の `unreadable`）も、生の値の欄が一致すれば消して件数に数える（`plantUnreadable` がある器だけ測る）
 * 5. 冪等（2度目は0件）。NUL を含む会話 id は「無い」と同じ（0件・何も消えない）。消した id は新しい行として足し直せる
 *
 * **会話の id はこの関数が決めた固有の値なので、空のストアでなくても測れる。**
 */
export async function verifyTaskRemoveForConversationContract(
  store: TaskStore,
  options: TaskRemoveForConversationContractOptions = {},
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`Task の器の契約違反（removeForConversation）: ${message}`);
  }
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
  const target = 'contract-task-remove-conv-target';
  const other = 'contract-task-remove-conv-other';
  const gone = ['trc-open', 'trc-closed', 'trc-self', 'trc-migrated'];
  const kept = ['trc-other', 'trc-manager', 'trc-external', 'trc-bare'];

  for (const task of [
    make('trc-open', 'human', { source: target, originConversationId: target }),
    make('trc-closed', 'human', { source: target, originConversationId: target }),
    // 起点の欄だけで会話を指す self（`task_add`）。source は会話 id でない自由な文字列でもよい
    make('trc-self', 'self', { source: 'GitHub の Issue', originConversationId: target }),
    // 台帳から移した行の形: 起点の欄は無く、source が会話 id
    make('trc-migrated', 'human', { source: target }),
    make('trc-other', 'human', { source: other, originConversationId: other }),
    // source が同じ文字列でも、manager / external の source は会話 id ではない
    make('trc-manager', 'manager', { source: target }),
    make('trc-external', 'external', { source: target }),
    make('trc-bare', 'human'),
  ]) {
    const added = await store.add(task);
    if (added.kind !== 'added') fail(`${task.id} が足せない: ${added.kind}`);
  }
  const closed = await store.setStatus('trc-closed', 'done', { by: 'clone', at: at() });
  if (closed.kind !== 'changed') fail(`trc-closed が閉じられない: ${closed.kind}`);

  let expected = gone.length;
  if (options.plantUnreadable !== undefined) {
    await options.plantUnreadable('trc-broken-target', {
      id: 'trc-broken-target',
      createdAt: at(),
      status: 'weird',
      origin: 'human',
      originConversationId: target,
    });
    await options.plantUnreadable('trc-broken-other', {
      id: 'trc-broken-other',
      createdAt: at(),
      status: 'weird',
      origin: 'human',
      originConversationId: other,
    });
    expected += 1;
  }

  const removed = await store.removeForConversation(target);
  if (removed !== expected) {
    fail(
      `消した件数が ${expected} でない（未了・閉じた・self・移行前の形${expected > gone.length ? '・読めない行' : ''}）: ${removed}`,
    );
  }
  const listed = (await store.list({ includeClosed: true })).entries.map((task) => task.id);
  for (const id of gone) {
    if ((await store.get(id)) !== null) fail(`対象の行（${id}）が get から消えていない`);
    if (listed.includes(id)) fail(`対象の行（${id}）が list(includeClosed) に残っている`);
  }
  for (const id of kept) {
    if ((await store.get(id)) === null) fail(`対象でない行（${id}）まで消えた`);
    if (!listed.includes(id)) fail(`対象でない行（${id}）が list から消えた`);
  }
  if (options.plantUnreadable !== undefined) {
    const unreadable = (await store.list({ includeClosed: true })).unreadable.map((row) => row.id);
    if (unreadable.includes('trc-broken-target')) fail('対象の読めない行が残っている');
    if (!unreadable.includes('trc-broken-other')) fail('対象でない読めない行まで消えた');
  }

  if ((await store.removeForConversation(target)) !== 0) fail('2度目が 0 件でない（冪等でない）');
  if ((await store.removeForConversation('contract-task-remove-conv-nothing')) !== 0)
    fail('無い会話が 0 件でない');
  if ((await store.removeForConversation(`${other}\u0000x`)) !== 0)
    fail('NUL を含む会話 id が 0 件でない');
  if ((await store.get('trc-other')) === null) fail('NUL を含む会話 id の呼びが行を消した');

  // 消したあとの id は新しい行として足し直せる（消えた行が「在った」扱いで拒まない）
  const reopened = await store.add(make('trc-open', 'human', { originConversationId: other }));
  if (reopened.kind !== 'added') fail(`物理的に消した id が足し直せない: ${reopened.kind}`);
  const otherExpected = 2 + (options.plantUnreadable === undefined ? 0 : 1);
  if ((await store.removeForConversation(other)) !== otherExpected) {
    fail(`別の会話の行が ${otherExpected} 件でない`);
  }
}
