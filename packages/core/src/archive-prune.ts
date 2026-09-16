import type { ArchiveEntry } from './store.js';

/**
 * `selectArchiveRemovalTargets` / `matchesArchiveRemoveManyFilter`（issue #698）
 * が使う上限の定数。
 *
 * **`packages/core/src/tools.ts` の `REMOVE_MANY_LIMIT_DEFAULT` /
 * `REMOVE_MANY_LIMIT_MAX`（`inbox_remove_many` が使う値）とは値が同じでも
 * 出所が違うので使い回さない**（`commitment_close_many` の同名の定数を
 * `inbox_remove_many` が使い回さなかったのと同じ理由。逐語:
 * `grep -Fn -- '「`commitment_close_many` の同名の定数と値を使い回さ' packages/core/src/tools.ts`）。
 * `archive` の一括除去はこのファイルが定義を持ち、HTTP 層・道具層はここから
 * import するだけにすること——値を書き写すと、片方だけ変えたときに黙って
 * 食い違う。
 */
export const ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT = 500;
export const ARCHIVE_REMOVE_MANY_LIMIT_MAX = 2_000;

/**
 * `POST /archive/remove` / `archive_remove_many`（issue #698）が受け取る絞り込み。
 *
 * **1つも指定しない呼びを「絞り込みが無いのと同じ」として断るかどうかは、
 * ここでは判断しない。** このファイルは純粋な述語・選定だけを持ち、
 * 拒否のような対話的な判断は呼び出し側（HTTP ハンドラ）に置く
 * （`matchesInboxRemoveManyFilter` の doc と同じ境界線。逐語:
 * `grep -Fn -- 'ここでは断らない——このファイルは純粋な述語だけを持ち' packages/core/src/inbox-backlog.ts`）。
 */
export interface ArchiveRemoveManyFilter {
  /** `ArchiveEntry.sessionId` の完全一致。省略＝全セッション。 */
  readonly sessionIds?: readonly string[];
  /**
   * この時刻より**前**に積まれた行だけ（`at < before`、ISO8601、**排他**）。
   * 「この時刻ちょうどの行」を意図的に境界の外側（残す側）に置く——`before`
   * を「掃除の締め切り」として渡す運用で、締め切りの瞬間に積まれたばかりの
   * 行まで一緒に持っていかない。
   */
  readonly before?: string;
  /** `storedBytes` がこれ**以上**の行だけ。 */
  readonly minStoredBytes?: number;
}

/**
 * `entry` が `filter` に当たるかを判定する（issue #698）。
 *
 * **絞り込みの各項は AND で効く。** `sessionIds` / `before` / `minStoredBytes`
 * のどれも渡さなければ全行が当たる——「絞り込みが無い呼びを拒否するか」は
 * このファイルの外（HTTP 層）の仕事であって、この述語自身は空の `filter` を
 * 特別扱いしない（`matchesInboxRemoveManyFilter` と同じ作法）。
 *
 * 純関数（I/O をしない）。`selectArchiveRemovalTargets` から
 * `Array.prototype.filter` 相当で呼ばれるほか、単体でも import できるように
 * 名前を分けて export してある。
 */
export function matchesArchiveRemoveManyFilter(
  entry: ArchiveEntry,
  filter: ArchiveRemoveManyFilter,
): boolean {
  if (filter.sessionIds !== undefined && !filter.sessionIds.includes(entry.sessionId)) {
    return false;
  }
  if (filter.before !== undefined && Date.parse(entry.at) >= Date.parse(filter.before)) {
    return false;
  }
  if (filter.minStoredBytes !== undefined && entry.storedBytes < filter.minStoredBytes) {
    return false;
  }
  return true;
}

export interface ArchiveRemovalSelectionOptions {
  /**
   * 含有の証明（下の `selectArchiveRemovalTargets` の doc）を要求するか。
   * **既定 `true`。** `false` を渡すのは、`continuity` を持たない既存の
   * 残骸（門 #873 より前の行）を、内容が失われることを承知の上で人間が
   * 明示的に畳むときだけ——この関数自身は「安全な既定」から動かない。
   */
  readonly requireContainment?: boolean;
  /** 1回の呼びで対象にする最大件数。既定 {@link ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT}。 */
  readonly limit?: number;
  /**
   * 対象から除く id（issue #698 追補3の「墓標」など、呼び出し側が名指しで
   * 守れと言っている行）。**「墓標」という語・概念はこのファイルへ持ち込まない**
   * ——`TranscriptGrave.archiveId` を見るのは HTTP 層の仕事で、ここは渡された
   * id をただ守るだけにする（この選定ロジックを他の「守るべき id」の理由
   * からも再利用できるようにするため）。
   */
  readonly protectedIds?: readonly string[];
}

/**
 * `selectArchiveRemovalTargets` の戻り値（issue #698）。
 *
 * **`skipped` は0件でも欄を省かない。** 省くと「その理由では1件も飛ばして
 * いない」と「その理由を測っていない」が区別できなくなる
 * （`inbox-backlog.ts` の `bySourceOverflowCount` と同じ理由。逐語:
 * `grep -Fn -- 'skipped` は0件でも欄を省かない' /home/worker/mgr-c541ffb4/SPEC.md`）。
 *
 * **不変条件（歯で撃つこと）:**
 * `matched === targets.length + skipped.newest + skipped.alreadyRemoved
 *   + skipped.notContained + skipped.protected + remaining`
 *
 * 理由: `matched` は絞り込みを通った行の総数であり、その行1つ1つは
 * 「対象になった（`targets` か、溢れて `remaining`）」か「4つの理由の
 * どれか1つで飛ばされた」かのどちらかに**必ず一度だけ**振り分けられる
 * （下の `selectArchiveRemovalTargets` の「振り分けの優先順」）。この等式が
 * 崩れるのは、ある行が0回または2回以上数えられたとき——バケツを見落とすか、
 * `continue` を書き忘れて二重に足すかのどちらかで、どちらも静かに数字が
 * 合わなくなる形の壊れ方をする。
 */
export interface ArchiveRemovalSelection {
  /** `selectArchiveRemovalTargets` に渡された `entries` の総行数（絞り込み前）。 */
  readonly totalRows: number;
  /** `filter` に当たった行数（`matchesArchiveRemoveManyFilter` が `true` を返した数）。 */
  readonly matched: number;
  /** 実際に消してよい行。**古い順**（`limit` 件まで）。 */
  readonly targets: readonly ArchiveEntry[];
  /** `matched` のうち `limit` に溢れて `targets` に入らなかった件数。 */
  readonly remaining: number;
  readonly skipped: {
    /** そのセッションの最も新しい行だったので飛ばした件数。例外を作らない。 */
    readonly newest: number;
    /** 既に `removedAt` が付いていた（冪等な再実行）ので飛ばした件数。 */
    readonly alreadyRemoved: number;
    /** 含有が証明できなかったので飛ばした件数（`requireContainment` が `true` のときだけ発生）。 */
    readonly notContained: number;
    /** `protectedIds` に含まれていたので飛ばした件数。 */
    readonly protected: number;
  };
}

/** `at` 昇順（同着は `id` 昇順）——セッション内の「古い順」の唯一の並び方。 */
function compareOldestFirst(a: ArchiveEntry, b: ArchiveEntry): number {
  const byAt = Date.parse(a.at) - Date.parse(b.at);
  if (byAt !== 0) return byAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * `entries`（`TranscriptArchive.list()` の全行、絞り込み前）から、絞り込みに
 * 当たり、かつ安全に tombstone してよい行を選ぶ（issue #698）。
 *
 * 純関数。I/O をしない——本文（`body`）にも触れない。渡された `ArchiveEntry`
 * が持つ `sessionId` / `at` / `storedBytes` / `continuity` / `removedAt` の
 * 5列だけで判定が閉じる（設計文書 §設計B-2 が使う `md5(substr(newest, …))`
 * のような本文照合はしない——追補4「本文を読まないことの実測上の根拠」。
 * 逐語: `grep -Fn -- 'shared hit=1 / 0.25ms' /home/worker/mgr-c541ffb4/SPEC.md`）。
 *
 * ## 全体の流れ（この順で処理する。⛔ 順序を変えない）
 *
 * 1. `sessionId` ごとに束ね、セッション内で**古い順**に並べる。
 * 2. **絞り込みを当てる前の、その全行**に対して `isNewest` と
 *    `coveredBySurvivor`（含有の証明）を決める（追補1）。
 * 3. そのあとで `filter` を当てて `matched` を数え、`matched` の行だけを
 *    優先順位に従って `skipped` の4つの理由と `targets` へ振り分ける。
 * 4. `targets` はセッションをまたいで**古い順**に並べ直し、`limit` 件まで
 *    採る。溢れは `remaining`。
 *
 * ### なぜ手順2を「絞り込みを当てる前」にしなければならないか（追補1）
 *
 * 理由は2つ、どちらも「絞り込み後の集合だけで鎖を組むと嘘の答えが出る」形:
 *
 * - **証明の錨が絞り込みの外に居ることがある。** `before=T` は T 以降の行を
 *   候補から外すが、外れた行こそが「候補を含んでいる、生きている後続の行」
 *   でありうる。絞り込み後の集合だけで鎖を組むと、その錨が最初から居ない
 *   ことになり、本当は証明できる行まで `notContained` に落ちる（安全側に
 *   倒れるが、消せるはずの行が消せなくなる——正しさは壊れないが、機能が
 *   無意味に弱くなる）。
 * - **「最新行」の意味が変わってしまう。** 守るべきは**セッション全体の
 *   最新行**であって、絞り込み後に残った集合の中での最新行ではない。
 *   絞り込み後だけで `isNewest` を決めると、`before` で本当の最新行が
 *   候補から外れた場合に「絞り込み後でいちばん新しい行」を最新行と
 *   誤認し、**本当の最新行が守られていることに引きずられて安全だと
 *   錯覚したまま、実は誰も守っていない行を消してしまう**——こちらは
 *   安全側に倒れない誤りなので、手順1・2を先に全行へ通すことが必須。
 *
 * ## 含有の証明（`requireContainment` が `true` のときだけ効く）
 *
 * `continuity === 'continues'` は「この行の本文が、同じセッションの直前の
 * 行の本文を先頭から含む（前方一致）」を意味する（逐語:
 * `grep -Fn -- "- \`'continues'\` — 直前の退避の全文を、新しい本文が先頭から含む（前方一致）。" packages/core/src/archive-continuity.ts`）。
 * ⟹ セッションを古い順 `r[0..n-1]` としたとき、`r[i]` が `r[i+1]` に
 * 「読める形で」含まれているなら、`r[i]` を消しても内容は失われない
 * （`r[i+1]` を読めば復元できる）。「読める形で」が要点——下の一段落。
 *
 * 実装は新しい方から古い方へ1回だけ舐める（`compareOldestFirst` で
 * 並べた配列を後ろから前へ）:
 *
 * ```
 * let coveredBySurvivor = false;
 * for (let i = n - 1; i >= 0; i -= 1) {
 *   removable[i] = coveredBySurvivor;
 *   if (r[i].continuity === 'continues') {
 *     coveredBySurvivor = coveredBySurvivor || r[i].removedAt === undefined;
 *   } else {
 *     coveredBySurvivor = false;   // 鎖が切れたらここより古い行は証明できない
 *   }
 * }
 * ```
 *
 * ### 🔑 `r[i].removedAt === undefined` を見る1行が要点である
 *
 * `r[i]` が既に tombstone されている（`removedAt` が付いている）と、
 * `r[i-1]` の本文が `r[i]` に前方一致で含まれていても、**その本文はもう
 * 読めない**——`r[i]` の `body` は既に落ちている。証明の役に立たない。
 * この分岐を落とす（`removedAt` を見ずに `continuity === 'continues'` だけで
 * `coveredBySurvivor` を立てる）と、「消した行に含まれているから消してよい」
 * という推論を再帰的に許してしまい、**鎖の先頭さえ生き残っていれば
 * セッションの中身が丸ごと静かに消える**——1回の呼びでは起きず、
 * 「最新行を残して他を1回消す→次の回でその『他』の中の1つを新たに
 * 最新扱いできる行が現れる」わけではないので実際には1セッション内で
 * 最新行以外は同じ呼びの中で決着するが、**「最新行を先に単発 `remove()` で
 * 消してから一括を呼ぶ」という運用は現実にありうる**（歯5がまさにこれを
 * 撃つ）。この1行が無いと、その運用のもとで直前の行まで芋づる式に
 * 消せることになり、`archive` に唯一残っていた本文が消える。
 *
 * ### `continuity` が `'diverged'` / `undefined` / `'first'` / `'unknown'` の行
 *
 * どれも「前方一致が確認できていない」状態なので `coveredBySurvivor` を
 * 引き継がず `false` に落とす（鎖を切る）。**`undefined`（門 #873 より前に
 * 積まれた行）を `'continues'` へ倒すことは絶対にしない**
 * （`archive-continuity.ts` の「🔴 絶対にやってはいけないこと」と同じ理由）。
 * ⟹ 既存の残骸はこの既定では1行も消えない。これは欠陥ではなく線引きで
 * ある（追補4）。
 *
 * ## 振り分けの優先順（1行が複数の理由に当てはまりうる）
 *
 * `matched`（`filter` に当たった）行を、次の順で最初に当てはまった理由へ
 * 振り分ける。**この順を明言しないと、1行が2つ以上の理由に同時に
 * 当てはまるときに二重に数えるか、逆にどちらにも数えないかで
 * `matched` の等式が壊れる：**
 *
 * 1. `protectedIds` に含まれる ⟹ `skipped.protected`
 *    （墓標が指す行は、たとえ「消してもよい」他の条件を満たしていても
 *    最優先で守る——追補3。名指しの保護は他のどの理由よりも強い）
 * 2. 既に `removedAt` が付いている ⟹ `skipped.alreadyRemoved`
 *    （冪等な再実行。「本当は最新行だった」等と数え直さない——一度
 *    消えた行は理由に関わらずここで確定させる）
 * 3. セッションの最新行 ⟹ `skipped.newest`（例外を作らない安全弁）
 * 4. `requireContainment` が `true` のとき、含有が証明できない
 *    ⟹ `skipped.notContained`
 * 5. 上のどれにも当たらない ⟹ `targets` の候補
 *
 * ## `limit` と `remaining`
 *
 * 候補（上の5に落ちた行）をセッションをまたいで古い順に並べ直し、`limit`
 * 件まで `targets` に採る。**「いちばん遡りたいものから失う」を避けるため
 * 新しい順ではなく古い順に採る**（SPEC.md の背景「齢で切ると効かない」の
 * 裏返し——一括で溢れさせるときも、古い行を優先して確実に対象へ入れる）。
 * 溢れた件数は `remaining`。
 */
export function selectArchiveRemovalTargets(
  entries: readonly ArchiveEntry[],
  filter: ArchiveRemoveManyFilter,
  options: ArchiveRemovalSelectionOptions = {},
): ArchiveRemovalSelection {
  const requireContainment = options.requireContainment ?? true;
  const limit = options.limit ?? ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT;
  const protectedIds = new Set(options.protectedIds ?? []);

  // 手順1・2: 絞り込みを当てる前の全行を sessionId ごとに束ね、
  // `isNewest` と `coveredBySurvivor`（含有の証明）を決める（追補1）。
  const bySession = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    const group = bySession.get(entry.sessionId);
    if (group === undefined) bySession.set(entry.sessionId, [entry]);
    else group.push(entry);
  }

  const newestIds = new Set<string>();
  const coveredById = new Map<string, boolean>();
  for (const group of bySession.values()) {
    group.sort(compareOldestFirst);
    const n = group.length;
    if (n === 0) continue;
    newestIds.add(group[n - 1].id);
    let coveredBySurvivor = false;
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = group[i];
      coveredById.set(row.id, coveredBySurvivor);
      if (row.continuity === 'continues') {
        coveredBySurvivor = coveredBySurvivor || row.removedAt === undefined;
      } else {
        coveredBySurvivor = false;
      }
    }
  }

  // 手順3: 絞り込みを当てて `matched` を数え、優先順位に従って振り分ける。
  let matched = 0;
  let skippedProtected = 0;
  let skippedAlreadyRemoved = 0;
  let skippedNewest = 0;
  let skippedNotContained = 0;
  const candidates: ArchiveEntry[] = [];

  for (const entry of entries) {
    if (!matchesArchiveRemoveManyFilter(entry, filter)) continue;
    matched += 1;

    if (protectedIds.has(entry.id)) {
      skippedProtected += 1;
      continue;
    }
    if (entry.removedAt !== undefined) {
      skippedAlreadyRemoved += 1;
      continue;
    }
    if (newestIds.has(entry.id)) {
      skippedNewest += 1;
      continue;
    }
    if (requireContainment && !(coveredById.get(entry.id) ?? false)) {
      skippedNotContained += 1;
      continue;
    }
    candidates.push(entry);
  }

  // 手順4: 候補をセッションをまたいで古い順に並べ直し、`limit` 件まで採る。
  candidates.sort(compareOldestFirst);
  const targets = candidates.slice(0, limit);
  const remaining = candidates.length - targets.length;

  return {
    totalRows: entries.length,
    matched,
    targets,
    remaining,
    skipped: {
      newest: skippedNewest,
      alreadyRemoved: skippedAlreadyRemoved,
      notContained: skippedNotContained,
      protected: skippedProtected,
    },
  };
}
