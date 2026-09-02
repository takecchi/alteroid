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

import { excerptLine, renderListing } from './excerpt.js';
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
 */
export interface MemoryFloor {
  /** premise の全文が毎ターン焼かれる分の文字数。 */
  premiseChars: number;
  /** fact の目次が毎ターン焼かれる分の文字数。 */
  tocChars: number;
  /** 焼き込み全体の文字数。**`renderMemoryDocuments(documents).length` と必ず一致する。** */
  totalChars: number;
  premiseDocs: number;
  factDocs: number;
  /** 毎ターン最も大きい premise の1件（premise が無ければ null）。 */
  largestPremise: { slug: string; chars: number } | null;
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

const KNOWN_DOC_KINDS: ReadonlySet<MemoryDocKind> = new Set(['premise', 'fact']);

/**
 * `value` が既知の区分（`premise` / `fact`）かどうか。
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
 * 区分を解決する（frontmatter → `premise` | `fact`）。
 *
 * **区分が無い（`none`）・読めない（`malformed`）・`type` が既知の集合に
 * 無い値のときは、`fact` ではなく `premise` として扱う。** これが移行の
 * 安全弁である——frontmatter を1つも持たない文書（`none`）は全て `premise`
 * になるので、この改修をマージした直後は焼き込みが従来と完全に同じになる。
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
 * 要旨の鮮度を判定する。
 *
 * **代理指標である**（`MemoryDescriptionFreshness` の doc）。ここが言えるのは
 * 「`description` が最後の本文変更以降に変わったか」だけで、「本文を読み
 * 直して書き直したか」ではない。
 */
export function resolveMemoryDescriptionFreshness(input: {
  description: string | undefined;
  /** ストアの派生値。一度も観測できていなければ `undefined`。 */
  describedAt: string | undefined;
  updatedAt: string;
}): MemoryDescriptionFreshness {
  if (input.description === undefined) return { kind: 'absent' };
  if (input.describedAt === undefined) return { kind: 'unknown' };
  return input.describedAt >= input.updatedAt ? { kind: 'fresh' } : { kind: 'stale' };
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
 * `renderMemoryDocuments` の1つに閉じている（`store.ts:48-53` の「器は文字列を
 * 組み立てない」という契約を、`tsc` が守る側へ回すための釘）。実行時には
 * ただの `string` であり、ランタイムの挙動には一切影響しない。
 */
export type RenderedMemory = string & { readonly [RENDERED_MEMORY_BRAND]: true };

function brandRenderedMemory(text: string): RenderedMemory {
  return text as RenderedMemory;
}

// ---------------------------------------------------------------------------
// 目次（TOC）— 保存しない。毎回、文書そのものから組み立てる
// ---------------------------------------------------------------------------

/** 目次1行の長さの上限（1文書が目次を飲み込まないため。外部の値は持ち込まない。4-5）。 */
const MEMORY_TOC_LINE_LIMIT = 200;

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
 */
export const MEMORY_TOC_ENTRY_LIMIT = 300;

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
 * **4つを1つに畳まない。** どれも「親の行が上に無い」という同じ見た目になるが、
 * **読み手が次に見に行く先が違う**（`renderMemoryTocIssue` の doc）。畳むと、
 * いちばん多い状態（親は実在していて、この描画に載っていないだけ）が、いちばん
 * 怖い状態（文書がそもそも無い）の言葉で報告される。
 */
type MemoryTocIssue = 'missing-parent' | 'cycle' | 'parent-not-listed' | 'parent-not-rendered';

interface ResolvedTocNode {
  entry: MemoryTocEntry;
  depth: number;
  issue?: MemoryTocIssue;
  children: ResolvedTocNode[];
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
   * この目次の対象ではないが、**同じ描画の中に premise として全文が載って
   * いる** slug（渡し手は `buildMemoryDocumentSections`）。
   */
  renderedAsPremise?: ReadonlySet<string>;
  /**
   * **記憶（ストア）に実在する slug の全体。** この描画に含まれる slug を
   * 含んでいてよい——描画の中に在るかどうかは先に判定されるので、渡し手は
   * 「今回載せていないもの」を選り分けずに、手元の全体をそのまま渡せばよい
   * （選り分けを渡し手にやらせると、そこが2つ目の間違えどころになる）。
   *
   * **渡さなければ（既定は空集合）この状態は起こりえない**——記憶の全体を
   * 渡している呼び手（システムプロンプトへの焼き込み・`memory_list`）の
   * 出力を1バイトも変えないための既定値である。
   */
  presentInMemory?: ReadonlySet<string>;
}

/**
 * 親子関係を解決し、木にする。**循環と、存在しない親を指す `parent` を
 * 黙って落とさない**（4-1「階層は『それ自体が目次である文書』で作る」）。
 *
 * - 親が存在しない slug を指す → ルート扱いにし、`issue: 'missing-parent'`
 * - 親をたどると自分自身に戻る（循環） → ルート扱いにし、`issue: 'cycle'`
 * - 親はこの `entries`（目次の対象）には無いが、`knownElsewhere` には在る
 *   → ルート扱いにし、`issue: 'parent-not-listed'`
 *
 * どれも文書自体は消えない——ルートとして目次に残り、印がつく。
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
 * ## ⚠️ 循環の検出は、いまも `entries` の中だけで閉じている
 *
 * `elsewhere` が運ぶのは **slug の集合**であって、`parent` の対応表ではない。
 * だから「循環の一部が `entries` の外を通る」形（a → b → c → a で c だけが
 * 差分に無い）は `cycle` として検出できず、`parent-not-rendered` に落ちる。
 * **これは「無い」と言い切る誤りではない**（親は実際に在り、実際にこの描画に
 * 載っていない）が、**言えるはずのことを言えていない。** 直すには記憶の全体の
 * `parent` を毎ターン読み直して渡すことになり、この関数の引数の形が変わる
 * ——範囲が別なので、ここでは直していない。**ここを直すときは
 * `renderMemoryTocIssue` の doc も一緒に読むこと。**
 */
function resolveMemoryHierarchy(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere = {},
): ResolvedTocNode[] {
  const renderedAsPremise = elsewhere.renderedAsPremise ?? new Set<string>();
  const presentInMemory = elsewhere.presentInMemory ?? new Set<string>();
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const parentOf = new Map(entries.map((entry) => [entry.slug, entry.parent]));

  function effectiveParent(slug: string): {
    parent?: string;
    issue?: MemoryTocIssue;
  } {
    const direct = parentOf.get(slug);
    if (direct === undefined || direct === '') return {};
    if (!bySlug.has(direct)) {
      // **順に見る。** 「同じ描画の中に premise として載っている」ほうが具体的
      // なので先に当てる——記憶の全体には当然その premise も入っているので、
      // 逆順にすると具体的な言い方のほうが二度と出なくなる。
      if (renderedAsPremise.has(direct)) return { issue: 'parent-not-listed' };
      if (presentInMemory.has(direct)) return { issue: 'parent-not-rendered' };
      return { issue: 'missing-parent' };
    }
    if (direct === slug) return { issue: 'cycle' };
    const seen = new Set<string>([slug]);
    let cursor = direct;
    for (;;) {
      if (seen.has(cursor)) return { issue: 'cycle' };
      seen.add(cursor);
      const next = parentOf.get(cursor);
      if (next === undefined || next === '' || !bySlug.has(next)) break;
      cursor = next;
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
 * 印は要旨の**前**に置く——左から読んで必ず当たる形にする（4-1）。
 *
 * **代理指標であることをここにも書く**（`MemoryDescriptionFreshness` の doc
 * と同じ注意）。`fresh`（印なし）は「`description` が本文の変更後に書かれた」
 * ことしか意味しない。「本文を読み直して要旨を書き直した」ことの保証では
 * ない。
 */
function memoryFreshnessMarker(freshness: MemoryDescriptionFreshness): string {
  switch (freshness.kind) {
    case 'fresh':
      return '';
    case 'stale':
      return '⚠古い要旨（本文の方が新しい）: ';
    case 'unknown':
      return '？要旨の鮮度不明: ';
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
 * **`missing-parent` / `parent-not-listed` / `parent-not-rendered` を畳まない。**
 * 3つとも「親の行が上に無い」という同じ見た目だが、**読み手が次に疑う先が違う。**
 *
 * | 印                    | 何が起きているか                                         | 読み手が次に見る先                       |
 * | --------------------- | -------------------------------------------------------- | ---------------------------------------- |
 * | `missing-parent`      | その slug の文書がそもそも無い（打ち間違いか、削除された） | `parent` の綴り／消したかどうか          |
 * | `parent-not-listed`   | 文書は実在し、**同じ描画の中に premise として全文が載っている** | この目次のすぐ上                    |
 * | `parent-not-rendered` | 文書は実在するが、**今回の描画そのものに載っていない**     | 記憶の側（`memory_list` を呼ぶ必要は無い） |
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
 * `cycle` については、循環の一部が描画の外を通ると検出できない（この場合
 * `parent-not-rendered` に落ちる。理由と直し方は `resolveMemoryHierarchy` の doc）。
 */
function renderMemoryTocIssue(node: ResolvedTocNode): string {
  if (node.issue === 'missing-parent') return `［親 ${String(node.entry.parent)} が見つからない］`;
  if (node.issue === 'cycle') return `［親 ${String(node.entry.parent)} との間で循環］`;
  if (node.issue === 'parent-not-listed') {
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
 * `fact` 文書の目次を組み立てる。**保存しない——毎回この関数が
 * 各文書の `description` から組み立て直す**ので、目次と実体が食い違う
 * ことは構造的に起こりえない（4-1）。
 *
 * **件数で切ったら、切った件数を必ず出す**（`excerpt.ts` と同じ約束）。
 *
 * `elsewhere` はそのまま `resolveMemoryHierarchy` へ渡す（`parent` がこの目次の
 * 外に実在するときの2つの状態を区別するため。呼び手
 * （`buildMemoryDocumentSections`）が premise の slug 集合と、記憶の全体の
 * slug 集合を渡す）。
 */
function renderMemoryToc(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere = {},
): string {
  const flat = flattenMemoryToc(resolveMemoryHierarchy(entries, elsewhere));
  const shown = flat.slice(0, MEMORY_TOC_ENTRY_LIMIT);
  const omitted = flat.length - shown.length;
  const lines = [
    '<!-- memory: index -->',
    '## 記憶の目次（fact。本文は memory_read で開く。階層はインデントで表す）',
    ...shown.map(renderMemoryTocLine),
  ];
  if (omitted > 0) {
    lines.push(`…ほか ${omitted} 件は目次から省略（目次の対象は全 ${flat.length} 件）。`);
  }
  return lines.join('\n');
}

const MALFORMED_FRONTMATTER_NOTE =
  '<!-- memory: frontmatter が壊れている（既知の形にならなかった。premise として全文を扱っている） -->';

function renderPremisePart(part: MemoryPart): string {
  const rendered = renderMemoryDocument(part);
  const frontmatter = parseMemoryFrontmatter(part.content);
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
 */
function buildMemoryDocumentSections(
  documents: readonly MemoryPart[],
  presentInMemory?: ReadonlySet<string>,
): {
  premiseParts: MemoryPart[];
  premiseSection: string;
  tocEntries: MemoryTocEntry[];
  tocSection: string;
} {
  const premiseParts: MemoryPart[] = [];
  const tocEntries: MemoryTocEntry[] = [];

  for (const doc of documents) {
    const frontmatter = parseMemoryFrontmatter(doc.content);
    const kind = resolveMemoryDocKind(frontmatter);
    if (kind === 'premise') {
      premiseParts.push(doc);
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

  const premiseSection =
    premiseParts.length === 0 ? '' : premiseParts.map(renderPremisePart).join('\n\n');
  // 目次の外にも実在する slug を、**在り処ごとに分けて**渡す——`documents` は
  // 「記憶の全部」とは限らないので、ここで畳むと実在するものが「見つからない」
  // として出る（`renderMemoryTocIssue` の 'parent-not-listed' と
  // 'parent-not-rendered'）。
  const premiseSlugs = new Set(premiseParts.map((part) => part.slug));
  const tocSection =
    tocEntries.length === 0
      ? ''
      : renderMemoryToc(tocEntries, { renderedAsPremise: premiseSlugs, presentInMemory });

  return { premiseParts, premiseSection, tocEntries, tocSection };
}

/**
 * `renderMemoryDocuments` の任意引数。**記憶の一部だけを描く呼び手のためだけに
 * ある**（全体を渡す呼び手は何も渡さなくてよい）。
 */
export interface RenderMemoryDocumentsOptions {
  /**
   * **記憶（ストア）に実在する slug の全体。** `documents` に含まれる slug を
   * 含んでいてよい（選り分けは不要。`MemoryHierarchyElsewhere.presentInMemory`）。
   *
   * 渡すと、`parent` が `documents` の外を指しているときに「見つからない」
   * （＝文書がそもそも無い）ではなく「在るが、ここに載せた分には含まれない」と
   * 出る。**渡さなければ出力は1バイトも変わらない。**
   */
  presentInMemory?: ReadonlySet<string>;
}

/** `premiseSection` と `tocSection` を、実際に焼き込む1本の文字列へ繋ぐ。 */
function joinMemorySections(premiseSection: string, tocSection: string): string {
  return [premiseSection, tocSection].filter((section) => section.length > 0).join('\n\n');
}

/**
 * 記憶をクローンの文脈へ載せる、唯一の入口。
 *
 * **区分ごとに載り方を変える**（4-1「B. 区分と載せ方」）:
 * - `premise`（判断の前提。既定でもある） — **全文**。切り詰めない
 *   （切り詰めた前提は「持っていない前提」と区別できない）
 * - `fact`（事実と蓄積） — **目次の1行だけ**。本文は `memory_read` で開く
 *
 * **どの文書も、全文か目次行かの「どちらか一方」に必ず現れる**（二重に
 * 載せない・取りこぼさない）。文書の順序は呼び手（ストア）が決めた順
 * そのまま（`premise` は slug 昇順のまま連結、`fact` は目次側で
 * 階層・slug 昇順に並べ直す）。
 *
 * frontmatter を1つも持たない文書の集合（`kind: 'none'` のみ）に対しては、
 * 全件が `premise` に分類されるため、出力は frontmatter 導入前の
 * `renderMemoryDocuments` と1バイトも変わらない（受け入れ基準の最上位）。
 *
 * ## ⚠️ `documents` が「記憶の全部」でない呼び方がある
 *
 * 上の不変条件（どの文書も全文か目次行のどちらか一方に必ず現れる）は、**記憶の
 * 全体を渡したときの約束である。** `clone.ts` の `#withFreshMemory` は
 * **変わった文書だけ**を渡す——そのとき「渡されなかった文書」は上にも下にも
 * 現れない。**その状態を「存在しない」と報告しないために、部分だけを渡す呼び手は
 * `options.presentInMemory` に記憶の全体の slug を渡すこと**（渡さないと、親が
 * 今回変わっていないだけで「親 X が見つからない」と出る）。
 */
export function renderMemoryDocuments(
  documents: readonly MemoryPart[],
  options: RenderMemoryDocumentsOptions = {},
): RenderedMemory {
  const { premiseSection, tocSection } = buildMemoryDocumentSections(
    documents,
    options.presentInMemory,
  );
  return brandRenderedMemory(joinMemorySections(premiseSection, tocSection));
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
  const { premiseParts, premiseSection, tocEntries, tocSection } =
    buildMemoryDocumentSections(documents);
  const totalChars = joinMemorySections(premiseSection, tocSection).length;

  let largestPremise: { slug: string; chars: number } | null = null;
  for (const part of premiseParts) {
    const chars = renderPremisePart(part).length;
    if (largestPremise === null || chars > largestPremise.chars) {
      largestPremise = { slug: part.slug, chars };
    }
  }

  return {
    premiseChars: premiseSection.length,
    tocChars: tocSection.length,
    totalChars,
    premiseDocs: premiseParts.length,
    factDocs: tocEntries.length,
    largestPremise,
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
 * 3. **`premise` を新規作成したときだけ**、それが「毎ターン全文が焼かれる」
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
  const floorLine = `毎ターンの床（焼き込み全体。いま読み直した値）: ${transition}。`;

  if (created && kind === 'premise') {
    const lines = [
      `⭐ 新規作成: ${slug}（区分: premise）。`,
      floorLine,
      '⚠️ premise は毎ターン全文がそのままクローンの文脈へ焼かれる（切り詰めない）。',
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
 * ## 引数は「1回のツール呼び出しで変わった文書すべて」
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
 * 3. **⚠️ `renderMemoryDocuments` へ `presentInMemory` を渡していない。**
 *    ここが持っているのは「今回書いた文書」だけで、記憶の全体を知らない
 *    （呼び手4箇所は `tools.ts` に在り、ストアを渡してこない）。そのため、
 *    書いた文書が **fact で、その `parent` が今回の書き込みに含まれない**
 *    ときだけ、実際に載る印（「在るが、ここに載せた分には含まれない」）より
 *    短い印（「見つからない」）で数えることになり、**数十文字ぶん少なく出る。**
 *    ⟹ 直すには呼び手の側から記憶の全体を渡す必要がある（`tools.ts` の4箇所
 *    の署名が変わる）。ここではその形にしていない。
 *
 * ## ⚠️ 引数を非空タプルにしてある理由（P3 の同乗、#318）
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
): string {
  if (parts.length === 0) {
    throw new Error('describeMemoryReinjectionEstimate: parts が空（呼び手の実装誤り）');
  }

  const chars = renderMemoryDocuments(parts).length;
  const kindOf = (part: MemoryPart): MemoryDocKind =>
    resolveMemoryDocKind(parseMemoryFrontmatter(part.content));
  const kindLabel = (kind: MemoryDocKind): string =>
    kind === 'premise' ? 'premise・全文' : 'fact・目次1行';
  const breakdown = parts.map((part) => `${part.slug}（${kindLabel(kindOf(part))}）`).join(' + ');

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
 * 節を切り取った後の `content` と、切り取った文字列を返す。
 *
 * **組み立ては継ぎ足しである。** `content.slice(0, section.start)` と
 * `content.slice(section.end)` を繋ぐだけなので、**frontmatter のバイト列は
 * 添字で運ばれるだけで一度も書き直されない**（`memoryBodyStart` の doc）。
 * `section.start` は必ず `memoryBodyStart(content)` 以上なので、frontmatter が
 * 切り取りの範囲に入ることは無い。
 *
 * **それでも書き込み前に検査すること**——この関数が正しいことと、次にここを
 * 触る人が組み直す形に変えないことは別である（`memory_section_move` の
 * 第3層。`tools.ts` を読むこと）。
 */
export function cutMemorySection(
  content: string,
  section: MemorySection,
): { nextContent: string; cut: string } {
  return {
    nextContent: content.slice(0, section.start) + content.slice(section.end),
    cut: content.slice(section.start, section.end),
  };
}

/** 目次の予算（文字数）。件数では切らない（AGENTS.md の地雷表）。 */
export const MEMORY_OUTLINE_BUDGET = 8_000;

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
 */
export function renderMemoryOutline(sections: readonly MemorySection[]): string {
  if (sections.length === 0) {
    return (
      '節が1つも無い（見出しが1つも無いか、最初の見出しより前の前書きしか無い）。' +
      '前書きは節ではないので memory_section_move では動かせない。'
    );
  }
  const counts = new Map<string, number>();
  for (const section of sections) counts.set(section.id, (counts.get(section.id) ?? 0) + 1);
  const items = sections.map((section) => {
    const indent = '  '.repeat(section.depth - 1);
    const ambiguous =
      (counts.get(section.id) ?? 0) > 1
        ? ' ⚠この id は複数箇所に当たる。この id では動かせない（memory_section_move は断る）'
        : '';
    return `${indent}[${section.id}] ${section.heading} — ${formatMemoryCharCount(section.chars)} 文字${ambiguous}`;
  });
  return renderListing(items, {
    budget: MEMORY_OUTLINE_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${rest} 節は省略（節は全 ${total} 件あり、${shown} 件だけ出した）。` +
      '省略された節を動かしたいなら、先に上の節を減らすか、memory_read で本文を読むこと。',
  });
}
