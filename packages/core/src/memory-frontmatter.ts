/**
 * 記憶の frontmatter・区分・説明の鮮度・作成時刻を、本文（`content`）から導出する場所。
 * 器（fs / pg）ごとに解釈を書かず、ここ1本に置く。
 */

import { assertNever } from './assert-never.js';
import type {
  MemoryCreatedAt,
  MemoryDescriptionDrift,
  MemoryDescriptionFreshness,
  MemoryDocKind,
  MemoryFrontmatterState,
} from './schema.js';

const FRONTMATTER_DELIMITER = '---';

const KNOWN_FRONTMATTER_KEYS = new Set(['description', 'type', 'parent']);

// YAML ライブラリを使わない: `description: no` が静かに `false` になる挙動を避け、読めなければ落ちるパーサが欲しいため
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

function frontmatterBody(content: string): string {
  return content.slice(memoryBodyStart(content));
}

// frontmatterBody と実装を分けない: 本文と本文の始まる位置が食い違うと、memory_section_move が本文の一部を frontmatter として運ぶため
// memory_section_move は frontmatter をこの添字で運ぶだけで書き直さない: `serializeMemoryFrontmatter` を通すとキーの順序まで正規化されてしまうため
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
  // content.length へ詰める: 本文が無いのに本文が在るように見えるのを避けるため
  return Math.min(offset, content.length);
}

interface MemoryFrontmatterPatch {
  description?: string;
  type?: string;
  parent?: string;
}

// キーの並びは `description` → `type` → `parent` に正規化する: 既存の順序を保つ処理ではない
function serializeMemoryFrontmatter(fields: MemoryFrontmatterPatch): string {
  const lines = [FRONTMATTER_DELIMITER];
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`);
  if (fields.type !== undefined) lines.push(`type: ${fields.type}`);
  if (fields.parent !== undefined) lines.push(`parent: ${fields.parent}`);
  lines.push(FRONTMATTER_DELIMITER);
  return lines.join('\n');
}

interface MemoryFrontmatterLineBreak {
  position: number;
  char: '\n' | '\r';
  excerpt: string;
}

const MEMORY_LINE_BREAK_EXCERPT_RADIUS = 20;

function escapeMemoryLineBreaksForDisplay(value: string): string {
  return value.replace(/\r\n/g, '\\r\\n').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

// `\r` も検査する: 単独の `\r` は目次の1行にそのまま残り、読めない行を作るため
export function findMemoryFrontmatterLineBreak(value: string): MemoryFrontmatterLineBreak | null {
  const match = /[\r\n]/.exec(value);
  if (match === null) return null;
  const index = match.index;
  const char = match[0] as '\n' | '\r';
  const start = Math.max(0, index - MEMORY_LINE_BREAK_EXCERPT_RADIUS);
  const end = Math.min(value.length, index + 1 + MEMORY_LINE_BREAK_EXCERPT_RADIUS);
  const before = escapeMemoryLineBreaksForDisplay(value.slice(start, index));
  const breakMark = escapeMemoryLineBreaksForDisplay(char);
  const after = escapeMemoryLineBreaksForDisplay(value.slice(index + 1, end));
  const excerpt =
    (start > 0 ? '…' : '') + before + breakMark + after + (end < value.length ? '…' : '');
  return { position: index + 1, char, excerpt };
}

// 本文を引数に取らず `content` をそのまま運ぶ: 本文がモデルのツール呼び出しの引数に現れないので、本文が途中で切れて通る経路が構造的に無い
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
  // 本文が空のとき `${header}\n` も `header` も無条件には返さない: `frontmatterBody` は閉じの `---` の後ろの改行の有無に関わらず空文字を返すので、元の文書の末尾で決める
  return content.endsWith('\n') ? `${header}\n` : header;
}

const KNOWN_DOC_KINDS: ReadonlySet<MemoryDocKind> = new Set(['premise', 'fact', 'indexed']);

// 綴り間違いの値を黙って書かせない: resolveMemoryDocKind が premise へ倒すので区分は変わらないのに、書き手には変えたつもりが残るため
export function isKnownMemoryDocKind(value: string): value is MemoryDocKind {
  return KNOWN_DOC_KINDS.has(value as MemoryDocKind);
}

// 区分が無い・読めない・未知の値は fact / indexed にせず premise へ倒す: 誤りが「余分に全文を焼く」だけで self_status の総文字数から気づけるが、fact にすると文書が黙って目次の1行へ縮み、気づく手段が失われるため
export function resolveMemoryDocKind(frontmatter: MemoryFrontmatterState): MemoryDocKind {
  if (frontmatter.kind !== 'parsed') return 'premise';
  const { type } = frontmatter;
  if (type !== undefined && KNOWN_DOC_KINDS.has(type as MemoryDocKind))
    return type as MemoryDocKind;
  return 'premise';
}

export function assertNeverMemoryDocKind(kind: never): never {
  return assertNever('未知の記憶の区分', kind);
}

export function resolveMemoryDescriptionFreshness(input: {
  description: string | undefined;
  describedAt: string | undefined;
  updatedAt: string;
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
  currentBytes: number;
}): MemoryDescriptionFreshness {
  if (input.description === undefined) return { kind: 'absent' };
  if (input.describedAt === undefined) return { kind: 'unknown' };
  if (input.describedAt >= input.updatedAt) return { kind: 'fresh' };
  // clamp はここ1か所に置く: 呼び出し側や表示側でも重ねると同じ異常を2箇所が別々に隠し、片方が「0（＝最新）」に化けても気づけないため
  const staleForMs = Math.max(0, Date.parse(input.updatedAt) - Date.parse(input.describedAt));
  const drift = resolveMemoryDescriptionDrift({
    describedBytes: input.describedBytes,
    describedBytesAt: input.describedBytesAt,
    describedAt: input.describedAt,
    currentBytes: input.currentBytes,
  });
  return { kind: 'stale', staleForMs, drift };
}

function resolveMemoryDescriptionDrift(input: {
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
  describedAt: string;
  currentBytes: number;
}): MemoryDescriptionDrift {
  // `describedBytes` が無いことを 0（変化なし）に見せない: 取れなかったことを変化なしに化けさせないため
  if (input.describedBytes === undefined) return { kind: 'unrecorded' };
  // `describedBytesAt` が無いときも measured: describedAt と describedBytes は必ず同時に立つので、無いのは `describedBytesAt` を持たない旧い行だけで、その describedBytes は describedAt と同時刻のものだから
  if (input.describedBytesAt === undefined || input.describedBytesAt <= input.describedAt) {
    return {
      kind: 'measured',
      describedBytes: input.describedBytes,
      currentBytes: input.currentBytes,
      deltaBytes: input.currentBytes - input.describedBytes,
    };
  }
  return {
    kind: 'at-least',
    baselineBytes: input.describedBytes,
    baselineAt: input.describedBytesAt,
    currentBytes: input.currentBytes,
    deltaBytes: input.currentBytes - input.describedBytes,
  };
}

// fs と pg で別々に書かない: 器ごとに frontmatter の解釈を書くと食い違うため
export function deriveMemoryFrontmatter(input: {
  content: string;
  updatedAt: string;
  describedAt: string | undefined;
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
  currentBytes: number;
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
    describedBytes: input.describedBytes,
    describedBytesAt: input.describedBytesAt,
    currentBytes: input.currentBytes,
  });
  return { frontmatter, kind, description, parent, descriptionFreshness };
}

// 3つの値を1つのオブジェクトで返す: 片方だけ進む状態を型の上で作れなくするため
export function nextDescribedState(input: {
  priorContent: string | null;
  nextContent: string;
  priorDescribedAt: string | undefined;
  priorDescribedBytes: number | undefined;
  priorDescribedBytesAt: string | undefined;
  priorBytes: number | undefined;
  priorUpdatedAt: string | undefined;
  writtenAt: string;
  writtenBytes: number;
}): {
  describedAt: string | undefined;
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
} {
  const priorDescription =
    input.priorContent === null
      ? undefined
      : ((state) => (state.kind === 'parsed' ? state.description : undefined))(
          parseMemoryFrontmatter(input.priorContent),
        );
  const nextState = parseMemoryFrontmatter(input.nextContent);
  const nextDescription = nextState.kind === 'parsed' ? nextState.description : undefined;

  if (priorDescription !== nextDescription) {
    return {
      describedAt: input.writtenAt,
      describedBytes: input.writtenBytes,
      describedBytesAt: input.writtenAt,
    };
  }

  // 基準点は書き込みのたびに進めない: 進めると常に直前の1回ぶんしか測れなくなるため
  if (input.priorDescribedBytes !== undefined) {
    return {
      describedAt: input.priorDescribedAt,
      describedBytes: input.priorDescribedBytes,
      describedBytesAt: input.priorDescribedBytesAt,
    };
  }

  if (input.priorBytes === undefined || input.priorUpdatedAt === undefined) {
    return {
      describedAt: input.priorDescribedAt,
      describedBytes: undefined,
      describedBytesAt: undefined,
    };
  }
  // 書いた後の値（writtenBytes / writtenAt）を基準にしない: 直後の読み出しが deltaBytes: 0 になり、欠測が「変わっていない」に見えるため
  return {
    describedAt: input.priorDescribedAt,
    describedBytes: input.priorBytes,
    describedBytesAt: input.priorUpdatedAt,
  };
}

export function assertNeverMemoryCreatedAt(createdAt: never): never {
  return assertNever('未知の記憶作成時刻の状態', createdAt);
}

// 索引に作成時刻が無い記憶は `unknown` にする: 更新時刻などで補うと、作成された時刻を知っているように見えるため
export function toMemoryCreatedAt(at: string | undefined): MemoryCreatedAt {
  return at === undefined ? { kind: 'unknown' } : { kind: 'known', at };
}

// 根拠が無ければ「不明」と明言する: 値を持たないことを空文字で隠さないため
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
