import { tailByCodePoints } from './excerpt.js';

/**
 * 蒸留（PreCompact・退避の拾い直し）へ渡す会話ログの末尾を作る（#5306）。
 *
 * 生の JSONL を文字数で切るだけだと、JSON の外枠・メタ情報・tool_result の全文に上限の字数を食われ、
 * 人間の発言が入る区間が短くなる。行ごとに「発言者: テキスト」へ整形してから切る。
 *
 * - **読めない行・形が想定外の行は、そのまま残す。** 捨てて蒸留の材料を黙って減らさない
 * - **整形が例外で落ちたら、生の末尾へ戻る**（{@link distillTailOf}）。蒸留は生存条件なので、整形の不具合で止めない
 * - 切り詰めるのは tool_use の入力・tool_result・thinking だけ。user / assistant の text は1文字も削らない
 *   （全文は退避に残っているので、削った tool_result は後から引ける）
 */

const TOOL_USE_INPUT_CHARS = 200;
const TOOL_RESULT_CHARS = 300;
const THINKING_CHARS = 500;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 先頭から `max` 字（UTF-16 の単位。サロゲートペアの途中では切らない）。切ったら省略した字数を添える。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…（以降 ${String(text.length - end)} 字を省略）`;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
          return part['text'];
        }
        if (isObject(part) && part['type'] === 'image') return '[画像]';
        return JSON.stringify(part);
      })
      .join(' ');
  }
  return JSON.stringify(content) ?? '';
}

/** 1つの block を整形する。空なら `''`（何も出さない）。 */
function formatBlock(speaker: string, block: unknown): string {
  // 想定外の block は、省略せずそのまま出す
  if (!isObject(block)) return JSON.stringify(block);
  const type = block['type'];
  if (type === 'text' && typeof block['text'] === 'string') {
    return block['text'].length === 0 ? '' : `${speaker}: ${block['text']}`;
  }
  if (type === 'thinking' && typeof block['thinking'] === 'string') {
    return block['thinking'].length === 0
      ? ''
      : `${speaker}(thinking): ${clip(block['thinking'], THINKING_CHARS)}`;
  }
  if (type === 'tool_use' && typeof block['name'] === 'string') {
    const input = JSON.stringify(block['input']) ?? '';
    return `${speaker}: [tool_use] ${block['name']} ${clip(oneLine(input), TOOL_USE_INPUT_CHARS)}`;
  }
  if (type === 'tool_result') {
    const label = block['is_error'] === true ? 'tool_result error' : 'tool_result';
    return `${speaker}: [${label}] ${clip(oneLine(toolResultText(block['content'])), TOOL_RESULT_CHARS)}`;
  }
  if (type === 'image') return `${speaker}: [画像]`;
  return JSON.stringify(block);
}

/** 1行を整形する。整形しない（そのまま残す）ときは `null`。 */
function formatLine(line: string): string | null {
  if (!line.trimStart().startsWith('{')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(entry)) return null;
  const speaker = entry['type'];
  if (speaker !== 'user' && speaker !== 'assistant') return null;
  const message = entry['message'];
  if (!isObject(message)) return null;
  const content = message['content'];
  if (typeof content === 'string') return content.length === 0 ? null : `${speaker}: ${content}`;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block: unknown) => formatBlock(speaker, block))
    .filter((s) => s !== '');
  return parts.length === 0 ? null : parts.join('\n');
}

/** 末尾の窓の先頭の行が途中から始まっているかもしれない（呼び出し側が切り詰めた）ときは、読めない先頭行を捨てる。 */
export interface FormatOptions {
  readonly startsMidLine: boolean;
}

/** 生の JSONL を「発言者: テキスト」の行へ整形する。読めない行はそのまま残す。 */
export function formatTranscriptForDistill(raw: string, options: FormatOptions): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const formatted = formatLine(line);
    if (formatted !== null) {
      out.push(formatted);
      return;
    }
    // 切れた窓の先頭の断片は JSON として読めず、蒸留に渡しても材料にならない（従来の tailOf も最初の改行までを捨てていた）
    if (index === 0 && options.startsMidLine && !parses(line)) return;
    out.push(line);
  });
  return out.join('\n');
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * 蒸留に渡す末尾。整形してから `maxChars`（コードポイント）で末尾側を切り、切ったなら行の途中から始めない。
 * 整形が例外で落ちたら生の末尾へ戻る（蒸留を止めない）。
 *
 * `maxChars` を `.length` で数えない: コードポイントで数える `TranscriptArchive.readTail` と食い違い、
 * 切り詰めていない本文の先頭を静かに消す。判定は「切り詰めた結果が元の文字列と一致するか」で行う。
 *
 * 入力が `maxChars` を超えているときは、窓の先頭が行の途中かもしれないとみなす
 * （`readTranscriptTail` と `TranscriptArchive.readTail` はどちらも、切り詰めるときに `maxChars + 1` 字以上を返す）。
 */
export function distillTailOf(
  transcript: string,
  maxChars: number,
  format: (raw: string, options: FormatOptions) => string = formatTranscriptForDistill,
): string {
  const startsMidLine = tailByCodePoints(transcript, maxChars) !== transcript;
  let source: string;
  try {
    source = format(transcript, { startsMidLine });
  } catch {
    // 整形の不具合で蒸留を止めない: 蒸留は生存条件。今までの生の末尾に戻る
    source = transcript;
  }
  const cut = tailByCodePoints(source, maxChars);
  if (cut === source) return source;
  const newline = cut.indexOf('\n');
  return newline === -1 ? cut : cut.slice(newline + 1);
}
