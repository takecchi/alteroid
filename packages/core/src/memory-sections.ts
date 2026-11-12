/**
 * 記憶の本文を見出しの節へ切る場所: 節の走査・節 id の lookup・切り出し・階層飛びの検査と、節の行の形。
 * memory_outline / memory_section_move と毎ターンの焼き込みが同じ節の読みを使うよう、ここ1本に置く。
 */

import { createHash } from 'node:crypto';

import { renderListing } from './excerpt.js';
import { memoryBodyStart } from './memory-frontmatter.js';

// 焼き込みの行の見出しの幅: 長い見出しは逐語の引用を含み、目次の予算の大半を食うため。節id は切らない（節を開く口は変わらない）
export const MEMORY_PROMPT_OUTLINE_HEADING_WIDTH = 80;

// 幅を超えるときだけ切る（幅 − 1 字 + 「…」）。サロゲートペアの上位だけが残ると壊れた文字になるので、そのときは1字手前で切る
export function truncateOutlineHeading(heading: string): string {
  if (heading.length <= MEMORY_PROMPT_OUTLINE_HEADING_WIDTH) return heading;
  let cut = heading.slice(0, MEMORY_PROMPT_OUTLINE_HEADING_WIDTH - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function formatMemoryCharCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatMemoryCharDelta(delta: number): string {
  return delta >= 0 ? `+${formatMemoryCharCount(delta)}` : formatMemoryCharCount(delta);
}

export function formatMemoryPercentDelta(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return '0%';
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

export interface MemorySection {
  id: string;
  heading: string;
  depth: number;
  start: number;
  end: number;
  chars: number;
}

interface MemorySectionScan {
  bodyStart: number;
  sections: MemorySection[];
}

// 見出しの文字列で指す形にしない: 書き換えを検出する材料が引数の中から消え、id が中身で変わることがこの道具の唯一の並行制御になっているため。前半8桁（見出し）を足す: 「そんな id は無い」と「その id は古い」の断りを分けるため
export function memorySectionId(heading: string, body: string): string {
  const digest = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
  return `${digest(heading)}-${digest(`${heading}\n${body}`)}`;
}

const SECTION_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;

const SECTION_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// `extractMemoryHeadings` と1本にまとめない: あちらは拾いすぎる側、こちらは拾わない側へ倒す向きが逆で、こちらが拾いすぎるとフェンスの開きだけが出どころに残り、以降が全部コードとして描かれるため
export function scanMemorySections(content: string): MemorySectionScan {
  const bodyStart = memoryBodyStart(content);
  const body = content.slice(bodyStart);
  const lines = body.split('\n');

  // 行の再結合（`join`）を通さない: 通すと改行コードの扱いで1バイト動くため
  const lineStart: number[] = [];
  let offset = bodyStart;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }

  interface Open {
    depth: number;
    heading: string;
    // 節 id は行そのもの（CRLF の `\r` 込み）で計算する: 表示値（`heading`）で計算し直すと、保存済みの CRLF の文書の節 id がすべて変わるため
    rawHeading: string;
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
        id: memorySectionId(entry.rawHeading, content.slice(Math.min(entry.bodyFrom, end), end)),
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
    // 「同じ深さ」に狭めない: `###` の節が次の `##` で終わらなくなり、子でないものを子として運ぶため
    close(start, depth);
    open.push({
      depth,
      // 表示値は CRLF の `\r` を落とす: 残すと outline の「— N 文字」が端末で行頭へ戻り、見出しを上書きするため
      heading: line.endsWith('\r') ? line.slice(0, -1) : line,
      rawHeading: line,
      start,
      bodyFrom: start + line.length + 1,
    });
  }
  close(content.length, 1);

  sections.sort((a, b) => a.start - b.start);
  return { bodyStart, sections };
}

export type MemorySectionLookup =
  | { kind: 'found'; section: MemorySection }
  | { kind: 'ambiguous'; sections: MemorySection[] }
  | { kind: 'stale'; sections: MemorySection[] }
  | { kind: 'absent' };

// ambiguous の片方を黙って選ばない: 消える側が観測できず取り違えに気づけないため。stale と absent を畳まない: 疑う先が違うため
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

// 並べ替えた列（ordered）も返す: 呼び手が再度並べ替えると同じ規則が2箇所に立ち、片方を壊してももう片方が結果を正しくして歯が赤くならないため。重なりの検査をここに重ねない: 片方を直したときにもう片方が古いままになる経路ができるため
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

// 兄弟（隣り合う節）は重なりとして拾わない: 判定を `<=` にすると、隣り合う兄弟節をまとめて移す正当な呼び出しまで断るため
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

interface MemorySectionHierarchyJump {
  readonly section: MemorySection;
  readonly parent: MemorySection;
  readonly gap: number;
}

export function findMemorySectionHierarchyJumps(
  allSections: readonly MemorySection[],
  root: MemorySection,
): readonly MemorySectionHierarchyJump[] {
  const descendants = allSections
    .filter(
      (section) => section.id !== root.id && section.start >= root.start && section.end <= root.end,
    )
    .sort((a, b) => a.start - b.start);

  const jumps: MemorySectionHierarchyJump[] = [];
  const stack: MemorySection[] = [root];
  for (const section of descendants) {
    // スタックの pop の不等号は `<=` にする: `<` にすると兄弟どうしで直前の兄弟が親として誤って残るため。root はスタックの底に置いたまま pop しない: 直近の親が見つからない万一の倒れ先を root に固定するため
    while (stack.length > 1 && (stack[stack.length - 1] as MemorySection).end <= section.start) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] as MemorySection;
    if (section.depth - parent.depth > 1) {
      jumps.push({ section, parent, gap: section.depth - parent.depth });
    }
    stack.push(section);
  }
  return jumps;
}

export const MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET = 800;

// 拒否ではなく警告にとどめる: 階層飛びは妥当な構造の可能性が残り、機械的に一意に決まる不正ではなく意味の妥当性の話で、道具には判定できないため
export function describeMemorySectionMoveHierarchyJumpWarning(
  allSections: readonly MemorySection[],
  roots: readonly MemorySection[],
): string | null {
  const perRoot = roots.map((root) => ({
    root,
    descendantCount: allSections.filter(
      (section) => section.id !== root.id && section.start >= root.start && section.end <= root.end,
    ).length,
    jumps: findMemorySectionHierarchyJumps(allSections, root),
  }));

  const descendantTotal = perRoot.reduce((sum, entry) => sum + entry.descendantCount, 0);
  const allJumps = perRoot.flatMap((entry) => entry.jumps);
  if (allJumps.length === 0) return null;

  const lines = allJumps.map(
    (jump) =>
      `- 「${jump.section.heading}」は直近の親「${jump.parent.heading}」より ${jump.gap} 階層深い（1段飛ばし以上）`,
  );
  const listing = renderListing(lines, {
    budget: MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET,
    omitted: ({ rest, total }) =>
      `…ほか ${rest} 件は一覧から省略（階層が飛んでいる子孫は全 ${total} 件）。`,
  });

  return (
    `⚠ 移した節の子孫 ${descendantTotal} 件のうち ${allJumps.length} 件は、見出しの階層が` +
    '直近の親より2段以上飛んでいる（例: `##` の子に `####` が直接ぶら下がる、間の `###` が無い）。' +
    '親と無関係な話題が、書式の都合で子として一緒に運ばれた可能性がある——妥当な構造のこともあるので' +
    '断ってはいない。移した先を memory_outline で確かめ、無関係なら memory_section_move で切り離すこと。\n' +
    listing
  );
}

// 切れるのは一覧の表示だけ: 移動そのものはこの一覧を組む前に全件の検査を通って一括で終わっているので、「一覧から省略」であって「移動していない」ではない
export const MEMORY_SECTION_MOVE_LIST_BUDGET = 2_000;

// 予算と省略の文言は共有しない: 道具は `side` で反対側を出せるが焼き込みは1回しか描かず、省いたときに何をすればよいかが違うため
// 重複は `allSections`（文書の全節）で数える: 出す範囲（offset・q の窓）の中だけで数えると、窓の外に同じ id の節があっても印が付かず、
// memory_section_move（全節で一意かを見る）に断られる id を使えると読ませるため
// 'tool' は道具の応答の行（文字数あり・見出しは全文）、'prompt' は毎ターンの焼き込みの行（文字数なし・長い見出しは切る）。
// 道具の応答の形は変えない: 全文と文字数を見たい読み手は memory_outline へ来るため
type OutlineLineForm = 'tool' | 'prompt';

export const OUTLINE_AMBIGUOUS_MARKER =
  ' ⚠この id は複数箇所に当たる。この id では動かせない（memory_section_move は断る）';

export function memorySectionLines(
  sections: readonly MemorySection[],
  allSections: readonly MemorySection[] = sections,
  form: OutlineLineForm = 'tool',
): string[] {
  const counts = new Map<string, number>();
  for (const section of allSections) counts.set(section.id, (counts.get(section.id) ?? 0) + 1);
  return sections.map((section) => {
    const indent = '  '.repeat(section.depth - 1);
    const ambiguous = (counts.get(section.id) ?? 0) > 1 ? OUTLINE_AMBIGUOUS_MARKER : '';
    return form === 'prompt'
      ? `${indent}[${section.id}] ${truncateOutlineHeading(section.heading)}${ambiguous}`
      : `${indent}[${section.id}] ${section.heading} — ${formatMemoryCharCount(section.chars)} 文字${ambiguous}`;
  });
}
