// `EventSource` を使わない: GET しか投げられずヘッダも付けられず、デーモンの chat（`POST /chat`）に使えないため。
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

const DELIMITER = /\r\n\r\n|\n\n|\r\r/;

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const match = DELIMITER.exec(buffer);
        if (match === null) break;
        const chunk = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const message = parseSseChunk(chunk);
        if (message !== null) yield message;
      }
    }

    const rest = parseSseChunk(buffer);
    if (rest !== null) yield rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseSseChunk(chunk: string): SseMessage | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  let seen = false;

  for (const rawLine of chunk.split(/\r\n|\n|\r/)) {
    if (rawLine.length === 0 || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const rest = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');

    if (field === 'event') {
      event = rest;
      seen = true;
    } else if (field === 'data') {
      data.push(rest);
      seen = true;
    } else if (field === 'id') {
      id = rest;
      seen = true;
    }
  }

  if (!seen) return null;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}
