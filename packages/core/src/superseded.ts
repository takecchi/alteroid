import type { CommitmentList } from './store.js';

/**
 * 「この委譲（マネージャー）から、いま配られている合図より後に報告が届いている」を
 * ターンの入口へ載せるための判定と文面。
 *
 * ## なぜ在るのか（依頼者の実害）
 *
 * デーモン落ちで拾い直された合図（配り直し）を約15件処理したところ、**7件は
 * 中身が既に片付いていた。** そのつど「もう済んでいないか」を `gh` 等で測る手を
 * 打ち、そのぶんのターンと消費が判断ではなく確認に消えた。
 *
 * **足すのは事実だけである。** 「配らない」「畳む」「まとめる」は採らない ——
 * 配り直しは落ちた分を失わないための安全機構であり、「新しい報告が在る」は
 * 「中身が古い」を意味しない（別の話題のこともある）。だからここが出すのは
 * 「後続の報告が何件、いつまで届いているか」という**事実**だけで、読むかどうか・
 * どう扱うかはクローンが決める（`#commitmentNoticeFor` が「どれを先にやるかは
 * ……毎回決め直すこと」と書いているのと同じ線）。
 *
 * ## 出所は台帳（`stores.commitments`）である
 *
 * `Clone#post()` は逐語で `this.#commit(event);` を `this.#inbox.push(` の
 * **前**に呼ぶ ⟹ どの `manager_message` にも台帳の行が1本開く。
 * `commitmentFor`（`clone.ts`）が `manager_message` から作る行は逐語で
 * `{ id: event.id, at: event.at, origin: 'manager', source: event.managerId,
 * body: \`[${event.kind}] ${event.text}\` }` ⟹ `source` に委譲、`at` に時刻が
 * 構造化された欄で在り、`at` は比較する相手（いま配られている合図の `at`）と
 * 同じ欄なので時計の食い違いが起きない。
 *
 * **`ManagerSummary.lastReportAt` は使わない。** `manager.ts` で
 * `new Date().toISOString()`（`#now()` を通さない）で書かれる一方、
 * `InboxEvent.at` は `new Date(this.#now())` と `new Date()` が混在しており、
 * 時計が2つある比較はいつか逆転する。
 *
 * **`Clone` のインメモリの受信箱（`#inbox`）も使わない。** 失敗の枝が原理的に
 * 無いので「0 件」と「数えられなかった」を分けられない。
 *
 * ## 時刻の比較は `Date.parse` の数値で
 *
 * `isoDateTime`（`schema.ts`）は `z.string().datetime({ offset: true })` ⟹
 * `+09:00` 形式が通る ⟹ 文字列の辞書順比較は使えない（`2026-09-09T19:00:00+09:00`
 * は `2026-09-09T11:00:00Z` と同じ瞬間だが、辞書順だと `+09:00` の側が大きく
 * 見える）。`Date.parse()` して数値で比較し、`Number.isNaN` なら「数えられ
 * なかった」側へ倒す。
 *
 * ## この形を採る根拠（既存の先例2つに合わせている）
 *
 * - `apps/daemon/src/runner-swap-notice.ts` の `decideRunnerSwapNotice` の doc
 *   ——「純粋な判定関数。I/O をしない——呼び出し側（`noteRunnerSwap`）が台帳・
 *   名簿を読んでから渡す。副作用と判定を分けておくことで、判定の分岐それぞれに
 *   歯を直接通せる（I/O のモックを介さずに済む）」。
 * - `situation.ts` の `describeSituation` / `describeSituationUnavailable`。
 *   末尾に {@link block}（`'', '---', ''` を足して `join('\n')`）を持つ形も
 *   同じにしてある。
 *
 * ## 「沈黙は 0 件」という調停が成り立つ唯一の条件
 *
 * 依頼者は「行が出なければ 0 件と数え切れた」という調停を置いている。**それが
 * 成り立つ条件は「数えられなかった側が絶対に黙らないこと」だけである。** ⟹
 * 0 件に見えても障害（読めない行・物理削除された片付き行・`at` が壊れている行）
 * が在れば黙ってはいけない（{@link SupersededDecision} の `'uncountable'`）。
 */

/**
 * 判定の結果。**3値を持つ**（`runner-swap-notice.ts` の
 * `'none-affected'` / `'ledger-unreadable'` と同じ理由——2値にすると、
 * 判定できない場合がどちらかへ黙って倒れる）。
 */
export type SupersededDecision =
  | { readonly kind: 'none' } // 後続の報告 0 件、かつ障害無し ⟹ 数え切れた
  | {
      readonly kind: 'superseded';
      readonly reports: number;
      readonly latestAt: string;
      /** 障害が在ればその理由の文。無ければ `undefined`（件数の情報を捨てない）。 */
      readonly uncertain: string | undefined;
    }
  | { readonly kind: 'uncountable'; readonly detail: string }; // 0件だが障害が在る ⟹ 黙らない

/**
 * 台帳（{@link CommitmentList}）から、いま配られている合図より後に届いた
 * 同じ委譲の報告を数える。**純粋な判定関数。I/O をしない。**
 *
 * 判定の順序（守ること）:
 * 1. `origin === 'manager' && source === managerId && body.startsWith('[report] ')
 *    && !excludeIds.has(id)` で絞る
 * 2. 各行の `Date.parse(at)` を取る。`Number.isNaN` の行は「読めなかった障害」
 *    として数える（比較には使わない）。**基準側（`afterAts`）の `at` が読めない
 *    ときは、数える前に `'uncountable'` へ倒す**（`afterAts` の doc）
 * 3. `parsed > afterMs` の件数 `n` と、その中の最大 `at`（元の文字列）を取る
 * 4. 障害の有無を数える: `list.unreadable.length` / `list.trimmedClosed` /
 *    2 で数えた `at` が壊れている行数
 * 5. `n >= 1` ⟹ `'superseded'`（障害が在れば `uncertain` に理由を添える。
 *    件数の情報を捨てない）
 * 6. `n === 0` かつ障害無し ⟹ `'none'`
 * 7. **`n === 0` かつ障害在り ⟹ `'uncountable'`。** これがこの設計のいちばん
 *    大事な枝である——「沈黙 ＝ 0 件」という調停は、数えられなかった側が
 *    絶対に黙らないことでしか成り立たない。
 */
export function countSupersedingReports(input: {
  readonly list: CommitmentList;
  readonly managerId: string;
  /**
   * 判定の基準時刻。**いま配っている batch の `manager_message` の `at` を
   * そのまま全部渡す**（epoch へ畳むのは呼び出し側の仕事にしない）。
   *
   * **畳む前の形で受け取る理由は、`at` が読めなかったときの倒れ先をここで
   * 決めるためである。** 呼び出し側で `Date.parse` して畳むと、読めなかった
   * 回は基準が `-Infinity` になり、**この委譲の報告が全部「後続」に見える**
   * ——「あなたが読んでいるものは古い」という嘘を、いちばん強い向きで出す。
   * 台帳側の壊れた `at` を「数えられなかった」へ倒しているのと、向きを揃える。
   */
  readonly afterAts: readonly string[];
  /** 「後続」に数えない id（いま配っている batch 自身の id 全部）。 */
  readonly excludeIds: ReadonlySet<string>;
}): SupersededDecision {
  const { list, managerId, afterAts, excludeIds } = input;

  // **基準時刻が1つでも読めなければ数えない。** 上の `afterAts` の doc の理由。
  let afterMs = -Infinity;
  for (const at of afterAts) {
    const parsed = Date.parse(at);
    if (Number.isNaN(parsed)) {
      return { kind: 'uncountable', detail: 'いま配っている合図の受け取り時刻が読めない' };
    }
    if (parsed > afterMs) afterMs = parsed;
  }
  if (afterMs === -Infinity) {
    return { kind: 'uncountable', detail: 'いま配っている合図に受け取り時刻が1つも無い' };
  }

  const candidates = list.entries.filter(
    (entry) =>
      entry.origin === 'manager' &&
      entry.source === managerId &&
      entry.body.startsWith('[report] ') &&
      !excludeIds.has(entry.id),
  );

  let unparsableAt = 0;
  let n = 0;
  let latestMs = -Infinity;
  let latestAt: string | undefined;
  for (const entry of candidates) {
    const parsed = Date.parse(entry.at);
    if (Number.isNaN(parsed)) {
      unparsableAt += 1;
      continue;
    }
    if (parsed > afterMs) {
      n += 1;
      if (parsed > latestMs) {
        latestMs = parsed;
        latestAt = entry.at;
      }
    }
  }

  const troubles: string[] = [];
  if (list.unreadable.length > 0) troubles.push(`読めない行が ${list.unreadable.length} 件`);
  if (list.trimmedClosed > 0)
    troubles.push(`保持上限を超えて物理削除された片付き行が累計 ${list.trimmedClosed} 件`);
  if (unparsableAt > 0) troubles.push(`受け取り時刻が壊れている行が ${unparsableAt} 件`);
  const uncertain = troubles.length === 0 ? undefined : troubles.join('・');

  // **`latestAt` そのものを条件にする（`n >= 1` ではなく）。** どちらも同時にしか
  // 成り立たないが、それは読む側からは見えないので、`as` で押し通すと「型の上では
  // `undefined` を渡せる」という穴が注釈だけで守られる形になる。
  if (latestAt !== undefined) {
    return { kind: 'superseded', reports: n, latestAt, uncertain };
  }
  if (uncertain === undefined) return { kind: 'none' };
  return { kind: 'uncountable', detail: uncertain };
}

/**
 * {@link countSupersedingReports} の結果を、ターンの入口へ載せる文面にする。
 *
 * - `'none'` ⟹ **`''` を返す**（何も出さない）。オーナーの「永続的なトークン
 *   肥大化を避けたい」という立ち続ける指示との調停 —— 0 件は算術で確定できた
 *   ときにだけ `'none'` になるので、黙っても「数えていない」にはならない。
 * - `'superseded'` ⟹ 件数と最新時刻を名乗り、**中身は古いかもしれないが
 *   不要とは限らない**と断る。`uncertain` が在れば「これより多い可能性が
 *   ある」の1行を足す（件数の情報を捨てない）。
 * - `'uncountable'` ⟹ 「0 件」と「数えられなかった」を混同しない。2行目の
 *   言い回しは {@link describeSituationUnavailable}（`situation.ts`）に
 *   意図して揃えてある——読み手が同じ形として認識できるようにするためである。
 */
export function describeSuperseded(decision: SupersededDecision, managerId: string): string {
  if (decision.kind === 'none') return '';

  if (decision.kind === 'superseded') {
    return block([
      `⚠ **この委譲（${managerId}）からは、この合図より後に報告が ${decision.reports} 件届いている**` +
        `（最新: ${decision.latestAt}）。`,
      '⟹ **この報告の中身は既に古いかもしれない。** 手を動かす前に、その' +
        ` ${decision.reports} 件を先に読むこと（\`manager_list\` / \`commitment_list\`）。`,
      '⚠ ただし「新しい報告が在る」は「この報告が要らない」ではない —— 別の話題のこともある。' +
        '読むのは中身であって件数ではない。',
      ...(decision.uncertain === undefined
        ? []
        : [`⚠ **これより多い可能性がある**（${decision.uncertain}）。`]),
    ]);
  }

  return block([
    `⚠ **この委譲（${managerId}）の、この合図より後の報告を数えられなかった**（${decision.detail}）。`,
    'これは「0 件」ではなく「**数えられなかった**」である。要るなら `manager_list` / ' +
      '`commitment_list` を自分で呼ぶこと。',
  ]);
}

/**
 * 節を1つの塊にする。**末尾の区切り（`---`）まで含めて返す**——
 * `situation.ts` の `block` / `#commitmentNoticeFor`（`clone.ts`）が同じ形
 * （`'', '---', ''` で終わる配列を `join('\n')` する）で返しており、区切りを
 * 呼び出し側で足す形にすると、節を1つ足すたびに `#runTurn` の連結の側にも
 * 手が要る。
 */
function block(lines: readonly string[]): string {
  return [...lines, '', '---', ''].join('\n');
}
