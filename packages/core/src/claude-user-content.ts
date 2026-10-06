/**
 * 中立のユーザー入力を、Claude SDK のユーザーメッセージの `content` へ写す。
 *
 * 画像が無ければ従来どおり**文字列のまま**返す（後方互換。画像の無い入力は1文字も変わらない）。
 * あれば text ブロック + image（base64）ブロックの配列。クローンとマネージャーの両方の駆動役が使う。
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentUserInput } from './agent-session.js';

type SdkContent = SDKUserMessage['message']['content'];

export function toSdkContent(next: AgentUserInput): SdkContent {
  const images = next.images ?? [];
  if (images.length === 0) return next.text;
  return [
    { type: 'text', text: next.text },
    ...images.map((image) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
    })),
  ];
}
