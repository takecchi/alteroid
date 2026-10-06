import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * 承認待ちへの回答（`POST /approvals/:id/answer`・`POST /approvals/answer`）は、
 * 空白だけの `answer` や、NUL だけの `answer`（NUL は日誌・承認の入口で落ちて空になる）を
 * 受け付けて、空の回答として記録してしまわないこと。
 * 入口の検査は `answerFields.answer = z.string().min(1)`（空白も NUL も長さ1以上と数える）。
 */
function setup() {
  const stores = createMemoryStores();
  const answered: string[] = [];
  const clone: CloneHost = {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval(_id: string, answer: string) {
      answered.push(answer);
    },
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
  return { app, stores, answered };
}

async function post(app: ReturnType<typeof setup>['app'], path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

describe('承認への回答が空白だけ・NULだけのとき（空の回答として記録しない）', () => {
  it.each([
    ['空白だけ', '   '],
    ['改行とタブだけ', '\n\t'],
    ['全角空白だけ', '　'],
    ['NULだけ', '\u0000'],
  ])('POST /approvals/:id/answer は %s の answer を 400 で断る', async (_label, answer) => {
    const { app, stores, answered } = setup();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      question: '進めてよいか',
    });
    const response = await post(app, '/approvals/ap-1/answer', { answer });
    expect({ status: response.status, answered }).toEqual({ status: 400, answered: [] });
  });

  it('POST /approvals/answer（一括）は空白だけの answer を件ごとの成功にしない', async () => {
    const { app, stores, answered } = setup();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      question: '進めてよいか',
    });
    const response = await post(app, '/approvals/answer', {
      answers: [{ id: 'ap-1', answer: '   ' }],
    });
    expect({ status: response.status, answered }).toEqual({ status: 400, answered: [] });
  });
});

describe('承認への回答の検査が壊してはいけないもの（#3384）', () => {
  it('400 の文に、送られた answer の値を載せない', async () => {
    const { app, stores } = setup();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      question: '進めてよいか',
    });
    const response = await post(app, '/approvals/ap-1/answer', { answer: ' \u0000 ' });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('\\u0000');
    expect(text).not.toContain('\u0000');
    expect(JSON.parse(text)).toEqual({ error: 'answer の形が不正: answer' });
  });

  it('NUL が混じっても、落とした後に本文が残る answer は今までどおり通す（値は書き換えない）', async () => {
    const { app, stores, answered } = setup();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      question: '進めてよいか',
    });
    const response = await post(app, '/approvals/ap-1/answer', { answer: ' \u0000はい ' });
    expect({ status: response.status, answered }).toEqual({
      status: 200,
      answered: [' \u0000はい '],
    });
  });

  it('一括は、1件でも空白だけの answer があれば全体を 400 にし、誰にも答えない', async () => {
    const { app, stores, answered } = setup();
    for (const id of ['ap-1', 'ap-2']) {
      await stores.jobs.putApproval({
        id,
        createdAt: '2026-09-02T00:00:00.000Z',
        question: '進めてよいか',
      });
    }
    const response = await post(app, '/approvals/answer', {
      answers: [
        { id: 'ap-1', answer: 'はい' },
        { id: 'ap-2', answer: '\u0000' },
      ],
    });
    expect({ status: response.status, answered }).toEqual({ status: 400, answered: [] });
  });
});
