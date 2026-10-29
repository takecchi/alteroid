import { vi } from 'vitest';
import { createAttachmentDraft } from './attachments.js';
import type { Listed, SlashContext } from './chat.js';
import type { createClient } from './client.js';
import type { Target } from './target.js';

type Client = ReturnType<typeof createClient>;

const UNREACHABLE_TARGET: Target = {
  baseUrl: 'http://127.0.0.1:1',
  headers: {},
  remote: false,
  note: null,
};

// confirm の既定を承認にしない: 確認を書き忘れた試験が、戻せない操作の HTTP を黙って叩くため
export function slashArgs(
  client: Client,
  listed: Listed,
  overrides: Partial<SlashContext> = {},
): [Client, Listed, SlashContext] {
  const target = overrides.target ?? UNREACHABLE_TARGET;
  return [
    client,
    listed,
    {
      conversationId: null,
      target,
      confirm: async () => false,
      onFailed: () => {},
      hooks: {},
      auxClient: client,
      absentOkClient: client,
      removedOkClient: client,
      draft: createAttachmentDraft(target),
      signal: new AbortController().signal,
      ...overrides,
    },
  ];
}

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
