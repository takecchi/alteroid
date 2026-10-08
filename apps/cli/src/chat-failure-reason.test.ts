import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSlashCommand, type Listed } from './chat.js';
import type { createClient } from './client.js';
import { captureStdout } from './test-support.js';

function replyingClient(status: number, rawBody: string): ReturnType<typeof createClient> {
  const respond = () =>
    Promise.resolve(
      new Response(rawBody, { status, headers: { 'content-type': 'application/json' } }),
    );
  const node = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, property) =>
        typeof property === 'string' && property.startsWith('$') ? respond : node(),
    });
  return node() as ReturnType<typeof createClient>;
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
    messageTexts: {},
  };
}

async function run(line: string, status: number, rawBody: string): Promise<string> {
  const read = captureStdout();
  await runSlashCommand(line, replyingClient(status, rawBody), emptyListed());
  const text = read();
  vi.restoreAllMocks();
  return text;
}

const REASON = '理由の目印（chat-failure-reason のテスト用）';

const FAILURE_MOUTHS: readonly (readonly [name: string, line: string])[] = [
  ['/report <日付>', '/report 2026-01-01'],
  ['/report', '/report'],
  ['/reports', '/reports'],
  ['/schedule（一覧）', '/schedule'],
  ['/schedule（仕込む）', '/schedule nightly 10:00 何かをする'],
  ['/unschedule', '/unschedule nightly'],
  ['/run', '/run nightly'],
  ['/event', '/event src 本文'],
  ['/memory（一覧）', '/memory'],
  ['/memory <slug>', '/memory some-slug'],
  ['/journal', '/journal'],
  ['/conversations', '/conversations'],
  ['/conversation', '/conversation conv-1'],
  ['/waiting', '/waiting'],
  ['/manager', '/manager mgr-1'],
  ['/archive sessions', '/archive sessions'],
  ['/archive（一覧）', '/archive'],
  ['/archive <id>', '/archive sess-1.jsonl'],
  ['/approvals', '/approvals'],
  ['/approval-trace', '/approval-trace appr-1'],
  ['/answer', '/answer appr-1 はい'],
  ['/answers', '/answers appr-1 はい'],
  ['/commitments', '/commitments'],
  ['/commitment <id>', '/commitment cmt-1'],
  ['/schedule-show', '/schedule-show nightly'],
  ['/usage', '/usage'],
  ['/reply（requestId から宛先を引く）', '/reply req-1 こんにちは'],
  ['/allow（宛先なし）', '/allow'],
];

describe('chat の / コマンドの失敗は、状態コードか理由を出す', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(FAILURE_MOUTHS)('%s: 500 と { error } ならデーモンの理由が載る', async (_name, line) => {
    const text = await run(line, 500, JSON.stringify({ error: REASON }));
    expect(text).toContain(REASON);
  });

  it.each(FAILURE_MOUTHS)(
    '%s: 本文が JSON でない 500 なら状態コードが載る（理由は読めない）',
    async (_name, line) => {
      const text = await run(line, 500, '<html>Bad Gateway</html>');
      expect(text).toContain('500');
    },
  );

  it.each([
    ['/report 2026-01-01', 'の日報はありません'],
    ['/unschedule nightly', 'という継続中の依頼はありません'],
    ['/run nightly', 'という定期ジョブはありません'],
    ['/memory some-slug', 'そんな記憶はありません'],
    ['/manager mgr-1', 'そのマネージャーの生ログはまだありません'],
    ['/archive sess-1.jsonl', 'その生ログはありません'],
  ])('%s: 404 は「無い」のまま', async (line, sentence) => {
    const text = await run(line, 404, JSON.stringify({ error: 'not found' }));
    expect(text).toContain(sentence);
  });

  it.each([
    ['/report 2026-01-01', 'の日報はありません'],
    ['/unschedule nightly', 'という継続中の依頼はありません'],
    ['/run nightly', 'という定期ジョブはありません'],
    ['/memory some-slug', 'そんな記憶はありません'],
    ['/manager mgr-1', 'そのマネージャーの生ログはまだありません'],
    ['/archive sess-1.jsonl', 'その生ログはありません'],
  ])('%s: 500 を「無い」と言わない', async (line, sentence) => {
    const text = await run(line, 500, JSON.stringify({ error: REASON }));
    expect(text).not.toContain(sentence);
  });
});
