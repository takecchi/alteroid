import { describe, expect, it } from 'vitest';

import type { JournalQuery } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `conversation_read` — 人間との会話を日誌から読み返す道具。
 *
 * **これがこの PR の存在理由である。** クローンは自分と人間の会話を後から
 * 読み返す手段を持たなかった（`journal_read` は `types` でしか絞れず、`exchange`
 * に絞っても manager / self との往復に埋もれる）。逐語そのものは
 * `clone.ts` の `#record` が既に日誌へ積んでいる — ここに固定するのは
 * **その逐語へ、大量の manager / self ノイズに埋もれても、実際に届くこと**である。
 *
 * 形は `journal_read`（`journal-read.test.ts`）をそのまま踏襲する。
 */

function tools(stores: Stores) {
  const list = createCloneTools({ stores, emit: () => undefined, memoryCause: () => 'clone' });
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const found = list.find((entry) => entry.name === name);
    if (!found) throw new Error(`道具 ${name} が無い`);
    const result = (await found.handler(args as never, {} as never)) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join('');
  };
}

/** `stores.journal.list` に渡された引数を記録する（since/until の伝播を見るため）。 */
function spyOnList(stores: Stores): JournalQuery[] {
  const calls: JournalQuery[] = [];
  const original = stores.journal.list.bind(stores.journal);
  stores.journal.list = async (query?: JournalQuery) => {
    calls.push(query ?? {});
    return original(query);
  };
  return calls;
}

async function humanTurn(
  stores: Stores,
  conversationId: string,
  inboundText: string,
  outboundText: string,
): Promise<void> {
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: inboundText,
    conversationId,
  });
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'outbound',
    text: outboundText,
    conversationId,
  });
}

/** manager / self との往復（人間の会話とは無関係なノイズ）を大量に積む。 */
async function fillNoise(stores: Stores, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await stores.journal.append({
      type: 'exchange',
      with: i % 2 === 0 ? 'manager' : 'self',
      role: 'inbound',
      text: `[noise-${i}] マネージャーとの往復あるいは内部ターンの本文。`.repeat(3),
    });
  }
}

describe('conversation_read — 存在理由（人間の発言が manager/self のノイズに埋もれない）', () => {
  it('speaker: human を指定すると、会話の中身から人間自身の発言だけが取れる', async () => {
    const stores = createMemoryStores();
    // 人間の会話の前後を、大量の manager / self との往復で挟む（実運用の比率を模す）。
    await fillNoise(stores, 30);
    await humanTurn(stores, 'conv-1', '人間の質問です', 'クローンの返答です');
    await fillNoise(stores, 30);
    const call = tools(stores);

    const both = await call('conversation_read', { conversationId: 'conv-1' });
    expect(both).toContain('人間の質問です');
    expect(both).toContain('クローンの返答です');

    const humanOnly = await call('conversation_read', {
      conversationId: 'conv-1',
      speaker: 'human',
    });
    expect(humanOnly).toContain('人間の質問です');
    expect(humanOnly).not.toContain('クローンの返答です');
    // ノイズ（manager / self）はそもそも会話に含まれない。
    expect(humanOnly).not.toContain('noise-');
  });

  it('q + speaker: human で、ノイズに埋もれた中から人間の発言だけを語で探せる', async () => {
    const stores = createMemoryStores();
    await fillNoise(stores, 40);
    await humanTurn(stores, 'conv-2', '独自の合言葉トマト', 'トマトについての返答');
    const call = tools(stores);

    const reply = await call('conversation_read', { q: 'トマト', speaker: 'human' });

    expect(reply).toContain('独自の合言葉トマト');
    expect(reply).not.toContain('トマトについての返答');
  });
});

/**
 * **issue #418 の症状そのものを固定する歯。** 「絞りが効いている」だけでは
 * 弱い（`with` を返却後に絞る旧実装でも、`scan` が十分大きければ同じ結果に
 * なる）。ここで測るのは**窓に食われないこと** — `scan` を症状が出るほど
 * 小さくし、manager との往復を `scan` より多く積んでも、人間の会話が消えない
 * ことを確かめる。
 */
describe('conversation_read — 窓が小さくても manager の往復に食われない（issue #418）', () => {
  it('scan より多い manager の往復を積んでも、既定より遥かに小さい scan で人間の会話が出る', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '人間の質問です', 'クローンの返答です');
    // human の後に、scan（3）よりずっと多い manager/self の往復を積む
    // （新しい順に返るストアでは、これらのほうが human より「新しい」）。
    for (let i = 0; i < 20; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: i % 2 === 0 ? 'manager' : 'self',
        role: 'inbound',
        text: `noise-${i}`,
      });
    }
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-1', scan: 3 });

    // 旧実装（with を limit の後で絞る）だと、scan=3 で返る3件はすべて
    // manager/self になり、conv-1 は「窓には無い（判定できない）」になっていた。
    expect(reply).toContain('人間の質問です');
    expect(reply).toContain('クローンの返答です');
    expect(reply).not.toContain('この窓には無い');
  });
});

describe('conversation_read — since / until の伝播', () => {
  it('since / until が stores.journal.list へそのまま降りる', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    await humanTurn(stores, 'conv-1', '質問', '返答');
    const call = tools(stores);

    await call('conversation_read', {
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
      scan: 500,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
      limit: 500,
      types: ['exchange'],
      // **issue #418 で足した。** 絞りを `limit` より前（ストアの側）で
      // 効かせるための鍵——`readConversationWindow` を経由していることの
      // 検算でもある（手組みに戻ると、この鍵が最初に落ちる）。
      with: ['human'],
    });
  });

  it('省略時は since / until を渡さない（未指定と空文字を混同しない）', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    const call = tools(stores);

    await call('conversation_read', {});

    expect(calls[0]).not.toHaveProperty('since');
    expect(calls[0]).not.toHaveProperty('until');
  });
});

describe('conversation_read — 予算を超えたら省略した件数を言う', () => {
  it('黙って切らない（省略した件数が本文に出る）', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 60; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[msg-${i}] ${'長い発言本文。'.repeat(40)}`,
        conversationId: 'conv-big',
      });
    }
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-big' });

    expect(reply).toContain('件は省略');
    expect(reply).toContain('conversation_read id=');
  });

  /**
   * **切る側を間違えない。** 会話を開く動機はたいてい「さっきの続き」なので、
   * 予算で落とすのは古い側でなければならない。ここが逆だと、いちばん要る直近の
   * 発言だけが消えたうえ、注記も「もっと遡れ」と逆向きの続きの取り方を案内する。
   */
  it('会話の中身は新しい側を残し、落としたのが古い側であることを言う', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 60; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[msg-${i}] ${'長い発言本文。'.repeat(40)}`,
        conversationId: 'conv-big',
      });
    }
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-big' });

    // いちばん新しい発言は残り、いちばん古い発言が落ちている
    expect(reply).toContain('[msg-59]');
    expect(reply).not.toContain('[msg-0]');
    expect(reply).toContain('古い側');
    // 続きの取り方が「効かないほう」を案内していないこと。
    // **`not.toContain` で書かないこと。** 以前ここは
    // `not.toContain('さらに遡るなら scan を増やすこと')` だったが、その文言は
    // リポジトリのどこにも無いので、どんな実装でも通る（歯が無い）。
    // 落とすのは古い側なので、効く手は until であって scan ではない。
    expect(reply).toContain('until で窓を古い方へずらすこと');
    expect(reply).not.toMatch(/scan を増や(せば|して)/);
  });
});

/**
 * **`since` を渡されたとき「無い」と言い切らない。**
 *
 * ストアは `since` を LIMIT より先に効かせるので、件数が `scan` に届かないことは
 * 「日誌の先頭まで見た」を意味しない。ここを混ぜると、`since` より古い側に実在する
 * 発言について「無い」と報告してしまう — 観測の欠落を存在の否定として出す形で、
 * この道具が塞いでいる欠陥そのものである。
 */
describe('conversation_read — since で窓を切ったら「先頭に届いた」と言わない', () => {
  it('since より古い側に在る発言を「無い」と言わず、判定できないと言う', async () => {
    const stores = createMemoryStores();
    // since より古い側に、探す語を実際に置く。
    await humanTurn(stores, 'conv-old', '独自の合言葉デプロイの件', '古い側の返答');
    const call = tools(stores);

    const reply = await call('conversation_read', {
      q: 'デプロイ',
      since: '2099-01-01T00:00:00.000Z',
    });

    // 「無い」と言い切らない（実際には since より古い側に在る）。
    expect(reply).not.toContain('に当たる発言は無い');
    expect(reply).toContain('判定できない');
    // 「先頭に届いている」と嘘をつかない。
    expect(reply).not.toContain('先頭に届いている');
    // 効く手（since を動かす）を案内する。
    expect(reply).toContain('since');
  });

  it('since が無ければ従来どおり「先頭に届いている」と言える', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '質問', '返答');
    const call = tools(stores);

    const reply = await call('conversation_read', { q: '当たらない語' });

    expect(reply).toContain('先頭に届いている');
    expect(reply).toContain('に当たる発言は無い');
  });
});

/**
 * **一覧が `limit` で切れたことを黙らない。**
 *
 * 削る段は2つ（`limit` と予算）あり、`slice` の後の件数だけを数えると
 * `limit` で消えた分が出力のどこにも現れない。「20 件出して、日誌の先頭に
 * 届いている」と読める応答のまま、残りが消える。
 */
describe('conversation_read — 一覧が limit で切れたら、その件数と効く手を言う', () => {
  it('limit で落ちた会話の件数が本文に出て、limit を増やせと案内する', async () => {
    const stores = createMemoryStores();
    // 予算には収まる短さで、limit（既定 20）を超える数の会話を積む。
    for (let i = 0; i < 30; i += 1) {
      await humanTurn(stores, `conv-${i}`, `短い質問${i}`, `短い返答${i}`);
    }
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    // 30 件のうち 20 件だけ出したこと、残り 10 件が在ることの両方が出る。
    expect(reply).toContain('10 件');
    expect(reply).toContain('30 件');
    expect(reply).toContain('limit を増やせば出る');
    // 予算で切れたときの（ここでは効かない）案内を混ぜない。
    expect(reply).not.toContain('limit を増やしても出てこない');
  });

  it('limit に収まっているときは、余計な省略の注記を出さない', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 3; i += 1) {
      await humanTurn(stores, `conv-${i}`, `短い質問${i}`, `短い返答${i}`);
    }
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    expect(reply).not.toContain('件は省略');
    expect(reply).not.toContain('limit を増やせば出る');
    expect(reply).toContain('先頭に届いている');
  });
});

describe('conversation_read — id + offset で全文を続きから読む', () => {
  it('先頭が切れたら続きの取り方が出て、offset で続きが取れる', async () => {
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: `先頭の目印${'z'.repeat(10_000)}末尾の目印`,
      conversationId: 'conv-1',
    });
    const call = tools(stores);

    const head = await call('conversation_read', { id: entry.id });
    expect(head).toContain('先頭の目印');
    expect(head).not.toContain('末尾の目印');
    expect(head).toContain(`conversation_read id=${entry.id} offset=`);

    const offset = Number(/offset=(\d+)/.exec(head)?.[1]);
    const rest = await call('conversation_read', { id: entry.id, offset });
    expect(rest).toContain('末尾の目印');
  });

  it('無い id は、id だけを言って journal_read/conversation_read の区別に本文を漏らさない', async () => {
    const call = tools(createMemoryStores());
    const reply = await call('conversation_read', { id: 'no-such-id' });
    expect(reply).toContain('no-such-id');
    expect(reply).toContain('無い');
  });

  it('会話の発言ではない id（manager との往復）は journal_read を案内する', async () => {
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'マネージャーとの往復本文',
    });
    const call = tools(stores);

    const reply = await call('conversation_read', { id: entry.id });

    expect(reply).toContain('journal_read');
    expect(reply).not.toContain('マネージャーとの往復本文');
  });
});

describe('conversation_read — 判定できないことを2値に潰さない', () => {
  it('遡り切れているのに無ければ「無い」と言う', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '別の会話',
      conversationId: 'conv-real',
    });
    const call = tools(stores);

    // scan(2000 既定) に対して journal は1件だけなので、確実に先頭まで遡り切る。
    const reply = await call('conversation_read', { conversationId: 'conv-does-not-exist' });

    expect(reply).toContain('無い');
    expect(reply).not.toContain('判定できない');
  });

  it('遡り切れていないなら「判定できない」と言う（無いと言い切らない）', async () => {
    const stores = createMemoryStores();
    // scan より多い件数を積み、窓の外に本当は在るかもしれない状態を作る。
    for (let i = 0; i < 5; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[filler-${i}] 別会話`,
        conversationId: 'conv-filler',
      });
    }
    const call = tools(stores);

    // scan を窓より小さく絞る → 返る件数が scan と同数になり、reachedStart は偽。
    const reply = await call('conversation_read', {
      conversationId: 'conv-does-not-exist',
      scan: 3,
    });

    expect(reply).toContain('判定できない');
    expect(reply).not.toContain('会話 conv-does-not-exist に当たる発言は無い。');
  });

  it('q でも同じ区別を持つ（一覧が空でも reachedStart で言い分ける）', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 5; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[filler-${i}] 別の話題`,
        conversationId: 'conv-filler',
      });
    }
    const call = tools(stores);

    const notReached = await call('conversation_read', { q: '存在しない語', scan: 3 });
    expect(notReached).toContain('判定できない');

    const reached = await call('conversation_read', { q: '存在しない語', scan: 500 });
    expect(reached).toContain('無い');
    expect(reached).not.toContain('判定できない');
  });
});

describe('conversation_read — q で語を探す', () => {
  it('大文字小文字を区別しない部分一致で当たる', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', 'Deploy の話をしたい', 'デプロイ手順を答えます');
    const call = tools(stores);

    const reply = await call('conversation_read', { q: 'deploy' });

    expect(reply).toContain('Deploy の話をしたい');
    expect(reply).toContain('conversation=conv-1');
  });
});

describe('conversation_read — 会話の一覧', () => {
  it('何も指定しなければ会話の一覧を新しい順に返す', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-old', '古い会話の発言', '古い会話への返答');
    await humanTurn(stores, 'conv-new', '新しい会話の発言', '新しい会話への返答');
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    const oldIndex = reply.indexOf('conv-old');
    const newIndex = reply.indexOf('conv-new');
    expect(oldIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeLessThan(oldIndex);
    expect(reply).toContain('conversation_read conversationId=');
  });
});

/**
 * **「何が出ないか」を説明文から消させない。**
 *
 * この道具を引く場面のかなりの割合が「人間が自分の質問に何と答えたか」だが、
 * `ask_human` への回答は `exchange` にならず日誌の `escalation` にしか残らない
 * （`clone.ts` の `#record` が `human_answer` を素通りさせる）。**出ないことを
 * 知らずに引くと「無かった」と読む**ので、説明文に名指しで書いてある。ここは
 * 文面の細部ではなく「この2つが名指しされていること」だけを固定する。
 */
describe('conversation_read — 出ないものを説明文が名指ししている', () => {
  it('ask_human の回答が出ないことと、その行き先が書いてある', () => {
    const found = createCloneTools({
      memoryCause: () => 'clone',
      stores: createMemoryStores(),
      emit: () => undefined,
    }).find((entry) => entry.name === 'conversation_read');
    if (!found) throw new Error('道具 conversation_read が無い');

    expect(found.description).toContain('ask_human');
    // 行き先は `escalation`。**`approvals_list` は未回答だけを出す口なので答えを持たない。**
    expect(found.description).toContain('escalation');
    expect(found.description).toContain('approvals_list では出ない');
  });
});

/**
 * **渡されたのに使わなかった入力を、黙って捨てない。**
 *
 * `speaker` は会話の一覧では効かない（会話が在るかどうかは誰が喋ったかで変わらず、
 * 片方だけで数えるとあるはずの会話が一覧から消える）。**無視するのは正しいが、
 * 渡した側からは絞れた一覧に見える** — 効いていないことを応答に出す。
 */
describe('conversation_read — 効かなかった指定を黙らない', () => {
  it('一覧モードで speaker を渡すと、効いていないことを応答に書く', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '人間の発言', 'クローンの返答');
    const call = tools(stores);

    const reply = await call('conversation_read', { speaker: 'human' });

    expect(reply).toContain('speaker=human');
    expect(reply).toContain('効いていない');
  });

  it('speaker を渡さなければ、その注記は出ない（毎回出ると目印が効かなくなる）', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '人間の発言', 'クローンの返答');
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    expect(reply).not.toContain('効いていない');
  });
});
