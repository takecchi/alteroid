import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSlashCommand, type Listed } from './chat.js';
import type { createClient } from './client.js';
import { captureStdout } from './test-support.js';

/**
 * `/` コマンドの読み出し・書き込みが失敗したとき、**状態コードも理由も出さずに固定の
 * 文言だけを返す口**が無いことを測る（PR #2175 / PR #2256 が直さなかった残り）。
 *
 * どの経路（`client.<何か>.$get()` など）を叩いても、指定した状態コードと本文で答える
 * クライアントを Proxy で作る。**経路ごとにスタブを手で書かない** ⟹ 口を増やしたときに
 * 「スタブを足し忘れて緑」にならず、この表に行を足すだけで守られる。
 */
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

/** 失敗（500 + `{ error }`）を、理由つきで出さなければならない口。1行が1つの口。 */
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

  /**
   * 「無い」を意味する 404 は、これまでの文言のまま残す（理由を足すために潰さない）。
   * 失敗（500 等）が「無い」に化けていた口だけが、404 のときだけ「無い」と言う。
   */
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
