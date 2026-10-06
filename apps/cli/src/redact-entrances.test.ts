import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  renderReport,
  renderReportLine,
  renderWaitingList,
  runSlashCommand,
  sendMessage,
  type Listed,
} from './chat.js';
import type { createClient } from './client.js';
import { renderConversationDetail } from './conversations.js';
import { errorReason, withErrorReason } from './format.js';
import { captureStdout } from './test-support.js';

/**
 * 入口（CLI）が画面へ出す本文・error の文から、トークンが消えることを測る（issue #2600）。
 * 本文には狭い網（40桁の sha・UUID は残す）、error には切らない版を掛ける。
 *
 * 偽のトークンは `ghp_` + 英数字40字（本物ではない）。
 */
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** 経路（`approvals.$get` など、`.` 区切り）から応答を決めるクライアント。 */
function routedClient(
  route: (path: string) => { status?: number; json?: unknown; text?: string },
): ReturnType<typeof createClient> {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined;
        if (!property.startsWith('$')) return node([...path, property]);
        return () => {
          const reply = route([...path, property].join('.'));
          const body = reply.text ?? JSON.stringify(reply.json ?? {});
          return Promise.resolve(
            new Response(body, {
              status: reply.status ?? 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        };
      },
    });
  return node([]) as ReturnType<typeof createClient>;
}

function emptyListed(): Listed {
  return {
    approvals: [],
    commitments: [],
    conversations: [],
    managers: [],
    managerAnchors: {},
    waiting: [],
    messages: [],
    messagesConversationId: null,
    messageAttachments: {},
  };
}

async function run(
  line: string,
  route: Parameters<typeof routedClient>[0],
  listed: Listed = emptyListed(),
): Promise<string> {
  const read = captureStdout();
  await runSlashCommand(line, routedClient(route), listed);
  return read();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectRedacted(out: string): void {
  expect(out).not.toContain(TOKEN);
  expect(out).not.toContain('ghp_a1B2c3D4e5');
}

describe('CLI の会話', () => {
  it('/conversation の発言と /conversations の preview から、トークンが消え sha は残る', () => {
    const detail = renderConversationDetail(
      'conv-1',
      [
        {
          id: 'm1',
          at: '2026-01-01T00:00:00.000Z',
          role: 'inbound',
          text: `token は ${TOKEN} で commit は ${SHA}`,
        },
      ] as Parameters<typeof renderConversationDetail>[1],
      1,
      true,
      0,
    );
    expectRedacted(detail);
    expect(detail).toContain(SHA);
  });

  it('/conversations の preview', async () => {
    const out = await run('/conversations', () => ({
      json: {
        conversations: [
          {
            conversationId: 'c1',
            startedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: 1,
            preview: `見て ${TOKEN}`,
          },
        ],
        scanned: 1,
        reachedStart: true,
      },
    }));
    expectRedacted(out);
    expect(out).toContain('c1');
  });

  it('SSE の text / ask_human の question / error / usage_limited', async () => {
    const sse =
      `event: text\ndata: ${JSON.stringify({ text: `答え ${TOKEN} ${SHA}` })}\n\n` +
      `event: ask_human\ndata: ${JSON.stringify({ approvalId: 'ap-1', question: `使う? ${TOKEN}` })}\n\n` +
      `event: usage_limited\ndata: ${JSON.stringify({ message: `枠 ${TOKEN}` })}\n\n` +
      `event: error\ndata: ${JSON.stringify({ message: `失敗 ${TOKEN}` })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(sse, { status: 200 }))),
    );
    const read = captureStdout();
    await sendMessage(
      { baseUrl: 'http://x', headers: {}, remote: false, note: null },
      'こんにちは',
      null,
    );
    const out = read();
    expectRedacted(out);
    expect(out).toContain(SHA);
    expect(out).toContain('ap-1');
    expect(out).toContain('エラー: 失敗');
  });

  it('SSE の text のチャンクをまたいだトークンも消え、本文の順は保たれる（#2635）', async () => {
    const half = TOKEN.length / 2;
    const texts = [
      `1行目 ${TOKEN.slice(0, half)}`,
      `${TOKEN.slice(half)} 続き\n2行目 ${TOKEN.slice(0, 10)}`,
      `${TOKEN.slice(10)} ${SHA}`,
    ];
    const sse =
      texts.map((text) => `event: text\ndata: ${JSON.stringify({ text })}\n\n`).join('') +
      `event: tool\ndata: ${JSON.stringify({ tool: 'Bash' })}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(sse, { status: 200 }))),
    );
    const read = captureStdout();
    await sendMessage(
      { baseUrl: 'http://x', headers: {}, remote: false, note: null },
      'こんにちは',
      null,
    );
    const out = read();
    expectRedacted(out);
    expect(out).toContain(`1行目 [REDACTED] 続き\n2行目 [REDACTED] ${SHA}\n  · Bash\n`);
  });
});

describe('CLI の委譲', () => {
  it('/manager の生ログ全文から、トークンが消え sha は残る', async () => {
    const out = await run('/manager mgr-1', () => ({
      text: `tool_use input: {"cmd":"git push https://x:${TOKEN}@github.com/a/b"}\nsha ${SHA}`,
    }));
    expectRedacted(out);
    expect(out).toContain(SHA);
  });

  it('/waiting の summary', () => {
    const { text } = renderWaitingList([
      {
        managerId: 'mgr-1',
        waiting: [
          {
            requestId: 'r1',
            kind: 'question',
            askedAt: '2026-01-01T00:00:00.000Z',
            summary: `待ち ${TOKEN}`,
          },
        ],
      },
    ] as unknown as Parameters<typeof renderWaitingList>[0]);
    expectRedacted(text);
    expect(text).toContain('mgr-1');
  });
});

describe('CLI の承認待ち', () => {
  const approval = {
    id: 'ap-1',
    question: `許可? ${TOKEN}`,
    context: `背景 ${TOKEN} ${SHA}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    answeredAt: '2026-01-02T00:00:00.000Z',
    answer: `答え ${TOKEN}`,
    conversationId: null,
  };

  it('/approvals の question・context・answer', async () => {
    const out = await run('/approvals all', () => ({ json: { approvals: [approval] } }));
    expectRedacted(out);
    expect(out).toContain(SHA);
    expect(out).toContain('ap-1');
  });

  it('/approvals の withdrawnReason', async () => {
    const out = await run('/approvals all', () => ({
      json: {
        approvals: [
          {
            ...approval,
            answeredAt: undefined,
            withdrawnAt: '2026-01-02T00:00:00.000Z',
            withdrawnReason: `理由 ${TOKEN}`,
          },
        ],
      },
    }));
    expectRedacted(out);
    expect(out).toContain('取り下げた理由');
  });

  it('/approval の詳細（設問の prompt / label / description）', async () => {
    const out = await run('/approval ap-1', () => ({
      json: {
        approval: {
          ...approval,
          questions: [
            {
              id: 'q1',
              prompt: `どれ? ${TOKEN}`,
              options: [{ id: 'o1', label: `ラベル ${TOKEN}`, description: `説明 ${TOKEN}` }],
            },
          ],
        },
        settledOn: null,
      },
    }));
    expectRedacted(out);
    expect(out).toContain('許可?');
  });
});

describe('CLI の日誌', () => {
  it('/journal の要旨（本文）', async () => {
    const out = await run('/journal', () => ({
      json: {
        entries: [
          {
            id: 'j1',
            at: '2026-01-01T00:00:00.000Z',
            type: 'message',
            text: `本文 ${TOKEN} ${SHA}`,
          },
        ],
      },
    }));
    expectRedacted(out);
    expect(out).toContain('j1');
  });

  it('日報の body と unavailable', () => {
    const body = renderReport({ date: '2026-01-01', body: `日報 ${TOKEN} ${SHA}` });
    expectRedacted(body);
    expect(body).toContain(SHA);
    expectRedacted(renderReport({ date: '2026-01-01', body: '', unavailable: `だめ ${TOKEN}` }));
    expectRedacted(
      renderReportLine({
        date: '2026-01-01',
        at: '2026-01-01T00:00:00.000Z',
        body: `日報 ${TOKEN}`,
      }),
    );
  });
});

describe('CLI の error', () => {
  it('errorReason / withErrorReason は body.error からトークンを消す', async () => {
    const response = () => ({ json: () => Promise.resolve({ error: `拒否 ${TOKEN}` }) });
    expectRedacted((await errorReason(response())) ?? '');
    expectRedacted(await withErrorReason('失敗 (500)', response()));
  });

  it('/journal の 500 の理由（withDetail）', async () => {
    const out = await run('/journal', () => ({ status: 500, json: { error: `内部 ${TOKEN}` } }));
    expectRedacted(out);
    expect(out).toContain('日誌を読めませんでした');
  });
});
