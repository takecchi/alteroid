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
