import type { JournalEntry, JournalEntryType } from './schema.js';
import type { ExchangeWith, JournalQuery, JournalStore } from './store.js';
import { JournalAnchorNotFoundError } from './store.js';

// vitest の `expect` で書かない: `storage-fs` / `storage-pg` が `@alteroid/core` を実行時の依存として読むため
// 行の位置を錨にする: `JournalStore` は更新・削除の口を持たず、既存の行どうしの前後関係が変わらないため
// 1. `order` 未指定 = `'desc'`（既存の挙動を1文字も変えない）
export type JournalStoreOrderContractSubject = Pick<JournalStore, 'append' | 'list'>;

async function collectAllPages(
  journal: JournalStoreOrderContractSubject,
  order: 'asc' | 'desc',
  pageSize: number,
  filter: { types?: JournalEntryType[]; with?: ExchangeWith[] } = {},
): Promise<JournalEntry[]> {
  const collected: JournalEntry[] = [];
  let after: JournalQuery['after'];
  for (;;) {
    const page = await journal.list({
      order,
      limit: pageSize,
      ...(after === undefined ? {} : { after }),
      ...filter,
    });
    if (page.length === 0) break;
    collected.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1];
    if (last === undefined) break;
    after = { id: last.id, at: last.at };
  }
  return collected;
}

function idSequence(entries: readonly JournalEntry[]): string {
  return entries.map((entry) => entry.id).join(',');
}

// `vi.useFakeTimers()` を使わない: 契約関数が vitest 非依存という約束に反するため
async function appendPairAtSameMillisecond(
  journal: JournalStoreOrderContractSubject,
): Promise<[JournalEntry, JournalEntry]> {
  const RealDate = Date;
  const frozenMs = RealDate.now();

  // `class extends Date` ではなく `Proxy` にする: 可変長引数を `super(...)` へ渡す形は tsup の dts ビルド（TS2556）で拒否されるため
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
    const first = await journal.append({
      type: 'decision',
      decision: 'journal-order-contract: same-millisecond first',
      grounds: 'journal-order-with-contract',
    });
    const second = await journal.append({
      type: 'decision',
      decision: 'journal-order-contract: same-millisecond second',
      grounds: 'journal-order-with-contract',
    });
    return [first, second];
  } finally {
    globalThis.Date = RealDate;
  }
}

// 固定の `sleep` にしない: 何ミリ秒待てば足りるかは器の分解能に依存するため
async function awaitNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export async function verifyJournalStoreOrderContract(
  journal: JournalStoreOrderContractSubject,
): Promise<void> {
  const a = await journal.append({
    type: 'decision',
    decision: 'journal-order-contract: a',
    grounds: 'journal-order-with-contract',
  });
  await awaitNextMillisecond();
  const b = await journal.append({
    type: 'decision',
    decision: 'journal-order-contract: b',
    grounds: 'journal-order-with-contract',
  });
  await awaitNextMillisecond();
  await journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: 'journal-order-contract: c',
  });
  await awaitNextMillisecond();
  const d = await journal.append({
    type: 'exchange',
    with: 'manager',
    role: 'inbound',
    text: 'journal-order-contract: d',
  });
  await awaitNextMillisecond();
  const e = await journal.append({
    type: 'decision',
    decision: 'journal-order-contract: e',
    grounds: 'journal-order-with-contract',
  });

  const unspecified = await journal.list({});
  const desc = await journal.list({ order: 'desc' });
  if (idSequence(unspecified) !== idSequence(desc)) {
    throw new Error(
      'JournalStore の order 契約（1: 未指定=desc）が破れている — ' +
        `order 未指定（${idSequence(unspecified)}）と order:'desc'（${idSequence(desc)}）で結果が違う。`,
    );
  }

  const asc = await journal.list({ order: 'asc' });
  const reversedDesc = [...desc].reverse();
  if (idSequence(asc) !== idSequence(reversedDesc)) {
    throw new Error(
      'JournalStore の order 契約（2: asc は desc の正確な逆順）が破れている — ' +
        `desc=${idSequence(desc)} の逆順は ${idSequence(reversedDesc)} のはずが、` +
        `asc=${idSequence(asc)} だった。`,
    );
  }

  const pagedDesc = await collectAllPages(journal, 'desc', 2);
  if (idSequence(pagedDesc) !== idSequence(desc)) {
    throw new Error(
      'JournalStore の order 契約（3: after+desc の頁の連結=全件）が破れている — ' +
        `全件=${idSequence(desc)}、頁を辿った連結=${idSequence(pagedDesc)}。`,
    );
  }

  const pagedAsc = await collectAllPages(journal, 'asc', 2);
  if (idSequence(pagedAsc) !== idSequence(asc)) {
    throw new Error(
      'JournalStore の order 契約（4: after+asc の頁の連結=全件）が破れている — ' +
        `全件=${idSequence(asc)}、頁を辿った連結=${idSequence(pagedAsc)}。`,
    );
  }

  const decisionFull = await journal.list({ types: ['decision'] });
  const decisionPaged = await collectAllPages(journal, 'desc', 1, { types: ['decision'] });
  if (idSequence(decisionPaged) !== idSequence(decisionFull)) {
    throw new Error(
      'JournalStore の order 契約（5: after は types/with より前に効く）が破れている — ' +
        `types:['decision'] の全件=${idSequence(decisionFull)}、` +
        `絞りを付けたまま頁を辿った連結=${idSequence(decisionPaged)}。`,
    );
  }

  const afterD = await journal.list({
    order: 'desc',
    after: { id: d.id, at: d.at },
    types: ['decision'],
    limit: 1,
  });
  if (afterD.length !== 1 || afterD[0]?.id !== b.id) {
    throw new Error(
      'JournalStore の order 契約（5b: 錨自体が絞りに当たらなくても全順序で位置が決まる）が' +
        `破れている — d（type:exchange, id=${d.id}）を錨に types:['decision'] を掛けると ` +
        `b（id=${b.id}）が返るはずが、実際には ` +
        `${JSON.stringify(afterD.map((entry) => entry.id))} が返った（あるいは投げた）。`,
    );
  }

  const window: JournalEntry[] = [];
  for (let i = 0; i < 10; i += 1) {
    window.push(
      await journal.append({
        type: 'decision',
        decision: `journal-order-contract: window-${i}`,
        grounds: 'journal-order-with-contract',
      }),
    );
  }
  const anchor6 = window[5] as JournalEntry;
  const expected6 = window[4] as JournalEntry;
  const afterAnchor6 = await journal.list({
    order: 'desc',
    after: { id: anchor6.id, at: anchor6.at },
    limit: 1,
  });
  if (afterAnchor6.length !== 1 || afterAnchor6[0]?.id !== expected6.id) {
    throw new Error(
      'JournalStore の order 契約（6: after は limit より前に効く）が破れている — ' +
        `window-5 の次は window-4（id=${expected6.id}）のはずが、` +
        `after:{id:window-5} + limit:1 は ${JSON.stringify(afterAnchor6.map((entry) => entry.id))} を返した。`,
    );
  }

  let threwForMissingId = false;
  try {
    await journal.list({ after: { id: 'no-such-id', at: e.at } });
  } catch (error) {
    threwForMissingId = error instanceof JournalAnchorNotFoundError;
  }
  if (!threwForMissingId) {
    throw new Error(
      'JournalStore の order 契約（7: 存在しない id で投げる）が破れている — ' +
        'after に存在しない id を渡しても JournalAnchorNotFoundError が投げられなかった。',
    );
  }

  // 前提が崩れたときは実装ではなく前提を名指しさせる: 契約8 の文言は実装を疑う向きなので、止めないと濡れ衣のまま調査が始まるため
  if (a.at === e.at) {
    throw new Error(
      'JournalStore の order 契約を測れない（歯の前提が崩れている。実装の問題ではない） — ' +
        `5件の append が同じ時刻になった（a.at = e.at = ${a.at}）。` +
        '契約8 は「a.id は実在するが at が食い違う」アンカーを作るために e.at を' +
        '借りているので、両者が同じだとそれが有効なアンカーになってしまう。' +
        'awaitNextMillisecond() が効いているかを見ること（issue #449）。',
    );
  }
  let threwForMismatchedAt = false;
  try {
    await journal.list({ after: { id: a.id, at: e.at } });
  } catch (error) {
    threwForMismatchedAt = error instanceof JournalAnchorNotFoundError;
  }
  if (!threwForMismatchedAt) {
    throw new Error(
      'JournalStore の order 契約（8: id は在るが at が違うときも投げる）が破れている — ' +
        'id は実在するが at が食い違う after を渡しても JournalAnchorNotFoundError が ' +
        '投げられなかった（id だけで引いている疑いがある）。',
    );
  }

  const [first, second] = await appendPairAtSameMillisecond(journal);
  if (first.at !== second.at) {
    // 再現できなかった場合はここで判定を止める: 通ったことにしないため
    throw new Error(
      'JournalStore の order 契約（9: 同じミリ秒の同着）を測る前提が満たせなかった — ' +
        `固定したはずの2行の at が食い違う（first.at=${first.at}, second.at=${second.at}）。` +
        'この器では同じミリ秒の同着を再現できていない。',
    );
  }

  const descAfterPair = await journal.list({ order: 'desc' });
  const secondIndex = descAfterPair.findIndex((entry) => entry.id === second.id);
  const firstIndex = descAfterPair.findIndex((entry) => entry.id === first.id);
  if (secondIndex === -1 || firstIndex === -1 || firstIndex !== secondIndex + 1) {
    throw new Error(
      'JournalStore の order 契約（9: 同じミリ秒の同着）が破れている — ' +
        `desc の全件の中で second（id=${second.id}）の直後が first（id=${first.id}）で` +
        `ないといけないが、実際の並びは ${idSequence(descAfterPair)} だった。`,
    );
  }

  const afterSecondDesc = await journal.list({
    order: 'desc',
    after: { id: second.id, at: second.at },
    limit: 1,
  });
  if (afterSecondDesc.length !== 1 || afterSecondDesc[0]?.id !== first.id) {
    throw new Error(
      'JournalStore の order 契約（9: 同じミリ秒の同着、desc）が破れている — ' +
        `second（id=${second.id}）を錨にした次は first（id=${first.id}）のはずが、` +
        `実際には ${JSON.stringify(afterSecondDesc.map((entry) => entry.id))} が返った。`,
    );
  }

  const afterFirstAsc = await journal.list({
    order: 'asc',
    after: { id: first.id, at: first.at },
    limit: 1,
  });
  if (afterFirstAsc.length !== 1 || afterFirstAsc[0]?.id !== second.id) {
    throw new Error(
      'JournalStore の order 契約（9: 同じミリ秒の同着、asc）が破れている — ' +
        `first（id=${first.id}）を錨にした次は second（id=${second.id}）のはずが、` +
        `実際には ${JSON.stringify(afterFirstAsc.map((entry) => entry.id))} が返った。`,
    );
  }

  const fullDescWithPair = await journal.list({ order: 'desc' });
  const pagedDescWithPair = await collectAllPages(journal, 'desc', 1);
  if (idSequence(pagedDescWithPair) !== idSequence(fullDescWithPair)) {
    throw new Error(
      'JournalStore の order 契約（9: 同着を跨いだ頁の連結）が破れている — ' +
        `全件=${idSequence(fullDescWithPair)}、頁を辿った連結=${idSequence(pagedDescWithPair)}。`,
    );
  }
}
