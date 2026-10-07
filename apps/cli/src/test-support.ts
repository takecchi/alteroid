import { vi } from 'vitest';

// `vi.restoreAllMocks()` を呼ばない: 同じテストが張った他の spy（`fetch` など）まで戻してしまうため
export function captureStdout(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join('');
}

export function captureStderr(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join('');
}

export function pretendTty(isTty: boolean): () => void {
  const streams = [process.stdin, process.stdout] as const;
  const saved = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  for (const stream of streams) {
    Object.defineProperty(stream, 'isTTY', { value: isTty, configurable: true, writable: true });
  }
  return () => {
    streams.forEach((stream, index) => {
      const descriptor = saved[index];
      if (descriptor === undefined) Reflect.deleteProperty(stream, 'isTTY');
      else Object.defineProperty(stream, 'isTTY', descriptor);
    });
  };
}

export function pretendStdinTty(isTty: boolean): () => void {
  const saved = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {
    value: isTty,
    configurable: true,
    writable: true,
  });
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.stdin, 'isTTY');
    else Object.defineProperty(process.stdin, 'isTTY', saved);
  };
}
