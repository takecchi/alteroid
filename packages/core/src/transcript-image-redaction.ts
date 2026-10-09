import { sha256Hex } from './auth.js';

/**
 * 生ログ（pg の sessionStore・アーカイブ・transcript）へ書く前に、添付した画像の
 * 中身（base64）を「型・大きさ・sha256 の控え」へ置き換える（#4127）。
 *
 * - **対象は user 行の content 配列の最上位の画像だけ。** tool_result の中の画像
 *   （Read の結果など）は決定の対象外なので触らない。
 * - **控えは `type:'text'` の block にする。** mirror/pg は resume の正本なので、
 *   SDK と API が受け付ける形（空にならない text block）でなければならない。
 * - **決定的にする。** 同じ入力は同じ出力（2回当てても変わらない）。
 * - **触らない行は同じ参照・同じバイトで返す。** アーカイブの連続性判定が前回本文と
 *   バイト比較しているため。
 */

// 空白を許す: 字句を決め打ちにすると、整形された行の画像を黙って素通りさせるため
const IMAGE_MARK = /"type"\s*:\s*"image"/;

type Block = { readonly type?: unknown; readonly source?: unknown };

function isBase64Image(
  block: unknown,
): block is { source: { media_type?: unknown; data: string } } {
  if (typeof block !== 'object' || block === null) return false;
  const { type, source } = block as Block;
  if (type !== 'image') return false;
  if (typeof source !== 'object' || source === null) return false;
  const s = source as { type?: unknown; data?: unknown };
  return s.type === 'base64' && typeof s.data === 'string';
}

function receiptText(block: { source: { media_type?: unknown; data: string } }): string {
  const bytes = Buffer.from(block.source.data, 'base64');
  const mediaType =
    typeof block.source.media_type === 'string' ? block.source.media_type : 'unknown';
  return `[画像の控え] type=${mediaType} size=${bytes.length} sha256=${sha256Hex(bytes)}（中身は生ログに残さない。#4127。保持期限内なら同じ発言の [添付] 行の id で attachment_fetch から引ける）`;
}

export function redactImagesInSessionEntry(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) return entry;
  const message = (entry as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return entry;
  const { role, content } = message as { role?: unknown; content?: unknown };
  const isUser = role === 'user' || (entry as { type?: unknown }).type === 'user';
  if (!isUser || !Array.isArray(content)) return entry;
  if (!content.some(isBase64Image)) return entry;
  return {
    ...entry,
    message: {
      ...message,
      content: content.map((block: unknown) =>
        isBase64Image(block) ? { type: 'text', text: receiptText(block) } : block,
      ),
    },
  };
}

export function redactImagesInEntries(entries: readonly unknown[]): unknown[] {
  return entries.map(redactImagesInSessionEntry);
}

export function redactImagesInTranscript(body: string): string {
  // 画像を含みうる行だけ触る: 他の行をパースし直すと、キー順・空白・エスケープが動いてバイト比較が崩れるため
  if (!IMAGE_MARK.test(body)) return body;
  return body
    .split('\n')
    .map((line) => {
      if (!IMAGE_MARK.test(line)) return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return line;
      }
      const redacted = redactImagesInSessionEntry(parsed);
      return redacted === parsed ? line : JSON.stringify(redacted);
    })
    .join('\n');
}
