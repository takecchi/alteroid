import { InvalidConversationCursorError, readConversationPage } from './conversation.js';
import type { ConversationCursor } from './conversation.js';
import type { JournalEntry } from './schema.js';
import type { JournalStore } from './store.js';

/**
 * 会話の一覧の頁送り（`readConversationPage`）の契約を、`JournalStore` 実装1つに対して測る。
 *
 * **ストアに新しい口は足していない。** 頁送りは日誌の継続点（`JournalQuery.after`、
 * `order: 'asc' | 'desc'`、`listPage`）の上に載っているので、ここで測るのは「その3つを組んで
 * 会話の並びを辿ったとき、3実装（インメモリ / fs / pg）で同じ答えになる」ことである。
 * `journal-order-with-contract.ts` と同じ作法で、vitest に依存しない素の非同期関数にしてある
 * （`packages/storage-fs` / `packages/storage-pg` が `@alteroid/core` を実行時に読むため）。
 *
 * 測る性質:
 * 1. **頁の連結 = 全件。** `limit` を小さくして継続点を辿った会話 id の列が、1頁で全部読んだ列と
 *    一致する（飛ばしも重複も無い）。
 * 2. **窓（`scan`）より小さい頁でも同じ。** `scan` を会話の数より小さくして継続点を辿っても、窓の外の
 *    会話に辿り着き、並びが変わらない（窓をまたぐ会話を二重に出さない）。
 * 3. **同じミリ秒に最新の発言が並ぶ会話があっても、飛ばさず重複しない。** `at` では割れない同着を
 *    日誌の順序が割る。
 * 4. **終端で `next` が `null` になる。** 続きがあるのに `null` にしない（窓の外が残るのに黙って
 *    途切れない）。
 * 5. **使えない継続点は `InvalidConversationCursorError`。** 存在しない id・`at` の食い違い・
 *    会話の発言ではない行を指す継続点は、黙って先頭へ倒さず断る。
 *
 * `append` した行は呼び出し側のストアへ残る（後始末はしない）。使い捨てのストアを渡すこと。
 */
export type ConversationPageContractSubject = Pick<
  JournalStore,
  'append' | 'list' | 'listPage' | 'get'
>;

function fail(property: string, detail: string): never {
  throw new Error(`会話の頁送りの契約（${property}）が破れている — ${detail}`);
}

/** 継続点を辿って全頁の会話 id を集める。暴走を避けるため頁数に上限を置く。 */
async function walk(
  journal: ConversationPageContractSubject,
  options: { limit: number; scan: number },
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: ConversationCursor | undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await readConversationPage(journal, {
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(...page.conversations.map((conversation) => conversation.conversationId));
    if (page.next === null) return ids;
    cursor = page.next;
  }
  return fail('頁の連結', '200 頁辿っても終端に着かない（継続点が進んでいない疑い）');
}

/** `Date` を固定して `fn` を走らせる。vitest の fake timers は使わない（契約は vitest 非依存）。 */
async function atFrozenMillisecond<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const frozenMs = RealDate.now();
  const FrozenDate = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      if (args.length === 0) return new target(frozenMs);
      return Reflect.construct(target, args);
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => frozenMs;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  globalThis.Date = FrozenDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

async function awaitNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export async function verifyConversationPageContract(
  journal: ConversationPageContractSubject,
): Promise<void> {
  const say = (conversationId: string, role: 'inbound' | 'outbound', text: string) =>
    journal.append({ type: 'exchange', with: 'human', role, text, conversationId });

  // 会話 p0..p5。発言を交互に積んで、会話の発言が日誌の中で入り混じるようにする。
  // マネージャーとの往復（`with: 'manager'`）を間に挟む（窓の予算を食わないことの確認も兼ねる）。
  const base = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((name) => `page-contract-${name}`);
  for (const id of base) {
    await say(id, 'inbound', `${id} first`);
    await awaitNextMillisecond();
  }
  await journal.append({
    type: 'exchange',
    with: 'manager',
    role: 'inbound',
    text: 'page-contract: noise',
  });
  for (const id of [...base].reverse()) {
    await say(id, 'outbound', `${id} second`);
    await awaitNextMillisecond();
  }
  // 最新の発言が同じミリ秒に並ぶ3つの会話（性質3）。
  const tied = ['t0', 't1', 't2'].map((name) => `page-contract-${name}`);
  const tiedEntries = await atFrozenMillisecond(async () => {
    const entries: JournalEntry[] = [];
    for (const id of tied) entries.push(await say(id, 'inbound', `${id} tied`));
    return entries;
  });
  if (new Set(tiedEntries.map((entry) => entry.at)).size !== 1) {
    fail('同着', '同じミリ秒に積めていない（この契約の前提が崩れている）');
  }

  const whole = await readConversationPage(journal, { limit: 200, scan: 2000 });
  const wholeIds = whole.conversations.map((conversation) => conversation.conversationId);
  const expectedIds = [...tied].reverse().concat(base);
  if (wholeIds.join(',') !== expectedIds.join(',') || whole.next !== null) {
    fail(
      '前提',
      `1頁で読んだ並びが想定と違う: ${wholeIds.join(',')}（next=${JSON.stringify(whole.next)}）`,
    );
  }

  // 性質1: limit を小さくして辿る。
  for (const limit of [1, 2, 4]) {
    const walked = await walk(journal, { limit, scan: 2000 });
    if (walked.join(',') !== wholeIds.join(',')) {
      fail(
        '1: 頁の連結=全件',
        `limit=${limit} で辿った列 ${walked.join(',')} が全件 ${wholeIds.join(',')} と違う`,
      );
    }
  }

  // 性質2・3: 窓を発言の数より小さくして辿る（窓の外へも継続点で進む。同着の会話をまたぐ）。
  for (const scan of [1, 2, 3, 5]) {
    for (const limit of [1, 3]) {
      const walked = await walk(journal, { limit, scan });
      if (walked.join(',') !== wholeIds.join(',')) {
        fail(
          '2・3: 窓より小さい頁でも連結=全件（同着を飛ばさない）',
          `scan=${scan} limit=${limit} で辿った列 ${walked.join(',')} が全件 ${wholeIds.join(',')} と違う`,
        );
      }
    }
  }

  // 性質4: 窓が日誌の先頭に届いていないのに `next` が `null` にならない。
  const narrow = await readConversationPage(journal, { limit: 200, scan: 2 });
  if (narrow.reachedStart || narrow.next === null) {
    fail(
      '4: 続きがあるなら next が在る',
      `scan=2 で reachedStart=${narrow.reachedStart} next=${JSON.stringify(narrow.next)}`,
    );
  }
  const lastPage = await readConversationPage(journal, { limit: 200, scan: 2000 });
  if (lastPage.next !== null) fail('4: 終端で next が null', JSON.stringify(lastPage.next));

  // 性質5: 使えない継続点。
  const someEntry = tiedEntries[0] as JournalEntry;
  const decision = await journal.append({
    type: 'decision',
    decision: 'page-contract: not an exchange',
    grounds: 'conversation-page-contract',
  });
  const badCursors: [string, ConversationCursor][] = [
    ['存在しない id', { id: 'page-contract-missing', at: someEntry.at }],
    ['id は在るが at が違う', { id: someEntry.id, at: '2000-01-01T00:00:00.000Z' }],
    ['会話の発言ではない行', { id: decision.id, at: decision.at }],
  ];
  for (const [label, cursor] of badCursors) {
    let thrown: unknown;
    try {
      await readConversationPage(journal, { limit: 5, scan: 100, cursor });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof InvalidConversationCursorError)) {
      fail(
        '5: 使えない継続点は断る',
        `${label} で InvalidConversationCursorError を投げなかった（${String(thrown)}）`,
      );
    }
  }
}
