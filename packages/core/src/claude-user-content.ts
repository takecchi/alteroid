import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentUserInput } from './agent-session.js';

type SdkContent = SDKUserMessage['message']['content'];

function toSdkContent(next: AgentUserInput): SdkContent {
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

export async function* toSdkInput(
  input: AsyncIterable<AgentUserInput>,
): AsyncGenerator<SDKUserMessage> {
  for await (const next of input) {
    yield {
      type: 'user',
      message: { role: 'user', content: toSdkContent(next) },
      parent_tool_use_id: null,
    };
  }
}
