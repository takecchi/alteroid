// クローンの tick の要約（digest）と固定の文言を、同じ会話（同じ SDK セッション、自動要約の前）の中では前回からの差分にする（#4937）。
// 純粋な重複の除去であって、判断の材料は減らさない: 前に出した全文は会話の上に残っている。
// 控えの作りは「いまの全体」の説明文（`situation.ts` の `SituationExplained`、clone.ts の `#commitSituationExplained`）に揃える:
// 組んだ時点では控えへ書かず（staged）、入力を SDK へ押し込めた後に確定する。押し込めなかった回に控えを進めると、会話に一度も載っていない全文を畳んでしまうため。
// 「20ターンごとに全文」は入れない（状況の節との違い）: 判断ではなく重複の除去なので、会話が続く限り前の全文は上にある。全文へ戻すのは会話が変わった・要約が走りうる・記録が無いときだけ（`reset()`）。
// 段落の重複の除去（#4943）も同じ控えに載せる: 全文へ戻す条件（reset）・入力を押し込めた後の確定（commit）・押し込めなかった回の持ち越しの破棄（discardStaged）を1つの口にし、呼び忘れが出ないようにするため。
import { createHash } from 'node:crypto';
import { DIGEST_FIXED_PHRASES, DIGEST_LIST_SECTION_NAMES } from './digest.js';

/** 段落として畳む最小の長さ（文字数）。これより短い段落は、参照にしても得が小さく読みにくくなるだけなので常に全文。 */
export const SYSTEM_PARAGRAPH_MIN_CHARS = 200;
/** 前に全文で出した段落の代わりに出す短い参照。 */
export const SYSTEM_PARAGRAPH_REF = '（前に出した段落と同じ。会話の上にある）';
// 控えるのは指紋だけで、件数に上限を置く: 変わる値を含む段落が会話の間に溜まり続けないため。溢れて忘れた段落は次に全文へ戻るだけ（安全側）
const PARAGRAPH_MEMORY_LIMIT = 256;

function paragraphKey(paragraph: string): string {
  return createHash('sha256').update(paragraph).digest('hex').slice(0, 32);
}

interface SectionRecord {
  /** その要約を組んだ時刻（`HH:MMZ` の表示用）。 */
  readonly at: Date;
  /** 見出し行 → 本文（見出しの次の行から次の見出しの前まで）。差分にする前の全文を持つ。 */
  readonly sections: ReadonlyMap<string, string>;
}

interface Staged {
  sections: SectionRecord | null;
  readonly fixed: Set<string>;
  readonly requests: Map<string, { text: string; at: Date }>;
  readonly paragraphs: Set<string>;
}

export interface RenderedDigest {
  /** モデルへ渡す形（差分にしたもの）。 */
  readonly text: string;
  /** 差分にする前の全文の長さ。 */
  readonly fullChars: number;
}

/** `HH:MMZ`（UTC）。 */
export function clockLabel(at: Date): string {
  return `${at.toISOString().slice(11, 16)}Z`;
}

const SECTION_HEADING = /^## /u;
// `omitted()`（digest.ts）の「…ほか N 件」の行は項目として数えない: 件数の行で、常に出す
const OMITTED_LINE = /^- …ほか /u;

interface ParsedDigest {
  readonly preamble: string[];
  readonly sections: { heading: string; body: string[] }[];
}

function parseDigest(text: string): ParsedDigest {
  const preamble: string[] = [];
  const sections: { heading: string; body: string[] }[] = [];
  for (const line of text.split('\n')) {
    if (SECTION_HEADING.test(line)) {
      sections.push({ heading: line, body: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current === undefined) preamble.push(line);
    else current.body.push(line);
  }
  return { preamble, sections };
}

// 節と節の間の空行は本文の末尾に付く: 比較には含めず、出力では元のまま残す
function splitTrailingBlank(body: readonly string[]): { content: string[]; trailing: string[] } {
  let end = body.length;
  while (end > 0 && body[end - 1] === '') end -= 1;
  return { content: body.slice(0, end), trailing: body.slice(end) };
}

function isItemStart(line: string): boolean {
  return line.startsWith('- ') && !OMITTED_LINE.test(line);
}

// 項目 = `- ` で始まる行と、続く2文字下げの行（`  直近の報告:` など）
function groupBody(content: readonly string[]): ({ item: string } | { other: string })[] {
  const out: ({ item: string } | { other: string })[] = [];
  for (const line of content) {
    const last = out.at(-1);
    if (isItemStart(line)) out.push({ item: line });
    else if (line.startsWith('  ') && last !== undefined && 'item' in last) {
      out[out.length - 1] = { item: `${last.item}\n${line}` };
    } else out.push({ other: line });
  }
  return out;
}

function isListSection(heading: string): boolean {
  const name = heading.replace(SECTION_HEADING, '');
  return DIGEST_LIST_SECTION_NAMES.some((candidate) => name.startsWith(candidate));
}

export class DigestSessionDelta {
  #committed: {
    sections: SectionRecord | null;
    fixed: Set<string>;
    requests: Map<string, { text: string; at: Date }>;
    paragraphs: Set<string>;
  } = { sections: null, fixed: new Set(), requests: new Map(), paragraphs: new Set() };
  #staged: Staged | null = null;

  /** 差分の記録を全て捨てる（次の回は全文）。会話が変わった（作り直しの窓を含む）・要約が走りうる・見込みの材料が無い・走った・失敗したターンの後・起動直後（#4941）。段落の控え（#4943）も同じ口で消える。 */
  reset(): void {
    this.#committed = {
      sections: null,
      fixed: new Set(),
      requests: new Map(),
      paragraphs: new Set(),
    };
    this.#staged = null;
  }

  /** 前の回の持ち越しを捨てる（入力が入らなかった回の全文を、次の回へ引き継がない）。 */
  discardStaged(): void {
    this.#staged = null;
  }

  /** 入力を SDK へ押し込めた直後にだけ呼ぶ: 全文が会話に載ったと言えるのはそのときだけのため。 */
  commit(): void {
    const staged = this.#staged;
    if (staged === null) return;
    this.#staged = null;
    if (staged.sections !== null) this.#committed.sections = staged.sections;
    for (const id of staged.fixed) this.#committed.fixed.add(id);
    for (const [kind, request] of staged.requests) this.#committed.requests.set(kind, request);
    for (const key of staged.paragraphs) this.#committed.paragraphs.add(key);
    // 古い方から忘れる（Set は挿入順）
    for (const key of this.#committed.paragraphs) {
      if (this.#committed.paragraphs.size <= PARAGRAPH_MEMORY_LIMIT) break;
      this.#committed.paragraphs.delete(key);
    }
  }

  #stage(): Staged {
    this.#staged ??= {
      sections: null,
      fixed: new Set(),
      requests: new Map(),
      paragraphs: new Set(),
    };
    return this.#staged;
  }

  /**
   * システムが作った本文を空行（`\n\n`）で段落に分け、同じ会話で既に全文で出した段落と1字も違わない長い段落を短い参照にする（#4943）。
   * 比べるのは完全一致だけ: 回数・理由・時刻などの変わる値を含む段落は、自然に全文のままになる。
   * 呼び出し側は、システムが作った部品にだけ掛けること（人間の発言・外部イベントの中身・担当の報告の本文・人間の回答は、言い換えると意味が変わるので掛けない）。
   * `eligible` で、システムが作った段落とそうでない段落が混ざる本文（担当の確認の文）の対象を絞る。
   * 結合は `join('\n\n')` で元に戻せる形にしてあり、畳まない段落は1字も変えない。
   */
  foldParagraphs(text: string, eligible: (paragraph: string) => boolean = () => true): string {
    if (text.length < SYSTEM_PARAGRAPH_MIN_CHARS) return text;
    return text
      .split('\n\n')
      .map((paragraph) => {
        if (paragraph.length < SYSTEM_PARAGRAPH_MIN_CHARS || !eligible(paragraph)) return paragraph;
        const key = paragraphKey(paragraph);
        if (this.#committed.paragraphs.has(key)) return SYSTEM_PARAGRAPH_REF;
        // 同じ入力の中の2つ目は全文のまま: 参照が指す先（会話の上）に、この入力はまだ載っていないため
        this.#stage().paragraphs.add(key);
        return paragraph;
      })
      .join('\n\n');
  }

  /**
   * 固定の文言。会話で1回だけ全文、以後は参照。
   * @param full 全文
   * @param ref 会話の上に出したことを名乗る短い参照
   */
  fixed(id: string, full: string, ref: string): string {
    if (this.#committed.fixed.has(id)) return ref;
    this.#stage().fixed.add(id);
    return full;
  }

  /**
   * 今回の依頼の本文（timer）。同じ会話で同じ kind・同じ本文を全文で出していれば、その時刻を返す。
   * 返ったら呼び出し側は全文を出さない。返らなければ全文を出す前提で控えに足す。
   */
  requestSeenAt(kind: string, text: string, now: Date): Date | null {
    const seen = this.#committed.requests.get(kind);
    // 差分にした回も記録の時刻を進める: 「前回の発火」を名乗るため。本文は同じなので、会話の上の全文は変わらない
    this.#stage().requests.set(kind, { text, at: now });
    return seen !== undefined && seen.text === text ? seen.at : null;
  }

  /**
   * 要約を節の単位・一覧の節は行の単位で、前回との差分にする。
   * `fixedPhrases` に当たる固定の注記は、会話で1回だけ全文にする。
   */
  renderDigest(digest: string, now: Date): RenderedDigest {
    const parsed = parseDigest(digest);
    if (parsed.sections.length === 0) return { text: digest, fullChars: digest.length };

    const previous = this.#committed.sections;
    const fullSections = new Map<string, string>();
    const out: string[] = [...parsed.preamble];
    for (const section of parsed.sections) {
      const { content, trailing } = splitTrailingBlank(section.body);
      const bodyText = content.join('\n');
      fullSections.set(section.heading, bodyText);
      const before = previous?.sections.get(section.heading);
      out.push(section.heading);
      if (previous === null || before === undefined) {
        out.push(...this.#foldFixed(content));
      } else if (before === bodyText) {
        out.push(
          `（前回（${clockLabel(previous.at)}）の要約から変わっていない。全文は会話の上にある）`,
        );
      } else if (isListSection(section.heading)) {
        out.push(...this.#foldFixed(rowDelta(content, before, previous.at)));
      } else {
        out.push(...this.#foldFixed(content));
      }
      out.push(...trailing);
    }
    this.#stage().sections = { at: now, sections: fullSections };
    return { text: out.join('\n'), fullChars: digest.length };
  }

  #foldFixed(lines: readonly string[]): string[] {
    let text = lines.join('\n');
    for (const phrase of DIGEST_FIXED_PHRASES) {
      if (!text.includes(phrase.text)) continue;
      text = text.replace(phrase.text, () =>
        this.fixed(`digest:${phrase.id}`, phrase.text, phrase.ref),
      );
    }
    return text.split('\n');
  }
}

// 前回の同じ節に1字も違わない行があれば省き、新しい行・変わった行だけを出す。件数の行（節の外の数え上げ・`…ほか N 件`）と固定の注記は対象外で、常に出す
function rowDelta(content: readonly string[], beforeBody: string, previousAt: Date): string[] {
  const beforeItems = new Set(
    groupBody(beforeBody.split('\n'))
      .filter((entry): entry is { item: string } => 'item' in entry)
      .map((entry) => entry.item),
  );
  const out: string[] = [];
  let omittedInRun = 0;
  const flush = (): void => {
    if (omittedInRun === 0) return;
    out.push(
      `（ほかの ${omittedInRun} 件は前回（${clockLabel(previousAt)}）から変わっていない。会話の上にある）`,
    );
    omittedInRun = 0;
  };
  for (const entry of groupBody(content)) {
    if ('item' in entry) {
      if (beforeItems.has(entry.item)) omittedInRun += 1;
      else out.push(entry.item);
    } else {
      flush();
      out.push(entry.other);
    }
  }
  flush();
  return out;
}
