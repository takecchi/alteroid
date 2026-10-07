import { describe, expect, it } from 'vitest';

import { ApprovalsController, type DetailState } from './approvals-controller.js';
import { approvalDocument, approvalListLine } from './approvals-view.js';
import { ChatController } from './chat-controller.js';
import { approvalRow, fakeApi, journalEntry, managerRow, minute, said } from './fake-api.js';
import { journalDetailText, journalListLine } from './journal-format.js';
import { JournalController } from './journal-controller.js';
import { managerListLine } from './managers-view.js';
import { parseTranscript } from './managers-transcript.js';
import { waitFor } from './test-helpers.js';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

function expectRedacted(text: string): void {
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('ghp_a1B2c3D4e5');
}

const line = (value: unknown): string => JSON.stringify(value);

describe('TUI の会話', () => {
  it('SSE の text は、チャンクをまたいだトークンも消え、sha は残る', async () => {
    const api = fakeApi();
    const controller = new ChatController(api);
    api.scripts.push([
      { type: 'open', conversationId: 'c1' },
      { type: 'text', text: `答え ${TOKEN.slice(0, 20)}` },
      { type: 'text', text: `${TOKEN.slice(20)} ${SHA}` },
      { type: 'done' },
    ]);
    await controller.send('やあ');
    const texts = controller.store
      .getSnapshot()
      .entries.filter((e) => e.kind === 'assistant')
      .map((e) => e.text)
      .join('\n');
    expectRedacted(texts);
    expect(texts).toContain(SHA);
  });

  it('ask_human の question・usage_limited / error の message', async () => {
    const api = fakeApi();
    const controller = new ChatController(api);
    api.scripts.push([
      { type: 'open', conversationId: 'c1' },
      { type: 'ask_human', approvalId: 'ap-9', question: `使う? ${TOKEN}` },
      { type: 'usage_limited', message: `枠 ${TOKEN}` },
      { type: 'error', message: `失敗 ${TOKEN}` },
      { type: 'done' },
    ]);
    await controller.send('x');
    const all = controller.store
      .getSnapshot()
      .entries.map((e) => e.text)
      .join('\n');
    expectRedacted(all);
    expect(all).toContain('ap-9');
    expect(all).toContain('失敗');
  });

  it('履歴を開いたときの発言', async () => {
    const api = fakeApi();
    api.messages['c1'] = [
      { id: 'm1', at: minute(1), role: 'inbound', text: `token ${TOKEN} sha ${SHA}` },
    ] as never;
    const controller = new ChatController(api);
    await controller.openConversation('c1');
    const all = controller.store
      .getSnapshot()
      .entries.map((e) => e.text)
      .join('\n');
    expectRedacted(all);
    expect(all).toContain(SHA);
  });

  it('例外の message（messageOf）', async () => {
    const api = fakeApi();
    const controller = new ChatController(api);
    api.scripts.push([new Error(`落ちた ${TOKEN}`)]);
    await controller.send('x');
    const all = controller.store
      .getSnapshot()
      .entries.map((e) => e.text)
      .join('\n');
    expectRedacted(all);
    expect(all).toContain('落ちた');
  });
});

describe('TUI の委譲', () => {
  it('生ログの発言・tool_use の input・tool_result・読めない行から、トークンが消え sha は残る', () => {
    const body = [
      line({ type: 'user', message: { role: 'user', content: `依頼 ${TOKEN} ${SHA}` } }),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: `読む ${TOKEN}` },
            { type: 'tool_use', name: 'Bash', input: { command: `curl -H "x: ${TOKEN}"` } },
          ],
        },
      }),
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: `out ${TOKEN}` }] },
      }),
      `壊れた行 ${TOKEN}`,
      line({ type: 'result', detail: TOKEN }),
    ].join('\n');
    const entries = parseTranscript(body);
    const all = entries.map((e) => e.text).join('\n');
    expectRedacted(all);
    expect(all).toContain(SHA);
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  it('マネージャーの一覧の request と返事待ちの summary', () => {
    const text = managerListLine(
      managerRow('mgr-1', {
        request: `依頼 ${TOKEN}`,
        waiting: [{ requestId: 'r1', kind: 'question', summary: `待ち ${TOKEN}` }] as never,
      }),
      Date.parse('2026-10-02T01:00:00.000Z'),
    );
    expectRedacted(text);
    expect(text).toContain('mgr-1');
  });
});

describe('TUI の承認待ち', () => {
  const NOW = Date.parse('2026-10-02T01:00:00.000Z');
  const detail = (patch: Partial<DetailState>): DetailState =>
    ({
      id: 'ap-1',
      approval: null,
      missing: false,
      mode: 'read',
      form: null,
      confirm: null,
      busy: false,
      notice: null,
      noticeTone: 'info',
      error: null,
      loadedAt: NOW,
      ...patch,
    }) as DetailState;

  it('一覧の question と、詳細の question・context・設問・回答', () => {
    const row = approvalRow('ap-1', {
      question: `許可? ${TOKEN}`,
      context: `背景 ${TOKEN} ${SHA}`,
      answeredAt: '2026-10-02T02:00:00.000Z',
      answer: `答え ${TOKEN}`,
      questions: [
        {
          id: 'q1',
          prompt: `どれ? ${TOKEN}`,
          options: [{ id: 'a', label: `ラベル ${TOKEN}`, description: `説明 ${TOKEN}` }],
        },
      ],
    });
    expectRedacted(approvalListLine(row, NOW));
    const doc = approvalDocument(detail({ approval: row }), 100)
      .rows.map((r) => r.text)
      .join('\n');
    expectRedacted(doc);
    expect(doc).toContain(SHA);
    expect(doc).toContain('ap-1');
  });

  it('取り下げた理由', () => {
    const doc = approvalDocument(
      detail({
        approval: approvalRow('ap-1', {
          withdrawnAt: '2026-10-02T02:00:00.000Z',
          withdrawnReason: `理由 ${TOKEN}`,
        }),
      }),
      100,
    )
      .rows.map((r) => r.text)
      .join('\n');
    expectRedacted(doc);
    expect(doc).toContain('取り下げ');
  });

  it('読み込みの失敗の理由（messageOf）', async () => {
    const api = fakeApi();
    const controller = new ApprovalsController(api);
    api.approvalListFails = `繋がらない ${TOKEN}`;
    controller.enter();
    await waitFor(() => controller.store.getSnapshot().list.error !== null);
    const error = controller.store.getSnapshot().list.error ?? '';
    expectRedacted(error);
    expect(error).toContain('繋がらない');
  });
});

describe('TUI の日誌', () => {
  it('詳細の全文・一覧の要旨', () => {
    const entry = said(1, `本文 ${TOKEN} ${SHA}`);
    const detail = journalDetailText(entry);
    expectRedacted(detail);
    expect(detail).toContain(SHA);
    expectRedacted(journalListLine(entry, Date.parse('2026-10-02T01:00:00.000Z')));
    const nested = journalDetailText(
      journalEntry('x', 'decision', minute(0), { decision: '進める', grounds: TOKEN }),
    );
    expectRedacted(nested);
  });
});

describe('TUI の error', () => {
  it('日誌の読み込みの失敗の理由（messageOf）', async () => {
    const api = fakeApi();
    api.journalListFails = `繋がらない ${TOKEN}`;
    const controller = new JournalController(api, {});
    controller.enter();
    await waitFor(() => controller.store.getSnapshot().status === 'error');
    const error = controller.store.getSnapshot().error ?? '';
    expectRedacted(error);
    expect(error).toContain('繋がらない');
  });
});
