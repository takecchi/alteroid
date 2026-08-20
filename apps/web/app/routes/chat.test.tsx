// @vitest-environment jsdom
/**
 * 新しい会話の**最初の応答が最後まで画面に残る**こと。
 *
 * 新しい会話の id は受信の途中（`open`）で決まり、そこで URL を揃える。ここで
 * 画面を作り直すと、その cleanup が同じリクエストを中断し、続く text / done が
 * 二度と届かない — しかも「静かに終わった」ようにしか見えない。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

import Chat from './chat';

const CONVERSATION_ID = 'conv-1';

/**
 * **本物の `Chat` を描く。**
 *
 * 直したのは `Chat` が `ChatPane` をどう置くか（`key` を付けない）なので、
 * `ChatPane` を自分で組み立てて試すと、まさに直した所を迂回してしまう。
 * framework mode が渡す `loaderData` だけを手で与える。
 */
const ChatRoute = Chat as unknown as (props: {
  loaderData: { conversationId: string | undefined };
}) => React.ReactElement;

function Harness() {
  const params = useParams();
  return <ChatRoute loaderData={{ conversationId: params.conversationId }} />;
}

function renderChat(initial = '/chat') {
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

const STREAM = [
  { event: 'open', data: { conversationId: CONVERSATION_ID } },
  { event: 'thinking', data: { type: 'thinking' } },
  { event: 'text', data: { type: 'text', text: 'こんにちは' } },
  { event: 'text', data: { type: 'text', text: '、元気にやっている' } },
  { event: 'done', data: { type: 'done' } },
];

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

/**
 * この画面には**名前の違う list が2つ**ある（やりとりと会話一覧）。
 *
 * 同じ本文が両方に出るのは正しい（送った直後は、サーバの `/conversations` も
 * 自分の発言を抜粋にする）。だから本文を探すときは、どちらを見ているのかを
 * 必ず言うこと — 画面全体で探すと、二度当たるか、当たった側を取り違える。
 */
const transcript = () => screen.getByRole('list', { name: 'やりとり' });
const conversationList = () => screen.getByRole('list', { name: '会話' });

describe('新しい会話', () => {
  it('open で URL が変わっても、受信中のストリームが切れない', async () => {
    const stub = stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      // **サーバは既に同じやりとりを持っている体にする。** 人間の発言は受理した
      // 時点で日誌へ載り（`clone.ts` の `#record`）、返信もターンの終わりに載る
      // ので、履歴を読み直せば同じ2件が返ってくるのが実物の姿である。
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({
          conversationId: CONVERSATION_ID,
          messages: [
            { id: 'm1', at: '2026-08-20T00:00:00Z', role: 'inbound', text: 'やあ' },
            {
              id: 'm2',
              at: '2026-08-20T00:00:01Z',
              role: 'outbound',
              text: 'こんにちは、元気にやっている。',
            },
          ],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');

    // open の後に届いた分まで、全部同じ画面に残っている
    expect(await screen.findByText(/こんにちは、元気にやっている/)).toBeTruthy();
    // 自分の発言も消えていない
    // **やりとりの中に限って**見る。送信は会話一覧の抜粋にも即座に映るので
    // （`useRecordOwnMessage`）、画面全体で探すと同じ本文に二度当たる。
    expect(within(transcript()).getByText('やあ')).toBeTruthy();

    // URL は id へ揃っている
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/chat/${CONVERSATION_ID}`);
    });

    // **履歴を読み直していない。** この画面で始めた会話は手元の内容が全文なので、
    // 日誌から再構成したものを重ねると同じ発言が二重に出る。
    //
    // ↑ **期待値を反転させた（#92）。** この「読み直さない」は、同時に
    // 「サーバ側で後から進んだぶんをこの画面は永久に受け取らない」ことでもあった
    // — 枠（利用上限）で保持された発言の返信が、同じタブに居続ける限り出ない。
    // 人間の「あとで良いのでちゃんと返信してほしい」が満たされない経路がここで、
    // 現行の欠陥を仕様として固定していたのがこの1行である。
    //
    // **保証は弱くなっていない。** このテストが守っているのは「二重に出ない」
    // ことであって「読み直さない」ことではない。読み直したうえで二重に出ない
    // ことを、下の2つで直接見ている（`getByText` は2件当たると投げるので、
    // 上の2つのアサーションも二重描画では落ちる）。
    await waitFor(() => {
      expect(stub.calls.some((url) => url.includes(`/conversations/${CONVERSATION_ID}`))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(within(transcript()).getAllByText('やあ')).toHaveLength(1);
      expect(within(transcript()).getAllByText(/こんにちは、元気にやっている/)).toHaveLength(1);
    });
  });

  it('受信が終わると入力へ戻る（送信中のままにしない）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    await screen.findByText(/こんにちは、元気にやっている/);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /受信をやめる/ })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /送る/ })).toBeTruthy();
  });

  /**
   * 送ったものが**会話一覧に即座に出る**こと。
   *
   * 一覧はサーバが日誌を走査して組み立てるので、SSE の往復を待つと目に見えて
   * 遅い（「送ったのに会話一覧に出てこない」）。だから `open` で会話 id が
   * 確定した時点で、暫定値を先に入れている（`useRecordOwnMessage`）。
   *
   * **ここを固定しておかないと、あの反映が消えても誰も気づけない。**
   */
  it('送ると、会話一覧にその抜粋が即座に現れる', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      // サーバは何も返さない。一覧に出るなら、それは手元で入れた分である。
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    // 一覧が空のまま描かれている（この時点では list ごと出ていない）
    await screen.findByText('まだ会話がない。');

    await send('やあ');

    // **`<ul>` が出るのを待つ。** 一覧が空のあいだは list ごと描かれないので
    // （`まだ会話がない。` に差し替わる）、先に掴もうとすると存在しない。
    await waitFor(() => conversationList());
    expect(within(conversationList()).getByText('やあ')).toBeTruthy();
  });
});

describe('受信をやめる', () => {
  /**
   * 人間が購読だけ止めたとき。
   *
   * クローンのターンは止まらないので「やめた」のは受信だけだが、**画面には
   * 止まったことが見えていなければならない**。進行中の合図が残ると、動いていない
   * ものを動いているように見せ続けることになる。
   */
  it('進行中の合図が消え、それまでの本文は残る', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'ここまでは届いた' } },
            { event: 'thinking', data: { type: 'thinking' } },
          ],
          // まだ考えている（`done` を送らない）
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    /*
     * **本文が届くまで待ってから止める。**
     *
     * 「考えている…」は送信の瞬間から出ているので、それだけを待って止めると、
     * この筋書きが要る状態（本文が届いていて、なお進行中）へ入る前に止めてしまう。
     * ここで待っているのはサーバから来た `thinking`（本文の後に出るのはそれしか
     * 出どころが無い）で、止める対象を取り違えないための順番でもある。
     */
    await screen.findByText('ここまでは届いた');
    expect(await screen.findByText('考えている…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /受信をやめる/ }));

    // ① 進行中の合図が消える
    await waitFor(() => {
      expect(screen.queryByText('考えている…')).toBeNull();
    });
    // ② 送信できる状態へ戻る
    expect(screen.getByRole('button', { name: /送る/ })).toBeTruthy();
    // ③ それまでに届いた本文は残る
    expect(screen.getByText('ここまでは届いた')).toBeTruthy();
    expect(within(transcript()).getByText('やあ')).toBeTruthy();
  });

  it('ツール実行中の表示でも同じ', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'tool', data: { type: 'tool', tool: 'manager_start' } },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText(/manager_start を実行中/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /受信をやめる/ }));

    await waitFor(() => {
      expect(screen.queryByText(/manager_start を実行中/)).toBeNull();
    });
    expect(screen.getByRole('button', { name: /送る/ })).toBeTruthy();
  });
});

/**
 * 「考えている…」を**いつ出すか**。
 *
 * クローンは受信箱を一件ずつ取り出して直列に処理する（`docs/architecture.md` の
 * 同時実行モデル）。サーバが `thinking` を送るのは自分のターンが始まってからで、
 * 先客（蒸留・マネージャーとの往復・自律の起点）が走っているあいだは何も来ない。
 * **待ち時間が長いときこそ来ない。** だから出すかどうかはこの画面の送信状態で決め、
 * サーバの `thinking` は「実際にターンが始まった」という別の証拠として残す。
 */
describe('考えている…の合図', () => {
  it('サーバがまだ何も言っていなくても、送った瞬間に出る', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        // **1フレームも流さない。** 受信箱で順番を待っているクローン、つまり
        // 「待ち時間が長い」場面そのもの。ここで出るなら、出どころは画面しかない。
        return sse([], { keepOpen: true, signal: init?.signal });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText('考えている…')).toBeTruthy();
  });

  it('本文が1文字でも来たら消える（受信はまだ続いている）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'こ' } },
          ],
          // 終わらせない。**消える理由が「本文が来たから」であることを固定する** —
          // `done` を送ると、終わったから消えたのか本文で消えたのか分からない。
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText('考えている…')).toBeTruthy();
    await screen.findByText('こ');
    await waitFor(() => {
      expect(screen.queryByText('考えている…')).toBeNull();
    });
    // まだ受信中である（合図が消えたのは受信が終わったからではない）
    expect(screen.getByRole('button', { name: /受信をやめる/ })).toBeTruthy();
  });

  /**
   * **サーバの `thinking` を受ける経路を消していない**こと。
   *
   * 画面側の合図は送信の瞬間の1回きりで、本文が来た時点で畳まれる。だから
   * **本文の後に出ている「考えている…」は、サーバの `thinking` しか出どころが無い。**
   * （道具の実行が終わってモデルが考え直すときに来る。ここを落とすと、画面は
   * 終わった実行を映したまま止まる。）
   */
  it('本文の後にサーバの thinking が来たら、また出る', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'ここまでは届いた' } },
            { event: 'thinking', data: { type: 'thinking' } },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    await screen.findByText('ここまでは届いた');
    expect(await screen.findByText('考えている…')).toBeTruthy();
  });
});

/**
 * 「順番を待っている」と「考えている」を1つの表示に潰していないこと。
 *
 * 画面が送信の瞬間に出す「考えている…」は、この画面が言える範囲＝「送った」までの
 * 表示である。サーバの `queued` は**受理したがまだ順番が来ていない**という、より
 * 正確な事実なので、届いたら差し替える。先客のターンが数分続けば、その数分は
 * 「考えている」ではない。
 */
describe('順番待ちの合図（queued）', () => {
  it('queued が来たら「順番を待っている…」へ差し替わる', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'queued', data: { type: 'queued' } },
          ],
          // 順番待ちのまま終わらせない（先客のターンが走っている状態）。
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText('順番を待っている…')).toBeTruthy();
  });

  it('順番が来たら「考えている…」へ移る（queued を置き換えるのではなく後に続く）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'queued', data: { type: 'queued' } },
            { event: 'thinking', data: { type: 'thinking' } },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    expect(await screen.findByText('考えている…')).toBeTruthy();
    // 順番待ちの表示は残らない（進行中の合図は1つだけ）。
    await waitFor(() => {
      expect(screen.queryByText('順番を待っている…')).toBeNull();
    });
  });
});

/**
 * 枠（利用上限）が閉じている合図（`usage_limited`）。
 *
 * `queued` / `thinking` と違って**進行中の合図（transient）にしていない** —
 * 直後に必ず `error`（終端）が続く契約で、transient にすると `error` の
 * `setFailure` 自体はこの行に触れないものの、ストリーム終了時の `finally` が
 * `line.transient !== true` で transient な行を残らず消してしまい、枠が
 * 閉じていたという事実が画面から消える。ここでは受信が終わったあと（`finally`
 * が必ず走ったあと）も本文が残ることを確かめる。
 */
describe('枠が閉じている合図（usage_limited）', () => {
  it('直後に届く error・受信終了後も画面に残る（transient として消えない）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            {
              event: 'usage_limited',
              data: { type: 'usage_limited', message: '枠が閉じている（テスト用の文言）' },
            },
            { event: 'error', data: { type: 'error', message: 'いまは投げられない' } },
          ],
          // usage_limited の直後に error で終わる（`done` は来ない契約）。
          { signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    // SDK の文言（event.message）がそのまま残っている。
    expect(await screen.findByText(/枠が閉じている（テスト用の文言）/)).toBeTruthy();
    // 保持されていて試し直されることが分かる一文も付いている。
    expect(await screen.findByText(/配り直されて試し直される/)).toBeTruthy();
    // 直後の error（終端）も出る。
    expect(await screen.findByText('いまは投げられない')).toBeTruthy();

    // 受信が終わり、入力欄が戻った（＝ finally の transient 掃除が走った）
    // あとも、usage_limited の行は消えていない。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /送る/ })).toBeTruthy();
    });
    expect(screen.getByText(/枠が閉じている（テスト用の文言）/)).toBeTruthy();
  });
});

describe('会話の切り替え', () => {
  it('人間が別の会話を選んだら、前の会話の内容を捨てる', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations/other')) {
        return json({
          conversationId: 'other',
          messages: [{ id: 'm1', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '別の会話' }],
        });
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    const { router } = renderChat();
    await send('やあ');
    await screen.findByText(/こんにちは、元気にやっている/);

    // 自分が採番した id への同期ではなく、人間の切り替え
    await router.navigate('/chat/other');

    expect(await screen.findByText('別の会話')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText(/こんにちは、元気にやっている/)).toBeNull();
    });
  });
});
