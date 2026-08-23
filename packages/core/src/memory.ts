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
  const lines = content.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return content;
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) return content;
  return lines.slice(closingIndex + 1).join('\n');
}

/** frontmatter の3キーのうち、渡したものだけを新しい値にする差分。 */
export interface MemoryFrontmatterPatch {
  description?: string;
  type?: string;
  parent?: string;
}

function serializeMemoryFrontmatter(fields: MemoryFrontmatterPatch): string {
  const lines = [FRONTMATTER_DELIMITER];
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`);
  if (fields.type !== undefined) lines.push(`type: ${fields.type}`);
  if (fields.parent !== undefined) lines.push(`parent: ${fields.parent}`);
  lines.push(FRONTMATTER_DELIMITER);
  return lines.join('\n');
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
 * `patch` のキーを1つも渡さない呼び（3キーとも `undefined`）を断るかどうかは
 * ここでは決めない——それは道具（呼び手）の責務であり、この関数自体は
 * 「空のパッチ」を渡されれば frontmatter を（内容が変わらないまま）
 * 再構成して返す。
 */
export function applyMemoryFrontmatterPatch(content: string, patch: MemoryFrontmatterPatch): string {
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
  return body.length === 0 ? header : `${header}\n${body}`;
}

const KNOWN_DOC_KINDS: ReadonlySet<MemoryDocKind> = new Set(['premise', 'fact']);

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

interface ResolvedTocNode {
  entry: MemoryTocEntry;
  depth: number;
  issue?: 'missing-parent' | 'cycle';
  children: ResolvedTocNode[];
}

/**
 * 親子関係を解決し、木にする。**循環と、存在しない親を指す `parent` を
 * 黙って落とさない**（4-1「階層は『それ自体が目次である文書』で作る」）。
 *
 * - 親が存在しない slug を指す → ルート扱いにし、`issue: 'missing-parent'`
 * - 親をたどると自分自身に戻る（循環） → ルート扱いにし、`issue: 'cycle'`
 *
 * どちらも文書自体は消えない——ルートとして目次に残り、印がつく。
 */
function resolveMemoryHierarchy(entries: readonly MemoryTocEntry[]): ResolvedTocNode[] {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const parentOf = new Map(entries.map((entry) => [entry.slug, entry.parent]));

  function effectiveParent(slug: string): { parent?: string; issue?: 'missing-parent' | 'cycle' } {
    const direct = parentOf.get(slug);
    if (direct === undefined || direct === '') return {};
    if (!bySlug.has(direct)) return { issue: 'missing-parent' };
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

/** 循環・存在しない親を黙って落とさず、印として言葉にする。 */
function renderMemoryTocIssue(node: ResolvedTocNode): string {
  if (node.issue === 'missing-parent') return `［親 ${String(node.entry.parent)} が見つからない］`;
  if (node.issue === 'cycle') return `［親 ${String(node.entry.parent)} との間で循環］`;
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
 */
function renderMemoryToc(entries: readonly MemoryTocEntry[]): string {
  const flat = flattenMemoryToc(resolveMemoryHierarchy(entries));
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
 */
export function renderMemoryDocuments(documents: readonly MemoryPart[]): RenderedMemory {
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
  const tocSection = tocEntries.length === 0 ? '' : renderMemoryToc(tocEntries);

  const sections = [premiseSection, tocSection].filter((section) => section.length > 0);
  return brandRenderedMemory(sections.join('\n\n'));
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
 * ストア側の想定外の挙動）を疑う根拠になる（歯は `tools.test.ts` にある）。
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
 * **行頭に限る。** 行のどこかに `#` があるだけの行（インラインの `#` や
 * コードブロックの中身）は見出しではない——ここを緩めると、本文中の
 * `#` がすべて「見出し」として数えられてしまう。
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
