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

import Chat, { nextShown } from './chat';

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
  /**
   * #251 の flaky 調査で作った回帰テスト。
   *
   * **本物の競合が実装側にあるかを、時計に頼らず確かめる。** `sse()` の
   * `after` を使い、「navigate した直後・かつ signal を渡さない（＝アプリ側の
   * `abort()` がこのストリームのフレーム送出を止めない）」という最悪条件で、
   * 前の会話のストリームから `text` チャンクを1つわざと遅れて流す。
   *
   * `ChatPane` の `owns()`/`stopped()`（`routes/chat.tsx`）が
   * `shownIdRef` だけを見て書き込みを許可するかどうかを判定しているので、
   * ここが正しく機能していれば、フレームの送出そのものが止まっていなくても
   * 画面には出ない。**この構成（`delayMs: 0`・signal 無し・navigate と同じ
   * tick でゲートを外す）そのもので24回連続実測し、揺れずに通ることを
   * 確認済み**（2026-08-23 観測）。
   *
   * ⚠️ **#437 で、この歯が言えるのは「競わせた」までだと分かった。** 24回
   * 連続で通ったのは実測だが、**通っていたのは勝った側の順序だけ**だった
   * —— 既定の並列度の全スイートで実際に負けた側を通り、赤くなっている
   * （生の観測は Issue #437）。そして負けた側では**アプリが誤っていた**。
   * 誤っていたのは `owns()`/`stopped()` ではなく、**会話を切り替えたときの
   * 捨て直しの側**である（`chat.tsx` の `nextShown` / `shown` の doc）。
   *
   * **⟹ この歯は残すが、性質の保証はこの歯が持っていない。** どちらが先に
   * 走るかを実行環境に委ねている以上、**緑は「たまたま勝った側を通った」と
   * 区別できず、赤も「別の理由で落ちた」と区別できない。** 保証を持つのは
   * 下の `nextShown` の歯（決定的）である。ここが残っているのは、最悪条件を
   * 組んだ構成そのものを捨てないためである。
   */
  it('navigate と同じ tick で、しかも abort が効かない前の会話のストリームから届いたチャンクは画面に出ない', async () => {
    let releaseStray: () => void = () => {};
    const strayGate = new Promise<void>((resolve) => {
      releaseStray = resolve;
    });
    stubFetch((url) => {
      if (url.endsWith('/chat')) {
        // ⚠️ わざと signal を渡さない — アプリ側の abort() でこのストリームの
        // フレーム送出そのものは止まらない状況を作り、実測より厳しい条件で試す。
        return sse(
          [
            { event: 'open', data: { conversationId: CONVERSATION_ID } },
            { event: 'text', data: { type: 'text', text: 'こんにちは' } },
            { event: 'text', data: { type: 'text', text: '追加チャンク' }, after: strayGate },
            { event: 'done', data: { type: 'done' } },
          ],
          { keepOpen: true, delayMs: 0 },
        );
      }
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
    await screen.findByText('こんにちは');

    // navigate の呼び出しと**同じタイミングで**ストリームのゲートを外す —
    // React の effect（shownIdRef を進めて abort する側）と、遅れて届く
    // チャンクの処理のどちらが先に走るかを競わせる。
    const navPromise = router.navigate('/chat/other');
    releaseStray();
    await navPromise;

    await screen.findByText('別の会話');
    // 数ティック待って、追いついてくる可能性のある描画を拾う。
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.queryByText(/追加チャンク/)).toBeNull();
  });

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
    /*
     * #251: CI で1度だけ落ち、同じ commit の再実行で通った（詳細は Issue）。
     *
     * **実装側に本物の競合は無いことを、この直上の回帰テストで決定的に
     * 確かめてある** — navigate と同じ tick で、しかも abort が効かない
     * 前の会話のストリームからチャンクを流しても画面には出ない。この構成
     * （signal 無し・delayMs: 0・navigate と同じ tick でゲートを外す）で
     * 24回連続実測しても揺れなかった（2026-08-23 観測）。だから、ここで
     * 落ちるとすれば「消えるまでにかかる時間」（React の再描画・effect の
     * 実行）が既定の `waitFor` タイムアウト（`asyncUtilTimeout`、
     * testing-library の既定 1000ms。このリポジトリは `configure()` で
     * 上書きしていない）を CI の負荷下で超えただけ、という形になる。
     * 落ちた回の当該 `it` の所要は 1120ms で、「setup 約120ms + waitFor が
     * 1000ms 使い切って最後の評価で落ちる」と整合する。
     *
     * **`timeout` はこのテストが守っている性質（前の会話の内容が消える
     * こと）を1文字も変えない — assertion 自体（`queryByText` /
     * `toBeNull()`）はそのまま。変えているのは「どれだけ待つか」という
     * 足場のパラメータだけである。** 3000ms は同じファイル内の他の
     * `waitFor` 拡張（`chat.usage-limit-delayed-reply.test.tsx` /
     * `chat.duplicate-on-invalidate.test.tsx`）と同じ値に揃えた。
     *
     * ⚠️ これは「決定的な原因を直した」ではない。**予算を広げた理由は
     * 「このテストが遅い」ではなく、「実行環境が複数のプロセスと共有されて
     * いて、実行時間が他の負荷に依存するから」である**（`AGENTS.md`「自分が
     * 走っている器」参照）。**だから「新しい予算なら落ちない」とは言えない**
     * — 環境の混み方が変われば、また足りなくなりうる。どれだけ混むと
     * 足りなくなるかは測っていない。次に同じものを見た人が「無駄に長い
     * timeout だ」と思って戻さないよう、この経緯をここに残す。
     */
    await waitFor(
      () => {
        expect(screen.queryByText(/こんにちは、元気にやっている/)).toBeNull();
      },
      { timeout: 3000 },
    );
  });
});

/**
 * #437 の回帰テスト。**上の「競わせる」歯とは、測っているものが違う。**
 *
 * 上は順序を実行環境に委ねている。ここは **#437 で実測した順序をそのまま値で
 * 組む** ので、毎回同じ経路を通る（実測の trace は Issue #437）。
 *
 * ⚠️ **画面を描いてこの順序を組むことはできなかった。** React 19 は、積まれた
 * 更新を**次のマイクロタスクの切れ目で流す** — テストの側から「積まれてから
 * 流れるまで」の隙間へ切り替えを差し込む手段が無い（`await` を挟んだ時点で
 * 既に流れている）。`act` で囲っても、`router.navigate` でも、会話一覧の
 * クリック（離散イベント）でも同じだった（4通り実測）。**だから判定そのもの
 * （`nextShown`）を切り出して、値で組んでいる。**
 */
describe('会話を切り替えたときに捨てるもの（nextShown）', () => {
  type Shown = Parameters<typeof nextShown>[0];

  const 前の会話: Shown = {
    id: CONVERSATION_ID,
    lastRouteId: CONVERSATION_ID,
    lines: [
      { key: 'h-0-やあ', role: 'human', text: 'やあ' },
      { key: 'c-1', role: 'clone', text: 'こんにちは' },
    ],
    failure: undefined,
  };

  it('人間が別の会話を選んだら、前の会話に属するものを捨てる', () => {
    const 切り替え後 = nextShown(前の会話, 'other');

    expect(切り替え後.id).toBe('other');
    expect(切り替え後.lastRouteId).toBe('other');
    expect(切り替え後.lines).toEqual([]);
    expect(切り替え後.failure).toBeUndefined();
  });

  /**
   * **これが #437 の本体である。**
   *
   * 切り替えの描画で一度は捨てたのに、**その後で React が「切り替えより前に
   * 積まれていた `lines` の更新関数」を基底の値から貼り直す**ことがある
   * （実測: 60回中11回。既定の並列度の全スイートでも1回捕まえた）。貼り直しで
   * 戻ってくるのは**前の会話の `lines` そのもの**で、迷子のチャンクだけでは
   * なく**人間自身の発言も一緒に戻る。**
   *
   * 印（`lastRouteId`）を別の state に持っていると、戻るのは `lines` だけで
   * 印は進んだままになる ⟹ 捨て直しの判定は二度と走らず、**前の会話の中身が
   * 別の会話の画面に残ったまま消えない**（3000ms 待っても消えないことを実測）。
   *
   * 1つの state に畳んであれば、印も一緒に戻る ⟹ **同じ判定がもう一度効く。**
   */
  it('貼り直しで前の会話の値が戻ってきても、同じ判定がもう一度捨てる', () => {
    // React が貼り直しで作る値：**切り替え前の値**に、積まれていた更新を当てたもの。
    const 貼り直された値: Shown = {
      ...前の会話,
      lines: [
        { key: 'h-0-やあ', role: 'human', text: 'やあ' },
        { key: 'c-1', role: 'clone', text: 'こんにちは追加チャンク' },
      ],
    };

    const 直後の描画 = nextShown(貼り直された値, 'other');

    expect(直後の描画.lines).toEqual([]);
    expect(直後の描画.id).toBe('other');
    expect(直後の描画.lastRouteId).toBe('other');
  });

  it('URL が自分の採番に追いついただけなら、何も捨てない', () => {
    // `open` で id が決まった直後（id は URL より先へ進んでいる）。
    const 採番直後: Shown = { ...前の会話, lastRouteId: undefined };

    const 追いついた後 = nextShown(採番直後, CONVERSATION_ID);

    // **同じ配列のまま**（作り直してもいない）。送ったばかりの発言が消えない。
    expect(追いついた後.lines).toBe(採番直後.lines);
    expect(追いついた後.id).toBe(CONVERSATION_ID);
    expect(追いついた後.lastRouteId).toBe(CONVERSATION_ID);
  });

  it('URL が変わっていなければ、同じものをそのまま返す', () => {
    expect(nextShown(前の会話, CONVERSATION_ID)).toBe(前の会話);
  });

  it('新しい会話（URL に id が無い）へ移っても捨てる', () => {
    const 新しい会話 = nextShown(前の会話, undefined);

    expect(新しい会話.id).toBeUndefined();
    expect(新しい会話.lastRouteId).toBeUndefined();
    expect(新しい会話.lines).toEqual([]);
  });
});

/**
 * サーバは日誌の新しい方から `scan` 件しか見ない（`GET /conversations/:id`）。
 * だから**出ている分が全部とは限らない。**
 *
 * ここが無いと、古い会話を開いた人間には「これで全部」に見える。とくに中身が
 * 空だったときは、下の `Empty`（「目的や価値観を伝えると…」）が出るので
 * **「まだ何も話していない」と読める** — 実際には遡り切れていないだけである。
 */
describe('遡り切れていないことを言う', () => {
  const MESSAGE = { id: 'm1', at: '2026-08-13T00:00:00Z', role: 'inbound', text: '古い発言' };

  function stubDetail(detail: unknown) {
    return stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) return json(detail);
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });
  }

  it('窓が先頭に届いていなければ、遡った件数を添えてそう書く', async () => {
    stubDetail({
      conversationId: CONVERSATION_ID,
      messages: [MESSAGE],
      scanned: 2000,
      reachedStart: false,
    });
    renderChat(`/chat/${CONVERSATION_ID}`);

    expect(
      await screen.findByText(/人間との往復を 2000 件遡ったが、先頭には届いていない/),
    ).toBeTruthy();
    expect(screen.getByText('古い発言')).toBeTruthy();
  });

  it('中身が空のときも「無い」とは書かず、判定できないことを書く', async () => {
    stubDetail({
      conversationId: CONVERSATION_ID,
      messages: [],
      scanned: 2000,
      reachedStart: false,
    });
    renderChat(`/chat/${CONVERSATION_ID}`);

    expect(await screen.findByText(/先頭には届いていない/)).toBeTruthy();
  });

  it('窓が先頭に届いていれば、但し書きは出さない', async () => {
    stubDetail({
      conversationId: CONVERSATION_ID,
      messages: [MESSAGE],
      scanned: 3,
      reachedStart: true,
    });
    renderChat(`/chat/${CONVERSATION_ID}`);

    expect(await screen.findByText('古い発言')).toBeTruthy();
    expect(screen.queryByText(/先頭には届いていない/)).toBeNull();
  });
});

/**
 * **#418 の裏返し。** `GET /conversations` は `scan` の窓に加えて `limit`
 * （既定20、画面は30固定）でも黙って会話数を切っていた。上の
 * 「遡り切れていないことを言う」（`ChatPane`・個別会話）と同じ作法で、
 * 一覧側（`ConversationList`）にも `reachedStart` / `hiddenByLimit` の
 * 断り書きを足した。**2つは別の条件なので、両方出ることも片方だけの
 * こともある** — ここでは4通り（両方出る／片方ずつ／両方出ない）を測る。
 */
describe('会話一覧の断り書き（#418 の裏返し）', () => {
  function stubList(list: unknown) {
    return stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes(`/conversations/${CONVERSATION_ID}`)) {
        return json({ conversationId: CONVERSATION_ID, messages: [] });
      }
      if (url.includes('/conversations')) return json(list);
      return undefined;
    });
  }

  const CONVERSATION = {
    conversationId: 'conv-x',
    startedAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    messages: 1,
    preview: '一覧の1件',
  };

  it('reachedStart が偽なら、先頭に届いていないと書く', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 2000,
      reachedStart: false,
      hiddenByLimit: 0,
    });
    renderChat();

    expect(
      await screen.findByText(/人間との往復を 2000 件遡ったが、先頭には届いていない/),
    ).toBeTruthy();
    // hiddenByLimit は0なので、こちらの断り書きは出ない（2つは別の条件）。
    expect(screen.queryByText(/…ほか/)).toBeNull();
  });

  it('reachedStart が真なら、先頭に届いていないとは書かない（不在の側）', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 1,
      reachedStart: true,
      hiddenByLimit: 0,
    });
    renderChat();

    await screen.findByText('一覧の1件');
    expect(screen.queryByText(/先頭には届いていない/)).toBeNull();
  });

  it('hiddenByLimit が正なら、省いた件数を書く', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 30,
      reachedStart: true,
      hiddenByLimit: 5,
    });
    renderChat();

    expect(await screen.findByText(/…ほか 5 件は省略/)).toBeTruthy();
    // reachedStart は真なので、こちらの断り書きは出ない（2つは別の条件）。
    expect(screen.queryByText(/先頭には届いていない/)).toBeNull();
  });

  it('hiddenByLimit が0なら、省いた件数は書かない（不在の側）', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 1,
      reachedStart: true,
      hiddenByLimit: 0,
    });
    renderChat();

    await screen.findByText('一覧の1件');
    expect(screen.queryByText(/…ほか/)).toBeNull();
  });

  it('両方の条件が成り立てば、両方書く', async () => {
    stubList({
      conversations: [CONVERSATION],
      scanned: 2000,
      reachedStart: false,
      hiddenByLimit: 5,
    });
    renderChat();

    expect(
      await screen.findByText(/人間との往復を 2000 件遡ったが、先頭には届いていない/),
    ).toBeTruthy();
    expect(await screen.findByText(/…ほか 5 件は省略/)).toBeTruthy();
  });
});

/**
 * 折り返しの付け忘れ（本2）。
 *
 * 人間・システムの行は `Markdown`（components/markdown.tsx）を経由しない
 * 素のテキストのままなので、`break-words` が無いと空白を持たない長い一続きの
 * 文字列（URL 等）で吹き出しがはみ出す。クローンの行は `Markdown` が自前で
 * `min-w-0 ... break-words` を持っている（`markdown.test.tsx` 参照）。
 *
 * **⚠️ これは「はみ出しが直った」ことの試験ではない。** jsdom はレイアウトを
 * 持たないので、固定できるのは「そのクラス名が書かれていること」までである。
 * それでも置くのは、戻す変更（`break-words` を消す）を黙って通さないため。
 */
describe('吹き出しの折り返し（本2）', () => {
  it('人間の吹き出しに break-words が付いている', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    const bubble = within(transcript()).getByText('やあ');
    expect(bubble.className.split(/\s+/)).toContain('break-words');
  });
});

/**
 * 送信まわりのボタンの狭幅対応（本6）。
 *
 * 「送る」「受信をやめる」は、狭い画面（`md` 未満）ではラベルを畳みアイコンだけに
 * する（`hidden md:inline`）。**これは「実際に隠れた」ことの試験ではない。**
 * jsdom は CSS を1つも持たないので、`hidden md:inline` が画面上で本当にラベルを
 * 隠すことはここでは1つも観測できない。固定できるのは、ラベルを包む `<span>` に
 * そのクラス名が書かれていることまでである。
 *
 * `aria-label` は別に固定する。**ラベルの `<span>` を `hidden` にしても、jsdom は
 * CSS を評価しないのでアクセシブルネームの計算はラベルの文字列を通常どおり拾える。
 * つまり `getByRole('button', { name: '送る' })` は `aria-label` を消しても
 * 通ってしまい、それだけでは `aria-label` の有無を確かめられない。** だから
 * ここでは `aria-label` 属性そのものを直接見る。
 */
describe('送信ボタンの狭幅対応（本6）', () => {
  it('「送る」のラベルは hidden md:inline を持つ span に包まれている（クラス名の存在のみ。実際に隠れることはここでは確認できない）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    const sendButton = await screen.findByRole('button', { name: '送る' });
    const label = within(sendButton).getByText('送る');
    expect(label.tagName).toBe('SPAN');
    const classes = label.className.split(/\s+/);
    expect(classes).toContain('hidden');
    expect(classes).toContain('md:inline');
  });

  it('「送る」ボタンは aria-label="送る" を明示している（getByRole の名前一致だけでは確かめられない — 属性を直接見る）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    const sendButton = await screen.findByRole('button', { name: '送る' });
    expect(sendButton.getAttribute('aria-label')).toBe('送る');
  });

  it('受信中は「受信をやめる」のラベルも hidden md:inline を持つ span に包まれ、aria-label も明示されている。かつ「送る」ボタンは消えず両方とも出ている', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) {
        return sse(
          [{ event: 'open', data: { conversationId: CONVERSATION_ID } }],
          // 受信中の状態を保つ（`done` を送らない）。
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    await send('やあ');

    const stopButton = await screen.findByRole('button', { name: '受信をやめる' });
    const stopLabel = within(stopButton).getByText('受信をやめる');
    expect(stopLabel.tagName).toBe('SPAN');
    const stopClasses = stopLabel.className.split(/\s+/);
    expect(stopClasses).toContain('hidden');
    expect(stopClasses).toContain('md:inline');
    expect(stopButton.getAttribute('aria-label')).toBe('受信をやめる');

    // 「受信をやめる」は「送る」の代わりではない。並べて出ている。
    expect(screen.getByRole('button', { name: '送る' })).toBeTruthy();
  });
});

/**
 * `ChatPane` の横向き safe-area inset（Issue #247 の4）。
 *
 * **これは「切り欠きの側で本文が欠けなくなった」ことの試験ではない。** jsdom は
 * `env(safe-area-inset-*)` を評価できないので、実際に何 px になるかはここでは
 * 測れない。固定できるのは、ヘッダ・やりとりの本文・入力欄の帯の3箇所に
 * `--safe-left` / `--safe-right` を使うクラス名が書かれていることまでである。
 *
 * 入力欄の帯（footer）は `--safe-bottom` を既に持っていた（縦向き）。ここで
 * 見るのは横向きぶんで、ヘッダ・本文にも同じ幅で当ててあることを併せて見る
 * （3つとも同じ左右の物理端を共有するので、本文だけ当てるとヘッダの見出しだけ
 * 切り欠きにかぶることになる）。
 */
describe('ChatPane の横向き safe-area inset（本4）', () => {
  it('ヘッダ・本文・入力欄の帯が pl / pr の safe-area クラスを持つ（クラス名の存在のみ）', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/chat')) return sse(STREAM, { signal: init?.signal });
      if (url.includes('/conversations')) return json({ conversations: [], scanned: 0 });
      return undefined;
    });

    renderChat();
    // 「やりとり」の `<ul>` は本文が1件も無いあいだは出ない（`Empty` に差し替わる）。
    // 本文側の要素を掴むために、まず1件送る。
    await send('やあ');

    const header = screen.getByRole('banner');
    const headerClasses = header.className.split(/\s+/);
    expect(headerClasses).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(headerClasses).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(headerClasses).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(headerClasses).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');

    const body = screen.getByRole('list', { name: 'やりとり' }).parentElement;
    if (body === null) throw new Error('やりとりの親要素が見つからない');
    const bodyClasses = body.className.split(/\s+/);
    expect(bodyClasses).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(bodyClasses).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(bodyClasses).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(bodyClasses).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');

    const textbox = screen.getByPlaceholderText(/クローンに話しかける/);
    // 入力欄の帯そのもの（`border-t` の div）まで3階層上がる
    // （`<textarea>` → `min-w-0 flex-1` → `flex items-end gap-2` → 帯本体）。
    const footer = textbox.parentElement?.parentElement?.parentElement;
    if (footer === undefined || footer === null) throw new Error('入力欄の帯が見つからない');
    const footerClasses = footer.className.split(/\s+/);
    expect(footerClasses).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(footerClasses).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(footerClasses).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(footerClasses).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');
    // 既存の縦の safe-area（本4の対象外だが、消していないことも一緒に見ておく）。
    expect(footerClasses).toContain('pb-[calc(0.75rem+var(--safe-bottom))]');
  });
});
