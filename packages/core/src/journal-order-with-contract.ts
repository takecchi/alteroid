import type { JournalEntry, JournalEntryType } from './schema.js';
import type { ExchangeWith, JournalQuery, JournalStore } from './store.js';
import { JournalAnchorNotFoundError } from './store.js';

/**
 * `JournalStore` の `order` / `after` の契約を、実装1つに対して測る
 * （issue #432 の2本目）。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか。** `journal-with-contract.ts`
 * の doc と同じ理由 — `packages/storage-fs` と `packages/storage-pg` は
 * `@alteroid/core` を実行時の依存として読む（`dist/index.js` 経由）ので、
 * ここを vitest の `expect` で書くとその依存を2パッケージへ持ち込むことになる。
 * 食い違ったら `throw` する素の関数にして、呼ぶ側（各パッケージのテスト
 * ファイル）が好きな assertion 道具でラップできるようにしてある。
 *
 * **なぜ「行の位置」を錨にしてよいのか — `JournalStore` が行を動かさないから
 * である。**
 *
 * この契約は「`after` に渡した行の次から返る」ことを要求している。**位置を
 * 指す錨は、店（ストア）が既存の行を動かすなら壊れる** —— 頁と頁の間に前半の
 * 行が動けば、後続の位置がずれて1件飛ばし、動いた行がもう一度現れる。
 *
 * **日誌ではそれが起きない。`JournalStore`（`store.ts`）は `append` /
 * `list` / `get` の3つしか持たず、更新も削除も口が無い。** 追記は必ず
 * いちばん新しい側に足されるだけなので、既存の行どうしの前後関係は永久に
 * 変わらない。
 *
 * **⚠️ 同じ repo に、壊れるほうの実例が在る。** `packages/storage-fs` の
 * 承認待ちは `putApproval` が既存の id への書き込みで行を配列の末尾へ動かす
 * （`grep -n 'approvals.push(pendingApprovalSchema.parse(approval))' packages/storage-fs/src/jobs.ts`
 * — 既存の id を `filter` で除いてから `push` するので、答えた行が末尾へ
 * 動く）。承認に答えるのがまさにその経路なので、あちら（`GET /approvals`、
 * issue #432 の1本目）は位置ではなく `(createdAt, id)` の**比較**で辿る形に
 * してある（`apps/daemon/src/app.ts` の `approvalsCursorSchema` の doc）。
 *
 * **⟹ 「カーソル」と一語で呼んでも、位置で辿ってよいかどうかは店が行を
 * 動かすかで決まる。** 日誌に新しい書き込み経路（更新・削除・並べ替え）を
 * 足すなら、**この契約が先に壊れる** — 次に `JournalStore` へ更新・削除の口を
 * 足す人は、まずこの doc とこの契約群を読み直すこと。
 *
 * **測る9性質。3実装（`packages/core/src/testing.ts` のインメモリ /
 * `packages/storage-fs/src/journal.ts` / `packages/storage-pg/src/journal.ts`）
 * すべてがこれを呼ぶこと。呼んでいない実装が増えたら
 * `scripts/journal-store-with-contract-registry.test.ts` が落ちる。**
 *
 * 1. **`order` 未指定 = `'desc'`**（既存の挙動を1文字も変えない）
 * 2. **`order: 'asc'` は `order: 'desc'` の正確な逆順**（同じ query で）
 * 3. **`after` ＋ `desc` で頁を辿ると、連結が `desc` の全件と一致する**
 *    （飛ばしも重複も無い）
 * 4. **`after` ＋ `asc` でも同じ**
 * 5. **`after` は `types` / `with` の絞りより前に効く** —— 絞りを付けたまま
 *    頁を辿った連結が、絞った全件と一致する
 * 6. **`after` は `limit` より前に効く** —— 錨の位置を `limit` の後で探す
 *    実装だと、この性質が壊れる
 * 7. **存在しない `id` で `JournalAnchorNotFoundError` を投げる**
 * 8. **`id` は在るが `at` が違うときも同じ型を投げる**（3実装で答えが揃う
 *    ことの本体 — `id` だけの一致では fs が `at` に依存している事実と
 *    揃わない）
 * 9. **⭐ 同じミリ秒に積んだ2行をまたいでも、飛ばさず重複しない** ——
 *    **これがこの設計の要点である。** `at` だけをカーソルにすると壊れる
 *    場所で、`id` を錨にしているから通る。`at` はミリ秒精度の
 *    `new Date().toISOString()` なので、同じミリ秒に2行積まれることを
 *    確実に再現するために、この契約だけは呼び出し側の `Date` を一時的に
 *    固定する（下の `appendPairAtSameMillisecond`。**vitest の
 *    `vi.useFakeTimers()` は使わない** — ここが vitest 非依存という
 *    この節冒頭の理由に反するため、プレーンな JS で `globalThis.Date` を
 *    差し替える）。
 *
 * `append` した行は呼び出し側のストアへ実際に残る（後始末はしない）。
 * 使い捨てのストアを渡すこと（各テストファイルは毎回新しいストアを作っている）。
 */
export type JournalStoreOrderContractSubject = Pick<JournalStore, 'append' | 'list'>;

/** `desc` / `asc` それぞれで、`after` を辿って全頁を集めて連結する。 */
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

/**
 * 契約9専用: `Date` を一時的に固定して、同じミリ秒に2行を積む。
 *
 * **vitest の `vi.useFakeTimers()` を使わない。** この契約関数自体は
 * vitest 非依存という約束（本ファイル冒頭の doc）を、契約9だけが破る
 * 理由が無い — プレーンな JS で `globalThis.Date` を差し替えれば、
 * vitest を経由せずに時刻を固定できる。差し替えは `finally` で必ず戻す。
 */
async function appendPairAtSameMillisecond(
  journal: JournalStoreOrderContractSubject,
): Promise<[JournalEntry, JournalEntry]> {
  const RealDate = Date;
  const frozenMs = RealDate.now();

  // **`class extends Date` ではなく `Proxy` にしてある。** `Date` は複数の
  // コンストラクタ・オーバーロードを持ち、可変長引数をそのまま `super(...)`
  // へ渡す形は tsup の dts ビルド（TS2556）で拒否される。`Proxy` の
  // `construct` トラップなら引数の型検査を経由しないので、この問題が無い。
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

  // 一時的にグローバルの `Date` を凍結時刻へ差し替える。
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

export async function verifyJournalStoreOrderContract(
  journal: JournalStoreOrderContractSubject,
): Promise<void> {
  // 5件を積む（追記順 a, b, c, d, e）。desc の全件は e, d, c, b, a になるはず。
  const a = await journal.append({
    type: 'decision',
    decision: 'journal-order-contract: a',
    grounds: 'journal-order-with-contract',
  });
  const b = await journal.append({
    type: 'decision',
    decision: 'journal-order-contract: b',
    grounds: 'journal-order-with-contract',
  });
  await journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: 'journal-order-contract: c',
  });
  const d = await journal.append({
    type: 'exchange',
    with: 'manager',
    role: 'inbound',
    text: 'journal-order-contract: d',
  });
  const e = await journal.append({
    type: 'decision',
    decision: 'journal-order-contract: e',
    grounds: 'journal-order-with-contract',
  });

  // --- 契約1: 未指定 = desc ---
  const unspecified = await journal.list({});
  const desc = await journal.list({ order: 'desc' });
  if (idSequence(unspecified) !== idSequence(desc)) {
    throw new Error(
      'JournalStore の order 契約（1: 未指定=desc）が破れている — ' +
        `order 未指定（${idSequence(unspecified)}）と order:'desc'（${idSequence(desc)}）で結果が違う。`,
    );
  }

  // --- 契約2: asc は desc の正確な逆順 ---
  const asc = await journal.list({ order: 'asc' });
  const reversedDesc = [...desc].reverse();
  if (idSequence(asc) !== idSequence(reversedDesc)) {
    throw new Error(
      'JournalStore の order 契約（2: asc は desc の正確な逆順）が破れている — ' +
        `desc=${idSequence(desc)} の逆順は ${idSequence(reversedDesc)} のはずが、` +
        `asc=${idSequence(asc)} だった。`,
    );
  }

  // --- 契約3: after + desc の頁の連結 = desc の全件 ---
  const pagedDesc = await collectAllPages(journal, 'desc', 2);
  if (idSequence(pagedDesc) !== idSequence(desc)) {
    throw new Error(
      'JournalStore の order 契約（3: after+desc の頁の連結=全件）が破れている — ' +
        `全件=${idSequence(desc)}、頁を辿った連結=${idSequence(pagedDesc)}。`,
    );
  }

  // --- 契約4: after + asc の頁の連結 = asc の全件 ---
  const pagedAsc = await collectAllPages(journal, 'asc', 2);
  if (idSequence(pagedAsc) !== idSequence(asc)) {
    throw new Error(
      'JournalStore の order 契約（4: after+asc の頁の連結=全件）が破れている — ' +
        `全件=${idSequence(asc)}、頁を辿った連結=${idSequence(pagedAsc)}。`,
    );
  }

  // --- 契約5: after は types/with の絞りより前に効く ---
  // c/d（exchange）を挟んで a,b,e（decision）が散っている状態で、
  // types:['decision'] を付けたまま limit:1 で頁を辿る。after が絞り込み後
  // の集合の中だけで錨を探す実装だと、絞りに当たらない行を跨いだ瞬間に
  // 連結が壊れる。
  const decisionFull = await journal.list({ types: ['decision'] });
  const decisionPaged = await collectAllPages(journal, 'desc', 1, { types: ['decision'] });
  if (idSequence(decisionPaged) !== idSequence(decisionFull)) {
    throw new Error(
      'JournalStore の order 契約（5: after は types/with より前に効く）が破れている — ' +
        `types:['decision'] の全件=${idSequence(decisionFull)}、` +
        `絞りを付けたまま頁を辿った連結=${idSequence(decisionPaged)}。`,
    );
  }

  // --- 契約5b: 錨自体が絞りに当たらない種別でも、絞り込み前の全順序で位置が
  // 決まる（5 の一般形をより強く確かめる）。**この形が重要な理由**: 上の
  // 5 は「頁を辿るあいだ錨も常に絞りに当たる種別」だけを積んだ場合、実装が
  // 「絞り込んでから錨を探す」（絞りが `after` より前）でも、錨自身が
  // 絞り込み後の集合に残っていればたまたま正しい答えを返してしまい、
  // 順序契約の違反を検出できない。ここでは d（type: exchange, with: manager）
  // を錨にして types:['decision'] を掛ける——d 自身は絞りに当たらない種別
  // なので、「絞ってから錨を探す」実装は d を見つけられず
  // `JournalAnchorNotFoundError` を誤って投げるか、位置がずれる。正しい
  // 実装は全順序（e,d,c,b,a）の中で d の位置を決め、そこから先を
  // types:['decision'] で絞るので b（d の直後にある decision）が返る。
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

  // --- 契約6: after は limit より前に効く ---
  // 10件（n0..n9、追記順＝古い順）を積み、desc の全件は n9,n8,...,n0 になる。
  // 錨を真ん中（n5）に置き、limit:1 で「次」（n4）だけを取れるか確かめる —
  // limit を先に適用してから錨を探す実装だと、先頭からの上位1件（n9）だけが
  // 候補に残り、n5 より新しい行が候補を独占して n5 自体が候補から漏れる。
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

  // --- 契約7: 存在しない id で投げる ---
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

  // --- 契約8: id は在るが at が違うときも投げる ---
  let threwForMismatchedAt = false;
  try {
    // a.id は実在するが、e.at（別行の時刻。a.at とは異なる）と組み合わせる。
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

  // --- 契約9: 同じミリ秒に積んだ2行をまたいでも、飛ばさず重複しない ---
  const [first, second] = await appendPairAtSameMillisecond(journal);
  if (first.at !== second.at) {
    // **再現できなかった場合はここで判定を止める。** 通ったことにしない —
    // 呼び出し側（各テストファイル）はこの throw を捕まえて「再現できな
    // かった」とそのまま報告すること。
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

  // desc で second を錨にした続きの先頭が first であること（隣接の同着を
  // 飛ばさない）。
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

  // asc で first を錨にした続きの先頭が second であること（逆向きでも同じ）。
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

  // 全件（desc）を after で頁を辿って集めても、同着の2行を1件も飛ばさず・
  // 重複させずに含むこと（契約3の一般形を、この同着ペアで再確認する）。
  const fullDescWithPair = await journal.list({ order: 'desc' });
  const pagedDescWithPair = await collectAllPages(journal, 'desc', 1);
  if (idSequence(pagedDescWithPair) !== idSequence(fullDescWithPair)) {
    throw new Error(
      'JournalStore の order 契約（9: 同着を跨いだ頁の連結）が破れている — ' +
        `全件=${idSequence(fullDescWithPair)}、頁を辿った連結=${idSequence(pagedDescWithPair)}。`,
    );
  }
}
