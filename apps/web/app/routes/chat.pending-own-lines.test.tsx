// @vitest-environment jsdom
/**
 * `pendingOwnLines`（issue #446 の筋書き2 — 同じ会話へ繰り返し戻って発言を
 * 続けても `lines` が増え続けないようにする側）の歯。
 *
 * PR #467 は「異なる会話を切り替えて回る」筋書き1だけを直し、「同じ会話へ
 * 繰り返し戻る」筋書き2は意図的に見送った——見送った理由は、素朴に「サーバの
 * 履歴が引き取ったか」で刈ると、**履歴の再取得がまだ空を返している窓で、
 * 届いたばかりの行を画面から消してしまう**という別の失敗を持ち込むためである
 * （`grep -Fn -- 'issue #446 の筋書き2' apps/web/app/routes/chat.tsx`）。
 *
 * `pendingOwnLines` はこれを「一致が確認できた行だけを落とす」構造で避ける
 * ——一致が無ければ理由を問わず残す。ここではその純関数を直接測り
 * （前半）、実際に画面へ組み込んだときにも同じ性質が保たれること・かつ
 * **新しい表示バグ（ストリーミング中の返信が、内容の偶然の一致で刈られて
 * 以後のチャンクを取りこぼす）を持ち込んでいないこと**を確かめる（後半）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '~/hooks/use-journal-live';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Chat, { pendingOwnLines } from './chat';

/**
 * `pendingOwnLines` 単体の歯。component を描かずに直接測る
 * （`retainedBy` の単体の歯と同じ作法。`chat.test.tsx` 参照）。
 */
describe('pendingOwnLines（issue #446 の筋書き2）', () => {
  const 行 = (text: string, role: 'human' | 'clone' = 'human', of = 'conv-a') => ({
    key: `k-${role}-${text}`,
    role,
    text,
    of,
  });

  it('historyLines に同じ role・本文の行があれば、手元の行は落ちる（引き取られた）', () => {
    const lines = [行('やあ')];
    const historyLines = [行('やあ')];

    expect(pendingOwnLines(lines, 'conv-a', historyLines)).toHaveLength(0);
  });

  it('一致が無ければ、理由を問わず残る（履歴が空でも、本文が違っても）', () => {
    const lines = [行('やあ'), 行('元気？')];
    expect(pendingOwnLines(lines, 'conv-a', [])).toHaveLength(2);
    expect(pendingOwnLines(lines, 'conv-a', [行('別の話')])).toHaveLength(2);
  });

  it('role が違えば一致しない（同じ本文でも human と clone は別物）', () => {
    const lines = [行('了解', 'human')];
    const historyLines = [行('了解', 'clone')];

    expect(pendingOwnLines(lines, 'conv-a', historyLines)).toHaveLength(1);
  });

  it('同じ本文が複数あっても1件ずつしか消さない（多重集合の照合）', () => {
    const lines = [行('ok'), 行('ok'), 行('ok')];
    const historyLines = [行('ok')];

    const pending = pendingOwnLines(lines, 'conv-a', historyLines);
    expect(pending).toHaveLength(2);
  });

  it('いま見ている会話（shownId）以外の行は、一致のいかんによらず結果に出さない（ownedBy と同じ絞り）', () => {
    // `pendingOwnLines` は `ownedBy(lines, shownId)` から出発する——conv-b の
    // 行は shownId が conv-a である限り、そもそも候補にすら入らない
    // （`historyLines` 側の `of` は見ない。「いま見ている会話向け」を渡す
    // 責務は呼び出し側にある）。historyLines を空にして、conv-b の行が
    // 「一致が無いから残る」形で紛れ込んでいないことを確かめる。
    const lines = [行('やあ', 'human', 'conv-a'), 行('別の話', 'human', 'conv-b')];

    const pending = pendingOwnLines(lines, 'conv-a', []);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe('やあ');
  });
});

const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  useJournalLive();
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial: string) {
  const router = createMemoryRouter(
    [
      { path: '/chat', Component: Harness },
      { path: '/chat/:conversationId', Component: Harness },
    ],
    { initialEntries: [initial] },
  );
  return {
    router,
    ...render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    ),
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

async function send(text: string) {
  const box = await screen.findByPlaceholderText(/クローンに話しかける/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /送る/ }));
}

const transcript = () => screen.getByRole('list', { name: 'やりとり' });

/**
 * **本命: 刈り込みを強めても、ストリーミング中の返信を壊さない。**
 *
 * `pendingOwnLines` による刈り込み（`chat.tsx` の `ChatPane` 内の不変条件
 * チェック）は「役割＋本文が完全一致すれば引き取られたとみなして落とす」。
 * これをそのまま state（`lines`）へ適用すると、**いままさに `append` が
 * `key` で引いて継ぎ足している途中の返信**が、たまたま**過去の別の返信と
 * 同じ本文になった瞬間**に刈られてしまい、そのあとに届くチャンクが
 * `append` の `findIndex` で見失われて静かに捨てられる——という新しい表示
 * バグを持ち込みうる（`chat.tsx` の `activeReplyKeyRef` の doc）。
 *
 * ここでは実際にその状況（新しい返信の最初のチャンクが、既に履歴にある
 * 過去の返信 `OK` とちょうど一致し、そのあとにもう1チャンク続く）を組み立て、
 * **最終的な本文が丸ごと（後続チャンクを含めて）画面に残る**ことを確かめる。
 * `activeReplyKeyRef` の除外が無ければ、後続チャンクが失われて `OK` だけが
 * 残ってしまう（このテストはその失敗を検出できる）。
 */
describe('ストリーミング中の返信を、内容の偶然の一致で刈らない', () => {
  const CONVERSATION_ID = 'conv-1';

  it('最初のチャンクが過去の返信と一致しても、後続のチャンクは失われない', async () => {
    const route: Route = (url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            // 1個目のチャンクが、下の履歴にある過去の返信とちょうど同じ本文になる。
            { event: 'text', data: { type: 'text', text: 'OK' } },
            { event: 'text', data: { type: 'text', text: '、以上です' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            // 過去の別のやりとりで、クローンが全く同じ本文 `OK` を返している。
            { id: 'm0', at: '2026-08-01T00:00:00Z', role: 'inbound', text: '前の質問' },
            { id: 'm0b', at: '2026-08-01T00:00:01Z', role: 'outbound', text: 'OK' },
          ],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    stubFetch(route);

    renderChat(`/chat/${CONVERSATION_ID}`);
    await screen.findByText('前の質問');

    await send('もう一度聞きたい');

    // 完成した返信が、後続チャンクぶんも含めてまるごと出る。
    expect(await within(transcript()).findByText('OK、以上です')).toBeTruthy();
    // 過去の返信 `OK`（履歴）と、いま届いた `OK、以上です`（新しい返信）は
    // 別の吹き出しとして両方残る——新しい返信が古い `OK` に吸収されて消えて
    // いない。
    expect(within(transcript()).getByText('OK', { selector: 'p' })).toBeTruthy();
  });
});

/**
 * **同じ会話へ繰り返し戻って発言を続けても、届いたばかりの行は画面から
 * 消えない。**
 *
 * `chat.duplicate-on-invalidate.test.tsx` と同じ土台（`journal/stream` の
 * `exchange(with:'human')` による無効化。同じ会話を開いたまま発言する形）を
 * 使い、**2往復ぶん**繰り返す——1往復目が履歴へ引き取られて手元の写しが
 * 刈られたあとも、2往復目でまだ引き取られていない発言が画面から消えない
 * ことを確かめる。
 */
describe('同じ会話へ繰り返し戻っても、届いたばかりの行は消えない（issue #446 の筋書き2）', () => {
  const CONVERSATION_ID = 'conv-1';

  it('1往復目が履歴へ引き取られたあと、2往復目の発言は消えずに残る', async () => {
    let afterFirstRoundSettled = false;
    let releaseInvalidation: () => void = () => {};
    const invalidationReleased = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });

    const route: Route = (url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'evt-1',
                at: '2026-08-20T00:00:10.000Z',
                with: 'human',
                role: 'inbound',
                text: '1回目の発言',
                conversationId: CONVERSATION_ID,
              },
              after: invalidationReleased,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'はい' } },
            { event: 'done', data: { type: 'done' } },
          ],
          { signal: init?.signal },
        );
      }
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json(
          afterFirstRoundSettled
            ? {
                conversationId: CONVERSATION_ID,
                messages: [
                  {
                    id: 'm1',
                    at: '2026-08-20T00:00:05.000Z',
                    role: 'inbound',
                    text: '1回目の発言',
                  },
                  { id: 'm2', at: '2026-08-20T00:00:06.000Z', role: 'outbound', text: 'はい' },
                ],
              }
            : { conversationId: CONVERSATION_ID, messages: [] },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    };
    const stub = stubFetch(route);
    const detailFetchCount = () =>
      stub.calls.filter((url) => url.includes(`/conversations/${CONVERSATION_ID}`)).length;

    renderChat(`/chat/${CONVERSATION_ID}`);

    // 1往復目。
    await send('1回目の発言');
    expect(within(transcript()).getAllByText('1回目の発言')).toHaveLength(1);
    await screen.findByText('はい');

    // サーバ側は既に1往復目を日誌へ載せている体にしてから、無効化を届かせる
    // （`chat.duplicate-on-invalidate.test.tsx` と同じ順序の理由）。
    afterFirstRoundSettled = true;
    const detailFetchesBefore = detailFetchCount();
    releaseInvalidation();
    await waitFor(() => {
      expect(detailFetchCount()).toBeGreaterThan(detailFetchesBefore);
    });
    // 1往復目は履歴側からも出るので、重複なく1回だけ見える。
    expect(within(transcript()).getAllByText('1回目の発言')).toHaveLength(1);
    expect(within(transcript()).getAllByText('はい')).toHaveLength(1);

    // 2往復目。まだサーバの履歴には無い、届いたばかりの発言。
    await send('2回目の発言（まだ履歴に無い）');
    expect(within(transcript()).getAllByText('2回目の発言（まだ履歴に無い）')).toHaveLength(1);
    await screen.findByText('はい', {}, { timeout: 3000 });

    // **1往復目・2往復目のどちらも、消えずに1回ずつ見えている。**
    expect(within(transcript()).getAllByText('1回目の発言')).toHaveLength(1);
    expect(within(transcript()).getAllByText('2回目の発言（まだ履歴に無い）')).toHaveLength(1);
  });
});
