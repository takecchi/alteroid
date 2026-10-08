import { InvalidConversationCursorError, readConversationPage } from './conversation.js';
import type { ConversationCursor } from './conversation.js';
import type { JournalEntry } from './schema.js';
import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg が core を実行時に読むため。append した行は後始末しないので、使い捨てのストアを渡す
export type ConversationPageContractSubject = Pick<
  JournalStore,
  'append' | 'list' | 'listPage' | 'get'
>;

function fail(property: string, detail: string): never {
  throw new Error(`会話の頁送りの契約（${property}）が破れている — ${detail}`);
}

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

// vitest の fake timers を使わない: 契約は vitest 非依存のため
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

  for (const limit of [1, 2, 4]) {
    const walked = await walk(journal, { limit, scan: 2000 });
    if (walked.join(',') !== wholeIds.join(',')) {
      fail(
        '1: 頁の連結=全件',
        `limit=${limit} で辿った列 ${walked.join(',')} が全件 ${wholeIds.join(',')} と違う`,
      );
    }
  }

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

  const narrow = await readConversationPage(journal, { limit: 200, scan: 2 });
  if (narrow.reachedStart || narrow.next === null) {
    fail(
      '4: 続きがあるなら next が在る',
      `scan=2 で reachedStart=${narrow.reachedStart} next=${JSON.stringify(narrow.next)}`,
    );
  }
  const lastPage = await readConversationPage(journal, { limit: 200, scan: 2000 });
  if (lastPage.next !== null) fail('4: 終端で next が null', JSON.stringify(lastPage.next));

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
