export interface SSEEvent {
  name: string;
  data: string;
  json<T>(): T | null;
}

export function parseSSEChunk(chunk: string): SSEEvent | null {
  let name = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;

  const data = dataLines.join('\n');
  return {
    name,
    data,
    json<T>(): T | null {
      try {
        return JSON.parse(data) as T;
      } catch {
        return null;
      }
    },
  };
}
