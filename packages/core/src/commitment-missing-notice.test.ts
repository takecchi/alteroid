import { describe, expect, it } from 'vitest';

import type { CommitmentList, Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * 単票の台帳照会（`commitment_list id=`）が、**「いま無い」を「id が違う」と
 * 言い切らない**ことの検証（issue #1028）。
 *
 * ## ここで守っている線
 *
 * `get(id)` が `null` を返したという事実から言えるのは「いま台帳にその行が
 * 無い」までである。**「最初から無かった＝打ち間違いである」はそこから出て
 * こない** —— 一度は書けた行が後で消える経路が実在するからである
 * （`storage-fs` は `CLOSED_HISTORY_LIMIT` を超えた古い片付き行を物理削除
 * する。issue #416）。
 *
 * **⚠️ ただし「消えた」とも名乗れない。** 消した id はどの実装も控えておらず、
 * 残るのは累計件数（`CommitmentList.trimmedClosed`）だけである。⟹ 名乗れる
 * のは「**言い切れない**」までで、この歯が固定するのもそこまでである。
 * 「この id は消えた」と読める文言を将来ここへ足すと、持っていない根拠で
 * 断定することになる。
 *
 * ## 3つの場合を別々に固定する理由
 *
 * 削除を申告しないストア（本番の `storage-pg`）では**従来どおり言い切ってよい**
 * ——言い切れる根拠が在るからである。ここを畳んで「常に言葉を濁す」にすると、
 * 断れる場面でも断れなくなる。逆に**数えられなかった回を 0 と混ぜない**のは、
 * この直しが塞ごうとしている取り違えを直し自身が作らないためである。
 */
describe('commitment_list id=（単票）が「無い」をどう名乗るか（#1028）', () => {
  /** その `stores` に配線した `commitment_list` を呼ぶ関数を返す。 */
  function reader(stores: Stores) {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'commitment_list');
    expect(found, 'commitment_list という道具が無い').toBeDefined();
    return async (args: Record<string, unknown>) => {
      const result = await found?.handler(args as never, {} as never);
      return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    };
  }

  /**
   * `list()` の答え方だけを差し替えた `stores` を作る。
   *
   * **`get()` は触らない。** 固定したいのは「`get()` が `null` を返した後、
   * 削除の申告をどう読むか」であって、`get()` 自身の振る舞いではない。
   */
  function storesWithListing(answer: () => Promise<CommitmentList>): Stores {
    const stores = createMemoryStores();
    return { ...stores, commitments: { ...stores.commitments, list: answer } };
  }

  it('削除を1件も申告しないストアでは、これまでどおり「id が違う」と言い切る', async () => {
    const stores = createMemoryStores();
    const text = await reader(stores)({ id: 'c-nope' });
    // 本番の記憶ストア（`storage-pg`）はここに来る——物理削除の経路を1つも
    // 持たないので、`null` は「最初から無い」の証拠になる。
    expect(text).toContain('id が違う');
  });

  it('物理削除を申告しているストアでは、「id が違う」と言い切らずに件数を断る', async () => {
    const stores = storesWithListing(async () => ({
      entries: [],
      unreadable: [],
      trimmedClosed: 7,
    }));

    const text = await reader(stores)({ id: 'c-nope' });

    // 固定したいこと（文面そのものではなく、何を言い何を言わないか）。
    expect(text).toContain('言い切れない');
    expect(text).toContain('7');
    // **断定へ戻らないこと。** 元の文（言い切る形）がそのまま返ってはいけない。
    expect(text).not.toContain('は無い（id が違う）。');
    // **⚠️ 逆側へも倒れないこと。** 消した id は控えられていないので、
    // 「この id は消えた」とは名乗れない。
    expect(text).not.toContain('この id は消えた');
  });

  it('台帳を読み直せなかった回を、削除0件と混ぜない', async () => {
    const stores = storesWithListing(async () => {
      throw new Error('台帳を読めない');
    });

    const text = await reader(stores)({ id: 'c-nope' });

    expect(text).toContain('読めなかった');
    // 読めなかったのに「id が違う」と言い切ると、この直しが塞ごうとしている
    // 取り違えを直し自身が作ることになる。
    expect(text).not.toContain('は無い（id が違う）。');
  });
});
