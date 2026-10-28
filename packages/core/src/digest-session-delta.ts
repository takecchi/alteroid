// クローンの tick の要約（digest）と固定の文言を、同じ会話（同じ SDK セッション、自動要約の前）の中では前回からの差分にする（#4937）。
// 純粋な重複の除去であって、判断の材料は減らさない: 前に出した全文は会話の上に残っている。
// 控えの作りは「いまの全体」の説明文（`situation.ts` の `SituationExplained`、clone.ts の `#commitSituationExplained`）に揃える:
// 組んだ時点では控えへ書かず（staged）、入力を SDK へ押し込めた後に確定する。押し込めなかった回に控えを進めると、会話に一度も載っていない全文を畳んでしまうため。
// 全文へ戻す理由は2つに分ける（`reset(reason)`）: 要約が走りうる／走った（`'compaction'`）は会話の上に要約された前の文脈が残るので、判断の節だけの軽い全文（`isLean`）にする。
// 会話が変わった・失敗したターンの後・起動直後・見込みの材料が無い（`'full'`。区別できない箇所の既定）は完全な全文。軽い全文で省いた節は控えへ入れない（次の回に「前と同じ」と畳ませない）。
// 固定の文言の控え（`fixed`。道具の応答 `manager-list:*`・`tool:*` と、報告の包み `manager-message:*`・`digest:*`・`commitment-notice-*` を含む）だけは、`SITUATION_FULL_EVERY_TURNS` ターンごとにも全文へ戻す（`forgetFixed()`。状況の節と同じ線）。
// 以前は「20ターンごとに全文は入れない（重複の除去であって判断ではない）」と決めていたが、変えた: 要約の合図を取りこぼしたときに、全文が会話から消えたまま札（参照）だけが続く長さに上限を置く保険が要る（札は安全上の結論を短く残すだけで、全文の代わりではない）。
// 周期の対象は `fixed` だけ: 段落（`paragraphs`）と報告（`reports`）の控えは #5422 の対象外で、周期の保険は入れていない（要約が走りうる回などの `reset()` は従来どおり全部を捨てる）。それらに周期が要るかは別に判断する。
// 周期以外で全文へ戻すのは、会話が変わった・要約が走りうる・記録が無いとき（`reset()`）。
// 段落の重複の除去（#4943）も同じ控えに載せる: 全文へ戻す条件（reset）・入力を押し込めた後の確定（commit）・押し込めなかった回の持ち越しの破棄（discardStaged）を1つの口にし、呼び忘れが出ないようにするため。
import { createHash } from 'node:crypto';
import {
  DIGEST_FIXED_PHRASES,
  DIGEST_LIST_SECTION_NAMES,
  SOURCE_TALLY_HEADING,
  foldDigestCountsLine,
} from './digest.js';

/**
 * 要約が走りうる／走った回の軽い全文（案 A）で、中身を省いて1行の参照にする節（見出しの先頭が一致するもの）と、その引き口。
 * 引き口は `tools.ts` に実在する道具と引数だけを書く: `commitment_list`（`includeClosed`）・`journal_read`（`types`）・`usage_read`。
 * 先頭の件数行（まえがき）は節の外なので、省いた節の件数もそのまま残る。
 * 残す節（人間の回答待ち・エスカレーション・担当・自分の台帳の未了・聞かずに決めたこと・継続中の依頼・読めない行の注記）はここに無い。
 */
export const LEAN_DROPPED_SECTIONS: readonly { name: string; ref: string }[] = [
  {
    name: 'この期間に片付けた仕事',
    ref: '（この節は省いた。`commitment_list` に includeClosed=true を渡すと引ける）',
  },
  {
    name: '記憶の更新',
    ref: '（この節は省いた。`journal_read` に types=["memory_update"] を渡すと引ける）',
  },
  {
    name: '使った分',
    ref: '（この節は省いた。`usage_read` で引ける）',
  },
];
/** 外部イベントの節のうち、発行元別の件数と本文の形（標本）を省いた跡に出す参照。件名の一覧と固定の注記は残す。 */
export const LEAN_EXTERNAL_TALLY_REF =
  '（発行元別の件数と本文の形は省いた。`journal_read` に types=["external_event"] を渡すと引ける）';
const EXTERNAL_SECTION_NAME = '届いた外部イベント';
const LEDGER_SECTION_NAME = '引き受けたまま終わっていない仕事';

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

/** 担当の報告の全文を発言に載せたことの控え。本文そのものは持たず、指紋と長さだけを持つ（最大 47,500 字を担当の数だけ抱えないため）。 */
interface ReportShown {
  readonly key: string;
  readonly chars: number;
  readonly at: Date;
}

/**
 * この長さに満たない報告は控えない。引き直しても得が小さく、短い本文は別の箇所の文字列と偶然一致しやすいため。
 * 控えないだけで安全側（引き直せば全文が返る）。
 */
export const REPORT_SHOWN_MIN_CHARS = 1_000;

interface Staged {
  sections: SectionRecord | null;
  readonly fixed: Set<string>;
  readonly requests: Map<string, { text: string; at: Date }>;
  readonly paragraphs: Set<string>;
  readonly reports: Map<string, ReportShown>;
}

/** `DigestSessionDelta` の確定した控えを JSON にできる形にしたもの（`exportState` / `importState`）。 */
export interface DigestDeltaState {
  sections: { at: string; sections: [string, string][] } | null;
  fixed: string[];
  requests: [string, { text: string; at: string }][];
  paragraphs: string[];
  reports: [string, { key: string; chars: number; at: string }][];
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

/** 「前回と同じ」を1行にまとめてよい節の名前（見出しの `（` より前）。台帳の節（#5297 の領域）は `null`。 */
function foldableSameSectionName(heading: string): string | null {
  const name = heading.replace(SECTION_HEADING, '');
  if (name.startsWith(LEDGER_SECTION_NAME)) return null;
  const paren = name.indexOf('（');
  return paren >= 0 ? name.slice(0, paren) : name;
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
    reports: Map<string, ReportShown>;
  } = {
    sections: null,
    fixed: new Set(),
    requests: new Map(),
    paragraphs: new Set(),
    reports: new Map(),
  };
  #staged: Staged | null = null;
  // 次の要約を「判断の節だけの軽い全文」にしてよいか。会話の上に何も残っていない理由（起動直後・会話が変わった・失敗したターンの後・見込みの材料が無い）の reset が1度でもあれば、
  // その全文が確定（commit）するまでは完全な全文（`#fullForced`）。起動直後は記録が無いので真から始める
  #fullForced = true;
  #compactionReset = false;

  /**
   * 戻り値は「畳んだ記録が実際に残っていて捨てたか」（観測用。挙動は変えない）。
   * 差分の記録を全て捨てる（次の回は全文）。会話が変わった（作り直しの窓を含む）・要約が走りうる・見込みの材料が無い・走った・失敗したターンの後・起動直後（#4941）。段落の控え（#4943）も同じ口で消える。
   * `reason`: `'full'`（既定。区別できない箇所はここへ倒す）は会話の上に何も残っていない回で、次の要約は完全な全文。
   * `'compaction'` は要約が走りうる／走った回で、次の要約は判断の節だけの軽い全文にしてよい（`renderDigest`）。ただし先に `'full'` の reset があって、その全文がまだ確定していなければ完全な全文のまま。
   */
  reset(reason: 'full' | 'compaction' = 'full'): boolean {
    const hadRecord =
      this.#committed.sections !== null ||
      this.#committed.fixed.size > 0 ||
      this.#committed.requests.size > 0 ||
      this.#committed.paragraphs.size > 0 ||
      this.#committed.reports.size > 0;
    if (reason === 'full') this.#fullForced = true;
    else this.#compactionReset = true;
    this.#committed = {
      sections: null,
      fixed: new Set(),
      requests: new Map(),
      paragraphs: new Set(),
      reports: new Map(),
    };
    this.#staged = null;
    return hadRecord;
  }

  /**
   * 確定した控え（committed）だけを、JSON にできる形で写す。押し込めていない分（staged）は含めない: 会話に載ったと言えるのは確定した分だけのため。
   * 再起動をまたいで resume するときの読み戻し用（`fold-state.ts`）。日時は ISO 文字列。
   */
  exportState(): DigestDeltaState {
    const { sections, fixed, requests, paragraphs, reports } = this.#committed;
    return {
      sections:
        sections === null
          ? null
          : { at: sections.at.toISOString(), sections: [...sections.sections] },
      fixed: [...fixed],
      requests: [...requests].map(([kind, r]) => [kind, { text: r.text, at: r.at.toISOString() }]),
      paragraphs: [...paragraphs],
      reports: [...reports].map(([id, r]) => [
        id,
        { key: r.key, chars: r.chars, at: r.at.toISOString() },
      ]),
    };
  }

  /**
   * `exportState` の写しから控えを組み直す（形の検査は呼び出し側）。読み戻した回の挙動:
   * 要約を1度でも全文で出していた（sections がある）なら、完全な全文へ倒す理由は消える。無ければ起動直後と同じ（最初の要約は完全な全文）。
   */
  importState(state: DigestDeltaState): void {
    this.#committed = {
      sections:
        state.sections === null
          ? null
          : { at: new Date(state.sections.at), sections: new Map(state.sections.sections) },
      fixed: new Set(state.fixed),
      requests: new Map(
        state.requests.map(([kind, r]) => [kind, { text: r.text, at: new Date(r.at) }]),
      ),
      paragraphs: new Set(state.paragraphs),
      reports: new Map(
        state.reports.map(([id, r]) => [id, { key: r.key, chars: r.chars, at: new Date(r.at) }]),
      ),
    };
    this.#staged = null;
    this.#fullForced = state.sections === null;
    this.#compactionReset = false;
  }

  /** 次の要約が軽い全文か: 要約が走りうる／走った理由の reset があり、完全な全文へ倒す理由の reset が（確定した全文の後に）無いとき。 */
  isLean(): boolean {
    return this.#compactionReset && !this.#fullForced;
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
    if (staged.sections !== null) {
      this.#committed.sections = staged.sections;
      // 要約が会話に載った: 次の reset の理由からやり直す
      this.#fullForced = false;
      this.#compactionReset = false;
    }
    for (const id of staged.fixed) this.#committed.fixed.add(id);
    for (const [kind, request] of staged.requests) this.#committed.requests.set(kind, request);
    for (const key of staged.paragraphs) this.#committed.paragraphs.add(key);
    for (const [managerId, shown] of staged.reports) this.#committed.reports.set(managerId, shown);
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
      reports: new Map(),
    };
    return this.#staged;
  }

  /**
   * 担当 `managerId` の報告 `text` を、全文のまま発言に載せた（束の予算で省いた・切り詰めた報告は渡さない）。確定は `commit` の後。
   * `manager_report` が同じ本文を引き直すときの重複を畳む控えで、鍵は担当 id と本文そのもの（台帳の `lastReport` と同じ文字列）。
   * 担当ごとに最新の1件だけ持つ: 台帳が持つのも最新の1件のため。
   */
  reportShown(managerId: string, text: string, at: Date): void {
    if (text.length < REPORT_SHOWN_MIN_CHARS) return;
    this.#stage().reports.set(managerId, { key: paragraphKey(text), chars: text.length, at });
  }

  /** 確定した控えがあれば、全文を発言に載せた時刻。無ければ（reset 後・押し込めなかった回・別の本文）`null` で、呼び手は全文を返す。 */
  reportShownAt(managerId: string, text: string): Date | null {
    const shown = this.#committed.reports.get(managerId);
    if (shown === undefined || shown.chars !== text.length) return null;
    return shown.key === paragraphKey(text) ? shown.at : null;
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
   * ターンの途中（道具の応答）で出す固定の文言。`fixed` と同じ判定で、控えへの確定だけが違う。
   * `fixed` にしない理由: 控えの確定（`commit`）は入力を押し込めた直後の1回きりで、道具の呼び出しはその後に起きる。
   * `fixed` で足した控えは次の回の頭の `discardStaged` に捨てられ、道具の応答は永久に全文のままになる。
   * 道具の応答は返した時点で会話に載るので、確定を待たずに控える。失敗したターンの後・会話が変わった・要約が走りうる回の `reset` は同じ口で効く。
   */
  fixedInTurn(id: string, full: string, ref: string): string {
    if (this.#committed.fixed.has(id)) return ref;
    this.#committed.fixed.add(id);
    return full;
  }

  /**
   * 固定の文言の控えだけを捨てる（次の回は全文）。一定ターンごとの全文戻し（situation の `SITUATION_FULL_EVERY_TURNS` と同じ線）用で、`reset` とは違い
   * 要約の軽い全文への切り替え（`#fullForced` / `#compactionReset`）には触れない: 要約の合図を取りこぼしても、全文が会話から消えたまま参照だけが続く長さに上限を置くための保険のため。
   */
  forgetFixed(): void {
    this.#committed.fixed.clear();
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
    const lean = this.isLean();
    const fullSections = new Map<string, string>();
    // 件数の行は、同じ会話の2回目以降は項目名を参照にする（数字は毎回出す）。全文へ戻す条件は `fixed()` の控えと同じ
    const out: string[] = parsed.preamble.map((line) => {
      const folded = foldDigestCountsLine(line);
      return folded === null ? line : this.fixed('digest:counts-line-labels', line, folded);
    });
    // 2節以上が同時に前回と同じなら、節ごとの参照を1行にまとめる。軽い全文の回は畳まない（省いた節の跡と混ざるため）。台帳の節はまとめない（別の参照のまま）
    const foldedNames: string[] = [];
    if (previous !== null && !lean) {
      for (const section of parsed.sections) {
        const name = foldableSameSectionName(section.heading);
        if (name === null) continue;
        const { content } = splitTrailingBlank(section.body);
        if (previous.sections.get(section.heading) === content.join('\n')) foldedNames.push(name);
      }
    }
    const foldSame = foldedNames.length >= 2;
    let foldedLineWritten = false;
    for (const section of parsed.sections) {
      const { content, trailing } = splitTrailingBlank(section.body);
      const bodyText = content.join('\n');
      if (lean) {
        const sectionName = section.heading.replace(SECTION_HEADING, '');
        const dropped = LEAN_DROPPED_SECTIONS.find((candidate) =>
          sectionName.startsWith(candidate.name),
        );
        if (dropped !== undefined) {
          // 控え（fullSections）へ入れない: 次の回の差分が「前と同じ」と畳んでも、指す先（会話の上の全文）が無いため。次の回はこの節を全文で出す
          out.push(section.heading, dropped.ref, ...trailing);
          continue;
        }
        const tallyAt = content.indexOf(SOURCE_TALLY_HEADING);
        if (sectionName.startsWith(EXTERNAL_SECTION_NAME) && tallyAt >= 0) {
          // 件名の一覧と固定の注記は残し、発行元別の件数・本文の形だけを省く。節ごと控えへ入れない（上と同じ理由）
          const kept = splitTrailingBlank(content.slice(0, tallyAt)).content;
          out.push(section.heading, ...this.#foldFixed(kept), LEAN_EXTERNAL_TALLY_REF, ...trailing);
          continue;
        }
      }
      fullSections.set(section.heading, bodyText);
      const before = previous?.sections.get(section.heading);
      if (
        foldSame &&
        previous !== null &&
        before === bodyText &&
        foldableSameSectionName(section.heading) !== null
      ) {
        if (!foldedLineWritten) {
          foldedLineWritten = true;
          out.push(
            `（前回（${clockLabel(previous.at)}）の要約から変わらない節: ${foldedNames.join('・')}。各節の全文は会話の上にある）`,
            ...trailing,
          );
        }
        continue;
      }
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
