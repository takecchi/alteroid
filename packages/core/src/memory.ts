/**
 * 記憶をクローンの文脈へ載せる形（＝1つの文字列にする）を決める場所。
 *
 * **ここが器（fs / pg / インメモリ）の側にあってはならない。** 載せ方はクローンの
 * 文脈の設計であって保存形式ではない。器ごとに書いていた結果、実際に食い違った —
 * `FsPersonaStore` と `PgPersonaStore` は `<!-- memory: slug.md -->` の見出しを
 * 付けていたのに、テストのインメモリ実装だけが本文をただ連結していた。**見出しが
 * 無い形でテストが緑になっていた**ので、「どの文書が変わったか」を見出しで指す
 * 実装をテストで確かめられない状態だった（AGENTS.md「固定値を返すスタブは
 * テストを緑にしたまま分岐を殺す」と同じ形である）。
 *
 * 見出しを付ける理由そのものは2つある。
 *
 * 1. 人間が開くのは `~/.alteroid/memory/*.md` という**別々のファイル**である。
 *    連結してしまうと、クローンは「どのファイルに書いてあったか」を言えなくなる。
 * 2. 走行中に変わった文書だけを載せ直せる（`clone.ts` の `#withFreshMemory`）。
 *    システムプロンプトに載っている塊と同じ見出しで指せるので、クローンは
 *    「どれが差し替わったか」を自分で対応付けられる。
 */

import { createHash } from 'node:crypto';

import {
  excerpt,
  excerptLine,
  fillListingBudget,
  renderListing,
  renderListingFromEnd,
} from './excerpt.js';
import { heuristicChars, type HeuristicChars } from './quantity.js';
import type {
  MemoryCreatedAt,
  MemoryDescriptionFreshness,
  MemoryDocKind,
  MemoryFrontmatterState,
  MemoryProtectionStatus,
} from './schema.js';
import type { JournalStore } from './store.js';

/**
 * 記憶を載せるときの1文書ぶんの単位。`MemoryDocument` はこれを満たす。
 *
 * `title` / `descriptionFreshness` は省略可能——**`content` から導出できる
 * もの（区分・要旨・親）は `renderMemoryDocuments` がここで毎回 `content` から
 * 読み直す**（frontmatter を1つも持たない文書の集合に対して焼き込みが現行と
 * 完全に同じであることを、保存された別の値ではなく `content` 自身で保証する
 * ため）。`descriptionFreshness` だけは `content` から導出できない
 * （導出元の `describedAt` はストアの派生値置き場にあり、本文には無い）ので、
 * 渡し手（ストア）が添える。省略時は `unknown`（安全側）として扱う。
 */
export interface MemoryPart {
  slug: string;
  content: string;
  /** 目次の1行に出すタイトル。省略時は `slug`。 */
  title?: string;
  /** 要旨の鮮度。`content` からは導出できない。省略時は `unknown`。 */
  descriptionFreshness?: MemoryDescriptionFreshness;
}

/**
 * 「記憶の肥大」——毎ターンの焼き込みに実際に載る分量。`measureMemoryFloor`
 * の戻り値。
 *
 * 単位はすべて**文字**（`String.length`）。bytes ではない
 * （`measureMemoryFloor` の doc）。
 *
 * **量の欄（`*Chars`）は {@link HeuristicChars} で持つ。件数の欄
 * （`*Docs`）は素の `number` のまま。** 件数は「量」ではなく「何件か」で
 * あり、単位（文字/トークン）も確からしさ（heuristic/exact）も持たない
 * ——巻き込むと `Quantity` という型が「単位付きの数量」以外のものまで
 * 名乗ることになり、型そのものが意味を失う（`quantity.ts` モジュール
 * 冒頭の「なぜ要るか」）。
 */
export interface MemoryFloor {
  /** premise のカード（要旨＋節の目次）が毎ターン焼かれる分の文字数。 */
  premiseChars: HeuristicChars;
  /**
   * `indexed` のカード（要旨だけ。節の目次は焼かれない）が毎ターン焼かれる
   * 分の文字数。**`indexed` が1件も無ければ 0。**
   */
  indexedChars: HeuristicChars;
  /** fact の目次が毎ターン焼かれる分の文字数。 */
  tocChars: HeuristicChars;
  /** 焼き込み全体の文字数。**`renderMemoryDocuments(documents).length` と必ず一致する。** */
  totalChars: HeuristicChars;
  premiseDocs: number;
  indexedDocs: number;
  factDocs: number;
  /**
   * そのうち、**カードを落として1行にした premise の件数**
   * （`MEMORY_PREMISE_CARD_BUDGET`）。
   *
   * **`premiseDocs` から引かれてはいない。** 落ちても premise であることは
   * 変わらないので、区分の件数は動かさない——ここが答えるのは「そのうち
   * 何件が索引を持っていないか」である。
   *
   * **⚠️ この軸が無いと `totalChars` が黙って嘘をつく。** 蓋が噛むと、
   * premise を1件足しても `totalChars` はほとんど動かない（別のカードが
   * 落ちて釣り合うため）。⟹ クローンは「premise を足しても安い」と読む。
   * 0 でない限り、`totalChars` は**蓋が効いた後の値**である。
   */
  demotedPremiseDocs: number;
  /** 毎ターン最も大きい premise の1件（premise が無ければ null）。 */
  largestPremise: { slug: string; chars: HeuristicChars } | null;
  /** 毎ターン最も大きい indexed の1件（indexed が無ければ null）。 */
  largestIndexed: { slug: string; chars: HeuristicChars } | null;
}

// ---------------------------------------------------------------------------
// 記憶の保護状態（human guard）— 判定と描画
// ---------------------------------------------------------------------------

/**
 * `MemoryProtectionStatus`（`schema.ts`）の3状態を網羅していることを型で強制する。
 *
 * **状態を1つ足したら、この関数を呼んでいる `switch` の `default` 節で
 * `never` への代入ができなくなり `tsc` が落ちる。** 分岐を書き足し忘れて
 * 未知の状態が黙って `unknown` 側へ倒れる実装を防ぐための、唯一の網羅性
 * チェックである。実行時にここへ来るのは型で弾かれたはずの値が渡ったときだけ
 * なので、投げて構わない。
 */
export function assertNeverMemoryProtectionStatus(status: never): never {
  throw new Error(`未知の記憶保護状態: ${JSON.stringify(status)}`);
}

/**
 * `distill`（統合の走行）からの全文置換・削除を許すか。
 *
 * **量（文字数の減少率）では判定しない。** 蒸留は正当な運用として大きく畳む
 * ことがあるので、判定軸は「保護状態 × 書き手」だけである（書き手側の判定は
 * `tools.ts` が持つ）。ここは保護状態の側だけを見る。
 *
 * - `human` / `unknown` → 断る（`unknown` は守る側へ倒す）
 * - `clone-only` → 通す
 */
export function memoryProtectionAllowsFullReplace(status: MemoryProtectionStatus): boolean {
  switch (status.kind) {
    case 'human':
      return false;
    case 'unknown':
      return false;
    case 'clone-only':
      return true;
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

/** 保護状態を人間可読な一言にする（歯が断るときの返答に使う）。 */
export function describeMemoryProtectionStatus(status: MemoryProtectionStatus): string {
  switch (status.kind) {
    case 'human':
      return '人間が過去に書いた記憶（human）';
    case 'clone-only':
      return 'クローンだけが書いてきた記憶（clone-only）';
    case 'unknown':
      return '履歴が無い、または外から書き換えられた可能性がある記憶（unknown。守る側の既定）';
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

// ---------------------------------------------------------------------------
// 記憶の保護状態（human guard）— 索引の組み直し
// ---------------------------------------------------------------------------

/**
 * 日誌全体から、slug ごとの「最後に `cause:'human'`（`action !== 'remove'`）で
 * 書かれた時刻」を導出する。
 *
 * **判定基準の単一の実装である。** 呼ぶのは3か所——`apps/daemon/src/storage.ts`
 * の起動時 backfill、`FsPersonaStore` / `PgPersonaStore` の索引の組み直し
 * （読み出し時に索引を失っていたと分かったとき）。3か所が別々に基準を書くと、
 * 片方だけ直して残りが古い基準のまま、という穴ができる。
 *
 * **`action:'remove'` は含めない。** 人間による削除は「将来この slug に書かれる
 * 新しい内容」を無条件に保護する理由にはならない
 * （`apps/daemon/src/app.ts` の `DELETE /memory/:slug` ハンドラの doc と同じ判断。
 * `markHumanTouched` を呼ぶのが `PUT` だけで `DELETE` では呼ばないのもこれに揃えた
 * ためである）。
 *
 * `journal.list({ types: ['memory_update'] })` は新しい順に返るので、先に
 * 見つかった（＝新しい）ほうを残す。
 */
export async function deriveHumanTouchedAtFromJournal(
  journal: Pick<JournalStore, 'list'>,
): Promise<Map<string, string>> {
  const entries = await journal.list({ types: ['memory_update'] });
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'memory_update') continue;
    if (entry.cause !== 'human') continue;
    if (entry.action === 'remove') continue;
    if (!result.has(entry.slug)) result.set(entry.slug, entry.at);
  }
  return result;
}

/**
 * 日誌全体から、slug ごとの「最初に `action:'write'` で書かれた時刻」を導出する
 * （記憶の `createdAt` の唯一の根拠）。
 *
 * **`deriveHumanTouchedAtFromJournal` と対になるが、見るものも残し方も逆**
 * である。あちらは `cause:'human'` に絞って**新しいほう**（最後に人間が
 * 書いた時刻）を残す。こちらは `cause` を問わず `action:'write'` だけに絞って
 * **古いほう**（最初に書かれた時刻）を残す——`journal.list()` は新しい順に
 * 返るので、`if (!result.has(...))` で先着（＝新しいほう）を残すのではなく
 * **毎回上書きする**ことで、ループが終わった時点で最も古いエントリが残る
 * ようにしてある。
 *
 * **`action:'append'` と、区別が導入される前の古いエントリ（`action` が
 * `undefined`）は対象にしない。** `append` は「存在しなければ作る」ので
 * 理屈上は初回作成でもありうるが、`action:'write'` という狭い基準に絞る
 * ——広げて誤って早い時刻を拾うより、根拠が無ければ `unknown` に倒す
 * （記憶の絶対条件4）ほうを優先した。**`action:'remove'` も対象外**
 * （削除は作成ではない）。
 *
 * 呼ぶのは2か所——`apps/daemon/src/storage.ts` の起動時 backfill と、
 * `deriveHumanTouchedAtFromJournal` と同様に将来ストア側で組み直しが要る
 * ようになったとき。基準がここ以外にも散ると、片方だけ直して残りが古い
 * 基準のまま、という穴ができるので実装はここに1本化する。
 */
export async function deriveMemoryCreatedAtFromJournal(
  journal: Pick<JournalStore, 'list'>,
): Promise<Map<string, string>> {
  const entries = await journal.list({ types: ['memory_update'] });
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'memory_update') continue;
    if (entry.action !== 'write') continue;
    result.set(entry.slug, entry.at);
  }
  return result;
}

/**
 * 保護状態の索引（派生値）を日誌から組み直したことを記録する日誌エントリの本文。
 *
 * **`memory_update` は使わない。** 記憶（本文）は変わっていない。変わったのは
 * 派生値だけである。**新しい `JournalEntryType` も足さない** — 既存の `decision`
 * で表現できる（`apps/daemon/src/app.ts` は daemon 内部の判断でも同じ型を使う）。
 * 種別を新設すると `apps/web` とクローンの道具（`journal_read` の整形）が
 * 型で落ちる形になっているはずなので、そちらを直す作業が要る
 * （PR #140「日誌の種別を足したときに web の2か所が型で落ちるようにする」）。
 *
 * **この組み直しが何を失い、何を失わないかをここに書く。** `humanTouchedAt`
 * （人間が書いたという保護の信号そのもの）は日誌から完全に復元できるので、
 * **保護は失われない**。失われるのは**外部編集の検出の履歴**だけである——
 * ハッシュは日誌に無いので、組み直す瞬間の本文の値で新しく基準化する
 * （「ここから先を見張る」）。**組み直し以前に外部編集があったとしても、
 * この組み直しはそれを「無かったこと」にする。** これを「外部編集が無かった
 * 証拠」として読まないこと——単に、組み直し以前の履歴は失われただけである。
 */
export function memoryProtectionRebuildDecision(counts: {
  humanRestored: number;
  hashesBaselined: number;
}): { decision: string; grounds: string } {
  return {
    decision:
      '記憶の保護状態の索引（派生値）を日誌から組み直した' +
      `（human 印 ${counts.humanRestored} 件を復元、本文のハッシュ ${counts.hashesBaselined} 件を` +
      '現在の値で基準化）。',
    grounds:
      '索引が読めなかった（無い・壊れている・スキーマが合わない）ため、次の読み出しでその場で' +
      '組み直した。cause:human の記録は日誌が持つので保護（human 印）は失われていないが、' +
      'この組み直しより前に外部から本文が書き換えられていたとしても、それはもう検出できない' +
      '（ハッシュは日誌に無いので、組み直す瞬間の本文の値で新しく基準化するため）。',
  };
}

/**
 * 1文書ぶん。見出しは人間が開くファイル名と同じ形にする（`slug.md`）。
 *
 * 末尾の空白行だけ落とす。**先頭や本文には触らない** — 人間の手書きの記述を
 * 整形の都合で書き換えないこと（`prompt.ts` の「記憶」の節と同じ約束）。
 *
 * **frontmatter を意識しない、純粋な単文書レンダラのままにしてある。** 区分の
 * 判定・malformed の印づけ・目次への振り分けは、すべて呼び手
 * （`renderMemoryDocuments`）の責務である——ここを frontmatter で分岐させると、
 * 直接この関数を固定している既存のテスト（`memory.test.ts`）が frontmatter の
 * 有無で意味を変えてしまう。
 */
export function renderMemoryDocument({ slug, content }: MemoryPart): string {
  return `<!-- memory: ${slug}.md -->\n${content.trimEnd()}`;
}

// ---------------------------------------------------------------------------
// frontmatter の解釈（content の先頭。#170）
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIMITER = '---';

/** frontmatter が受け付ける既知のキー。これ以外は `malformed`。 */
const KNOWN_FRONTMATTER_KEYS = new Set(['description', 'type', 'parent']);

/**
 * `content` の先頭から frontmatter を読む。
 *
 * **受け付ける形を狭く固定する**（`MemoryFrontmatterState` の doc）:
 * 1行目が `---`、閉じの `---` までが frontmatter。各行は `key: value`。
 * キーは既知の集合のみ。値は文字列としてのみ読む——ネスト無し、複数行無し、
 * 型推論を一切しない。外れたら `malformed`。
 *
 * **YAML ライブラリを使わない。** repo に YAML 系の依存は現状ゼロで、この
 * 用途で欲しいのは「読めなければ落ちる」パーサであって賢いパーサではない
 * （`description: no` が静かに `false` になるような挙動は、この用途では
 * リスクでしかない）。
 *
 * **既知の落とし穴**: Markdown の水平線・見出し下線もまた `---` の1行である。
 * 文書の1行目がたまたまそれだと、このパーサは frontmatter の開始とみなし、
 * 閉じの `---` が見つからなければ `malformed` になる。これは意図した設計
 * ——`malformed` は既定で `premise`（全文）に倒れるので、文書自体が消える
 * ことはない（区分の既定は `resolveMemoryDocKind` を見よ）。
 */
export function parseMemoryFrontmatter(content: string): MemoryFrontmatterState {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return { kind: 'none' };

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) return { kind: 'malformed' };

  const fields: { description?: string; type?: string; parent?: string } = {};
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(':');
    if (separator === -1) return { kind: 'malformed' };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) return { kind: 'malformed' };
    if (key === 'description') fields.description = value;
    else if (key === 'type') fields.type = value;
    else if (key === 'parent') fields.parent = value;
  }
  return { kind: 'parsed', ...fields };
}

/**
 * `MemoryFrontmatterState` の3状態の網羅性を型で強制する
 * （`assertNeverMemoryProtectionStatus` と同じ形）。
 */
export function assertNeverMemoryFrontmatterState(state: never): never {
  throw new Error(`未知の frontmatter 解釈状態: ${JSON.stringify(state)}`);
}

/**
 * `content` から frontmatter ブロック（開始・終了の `---` を含む）を取り除いた
 * 残り（本文）を返す。
 *
 * **`parseMemoryFrontmatter` と同じ「1行目が `---` か」「閉じの `---` は
 * どこか」の判定をここでも行うが、意図して別関数にしてある** ——
 * `parseMemoryFrontmatter` は3状態のどれかを返す判定器で、`malformed`
 * （閉じが無い）を返せることが前提の形になっている。こちらは
 * `applyMemoryFrontmatterPatch` だけが呼ぶ下ごしらえで、**呼び手が既に
 * `parseMemoryFrontmatter(content).kind !== 'malformed'` を確かめた後にしか
 * 呼ばない**契約なので、`malformed` の場合を型で持たない（呼び手の責務は
 * `applyMemoryFrontmatterPatch` の doc に書く）。
 *
 * - 1行目が `---` でなければ、`content` 全体を本文として返す（frontmatter が
 *   無い＝`none`）。
 * - 1行目が `---` なら、閉じの `---` の次の行から本文とする。閉じが無い
 *   （`malformed`）場合は呼び手の契約違反なので、便宜的に `content` 全体を
 *   返す——ここに来ること自体が呼び手のバグであり、値の正しさは保証しない。
 */
function frontmatterBody(content: string): string {
  return content.slice(memoryBodyStart(content));
}

/**
 * `content` の中で本文が始まる添字（frontmatter ブロックの閉じの `---` の
 * 次の行の先頭）を返す。frontmatter が無い・閉じが無い（`malformed`）なら `0`。
 *
 * **`frontmatterBody` の唯一の実装である。** あちらはこの添字で `slice` する
 * だけになっている——2つに分かれていると、片方だけ直したときに
 * 「文字列としての本文」と「本文の始まる位置」が食い違い、**frontmatter を
 * 添字で運ぶ側（`memory_section_move`）が本文の一部を frontmatter として
 * 運ぶ**という形の壊れ方をする。だから1本にしてある。
 *
 * **この添字が `memory_section_move` の frontmatter 保護の第2層である。**
 * 節の切り取りは `content.slice(0, memoryBodyStart(content)) + <新しい本文>`
 * で組み立てるので、**frontmatter のバイト列は添字で運ばれるだけで一度も
 * 書き直されない**——`serializeMemoryFrontmatter` を通さないので、キーの
 * 順序の正規化すら起きない（`applyMemoryFrontmatterPatch` は正規化する。
 * そちらの doc を読むこと）。
 */
export function memoryBodyStart(content: string): number {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return 0;
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) return 0;
  let offset = 0;
  for (let index = 0; index <= closingIndex; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  // 閉じの `---` が最終行（その後ろに改行が無い）のとき、上の足し算は
  // `content.length + 1` になる。`slice` は超過を許すが、`slice(0, n)` の側で
  // 「本文が無いのに本文が在る」ように見えるのを避けるため、ここで詰める。
  return Math.min(offset, content.length);
}

/** frontmatter の3キーのうち、渡したものだけを新しい値にする差分。 */
export interface MemoryFrontmatterPatch {
  description?: string;
  type?: string;
  parent?: string;
}

/**
 * **キーの並び順は `description` → `type` → `parent` に正規化される。**
 * 人間が別の順序で書いていた frontmatter でも、`memory_frontmatter_set` を
 * 一度でも通すとこの順に並べ替わる（値は失われず、意味も変わらない）。
 * 既存の順序を保つ処理ではないので、直しに行かないこと。
 */
function serializeMemoryFrontmatter(fields: MemoryFrontmatterPatch): string {
  const lines = [FRONTMATTER_DELIMITER];
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`);
  if (fields.type !== undefined) lines.push(`type: ${fields.type}`);
  if (fields.parent !== undefined) lines.push(`parent: ${fields.parent}`);
  lines.push(FRONTMATTER_DELIMITER);
  return lines.join('\n');
}

/**
 * `serializeMemoryFrontmatter` は各キーを `key: value` の1行として並べる。
 * `value` に改行（`\n` / `\r`）が入ると、その行から先が別の行として現れる
 * ——frontmatter の別のキー・閉じの `---`・本文の1行目と見分けが付かなく
 * なる。**本文そのものは失われない**（`applyMemoryFrontmatterPatch` は
 * 古い `content` から本文を取るだけで、値をそこへ書き込みはしない）が、
 * 改行を含む値を許すと、値の続きが「本文の先頭」として紛れ込む形になる。
 *
 * **書き込み側の入口（`memory_frontmatter_set`）がこれを断るために使う。**
 * `parseMemoryFrontmatter`（読み出し側）は既に `---` を含む行を malformed
 * として扱うので、この関数が防ぐのは「新しく書き込もうとしている値」で
 * あって、既存の読み出しの挙動は変えない。
 *
 * `\r` も検査する——`\r\n` は `\n` だけでも捕まるが、単独の `\r` は
 * 目次の1行（`renderMemoryToc` 等）にそのまま残り、読めない行を作る。
 */
export function containsMemoryFrontmatterLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

/**
 * frontmatter の指定されたキーだけを差し替え／追加する（#318 案 (a)）。
 * **本文には一切触れない。**
 *
 * これが `memory_frontmatter_set` の中核である——**本文はこの関数の呼び出しの
 * 中に一度も文字列として現れない**（`content` は呼び手がストアから読んだ
 * ものをそのまま渡すだけで、モデルのツール呼び出しの引数には含まれない）。
 * だから本文が途中で切れて通る経路が構造的に無い（検出できる、より強い
 * 「起こりえない」——issue #318 の設計判断そのもの）。
 *
 * - `content` が frontmatter を持たない（`parseMemoryFrontmatter` が
 *   `{ kind: 'none' }`）→ 先頭に新しく frontmatter を作って足す。本文は
 *   そのまま後ろに続く（1バイトも変えない）。
 * - `content` が frontmatter を持つ（`{ kind: 'parsed' }`）→ `patch` に
 *   渡されたキーだけを差し替え／追加し、渡されなかったキーは既存の値の
 *   まま残す。本文は1バイトも変えない。
 * - `content` が `malformed` → **呼ばないこと。** 呼ぶと例外を投げる
 *   （安全側——呼び手（`memory_frontmatter_set`）は必ず先に
 *   `parseMemoryFrontmatter` で `malformed` を弾いて断る判断をしている
 *   はずで、ここへ `malformed` な `content` が来るのはその判断が抜けている
 *   ときだけである）。
 *
 * **本文が空（frontmatter だけの文書）のとき、閉じの `---` の後ろの改行は
 * 元の文書に在ったとおりに保つ（#354 のコメント）。** `frontmatterBody` は
 * `---\n…\n---\n`（末尾に改行あり）と `---\n…\n---`（改行なし）の**両方**に
 * 対して空文字を返すので、**`body` だけを見ても、閉じの `---` を終える改行が
 * 在ったのかどうかは決まらない**——だから `content` の末尾で決める。
 *
 * - **`${header}\n` を無条件で返す形にしないこと。** 末尾の改行を持たない
 *   文書で1バイト増える。**いま落ちている1バイトを、逆向きの1バイトに
 *   置き換えるだけ**になる
 * - **`header` を無条件で返す形にも戻さないこと**（#338 以降しばらくこの形
 *   だった）。`---\n…\n---\n` に対して閉じの `---` の後ろの改行が1つ落ちた
 * - **本文が空でない側はこの分岐に入らない。** そちらは `header` と `body` の
 *   あいだの改行が必ず在るので、`\n` で繋ぎ直せば元に戻る
 * - 歯は `memory.test.ts`（両方向を1本ずつ）と `tools.test.ts`
 *   （`memory_frontmatter_set` 経由で、ストアに残った文書そのもの）に在る
 *
 * `patch` のキーを1つも渡さない呼び（3キーとも `undefined`）を断るかどうかは
 * ここでは決めない——それは道具（呼び手）の責務であり、この関数自体は
 * 「空のパッチ」を渡されれば frontmatter を（内容が変わらないまま）
 * 再構成して返す。
 */
export function applyMemoryFrontmatterPatch(
  content: string,
  patch: MemoryFrontmatterPatch,
): string {
  const state = parseMemoryFrontmatter(content);
  if (state.kind === 'malformed') {
    throw new Error(
      'applyMemoryFrontmatterPatch: malformed な frontmatter にはパッチを当てられない' +
        '（呼び手が先に断ること）',
    );
  }
  const priorFields: MemoryFrontmatterPatch = state.kind === 'parsed' ? state : {};
  const nextFields: MemoryFrontmatterPatch = {
    description: patch.description ?? priorFields.description,
    type: patch.type ?? priorFields.type,
    parent: patch.parent ?? priorFields.parent,
  };
  const body = frontmatterBody(content);
  const header = serializeMemoryFrontmatter(nextFields);
  if (body.length > 0) return `${header}\n${body}`;
  // 本文が空のときだけ、`body` からは「閉じの `---` を終える改行が在ったか」
  // が決まらない（`frontmatterBody` は両方に対して空文字を返す）。元の文書の
  // 末尾で決める。上の doc「本文が空の文書」を読むこと。
  return content.endsWith('\n') ? `${header}\n` : header;
}

const KNOWN_DOC_KINDS: ReadonlySet<MemoryDocKind> = new Set(['premise', 'fact', 'indexed']);

/**
 * `value` が既知の区分（`premise` / `fact` / `indexed`）かどうか。
 *
 * **`resolveMemoryDocKind`（読み出し側）の「未知の値は premise へ倒す」安全弁
 * とは別の使い道である。** あちらは既存文書・`memory_write` が書いた任意の
 * `type` を受けて表示のために区分を決める側（未知の値でも文書は消えない）。
 * こちらは `memory_frontmatter_set`（書き込み側の入口）が「渡された値を
 * そのまま frontmatter へ書いてよいか」を判定するために使う——**綴りを
 * 間違えた値（`Fact` / `facts` 等）を黙って書くと、`resolveMemoryDocKind`
 * が premise へ倒すので区分は変わらないのに、書き手には「変えた」つもりが
 * 残る**（応答は嘘をつかないが、何も言わないまま次のターンへ進む）。
 *
 * 既知の集合を2箇所に持たない——`KNOWN_DOC_KINDS` を唯一の実装として共有する。
 */
export function isKnownMemoryDocKind(value: string): value is MemoryDocKind {
  return KNOWN_DOC_KINDS.has(value as MemoryDocKind);
}

/**
 * 区分を解決する（frontmatter → `premise` | `fact` | `indexed`）。
 *
 * **区分が無い（`none`）・読めない（`malformed`）・`type` が既知の集合に
 * 無い値のときは、`fact` にも `indexed` にもせず `premise` として扱う。**
 * これが移行の安全弁である——frontmatter を1つも持たない文書（`none`）は
 * 全て `premise` になるので、この改修をマージした直後は焼き込みが従来と
 * 完全に同じになる。`indexed` を足したときも、この安全弁の向き（既知でない
 * 値は `premise` へ倒す）は1ミリも変えていない——`indexed` は `KNOWN_DOC_KINDS`
 * に加わった**既知の値**なので、`type: indexed` はそのまま `indexed` として
 * 解決される（安全弁が発動するのは未知の値のときだけである）。
 *
 * 取り返しがつく側へ倒す判断でもある: `premise` を既定にした誤りは
 * 「余分に全文を焼く」だけで `self_status` の総文字数から必ず気づけるが、
 * `fact` を既定にした誤りは文書が黙って目次の1行へ縮み、気づく手段
 * そのもの（その文書の中身）が失われる。
 */
export function resolveMemoryDocKind(frontmatter: MemoryFrontmatterState): MemoryDocKind {
  if (frontmatter.kind !== 'parsed') return 'premise';
  const { type } = frontmatter;
  if (type !== undefined && KNOWN_DOC_KINDS.has(type as MemoryDocKind))
    return type as MemoryDocKind;
  return 'premise';
}

/**
 * `MemoryDocKind`（3値）の網羅性を型で強制する（`assertNeverMemoryProtectionStatus`
 * と同じ形）。呼び手（`tools.ts` の `kindLabel` 等）が `switch` の `default` で
 * これへ渡すと、区分を1つ足したときに埋め忘れた分岐で `tsc` が落ちる。
 */
export function assertNeverMemoryDocKind(kind: never): never {
  throw new Error(`未知の記憶の区分: ${JSON.stringify(kind)}`);
}

/**
 * 要旨の鮮度を判定する。
 *
 * **代理指標である**（`MemoryDescriptionFreshness` の doc）。ここが言えるのは
 * 「`description` が最後の本文変更以降に変わったか」だけで、「本文を読み
 * 直して書き直したか」ではない。
 *
 * **`stale` には `staleForMs`（`updatedAt - describedAt` のミリ秒差）を必ず
 * 添える**（#821）。`describedAt < updatedAt` は文字列の辞書式比較で決まる
 * ため、両方が ISO 8601 の絶対時刻である限り `Date.parse` の引き算は正の値
 * になる —— 順序を保つのは呼び出し側ではなくここ1か所であることが要点で、
 * 引き算の向きを間違えると符号が反転するだけで例外は出ない（変異試験で
 * 狙う場所）。
 */
export function resolveMemoryDescriptionFreshness(input: {
  description: string | undefined;
  /** ストアの派生値。一度も観測できていなければ `undefined`。 */
  describedAt: string | undefined;
  updatedAt: string;
}): MemoryDescriptionFreshness {
  if (input.description === undefined) return { kind: 'absent' };
  if (input.describedAt === undefined) return { kind: 'unknown' };
  if (input.describedAt >= input.updatedAt) return { kind: 'fresh' };
  const staleForMs = Date.parse(input.updatedAt) - Date.parse(input.describedAt);
  return { kind: 'stale', staleForMs };
}

/** `MemoryDescriptionFreshness` の4状態の網羅性を型で強制する。 */
export function assertNeverMemoryDescriptionFreshness(freshness: never): never {
  throw new Error(`未知の要旨の鮮度状態: ${JSON.stringify(freshness)}`);
}

/**
 * frontmatter から導出される値をまとめて返す（fs / pg のストアが
 * `list()` / `read()` / `documents()` で共通に呼ぶ、唯一の実装）。
 *
 * **ここを2箇所（fs と pg）で別々に書かないための関数である。** 器ごとに
 * frontmatter の解釈を書いた結果 fs / pg で食い違う、という `memory.ts`
 * 冒頭のコメントに書いてある過去の失敗（`concat()` の一件）と同じ形の
 * 危険をここでも避ける。
 */
export function deriveMemoryFrontmatter(input: {
  content: string;
  updatedAt: string;
  /** ストアの派生値置き場（fs: `.index.json` / pg: `described_at` 列）。 */
  describedAt: string | undefined;
}): {
  frontmatter: MemoryFrontmatterState;
  kind: MemoryDocKind;
  description: string | undefined;
  parent: string | undefined;
  descriptionFreshness: MemoryDescriptionFreshness;
} {
  const frontmatter = parseMemoryFrontmatter(input.content);
  const kind = resolveMemoryDocKind(frontmatter);
  const description = frontmatter.kind === 'parsed' ? frontmatter.description : undefined;
  const parent = frontmatter.kind === 'parsed' ? frontmatter.parent : undefined;
  const descriptionFreshness = resolveMemoryDescriptionFreshness({
    description,
    describedAt: input.describedAt,
    updatedAt: input.updatedAt,
  });
  return { frontmatter, kind, description, parent, descriptionFreshness };
}

/**
 * `description` が新旧で変わったかを比べる。ストアの `write()` がこれで
 * `describedAt` を進めるか据え置くかを決める（4-3: 書き手は `describedAt` を
 * 書けない——store が採番する `updatedAt` を書き手は知らないので、書いた
 * 直後から必ず「古い」と出てしまう。だから store が導出する）。
 *
 * 変わっていなければ据え置く。変わっていれば新しい時刻へ進める——**その
 * 時刻は呼び手が渡す**（fs なら書き込み後に確定した `updatedAt`、pg なら
 * `UPDATE` が返した行の `updatedAt`。ここで `Date.now()` を新たに取らない
 * ことで、`describedAt === updatedAt` が保証され、直後の読み出しが必ず
 * `fresh` になる）。
 */
export function nextDescribedAt(input: {
  priorContent: string | null;
  nextContent: string;
  priorDescribedAt: string | undefined;
  /** この書き込みが確定した時刻（呼び手の `updatedAt` と同じ値を渡すこと）。 */
  writtenAt: string;
}): string | undefined {
  const priorDescription =
    input.priorContent === null
      ? undefined
      : ((state) => (state.kind === 'parsed' ? state.description : undefined))(
          parseMemoryFrontmatter(input.priorContent),
        );
  const nextState = parseMemoryFrontmatter(input.nextContent);
  const nextDescription = nextState.kind === 'parsed' ? nextState.description : undefined;
  return priorDescription === nextDescription ? input.priorDescribedAt : input.writtenAt;
}

// ---------------------------------------------------------------------------
// 記憶の全文（branded type — `renderMemoryDocuments` だけが作れる。4-14）
// ---------------------------------------------------------------------------

declare const RENDERED_MEMORY_BRAND: unique symbol;

/**
 * `renderMemoryDocuments` の戻り値であることを型で保証する印。
 *
 * **`buildCloneSystemPrompt`（`prompt.ts`）の `memory` 引数はこの型を要求する。**
 * 生の文字列を渡すと `tsc` が落ちる——記憶が文字列になる関数は
 * `renderMemoryDocuments` の1つに閉じている（`store.ts` の `PersonaStore.documents()` の
 * doc が持つ「器は文書を渡すだけにする」という契約を、`tsc` が守る側へ回すための釘）。実行時には
 * ただの `string` であり、ランタイムの挙動には一切影響しない。
 */
export type RenderedMemory = string & { readonly [RENDERED_MEMORY_BRAND]: true };

function brandRenderedMemory(text: string): RenderedMemory {
  return text as RenderedMemory;
}

// ---------------------------------------------------------------------------
// 目次（TOC）— 保存しない。毎回、文書そのものから組み立てる
// ---------------------------------------------------------------------------

/**
 * 目次1行の長さの上限（1文書が目次を飲み込まないため。外部の値は持ち込まない。4-5）。
 *
 * **`export` してあるのはテストのため**（`memory.test.ts` が
 * `MEMORY_TOC_ENTRY_LIMIT * MEMORY_TOC_LINE_LIMIT` で「蓋が無ければ束ねた
 * 全体がどこまで伸びうるか」の下限を書き写さずに導くのに使う。値そのものは
 * 変えていない）。
 */
export const MEMORY_TOC_LINE_LIMIT = 200;

/**
 * 目次を件数で切るときの上限。**`self_status` の記憶内訳とは、もう同じ考え方
 * ではない。** かつてここは `self_status` の `SELF_STATUS_MEMORY_DOC_LIMIT`
 * （件数）と同じ考え方だったが、`self_status` 側は人間の依頼（id + 名前 +
 * 概要 + updated_at + created_at）で `title` / 要旨を足したことで1行の長さが
 * 可変になり、件数のままでは何件で壊れるかが運任せになるため文字数の予算
 * （`SELF_STATUS_MEMORY_LISTING_BUDGET`、`tools.ts`）へ替えた
 * （`.claude/skills/listing-and-detail/SKILL.md`「予算は件数ではなく文字数で
 * 持つ」）。こちらは件数のまま残してある——対象がプロンプトへ焼く目次で
 * 「何件までなら判断材料として妥当か」という軸であって、MCP の出力上限
 * （文字数）とは切る理由が違う。**`export` してあるのはテストのため**
 * （`memory.test.ts` が「切ったら言う」を確かめるのに、この値を書き写さず
 * 参照する）。
 *
 * **⚠️ ここで「件数のまま残す」と決めた理由（1行あたりの上限は運任せにならない
 * こと）は、束ねた全体には及ばない。** `self_status` を移した理由の逐語
 * 「1行の長さが可変になり、件数のままでは何件で壊れるかが運任せになる」は、
 * まさにこの目次の1行（`renderMemoryTocLine`）にも当たる——`MEMORY_TOC_LINE_LIMIT`
 * は1行あたりの**上限**であって固定幅ではなく、そこに階層のインデントと
 * 鮮度の印（`memoryFreshnessMarker`）と `title` が乗るので、300件の総量は
 * 数千字から6万字超まで動く（実測は `MEMORY_TOC_CHAR_BUDGET` の doc）。
 * **だからこの件数の上限とは別に、束ねた全体の文字数にも蓋を持つ
 * （`MEMORY_TOC_CHAR_BUDGET`）。両方が独立に効く**——件数の上限を外すのでは
 * なく、「判断材料として何件が妥当か」という軸と「毎ターンの床に何文字まで
 * 許すか」という軸を両方持つ。
 */
export const MEMORY_TOC_ENTRY_LIMIT = 300;

/**
 * `fact` 目次（`renderMemoryToc`）全体を束ねた文字数の予算。**件数
 * （`MEMORY_TOC_ENTRY_LIMIT`）とは別の軸で、両方が効く。**
 *
 * ## なぜ要るか — 件数の上限だけでは、束ねた総量が運任せになる
 *
 * `MEMORY_TOC_ENTRY_LIMIT` の doc に書いたとおり、この目次の1行は
 * `MEMORY_TOC_LINE_LIMIT`（1行あたりの上限）・階層のインデント・鮮度の印・
 * `title` を持つ可変長の行である。件数だけで切ると、`.claude/skills/
 * listing-and-detail/SKILL.md`「予算は件数ではなく文字数で持つ」が名指しして
 * いる形そのものになる——実際にそこは「#170 は記憶の目次に
 * `MEMORY_TOC_ENTRY_LIMIT = 300`（件数）と `MEMORY_TOC_LINE_LIMIT = 200`
 * （1行の長さ）を入れた。**300 × 200 = 60,000 文字**」と書き、道具側の統一
 * とは分けて範囲外に残していた（同 SKILL.md「いま揃っていないもの」）。
 *
 * ## 実測（このリポジトリでの合成入力。2026-09-09）
 *
 * `renderMemoryDocuments` に `MEMORY_TOC_ENTRY_LIMIT`（300）件の `fact` を通した
 * 実測値（本番の記憶ではなく、この PR の中で組んだ合成入力——本番の実体
 * （PostgreSQL / `~/.alteroid/memory/*.md`）とデーモンの HTTP API には触れて
 * いない）:
 *
 * | 入力 | 目次全体の文字数 |
 * | --- | --- |
 * | 300件、要旨なし（下限） | 8,849 |
 * | 300件、要旨が `MEMORY_TOC_LINE_LIMIT` ちょうど（200字） | 67,049 |
 * | 300件、要旨がそれより長い（300字。`excerptLine` が切って注記が乗る） | 73,049 |
 *
 * **⚠️ この表が成立する入力の条件を書いておく。書かないと、再現しなかった人が
 * 「表が嘘だ」と読むか、自分の測り方を疑うかのどちらかになる（どちらも損である）。**
 *
 * 1. **slug は `fact-0`〜`fact-299`（0埋めなし）である。** 目次の1行は slug を
 *    2回運ぶ（`renderMemoryTocLine` の `- <slug>: <title> — <要旨>` の slug と、
 *    `title` を slug と同じにした合成入力の `title`）ので、**slug の長さが
 *    変われば表の数も変わる。** `fact-000`〜`fact-299`（3桁の0埋め）で取り直すと
 *    **3つとも 220 文字増える**（9,069 / 67,269 / 73,269）——0埋めで伸びるのは
 *    `fact-0`〜`fact-9` の10件が2文字ずつと `fact-10`〜`fact-99` の90件が1文字
 *    ずつで、それが1行につき2回なので `2 × (10×2 + 90×1) = 220` である。
 *    **結論はどちらの取り方でも動かない**——6通りとも 60,000 を超える。
 * 2. **蓋を外して測った数である。** この定数を一時的に十分大きな値へ差し替えて
 *    測り、元へ戻した。**蓋が効いているいまの出力はこれではない**——300件・
 *    要旨200字・0埋めの slug で **12,281 文字**である（その上界は
 *    `memory.test.ts` の「⭐⭐⭐ 修理の実在: 予算を超えてよいのは断り書きぶん
 *    だけ（遊びは断り書きの実測長が決める）」が歯として持つ）。
 * 3. **3行目（300字）の数には `excerptLine` の注記ぶんが含まれる。** 要旨が
 *    1行の上限を超えるので、行ごとに切った注記が乗る。
 *
 * **再現は 2026-09-09 に取り直して6通りとも一致した**（上の3つと、0埋めの3つ）。
 *
 * **理論値「約6万字」は控えめだった**——1行あたりの上限を使い切る現実的な
 * 入力で 67,049 文字、超過分がある入力では 73,049 文字まで伸びる。
 *
 * **この表の数は、doc コメントの主張のままでは古くなっても気づけない。**
 * `MEMORY_TOC_ENTRY_LIMIT * MEMORY_TOC_LINE_LIMIT`（60,000）という下限を
 * 実際に超えることは `memory.test.ts` の「⭐⭐⭐ 穴の実在: 蓋が無ければ、
 * 束ねた候補行は 300件 × 1行200字 の下限を超えて伸びる」が歯として固定して
 * いる——1行の形式を書き写さず、2件・1件の実レンダリングの差分から外挿した
 * 値で確かめる。
 *
 * **そして「蓋が効いている」側は別の歯が持つ**（「⭐⭐⭐ 修理の実在: 予算を
 * 超えてよいのは断り書きぶんだけ（遊びは断り書きの実測長が決める）」）。
 * **元は1本だった。** 1本の歯が「穴が在った」と「修理が効いている」を両方
 * 主張していたので、遊びが緩いほうの主張に合わせられ、`+ 1_000` という丸い
 * 数字が入っていた——実測（base `139c7aa`）で1行の限界費用は 224 字なので、
 * **予算を3行ぶん（672字）恒常的に超過してもどの歯も落ちなかった。**
 *
 * ## 値の出し方（12,000。人間の決定）
 *
 * - **危険の大きさから逆算した。** 理論上の最悪（上の実測）はおよそ6〜7万字
 *   （≒ 4〜5万トークンを毎ターン）。12,000 はそれを約1/5〜1/6に抑える。
 * - **いま噛まない値にした。** `fact` が数本の現状では総量は1〜2千字の桁と
 *   見込まれ（**本番を測った値ではない。依頼者の見立てであり、この PR は
 *   記憶の実体・デーモンの HTTP API のどちらにも触れていないので検証できない**）、
 *   12,000 は見立てどおりなら現状の数倍〜10倍の余裕がある——足した瞬間に
 *   文書が隠れ始めることが無い、という設計上の狙いである。
 * - **既存の値（`MEMORY_LISTING_BUDGET` / `MEMORY_OUTLINE_BUDGET` の 8,000、
 *   `MEMORY_PROMPT_OUTLINE_BUDGET` の 6,000）をあえて写さなかった。** 8,000 は
 *   道具側（1回のツール応答）の予算で、焼き込みと道具の予算を混同させない
 *   ことは別の PR の主題そのものである。6,000 は premise **1文書あたり**の
 *   節目次の予算で、こちらは **fact 全文書を束ねた**目次なので軸が違う。
 *   別の数を置くことで「別の予算である」を値そのものに語らせる。
 * - **既存の値（200 / 300 / 3,000 / 6,000 / 8,000）はどれも動かしていない。**
 *
 * **`export` してあるのはテストのため**（値を書き写さず参照する）。
 */
export const MEMORY_TOC_CHAR_BUDGET = 12_000;

/**
 * `memory_list`（道具）の一覧の予算。**件数ではなく文字数である。**
 *
 * プロンプトへ焼く目次（`renderMemoryToc`）が使う `MEMORY_TOC_ENTRY_LIMIT` とは
 * 別物にしてある。あちらは「システムプロンプトに何件載せるか」、こちらは
 * 「1回のツール応答に何文字載せるか」で、上限を決めるものが違う（MCP の出力上限）。
 *
 * **`export` してあるのはテストのため**（値を書き写さずに参照する）。
 */
export const MEMORY_LISTING_BUDGET = 8_000;

interface MemoryTocEntry {
  slug: string;
  title: string;
  description: string | undefined;
  descriptionFreshness: MemoryDescriptionFreshness;
  parent: string | undefined;
}

/**
 * 目次の1行に付く「親をたどれなかった」の**種類**。
 *
 * **5つを1つに畳まない。** どれも「親の行が上に無い」という同じ見た目になるが、
 * **読み手が次に見に行く先が違う**（`renderMemoryTocIssue` の doc）。畳むと、
 * いちばん多い状態（親は実在していて、この描画に載っていないだけ）が、いちばん
 * 怖い状態（文書がそもそも無い）の言葉で報告される。
 *
 * `cycle-outside-render` は5つ目（循環の一部が描画の外の記憶を通る。
 * `resolveMemoryHierarchy` の `detectCycle` の doc）。
 *
 * **`export` してあるのはテストのため。** `memory.test.ts`
 * が5状態の網羅性を `Record<MemoryTocIssue, true>` で縛る
 * （this repo の既存の網羅の歯は手書きの配列 + `assertNever` だが、依頼者の門で
 * 今回は明示的に `Record<...>` 形を指定された）——正本のこの型を直接縛ることで、
 * 6つ目の状態が増えたときにテスト側の宣言を埋め忘れると `tsc` が落ちる。テスト側に
 * 別の union を書き写すと、書き写した側が古いままでも気づけない（二重管理になる）。
 */
export type MemoryTocIssue =
  'missing-parent' | 'cycle' | 'parent-not-listed' | 'parent-not-rendered' | 'cycle-outside-render';

interface ResolvedTocNode {
  entry: MemoryTocEntry;
  depth: number;
  issue?: MemoryTocIssue;
  children: ResolvedTocNode[];
}

/**
 * 記憶の全体を、階層の解決に要る形（在否と `parent`）で引ける索引。
 *
 * `resolveMemoryHierarchy` が「この描画（`entries`）の外」を見るときの唯一の
 * 窓——在否は `slugs`（`Set` の参照。安い）、`parent` は `parentOf`（**遅延**。
 * `buildMemoryPresence` の doc）で引く。2つを分けてあるのは、在否の判定
 * （`parent-not-rendered` かどうか）は毎回要るが、`parent` の値（循環の検出）は
 * 「親がこの描画の外に在る」ときにしか要らないからである。
 */
interface MemoryPresence {
  /** 記憶（ストア）に実在する slug の全体。 */
  readonly slugs: ReadonlySet<string>;
  /**
   * その slug の `parent`（生の frontmatter の値。存在するとは限らない）。
   * 対象の slug がそもそも記憶に無ければ `undefined`。
   */
  parentOf(slug: string): string | undefined;
}

/**
 * `documents`（記憶の全体）から `MemoryPresence` を組み立てる。
 *
 * **`parentOf` の中身（frontmatter の解析）は遅延させる——初回に呼ばれたときに
 * だけ全体を1度だけ解析して記憶化し、以降はその結果を使い回す。** `slugs` は
 * ここで即座に作る（`Set` を作るだけで、`content` は1文字も読まない。安い）。
 *
 * **理由は呼び手の頻度である。** `clone.ts` の `#withFreshMemory` は**毎ターン**
 * この経路を通る。`parentOf` が要るのは「親がこの描画（差分）の外に在る」
 * ときの循環検出（`resolveMemoryHierarchy` の `detectCycle`）だけであり、
 * 親が同じ描画の中で全部解決するターン（＝典型的には「変わった文書の親も
 * 一緒に変わった」か「そもそも親を持たない文書しか変わっていない」ターン）
 * では `parentOf` は一度も呼ばれず、記憶全体の frontmatter を1文字も解析
 * しない。全体の `parent` を毎ターン先読みで解析すると、記憶が育つほど
 * 「更新の無いターン」まで比例して重くなる（依頼者の門3「クローンの呼び出し
 * 回数に比例する費用を足さない」の同じ精神を、`documents()` の再読み込みだけ
 * でなく CPU 側にも適用したもの）。
 */
function buildMemoryPresence(documents: readonly MemoryPart[]): MemoryPresence {
  const slugs = new Set(documents.map((doc) => doc.slug));
  let parentBySlug: Map<string, string | undefined> | undefined;
  function parentOf(slug: string): string | undefined {
    if (parentBySlug === undefined) {
      parentBySlug = new Map(
        documents.map((doc) => {
          const frontmatter = parseMemoryFrontmatter(doc.content);
          return [doc.slug, frontmatter.kind === 'parsed' ? frontmatter.parent : undefined];
        }),
      );
    }
    return parentBySlug.get(slug);
  }
  return { slugs, parentOf };
}

/**
 * 「この目次（`entries`）の外にも実在する slug」を、**在り処ごとに分けて**
 * 渡す口。`resolveMemoryHierarchy` の第2引数。
 *
 * **2つを1つの集合に混ぜないのは、読み手に言うべきことが違うからである。**
 * 親が同じ描画の中に premise として全文で載っているなら「上を読め」で済むが、
 * そもそも今回の描画に載っていないなら「載っていないだけで、記憶には在る」と
 * しか言えない。混ぜると、後者が前者の言い方（「本文が上に載っている」）で
 * 嘘をつく。
 */
interface MemoryHierarchyElsewhere {
  /**
   * この目次の対象ではないが、**同じ描画の中にカードとして載っている**
   * slug（渡し手は `buildMemoryDocumentSections`）。**premise だけでなく
   * `indexed` の slug も含む**（2026-09-11。どちらも目次行ではなくカードとして
   * 描かれる側なので、扱いは同じである——`indexed` はカードに節の目次こそ
   * 載らないが、要旨とカードの見出し自体はこの描画の中に在る）。
   */
  renderedAsPremise?: ReadonlySet<string>;
  /**
   * **記憶の全体を引ける索引。** `slugs` にはこの描画に含まれる slug を
   * 含んでいてよい——描画の中に在るかどうかは先に判定されるので、渡し手は
   * 「今回載せていないもの」を選り分けずに、手元の全体をそのまま渡せばよい
   * （選り分けを渡し手にやらせると、そこが2つ目の間違えどころになる）。
   *
   * **渡さなければ（既定は `undefined`）この状態は起こりえない**——記憶の全体を
   * 渡している呼び手（システムプロンプトへの焼き込み・`memory_list`）の
   * 出力を1バイトも変えないための既定値である。
   */
  presentInMemory?: MemoryPresence;
}

/**
 * 親子関係を解決し、木にする。**循環と、存在しない親を指す `parent` を
 * 黙って落とさない**（4-1「階層は『それ自体が目次である文書』で作る」）。
 *
 * - 親をたどると自分自身に戻る、または祖先の鎖のどこかで輪になる（循環） →
 *   ルート扱いにし、`issue: 'cycle'`（輪の全員がこの描画に載っている）または
 *   `issue: 'cycle-outside-render'`（輪の一部がこの描画の外を通る）
 * - 親が存在しない slug を指す → ルート扱いにし、`issue: 'missing-parent'`
 * - 親はこの `entries`（目次の対象）には無いが、`elsewhere.renderedAsPremise` には
 *   在る（同じ描画の中に premise として全文で載っている） → ルート扱いにし、
 *   `issue: 'parent-not-listed'`
 * - 親はこの `entries` には無いが、`elsewhere.presentInMemory` には在る
 *   （記憶には実在するが、この描画そのものには載っていない） → ルート扱いにし、
 *   `issue: 'parent-not-rendered'`
 *
 * どれも文書自体は消えない——ルートとして目次に残り、印がつく。
 *
 * **循環の判定を他の4つより先に行う理由**（`renderMemoryTocIssue` の doc の
 * 表と同じ話）: 読み手の次の一手が違う。`missing-parent` / `parent-not-listed` /
 * `parent-not-rendered` はどれも「（この場では）何もしなくてよい」だが、循環は
 * 「どれかの `parent` を直せ」である。循環を「親は外に在る」で覆うと、直すべき
 * 欠陥が黙る——だから `effectiveParent` は `detectCycle` を最初に呼ぶ。
 *
 * ## `elsewhere` — 「この目次の外にも実在する slug」
 *
 * **`entries` は「記憶の全部」とは限らない。** ここが取り違えの本体で、実際に
 * 2通りの形で踏んでいる。
 *
 * 1. `renderMemoryDocuments` の目次（`renderMemoryToc`）は **fact だけ**を対象
 *    に組む（premise は全文で別に載っている）。だから `entries`（fact の集合）
 *    だけを見て「親が無い」と判定すると、**親が premise として実在していても
 *    「見つからない」と出る**——`memory_list`（`renderMemoryListing`。全区分を
 *    対象にするので `bySlug` に premise も入っている）では同じ関係が正常に
 *    解決するのに、面によって答えが変わる欠陥だった
 *    （→ `elsewhere.renderedAsPremise`）
 * 2. `clone.ts` の `#withFreshMemory` は、記憶が更新されたことを**変わった
 *    文書だけ**を載せて伝える。だから `entries` はその差分に縮む——**親が
 *    今回変わっていないだけで「見つからない」と出た**（実測 2026-09-02、
 *    クローン自身が踏んだ。「記憶の階層が壊れた」と読んで `memory_list` を
 *    呼び直しに行かせている）（→ `elsewhere.presentInMemory`）
 *
 * **どちらも「その文書は存在しない」と読める言葉で報告していた。** 実際には
 * 存在していて、この描画の対象ではないだけである。`elsewhere` を渡すことで、
 * この2つを `missing-parent` から分けて名指しできるようにする。
 *
 * ## 循環の検出は、いまは記憶の全体で行う（かつては `entries` の中だけで閉じていた）
 *
 * **⚠️ ここは以前「範囲外」として明記していた箇所である。** `elsewhere` が運ぶ
 * ものが slug の集合だけだった間は、循環の一部が `entries` の外を通る形
 * （a → b → c → a で c だけが描画に無い）を `cycle` として検出できず、
 * `parent-not-rendered` に落ちていた。これは「無い」と言い切る誤りではない
 * （親は実際に在り、実際にこの描画に載っていない）が、言えるはずのことを
 * 言えていなかった。`elsewhere.presentInMemory` を `MemoryPresence`（`parent`
 * まで引ける索引）へ変えたことで、`detectCycle` が記憶の全体を辿れるように
 * なり、この欠落は埋まった。
 *
 * **`detectCycle` の辿り方**: `slug` から出発し、各ステップで「その slug が
 * `entries` に在れば `entries` の `parent`、無ければ `elsewhere.presentInMemory`
 * の `parent`」を引く。一度でも訪れた slug に戻ったら循環——**その循環が
 * `entries` の外の slug を1つでも経由していれば `cycle-outside-render`、
 * 全員が `entries` の中で完結していれば `cycle`**（歩いた経路のどこかで
 * `bySlug` に無い slug を経由したかどうかで判定する）。`presentInMemory` が
 * 渡されていなければ（`elsewhere.presentInMemory === undefined`）、`entries` の
 * 外へ出た時点で歩みを止める——**この場合の結果は、`presentInMemory` を
 * 渡す前の実装と1文字も変わらない**（既存の歯 `4状態を畳まない` 系列と、
 * 新設した `presentInMemory を渡さなければ出力が1バイトも変わらない` の歯で
 * 固定してある）。
 *
 * **⚠️ ここでも言えないこと。** `detectCycle` が `presentInMemory.parentOf` を
 * 呼ぶのは「循環かもしれない経路を実際に歩いているとき」に限られる——
 * `parent-not-rendered` の中で循環していない大多数（実運用のほとんど）でも、
 * 経路を1歩でも `entries` の外へ出れば `parentOf` は呼ばれる（そうしないと
 * その1歩が循環の一部かどうか判定できない）。**「親が全部この描画の中で解決する
 * ターン」でだけ frontmatter の解析を省ける**のであって、「親が描画の外に在る
 * turn では省ける」わけではない（`buildMemoryPresence` の doc）。
 */
function resolveMemoryHierarchy(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere = {},
): ResolvedTocNode[] {
  const renderedAsPremise = elsewhere.renderedAsPremise ?? new Set<string>();
  const presentInMemory = elsewhere.presentInMemory;
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const parentOf = new Map(entries.map((entry) => [entry.slug, entry.parent]));

  /**
   * `slug` の祖先の鎖に輪が在るかを、記憶の全体を辿って判定する
   * （`resolveMemoryHierarchy` の doc「`detectCycle` の辿り方」）。
   */
  function detectCycle(slug: string): 'cycle' | 'cycle-outside-render' | undefined {
    const seen = new Set<string>([slug]);
    let cursor = parentOf.get(slug);
    let touchedOutside = false;
    for (;;) {
      if (cursor === undefined || cursor === '') return undefined;
      if (seen.has(cursor)) return touchedOutside ? 'cycle-outside-render' : 'cycle';
      seen.add(cursor);
      if (bySlug.has(cursor)) {
        cursor = parentOf.get(cursor);
        continue;
      }
      // `cursor` はこの描画の外。索引が無ければ、従来どおりここで歩みを止める
      // （循環なし——`missing-parent` / `parent-not-rendered` の判定は呼び手側）。
      if (presentInMemory === undefined) return undefined;
      touchedOutside = true;
      cursor = presentInMemory.parentOf(cursor);
    }
  }

  function effectiveParent(slug: string): {
    parent?: string;
    issue?: MemoryTocIssue;
  } {
    const direct = parentOf.get(slug);
    if (direct === undefined || direct === '') return {};
    const cycle = detectCycle(slug);
    if (cycle !== undefined) return { issue: cycle };
    if (!bySlug.has(direct)) {
      // **順に見る。** 「同じ描画の中に premise として載っている」ほうが具体的
      // なので先に当てる——記憶の全体には当然その premise も入っているので、
      // 逆順にすると具体的な言い方のほうが二度と出なくなる。
      if (renderedAsPremise.has(direct)) return { issue: 'parent-not-listed' };
      if (presentInMemory?.slugs.has(direct)) return { issue: 'parent-not-rendered' };
      return { issue: 'missing-parent' };
    }
    return { parent: direct };
  }

  const nodes = new Map<string, ResolvedTocNode>(
    entries.map((entry) => [entry.slug, { entry, depth: 0, children: [] }]),
  );
  const roots: ResolvedTocNode[] = [];

  for (const entry of entries) {
    const node = nodes.get(entry.slug);
    if (!node) continue;
    const resolved = effectiveParent(entry.slug);
    if (resolved.issue !== undefined) node.issue = resolved.issue;
    const parentNode = resolved.parent === undefined ? undefined : nodes.get(resolved.parent);
    if (parentNode !== undefined) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function sortAndDepth(node: ResolvedTocNode, depth: number): void {
    node.depth = depth;
    node.children.sort((a, b) => a.entry.slug.localeCompare(b.entry.slug));
    for (const child of node.children) sortAndDepth(child, depth + 1);
  }
  roots.sort((a, b) => a.entry.slug.localeCompare(b.entry.slug));
  for (const root of roots) sortAndDepth(root, 0);

  return roots;
}

function flattenMemoryToc(roots: readonly ResolvedTocNode[]): ResolvedTocNode[] {
  const out: ResolvedTocNode[] = [];
  function walk(node: ResolvedTocNode): void {
    out.push(node);
    for (const child of node.children) walk(child);
  }
  for (const root of roots) walk(root);
  return out;
}

/**
 * `MemoryCreatedAt` の2状態の網羅性を型で強制する
 * （`assertNeverMemoryProtectionStatus` と同じ形）。
 */
export function assertNeverMemoryCreatedAt(createdAt: never): never {
  throw new Error(`未知の記憶作成時刻の状態: ${JSON.stringify(createdAt)}`);
}

/**
 * `createdAt` を一覧の1行に出す形にする。**根拠が無ければ「不明」と明言する**
 * ——値を持たないことを空文字で隠さない（`memoryFreshnessMarker` の
 * `unknown` 分岐と同じ判断: 分からないことを一覧の上でも言葉にする）。
 *
 * **`export` してあるのは `self_status` の記憶内訳（`tools.ts` の
 * `renderMemorySize`）も同じ整形を使うため。** 同じ結果を返す関数を2つ
 * 書かない——書けば、片方だけ直したくなったときにもう片方が古いまま残る
 * （`memory_list` と `self_status` で「不明」の言い方がずれる、という形で）。
 */
export function formatMemoryCreatedAt(createdAt: MemoryCreatedAt): string {
  switch (createdAt.kind) {
    case 'known':
      return createdAt.at;
    case 'unknown':
      return '不明';
    default:
      return assertNeverMemoryCreatedAt(createdAt);
  }
}

/**
 * ミリ秒差を人間が読める期間にする（`memoryFreshnessMarker` の `stale` 専用）。
 *
 * **`⚠` を数に置き換える #821 の核心はここが担う。** 「古いか古くないか」の
 * 1ビットではなく、「どれだけ古いか」を文字で運ぶ —— 1時間しか経っていない
 * 文書と30日放置された文書が、同じ印で束ねられないようにする。
 *
 * 秒・分・時間・日の4段で丸める（`describeZombieAge` / `formatElapsed`
 * ——`tools.ts` / `clone.ts`——と桁の切り方は同じ考え方だが、あちらは
 * 「いま」からの経過やゾンビの年齢という別の量を測る専用の実装なので
 * 共有しない。値を間違えて直したくなったとき、片方だけ直して済むように
 * 分けてある）。
 */
function formatMemoryStaleness(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  return `${days}日`;
}

/**
 * 印は要旨の**前**に置く——左から読んで必ず当たる形にする（4-1）。
 *
 * **代理指標であることをここにも書く**（`MemoryDescriptionFreshness` の doc
 * と同じ注意）。`fresh` は「`description` が本文の変更後に書かれた」ことしか
 * 意味しない。「本文を読み直して要旨を書き直した」ことの保証ではない。
 *
 * **`absent` 以外の3状態は必ず何かを出す**（#821）。かつては `fresh` /
 * `absent` がどちらも空文字で、`stale` / `unknown` だけが `⚠` / `？` を
 * 出していた —— その結果、本文の変更頻度が要旨の書き直し頻度を大きく
 * 上回るこの記憶の運用下では `stale` がほぼ常に真になり、「常に鳴る印」に
 * 読み手が慣れて他の印まで見なくなった（#821 の実測: 12/12 文書で `⚠` が
 * 付いていた）。**`stale` の有無という1ビットの信号をやめ、3状態それぞれに
 * 別の言葉を割り当てる** —— 「古いか」ではなく「どういう状態か」を言う形に
 * 変える。
 *
 * - `stale` — どれだけ古いかを `formatMemoryStaleness` で数値化して言う
 * - `unknown` — **「0（＝最新）」に見せない**。「要旨を書いた時刻が記録され
 *   ていない」と、`stale` とも `fresh` とも別の言葉で言う——欠測を鮮度として
 *   読ませると、直すべき文書が「手を入れなくてよい」側に化ける（#821）
 * - `fresh` — 「要旨の後に本文は動いていない」という正直なゼロ。`unknown`
 *   （そもそも測れていない）とは必ず違う言葉にする——同じ言葉にすると、
 *   読み手は「古くない」と「分からない」を区別できなくなる
 * - `absent` — 要旨そのものが無いので何も出さない（このケースは呼び出し側
 *   で `description === undefined` として既に弾かれているので、ここに来る
 *   ことは無い。網羅性のためだけに残す）
 */
function memoryFreshnessMarker(freshness: MemoryDescriptionFreshness): string {
  switch (freshness.kind) {
    case 'fresh':
      return '要旨の後に本文は動いていない: ';
    case 'stale':
      return `要旨は本文より${formatMemoryStaleness(freshness.staleForMs)}古い: `;
    case 'unknown':
      return '要旨を書いた時刻が記録されていない: ';
    case 'absent':
      return '';
    default:
      return assertNeverMemoryDescriptionFreshness(freshness);
  }
}

/**
 * 循環・存在しない親・「目次の外に実在する親」を黙って落とさず、印として
 * 言葉にする。
 *
 * **5つを畳まない。** どれも「親の行が上に無い」という同じ見た目だが、
 * **読み手が次に疑う先が違う。**
 *
 * | 印                     | 何が起きているか                                          | 読み手が次に見る先                         |
 * | ---------------------- | --------------------------------------------------------- | ------------------------------------------- |
 * | `missing-parent`       | その slug の文書がそもそも無い（打ち間違いか、削除された） | `parent` の綴り／消したかどうか             |
 * | `cycle`                | 親をたどると輪になる。**輪の全員がこの描画に載っている**  | どれかの `parent`（輪の中の全員を疑ってよい） |
 * | `parent-not-listed`    | 文書は実在し、**同じ描画の中に premise として全文が載っている** | この目次のすぐ上                      |
 * | `parent-not-rendered`  | 文書は実在するが、**今回の描画そのものに載っていない**     | 記憶の側（`memory_list` を呼ぶ必要は無い）   |
 * | `cycle-outside-render` | 親をたどると輪になるが、**輪の一部がこの描画の外を通る**   | どれかの `parent`（輪の全員は画面上に無い）  |
 *
 * 本文の在り処は `renderMemoryDocuments` の doc が保証する不変条件（「どの文書も、
 * 全文か目次行かのどちらか一方に必ず現れる」）そのものなので、`parent-not-listed`
 * ではここでも同じ言葉で言う。
 *
 * **⚠️ `parent-not-rendered` の側では、その不変条件は成り立っていない**
 * ——不変条件は「記憶の全体を渡したとき」の約束であって、部分だけを描く呼び手
 * （`clone.ts` の `#withFreshMemory`）の下では「上にも下にも無い」が正しい状態
 * である。だから言い方も変える。**「見つからない」と書かないことが要点である**
 * ——クローンはそれを「記憶の階層が壊れた」と読んで確かめに行く（実測 2026-09-02）。
 *
 * **`cycle` と `cycle-outside-render` を畳まない理由**（`resolveMemoryHierarchy`
 * の doc と同じ話をここにも書く）: 輪の一部が画面に無いのに「循環」とだけ言うと、
 * 読み手は在りもしない輪をこの目次の中だけで探してしまう。
 * `cycle-outside-render` は「輪は実在するが、全員はここに出ていない」と明言する
 * ——次に見るべきは `memory_list`（記憶の全体の階層）であって、この目次の中を
 * 探し直すことではない。
 */
function renderMemoryTocIssue(node: ResolvedTocNode): string {
  if (node.issue === 'missing-parent') return `［親 ${String(node.entry.parent)} が見つからない］`;
  if (node.issue === 'cycle') return `［親 ${String(node.entry.parent)} との間で循環］`;
  if (node.issue === 'parent-not-listed') {
    // ⚠️ 文言は premise を名指ししたまま据え置く（不変条件3 —— premise/fact
    // のみの入力では出力を1文字も変えない）。`indexed` の親がここへ来ても
    // 分類（parent-not-listed）自体は正しくなる——親は実在し、この描画の
    // 中にカードとして載っている——が、文言はやや不正確になる（「premise
    // として」だが実際は indexed）。この不整合は既知の限界として報告に残す。
    return (
      `［親 ${String(node.entry.parent)} は在るが、この目次は fact だけを列挙する` +
      '（premise として本文が上に全文で載っている）］'
    );
  }
  if (node.issue === 'parent-not-rendered') {
    return (
      `［親 ${String(node.entry.parent)} は在るが、ここに載せた分には含まれない` +
      '（記憶には実在する——消えたのではない）］'
    );
  }
  if (node.issue === 'cycle-outside-render') {
    return (
      `［親 ${String(node.entry.parent)} との間で循環` +
      '（輪の一部はここに載せた分には含まれない——記憶の側にある）］'
    );
  }
  return '';
}

function renderMemoryTocLine(node: ResolvedTocNode): string {
  const indent = '  '.repeat(node.depth);
  const descriptor =
    node.entry.description === undefined
      ? '（要旨なし）'
      : `${memoryFreshnessMarker(node.entry.descriptionFreshness)}${excerptLine(node.entry.description, MEMORY_TOC_LINE_LIMIT)}`;
  return `${indent}- ${node.entry.slug}: ${node.entry.title} — ${descriptor}${renderMemoryTocIssue(node)}`;
}

/**
 * この描画（`entries` ∪ `elsewhere.renderedAsPremise`）が記憶の全体を覆っている
 * かを判定する。
 *
 * **`renderMemoryToc` が省略行の文言を選ぶためだけに存在する。** `elsewhere`
 * を受け取っていない、または受け取っていても `presentInMemory` を渡していない
 * 呼び手（記憶の全体を渡している呼び手）は無条件に「覆っている」とする——
 * `presentInMemory` を渡さなければ挙動を1バイトも変えないという既定値の約束を
 * ここでも守る。渡されているときは、`presentInMemory.slugs` の全員がこの描画
 * （`entries` の slug と、premise として同じ描画に載っている slug）に含まれて
 * いるかを見る。
 */
function tocEntriesCoverWholeMemory(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere,
): boolean {
  if (elsewhere.presentInMemory === undefined) return true;
  const rendered = new Set<string>(entries.map((entry) => entry.slug));
  for (const slug of elsewhere.renderedAsPremise ?? []) rendered.add(slug);
  for (const slug of elsewhere.presentInMemory.slugs) {
    if (!rendered.has(slug)) return false;
  }
  return true;
}

/**
 * 目次が予算で切れたときの断り書き。**「切った」だけでなく「何で切ったか」を
 * 名乗る**——件数（`MEMORY_TOC_ENTRY_LIMIT`）・文字数（`MEMORY_TOC_CHAR_BUDGET`）・
 * その両方、の3状態を別の文言で区別する（依頼者の明示の求め。`premise` 側の
 * 断り書き `renderPremiseOutlineOmission` と同じ思想——予算値を名乗り、
 * 実行できる直し方だけを出す）。
 *
 * ## なぜ3状態を区別するのか
 *
 * 件数と文字数は別の軸で、どちらが実際に効いたかを畳むと直し方を間違える。
 * **件数で切れている**なら、それは #170 の設計判断（「何件までなら判断材料
 * として妥当か」）が働いている状態で、実行できる直し方は無い——`fact` の
 * 数そのものを減らす以外に手が無く、それを「直せ」と言うのは越権である。
 * **文字数で切れている**なら、要旨（`description`）が長い・文書が多いことが
 * 原因で、`memory_frontmatter_set` で要旨を短くするという実在する手がある
 * （`renderPremiseCard` が要旨超過のときに出す助言と同じ形）。
 *
 * ## `tocEntriesCoverWholeMemory` の区別は壊さない
 *
 * 呼び手が渡す `wholeMemory` は既存の区別（#170）そのもので、切った理由の
 * 文言とは独立に組み合わせる——3（切った理由）×2（被覆）を6本のテンプレート
 * で書き並べるのではなく、`scope`（被覆）と `cause`（理由）を別々に組み立てて
 * 連結する。
 *
 * ## fact の目次は、文書が存在することを名乗る唯一の場所
 *
 * `renderMemoryDocuments` の不変条件により、`fact` はカードではなく**この
 * 目次の1行にしか現れない**。`premise` はカードが切られても文書の見出し
 * （`<!-- memory: slug.md -->`）は必ず残るが、`fact` にはその残る側が無い
 * ——切られた文書は、この焼き込みの中では存在しないのと見分けが付かなく
 * なる。だから件数と「隠れている事実そのもの」を必ず両方言う。
 */
function renderMemoryTocOmission(input: {
  omitted: number;
  total: number;
  wholeMemory: boolean;
  countCut: boolean;
  charCut: boolean;
}): string {
  const { omitted, total, wholeMemory, countCut, charCut } = input;

  const scope = wholeMemory
    ? `目次の対象は全 ${total} 件`
    : `この目次に並べたのは全 ${total} 件。記憶の全体ではなく、今回載せた分だけである`;

  const cause =
    countCut && charCut
      ? `件数（${formatMemoryCharCount(MEMORY_TOC_ENTRY_LIMIT)} 件の上限）と文字数（予算 ` +
        `${formatMemoryCharCount(MEMORY_TOC_CHAR_BUDGET)} 文字）の両方に当たって切った。`
      : countCut
        ? `${formatMemoryCharCount(MEMORY_TOC_ENTRY_LIMIT)} 件の上限に当たって件数で切った` +
          `（文字数の予算 ${formatMemoryCharCount(MEMORY_TOC_CHAR_BUDGET)} 文字にはまだ余裕がある）。`
        : `文字数の予算 ${formatMemoryCharCount(MEMORY_TOC_CHAR_BUDGET)} 文字に当たって文字数で切った` +
          `（件数は ${formatMemoryCharCount(MEMORY_TOC_ENTRY_LIMIT)} 件の上限の下——要旨が長い文書が多い）。`;

  // **文字数で切れているときだけ、実行できる直し方を出す。** 件数のみで
  // 切れているときは #170 の設計判断（「何件までなら判断材料として妥当か」）
  // が働いているだけなので、直し方を出さない——実行できない助言（「fact を
  // 減らせ」に類する越権の助言）を出さないための線引きである。
  const remedy = charCut
    ? ' 要旨（description）が長い文書は memory_frontmatter_set で短くすると、同じ件数でもここに多く載る。'
    : '';

  return [
    `…ほか ${omitted} 件は目次から省略（${scope}）。${cause}`,
    '⚠️ この目次は、fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所である' +
      '（premise はカードが切られても見出しは必ず残るが、fact はここでしか名乗らない）。' +
      `省かれた ${formatMemoryCharCount(omitted)} 件は、この焼き込みの中では存在しないのと見分けが付かない。`,
    `全件は memory_list、本文は memory_read slug=<slug> で取れる。${remedy}`,
  ].join('\n');
}

/**
 * `fact` 文書の目次を組み立てる。**保存しない——毎回この関数が
 * 各文書の `description` から組み立て直す**ので、目次と実体が食い違う
 * ことは構造的に起こりえない（4-1）。
 *
 * **切ったら、何で切ったかを必ず出す**（`excerpt.ts` と同じ約束を、
 * 件数・文字数の2軸へ広げたもの。文言は `renderMemoryTocOmission`）。
 *
 * `elsewhere` はそのまま `resolveMemoryHierarchy` へ渡す（`parent` がこの目次の
 * 外に実在するときの3つの状態を区別するため。呼び手
 * （`buildMemoryDocumentSections`）が premise の slug 集合と、記憶の全体の
 * `MemoryPresence` を渡す）。
 *
 * **省略行の文言は、この描画が記憶の全体を覆っているかでも変える**
 * （`tocEntriesCoverWholeMemory`）。部分だけを描く呼び手（`clone.ts` の
 * `#withFreshMemory`）の下では「目次の対象は全 N 件」の N が「今回変わった
 * fact の数」を指してしまい、記憶全体の件数だと誤読される——**判定は省略が
 * 起きたとき（`omitted > 0`）だけ行う**（実運用では 300 件を超える差分は
 * まず起きないので、毎回この判定を評価する必要は無い）。
 *
 * ## 件数の蓋と文字数の蓋を両方掛ける（順番に注意）
 *
 * 1. まず件数（`MEMORY_TOC_ENTRY_LIMIT`）で切る——これは従来どおり。
 * 2. その残り（最大300件）に対して、束ねた文字数（`MEMORY_TOC_CHAR_BUDGET`）
 *    でさらに切る。**`renderListing` をそのまま使う**（`excerpt.ts`）——
 *    ただし断り書きの文言はここでは作らせず、`omitted` コールバックには
 *    内訳（`shown`/`rest`/`total`）だけを受け取らせて捨てる。最終的な文言は
 *    件数側の情報と合わせてから `renderMemoryTocOmission` が1本で組み立てる
 *    ——切り方を2本のテンプレート系列に割らないため（依頼者の求め）。
 *    `renderListing` は先頭から詰め、1件目は予算超過でも必ず出す（`excerpt`
 *    で切って出す）が、この目次の1行は `MEMORY_TOC_LINE_LIMIT`（1行あたり
 *    200字）で頭打ちなので、`MEMORY_TOC_CHAR_BUDGET`（12,000）に対して1行が
 *    単独で予算超過になることは実運用では起こらない。
 */
function renderMemoryToc(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere = {},
): string {
  const flat = flattenMemoryToc(resolveMemoryHierarchy(entries, elsewhere));
  const countShown = flat.slice(0, MEMORY_TOC_ENTRY_LIMIT);
  const countCut = countShown.length < flat.length;

  const candidateLines = countShown.map(renderMemoryTocLine);

  let charBudgetInfo: { rest: number; shown: number; total: number } | undefined;
  renderListing(candidateLines, {
    budget: MEMORY_TOC_CHAR_BUDGET,
    omitted: (info) => {
      charBudgetInfo = info;
      return ''; // 文言はここでは作らせない。内訳だけを受け取って捨てる。
    },
  });
  const charCut = charBudgetInfo !== undefined;
  const shownLines =
    charBudgetInfo === undefined ? candidateLines : candidateLines.slice(0, charBudgetInfo.shown);
  const omitted = flat.length - shownLines.length;

  const lines = [
    '<!-- memory: index -->',
    '## 記憶の目次（fact。本文は memory_read で開く。階層はインデントで表す）',
    ...shownLines,
  ];
  if (omitted > 0) {
    lines.push(
      renderMemoryTocOmission({
        omitted,
        total: flat.length,
        wholeMemory: tocEntriesCoverWholeMemory(entries, elsewhere),
        countCut,
        charCut,
      }),
    );
  }
  return lines.join('\n');
}

const MALFORMED_FRONTMATTER_NOTE =
  '<!-- memory: frontmatter が壊れている（既知の形にならなかった。premise として扱っている） -->';

/**
 * 「変わった範囲だけを描く」を選ぶ線。**変わった範囲が全文のこの割合より
 * 大きければ、差分にせず全文を描く。**
 *
 * **暫定値である**（実測に基づく調整はまだ行っていない）。本番の実測
 * （2026-09-07）では、記憶の書き換え 640 件の内訳が
 * `append` 383 / `move_in` 85 / `move_out` 85 / `describe` 70 / `write` 17 で、
 * 変わった量の平均は 3,283 バイト、対象文書の平均は 199,007 バイトだった
 * ——**実運用で起きる書き換えは、どれもこの線の遥かに下に居る。**
 * 線がどこにあっても実質同じ結果になる範囲で、
 * 「半分より小さければ差分と呼んでよい」という語感の側へ倒してある。
 */
const MEMORY_DELTA_MAX_RATIO = 0.5;

/**
 * カード差分（`renderPremiseDelta`）が「押し出された節」を名指しする分の
 * 文字数の予算。**件数ではなく文字数で切る**（`MEMORY_PROMPT_OMITTED_TAIL_BUDGET`
 * と同じ思想——`.claude/skills/listing-and-detail/SKILL.md`「予算は件数ではなく
 * 文字数で持つ」）。
 *
 * **既存の `MEMORY_PROMPT_OMITTED_TAIL_BUDGET` を流用しない。** あちらは
 * 「目次が予算で切れた、その断り書きの中で末尾を名指しする」ための予算で、
 * こちらは「カードの差分で、前の版には載っていたのに今の版では押し出された
 * 節を名指しする」ための予算——**切っている理由も、切る場面も違う**（前者は
 * 毎ターンの焼き込みそのものに乗る。後者は書き換えが起きたときだけ乗る）。
 * 値の桁を揃えたのは偶然ではなく、どちらも「目次の1行を数行ぶん載せる」
 * という同じ形の予算だからである——それでも定数としては分ける。
 */
const MEMORY_DELTA_PUSHED_OUT_BUDGET = 300;

/**
 * premise のカードに載せる要旨（frontmatter の `description`）の文字数の予算。
 *
 * **⚠️ これは「要旨を短くしろ」という目安であって、本文の上限ではない。**
 * 本文はもう焼き込みに載らない（`renderPremiseCard`）ので、毎ターン全員が払う
 * のは要旨と目次だけである。要旨だけが上限を持たないと、そこへ本文を書いて
 * 同じ肥大が戻る——**逃げ道を塞ぐためにここにも予算を置く。**
 *
 * **暫定値である。** 本番の実測（2026-09-08T00:40Z）で premise 5本の要旨は
 * 5,910 / 2,529 / 2,397 / 2,337 / 1,517 文字だった。**3,000 はこの分布の
 * 「外れ値1本だけを名指しする」位置である**——線に意味を持たせるための選び方で
 * あって、3,000 という数そのものに根拠は無い。
 *
 * **切っても失われない。** 切ったことは必ず名乗り、要旨の全文は
 * `memory_list` / `memory_read` に在る。
 */
export const MEMORY_PROMPT_DESCRIPTION_BUDGET = 3_000;

/**
 * premise のカードに載せる**節の目次**の文字数の予算。
 *
 * **道具（`memory_outline`）の `MEMORY_OUTLINE_BUDGET` とは別物である。**
 * あちらは「1回のツール応答に何文字載せるか」（MCP の出力上限）、こちらは
 * 「**毎ターン全員が払う焼き込みに何文字載せるか**」で、切る理由が違う。
 *
 * **暫定値である。** 本番の実測（2026-09-08T00:40Z）で premise 5本の見出しの
 * 総量は 34,823 / 8,474 / 7,393 / 4,934 / 2,971 文字だった。6,000 は
 * **「大きい2本を名指しし、残り3本はそのまま載る」位置**である。
 *
 * **⚠️ 予算に当たったこと自体が、この文書を割れという合図である**——だから
 * 省略の断りには件数だけでなく、割る手順（`memory_outline` → `memory_section_move`）
 * **だけでなく、何を移すかの基準**（済んだ経緯・1回きりの実測・失効した
 * 手順であって、いま足したばかりの節ではない）も書く（`excerpt.ts` の
 * 「続きの取り方を書けるのは、呼び手の側にその口が実在するときだけである」）。
 *
 * **基準を置く先は `prompt.ts`（毎ターンの床）ではなく、ここが生む断り書き
 * 側にした。** 費用が発生する瞬間と、危険が発生する瞬間が一致するからである
 * ——`prompt.ts` の床の案内はもともと「目次に『省略』と出ている文書」に
 * しか触れておらず、その助言が要る場面と、この断り書きが出る場面は同じ。
 * ⟹ 基準を断り書き側に置けば、**要るときに必ず在り、要らないときは1文字も
 * 出ない**。オーナーの決定（永続的なトークン肥大化を避ける）に対して、
 * 毎ターン払う床を増やさずに済む形である。
 */
export const MEMORY_PROMPT_OUTLINE_BUDGET = 6_000;

/**
 * `indexed` のカードに載せる要旨の文字数の予算。
 *
 * ## なぜ要るか（人間の決定 2026-09-10）
 *
 * 特定のプロジェクトでしか使わない記憶（実測でいう alteroid-work /
 * virchamate / mnemo / tsumugi の4文書）は、そのプロジェクトを触っていない
 * ターンでも premise として節の目次を焼き続けていた。**しかしセッションの
 * システムプロンプトはターンが始まる前に組み立てられるので、「いま触って
 * いるプロジェクト」で載せ方を選ぶことは実装できない。** ⟹ 成立するのは
 * 「人間またはクローンが事前に選べる形」だけであり、それが `type: indexed`
 * である——**節の目次を焼くのをやめ、要旨だけを焼く。**
 *
 * ## ⭐⭐ 不変条件: `indexed` の床は `premise` の床を絶対に超えない
 *
 * `indexed` は節の目次を1文字も焼かないので、逃した分の一部を要旨の予算へ
 * 回してよい——それでも `MEMORY_PROMPT_DESCRIPTION_BUDGET + MEMORY_PROMPT_OUTLINE_BUDGET`
 * （3,000 + 6,000 = 9,000）を絶対に超えないこと。**これは歯で固定してある**
 * （`memory.test.ts` の「`indexed` の要旨予算は premise の要旨＋目次予算より
 * 必ず小さい」——定数どうしを比較する歯なので、将来どちらかの値だけが動くと
 * 赤くなる）。
 *
 * **推奨値は 6,000 を採った。** 理由は2つ:
 *
 * 1. **要旨の予算を `MEMORY_PROMPT_DESCRIPTION_BUDGET`（3,000）のまま
 *    据え置かないこと。** 実測（2026-09-10）で、クローンの要旨は3,000文字で
 *    切られており、**切られるのは末尾＝いちばん新しい記述**である（実際に
 *    新しい規則が1本切れた実績がある）。節の目次で切られ、避難先の要旨でも
 *    切られるという**二重の切断**を、`indexed` では起こさないこと。
 * 2. **それでも無制限にはしないこと**（肥大化対策の放棄になる）。節の目次
 *    （6,000）を丸ごと手放すぶんを、そのまま要旨の予算へ回す形にすれば、
 *    「節の目次を手放した代わりに要旨を厚くする」という交換の形が数として
 *    も分かりやすい。
 */
export const MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET = 6_000;

/**
 * 目次が予算で切れたときに、**落ちた末尾の側を名指しする**ぶんの文字数の予算。
 *
 * ## なぜ落ちた側の見出しを断り書きへ出すのか
 *
 * **`renderListing` が落とすのは常に並びの末尾側である。** ⟹ 追記で育つ文書
 * （規則の一覧・学びの一覧）では、**新しく足した節だけが恒久的に窓の外へ出る。**
 * これは `excerpt.ts` の `ListingBudget.omitted` が逐語で名指ししている形で、
 * あちらは台帳（`tools.ts` の `commitment_list`）で実害が出て継続点で塞いだと
 * 書き、そのうえで「**他の一覧が同じ形かどうかは数えていない**」と断っている。
 * ⟹ **premise のカードが、その「数えていない一覧」だった。**
 *
 * **観測（2026-09-09、この器のクローンが自分の焼き込みを測った値）**: 規則の
 * 文書は 106 節・37,056 文字あり、目次に載っていたのは先頭側だけだった。⟹
 * その日に足した規則は目次に載らず、**「N 節省略」という断り書きは出ていたのに、
 * クローンはそれを「だから今日足した規則が見えない」へ繋げられなかった。**
 *
 * ## 落ちているのは本文であって、見出しではない
 *
 * 節の1行は数十文字しかない。⟹ **落ちた末尾のうち直近のぶんだけなら断り書きへ
 * 入る**し、そこには節id も出るので `memory_section_read` で直に開ける。
 * 「N 節省略」だけだと、何が省略されたかを知る手は `memory_outline` の呼び直し
 * にしか無く、**呼ぶ動機がその断り書きの中に無い。**
 *
 * ## ⚠️ 件数（「直近3節」）ではなく文字数で持つ
 *
 * 見出しの長さは節ごとにばらばらなので、**件数で決めると断り書きの長さが見出し
 * 次第で暴れる**——`ListingBudget` の doc が「件数から出力量を決めると、何件で
 * 壊れるかが運任せになる（それで一覧が丸ごと落ちた実績が `manager_list` に
 * ある）」と書いている、その形そのものである。
 *
 * **300 の出し方。** `MEMORY_PROMPT_OUTLINE_BUDGET` の doc に載っている本番実測
 * （2026-09-08）で、予算に当たっている premise の目次は1行あたり 80 文字前後で
 * ある。⟹ 300 は**その3行ぶん**で、「最後に足した節が1つ2つなら必ず名指しされる」
 * 位置である。**⭐ そして節数が増えても増えない**——1行の固定費（節id と
 * `— N 文字`）が節数に比例して予算を食うのに対し、ここは食わない。それが
 * この形を選んだ理由そのものである。
 */
export const MEMORY_PROMPT_OMITTED_TAIL_BUDGET = 300;

/**
 * premise のカードを**束ねた全体**の文字数の予算。**1文書あたりの予算
 * （{@link MEMORY_PROMPT_DESCRIPTION_BUDGET} / {@link MEMORY_PROMPT_OUTLINE_BUDGET}）
 * とは別の軸で、両方が効く。**
 *
 * ## なぜ要るか — 1文書あたりの予算だけでは、文書数に対して線形に伸びる
 *
 * `buildMemoryDocumentSections` は premise のカードを全件連結する。⟹ **床は
 * premise の文書数に比例して伸び、上界が存在しない。** {@link describeMemoryTidyTargets}
 * の doc が逐語でこの穴を名指ししている——「**⚠️ 当たっていないことは『小さい』では
 * ない。** 予算は1文書ごとに掛かるので、全部が予算の下でも合計は大きくなりうる」。
 * そこでの答えは「総量を別に出す」＝**観測**であって、蓋ではなかった。
 *
 * **同じ形は `fact` 側では既に塞がれている**（{@link MEMORY_TOC_CHAR_BUDGET}、
 * 2026-09-09）。件数の上限（{@link MEMORY_TOC_ENTRY_LIMIT}）だけでは束ねた総量が
 * 運任せになる、という理由でそちらへ文字数の蓋を足した。**premise 側だけが
 * 残っていた非対称を、ここで閉じる。**
 *
 * ## 実測（2026-09-11、この repo での合成入力）
 *
 * `renderMemoryDocuments` に premise（要旨 2,900 字 / 40 節）を N 件通した値。
 * **本番の記憶（PostgreSQL）には触っていない。**
 *
 * | premise 件数 | 蓋が無いときの焼き込み |
 * | --- | --- |
 * | 1 | 4,932 |
 * | 5 | 24,668 |
 * | 10 | 49,338 |
 * | 30 | 148,038 |
 * | 60 | **296,088** |
 *
 * 対照（`fact` は蓋が効いている）: 300件 12,403 / 1,000件 12,389 / 5,000件 12,255。
 *
 * ## 塞いでいるのは費用ではなく可用性である
 *
 * システムプロンプトは**要約で畳めない。** ⟹ 床が文脈窓を超えると、クローンは
 * 毎ターン失敗する。`clone.ts` の `#noteContextWindowFold` は畳み直しの暴走は
 * 止めるが（`held`）、**記憶の索引を自動で軽くする経路は無い**——クローン自身への
 * 断り書きも「⚠️ 記憶（システムプロンプトの「現在の記憶」）はそのままである」と
 * 言う。⟹ **人間が記憶を直すまで、クローンは1ターンも走れない。** この蓋は
 * そこへ落ちる道を閉じる。
 *
 * ## 値の出し方（60,000）
 *
 * **⚠️ この値は実装した側の導出であって、人間の決定ではない**
 * （{@link MEMORY_TOC_CHAR_BUDGET} の「## 値の出し方（12,000。人間の決定）」とは
 * そこが違う）。変えるならこの定数1つで足りる。
 *
 * - **⚠️ かつてここには「6本が全部上限に張り付いても `9,936 × 6 = 59,616 < 60,000`
 *   なので噛まない。噛み始めるのは7本目を足したときである」と書いてあった。その
 *   2文はいずれも偽である**（2026-09-11 に訂正。理由は下の「## 導出が腐った経緯」）。
 * - **噛む条件は「本数」ではなく「張り付いたカードが何枚あるか」である。**
 *   1文書あたりの予算に**完全に**張り付いたカードの大きさを、書式を真似ずに実測した
 *   （張り付いた文書を1件・2件通した差＝カード1枚＋区切り。`measureCardMarginalCost`
 *   と同じ作法）:
 *
 *   | 区分 | 張り付いたカード1枚（区切り込み） | この蓋に収まる枚数 |
 *   | --- | --- | --- |
 *   | `premise` | 10,288 | **5** |
 *   | `indexed` | 6,139 | **9** |
 *
 *   ⟹ **`premise` は6枚目が張り付いた時点で噛む**（`10,288 × 6 = 61,728 > 60,000`）。
 *   **本番の premise はちょうど6本なので、本数を1つも増やさなくても、6本が育ちきれば
 *   噛む。**
 * - **⭐ だから「◯本目で噛む」と書かないこと。** 噛むかどうかは**本数 × 張り付き
 *   具合**で決まり、しかも `indexed`（{@link MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET}）
 *   へ移せば1枚の大きさが下がるので**運用の側でも動く。** ⟹ 条件で書く——
 *   **「`indexed` へ移さないまま premise が6本とも上限へ張り付いたとき」**である。
 * - **噛むこと自体は意図である。** premise は「毎ターン全員が払う」区分なので、
 *   増やすことに価格が付いていてよい——足したターンにカードが1枚落ちれば、
 *   クローンはその場で「割るか fact へ落とすか」を判断できる（判断の材料は
 *   {@link describeMemoryTidyTargets} と、この蓋が出す断り書きの両方に在る）。
 * - **{@link MEMORY_TOC_CHAR_BUDGET}（12,000）と合わせて、記憶の索引の上界が確定する。**
 *   premise 60,000 ＋ 落とした分の一覧 {@link MEMORY_PREMISE_STUB_BUDGET} ＋ fact 12,000
 *   で、**文書が何件増えても焼き込みはこの和を超えない。**
 * - **今日の床を下げるのはこの蓋の仕事ではない。** #772 が挙げている案2（節目次を
 *   深さで切る）・案3（要旨と目次のどちらを切るか選ぶ）が「1文書あたりの定額が
 *   張り付いている」側の話で、こちらは「文書数に対する上界」側である。**別の軸なので、
 *   どちらかを入れてももう片方は要る。**
 *
 * ## 導出が腐った経緯（2026-09-11）— **依存している PR を名指ししていなかった**
 *
 * 旧い導出（`9,936 × 6 = 59,616 < 60,000`）は、**書いた時点では正しかった。**
 * 腐らせたのは、その後に入った2本である:
 *
 * - **#807**（`memory_outline` に `q` / `offset` を足した）が、節目次の省略の
 *   断り書きを書き換えた ⟹ **目次が切れている文書のカードが1枚あたり +202 文字**
 *   （実測。目次が予算に収まっている文書は +0）。
 * - **#805**（`indexed` を足した）が、この蓋の対象に `indexed` を加えた ⟹
 *   **「premise の本数」だけでは噛む条件が決まらなくなった。**
 *
 * ⟹ **どちらも「この定数を触った」わけではない。** それでも導出は偽になった。
 * **コメントは検査されないので、偽になったことは誰にも見えない**——次にこの値を
 * 触る人が、この計算を信じる。
 *
 * ## ⭐ 一般化: **「〜だから安全である」と書くなら、依存している対象を名指しする**
 *
 * この repo の定数の doc は、しばしば「実測で N だったので、この値なら収まる」と
 * いう形の導出を持つ。**その実測が何に依存しているかを書かないと、依存先が動いた
 * ときに導出だけが静かに嘘になる。** ⟹ **2つやること:**
 *
 * 1. **依存している PR・定数を名指しする。** 「この値は #807 が入っていない前提で
 *    出した」と1行あれば、#807 が入った瞬間に見直せた。
 * 2. ⭐ **導出そのものを歯にする。** ここでは「張り付いたカード何枚で噛むか」を
 *    **定数と実測から計算する歯**が `memory.test.ts` に在る ⟹ 1文書あたりの予算か
 *    この蓋のどちらかが動けば**赤くなる。** コメントだけなら気づけない。
 *
 * **`export` してあるのはテストのため**（値を書き写さず参照する）。
 */
export const MEMORY_PREMISE_CARD_BUDGET = 60_000;

/**
 * カードを落とした premise の1行に載せる要旨の長さの上限。
 *
 * **{@link MEMORY_TOC_LINE_LIMIT}（fact の目次の1行）と値は同じだが、別に置いてある。**
 * `.claude/skills/listing-and-detail/SKILL.md` の「予算の定数は**用途ごとに別に置き、
 * doc に由来を書く。値が同じでも使い回さないこと**（片方だけ直したくなったときに
 * 一緒に動いてしまう）」に従う——あちらは「fact の目次に何文字載せるか」、こちらは
 * 「**カードを落とした premise が、落とされた事実と一緒に何を名乗るか**」で、
 * 切る理由が違う。
 *
 * **由来は fact 側に合わせた。** 落とされた premise が名乗る量が fact の1行より
 * 多いと、「カードを落とした」と言いながら fact より重い行が並ぶことになる。
 */
const MEMORY_PREMISE_STUB_LINE_LIMIT = 200;

/**
 * カードを落とした premise の**一覧全体**の文字数の予算。
 *
 * **これが無いと蓋が蓋にならない。** 落とした分を1行ずつ並べる形は、落とした件数に
 * 比例して伸びる——{@link MEMORY_PREMISE_CARD_BUDGET} で切った総量が、断り書きの側から
 * 戻ってくる。⟹ 落とした分の一覧にも予算を持ち、**そこでさらに省いたら件数を名乗る**
 * （`renderListing`）。
 *
 * **値は {@link MEMORY_TIDY_TARGETS_BUDGET}（3,000）に合わせた。** あちらは「毎ターンの
 * 焼き込みに収まっていない文書を名指しする」一覧で、**これと同じ種類の的**である
 * （どちらも「この文書に手を入れろ」と言うための名指し）。同じ種類なので同じ量で足りる、
 * という判断であって、定数を共有はしていない（直上の理由）。
 */
const MEMORY_PREMISE_STUB_BUDGET = 3_000;

/**
 * ATX 見出しの最短の形（`# x`）の長さ。**見出しはこれ未満へは縮められない。**
 *
 * 「見出しを平均 N 文字まで縮めれば載る」と名乗るときの下限として使う——
 * N がこれを下回るなら、その助言は**縮める先が無い**ので嘘である。
 */
const MEMORY_MIN_HEADING_CHARS = 3;

/**
 * premise 1文書ぶんの**カード**（要旨 ＋ 節の目次）。**本文は1文字も載らない。**
 *
 * ## なぜ全文をやめたか（人間の決定 2026-09-08）
 *
 * かつてここは全文だった。`renderMemoryDocuments` の doc も「`premise` は全文。
 * 切り詰めない（切り詰めた前提は『持っていない前提』と区別できない）」と
 * 書いていた。**その判断を、持ち主が実測を見たうえで反転させた。**
 *
 * 実測（2026-09-08、Railway の PostgreSQL を直接引いた値）:
 *
 * | | 全文 | 要旨＋目次 |
 * | --- | --- | --- |
 * | premise 5本の合計 | 527,277 文字 | **73,285 文字（13.9%）** |
 * | 毎ターンの焼き込み | ≒ 411,000 トークン | **≒ 57,000 トークン** |
 *
 * `alteroid-work` は 303,013 文字・**917 節**あり、1節あたり約 330 文字だった
 * ——**判断の前提ではなく、追記され続けたログである**（書き換えの内訳も
 * `append` 383 に対して `write` 17 で、足すだけで整理していない）。
 *
 * 人間の逐語: 「**読みたいときに読める仕組みは必要だが、毎回全行読ませるのは
 * 無駄だと感じる。**」「そんなに毎回呼び出さなきゃいけない記憶って多くないと
 * 思っていて。」
 *
 * ## ⚠️ これは「切り詰め」ではない。ただし能力の削減ではあり、それは人間が選んだ
 *
 * **黙って短くしているのではない**——載るのは要旨と、節id つきの目次と、
 * 各節の文字数である。⟹ **クローンは「何が書いてあるか」を毎ターン知っており、
 * 必要な節を `memory_section_read` で1回で開ける。**
 *
 * **それでも、開かなければ本文は文脈に無い。** 判断の前提が手元から消えている
 * 状態は実在するので、**プロンプト側が「開かずに『記憶に根拠が無い』と結論
 * するな」と明言する必要がある**（`prompt.ts`）。ここを書き忘れると、
 * PRD「権限境界」（記憶に根拠があるかで判断する）が静かに壊れる——根拠が
 * 「無い」のではなく「開いていない」だけの状態が、同じ顔で出る。
 */
/**
 * 節の目次が予算で切れたときの断り書き。**「切った」だけを名乗らない。**
 *
 * 出すのは3つである:
 *
 * 1. 省いた件数（従来どおり）。
 * 2. ⭐ **落ちた末尾のうち直近の節を、節id つきの行そのままで名指しする**
 *    （`MEMORY_PROMPT_OMITTED_TAIL_BUDGET` の doc に理由がある）。落ちるのは
 *    常に末尾なので、**追記で育つ文書では「いま足したもの」がここに出る。**
 * 3. ⭐ **何をすれば全部載るかを算術で出す**——1行の平均と、そのうち固定費
 *    （節id と `— N 文字`）が何文字か、そして見出しを平均いくつまで縮めれば
 *    予算に入るか。
 *
 * ## ⚠️ 3 は達成不能なことがある。そのときは「縮めれば載る」と言わない
 *
 * **1行の固定費は節数に比例する。** ⟹ 節が増えると、**見出しを最短
 * （`# x` の3文字）まで縮めても予算に入らない点を必ず越える**——予算 6,000 では
 * **167〜201 節あたりで反転する**（実測。見出しの深さと節の大きさで動く）。
 * **実運用の `alteroid-work` は 917 節ある** ⟹ すでに反転側に居る。
 *
 * **そこで「平均 N 文字まで縮めれば載る」と出すのは嘘である**——縮める先が
 * 無いのに縮めろと言うことになる。⟹ 反転している文書には**割るしかないと
 * 名乗らせる。** これは `ListingBudget.omitted` の「続きの取り方を書けるのは、
 * 呼び手の側にその口が実在するときだけである」を、助言の側へ当てた形である
 * ——**実行できない助言を出さない。**
 */
function renderPremiseOutlineOmission(
  items: readonly string[],
  sections: readonly MemorySection[],
  { rest, shown, total }: { rest: number; shown: number; total: number },
): string {
  // 落ちたのは常に末尾側である（`renderListing` は前から詰める）。
  const dropped = items.slice(shown);
  // **末尾を残す向きで切る。** 落ちた並びの中でも読み手が要るのは新しい側
  // （末尾）で、穴が空くのは古い側（先頭）である（`renderListingFromEnd`）。
  const tail = renderListingFromEnd(dropped, {
    budget: MEMORY_PROMPT_OMITTED_TAIL_BUDGET,
    omitted: ({ rest: above }) =>
      `…（この上にさらに ${formatMemoryCharCount(above)} 節落ちている。全部は memory_outline の side=tail で見る）`,
  });

  const outlineChars = items.reduce((sum, item) => sum + item.length, 0);
  const shownChars = items.slice(0, shown).reduce((sum, item) => sum + item.length, 0);
  const droppedChars = dropped.reduce((sum, item) => sum + item.length, 0);
  const headingChars = sections.reduce((sum, section) => sum + section.heading.length, 0);
  // 固定費 = 目次の1行の長さ − 見出しの長さ（インデント・節id・`— N 文字`）。
  // **引き算で出す**——1行の形（`memorySectionLines`）が変わったときに、
  // ここへ書き写した数だけが古くなるのを防ぐ。
  const fixedChars = outlineChars - headingChars;
  const room = MEMORY_PROMPT_OUTLINE_BUDGET - fixedChars;
  const arithmetic =
    room < total * MEMORY_MIN_HEADING_CHARS
      ? `⚠ 節id と文字数の固定費だけで ${formatMemoryCharCount(fixedChars)} 文字を使う（予算 ` +
        `${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字）。**見出しを最短（\`# x\`）まで` +
        `縮めても全 ${formatMemoryCharCount(total)} 節は載らない**——固定費は節数に比例するので、` +
        `この文書は縮めるのではなく memory_section_move で割るしかない。`
      : `1行の平均は ${formatMemoryCharCount(Math.round(outlineChars / total))} 文字` +
        `（うち節id と文字数の固定費が ${formatMemoryCharCount(Math.round(fixedChars / total))} 文字）。` +
        `予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字に全 ` +
        `${formatMemoryCharCount(total)} 節を載せるには、見出しを平均 ` +
        `${formatMemoryCharCount(Math.floor(room / total))} 文字（いま ` +
        `${formatMemoryCharCount(Math.round(headingChars / total))} 文字）まで縮める必要がある。`;

  return [
    `…末尾 ${formatMemoryCharCount(rest)} 節は目次から省略（全 ${formatMemoryCharCount(total)} 節のうち先頭 ` +
      `${formatMemoryCharCount(shown)} 節だけ載せた）。` +
      '⚠ この文書は大きすぎて、目次すら毎ターンの焼き込みに収まっていない。' +
      `節の目次は全 ${formatMemoryCharCount(total)} 節ぶんで ${formatMemoryCharCount(outlineChars)} 文字` +
      `（節の本文の総量ではない）——うち焼き込みに載った分 ${formatMemoryCharCount(shownChars)} 文字、` +
      `予算に入らず省いた分 ${formatMemoryCharCount(droppedChars)} 文字。`,
    '落ちた末尾のうち直近の節（節id はそのまま memory_section_read に渡せる。' +
      '**足したばかりの節はここに出る**）:',
    tail,
    arithmetic,
    'memory_outline は side=tail で末尾も見られるほか、q=<文字列> で見出しを絞り込めば一致した節の節id へ直接届き、' +
      'offset=<N> で先頭から窓をずらして読むこともできる——後者は窓の大きさぶんずつ進めれば、' +
      'この文書がどれだけ大きくても全節の節id に有限回で届く（中央の節も含めて）。これらで残りを確かめてから、' +
      'memory_section_move で付録の文書へ割ること。**移すのは済んだ経緯・' +
      '1回きりの実測・失効した手順であって、末尾の新しい節ではない。** ' +
      '⚠ side=tail は末尾を**読む**ための向きであって、末尾を**移す**ための指示ではない' +
      '——読んで確かめた末尾をそのまま移すと、いちばん新しい学びを fact へ追い出すことになる。' +
      '同じ理由で、q や offset で中央の節id が読めても、それをそのまま移してよいとは限らない——' +
      '何を移すかの基準（直上）は変わらない。',
  ].join('\n');
}

/**
 * カードの要旨（`description`）1行を組む。**`renderPremiseCard`（`indexed` も
 * 含む）が共有する下ごしらえ**——premise と indexed は要旨の予算だけが違い
 * （`MEMORY_PROMPT_DESCRIPTION_BUDGET` / `MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET`）、
 * 切ったときの文面の形は同じである。**premise 側の抽出であり、既存の文面を
 * 1文字も変えていない**（`renderPremiseCard` の出力は抽出の前後で一致する
 * ことを歯で固定する——不変条件3）。
 */
function renderMemoryCardSummaryLine(description: string | undefined, budget: number): string {
  const trimmed = description?.trim() ?? '';
  return trimmed.length === 0
    ? '要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——' +
        'ここが空だと、本文を開くまでこの文書が何なのか分からない）'
    : trimmed.length <= budget
      ? `要旨: ${trimmed}`
      : `要旨: ${excerpt(trimmed, budget)}\n` +
        `⚠ 要旨が長すぎて毎ターンの焼き込みに収まっていない（${formatMemoryCharCount(trimmed.length)} 文字 / ` +
        `目安 ${formatMemoryCharCount(budget)} 文字）。全文は memory_list / memory_read に在る。` +
        '要旨に本文を書かず、本文は節へ移して memory_frontmatter_set で要旨を短くすること。';
}

function renderPremiseCard(part: MemoryPart): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const description = frontmatter.kind === 'parsed' ? frontmatter.description : undefined;
  const { sections } = scanMemorySections(part.content);

  const head =
    `<!-- memory: ${part.slug}.md（premise・本文は載っていない。` +
    `全 ${formatMemoryCharCount(part.content.length)} 文字 / ${formatMemoryCharCount(sections.length)} 節） -->`;

  const summaryLine = renderMemoryCardSummaryLine(description, MEMORY_PROMPT_DESCRIPTION_BUDGET);

  if (sections.length === 0) {
    return [
      head,
      summaryLine,
      '節: 1つも無い（見出しが無いか、前書きしか無い）。本文は memory_read で開く。' +
        '**見出しを付けると節id で名指しして開けるようになる**（memory_section_read）。',
    ].join('\n');
  }

  // **1行の形は1回だけ組む。** 断り書きの側も同じ行を名指しに使うので、
  // ここで2回組むと「目次に載っている行」と「落ちたと名乗る行」が別々の
  // 計算になりうる（数え方を2本に割らない。`measureMemoryFloor` の doc）。
  const items = memorySectionLines(sections);
  const listing = renderListing(items, {
    budget: MEMORY_PROMPT_OUTLINE_BUDGET,
    omitted: (part) => renderPremiseOutlineOmission(items, sections, part),
  });

  return [
    head,
    summaryLine,
    '節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:',
    listing,
  ].join('\n');
}

/**
 * `indexed` 1文書ぶんの**カード**（要旨だけ。節の目次は載らない）。
 *
 * **`renderPremiseCard` との唯一の違いは、要旨の予算と、節の目次を出さない
 * ことである。** 見出し（`head`）の形は premise と揃えてある——`全 N 文字 /
 * M 節` は premise のカードの1行目と同じ役目（「そこに何が在るか」を失わない。
 * PR の不変条件4）を、節の目次を省いた `indexed` でも果たす。
 *
 * **節の目次を焼かない代わりに、開く手段を必ず案内する。** `memory_outline`
 * （節id と見出しの一覧を返す）→ `memory_section_read`（節id を渡して開く）
 * の2手である。
 *
 * ⚠️ ここでは `q=` / `offset=` を名指ししない——`memory_outline` にその引数を
 * 足す変更は別 PR として並行に進んでいる（未マージ）。実行できない引数を
 * 助言に書かない（AGENTS.md「実行できない助言を出さない」と同じ線）。
 */
function renderIndexedCard(part: MemoryPart): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const description = frontmatter.kind === 'parsed' ? frontmatter.description : undefined;
  const { sections } = scanMemorySections(part.content);

  // ⚠️ 見出し（head）は premise と同じ形にする（「indexed」の語だけが違う）。
  // ここへ premise には無い説明を足すと、それだけで premise より必ず大きく
  // なる（節が0件のとき、他の行はどちらも同じ長さになるため）。
  const head =
    `<!-- memory: ${part.slug}.md（indexed・本文は載っていない。` +
    `全 ${formatMemoryCharCount(part.content.length)} 文字 / ${formatMemoryCharCount(sections.length)} 節） -->`;

  const summaryLine = renderMemoryCardSummaryLine(
    description,
    MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET,
  );

  // ⚠️ 節が0件のときも premise と一字一句同じ文にしない——head も summaryLine も
  // premise と同じ形になりうる（説明が予算内に収まる短い要旨のとき）ので、
  // ここが同じ文言だと indexed の床が premise と完全に一致してしまい、
  // 不変条件1（indexed の床は premise の床を必ず下回る）が節0件のときだけ
  // 破れる（実測で見つかった。`memory.test.ts` の「節 +0・要旨 10 文字」）。
  // だから premise の0節分岐より必ず短い文にする——「見出しを付けると節id で
  // 開けるようになる」という追加の案内は落とし、内容は変えず短くするだけに
  // とどめる。
  // 節が1件以上のときは、premise の最小1節ぶんの目次（見出し・節id・前置き込み）
  // より必ず短くなるよう、短い1行に切り詰めてある。
  const sectionsLine =
    sections.length === 0
      ? '節: 1つも無い（見出しが無いか、前書きしか無い）。本文は memory_read で開く。'
      : `節: 全 ${formatMemoryCharCount(sections.length)} 節（目次は載らない。` +
        'memory_outline → memory_section_read で開く）。';

  return [head, summaryLine, sectionsLine].join('\n');
}

/**
 * カード差分（`renderPremiseDelta`）の消えた行のうち、**目次の1行（節）の
 * 形をしている行だけ**から見出し文字列を取り出す。
 *
 * 形は `memorySectionLines` が組むもの（`[節id] 見出し — N 文字`。インデント
 * は先頭の空白）——**この形に一致しない行は節ではない**（カードの見出し
 * コメント・省略の断り書き・算術の説明・案内文のどれも `[` から始まらない
 * ので、誤って節と数えることはない）。一致しなければ `null` を返す。
 */
function parseOutlineLineHeading(line: string): string | null {
  const match = /^\s*\[[^\]]+\] (.+) — [\d,]+ 文字/.exec(line);
  return match ? (match[1] as string) : null;
}

/**
 * カード差分で消えた行を、**節の行だけ**を対象に3つへ分ける。
 * （呼び出し元・実例は `renderPremiseDelta` の doc「⚠️『いまは無い行』は
 * 一枚岩ではない」を見ること。）
 *
 * - **押し出された**（甲）: その見出しが、いまの文書の節に**ちょうど1つ**
 *   在り、かつ**その節のいまの行が、新しいカードのどこにも出ていない**
 *   ——節そのものは文書に残っており、予算に入らずカードの索引から落ちた
 *   だけである。**いまの節（id・文字数込み）を返す**——消えた行に書いて
 *   あった節id はその版のものなので使わない。`memorySectionId` は中身が
 *   変われば変わるので、版が違えば信用できる保証が無い。
 * - **消えたか書き換わった**（乙）: その見出しが、いまの文書のどの節にも
 *   無い。
 * - **判定できない**（丙）: その見出しが、いまの文書に**複数**在る——どの
 *   節に対応するかを決める材料が無い（`AGENTS.md`「判定できないという
 *   3つ目の状態を持つ」）。
 *
 * `parseOutlineLineHeading` が `null` を返す行（節ではない行）は `other` に
 * 入れる。**これは「消えた」とは名乗らない**——カードの1行目や断り書きは
 * 書き換えのたびに文字数・節数が変わるので、旧い版が消えた行の集合に
 * 混ざるのは当然であり、実際には何も失われていない（新しい版は `added`
 * 側に載っている）。
 *
 * ## ⚠️ 見出しが一致するだけでは「押し出された」と言わない
 *
 * **その節の本文だけが変わり、新しい行がいまのカードに現に載っている**
 * （＝ `added` 側に既に出ている）なら、それは押し出しではなくただの更新
 * である——読み手には「その行が別の新しい行に変わった」がそのまま見えて
 * おり、名指しする必要が無い。ここを見ずに「見出しが1つだけ一致すれば
 * 押し出された」と判定すると、**本文を書き換えただけの通常の更新まで
 * 「押し出された」と誤って名乗ってしまう**（節は消えても押し出されても
 * いない。ただ新しい行に置き換わっただけである）。⟹ `nextLineSet`
 * （新しいカードの行の集合）にその節の**いまの行そのもの**が含まれるかを
 * 見て、含まれていれば `other` へ落とす。
 */
function classifyDroppedOutlineLines(
  droppedLines: readonly string[],
  currentSections: readonly MemorySection[],
  nextLineSet: ReadonlySet<string>,
): {
  pushedOut: { heading: string; section: MemorySection }[];
  removedOrRewritten: string[];
  ambiguous: string[];
  other: string[];
} {
  const byHeading = new Map<string, MemorySection[]>();
  for (const section of currentSections) {
    const list = byHeading.get(section.heading);
    if (list) list.push(section);
    else byHeading.set(section.heading, [section]);
  }
  // **いまの各節の行そのもの**を、1回の `memorySectionLines` 呼び出しから
  // 作る——id の衝突マーカー（`memorySectionLines` が付ける ⚠）は文書全体を
  // 見て初めて正しく判定できるので、節ごとに単独で呼び直さない。
  const currentLineBySectionId = new Map<string, string>();
  const currentLines = memorySectionLines(currentSections);
  currentSections.forEach((section, index) => {
    currentLineBySectionId.set(section.id, currentLines[index]!);
  });

  const pushedOut: { heading: string; section: MemorySection }[] = [];
  const removedOrRewritten: string[] = [];
  const ambiguous: string[] = [];
  const other: string[] = [];

  for (const line of droppedLines) {
    const heading = parseOutlineLineHeading(line);
    if (heading === null) {
      other.push(line);
      continue;
    }
    const matches = byHeading.get(heading) ?? [];
    if (matches.length === 0) {
      removedOrRewritten.push(line);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(line);
      continue;
    }
    const section = matches[0]!;
    const currentLine = currentLineBySectionId.get(section.id);
    if (currentLine !== undefined && nextLineSet.has(currentLine)) {
      // その節のいまの行は、新しいカードに現に載っている——押し出しでは
      // なく、ただの更新（新しい行は `added` 側に既に出ている）。
      other.push(line);
      continue;
    }
    pushedOut.push({ heading, section });
  }

  return { pushedOut, removedOrRewritten, ambiguous, other };
}

/**
 * 押し出された節を、目次と同じ1行の形（**いまの**節id・文字数つき）で
 * 名乗る。文字数の予算（`MEMORY_DELTA_PUSHED_OUT_BUDGET`）で切る——件数が
 * 多いときに差分そのものが肥大化しないため（`.claude/skills/listing-and-detail/SKILL.md`
 * 「予算は件数ではなく文字数で持つ」）。
 *
 * 同じ節が複数の消えた行から重複して拾われることは無い——`section.id` で
 * 重複を除いてから並べる。
 */
function renderPushedOutSections(
  pushedOut: readonly { heading: string; section: MemorySection }[],
): string {
  const uniqueById = new Map<string, MemorySection>();
  for (const { section } of pushedOut) uniqueById.set(section.id, section);
  const items = memorySectionLines([...uniqueById.values()]);
  return renderListing(items, {
    budget: MEMORY_DELTA_PUSHED_OUT_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${formatMemoryCharCount(rest)} 節は省略（押し出された ${formatMemoryCharCount(total)} 節のうち ` +
      `${formatMemoryCharCount(shown)} 節だけ載せた。残りは memory_outline で確認すること）。`,
  });
}

/**
 * premise のカードの「変わった範囲だけ」を描く。差分にする価値が無ければ
 * `null` を返す（呼び手はカード全体へ倒す）。
 *
 * ## なぜ要るのか — 小さな書き換えがカード1枚ぶんの文脈を積んでいた
 *
 * `clone.ts` の `#withFreshMemory` は、変わった文書を会話へ載せ直す。その塊は
 * 会話の履歴として残り続けるので、**1回の書き換えの費用は「変えた量」ではなく
 * 「載せ直す塊の大きさ」で決まる。**
 *
 * 本番の実測（2026-09-07、Railway の PostgreSQL を直接引いた値）: 記憶の
 * 書き換えは1日 244 回あり、`alteroid-work` だけで 120 回だった。**カードに
 * したあとでも、1枚が予算いっぱい（要旨 ＋ 目次）なら1日で数十万トークンが
 * 会話へ積まれる。**
 *
 * ## 行の集合で差を取る（前後の一致で切らない）
 *
 * **カードは「見出し行 ＋ 要旨 ＋ 節の行」という索引であり、行が識別子である。**
 * ⟹ 前の版に無い行だけを、文書に現れる順のまま並べればよい。
 *
 * **前後の一致（共通の接頭辞・接尾辞）で切る形にしないこと。** カードの1行目は
 * 「全 N 文字 / M 節」を含むので**必ず変わる**——接頭辞が常に0行になり、
 * 末尾の節を1つ足しただけでも「全部変わった」に落ちる（実際にそう実装して
 * 落ちた）。
 *
 * **行の境界は必ず文字の境界である。** 記憶の見出しには絵文字（⚠️ / 🎯）が
 * 実際に含まれており、UTF-16 の code unit で切るとサロゲートペアが割れて
 * 壊れた文字を文脈へ載せうる。行で扱う限りそれが起こりえない。
 *
 * ## 「載せていない」を「無くなった」と読ませない
 *
 * 変わっていない行数と、**前の版に在って今は無い行数**を必ず名乗る
 * （`excerpt.ts` の「切ったら、切ったことを必ず言う」と同じ約束）。黙って
 * 省くと、クローンはそれを記憶の破損として読む。
 *
 * **⚠️ 行が移動しただけのときは「変わっていない」に数える。** カードは索引なので、
 * 同じ行が別の位置に在っても持っている情報は同じである——ここで位置まで見ると、
 * 節を1つ並べ替えただけで全体が差分に出る。
 *
 * ## ⚠️ 「いまは無い行」は一枚岩ではない（本番の実測で判明。2026-09-11）
 *
 * `memory_append` で9節・2,319文字を追記しただけの書き換えで、消えた行が
 * 7行出た。**その7行の中身は一様ではなかった**——3行は「カードの1行目・
 * 省略の断り書き・算術の説明」のような**節ではない行**で、数字（全体の
 * 文字数・節数・押し出された文字数）が追記のたびに変わるので、旧い版が
 * 消えた行の集合に入るのは当然であり、**何も失われていない**（新しい版が
 * `added` 側に載っている）。残る4行のうち3行は**本物の節の行**で、末尾の
 * 名指し（`MEMORY_PROMPT_OMITTED_TAIL_BUDGET` の枠）に載っていた節が、
 * 新しく追記された節に押し出されて**カードの索引から落ちていた**——節
 * そのものは文書に在る。
 *
 * **旧い実装はこの2種類を「消えたか書き換わったかのどちらか」という1つの
 * 文言に畳んでいた。** これでは押し出された節（＝文書に在り、節id さえ
 * 分かれば `memory_section_read` で開ける）と、本当に消えた・書き換わった
 * 節を、呼び手が区別できない。⟹ **消えた行のうち「節の行」だけを、いまの
 * 文書の節の一覧と突き合わせて3つに分ける**（`classifyDroppedOutlineLines`）。
 * 節ではない行（カードの見出し・断り書き・案内文）は、この分類に入れず
 * 黙って除く——それらは「消えた」のではなく「更新された」だけである。
 */
function renderPremiseDelta(
  slug: string,
  seenCard: string,
  nextCard: string,
  currentSections: readonly MemorySection[],
): string | null {
  const nextLines = nextCard.trimEnd().split('\n');
  const seenLines = seenCard.trimEnd().split('\n');
  if (nextCard.trimEnd() === seenCard.trimEnd()) return null;

  const seenSet = new Set(seenLines);
  const nextSet = new Set(nextLines);
  const added = nextLines.filter((line) => !seenSet.has(line));
  const droppedLines = seenLines.filter((line) => !nextSet.has(line));
  const unchangedCount = nextLines.length - added.length;

  // `join('\n')` の長さで測る——実際に載る形そのもので判定する。
  if (added.join('\n').length > nextCard.length * MEMORY_DELTA_MAX_RATIO) return null;

  const { pushedOut, removedOrRewritten, ambiguous } = classifyDroppedOutlineLines(
    droppedLines,
    currentSections,
    nextSet,
  );

  // **「消えた」と名乗るのは、実際に節が消えた／押し出された／判定できない
  // ときだけである。** 3つとも0件なら（＝消えたのは節ではない行だけなら）
  // この節の文言は1文字も出さない——起きていないことを起きたかのように
  // 書かない（`AGENTS.md` 地雷表「取れない軸に0の行を作る」の裏返し）。
  const droppedNotes: string[] = [];
  if (pushedOut.length > 0) {
    droppedNotes.push(
      `（前の版のカードに載っていたが、予算で押し出された節: ${formatMemoryCharCount(pushedOut.length)} 節。` +
        '節そのものは文書に在る——いまの節id で memory_section_read / memory_section_move に渡せる）:',
      renderPushedOutSections(pushedOut),
    );
  }
  if (removedOrRewritten.length > 0) {
    droppedNotes.push(
      `（前の版に在って、いまは無い節: ${formatMemoryCharCount(removedOrRewritten.length)} 節。` +
        'いまの文書のどの節の見出しとも一致しない——消されたか、見出しごと書き換わった）',
    );
  }
  if (ambiguous.length > 0) {
    droppedNotes.push(
      `（判定できない節: ${formatMemoryCharCount(ambiguous.length)} 節。同じ見出しがいまの文書に複数在るため、` +
        '押し出されたのか消えたのか決められない。memory_outline q=<見出しの一部> で確かめること）',
    );
  }

  return [
    `<!-- memory: ${slug}.md（カードの変わった範囲だけ） -->`,
    `（このカードは全 ${formatMemoryCharCount(nextLines.length)} 行。うち ` +
      `${formatMemoryCharCount(unchangedCount)} 行は変わっていないので載せていない。` +
      `カードの全体は memory_list、節の本文は memory_section_read で開ける）`,
    ...added,
    ...droppedNotes,
  ].join('\n');
}

/**
 * premise 1文書ぶんの描画。`seen`（クローンが既に見ている版）が渡され、かつ
 * 差分にする価値があるときだけ、**変わった範囲だけ**を描く。
 *
 * **`seen` を渡さない呼び手（システムプロンプトへの焼き込み・床の測定）は
 * カードの全体を得る。**
 */
function renderPremisePart(part: MemoryPart, seen?: string): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const card = renderPremiseCard(part);
  const delta =
    seen === undefined
      ? null
      : renderPremiseDelta(
          part.slug,
          renderPremiseCard({ slug: part.slug, content: seen }),
          card,
          scanMemorySections(part.content).sections,
        );
  const rendered = delta ?? card;
  return frontmatter.kind === 'malformed' ? `${MALFORMED_FRONTMATTER_NOTE}\n${rendered}` : rendered;
}

/**
 * カードを落とした premise の1行。
 *
 * **「カードが切られても見出しは必ず残る」を守るための形である。**
 * `renderMemoryTocOmission` が逐語でそう名乗っている（「premise はカードが切られても
 * 見出しは必ず残るが、fact はここでしか名乗らない」）——{@link MEMORY_PREMISE_CARD_BUDGET}
 * でカードを落とすとき、その約束を破らない唯一の形がこれである。**文書は消えない。
 * 落ちるのは節の目次と要旨の全文だけで、識別子・大きさ・節数・要旨の抜粋は残る。**
 *
 * 識別子を必ず載せるのは `.claude/skills/listing-and-detail/SKILL.md` の性質1
 * （「詳細を取りに行く鍵がなければ、抜粋にした瞬間に到達できないものが生まれる」）
 * ——`slug` が在れば `memory_outline` / `memory_section_read` / `memory_read` の
 * どれへも行ける。
 */
function renderPremiseStub(part: MemoryPart, cardChars: number, kind: MemoryDocKind): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const description =
    (frontmatter.kind === 'parsed' ? frontmatter.description : undefined)?.trim() ?? '';
  const { sections } = scanMemorySections(part.content);
  const summary =
    description.length === 0
      ? '（要旨がまだ書かれていない。memory_frontmatter_set の description で書くこと）'
      : excerptLine(description, MEMORY_PREMISE_STUB_LINE_LIMIT);
  return (
    `- ${part.slug}.md（${kind}・全 ${formatMemoryCharCount(part.content.length)} 文字 / ` +
    `${formatMemoryCharCount(sections.length)} 節・カードにすると ` +
    `${formatMemoryCharCount(cardChars)} 文字）: ${summary}`
  );
}

/**
 * premise のカードのうち、**どれをカードのまま載せ、どれを1行へ落とすか。**
 *
 * ## 蓋を掛けるのは「記憶の全体を描く呼び手」だけである
 *
 * `seenContent` が渡されている呼び（`clone.ts` の `#withFreshMemory` の差分）は
 * **渡された集合そのものが「今回変わった範囲」**であって床ではない。そこへ蓋を
 * 掛けると、システムプロンプト側ではカードが在る文書が差分の側だけ1行に落ちる
 * ——**同じ文脈の中で、同じ文書について2つの載り方が並ぶ。** ⟹ 掛けない。
 *
 * ## 落とす順序は「大きいほうから」である（位置で落とさない）
 *
 * **位置（渡された順＝slug 昇順）で落とすと、落ちる先を動かす手が
 * リネームしか無い。** `excerpt.ts` の `ListingBudget.omitted` が名指ししている
 * 「追記で育つ一覧の末尾が恒久的に落ちる」と同じ形で、クローンに取れる手が無い。
 *
 * 大きいほうから落とせば、落ちた文書に対して**取れる手が在る**——
 * `memory_section_move` で割る・付録を `fact` にする・要旨を短くする。しかも
 * その手は {@link describeMemoryTidyTargets} が既に名指ししている的と一致する。
 *
 * **⚠️ 代償を書いておく。いちばん大きい premise は、いちばん使っている前提でも
 * ありうる**（#772 の本番実測ではそれが `alteroid-work` だった）。だから断り書きの
 * 側で「要旨を削る方向へ倒すな」と言う（{@link renderPremiseBudgetNotice}）——
 * 落ちたのは索引であって、判断の前提そのものではない。
 *
 * ## 1枚も残らない形は作らない
 *
 * いちばん小さいカード1枚で予算を超えるときは、**その1枚は残す。**
 * `renderListing` の「1件だけで予算を超えるときはその1件を切って出す」と同じ
 * 倒し方である——0枚にすると「上限がある」と言えなくなる（`excerpt.ts`）。
 * 1文書あたりの予算（要旨 3,000 ＋ 節目次 6,000）が在るので実運用では起きない。
 */
function selectPremiseCards(
  parts: readonly MemoryPart[],
  seenContent: ReadonlyMap<string, string> | undefined,
  /**
   * カードの大きさを測るための描き手。**既定は `renderPremisePart`**（渡さない
   * 呼び手の出力は1文字も変わらない）。`indexed` を同じ蓋に入れるために、
   * 測る式をここへ外へ出してある——**測る側と描く側で別の関数を使うと、
   * 蓋が実際に載る量とは違う量を測る。**
   */
  render: (part: MemoryPart) => string = renderPremisePart,
): {
  kept: MemoryPart[];
  demoted: { part: MemoryPart; chars: number }[];
  /**
   * **蓋が無ければ premise の節が何文字だったか。** 断り書きが名乗るのはこの値で
   * ある（切ったあとの長さを名乗ると、超えたこと自体が出力から消える——
   * `excerpt.ts` の「切ったら、切ったことを必ず言う」）。
   *
   * **呼び手に計算させない。** ここで数えた値をそのまま返す——呼び手が同じ式を
   * 書き直すと、区切りの数え方が2本に割れて断り書きだけが静かにずれる
   * （`measureMemoryFloor` の doc と同じ理由）。
   */
  uncappedChars: number;
} {
  if (seenContent !== undefined) return { kept: [...parts], demoted: [], uncappedChars: 0 };

  const rendered = parts.map((part) => ({ part, chars: render(part).length }));
  const joinedChars = (count: number, sum: number): number =>
    count === 0 ? 0 : sum + MEMORY_SECTION_JOIN.length * (count - 1);
  const totalChars = joinedChars(
    rendered.length,
    rendered.reduce((sum, entry) => sum + entry.chars, 0),
  );
  if (totalChars <= MEMORY_PREMISE_CARD_BUDGET)
    return { kept: [...parts], demoted: [], uncappedChars: totalChars };

  // 小さいカードから詰める（⟹ 落ちるのは大きいほう）。同じ大きさなら slug で
  // 決める——**順序を入力の順に依らせないこと**（同じ記憶が呼びごとに違う
  // カードを落とすと、クローンは記憶が壊れたと読む）。
  const ascending = [...rendered].sort(
    (a, b) => a.chars - b.chars || a.part.slug.localeCompare(b.part.slug),
  );
  const keep = new Set<string>();
  let used = 0;
  for (const entry of ascending) {
    const next = joinedChars(keep.size + 1, used + entry.chars);
    if (keep.size > 0 && next > MEMORY_PREMISE_CARD_BUDGET) break;
    used += entry.chars;
    keep.add(entry.part.slug);
  }

  return {
    kept: parts.filter((part) => keep.has(part.slug)),
    demoted: rendered.filter((entry) => !keep.has(entry.part.slug)),
    uncappedChars: totalChars,
  };
}

/**
 * カードを落としたことの断り書き。**落とした事実・落とした分の名指し・開く口・
 * 直し方**の4つを出す。
 *
 * `excerpt.ts` の「切ったら、切ったことを必ず言う」をそのまま踏む。**そして
 * 続きの取り方を書けるのは呼び手の側にその口が実在するときだけ**という同じ doc の
 * 条件も満たしている——`memory_outline` / `memory_section_read` / `memory_read` は
 * どれも実在する道具である。
 */
function renderPremiseBudgetNotice(
  demoted: readonly { part: MemoryPart; chars: number }[],
  keptCount: number,
  totalChars: number,
  kindOf: (part: MemoryPart) => MemoryDocKind,
): string {
  const items = demoted.map((entry) =>
    renderPremiseStub(entry.part, entry.chars, kindOf(entry.part)),
  );
  const demotedPremise = demoted.filter((entry) => kindOf(entry.part) === 'premise').length;
  const demotedIndexed = demoted.length - demotedPremise;
  const listing = renderListing(items, {
    budget: MEMORY_PREMISE_STUB_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${formatMemoryCharCount(rest)} 件はこの一覧からも省略（全 ${formatMemoryCharCount(total)} 件のうち ` +
      `${formatMemoryCharCount(shown)} 件だけ出した）。全件は memory_list で取れる。`,
  });

  return [
    '<!-- memory: カードを落とした分（premise / indexed。文書は消えていない） -->',
    `⚠️ カード（premise と indexed）の合計が ${formatMemoryCharCount(totalChars)} 文字になり、` +
      `毎ターンの焼き込みの予算 ${formatMemoryCharCount(MEMORY_PREMISE_CARD_BUDGET)} 文字を超えた。` +
      `⟹ **大きいほうから ${formatMemoryCharCount(demoted.length)} 件のカードを落として1行にした**` +
      `（premise ${formatMemoryCharCount(demotedPremise)} 件 / indexed ${formatMemoryCharCount(demotedIndexed)} 件。` +
      `カードのまま載っているのは ${formatMemoryCharCount(keptCount)} 件）。` +
      '**落ちたのは節の目次と要旨の全文であって、文書そのものではない。**',
    listing,
    '**開く口**: memory_outline slug=<slug>（節の目次。side=tail で末尾も見える）→ ' +
      'memory_section_read（節の本文）。要旨の全文は memory_list / memory_read に在る。',
    '**直し方（どれか1つを実際にやること。読み流さない）**: ' +
      // **`indexed` にする手は、落ちたのが premise のときだけ出す。** 既に
      // `indexed` の文書へ「indexed にせよ」と言うと、クローンはそれを実行して
      // 床が1文字も下がらない（＝実行できない助言。`renderMemoryTocOmission` が
      // 「実行できない助言を出さない」として同じ線を引いている）。
      (demotedPremise > 0
        ? `(1) 上の premise ${formatMemoryCharCount(demotedPremise)} 件を memory_frontmatter_set で ` +
          'type: indexed にする——要旨だけが焼かれ、節の目次は焼かれなくなるので、' +
          'カード1枚が確実に小さくなる（節は memory_outline の q= / offset= で引ける）。'
        : '') +
      '(2) memory_section_move で割り、付録にした側を memory_frontmatter_set で fact にする' +
      (demotedIndexed > 0
        ? `——**上の indexed ${formatMemoryCharCount(demotedIndexed)} 件に残っている手はこれだけである。` +
          'すでに節の目次を手放しているので、type: indexed にしても1文字も下がらない。**'
        : '') +
      '。**⚠️ 要旨（description）を削る方向へ倒さないこと** —— 要旨は判断の前提そのもので、' +
      '落ちたのは索引のほうである。要旨を削ると、開く口はそのままなのに' +
      '「何が書いてあるか」を指す手掛かりだけが消える。',
  ].join('\n');
}

/**
 * `indexed` 1文書ぶんの描画。**`renderPremisePart` と同じ形**（`seen` が渡され、
 * 差分にする価値があるときだけ変わった範囲を描く）——`renderPremiseDelta` は
 * カードの行差分を取るだけの汎用関数なので、`indexed` のカードにもそのまま
 * 使える（名前が premise を名乗るが、中身は premise 固有ではない）。
 */
function renderIndexedPart(part: MemoryPart, seen?: string): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const card = renderIndexedCard(part);
  const delta =
    seen === undefined
      ? null
      : renderPremiseDelta(
          part.slug,
          renderIndexedCard({ slug: part.slug, content: seen }),
          card,
          scanMemorySections(part.content).sections,
        );
  const rendered = delta ?? card;
  return frontmatter.kind === 'malformed' ? `${MALFORMED_FRONTMATTER_NOTE}\n${rendered}` : rendered;
}

/**
 * `renderMemoryDocuments` と `measureMemoryFloor` の共有の下ごしらえ。
 *
 * **数え方を2本に割らないためだけに存在する。** 焼き込みの本体
 * （`renderMemoryDocuments`）と、その大きさだけを答える関数
 * （`measureMemoryFloor`）が別々に「premise を集めて全文にし、fact を
 * 集めて目次にする」処理を書くと、どちらか一方だけを直した瞬間に
 * メーターが実物と食い違う——ここへ1本にまとめ、両方がこれを呼ぶ。
 *
 * **`indexed` は3つ目の枝である**（2026-09-11）。premise・indexed のどちらも
 * カードとして描かれ（目次行にはならない）、`indexed` はそのカードから節の
 * 目次だけを省く。**`indexed` が1件も無い入力では、`indexedParts` は空配列、
 * `indexedSection` は空文字になり、下流（`joinMemorySections`）はそれを
 * 素通りするので出力は1文字も変わらない**（不変条件3）。
 */
function buildMemoryDocumentSections(
  documents: readonly MemoryPart[],
  presentInMemory?: readonly MemoryPart[],
  seenContent?: ReadonlyMap<string, string>,
): {
  premiseParts: MemoryPart[];
  premiseSection: string;
  /**
   * カードを落とした premise（{@link MEMORY_PREMISE_CARD_BUDGET}）。
   * **`premiseParts` の部分集合であって、そこから引かれてはいない**——落ちても
   * premise であることは変わらないので、区分の件数（`premiseDocs`）は動かさない。
   */
  demotedPremise: MemoryPart[];
  indexedParts: MemoryPart[];
  indexedSection: string;
  tocEntries: MemoryTocEntry[];
  tocSection: string;
} {
  const premiseParts: MemoryPart[] = [];
  const indexedParts: MemoryPart[] = [];
  const tocEntries: MemoryTocEntry[] = [];

  for (const doc of documents) {
    const frontmatter = parseMemoryFrontmatter(doc.content);
    const kind = resolveMemoryDocKind(frontmatter);
    if (kind === 'premise') {
      premiseParts.push(doc);
      continue;
    }
    if (kind === 'indexed') {
      indexedParts.push(doc);
      continue;
    }
    tocEntries.push({
      slug: doc.slug,
      title: doc.title ?? doc.slug,
      description: frontmatter.kind === 'parsed' ? frontmatter.description : undefined,
      descriptionFreshness: doc.descriptionFreshness ?? { kind: 'unknown' },
      parent: frontmatter.kind === 'parsed' ? frontmatter.parent : undefined,
    });
  }

  // **束ねた全体に蓋を掛ける**（{@link MEMORY_PREMISE_CARD_BUDGET}）。1文書あたりの
  // 予算だけでは文書数に対して線形に伸びる——`selectPremiseCards` の doc。
  // **蓋は premise と indexed の両方に掛ける。** indexed のカードを蓋の外に置くと、
  // 上限が「60,000 ＋ indexed の総量」に化けて、文書数に比例して伸びる穴が
  // `indexed` の側に開き直る（この蓋がまさに塞いだ形である）。**indexed のカードは
  // premise のカードより必ず小さい**（`MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET`）
  // ので、同じ蓋に入れても premise 側が不利になることは無い。
  const cardParts = [...premiseParts, ...indexedParts];
  const indexedSlugs = new Set(indexedParts.map((part) => part.slug));
  const renderCard = (part: MemoryPart, seen?: string): string =>
    indexedSlugs.has(part.slug) ? renderIndexedPart(part, seen) : renderPremisePart(part, seen);
  const { kept, demoted, uncappedChars } = selectPremiseCards(cardParts, seenContent, renderCard);
  const keptPremiseCards = kept
    .filter((part) => !indexedSlugs.has(part.slug))
    .map((part) => renderPremisePart(part, seenContent?.get(part.slug)));
  const keptIndexedCards = kept
    .filter((part) => indexedSlugs.has(part.slug))
    .map((part) => renderIndexedPart(part, seenContent?.get(part.slug)));
  const premiseSection =
    cardParts.length === 0
      ? ''
      : demoted.length === 0
        ? keptPremiseCards.join(MEMORY_SECTION_JOIN)
        : [
            ...keptPremiseCards,
            renderPremiseBudgetNotice(demoted, kept.length, uncappedChars, (part) =>
              indexedSlugs.has(part.slug) ? 'indexed' : 'premise',
            ),
          ].join(MEMORY_SECTION_JOIN);
  const indexedSection = keptIndexedCards.join(MEMORY_SECTION_JOIN);
  // 目次の外にも実在する slug を、**在り処ごとに分けて**渡す——`documents` は
  // 「記憶の全部」とは限らないので、ここで畳むと実在するものが「見つからない」
  // として出る（`renderMemoryTocIssue` の 'parent-not-listed' と
  // 'parent-not-rendered'）。**`indexed` も premise と同じくカードとして
  // 描かれる側なので、同じ集合へ合流させる**（`MemoryHierarchyElsewhere.renderedAsPremise`
  // の doc）——`indexed` が1件も無ければこの合流は premiseSlugs を1つも
  // 変えない（不変条件3）。
  const cardSlugs = new Set([...premiseParts, ...indexedParts].map((part) => part.slug));
  // `MemoryPresence` はここで1回だけ組み立てる（`buildMemoryPresence` の doc
  // どおり、`parentOf` の中身の解析はさらに遅延する——`presentInMemory` が
  // 渡されていても、循環検出が実際にこの描画の外へ出ない限り1文字も解析しない）。
  const presence = presentInMemory === undefined ? undefined : buildMemoryPresence(presentInMemory);
  const tocSection =
    tocEntries.length === 0
      ? ''
      : renderMemoryToc(tocEntries, { renderedAsPremise: cardSlugs, presentInMemory: presence });

  return {
    premiseParts,
    premiseSection,
    demotedPremise: demoted.map((entry) => entry.part),
    indexedParts,
    indexedSection,
    tocEntries,
    tocSection,
  };
}

/**
 * `renderMemoryDocuments` の任意引数。**記憶の一部だけを描く呼び手のためだけに
 * ある**（全体を渡す呼び手は何も渡さなくてよい）。
 */
export interface RenderMemoryDocumentsOptions {
  /**
   * **記憶（ストア）に実在する文書の全体。** `documents` に含まれる文書を
   * 含んでいてよい（選り分けは不要。`MemoryHierarchyElsewhere.presentInMemory`）。
   *
   * **型は「slug の集合」ではなく「文書そのもの」（`readonly MemoryPart[]`）。**
   * 循環の検出（`resolveMemoryHierarchy` の `detectCycle`）が記憶の全体を
   * 辿れるようにするには、在否（slug）だけでなく `parent`（frontmatter）まで
   * 引ける必要がある——渡し手は選り分けも変換もせず、手元の文書の配列を
   * そのまま渡せばよい（`MemoryPresence` への変換はこの関数の内側、
   * `buildMemoryPresence` が1回だけ行う。frontmatter の解析はそこでも遅延する）。
   *
   * 渡すと、`parent` が `documents` の外を指しているときに「見つからない」
   * （＝文書がそもそも無い）ではなく「在るが、ここに載せた分には含まれない」と
   * 出る。**渡さなければ出力は1バイトも変わらない。**
   */
  presentInMemory?: readonly MemoryPart[];

  /**
   * **クローンが既に見ている版**（slug → その時点の `content`）。
   * 載せ直す呼び手（`clone.ts` の `#withFreshMemory`）だけが渡す。
   *
   * 渡すと、premise は**全文ではなく変わった範囲だけ**が描かれる
   * （差分にする価値があるときだけ。`renderPremiseDelta`）。
   * **渡さなければ出力は1バイトも変わらない**——システムプロンプトへの
   * 焼き込みと `measureMemoryFloor`（床の測定）はどちらも渡さないので、
   * 「毎ターンの床」の値はこの引数の存在によって1文字も動かない。
   *
   * **`fact` には効かない。** fact はもともと目次の1行しか載らないので、
   * 差分にする余地が無い（`buildMemoryDocumentSections` は premise の枝でしか
   * これを見ない）。
   */
  seenContent?: ReadonlyMap<string, string>;
}

/**
 * 焼き込みの中で塊を繋ぐ区切り。**`premise` のカード同士・カードと断り書き・
 * `premise` の節と `fact` の目次の、3箇所すべてがこれを使う。**
 *
 * **リテラルで書き散らさない理由は、この区切りが予算の計算に入るからである。**
 * {@link selectPremiseCards} は「カードを1枚足したら全体が何文字になるか」を
 * 区切りぶんも含めて数える。⟹ 繋ぐ側と数える側で別のリテラルを持つと、
 * **蓋が予算をわずかに超えて通る**（`measureMemoryFloor` の doc「数え方を2本に
 * 割ると、どちらかだけを直したときにメーターが黙って嘘をつく」と同じ形）。
 */
const MEMORY_SECTION_JOIN = '\n\n';

/**
 * 区分ごとの節を、実際に焼き込む1本の文字列へ繋ぐ。**可変長の引数を取る**
 * （2026-09-11 に `indexed` の節を挟むため2引数から3引数対応へ拡張した）。
 * 空文字の節は素通りするので、`indexed` を1件も持たない入力では出力が
 * 従来と1バイトも変わらない（不変条件3）。
 *
 * **区切りは {@link MEMORY_SECTION_JOIN} である**——繋ぐ側と数える側で別の
 * リテラルを持つと蓋が予算をわずかに超えて通る（直上の doc）。
 */
function joinMemorySections(...sections: readonly string[]): string {
  return sections.filter((section) => section.length > 0).join(MEMORY_SECTION_JOIN);
}

/**
 * 記憶をクローンの文脈へ載せる、唯一の入口。
 *
 * **区分ごとに載り方を変える**（4-1「B. 区分と載せ方」。`indexed` は
 * 2026-09-11 に追加した3つ目の区分）:
 * - `premise`（判断の前提。既定でもある） — **要旨と節の目次**
 *   （`renderPremiseCard`）。本文は `memory_section_read` で節id を指して開く
 * - `indexed`（特定のプロジェクトでしか使わない記憶） — **要旨だけ**
 *   （`renderIndexedCard`）。節の目次は焼かれない——節を確かめるにはまず
 *   `memory_outline` を呼ぶ必要がある（premise は焼き込みにある目次から
 *   節id をそのまま拾えるが、`indexed` にはその近道が無い）
 * - `fact`（事実と蓄積） — **目次の1行だけ**。本文は `memory_read` で開く
 *
 * **⚠️ かつてここは「`premise` は全文。切り詰めない（切り詰めた前提は『持って
 * いない前提』と区別できない）」だった。人間が実測を見たうえで反転させた**
 * （2026-09-08。経緯と数は `renderPremiseCard` の doc）。**本文が消えたのでは
 * なく、開く口が別に在る**（`memory_section_read`）——「切り詰め」ではないと
 * 言えるのはその口が在るからで、**口を消したらこの載せ方は能力の削除になる。**
 *
 * **どの文書も、カードか目次行かの「どちらか一方」に必ず現れる**（二重に
 * 載せない・取りこぼさない）。文書の順序は呼び手（ストア）が決めた順
 * そのまま（`premise` は slug 昇順のまま連結、`fact` は目次側で
 * 階層・slug 昇順に並べ直す）。
 *
 * frontmatter を1つも持たない文書の集合（`kind: 'none'` のみ）に対しては、
 * 全件が `premise` に分類される——**区分の既定は変えていない。** ただし
 * `premise` の載り方そのものが全文からカードへ変わったので、**「frontmatter
 * 導入前と1バイトも変わらない」はもう成り立たない**（かつてここに在った
 * 受け入れ基準は、人間が載せ方を反転させた時点で意味を失った。歯も同じ
 * 理由で書き換えてある）。
 *
 * ## ⚠️ `documents` が「記憶の全部」でない呼び方がある
 *
 * 上の不変条件（どの文書も全文か目次行のどちらか一方に必ず現れる）は、**記憶の
 * 全体を渡したときの約束である。** `clone.ts` の `#withFreshMemory` は
 * **変わった文書だけ**を渡す——そのとき「渡されなかった文書」は上にも下にも
 * 現れない。**その状態を「存在しない」と報告しないために、部分だけを渡す呼び手は
 * `options.presentInMemory` に記憶の全体の文書を渡すこと**（渡さないと、親が
 * 今回変わっていないだけで「親 X が見つからない」と出る）。
 *
 * ## ⚠️ `options.seenContent` を渡すと premise が全文でなくなる
 *
 * 上の「`premise` は全文。切り詰めない」は、**`seenContent` を渡さない呼び手に
 * 対する約束である。** 渡した呼び手（載せ直し）には、変わった範囲だけが返る
 * ——省いた側は必ず行数と文字数で名乗る（`renderPremiseDelta`）。
 *
 * **これは「切り詰め」ではない。** 切り詰めは「全体を渡すつもりで一部を落と
 * す」ことで、落ちた分が読み手から見えなくなる。こちらは**渡す集合そのものが
 * 「今回変わった範囲」**であり、変わっていない側は同じ文脈の別の場所
 * （システムプロンプトの「現在の記憶」）に全文で載っている。
 */
export function renderMemoryDocuments(
  documents: readonly MemoryPart[],
  options: RenderMemoryDocumentsOptions = {},
): RenderedMemory {
  const { premiseSection, indexedSection, tocSection } = buildMemoryDocumentSections(
    documents,
    options.presentInMemory,
    options.seenContent,
  );
  return brandRenderedMemory(joinMemorySections(premiseSection, indexedSection, tocSection));
}

/**
 * 「記憶の肥大」を測る——毎ターン焼き込みへ実際に載る分量。
 *
 * **`renderMemoryDocuments` と同じ下ごしらえ（`buildMemoryDocumentSections`）を
 * 共有する。** 数え方を2本に割ると、どちらかだけを直したときにメーターが
 * 黙って嘘をつく（このファイル冒頭の見出しの話と同じ形の前科——器ごとに
 * 別々に書いていた載せ方が実際に食い違った）。
 *
 * **`totalChars` は `renderMemoryDocuments(documents).length` と厳密に一致する
 * ことを歯で固定する。** 一致を「たぶん同じ」で済ませない——`joinMemorySections`
 * を両方から呼ぶことで、実装として一致を強制する。
 *
 * **単位は文字（`String.length`）であって bytes ではない。** self_status が
 * 総文字数と文書ごとの bytes を混在させていたことで、依頼者は実際に bytes から
 * 文字数を割り戻して読んでいた——ここで bytes を返すと、対策自身がその誤りを
 * 再生産する。
 *
 * **各 premise の文字数は `content.length` ではなく `renderPremisePart` の
 * 結果の長さで数える**（`tools.ts` の「クローンの文脈へ実際に載る形で数える」と
 * 同じ理由——malformed な frontmatter は説明の1行が前に付くので、`content` だけ
 * を足すと実物より少ない数を「毎ターンの床」として名乗ることになる）。
 */
export function measureMemoryFloor(documents: readonly MemoryPart[]): MemoryFloor {
  const {
    premiseParts,
    premiseSection,
    demotedPremise,
    indexedParts,
    indexedSection,
    tocEntries,
    tocSection,
  } = buildMemoryDocumentSections(documents);
  const totalChars = joinMemorySections(premiseSection, indexedSection, tocSection).length;

  let largestPremise: { slug: string; chars: HeuristicChars } | null = null;
  for (const part of premiseParts) {
    const chars = renderPremisePart(part).length;
    if (largestPremise === null || chars > largestPremise.chars) {
      largestPremise = { slug: part.slug, chars: heuristicChars(chars) };
    }
  }

  let largestIndexed: { slug: string; chars: HeuristicChars } | null = null;
  for (const part of indexedParts) {
    const chars = renderIndexedPart(part).length;
    if (largestIndexed === null || chars > largestIndexed.chars) {
      largestIndexed = { slug: part.slug, chars: heuristicChars(chars) };
    }
  }

  return {
    premiseChars: heuristicChars(premiseSection.length),
    indexedChars: heuristicChars(indexedSection.length),
    tocChars: heuristicChars(tocSection.length),
    totalChars: heuristicChars(totalChars),
    premiseDocs: premiseParts.length,
    indexedDocs: indexedParts.length,
    factDocs: tocEntries.length,
    demotedPremiseDocs: demotedPremise.length,
    largestPremise,
    largestIndexed,
  };
}

// ---------------------------------------------------------------------------
// 一覧（`memory_list` / `GET /memory` / CLI / Web が使う。全区分を対象にする）
// ---------------------------------------------------------------------------

/** `memory_list` 等の一覧に出す1件。`MemoryDocumentMeta` はこれを満たす。 */
export interface MemoryListingEntry {
  slug: string;
  title: string;
  kind: MemoryDocKind;
  description: string | undefined;
  descriptionFreshness: MemoryDescriptionFreshness;
  parent: string | undefined;
  updatedAt: string;
  createdAt: MemoryCreatedAt;
}

/**
 * 記憶の一覧を人間可読な形にする（`memory_list` ツールの出力）。
 *
 * **プロンプトへ焼き込む目次（`renderMemoryDocuments` の TOC 節）とは別物。**
 * あちらは `fact` だけを対象にする（`premise` は全文で載っているので二重に
 * 載せない）が、こちらは**全区分を対象にする**——一覧はクローンが「何が
 * あるか」を把握するための道具であり、`premise` の文書も一覧には出ている
 * べきである（全文がどこかに焼かれていることと、一覧に載ることは別の話）。
 *
 * 階層の組み立て（循環・存在しない親の扱い）は目次と同じ実装を共有する。
 *
 * **上限は件数ではなく文字数で持つ。** ここが無上限だったあいだ、
 * `MEMORY_TOC_ENTRY_LIMIT` はプロンプトへ焼く目次（`renderMemoryToc`）にだけ
 * 効いていて、同じものを返す道具（`memory_list`）は全件を返していた。
 *
 * そして**件数だけでは足りない。** 300件 × 1行200字で 60,000 字になり、
 * `manager_list` が実際に溢れた 52,997 字を超える。件数から出力量を決めると
 * 何件で壊れるかが運任せになる——だから他の一覧（`journal_read` /
 * `manager_list` / `approvals_list` / `schedule_list` / `runner_list`）と
 * 同じ `renderListing` を通し、**文字数の予算**で締める。
 */
export function renderMemoryListing(entries: readonly MemoryListingEntry[]): string {
  if (entries.length === 0) return '（記憶はまだ空）';

  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const tocEntries: MemoryTocEntry[] = entries.map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    description: entry.description,
    descriptionFreshness: entry.descriptionFreshness,
    parent: entry.parent,
  }));
  const flat = flattenMemoryToc(resolveMemoryHierarchy(tocEntries));

  const items = flat.map((node) => {
    const meta = bySlug.get(node.entry.slug);
    const indent = '  '.repeat(node.depth);
    const kindTag = meta === undefined ? '' : `[${meta.kind}] `;
    // ラベルの語彙・順序（`作成: … / 更新: …`）は `manager_list` / `schedule_list`
    // に既に在るもの（`tools.ts`）と揃えてある——同じ人間の依頼（id + 名前 + 概要 +
    // updated_at + created_at）に対する3本目の一覧なので、ここだけ違う言い方を
    // 発明しない。
    const updatedAt =
      meta === undefined
        ? ''
        : ` (作成: ${formatMemoryCreatedAt(meta.createdAt)} / 更新: ${meta.updatedAt})`;
    const descriptor =
      node.entry.description === undefined
        ? ''
        : ` — ${memoryFreshnessMarker(node.entry.descriptionFreshness)}${excerptLine(node.entry.description, MEMORY_TOC_LINE_LIMIT)}`;
    return `${indent}- ${kindTag}${node.entry.slug}: ${node.entry.title}${updatedAt}${descriptor}${renderMemoryTocIssue(node)}`;
  });

  return renderListing(items, {
    budget: MEMORY_LISTING_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${rest} 件は省略（記憶は全 ${total} 件あり、${shown} 件だけ出した）。` +
      '狙った文書が出ていなければ memory_read slug=<slug> で直接開けること。',
  });
}

// ---------------------------------------------------------------------------
// memory_write / memory_append の応答に添える差分の要約（#318 案 (d)）
// ---------------------------------------------------------------------------

/**
 * なぜ要るか。
 *
 * クローンが `memory_write` で全文を再生成するとき、ツール呼び出しの
 * 中で本文を作り直す。その本文が途中で切れても、記憶には控えも履歴も
 * 無いので突き合わせる相手が存在しない——だからクローンは全文置換を
 * 安全に選べない。ここは「そもそも切れない」ようにするものではなく、
 * **切れたことにその場で気づけるようにする**ものである。
 *
 * `memory_append` にも同じ要約を付ける。追記も、追記しようとした文字列
 * そのものがツール呼び出しの中で切れれば、足りない分は静かに失われる。
 * ただし append は既存を消さないので、「消えた見出し」は理屈のうえでは
 * 常に 0 件のはずである——0 件でないなら append の異常（呼び手のバグや
 * ストア側の想定外の挙動）を疑う根拠になる。
 *
 * **この「常に」が何に依っているかを書いておく（#354）。** 依っているのは
 * 「消さない」ことではなく、**追記が `before` を*行の境界を保ったまま*
 * 前置きすること**である。`PersonaStore.append` の実装が
 * `${existing.content}${content}`（あいだに改行を挟まない形）になると、
 * **末尾の行が見出しだった文書でその見出しが追記の1行目と融合し、消えた
 * 見出しとして名指しされる**——`tsc` は落ちず、説明文（`memory_append`）
 * だけが静かに嘘になる。
 *
 * **実装は3つ在るので、歯も3つに置いてある**（1つを測って3つとも測った
 * ことにしない）: `tools.test.ts`（`testing.ts` のインメモリ実装。道具の
 * 応答まで通す）・`packages/storage-fs/src/index.test.ts`・
 * `packages/storage-pg/src/index.test.ts`。**fs と pg は書き込みのたびに
 * 本文を `ensureTrailingNewline` に通すので二重に守られており、`append`
 * 側の連結だけを壊しても落ちない**（#354 の変異試験で実測した）。
 * **単一点なのは `testing.ts` のインメモリ実装だけである。**
 *
 * **単位は文字数で統一する**（`content.length`）。日誌の `bytesBefore` /
 * `bytesAfter`（バイト）はそのまま——機械可読な面はバイト、人が読む面は
 * 文字という既にある二重構造（`memory_delete` の「削除直前 N 文字」と
 * 同じ軸）を壊さない。バイトと文字を1つの文に混ぜない。
 *
 * **本文そのものは載せない**（AGENTS.md「秘密の扱い」）。載せるのは
 * 見出しの文字列と数だけである。
 */

/** 消えた見出しの列挙を切るときの予算（文字数）。`renderListing` と同じ規律。 */
export const MEMORY_MISSING_HEADINGS_BUDGET = 600;

function formatMemoryCharCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** 増減の文字数。0 以上には `+` を付け、符号を持たない生の数と区別する。 */
function formatMemoryCharDelta(delta: number): string {
  return delta >= 0 ? `+${formatMemoryCharCount(delta)}` : formatMemoryCharCount(delta);
}

/**
 * Markdown の ATX 見出し（行頭の `#` 〜 `######`）を抜き出す。
 *
 * **行頭に限る。** 行の途中に `#` があるだけの行（インラインの `#`）は
 * 見出しではない——ここを緩めると、本文中の `#` がすべて「見出し」として
 * 数えられてしまう。
 *
 * ## ⚠️ 過剰に拾う側へ「意図して」倒してある（#354）
 *
 * この関数を呼ぶのは `missingMemoryHeadings` だけで、そこでの誤りは2方向
 * にしか出ない。**その2つは対称ではない。**
 *
 * | 誤りの向き               | 何が起きるか                                                                     |
 * | ------------------------ | -------------------------------------------------------------------------------- |
 * | **拾いすぎ（偽陽性）**   | 見出しでないものが「消えた見出し」に名指しされる。呼び手が余分に1つ確かめて済む  |
 * | **拾い漏れ（偽陰性）**   | 本物の見出しが消えたのに「消えた見出し: なし」と返る。**その場で気づく手段が無い** |
 *
 * 差分の要約が在る理由は「全文置換で本文が途中で切れたことに**その場で**
 * 気づく」ことだけで、記憶には控えも履歴も無い（`describeMemoryWriteDiff`
 * の doc）。**見落としたらそこで終わる。** だから拾いすぎを受け入れて
 * 拾い漏れを潰す側へ倒す。**これは #338 の実装がたまたまそうなっていた
 * 向きを、意図として固定したものである（#354）。**
 *
 * ### 次に触る人へ — 以下は欠陥ではない。「直す」と検出器が弱くなる
 *
 * - **コードフェンス（```` ``` ````）の中を除外していない。** フェンスの中の
 *   `# コメント`（シェル・設定ファイルの例）も見出しとして数える。**除外する
 *   実装を足さないこと** — フェンスの開閉が非対称な本文（**途中で切れた本文が
 *   まさにそうなる**）ではフェンスの内外を見誤り、そこから先の本物の見出しを
 *   丸ごと落とす。**この検出器がいちばん働くべき入力で、いちばん壊れる。**
 * - **setext 見出し（`===` / `---` の下線）は数えていない。** こちらは逆向きの
 *   拾い漏れで、上の方針からは足すほうが正しい。足していないのは、`---` が
 *   frontmatter の閉じと同じ形で、区別に本文全体の文脈が要るからである。
 *   **限界として道具の説明文（`memory_write` / `memory_append`）にも書いてある**
 *   ので、足すならそちらも直すこと。
 *
 * **単位は文字（`content.length`）である。** 日誌の `bytesBefore` /
 * `bytesAfter` はバイトで、別物である（`describeMemoryWriteDiff` の doc の
 * 「バイトと文字を1つの文に混ぜない」）。
 *
 * ### ⚠️ ただし「見落とす側」の限界が1つ在る。ここではなく呼び手にある
 *
 * この関数の倒し方（拾いすぎる側）だけを読んで「見落としは無い」と結論
 * しないこと。**`missingMemoryHeadings` は見出しを集合で比べるので、同じ
 * 見出しが他所に残っていれば節を丸ごと消しても検出されない**——向きが逆の
 * 限界で、そちらの doc に実測ごと書いてある（#354）。
 */
function extractMemoryHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push(`${match[1]} ${match[2]}`);
  }
  return headings;
}

/**
 * `before` に在って `after` に無い見出しを、重複を畳んで返す（出現順）。
 *
 * 見出しは集合として比べる——同じ見出しが `before` に複数回出ていても、
 * `after` のどこかに1つでも残っていれば「消えた」とは数えない。
 *
 * ## ⚠️ この設計が生む見落とし（#354）
 *
 * 直上の1文は**挙動**であって、**その結果どういう見落としが起きるか**を
 * 言っていない。言うとこうなる:
 *
 * > **同じ見出しが文書の他所に1つでも残っていれば、その見出しの節を
 * > 丸ごと消しても「消えた見出し: なし」が返る。**
 *
 * 実測（この2関数をそのまま走らせたもの）:
 *
 * ```
 * before の見出し: ["# 私について","### だから","## 経歴","### だから"]
 * after  の見出し: ["# 私について","### だから","## 経歴"]
 * missingMemoryHeadings = []      // ← 2つ目の「### だから」の節が丸ごと消えている
 * ```
 *
 * **これは `extractMemoryHeadings` の doc に在る限界とは向きが逆で、その
 * ぶん重い。** あちらは拾いすぎる（偽陽性）側だが、こちらは**見落とす
 * （偽陰性）側**である。この場合に残る手がかりは、同じ行に並ぶ文字数の
 * 増減（`describeMemoryWriteDiff`）だけになる。
 *
 * ## それでも集合で比べる——直さないこと
 *
 * **多重度を保つ形（`### だから` が2回 → 1回なら1件消えたと数える）へ
 * 変えないこと。** 同じ見出し（`### だから` のような定型の小見出し）を
 * 何度も使う記憶では、**多重度を見ると誤検出のほうが増える**——節の並べ
 * 替えや統合のたびに「消えた」が鳴り、鳴りっぱなしの警報は読まれなく
 * なる。**#338 のレビューで承認された設計判断であって、欠陥ではない。**
 *
 * 限界のほうは道具の説明文（`memory_write` / `memory_append`）にも書いて
 * あるので、ここを変えるならそちらも直すこと。**歯は `tools.test.ts` に
 * 在り、この見落としを「仕様」として固定している**（反転しに来ないこと）。
 *
 * **偽陽性と偽陰性のどちらへ倒してあるかの全体像は `extractMemoryHeadings`
 * の doc に在る。** ここを厳しくする変更は、そちらを読んでからにすること。
 */
function missingMemoryHeadings(before: string, after: string): string[] {
  const beforeHeadings = extractMemoryHeadings(before);
  const afterHeadings = new Set(extractMemoryHeadings(after));
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const heading of beforeHeadings) {
    if (afterHeadings.has(heading)) continue;
    if (seen.has(heading)) continue;
    seen.add(heading);
    missing.push(heading);
  }
  return missing;
}

function describeMemoryHeadingDiff(before: string, after: string): string {
  const missing = missingMemoryHeadings(before, after);
  if (missing.length === 0) return '消えた見出し: なし。';
  return [
    `消えた見出し（${formatMemoryCharCount(missing.length)} 件）:`,
    renderListing(
      missing.map((heading) => `- ${heading}`),
      {
        budget: MEMORY_MISSING_HEADINGS_BUDGET,
        omitted: ({ rest, shown, total }) =>
          `…ほか ${rest} 件は省略（消えた見出しは全 ${total} 件のうち ${shown} 件だけ出した）。`,
      },
    ),
  ].join('\n');
}

/**
 * `memory_write` / `memory_append` が成功したときに返す差分の要約。
 *
 * `before` は書き込み前の本文（無ければ `null`）、`after` は書き込み後の
 * 本文（ストアが返した実際の値——呼び手が計算し直さない）。
 *
 * **新規作成（`before === null`）は「前」が無いので、増減ではなくそう
 * 分かる形にする。** 見出しの比較も行わない（比べる相手が無い）。
 */
export function describeMemoryWriteDiff(before: string | null, after: string): string {
  if (before === null) {
    return `新規作成（${formatMemoryCharCount(after.length)} 文字）。`;
  }
  const delta = after.length - before.length;
  const charLine = `${formatMemoryCharCount(before.length)} → ${formatMemoryCharCount(after.length)} 文字（${formatMemoryCharDelta(delta)}）`;
  return [charLine, describeMemoryHeadingDiff(before, after)].join('\n');
}

/**
 * `N` から `M` へ動いたことを、矢印（`→`）を使わずに言う。
 *
 * **`describeMemoryWriteDiff` は矢印を使うのに、なぜここは使わないのか。**
 * `tools.test.ts`（`memory_write` の新規作成の歯）に
 * `expect(reply).not.toContain('→')` が固定で在り、これは「新規作成には
 * 『前』が無いので増減の矢印が出ない」ことを測る歯である。`describeMemoryFloor`
 * は新規作成のときも（premise が新規作成された場合は特に強く）床の遷移を言う
 * ——同じ応答に矢印を持ち込むと、上の歯が「新規作成なのに増減の表現がある」を
 * 誤って撃つ。**両立できないので、ここだけ矢印を使わない側へ倒した。**
 */
function formatMemoryFloorTransition(beforeChars: number, afterChars: number): string {
  const delta = afterChars - beforeChars;
  return (
    `${formatMemoryCharCount(beforeChars)} 文字から ${formatMemoryCharCount(afterChars)} 文字へ` +
    `（${formatMemoryCharDelta(delta)}）`
  );
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答の末尾に添える、「毎ターンの床」の一言。
 *
 * **`describeMemoryWriteDiff` とは別の関数である。** あちらは4口が共有していて
 * 出力を `tools.test.ts` が78件の `expect(reply)` で逐語に固定しているため、
 * 機能を足せば全部を壊す。こちらは追加の1行として応答の末尾に足すためだけに
 * 存在する。
 *
 * 言うことは3つ:
 * 1. 書いた文書の区分（`premise` / `fact`。書いた**後**の区分）
 * 2. 焼き込み全体の文字数が `before.totalChars` → `after.totalChars` へ
 *    どう動いたか（文字。`renderMemoryDocuments(documents).length` と一致する値。
 *    **`stores.persona.documents()` をいま読み直した値であることを短く名乗る**
 *    ——`read()` から `write()` までの間に人間が `PUT /memory/:slug` で
 *    書き換える窓があり、ここに出る値と次のターンに実際に焼かれる量が
 *    一致しない可能性があるため。`self_status` が既に採っている形
 *    「記憶の大きさ（いま stores.persona を読み直した値）」に揃える）
 * 3. **`premise` を新規作成したときだけ**、それが「毎ターン要旨と節の目次が焼かれる」
 *    ことを1行で言う——premise の新規作成は稀である（習慣化しない）ので、
 *    ここだけ他の枝より明確に強い言い方にしてある。**この枝にはさらに2つ
 *    足す**（依頼者の決裁。#318 の議論で「線が無くても、稀にしか出ない枝には
 *    置ける」とされた手当てを、稀にしか出ないこの枝へ畳んだもの）:
 *    - **いま最大の premise を名指しする**（`after.largestPremise`。書いた
 *      直後の状態で「どこを見ればよいか」にその場で答える——依頼者はまさに
 *      これが無くて詰まった。`about-me-core` を作った夜、応答は文字数だけ
 *      だった）
 *    - **縮めるのに全文置換は要らないこと**と、その3手順の道具名
 *      （`memory_outline` → `memory_section_move` → `memory_frontmatter_set`）
 *
 * ⛔ 既存の語「区分が変わった」（`memory_frontmatter_set` の `kindChangeNote`）を
 * 使い回さない。`tools.test.ts` に
 * `expect(reply).not.toContain('区分が変わった')`（type を変えなかったときの歯）
 * が固定であり、同じ語をここでも使うと、type を変えていない呼び出しでもこの
 * 関数が毎回その文字列を返すことになって歯を撃つ。
 *
 * ## ⚠️ 「毎回出る行」の限界（doc に書く条件で採用された）
 *
 * `created` が `false`（既存文書への追記・上書き・frontmatter 変更・節の
 * 移動）のときも、この行は出る。**この行は毎回出るので読み飛ばされる。それでも
 * 置くのは、参照値がその場に在ることに価値が在るから。これは行動を変える
 * 機構ではない。** 行動を変えるのは、稀にしか出ない側（新規作成・区分の変更・
 * 線を越えたとき）である。**「効かない場面」をここに書かずに入れると、次に
 * 読む人は「対策済み」と読む——だから書く。**
 *
 * **⚠️ 上の2要素（最大の premise・3手順）を `fact` の新規作成や `created === false`
 * の枝へは足さないこと。** あの枝を強くしている理由は「premise の新規作成は
 * 稀だから習慣化しない」であり、全部の枝に足すと稀ではなくなる——毎回出る側は
 * 「効かない機構」のままにしておく（直上の限界のとおり）。
 */
export function describeMemoryFloor(input: {
  before: MemoryFloor;
  after: MemoryFloor;
  slug: string;
  kind: MemoryDocKind;
  created: boolean;
}): string {
  const { before, after, slug, kind, created } = input;
  const transition = formatMemoryFloorTransition(before.totalChars, after.totalChars);
  // **蓋が噛んでいるあいだ、床の増減だけを読むと嘘になる**（`MemoryFloor.demotedPremiseDocs`
  // の doc）。premise を足しても別のカードが落ちて釣り合うので、増減はほとんど動かない。
  // ⟹ 噛んでいる回はそれを同じ行で名乗る。**噛んでいない回は1文字も出さない**
  // （毎回付けると、本当に噛んだときの目印が効かなくなる——`memory_read` と同じ倒し方）。
  const demotedNote =
    after.demotedPremiseDocs === 0
      ? ''
      : `⚠️ premise のカードは束ねた予算 ${formatMemoryCharCount(MEMORY_PREMISE_CARD_BUDGET)} 文字に当たっていて、` +
        `${formatMemoryCharCount(after.demotedPremiseDocs)} 件が1行に落ちている。` +
        '⟹ **この増減は蓋が効いた後の値である**（premise を足しても、別のカードが落ちて釣り合う）。' +
        '落ちた文書の名前と直し方は焼き込みの断り書きに在る。';
  const floorLine = `毎ターンの床（焼き込み全体。いま読み直した値）: ${transition}。` + demotedNote;

  if (created && kind === 'premise') {
    const lines = [
      `⭐ 新規作成: ${slug}（区分: premise）。`,
      floorLine,
      '⚠️ premise は毎ターン「要旨＋節の目次」がクローンの文脈へ焼かれる（本文は載らない）。' +
        '節の本文は memory_section_read で開く。要旨と見出しは短く保つこと。',
    ];
    const largest = after.largestPremise;
    if (largest !== null) {
      lines.push(
        `いま最も大きい premise: ${largest.slug}（${formatMemoryCharCount(largest.chars)} 文字）。`,
      );
    }
    lines.push(
      '縮めるのに全文置換は要らない: memory_outline で節を確かめ、' +
        'memory_section_move で付録の文書へ移し、memory_frontmatter_set でその付録を fact にする。',
    );
    return lines.join('\n');
  }

  const actionLabel = created ? '新規作成' : '更新';
  return `${actionLabel}: ${slug}（区分: ${kind}）。\n${floorLine}`;
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答に添える、「**この書き込みによって、次の
 * ターンの会話へ載る見込みの文字数**」の一言（P2、#318 の続き）。
 *
 * ## `describeMemoryFloor`（毎ターンの床）とは別の量である——置き換えない
 *
 * `describeMemoryFloor` が答えるのは「記憶全体が**毎ターン**焼き込まれ
 * **続ける**総量」（before/after は書き込み前後の記憶全体のスナップショット）。
 * こちらが答えるのは、`clone.ts` の `#withFreshMemory` がこの書き込みの
 * 結果として**次の1ターンだけ**会話へ差分として載せ直す量
 * （`renderMemoryDocuments(changed)`）——載った塊はその後会話の履歴として
 * 残り続けるので、毎ターンの床（前者）とは別の現象である。**2つの数を
 * 混ぜないよう、呼び手はこの関数の戻り値を `describeMemoryFloor` の行に
 * 続けて足すだけにし、どちらの行かは文言そのもので区別できるようにする**
 * （`floorLine` は「毎ターンの床」、こちらは「次のターンの会話へ載る見込み」
 * と名乗る）。
 *
 * ## 計算は `renderMemoryDocuments` そのもの——数え方を2本に割らない
 *
 * `渡された文書（群）をそのまま同じ純粋関数（`renderMemoryDocuments`）に
 * 通した文字数を返す。**区分で結果が変わることが要点である**——`premise`
 * なら全文、`fact` なら目次1行ぶんしか返らない。`measureMemoryFloor` が
 * 「後の床から逆算しない」のと同じ理由で、ここも `renderMemoryDocuments`
 * を再実装しない。
 *
 * ## 引数は「1回のツール呼び出しで変わった文書すべて」＋「書き込み後の記憶の全体」
 *
 * `memory_write` / `memory_append` / `memory_frontmatter_set` は1文書しか
 * 変えないので `[written]` の1要素配列を渡す。**`memory_section_move` だけ
 * 移動元・移動先の両方を「変わった文書」にする**——`#withFreshMemory` は
 * 次のターンにこの2つを**まとめて**載せ直すので、呼び手は両方を1回で
 * この関数へ渡すこと（`[toWritten, fromWritten]`）。
 *
 * **⚠️ ここが「合計」を選んだ理由。** 2文書ぶんを別々に
 * `renderMemoryDocuments([a])` / `renderMemoryDocuments([b])` で測って
 * 単純に足すと、`joinMemorySections` が挟む区切り文字（premise 同士なら
 * `\n\n`）のぶんだけ実物より少なく出る——**2本の render を足したもの**と
 * **2文書をまとめて1回 render したもの**は同じ値にならない。だから
 * ここは2文書をまとめて1回だけ `renderMemoryDocuments` に通し、**単一の
 * 合計**として返す（内訳は文書ごとの区分を並べて示す）。
 *
 * **`memoryAfter`（第2引数）は `renderMemoryDocuments(parts, { presentInMemory:
 * memoryAfter })` へそのまま渡す。** 呼び手4箇所（`tools.ts`）は書き込み
 * **後**に `stores.persona.documents()` を読み直した値をもう手元に持っている
 * （`memoryFloorNote` / `memorySessionGrowthNote` に渡しているのと同じ変数
 * `memoryAfter`）——**ここで改めてストアを読み直さない**（依頼者の門3
 * 「クローンの呼び出し回数に比例する費用を足さない」）。
 *
 * ## 第3引数（`seenContent`）— 「クローンが既に見ている版」
 *
 * `#withFreshMemory` は**変わった範囲だけ**を載せるので、見込みも同じ計算に
 * 揃える必要がある（`renderMemoryDocuments` の `options.seenContent`）。
 * 呼び手4箇所は**この書き込みの直前の内容**をもう手元に持っている
 * （`describeMemoryWriteDiff` へ渡している `before` と同じ値）ので、それを
 * そのまま渡す。
 *
 * **⚠️ 「直前の内容」と「クローンが実際に見ている版」は、いつも同じではない。**
 * クローンが見ているのは**前回の載せ直しの時点の内容**であり、同じターンの
 * 中で同じ文書を2回書き換えれば、2回目の呼び出しが渡す `before` は1回目の
 * 結果＝クローンがまだ見ていない版になる。そのとき実物（次のターンに載る量）
 * のほうが**多い**。これは下の「他に何も変わらなければ」という既存の条件の
 * 一形態であって、新しく生まれた限界ではない——**ただし向きは覚えておくこと。
 * ずれるときは必ず「見込みのほうが小さい」側へずれる。**
 *
 * **`undefined` を許さず、空の `Map` を渡させる形にしていない**のは
 * `memoryAfter` と同じ理由である（省略できる形にすると、渡し忘れが黙って
 * 「全文」寄りの大きい数へ倒れる。そちらは安全側だが、**実物と食い違った
 * まま気づけない**——見込みは実物と一致することにしか価値が無い）。
 *
 * ## ⚠️ これは予測であって実測ではない（依頼者の明示条件）
 *
 * 1. **「他に何も変わらなければ」という条件付きである。** ここで返す数は
 *    「このツール呼び出しで変わった文書（群）だけが変わった」という前提で
 *    計算している。**同じターンの中でこれ以外の文書も変われば、次の
 *    ターンにはそれも合わせて載る**——書き込みごとに出るこの数を機械的に
 *    合算して「次のターンに載る総量」を求めないこと（同じ文書を同じ
 *    ターンで複数回書き換えた場合は特に、後の呼び出しが返す数はその文書の
 *    最終状態の全部を含むので、前の呼び出しぶんまで足すと二重に数える）。
 * 2. **`memory_section_move` は移動元と移動先の両方を「変わった文書」に
 *    する。** 直上のとおり、ここでは両方をまとめた**合計**を1つの数で返す
 *    （別々に出す選択肢もあったが採らなかった——理由は直上）。
 * 3. **`memoryAfter` は「この呼び出しの時点でのスナップショット」である。**
 *    `read()` から `write()` までの間に人間が `PUT /memory/:slug` で別の
 *    文書を書き換える窓が理屈のうえでは在る（`describeMemoryFloor` の同種の
 *    注意と同じ）。次のターンが始まるまでにさらに記憶が動けば、そのぶんは
 *    この数に入らない——これは1の「他に何も変わらなければ」の条件そのもの
 *    であって、`memoryAfter` を渡したことで新しく生まれた限界ではない。
 *
 * ### ⭐ 直っていたもの: `presentInMemory` を渡していなかった欠落（#618 の続き）
 *
 * **これは以前ここに書かれていた「範囲外」の1つだった。** 第2引数
 * （`memoryAfter`）が無かった頃、この関数は「今回書いた文書」しか持たず、
 * 記憶の全体を知らなかった。書いた文書が **fact で、その `parent` が今回の
 * 書き込みに含まれない**ときだけ、実際に載る印（「在るが、ここに載せた分には
 * 含まれない」146+32=178文字級）より短い印（「見つからない」146文字級）で
 * 数えることになり、**数十文字（実測32文字）少なく出ていた**。`memoryAfter`
 * を必須の第2引数にし、`renderMemoryDocuments` へ `presentInMemory` として
 * そのまま渡すことで、書く側（この関数）と読む側（`clone.ts` の
 * `#withFreshMemory`）が同じ「記憶の全体」を見て同じ印を選ぶようになった
 * ——この一致は `clone-memory-injection.test.ts` の通しの歯（道具の応答から
 * 見込み文字数を取り出し、次のターンに実際に載る塊の文字数と突き合わせる）
 * で固定してある。
 *
 * ## ⚠️ 引数を必須にしてある理由（第2引数も含む）
 *
 * **`memoryAfter` は optional にしていない。** `renderMemoryDocuments` 自身の
 * `options.presentInMemory` が optional なのとは事情が違う——あちらは「記憶の
 * 全体を渡す呼び手（システムプロンプトへの焼き込み・`memory_list`）が正当に
 * 省略する」ための optional だが、こちらの4呼び手はどれも書き込み**後**に
 * `stores.persona.documents()` を読み直した値をすでに手元に持っており、
 * 省略する正当な理由が無い。**省略できる形にすると、渡し忘れが黙って
 * 「見つからない」寄りの短い数へ倒れる**（この関数がいままさに踏んでいた
 * 欠落そのもの）。必須にして `tsc` に強制させることで、渡し忘れを実行時では
 * なくビルド時に落とす（依頼者の門4「黙って効かなくなる形を作らない」）。
 *
 * **空配列を渡されても `throw` しない。** 呼び手が書き込みの成功
 * **後**にここを呼ぶ以上、`memoryAfter` が空になるのは「ストアが記憶を
 * 1件も返さなかった」という異常時だけで、直下の `parts` の非空タプルほど
 * 型で防げる性質のものではない。**空を渡すと `presentInMemory` を渡さな
 * かったのと同じ挙動になるだけ**（`renderMemoryDocuments` の既定）で、
 * 直下の `throw`（`parts` が空のとき）とは扱いが違う——`parts`
 * の空は呼び手の実装誤りだが `memoryAfter` の空はストアの状態そのものであり、
 * ここで投げると「記憶は書けているのに応答がエラーになる」形になって
 * 二重書きを誘発する（直下の「なぜ空を渡しても投げっぱなしにしてよいのか」と
 * 同じ理由）。**いまの4呼び手が実際に空を渡すことは起こりえない**
 * （`stores.persona.documents()` は書き込み直後の呼び出しなので、書いた
 * 文書自身が最低1件返る）。
 *
 * ## ⚠️ `parts` を非空タプルにしてある理由（P3 の同乗、#318）
 *
 * 呼び手4箇所（`tools.ts` の `memory_write` / `memory_append` /
 * `memory_frontmatter_set` / `memory_section_move`）は**全部、書き込みが
 * 成功した後にこれを呼ぶ。** だから空配列を渡す呼び手は構造的に存在しない
 * ——それを型で表すため、引数を `readonly [MemoryPart, ...MemoryPart[]]`
 * （非空タプル）にしてある。**直下の `throw` は残す**——型を迂回した
 * 呼び手（`as unknown as` 等）への最後の砦であって、正しく型を通る4箇所が
 * ここへ来ることは無い。
 *
 * **なぜ空を渡しても投げっぱなしにしてよいのか。** 呼び手が書き込みの
 * 成功**後**にここを呼ぶので、ここで投げると「記憶は書けているのに応答が
 * エラーになる」形になる。クローンはそれを「書けなかった」と読んで
 * 二重に書きうる（`memory_append` なら本文が二重になる）。**⟹ 空を渡し
 * うる呼び手を新しく足すなら、投げる前に握り潰す側へ倒すかを再検討する
 * こと。** いまの4呼び手は配列リテラル（`[written]` / `[toWritten, fromWritten]`）
 * なので、この型変更で1文字も直す必要が無い——空を作りようがない形で
 * 呼んでいる。
 */
export function describeMemoryReinjectionEstimate(
  parts: readonly [MemoryPart, ...MemoryPart[]],
  memoryAfter: readonly MemoryPart[],
  seenContent: ReadonlyMap<string, string>,
): string {
  if (parts.length === 0) {
    throw new Error('describeMemoryReinjectionEstimate: parts が空（呼び手の実装誤り）');
  }

  const chars = renderMemoryDocuments(parts, {
    presentInMemory: memoryAfter,
    seenContent,
  }).length;
  const kindOf = (part: MemoryPart): MemoryDocKind =>
    resolveMemoryDocKind(parseMemoryFrontmatter(part.content));
  // **「全文」か「変わった範囲だけ」かは、実際に描いてみて決まる**
  // （`renderPremiseDelta` は差分にする価値が無ければ全文へ倒れる）。
  // ラベルを別の判定で作らない——判定を2本に割ると、片方だけ直したときに
  // 内訳が黙って嘘をつく（`measureMemoryFloor` と同じ形の前科）。
  const labelOf = (part: MemoryPart): string => {
    const kind = kindOf(part);
    if (kind === 'fact') return 'fact・目次1行';
    const seen = seenContent.get(part.slug);
    return seen !== undefined &&
      renderPremiseDelta(
        part.slug,
        renderPremiseCard({ slug: part.slug, content: seen }),
        renderPremiseCard(part),
        scanMemorySections(part.content).sections,
      ) !== null
      ? 'premise・カードの変わった範囲だけ'
      : 'premise・カード（要旨＋節の目次）';
  };
  const breakdown = parts.map((part) => `${part.slug}（${labelOf(part)}）`).join(' + ');

  const subjectLabel =
    parts.length === 1
      ? 'この書き込み'
      : `この移動（${parts.map((part) => part.slug).join(' と ')} の合計）`;

  const lines = [
    `${subjectLabel}が次のターンの会話へ載る見込み: ${formatMemoryCharCount(chars)} 文字（${breakdown}）。`,
    '⚠️ これは予測であって実測ではない。「他に何も変わらなければ」という前提が付く' +
      '——同じターンで他の文書も変われば、次のターンにはそれも合わせて載るので、' +
      '書き込みごとに出るこの数を単純に合算しないこと。',
  ];
  if (parts.length > 1) {
    lines.push(
      'memory_section_move は移動元と移動先の両方を「変わった文書」にするため、' +
        'この数は両方の合計である（別々の値を足したものではなく、renderMemoryDocuments へ' +
        '両方まとめて渡した結果——区切り文字のぶんの誤差が乗らない）。',
    );
  }
  return lines.join('\n');
}

/** `formatMemoryCharDelta` の百分率版。1桁で丸める。 */
function formatMemoryPercentDelta(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return '0%'; // `-0` を含む（`Object.is(-0, 0)` は false だが `-0 === 0` は true）。
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答に足す、「セッション構築時点からの増分」の
 * 一言（P3、#318 の続き）。
 *
 * ## なぜ「セッション構築時点」を基準にするのか（依頼者の逐語）
 *
 * 「私が実際に毎ターン払っているのは組み立て時点の値である（畳んでも
 * 追記しても、いま走っているセッションが払う額は変わらない）。⟹ そこ
 * からの差は『次にセッションが組み立て直されたら、いくらになるか』を
 * 意味する。⟹『前回の書き込みから』だと、その意味を持たない。」
 *
 * だから比較の相手は「1つ前の書き込み」でも「セッション開始の壁時計」でも
 * なく、`CloneRuntimeFacts.injectedMemoryChars`
 * （このセッションのシステムプロンプトへ実際に焼き込まれた文字数。
 * セッションの間は固定 — `clone.ts` の `#promptMemoryChars` の doc）。
 *
 * ## `injectedMemoryChars` が引けないとき（依頼者が事後に承認した代替）
 *
 * `ToolContext.runtime` はテストのためだけに省略できる口で、本番の配線
 * （`clone.ts` の `#toolContext` / `#distillFromTranscript`）は本セッションと
 * 蒸留のサイドクエリの両方へ必ず渡す——両方とも `#runtimeFacts()` を経由し、
 * `injectedMemoryChars` は `#buildOptions` がセッションを開く時点で確定
 * するので、この4口のどのハンドラが呼ばれる時点でも既に値が入っている
 * （`self_status` が同じ値を「システムプロンプトへ焼き込んだ記憶の文字数」
 * として出しているのと同じ経路）。
 *
 * **それでも呼び手が `runtime` を渡さない場合に備え、黙って0や現在値へ
 * 倒さない。** `injectedMemoryChars` が `null` のときは「いま読み直した
 * 総量」を出すが、**それがセッション構築時点との差ではないことを文言に
 * 明記する**——依頼者の条件そのもの（「黙って別の数に差し替えない
 * でほしい。どちらの数かで、意味が変わる」）。
 *
 * ## 閾値を置かない（依頼者の明示条件）
 *
 * ここは「増えた／減った／変わらない」という事実だけを言う。「畳め」
 * 「危ない」に相当する語は使わない——判断はクローンが下す
 * （`docs/north_star.md` が要求する形）。
 *
 * ## ⚠️ 増分が 0 のときに「増えた」と読める文言を出さない
 *
 * `formatMemoryCharDelta` は 0 に `+` を付けるが、それをそのまま「増える」
 * という動詞に埋め込むと、変化が無いのに増加の文として読めてしまう。
 * ここでは delta === 0 のときだけ別の文（動詞を含まない）を返す
 * （歯: `tools.test.ts` の「増分が0のとき、増えたかのような文言を出さない」）。
 *
 * ## この機能が効くかどうかは未検証である（依頼者の明示指定）
 *
 * クローンは一度、同じ「毎ターンの床」の数を見ながら止まらなかった
 * （37,515 → 51,751 文字、+38%）。**⟹ 数を増やして見せることが、行動を
 * 変えるとは限らない。** この関数と `describeMemoryPremiseRanking` を
 * 足しても、それだけで記憶の肥大が止まる保証は無い——測っていない。
 */
export function describeMemorySessionDelta(input: {
  /** いま `stores.persona.documents()` を読み直した後の、焼き込み全体の文字数。 */
  afterChars: number;
  /**
   * `CloneRuntimeFacts.injectedMemoryChars`。引けないときは `null`
   * （直上の「引けないとき」を読むこと）。
   */
  injectedMemoryChars: number | null;
}): string {
  const { afterChars, injectedMemoryChars } = input;

  if (injectedMemoryChars === null) {
    return (
      `いまの記憶の総量（現在値）: ${formatMemoryCharCount(afterChars)} 文字。` +
      ' ⚠️ これはセッション構築時点との差ではなく現在値である' +
      '——セッション構築時点の値（`self_status` が「システムプロンプトへ焼き込んだ' +
      '記憶の文字数」として出す数）がこの呼び出しからは引けなかったため、' +
      '代わりに現在値だけを出している。'
    );
  }

  const label = '次に組み立て直されたら焼かれる量（セッション構築時点との差）';
  const delta = afterChars - injectedMemoryChars;

  if (delta === 0) {
    return (
      `${label}: セッション構築時点（${formatMemoryCharCount(injectedMemoryChars)} 文字）から` +
      '変わっていない。'
    );
  }

  const direction = delta > 0 ? '増える' : '減る';
  const percentNote =
    injectedMemoryChars === 0
      ? '（セッション構築時点が0文字だったため割合は出せない）'
      : `（${formatMemoryPercentDelta((delta / injectedMemoryChars) * 100)}）`;

  return (
    `${label}: セッション構築時点 ${formatMemoryCharCount(injectedMemoryChars)} 文字 → ` +
    `いま ${formatMemoryCharCount(afterChars)} 文字（${formatMemoryCharDelta(delta)} 文字` +
    `${percentNote}、${direction}見込み）。`
  );
}

/** `describeMemoryPremiseRanking` の一覧予算（文字数）。件数では切らない（AGENTS.md の地雷表）。 */
export const MEMORY_PREMISE_RANKING_BUDGET = 2_000;

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答に足す、「premise の大きさの順位」の一言
 * （P3、#318 の続き）。
 *
 * ## なぜ要るか
 *
 * `describeMemoryFloor` が名指しするのは「いま最も大きい premise」1件だけで、
 * しかも premise を新規作成した枝でしか出ない。それ以外の呼び出しでは
 * 「総量が動いた」しか見えず、**どの文書が大きいのか**が分からない——
 * 畳む判断に直接使える形にするには、全 premise の順位そのものが要る。
 *
 * ## サイズの数え方は `measureMemoryFloor` と揃える
 *
 * `content.length` ではなく `renderPremisePart` の結果の長さで数える——
 * malformed な frontmatter は説明の1行が前に付くので、`content` だけを
 * 足すと実物より少ない数を名乗ることになる（`measureMemoryFloor` の doc と
 * 同じ理由）。
 *
 * ## 一覧の上限は文字数で持つ（件数ではない）
 *
 * `renderListing`（`excerpt.ts`）を通し、切ったら省いた件数を必ず言う
 * （`.claude/skills/listing-and-detail/SKILL.md`。AGENTS.md の地雷表
 * 「一覧の上限を件数だけで決める」——300件 × 200字のような掛け算の見落としを
 * 避けるため、件数の上限は持たず文字数の予算だけで締める）。
 *
 * ## fact は対象にしない
 *
 * fact はプロンプトへ目次の1行しか載らない（`renderMemoryDocuments` が
 * 組む `tocSection`）ので、「どれが大きいか」の対象は premise だけである。
 *
 * ## 閾値を置かない・畳むことを勧めない
 *
 * 出すのは順位と文字数だけである。「これは大きすぎる」「畳め」に相当する
 * 語は使わない——`describeMemorySessionDelta` と同じ理由（判断はクローンが
 * 下す）。
 *
 * ## この機能が効くかどうかは未検証である
 *
 * `describeMemorySessionDelta` の doc の「未検証」節を見よ——同じ限界が
 * ここにも当てはまる。
 */
export function describeMemoryPremiseRanking(documents: readonly MemoryPart[]): string {
  const { premiseParts } = buildMemoryDocumentSections(documents);
  if (premiseParts.length === 0) {
    return 'premise の大きさの順位: いま premise はまだ無い。';
  }

  const ranked = premiseParts
    .map((part) => ({ slug: part.slug, chars: renderPremisePart(part).length }))
    // 大きい順。同数なら slug 昇順（出力を決定的にする——同数の並びが
    // 呼ぶたびに入れ替わると、変わっていないのに差分に見える）。
    .sort((a, b) => b.chars - a.chars || a.slug.localeCompare(b.slug));

  const items = ranked.map(
    (entry, index) => `${index + 1}. ${entry.slug}: ${formatMemoryCharCount(entry.chars)} 文字`,
  );

  const listing = renderListing(items, {
    budget: MEMORY_PREMISE_RANKING_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${rest} 件は省略（大きい順に ${shown} 件だけ出した。全 ${total} 件。` +
      '残りは memory_list で確認できる）。',
  });

  return `premise の大きさの順位（大きい順、全 ${ranked.length} 件）:\n${listing}`;
}

/** 「棚卸しの的」の一覧の文字数の予算。件数ではない（`excerpt.ts` の約束）。 */
export const MEMORY_TIDY_TARGETS_BUDGET = 3_000;

/**
 * **いま毎ターンの焼き込みに収まっていない文書を名指しする。**
 *
 * ## なぜ要るか — 印はカードの中にしか無かった
 *
 * `renderPremiseCard` は、要旨が `MEMORY_PROMPT_DESCRIPTION_BUDGET` を超えた
 * ときと、節の目次が `MEMORY_PROMPT_OUTLINE_BUDGET` に入りきらなかったときに
 * ⚠ の1行を出す。**しかしそれは「その文書のカードの中」にしか無い。**
 *
 * ⟹ クローンが「どの文書を割ればよいか」を知るには、焼き込みを自分で
 * 読み返して ⚠ を探すしかなかった。tick の digest にも、書き込みの応答にも、
 * `self_status` にも、`memory_list` にも、**予算に当たった文書を名指しする
 * 情報は1つも無い**（実測 2026-09-08。全走査して確かめた）。
 *
 * **集計も無かった** ——「いま何件が当たっているか」を答える口が存在しない。
 *
 * ## 出すのは的と数だけである。「畳め」は言わない
 *
 * 判断（どれをどう割るか）はクローンが下す（`describeMemoryPremiseRanking` の
 * doc と同じ線。**閾値を置かない**）。ここが返すのは「予算に当たっている」
 * という**測れた事実**と、その文書の名前と数だけである。
 *
 * **⚠️ 当たっていないことは「小さい」ではない。** 予算は1文書ごとに掛かるので、
 * 全部が予算の下でも合計は大きくなりうる——だから総量（`measureMemoryFloor`）と
 * この一覧は**別に出す**（呼び手が両方を並べる）。
 */
export function describeMemoryTidyTargets(documents: readonly MemoryPart[]): string {
  const { premiseParts } = buildMemoryDocumentSections(documents);

  const targets: string[] = [];
  for (const part of premiseParts) {
    const frontmatter = parseMemoryFrontmatter(part.content);
    const description =
      (frontmatter.kind === 'parsed' ? frontmatter.description : undefined)?.trim() ?? '';
    const { sections } = scanMemorySections(part.content);
    const outlineChars = memorySectionLines(sections).join('\n').length;

    const reasons: string[] = [];
    if (outlineChars > MEMORY_PROMPT_OUTLINE_BUDGET) {
      reasons.push(
        `節の目次が ${formatMemoryCharCount(outlineChars)} 文字（予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字。全 ${formatMemoryCharCount(sections.length)} 節のうち末尾が焼き込みに載っていない）`,
      );
    }
    if (description.length > MEMORY_PROMPT_DESCRIPTION_BUDGET) {
      reasons.push(
        `要旨が ${formatMemoryCharCount(description.length)} 文字（予算 ${formatMemoryCharCount(MEMORY_PROMPT_DESCRIPTION_BUDGET)} 文字）`,
      );
    }
    if (reasons.length === 0) continue;
    targets.push(`- ${part.slug}: ${reasons.join(' / ')}`);
  }

  if (targets.length === 0) {
    return (
      '棚卸しの的: 毎ターンの焼き込みに収まっていない文書は無い。' +
      '**これは「記憶が小さい」ではない** —— 予算は1文書ごとに掛かるので、' +
      '全部が予算の下でも合計は大きくなりうる（総量は別の行で出る）。'
    );
  }

  const listing = renderListing(targets, {
    budget: MEMORY_TIDY_TARGETS_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${rest} 件は省略（全 ${total} 件のうち ${shown} 件だけ出した）。`,
  });

  return (
    `棚卸しの的（毎ターンの焼き込みに収まっていない文書。全 ${targets.length} 件）:\n${listing}\n` +
    '**ここに出た文書は、焼き込みで見えていない節が在る。** memory_outline' +
    '（side=tail で末尾も見られる）で節を確かめ、memory_section_move で付録の文書へ移すこと。'
  );
}

// ---------------------------------------------------------------------------
// 節（section）— memory_outline / memory_section_move（#318 案 (b)）
// ---------------------------------------------------------------------------

/**
 * 節1つ。**`start` / `end` は `content` そのものへの添字**（本文への相対では
 * ない）で、`start` は必ず `memoryBodyStart(content)` 以上である。
 *
 * `end` は排他——「同じ深さ以下の次の見出しの行頭」か、無ければ
 * `content.length`。だから**入れ子の子（`##` の下の `###`）は親の節に
 * 含まれる**し、切り取った文字列は必ず行の境界で始まり行の境界で終わる。
 */
export interface MemorySection {
  /** 節id（`memorySectionId` を読むこと）。 */
  id: string;
  /** 見出し行そのもの（改行を含まない生の1行）。 */
  heading: string;
  /** 見出しの深さ（`#` の数。1〜6）。 */
  depth: number;
  /** `content` の中での開始位置（見出し行の先頭）。 */
  start: number;
  /** `content` の中での終了位置（排他）。 */
  end: number;
  /** この節の文字数。**子込みである**（`end - start`）。 */
  chars: number;
}

/** `scanMemorySections` の戻り値。 */
export interface MemorySectionScan {
  /** 本文が始まる位置（`memoryBodyStart`）。frontmatter を添字で運ぶために要る。 */
  bodyStart: number;
  /** 見つかった節（文書に現れる順）。 */
  sections: MemorySection[];
}

/**
 * 節id。
 *
 * ```
 * 節id = <見出しの8桁> "-" <sha256(見出し行 + "\n" + その節の中身) の先頭8桁>
 * ```
 *
 * ## ⭐ この値の役割は2つある
 *
 * > **id は「指し先」であると同時に「版の照合」である。**
 *
 * **節の中身が変われば id が変わる。** ⟹ `memory_outline` で目次を読んでから
 * `memory_section_move` を呼ぶまでの間に、誰か（人間・統合の走行）がその節を
 * 書き換えていたら、**id が一致せず断られる。＝ 楽観的排他そのものである。**
 *
 * ### ⚠️ 不便さが機能である。「毎回変わるのは不便だから見出しベースへ」と直さないこと
 *
 * 見出しの文字列で指す形にすると、**書き換えを検出する材料が引数の中から
 * 消える**——同名の見出し（この repo の当事者の記憶には `### だから` が
 * 何度も出る。#366）で曖昧になるうえ、曖昧でないときですら「読んだときの
 * その節」と「いま動かそうとしているその節」が同じものだと言えなくなる。
 * **この id が毎回変わることは欠陥ではなく、この道具が持っている唯一の
 * 並行制御である。**
 *
 * ### そして他の節が変わっても id は変わらない
 *
 * ハッシュの材料はその節の見出し行と中身だけである。**文書全体のハッシュを
 * ETag にする形と違い、無関係な変更で誤検出しない**——人間が別の節に1行
 * 足しただけで移動が断られる、ということが起きない。歯（`tools.test.ts`）が
 * この2つを別々に固定している（当たり＝断る／誤検出しない＝通る）。
 *
 * ### ⚠️ 例外を1つ: 入れ子の子を動かすと、親の id は変わる
 *
 * `##` の中に `###` が在るとき、節の範囲は子を含む（上の
 * `MemorySection.end` の doc）。だから**子を移すと親の中身が実際に変わり、
 * 親の id も変わる。** これは正しい振る舞い（親の中身は本当に変わった）だが、
 * **呼び手は驚く**——目次を1回読んで2つの節を続けて移そうとすると、2つ目が
 * 「その id は古い」で断られる。目次を読み直すのが正しい手当てである。
 *
 * ## なぜ2つに分かれているのか（依頼の設計からの逸脱と、その理由）
 *
 * **後半8桁は設計そのもの**（`sha256(見出し行 + "\n" + 中身)` の先頭8桁）。
 * **前半8桁（`sha256(見出し行)` の先頭8桁）を足したのは、断りを2つに分けろ
 * という要求と、単一の不透明なハッシュが両立しないからである:**
 *
 * | 断り | 意味 | 判定 |
 * | --- | --- | --- |
 * | **そんな id は無い** | 打ち間違い／別の文書／見出しごと書き換えられた | 前半が1つも一致しない |
 * | **その id は古い** | 誰かが中身を書き換えた。読み直せ | 前半は一致するが後半が違う |
 *
 * 単一のハッシュだけを受け取ると、一致しなかったときに「見出しは一致するが
 * 中身のハッシュが違う」を**計算する材料が無い**（過去の中身を知らないと
 * 逆算できない）。前半を足しても、**中身まで完全に同一の節が2つ在れば
 * id は依然として衝突する**（曖昧さの明示という役目は失われていない）。
 */
export function memorySectionId(heading: string, body: string): string {
  const digest = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
  return `${digest(heading)}-${digest(`${heading}\n${body}`)}`;
}

/** 節の見出しとして数える ATX 見出しの行。 */
const SECTION_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * コードフェンスの開始／終了の行。行頭のインデントは3つまで許す（CommonMark）。
 */
const SECTION_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * `content` を節に切り分ける。**frontmatter は節ではない**（`memoryBodyStart`
 * より前は一度も見ない）。**最初の見出しより前の前書きも節ではない**——
 * 指す値が発行されないので、この道具では動かせない。
 *
 * ## ⚠️⚠️ 走査は2本である。`extractMemoryHeadings` と1本にまとめないこと
 *
 * この関数は**コードフェンスの中の `## X` を見出しとして数えない**。
 * `extractMemoryHeadings`（差分の要約が使う検出器）は**数える**。
 * **食い違っているのではなく、向きが逆だから2本在る:**
 *
 * | 使い道 | 拾いすぎるとどうなるか | 安全な倒れ先 |
 * | --- | --- | --- |
 * | **`extractMemoryHeadings`**（消えた見出しの検出器） | 誤検出が増える。呼び手が1つ余計に確かめて終わる。**見落とす側には倒れない** | **拾いすぎる側** |
 * | **この関数**（節の境界の決定器） | **フェンスが片方だけ残る。静かに壊れる** | **拾わない側** |
 *
 * 決定器が拾いすぎるとどうなるか、具体的に書く。フェンスの中の `## X` を
 * 「次の見出し」と読むと、その手前で節が終わる——**移した後、出どころの
 * 文書には開きの ``` だけが残り、そこから先が全部コードとして描かれる。**
 * しかも**文字数の増減は妥当な値のままなので、差分の要約は何も言わない。**
 *
 * **`extractMemoryHeadings` を「直し」に行かないこと。** そちらの doc には
 * PR #360 で「コードフェンスの中を除外する実装を足さないこと」が理由つきで
 * 書いてある（フェンスの開閉が非対称な本文＝まさに途中で切れた本文で内外を
 * 見誤り、**あの検出器がいちばん働くべき入力でいちばん壊れる**）。**この2本を
 * 1本にまとめる変更は、どちらの向きへ寄せても片方を壊す。** 意図として固定
 * するため、**同じ文書に対して片方は拾い片方は拾わないことを1つの `it()` で
 * 並べて assert する歯**が `tools.test.ts` に在る。
 *
 * フェンスの数え方: 行頭（インデント3つまで）の ` ``` ` または `~~~` を3つ
 * 以上。閉じるのは**同じ記号で、開いたときと同じ長さ以上で、後ろに情報文字列
 * が無い行**だけである。開いたまま文書が終わったら、そこまで全部フェンスの
 * 中とみなす（＝節の境界を作らない。**拾わない側へ倒す**）。
 */
export function scanMemorySections(content: string): MemorySectionScan {
  const bodyStart = memoryBodyStart(content);
  const body = content.slice(bodyStart);
  const lines = body.split('\n');

  // 行頭の絶対添字（`content` 基準）を先に作る。切り取りは添字で行うので、
  // 行の再結合（`join`）を通さない——通すと改行コードの扱いで1バイト動く。
  const lineStart: number[] = [];
  let offset = bodyStart;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }

  interface Open {
    depth: number;
    heading: string;
    start: number;
    bodyFrom: number;
  }
  const open: Open[] = [];
  const sections: MemorySection[] = [];
  let fence: { marker: string; length: number } | null = null;

  const close = (upTo: number, minDepth: number): void => {
    while (open.length > 0 && (open[open.length - 1] as Open).depth >= minDepth) {
      const entry = open.pop() as Open;
      const end = upTo;
      sections.push({
        id: memorySectionId(entry.heading, content.slice(Math.min(entry.bodyFrom, end), end)),
        heading: entry.heading,
        depth: entry.depth,
        start: entry.start,
        end,
        chars: end - entry.start,
      });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const fenceMatch = SECTION_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      const info = fenceMatch[2] as string;
      if (fence === null) {
        // ` ``` ` の情報文字列にバックティックは置けない（CommonMark）。
        // 置かれていたらフェンスではない＝ただの本文の行として扱う。
        if (!(marker.startsWith('`') && info.includes('`'))) {
          fence = { marker: marker[0] as string, length: marker.length };
          continue;
        }
      } else if (
        marker.startsWith(fence.marker) &&
        marker.length >= fence.length &&
        info.trim().length === 0
      ) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;

    const headingMatch = SECTION_HEADING_PATTERN.exec(line);
    if (!headingMatch) continue;
    const depth = (headingMatch[1] as string).length;
    const start = lineStart[index] as number;
    // 「同じ深さ以下の次の見出しの直前」で閉じる。**「同じ深さ」に狭めない**
    // ——`###` の節が次の `##` で終わらなくなり、子でないものを子として運ぶ。
    close(start, depth);
    open.push({
      depth,
      heading: line,
      start,
      bodyFrom: start + line.length + 1,
    });
  }
  close(content.length, 1);

  sections.sort((a, b) => a.start - b.start);
  return { bodyStart, sections };
}

/** `lookupMemorySection` の結果。**「無い」と「古い」を畳まない。** */
export type MemorySectionLookup =
  | { kind: 'found'; section: MemorySection }
  /** 中身まで同一の節が複数在り、この id では1つに決まらない。 */
  | { kind: 'ambiguous'; sections: MemorySection[] }
  /** 見出しは一致するが中身のハッシュが違う＝誰かが書き換えた。 */
  | { kind: 'stale'; sections: MemorySection[] }
  /** その id の節がこの文書に1つも無い。 */
  | { kind: 'absent' };

/**
 * 節id で節を1つに決める。
 *
 * **「どちらか」を選ばない。** 中身まで同一の節が2つ在るときは
 * `ambiguous` を返して呼び手に断らせる——片方を黙って選ぶと、**消える側が
 * 観測できない**（応答は「移した」としか言わないので、呼び手は取り違えに
 * 気づく手段を持たない）。
 *
 * **`stale` と `absent` を畳まない。** 疑う先が違う——前者は「誰かが書き
 * 換えた。読み直せ」、後者は「打ち間違いか、別の文書か、見出しごと書き
 * 換えられた」である。判定の材料は `memorySectionId` の doc に在る。
 */
export function lookupMemorySection(
  sections: readonly MemorySection[],
  id: string,
): MemorySectionLookup {
  const exact = sections.filter((section) => section.id === id);
  if (exact.length === 1) return { kind: 'found', section: exact[0] as MemorySection };
  if (exact.length > 1) return { kind: 'ambiguous', sections: exact };
  const headingKey = `${id.split('-')[0] ?? ''}-`;
  const sameHeading = sections.filter((section) => section.id.startsWith(headingKey));
  if (sameHeading.length > 0) return { kind: 'stale', sections: sameHeading };
  return { kind: 'absent' };
}

/**
 * 複数の節をまとめて切り取った後の `content` と、切り取った文字列を返す
 * （`memory_section_move` が1回で複数の節id を移せるようにするために足した。
 * 節が1個のときも同じ関数を通す——単体版は残していない。1節しか渡されない
 * 呼び出しは `sections` に1要素の配列を渡すだけでよく、実装を2本持つ理由が
 * 無い）。
 *
 * ## 組み立て
 *
 * 1. `sections` を **`start` の昇順に並べ替える**——呼び手が渡した順ではない
 *    （`memory_section_move` の `sections` 引数の doc「渡す順ではなく文書に
 *    現れる順」）。
 * 2. `nextContent` は範囲の**間**の slice を繋いで作る（先頭の節の前・
 *    節と節の間・末尾の節の後ろ）。
 * 3. `cut` は範囲の中身を**文書に現れる順**で繋ぐ。呼び手が逆順（後ろの
 *    節を先に）渡しても、移し先には元の文書に現れる順で並ぶ。
 *
 * **継ぎ足しであることは1節のときと変わらない。** `slice` を繋ぐだけで
 * `serializeMemoryFrontmatter` を一度も通さない。`section.start` は必ず
 * `memoryBodyStart(content)` 以上（`MemorySection` の doc）なので、
 * frontmatter のバイト列がどの節の範囲にも入らないことも変わらない
 * （`memoryBodyStart` の doc）。**それでも書き込み前に検査すること**——
 * この関数が正しいことと、次にここを触る人が組み直す形に変えないことは
 * 別である（`memory_section_move` の第3層。`tools.ts` を読むこと）。
 *
 * ## ⚠️ 並べ替えた列（`ordered`）も返す——並び順の所有権はここにある
 *
 * 呼び手（`memory_section_move`）は、移した節を応答の一覧に**文書順で**並べる
 * ためにこの並びを要る。そこで呼び手が自分でもう一度並べ替えると、**同じ規則が
 * 2箇所に立つ**——片方を壊しても、もう片方が結果を正しくしてしまうので、
 * 「渡す順ではなく文書順で並ぶ」という保証を変異で撃っても歯が1本も赤く
 * ならなくなる（実測 2026-09-08。変異試験で見つけた）。**規則を1箇所に置き、
 * 並べ替えの結果そのものを返して呼び手に使わせる。**
 *
 * ## ⚠️ 範囲が重ならないことは呼び手の責任である
 *
 * ここには重なりを検出する分岐を置いていない。重なった範囲を渡すと、
 * 昇順に並べた次の節の `start` が前の節の `end` より手前に来て、
 * 「間」の slice が負の範囲になったり同じ文字列を2回運んだりする——
 * その検出は `findOverlappingMemorySections` の仕事であり、
 * `memory_section_move` はこの関数を呼ぶ前にそちらで断る
 * （`tools.ts` を読むこと）。ここに同じ検査を重ねて置くと、片方を
 * 直したときにもう片方が古いままになる経路ができるので、重ねない。
 */
export function cutMemorySections(
  content: string,
  sections: readonly MemorySection[],
): { nextContent: string; cut: string; ordered: readonly MemorySection[] } {
  const ordered = [...sections].sort((a, b) => a.start - b.start);

  let nextContent = '';
  let cut = '';
  let cursor = 0;
  for (const section of ordered) {
    nextContent += content.slice(cursor, section.start);
    cut += content.slice(section.start, section.end);
    cursor = section.end;
  }
  nextContent += content.slice(cursor);

  return { nextContent, cut, ordered };
}

/**
 * 複数の節id を渡されたとき、範囲が重なっている組が無いかを確かめる
 * （`memory_section_move` が複数節を移す前の全件先出しの検査の一部）。
 *
 * `start` の昇順に並べ、**隣り合う組だけ**を見る。範囲が重ならないなら
 * ソート後は隣り合う組ごとに `prev.end <= next.start` が成り立つはずなので、
 * それが崩れた最初の組を返せば十分——3つ以上にまたがる重なりも、
 * どこかの隣り合う組で必ず引っかかる。重なりが無ければ `null`。
 *
 * ## 捕まえるのは2つの形
 *
 * 1. **親と子を同時に指した。** `MemorySection.end` は子込み（同じ深さ
 *    以下の次の見出しの直前まで）なので、親を切り取ると子も一緒に
 *    消える——気づかずに子の節id も渡していると、同じ節を実質2回
 *    動かす指示になる。
 * 2. **同じ節id を2回渡した。** `lookupMemorySection` で同じ節を指す
 *    id を2つ渡すと、範囲（`start` と `end`）が完全に一致するので、
 *    これも重なりとして拾われる。
 *
 * ## ⚠️ 兄弟（隣り合う節）は重なりではない
 *
 * 兄弟どうしは前の節の `end` が次の節の `start` に一致する
 * （`prev.end === next.start`）。ここでの判定は**厳密な** `next.start < prev.end`
 * なので、これは重なりとして拾われない。`<=` にすると、1つの見出しの
 * 下に並ぶ複数の兄弟節を一度に移すだけの正当な呼び出しまで断ることに
 * なる——複数の兄弟をまとめて移すのは複数節対応そのものの使い道なので、
 * ここを断る分岐は足さない。
 */
export function findOverlappingMemorySections(
  sections: readonly MemorySection[],
): { first: MemorySection; second: MemorySection } | null {
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1] as MemorySection;
    const next = sorted[index] as MemorySection;
    if (next.start < prev.end) return { first: prev, second: next };
  }
  return null;
}

/**
 * `memory_section_move` が応答に並べる「移した節の一覧」の文字数予算。
 *
 * **件数ではなく文字数で切る**——`MEMORY_OUTLINE_BUDGET` と同じ思想
 * （見出しの長さは節ごとにばらばらなので、件数で切ると出力量が見出しの
 * 長さ次第で暴れる。AGENTS.md の地雷表）。渡された節id が90個でも応答が
 * 際限なく伸びないための歯止めであり、ここで切れるのは**一覧の表示**
 * だけである——移動そのものは、この一覧を組む前に全件先出しの検査
 * （`findOverlappingMemorySections` を含む）を通って一括で終わっている
 * ので、「一覧から省略」であって「移動していない」ではない
 * （`tools.ts` の `memory_section_move` の doc）。
 */
export const MEMORY_SECTION_MOVE_LIST_BUDGET = 2_000;

/** 目次の予算（文字数）。件数では切らない（AGENTS.md の地雷表）。 */
export const MEMORY_OUTLINE_BUDGET = 8_000;

/**
 * 目次を文書の**どちら側**から詰めるか（`memory_outline` の `side`）。
 *
 * **落ちるのは常に反対側である。** `'head'`（既定）なら末尾側が落ち、
 * `'tail'` なら先頭側が落ちる。**行の並びはどちらでも文書順のままで、この値が
 * 変えるのは「予算に入らなかったときにどちらを捨てるか」だけである。**
 *
 * **これは窓（オフセット）ではない。** 予算は文字数なので何節入るかは見出しの
 * 長さで動き、「末尾の N 節」を添字で当てる材料は呼び手の手元に無い。⟹ 渡すのは
 * 向きだけにして、何節入るかは予算に決めさせる。
 *
 * **値の列挙をここ1箇所に置く。** `tools.ts` が `z.enum(MEMORY_OUTLINE_SIDES)` で
 * 同じ配列を引くので、増やしても道具の側の書き換えが要らない
 * （`z.enum(JOURNAL_ENTRY_TYPES)` と同じ形）。
 */
export const MEMORY_OUTLINE_SIDES = ['head', 'tail'] as const;

/** 目次を出す向き（`MEMORY_OUTLINE_SIDES` の doc を読むこと）。 */
export type MemoryOutlineSide = (typeof MEMORY_OUTLINE_SIDES)[number];

/**
 * `memory_outline` の応答本体。
 *
 * **本文は1文字も出さない**（`memory_delete` が本文を日誌へ写さない線と
 * 同じ。`tools.ts` の該当 doc）。出るのは節id・見出し行・文字数だけである。
 * **frontmatter の行も1つも出ない**（`scanMemorySections` が
 * `memoryBodyStart` より前を一度も見ないので、材料が存在しない）。
 *
 * インデントが見出しの深さを表す。文字数は**子込み**なので、
 * **移したときに動く量が、呼ぶ前に数字で分かる。**
 *
 * **中身まで完全に同一の節が2つ在ると id が衝突する。** そのときはその id の
 * 行に印を出す——黙って並べると、呼び手はどちらか一方を指したつもりで
 * 断られる理由が分からない。
 *
 * ## `side` — 予算で落とす側を選ぶ
 *
 * **`'tail'` は `renderListingFromEnd`（`excerpt.ts`）を通すだけである。** 向きが
 * 違うだけの予算のループは既にあちらに在り、断り書きを穴の空いた側（先頭）へ
 * 置くところまで持っている。ここに同じループを書き直さない。
 *
 * **⚠️ `side` 単独が言えないこと: 中央は、どちらの向きでも出ない。** 予算に
 * 入らない中間の節は `'head'` でも `'tail'` でも落ちる。**「末尾から出せる」は
 * 「全部見える」ではない。**
 *
 * **節id は `side` に依存しない。** 材料はその節の見出し行と中身だけである
 * （`memorySectionId`）ので、**どちら側を出したかで id は1文字も変わらない ＝
 * 版の照合は弱まらない。**
 *
 * ## `q` — 見出しで絞り込む（中央へ届く道その1）
 *
 * 大文字小文字を区別しない**部分一致**。渡された文字列は `String.includes`
 * にそのまま渡すので、正規表現としては解釈しない——メタ文字（`.` `*` `[` `(`
 * `\` など）を含んでいても、その文字どおりの並びとしてしか一致しない。
 *
 * 応答は必ず「全 N 節のうち M 節が一致」を言う。**一致0件と、一致はあるが
 * 予算で切れた場合は別の文言にしてある**——前者は「一致そのものが無い」で
 * あって「予算が足りない」ではない。混ぜると、絞り込み語を直せば直るのか
 * `offset` で窓をずらすしかないのかが読み手に伝わらない。
 *
 * `side` と併用できる（絞り込んだ結果を先頭から詰めるか末尾から詰めるか）。
 * 一致した行は目次の1行と同じ形（`[節id] 見出し — N 文字`）——そのまま
 * `memory_section_read` / `memory_section_move` へ渡せる。**中間の節でも、
 * 見出しに残る言葉さえ思い出せれば、この口で直接 節id に届く。**
 *
 * ## `offset` — 窓をずらす（中央へ届く道その2。完全な到達を保証する側）
 *
 * 先頭から `offset` 節を飛ばしてから予算を埋める。**`q` は「思い出せる言葉が
 * あるとき」の近道で、`offset` は「言葉を思い出せなくても、有限回の呼び出しで
 * 必ず全節へ届く」ほうの保証である**——窓の大きさ（応答が「続きは
 * offset=N で」と返す、その N）ぶんずつ進めれば、文書がどれだけ大きくても
 * 全節の節id に到達できる。`offset` を渡すと `side` は見ない——`offset` は
 * 「窓をどこから開けるか」の指定で、`side` は「窓の中で予算に入らない側を
 * どちらへ捨てるか」の指定であり、役割が違う（窓を開いた後で詰める向きが
 * 変わると、offset を進める歩幅の保証が崩れる）。範囲外の `offset`（節数以上）
 * は黙って空にせず、その旨を明示して断る。
 *
 * `q` と `offset` は併用できる——`offset` は「絞り込み後の並び」に対して窓を
 * 開く。
 *
 * **⚠️ `q` も `offset` も渡さないとき、出力は1文字も変えていない。** 以下の
 * 実装はまずこの分岐を独立させ、その中身を移設前と揃えてある。
 */
/**
 * 節の一覧の**1行の形**。目次を出す場所が2つ（道具の `memory_outline` と、
 * プロンプトへ焼く記憶のカード）あるので、**行の形の持ち主をここ1つにする。**
 *
 * **予算と省略の文言は共有しない。** どちらも「何文字まで載せてよいか」と
 * 「省いたときに何をすればよいか」が違う（道具は `side` で反対側を出せるが、
 * 焼き込みは1回しか描かない）。⟹ 共有するのは行の形だけで、切り方は呼び手が
 * 持つ（`.claude/skills/listing-and-detail/SKILL.md` の「予算は件数ではなく
 * 文字数で持つ」は呼び手ごとに効く）。
 */
function memorySectionLines(sections: readonly MemorySection[]): string[] {
  const counts = new Map<string, number>();
  for (const section of sections) counts.set(section.id, (counts.get(section.id) ?? 0) + 1);
  return sections.map((section) => {
    const indent = '  '.repeat(section.depth - 1);
    const ambiguous =
      (counts.get(section.id) ?? 0) > 1
        ? ' ⚠この id は複数箇所に当たる。この id では動かせない（memory_section_move は断る）'
        : '';
    return `${indent}[${section.id}] ${section.heading} — ${formatMemoryCharCount(section.chars)} 文字${ambiguous}`;
  });
}

/**
 * `memory_outline` の省略の断り書きに足す、予算についての注記。
 *
 * **head/tail の2箇所で書き分けず、ここ1つに集約してある。** 依頼者が
 * 実際にこの予算の値（8,000）を、別の予算（毎ターンの焼き込みの節目次、
 * `MEMORY_PROMPT_OUTLINE_BUDGET` = 6,000）の値だと取り違えて自分の記憶に
 * 書いた実例がある——**値も観測も正しく、誤っていたのは値の帰属だけ**
 * だった。だから「値を見せる」だけでは再発する。次の4つを**同時に**
 * 見せる。
 *
 * 1. **その値**（`MEMORY_OUTLINE_BUDGET`。定数から組み立てる——文字列へ
 *    直書きすると、値が動いたときに断り書きのほうが嘘をつく）
 * 2. **何を切る予算か**——「`memory_outline` の1回のツール応答」（MCP の
 *    出力上限のため）であって、「毎ターンの焼き込み」ではない。焼き込み側
 *    の予算は2つに分かれている——fact 全体を束ねた目次は
 *    `MEMORY_TOC_CHAR_BUDGET`、premise 1文書ぶんの節目次は
 *    `MEMORY_PROMPT_OUTLINE_BUDGET`（値も別なので、混同すると値まで違う）
 * 3. ⭐ **同じ数字を持つ別の記憶の予算の名前**——`MEMORY_LISTING_BUDGET`
 *    （`memory_list` の一覧の予算）。この2つは値がたまたま同じなだけで、
 *    切っている対象が違う（`memory_outline` は1文書の節を、`memory_list`
 *    は全文書を並べる）
 * 4. **族の名乗り**——この値は「1回のツール応答に何文字載せるか」
 *    （MCP の出力上限）という理由で、道具の応答を切る予算に共通して
 *    使われている値である。⟹ 3 で兄弟を1本（`MEMORY_LISTING_BUDGET`）
 *    だけ名指ししても、読み手が「これで全部」と誤読する余地が残る——
 *    同じ理由で同じ値を持つ予算は他にもある、という事実そのものを言う
 *    （個体名までは列挙しない。名指しの範囲を「記憶の予算」に限ったのは
 *    3 の判断のままで変えていない）
 *
 * **3つ目は値が一致しているときにしか真ではない。** `MEMORY_LISTING_BUDGET`
 * を直接比較して分岐する——将来どちらかの値だけが動いて一致が崩れても、
 * この関数は「一致しない」と正直に書く（黙って嘘の一致を言い続けない）。
 *
 * **4つ目は3つ目の分岐（値が一致するかどうか）と独立させ、必ず出す。**
 * `sibling` の2分岐のどちらかの中に書くと、その分岐が選ばれたときにしか
 * 出ない非対称が生まれる——`family` を別の変数として立て、`scope` /
 * `sibling` と並べて連結する。
 *
 * `memory_outline` 自身の応答は、ここでは「目次」と呼ばない。「目次」は
 * この repo で3つの別のものを指す（fact 全体の目次・premise の節目次・
 * この `memory_outline` の応答）——**取り違えの発端がまさにここだった**ので、
 * この注記の中でだけは道具名（`memory_outline`）または定数名で名指しする。
 */
function renderMemoryOutlineBudgetNote(): string {
  const value = formatMemoryCharCount(MEMORY_OUTLINE_BUDGET);
  const scope =
    `この ${value} 文字は、memory_outline の1回のツール応答を切る予算である` +
    '（MCP の出力上限のため）。毎ターン全員が払う焼き込みの予算——fact 全体の' +
    '目次（MEMORY_TOC_CHAR_BUDGET）や premise 1文書ぶんの節目次' +
    '（MEMORY_PROMPT_OUTLINE_BUDGET）——とは別の予算である。';
  const sibling =
    MEMORY_LISTING_BUDGET === MEMORY_OUTLINE_BUDGET
      ? `⚠ memory_list の一覧の予算（MEMORY_LISTING_BUDGET）もいま同じ ${value} 文字だが、` +
        '別の予算である（1文書の節を並べる予算と、全文書を並べる予算）。'
      : 'memory_list の一覧の予算（MEMORY_LISTING_BUDGET、いま ' +
        `${formatMemoryCharCount(MEMORY_LISTING_BUDGET)} 文字）とは値が一致しない` +
        '——一致していた時期があっても、いまは別の値である。';
  const family =
    `そして ${value} は「1回のツール応答に何文字載せるか」（MCP の出力上限）という理由で` +
    '道具の応答を切る予算に共通して使われている値であり、この数字だけではどの予算かは決まらない' +
    '——同じ理由で同じ値を持つ予算が他にもある。';
  return `${scope} ${sibling} ${family}`;
}

/**
 * `memory_outline` へ渡せるオプション。**`side` 単体・省略・`{}` のどれでも、
 * `q` と `offset` を1つも渡さなければ出力は移設前と1文字も変わらない。**
 * （下の `renderMemoryOutline` の分岐そのものが歯である——`q === undefined
 * && offset === undefined` のときは旧実装の式をそのまま評価する。）
 */
export interface MemoryOutlineOptions {
  /** 予算で落とす側（`MEMORY_OUTLINE_SIDES` の doc）。既定は `'head'`。 */
  side?: MemoryOutlineSide;
  /** 見出しの絞り込み（上のクラスdocの「`q`」節）。 */
  q?: string;
  /** 窓の開始位置（上のクラスdocの「`offset`」節）。0起点。 */
  offset?: number;
}

/**
 * `q` による見出しの絞り込み。
 *
 * **大文字小文字を区別しない部分一致。正規表現としては解釈しない。** 渡された
 * 文字列は `String.prototype.includes` へそのまま渡すので、`.` `*` `[` `(`
 * `\` のようなメタ文字を含んでいても、その文字どおりの並びとしてしか一致
 * しない——`RegExp` を経由しないので、壊れようがない。
 */
function filterMemorySectionsByHeading(
  sections: readonly MemorySection[],
  q: string,
): MemorySection[] {
  const needle = q.toLowerCase();
  return sections.filter((section) => section.heading.toLowerCase().includes(needle));
}

export function renderMemoryOutline(
  sections: readonly MemorySection[],
  sideOrOptions: MemoryOutlineSide | MemoryOutlineOptions = 'head',
): string {
  if (sections.length === 0) {
    return (
      '節が1つも無い（見出しが1つも無いか、最初の見出しより前の前書きしか無い）。' +
      '前書きは節ではないので memory_section_move では動かせない。'
    );
  }

  // **文字列（旧い呼び方）とオプション（新しい呼び方）の両方を受ける。**
  // 既存の呼び手（`renderMemoryOutline(sections, 'tail')` の形）を壊さない
  // ための後方互換であって、新しい呼び手が文字列を渡す理由にはならない。
  const options: MemoryOutlineOptions =
    typeof sideOrOptions === 'string' ? { side: sideOrOptions } : sideOrOptions;
  const side = options.side ?? 'head';
  const { q, offset } = options;

  // ============================================================
  // **`q` も `offset` も渡さないとき: 以下は移設前の実装そのものである。**
  // 1文字も変えていない——変えたのは「ここへ来る前に分岐したこと」だけ。
  // ============================================================
  if (q === undefined && offset === undefined) {
    const items = memorySectionLines(sections);
    // **どちら側を落としたかを言う。** 「N 節省略」だけだと続きの取り方を間違える
    // （`conversation_read` の中身モードが同じ理由で同じことをしている）。そして
    // **続きの取り方を書けるのは、呼び手の側にその口が実在するときだけである**
    // （`excerpt.ts` の `ListingBudget.omitted` の doc）——`side` を足したこの版で
    // 初めて、末尾側へ行く口が実在する。旧い文面の「先に上の節を減らす」は、
    // **末尾を指せないまま末尾を減らせ**と言っていた ＝ 到達できない助言だった。
    const render = side === 'tail' ? renderListingFromEnd : renderListing;
    const budgetNote = renderMemoryOutlineBudgetNote();
    return render(items, {
      budget: MEMORY_OUTLINE_BUDGET,
      omitted: ({ rest, shown, total }) =>
        side === 'tail'
          ? `…先頭 ${rest} 節は省略（節は全 ${total} 件あり、末尾から ${shown} 件だけ出した）。` +
            '先頭側は side を渡さずに呼べば出る（既定）。' +
            '⚠中央（どちらの端からも予算の外に出る節）は、どちらの向きでも出ない——' +
            '端の節を memory_section_move で移して文書を縮めれば、次に memory_outline を' +
            '呼んだときの応答にそれが載る。' +
            ` ${budgetNote}`
          : `…末尾 ${rest} 節は省略（節は全 ${total} 件あり、先頭から ${shown} 件だけ出した）。` +
            '末尾側の節id が要るなら side=tail で呼ぶこと。' +
            '⚠中央（どちらの端からも予算の外に出る節）は、どちらの向きでも出ない。' +
            ` ${budgetNote}`,
    });
  }

  // ============================================================
  // ここから先は `q` / `offset` のどちらか（または両方）が渡された経路。
  // 上のブロックとは完全に別の式なので、上のブロックの出力には1バイトも
  // 影響しない。
  // ============================================================

  // `q`: 見出しで絞り込む。絞り込んだ後の並び（`pool`）を、以降の offset /
  // side の材料にする。
  let pool = sections;
  let queryHeader = '';
  if (q !== undefined) {
    const matched = filterMemorySectionsByHeading(sections, q);
    if (matched.length === 0) {
      // **一致0件と、一致はあるが予算で切れた場合を混ぜない。** 前者は
      // 「一致そのものが無い」であって「予算が足りない」ではない——文言を
      // 変えれば当たるのか、offset で窓をずらすしかないのかが違う。
      return (
        `見出しに「${q}」を含む節は無かった（一致0件。全 ${formatMemoryCharCount(sections.length)} 節を検索した）。` +
        'これは予算で落ちたのではない——一致そのものが無い。'
      );
    }
    pool = matched;
    queryHeader =
      `見出しに「${q}」を含む節: 全 ${formatMemoryCharCount(sections.length)} 節のうち ` +
      `${formatMemoryCharCount(matched.length)} 節が一致した。`;
  }

  const budgetNote = renderMemoryOutlineBudgetNote();
  const scopeLabel = q !== undefined ? '絞り込み後' : '全';

  // `offset`: 窓をずらす。**常に先頭から詰める（`side` を見ない）。** offset は
  // 「窓をどこから開けるか」、side は「窓の中で入らない側をどちらへ捨てるか」
  // で役割が違う——ここで side を見てしまうと、offset を「窓の大きさぶんずつ
  // 進めれば有限回で全節に届く」という保証が、進み方が向きで変わることで崩れる。
  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      return `offset は0以上の整数で渡すこと（渡された値: ${offset}）。`;
    }
    if (offset >= pool.length) {
      return (
        `${queryHeader ? queryHeader + ' ' : ''}` +
        `offset=${offset} の位置に節は無い（${scopeLabel} ${formatMemoryCharCount(pool.length)} 節しか無い）。`
      );
    }
    const windowed = pool.slice(offset);
    const items = memorySectionLines(windowed);
    const { lines, shown } = fillListingBudget(items, MEMORY_OUTLINE_BUDGET, false);
    const endIndex = offset + shown; // 次に呼ぶべき offset そのもの。呼び手は算術をしない。
    const more = endIndex < pool.length;
    const rangeLine =
      `${formatMemoryCharCount(offset + 1)}〜${formatMemoryCharCount(endIndex)} 節目 / ` +
      `${scopeLabel} ${formatMemoryCharCount(pool.length)} 節のうち ${formatMemoryCharCount(shown)} 節を出した。`;
    const continuationLine = more
      ? `続きが在る。次は offset=${endIndex} で呼ぶこと` +
        '（窓の大きさぶんずつ進めれば、有限回で全節に届く）。'
      : '続きは無い（最後まで出した）。';
    return [queryHeader, rangeLine, continuationLine, budgetNote, ...lines]
      .filter((line) => line !== '')
      .join('\n');
  }

  // `q` だけが渡された経路。`side` で「絞り込んだ結果」を先頭から詰めるか
  // 末尾から詰めるかを選ぶ——offset と違い、ここでは向きに意味がある
  // （窓の開始点を固定していないため）。
  const items = memorySectionLines(pool);
  const { lines, shown } = fillListingBudget(items, MEMORY_OUTLINE_BUDGET, side === 'tail');
  const omittedCount = pool.length - shown;
  const shownLabel =
    side === 'tail'
      ? `そのうち末尾から ${formatMemoryCharCount(shown)} 節を載せた`
      : `そのうち先頭から ${formatMemoryCharCount(shown)} 節を載せた`;
  const remainderNote =
    omittedCount === 0
      ? '（全件を載せた）。'
      : side === 'tail'
        ? `（先頭側の ${formatMemoryCharCount(omittedCount)} 節は予算で省略。` +
          'offset を併用すればこの絞り込みの先頭側も出せる）。'
        : `（末尾側の ${formatMemoryCharCount(omittedCount)} 節は予算で省略。` +
          'side=tail か offset を併用すれば続きが出せる）。';
  return [`${queryHeader}${shownLabel}${remainderNote}`, budgetNote, ...lines].join('\n');
}
