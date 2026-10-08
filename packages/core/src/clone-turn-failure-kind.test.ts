import { describe, expect, it } from 'vitest';

import { setup, waitFor, waitForTerminal } from './clone-test-harness.js';
import { toMessage } from './conversation.js';
import type { JournalEntry } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * ターン失敗の種別（`error` イベントの `kind` と、履歴の `turnFailureKind`）が、
 * 本文ではなく構造から決まり、2つの口で同じ値になること（Issue #3953）。
 *
 * **本文に `401` / `quota` を入れた対照を置いている**: 本文の語で決める実装は、構造が無い失敗を
 * `auth` / `quota` に倒すので、ここが赤くなる。
 */
describe('クローン — ターン失敗の種別を構造で運ぶ', () => {
  /** 1ターン落として、終端の `error` と、人間へ返った1行（履歴の元）を取り出す。 */
  async function failOnce(
    options: Parameters<typeof setup>[2],
  ): Promise<{ kind: string | undefined; held: JournalEntry | undefined }> {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, options);
    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    await waitFor(
      async () =>
        (await stores.journal.list({ types: ['exchange'] })).some(
          (entry) =>
            entry.type === 'exchange' &&
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.turnFailure !== undefined,
        ),
      '人間への失敗の知らせ',
    );
    const entries = await stores.journal.list({ types: ['exchange'] });
    const notice = entries.find(
      (entry) =>
        entry.type === 'exchange' &&
        entry.with === 'human' &&
        entry.role === 'outbound' &&
        entry.turnFailure !== undefined,
    );
    const terminal = s.events.find((event) => event.type === 'error');
    await s.clone.stop();
    return { kind: terminal?.type === 'error' ? terminal.kind : undefined, held: notice };
  }

  /** 履歴（`toMessage`）が運ぶ種別。 */
  const historyKindOf = (entry: JournalEntry | undefined): string | undefined =>
    entry?.type === 'exchange' ? toMessage(entry).turnFailureKind : undefined;

  it('assistant.error: authentication_failed は auth（本文が中立でも）', async () => {
    const { kind, held } = await failOnce({
      assistantErrorAt: () => ({ error: 'authentication_failed', text: 'ログインしてください' }),
      resultFor: () => ({ subtype: 'success', isError: true, text: 'ログインしてください' }),
    });
    expect(kind).toBe('auth');
    expect(historyKindOf(held)).toBe('auth');
  });

  it('assistant.error: rate_limit は quota', async () => {
    const { kind, held } = await failOnce({
      assistantErrorAt: () => ({ error: 'rate_limit', text: '混み合っています' }),
      resultFor: () => ({ subtype: 'success', isError: true, text: '混み合っています' }),
    });
    expect(kind).toBe('quota');
    expect(historyKindOf(held)).toBe('quota');
  });

  it('assistant.error だけが言う（result は成功の形）: authentication_failed は auth', async () => {
    const { kind, held } = await failOnce({
      assistantErrorAt: () => ({ error: 'authentication_failed', text: 'ログインしてください' }),
    });
    expect(kind).toBe('auth');
    expect(historyKindOf(held)).toBe('auth');
  });

  it('assistant.error: 認証でも枠でもない語（overloaded）は other', async () => {
    const { kind, held } = await failOnce({
      assistantErrorAt: () => ({ error: 'overloaded', text: '過負荷' }),
      resultFor: () => ({ subtype: 'success', isError: true, text: '過負荷' }),
    });
    expect(kind).toBe('other');
    expect(historyKindOf(held)).toBe('other');
  });

  it('result の api_error_status: 401 は auth', async () => {
    const { kind, held } = await failOnce({
      resultFor: () => ({
        subtype: 'error_during_execution',
        text: '通らなかった',
        apiErrorStatus: 401,
      }),
    });
    expect(kind).toBe('auth');
    expect(historyKindOf(held)).toBe('auth');
  });

  it('result の api_error_status: 429 は quota', async () => {
    const { kind, held } = await failOnce({
      resultFor: () => ({
        subtype: 'error_during_execution',
        text: '通らなかった',
        apiErrorStatus: 429,
      }),
    });
    expect(kind).toBe('quota');
    expect(historyKindOf(held)).toBe('quota');
  });

  it('対照: 構造が無く、本文にだけ 401 と quota が在る失敗は other（本文では決めない）', async () => {
    const { kind, held } = await failOnce({
      resultFor: () => ({
        subtype: 'error_during_execution',
        text: 'port 401 の disk quota が足りない',
        apiErrorStatus: 500,
      }),
    });
    expect(kind).toBe('other');
    expect(historyKindOf(held)).toBe('other');
  });

  it('例外で落ちた失敗は other', async () => {
    const { kind, held } = await failOnce({ failWith: 'セッションを起こせない 401' });
    expect(kind).toBe('other');
    expect(historyKindOf(held)).toBe('other');
  });

  it('枠で保持している回は quota（turnFailure: held と同じ根拠）', async () => {
    const { kind, held } = await failOnce({
      resultFor: () => ({
        subtype: 'success',
        isError: true,
        text: "You've hit your org's monthly spend limit",
      }),
    });
    expect(held?.type === 'exchange' ? held.turnFailure : undefined).toBe('held');
    expect(kind).toBe('quota');
    expect(historyKindOf(held)).toBe('quota');
  });
});
