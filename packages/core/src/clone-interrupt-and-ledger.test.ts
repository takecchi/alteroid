import { describe, it, expect } from 'vitest';
import {
  REDELIVERY_COUNT_PREFIX_A,
  REDELIVERY_COUNT_PREFIX_B,
  isHumanOriginated,
  resolveCloneHumanPriority,
} from './clone.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { InboxEvent, InboxEventType } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForExpect } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

/**
 * 割り込める起点の集合そのものを固定する。
 *
 * ## なぜ doc では守れないのか
 *
 * 人間以外が餓死しない理由は**割り込みの量が有界だから**で、有界なのは
 * **割り込めるのが人間の速さでしか来ないものだけ**だからである（`isHumanOriginated`
 * の doc）。`external`（webhook）や `timer` を1つ足すと、**割り込みの量が機械の
 * 速さで決まるようになり、有界性の根拠が消える。**
 *
 * ## この集合は畳み込みの前提でもある（守っているものが2つある）
 *
 * **⚠️ この2つ目は、設計時に意図したものではない。** 人間優先を入れる過程で
 * 「出荷される設定を測る歯が無くなる」を塞ごうとして、初めて見つかった。
 * **だからここには「なぜそう決めたか」の記録が無い** — 探しても出てこないのは
 * 記録漏れではなく、**誰も一度も決めていない**からである。**暗黙の前提がほかにも
 * 在りうると疑うこと。**
 *
 * **tick（`timer` / `self_initiative`）を `true` にすると、tick どうしが並べ替わり
 * うるようになり、畳み込み（`#foldsIntoHeldTick`）が黙って効かなくなる** —
 * 「先に届いた tick が `#deferred` へ入る前に次の tick が処理される」が起こりうる
 * ためで、#168 の歯「発意 tick を続けて送っても、保持する在庫は1件のまま増えない」
 * が守っているものが崩れる。**有界性だけを検討して足さないこと。**
 *
 * **そしてそれは緑のまま起きる。** 順序の歯（上の3本）は有限件数しか流さないので、
 * 集合が広がっても通る。**踏んでも出力に何も出ない**種類の壊れ方なので、doc に
 * 書いておくだけでは守れない（この repo は「読んだのに踏んだ」を何度も記録して
 * いる）。**気づく主体を `vitest` にする。**
 *
 * ## どう守っているか
 *
 * `InboxEvent` は `type` による判別可能な共用体なので、`Record<InboxEventType, …>`
 * にすると**新しい起点が増えた瞬間にコンパイルが落ちる。** 落ちた人は「これは人間
 * 起点か」を宣言させられ、その場で上の doc に当たる。**先例は #159**（画面から
 * 消した状態の数え上げを、テスト側の `Record<ManagerStatus, true>` へ移して
 * 「状態が増えるとコンパイルが落ちる」形にしたもの）。
 */
describe('クローン — 割り込める起点は、人間の速さで来るものだけ（ここが有界性の全体）', () => {
  it('割り込める起点が人間の速さで来るものだけであること（ここが有界性の全体）', () => {
    // **すべての起点について宣言させる。** 起点が増えるとここがコンパイルで落ちる。
    // 落ちたら、足した起点が「人間が待っている合図」かどうかを決めてから足すこと。
    const expected: Record<InboxEventType, boolean> = {
      human_message: true,
      human_answer: true,
      // 以下はすべて false。**機械の速さで来るものを true にしないこと** —
      // した瞬間に割り込みの量が機械の速さで決まり、有界性の根拠が消える。
      manager_message: false,
      external: false,
      timer: false,
      self_initiative: false,
      distill: false,
    };

    // 宣言と実装が一致すること。**`isHumanOriginated` は `type` しか見ない**ので、
    // 他のフィールドは判定に効かない（型を満たすだけの最小限を渡す）。
    for (const [type, isHuman] of Object.entries(expected)) {
      const event = { type, id: `evt-${type}`, at: '2026-08-22T00:00:00.000Z' } as InboxEvent;
      expect(isHumanOriginated(event), `${type} の判定`).toBe(isHuman);
    }

    // **true は2つだけである。** 上の Record を全部 true にする変異を弾く歯で、
    // 個別の一致（上のループ）だけでは「全部 true」を通してしまう。
    expect(Object.values(expected).filter(Boolean)).toHaveLength(2);
  });

  it('未設定・空・空白は既定（有効）で、明示的に切ったときだけ無効になる', () => {
    // **「読めなかった」を「切られた」と読まない。** 緩めると、変数が届かなかった
    // だけの器で人間の待ちが黙って戻る（`resolveCloneHumanPriority` の doc）。
    expect(resolveCloneHumanPriority({})).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: '' })).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: '   ' })).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: 'yes' })).toBe(true);

    for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: off }), off).toBe(false);
    }
  });
});

/**
 * **台帳で片付け済みの報告に印を付ける**（#391）。
 *
 * ## この describe が守っている性質
 *
 * クローンは、報告が**ターンへ配られる前に**台帳（`commitment_list`）で全文を
 * 読める —— `Clone#post()` は受信箱へ積む**前**に `#commit` を呼ぶからである。
 * だから「読んで答えた」つもりで閉じられ、**その後に来る配達が新規と見分けが
 * 付かない**（#391 で6例観測されている）。
 *
 * ## ⚠️ 「配り直しかどうか」は測っていない
 *
 * この印は配り直しの機構（`#redelivered` / `#redeliveredClosed`）を一切見ず、
 * **台帳が閉じているかだけを見る。** だからこの歯も、初回配達か再配達かを
 * 作り分けていない —— **作り分ける必要が無いことそのものが、この設計の要点で
 * ある。**
 *
 * ## 足場について
 *
 * 台帳の状態は `commitments.get` を差し替えて作る。**`post` してから閉じる形に
 * しないのは、配達との競争になるからである** —— 閉じる前に配られてしまえば、
 * 測りたい状態が作れていないのに緑になる（足場が測定対象と重なる形）。
 */
describe('台帳で片付け済みの報告には印が付く（#391）', () => {
  const REPORT_ID = 'evt-report-closed';

  /** `commitments.get` だけを差し替えた `Stores`。他の面は本物のまま。 */
  function storesWithGet(get: (id: string) => Promise<unknown>): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      commitments: { ...base.commitments, get: get as Stores['commitments']['get'] },
    };
  }

  /** 台帳の1件を組み立てる。`closedAt` を渡さなければ未了。 */
  function commitment(fields: { closedAt?: string; closedReason?: string }) {
    return {
      id: REPORT_ID,
      at: '2026-08-24T00:00:00.000Z',
      origin: 'manager' as const,
      body: '[report] 本文',
      ...fields,
    };
  }

  async function deliverReport(stores: Stores): Promise<string> {
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID,
      at: new Date().toISOString(),
      managerId: 'mgr-closed',
      kind: 'report',
      text: '本文の前半。……そして後半に依頼が入っている。',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文の前半'))).toBeTruthy(),
      '『本文の前半』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('本文の前半')) ?? '';
    await s.clone.stop();
    return delivered;
  }

  /**
   * **この歯が単独で守るもの**: 閉じている報告に印が付き、**閉じた理由まで運ぶ**こと。
   *
   * 理由を運ぶのは、**誤って閉じたときに誤りが理由の側に出る**からである
   * （実例: 「判断は求めていない」と書いて閉じた報告の本文後半に依頼が在った）。
   */
  it('閉じた報告には印が付き、閉じた理由も一緒に届く', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID
          ? commitment({
              closedAt: '2026-08-24T00:05:00.000Z',
              closedReason: '判断は求めていないので閉じる',
            })
          : null,
      ),
    );

    expect(delivered).toContain('この報告は台帳で既に片付けている');
    expect(delivered).toContain('判断は求めていないので閉じる');
  });

  /**
   * **この歯が単独で守るもの**: **本文を短くしない**こと。
   *
   * #391 が頼んだのは「見分けが付くこと」であって「短くすること」ではない。
   * そして実例（台帳 `801f5ee7`）では、**全文がもう一度届いたからこそ**
   * 「判断は求めていない」と誤って閉じたことに気づけた。**短くすると、その
   * 二度目の機会が消える。**
   */
  it('印が付いても本文は全文のまま届く（二度目の機会を消さない）', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID ? commitment({ closedAt: '2026-08-24T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered).toContain('本文の前半');
    expect(delivered).toContain('そして後半に依頼が入っている');
    // 閉じた理由が無ければ、括弧ごと出さない（取れない軸に値を作らない）。
    expect(delivered).not.toContain('閉じた理由');
  });

  /**
   * **この歯が単独で守るもの**: 閉じていない報告に印を付けないこと。
   *
   * 付けると「片付け済みだから読まなくてよい」を、**まだ片付けていないものへ**
   * 出すことになる。
   */
  it('閉じていない報告には印が付かない', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) => (id === REPORT_ID ? commitment({}) : null)),
    );

    expect(delivered).not.toContain('既に片付けている');
  });

  /**
   * **この歯が単独で守るもの**: 台帳が引けなかったときに**安全側（雑音側）へ**
   * 倒れること。
   *
   * 3値の `'unknown'` は `'open'` の言い換えではないが、**出す文言としては同じ**
   * （ふつうに全文を出す）。**引けなかったことを「閉じている」と読まない。**
   */
  it('台帳が引けなかったら印を付けない（unknown は雑音側へ倒す）', async () => {
    const delivered = await deliverReport(
      storesWithGet(() => Promise.reject(new Error('台帳が読めない'))),
    );

    expect(delivered).toContain('本文の前半');
    expect(delivered).not.toContain('既に片付けている');
  });

  /**
   * **この歯が単独で守るもの**: 印は**本文の後ろ**に出ること。
   *
   * 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされる ——
   * 本文を残した意味が消える。
   */
  it('印は本文より後ろに出る', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID ? commitment({ closedAt: '2026-08-24T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered.indexOf('本文の前半')).toBeLessThan(
      delivered.indexOf('この報告は台帳で既に片付けている'),
    );
  });
});

/**
 * 述語が当たった配り直しの件数を数える跡（issue #1374。#879 から切り出し）。
 *
 * #1374 はまだ「注記して配る（いま）」と「抑える」のどちらにするかを決めて
 * いない——決める前に要るのが件数である。ここで測るのは、その件数を数える
 * 跡（`REDELIVERY_COUNT_PREFIX_A` / `REDELIVERY_COUNT_PREFIX_B` で始まる
 * `exchange`、`with: 'self'` / `role: 'outbound'`）が、述語が当たって
 * **配った**回にだけ、高々1行増えることである。
 *
 * **配り方が変わっていないこと自体は、直上の「台帳で片付け済みの報告には
 * 印が付く（#391）」の歯がそのまま緑であることで示す。** 本文・断り書きの
 * 文言はここでは1文字も変えていない——変わったのは日誌への追記だけである。
 */
describe('述語が当たった配り直しの件数を数える（issue #1374）', () => {
  /** `commitments.get` だけを差し替えた `Stores`。#391 の describe と同じ形。 */
  function storesWithGet(get: (id: string) => Promise<unknown>): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      commitments: { ...base.commitments, get: get as Stores['commitments']['get'] },
    };
  }

  /** 台帳の1件を組み立てる。`closedAt` を渡さなければ未了。 */
  function commitment(id: string, fields: { closedAt?: string; closedReason?: string }) {
    return {
      id,
      at: '2026-09-24T00:00:00.000Z',
      origin: 'manager' as const,
      body: '[report] 本文',
      ...fields,
    };
  }

  /** 日誌の `exchange` のうち、指定した接頭辞で始まる行だけを抜く。 */
  async function countLines(
    stores: Stores,
    prefix: string,
  ): Promise<{ with: string; role: string; text: string }[]> {
    const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
    }[];
    // **kind の接頭辞（issue #1332）がいちばん外側に付く。** 数える跡は
    // `with: 'self'` の exchange なので `[計器]`（`EXCHANGE_KIND_GAUGE_PREFIX`）
    // が「【数える:A/B】」より前に付く（`exchange-kind.ts` の doc「kind は
    // managerId の外側」と同じ向き）。
    return exchanges.filter((entry) =>
      entry.text.startsWith(`${EXCHANGE_KIND_GAUGE_PREFIX}${prefix}`),
    );
  }

  it('(A) 台帳で片付け済みの報告が配られた回に、【数える:A】で始まる行が1つだけ増える', async () => {
    const REPORT_ID = 'evt-count-a-closed';
    const stores = storesWithGet(async (id) =>
      id === REPORT_ID ? commitment(REPORT_ID, { closedAt: '2026-09-24T00:05:00.000Z' }) : null,
    );
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID,
      at: new Date().toISOString(),
      managerId: 'mgr-count-a',
      kind: 'report',
      text: '本文A',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文A'))).toBeTruthy(),
      '『本文A』を含む入力が届く',
    );

    const hits = await countLines(stores, REDELIVERY_COUNT_PREFIX_A);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.with).toBe('self');
    expect(hits[0]?.role).toBe('outbound');
    expect(hits[0]?.text).toContain('mgr-count-a');

    await s.clone.stop();
  });

  it('(A) 陽性対照: 閉じていない報告が配られても、「【数える:」で始まる行は増えない', async () => {
    const REPORT_ID = 'evt-count-a-open';
    const stores = storesWithGet(async (id) =>
      id === REPORT_ID ? commitment(REPORT_ID, {}) : null,
    );
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID,
      at: new Date().toISOString(),
      managerId: 'mgr-count-a-open',
      kind: 'report',
      text: '本文A-open',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文A-open'))).toBeTruthy(),
      '『本文A-open』を含む入力が届く',
    );

    const exchanges = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    expect(exchanges.filter((entry) => entry.text.startsWith('【数える:'))).toHaveLength(0);

    await s.clone.stop();
  });

  it('(B) 有効性の断り書きが付いてターンが起きた回に、【数える:B】で始まる行が1つだけ増える', async () => {
    const s = setup();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-count-b-changed',
      at: new Date().toISOString(),
      // 一度も `managers.start` していない managerId ⟹ `managers.list()` に
      // 居ない ⟹ `inboxEventValidity` は `unknowable`（`describeValidity` は
      // 空文字でない）。
      managerId: 'mgr-count-b-ghost',
      kind: 'report',
      text: '本文B',
      statusAtDelivery: 'running',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文B'))).toBeTruthy(),
      '『本文B』を含む入力が届く',
    );

    const hits = await countLines(s.stores, REDELIVERY_COUNT_PREFIX_B);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.with).toBe('self');
    expect(hits[0]?.role).toBe('outbound');
    expect(hits[0]?.text).toContain('mgr-count-b-ghost');

    await s.clone.stop();
  });

  it('(B) 陽性対照: statusAtDelivery を名乗っていない報告では、「【数える:」で始まる行は増えない', async () => {
    const s = setup();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-count-b-unclaimed',
      at: new Date().toISOString(),
      managerId: 'mgr-count-b-unclaimed',
      kind: 'report',
      text: '本文B-unclaimed',
      // statusAtDelivery を渡さない ⟹ inboxEventValidity は unclaimed ⟹
      // describeValidity は空文字。
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文B-unclaimed'))).toBeTruthy(),
      '『本文B-unclaimed』を含む入力が届く',
    );

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    expect(exchanges.filter((entry) => entry.text.startsWith('【数える:'))).toHaveLength(0);

    await s.clone.stop();
  });

  /**
   * まとめ読み（`#runManagerReportBatch`）でも (A) は件数ぶん個別に立つ。
   *
   * `mgr-count-batch` から連続して3件の report が届き、うち2件（`r1` / `r3`）
   * だけが台帳で片付け済み。**「1ターンにつき高々1行」ではなく「配った報告
   * 1件につき高々1行」であることが、この歯の要点である** —— 束の中身に応じて
   * 0〜N 行のあいだで変わる。
   */
  it('(A) まとめ読みでは、束の中で閉じている件数ぶんだけ行が増える', async () => {
    const REPORT_ID_1 = 'evt-count-a-batch-1';
    const REPORT_ID_2 = 'evt-count-a-batch-2';
    const REPORT_ID_3 = 'evt-count-a-batch-3';
    const stores = storesWithGet(async (id) => {
      if (id === REPORT_ID_1)
        return commitment(REPORT_ID_1, { closedAt: '2026-09-24T00:05:00.000Z' });
      if (id === REPORT_ID_3)
        return commitment(REPORT_ID_3, { closedAt: '2026-09-24T00:06:00.000Z' });
      return null;
    });
    const s = setup(undefined, stores);

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID_1,
      at: new Date().toISOString(),
      managerId: 'mgr-count-batch',
      kind: 'report',
      text: '束1本目',
    });
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID_2,
      at: new Date().toISOString(),
      managerId: 'mgr-count-batch',
      kind: 'report',
      text: '束2本目',
    });
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID_3,
      at: new Date().toISOString(),
      managerId: 'mgr-count-batch',
      kind: 'report',
      text: '束3本目',
    });

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('束3本目') ?? false,
      'まとめたターンが投げられる',
    );

    const hits = await countLines(stores, REDELIVERY_COUNT_PREFIX_A);
    expect(hits).toHaveLength(2);

    await s.clone.stop();
  }, 15_000);
});

/**
 * #394 の鏡像の穴を埋める（issue #871）: `report` だけが台帳（`commitment_close`）
 * を見て「もう片付けた」を出しており、`question` / `permission` はそれを一切
 * 見ていなかった —— クローンが `commitment_close` でその行を閉じても、
 * `question` / `permission` は「返事をするまで止まっている」の全文を出し続けた。
 *
 * **`closedAt` には一切触れない。** ここで測るのは表示・通知の層だけであり、
 * 「いつ台帳から消えるか」（`commitment_close` だけが閉じる、という #1003 の
 * 保証）は変えていない —— 3本とも `commitments.get` を差し替えるだけで、
 * `commitment_close` そのものは1度も呼んでいない。
 *
 * 3経路（`report` / `question` / `permission`）それぞれで、台帳が閉じていれば
 * 通知が出ることを測る。`report` は #391 の既存の歯がそのまま守っているので、
 * ここでは追加で「同じ土台（`storesWithGet` と同じ形）」から3経路を通す形にし、
 * 非対称が本当に消えたことを1つの describe の中で並べて確かめる。
 */
describe('質問・許可確認にも、台帳で片付け済みなら印が付く（#871）', () => {
  /** `commitments.get` だけを差し替えた `Stores`。他の面は本物のまま。 */
  function storesWithGet(get: (id: string) => Promise<unknown>): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      commitments: { ...base.commitments, get: get as Stores['commitments']['get'] },
    };
  }

  /** 台帳の1件を組み立てる。`closedAt` を渡さなければ未了。 */
  function commitment(fields: { closedAt?: string; closedReason?: string }) {
    return {
      id: 'evt-871',
      at: '2026-09-15T00:00:00.000Z',
      origin: 'manager' as const,
      body: '[question] 本文',
      ...fields,
    };
  }

  /**
   * `question` / `permission` の1件を投げ、届いた本文を拾う。
   *
   * **`manager.ts` の本物の `ManagerPool` を通す**（`setupWithManager` を
   * 使わない）——ここで測りたいのは「マネージャーを一度も起こしていない
   * （＝ `waiting` にその managerId 自体が居ない＝ `liveness` は `'unknown'`）
   * 状態でも、台帳が閉じていれば印が付く」ことそのものである。`liveness` が
   * `'settled'` の経路（#394 の既存の歯）と混ぜないための選択。
   */
  async function deliverConfirmation(
    kind: 'question' | 'permission',
    stores: Stores,
    requestId = 'req-871',
  ): Promise<string> {
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: 'evt-871',
      at: new Date().toISOString(),
      managerId: 'mgr-871',
      kind,
      text: `本文の前半（${kind}）。……そして後半に依頼が入っている。`,
      requestId,
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文の前半'))).toBeTruthy(),
      '『本文の前半』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('本文の前半')) ?? '';
    await s.clone.stop();
    return delivered;
  }

  /**
   * **この歯が単独で守るもの**: `question` が台帳で閉じられていれば印が付き、
   * **答え直せとは言わない**こと（`manager_send` で答えたかどうかは問わない
   * ——`liveness` は `'unknown'` のままで、それでも印が出る）。
   */
  it('閉じた question には印が付き、答え直せとは言わない', async () => {
    const delivered = await deliverConfirmation(
      'question',
      storesWithGet(async (id) =>
        id === 'evt-871'
          ? commitment({
              closedAt: '2026-09-15T00:05:00.000Z',
              closedReason: 'もう要らないので閉じる',
            })
          : null,
      ),
    );

    expect(delivered).toContain('この質問は台帳で既に片付けている');
    expect(delivered).toContain('もう要らないので閉じる');
    expect(delivered).toContain('答え直す必要は無い');
    // 答え直せという指示（従来の「返事をするまで…止まっている」の全文）が
    // 1文字も無いこと。
    expect(delivered).not.toContain('返事をするまで');
    expect(delivered).not.toContain('manager_send');
    expect(delivered).not.toContain('ask_human');
  });

  /**
   * **この歯が単独で守るもの**: `permission` でも同じく印が付くこと
   * （`question` だけの特別扱いにしない）。
   */
  it('閉じた permission にも印が付き、答え直せとは言わない', async () => {
    const delivered = await deliverConfirmation(
      'permission',
      storesWithGet(async (id) =>
        id === 'evt-871' ? commitment({ closedAt: '2026-09-15T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered).toContain('この実行の許可確認は台帳で既に片付けている');
    expect(delivered).toContain('答え直す必要は無い');
    expect(delivered).not.toContain('返事をするまで');
  });

  /**
   * **この歯が単独で守るもの**: 閉じていない質問・許可確認には印を付けず、
   * これまでどおり全文の指示（`manager_send` / `ask_human`）が出ること
   * ——この変更が「常に答え直さなくてよいと言う」側へ倒れていないことを
   * 確かめる回帰。
   */
  it('閉じていない question / permission には印が付かず、従来どおり全文が出る', async () => {
    const stores = storesWithGet(async (id) => (id === 'evt-871' ? commitment({}) : null));

    const question = await deliverConfirmation('question', stores, 'req-871-q');
    expect(question).not.toContain('既に片付けている');
    expect(question).toContain('返事をするまで');
    expect(question).toContain('manager_send');

    const permission = await deliverConfirmation('permission', stores, 'req-871-p');
    expect(permission).not.toContain('既に片付けている');
    expect(permission).toContain('返事をするまで');
  });

  /**
   * **この歯が単独で守るもの**: 台帳が引けなかったら、質問・許可確認でも
   * 安全側（雑音側）へ倒れ、印を付けないこと（#391 の同名の歯と対）。
   */
  it('台帳が引けなかったら question にも印を付けない（unknown は雑音側へ）', async () => {
    const delivered = await deliverConfirmation(
      'question',
      storesWithGet(() => Promise.reject(new Error('台帳が読めない'))),
    );

    expect(delivered).not.toContain('既に片付けている');
    expect(delivered).toContain('返事をするまで');
  });

  /**
   * **この歯が単独で守るもの**: `report` 経路は今回の変更でも動き続けること
   * ——3経路のうち、`report` だけを取り残していないかを同じ describe の中で
   * 確かめる（#391 の既存の歯とは別に、ここでも1本持たせる）。
   */
  it('report 経路も同じ台帳から印を出す（3経路そろって対称）', async () => {
    const s = setup(
      undefined,
      storesWithGet(async (id) =>
        id === 'evt-871-report'
          ? commitment({ closedAt: '2026-09-15T00:05:00.000Z', closedReason: '報告側の確認' })
          : null,
      ),
    );
    s.clone.post({
      type: 'manager_message',
      id: 'evt-871-report',
      at: new Date().toISOString(),
      managerId: 'mgr-871',
      kind: 'report',
      text: '本文の前半（report）。……そして後半に依頼が入っている。',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文の前半'))).toBeTruthy(),
      '『本文の前半』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('本文の前半')) ?? '';
    await s.clone.stop();

    expect(delivered).toContain('この報告は台帳で既に片付けている');
    expect(delivered).toContain('報告側の確認');
  });
});

/**
 * マネージャーの報告に「受け取ってから、どれだけ経ったか」を添える（#562）。
 *
 * **実害**: 3件とも、クローンが読んだ時点で対象 PR は既に MERGED だった
 * （「#558 は押せる」等）。報告に時刻も経過も1文字も入らないため、クローンは
 * 自分がいま読んでいる文が何分・何時間前のものかを知る手段が無かった。
 *
 * `event.at` は `Clone#post()` が受理した時点の時刻であって、マネージャーが
 * 書いた時刻ではない——だからここでは「受け取ってから」でしか主張しない。
 */
describe('マネージャーの報告に受け取ってからの経過を添える（#562）', () => {
  /** `manager_message`（report）を投げて、届いた本文を拾う。 */
  async function deliverReport(overrides: { at: string; text?: string }): Promise<string> {
    const s = setup();
    const text = overrides.text ?? '直しました。CIも緑です。';
    s.clone.post({
      type: 'manager_message',
      id: 'evt-age-report',
      at: overrides.at,
      managerId: 'mgr-age',
      kind: 'report',
      text,
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes(text))).toBeTruthy(),
      'text の内容を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes(text)) ?? '';
    await s.clone.stop();
    return delivered;
  }

  /**
   * **この歯が単独で守るもの**: 経過は閾値を設けず、短くても必ず1行出ること。
   *
   * 閾値で「古いときだけ出す」形にすると、「新しい報告に行が出ない」のと
   * 「この機能自体が無い」のとが出力上で区別できなくなる——`tools.ts` の
   * `describeInboxBacklog`（#562 のもう一方）が0件で行を消していたのと同じ形。
   * ここではその逆を確かめる：**いま受け取ったばかりの報告にも行が出る。**
   */
  it('経過は閾値を設けず、受け取った直後の報告にも必ず1行出る', async () => {
    const at = new Date().toISOString();
    const delivered = await deliverReport({ at });

    // 「書かれた時刻」ではなく「受け取った時刻」の語彙で出ること。
    expect(delivered).toContain('受け取ってから');
    expect(delivered).toContain('経過');
    // 丸めた値だけでなく、`at` そのもの（ISO 文字列）も一緒に出ること
    // （突き合わせができるように）。
    expect(delivered).toContain(at);
  });

  /**
   * **この歯が単独で守るもの**: 経過は秒／分／時間／日を読みやすく丸めること。
   *
   * 3時間前という余裕のある値を使う——テストの実行に数百ms〜数秒かかっても
   * 4時間には届かないので、丸めの結果が揺れない。
   */
  it('経過は時間の単位で読みやすく丸められる', async () => {
    const at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at });

    expect(delivered).toContain('約3時間');
  });

  /** 同じ理由で、日の単位でも丸められることを確かめる（5日前）。 */
  it('経過は日の単位でも読みやすく丸められる', async () => {
    const at = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at });

    expect(delivered).toContain('約5日');
  });

  /**
   * **この歯が単独で守るもの**: 経過の行は本文の後ろ・指示の前に置かれること
   * （#391 の `closedReportNotice` と同じ規則）。
   *
   * 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされる——
   * その規則をここでも守ること。
   */
  it('経過の行は本文の後ろ・指示の前に置かれる', async () => {
    const text = '経過の位置を確かめる本文';
    const at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at, text });

    const bodyIndex = delivered.indexOf(text);
    const ageIndex = delivered.indexOf('受け取ってから');
    const instructionIndex = delivered.indexOf('続きが要るなら `manager_send`');

    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(ageIndex).toBeGreaterThan(bodyIndex);
    expect(instructionIndex).toBeGreaterThan(ageIndex);
  });

  /**
   * **この歯が単独で守るもの**: `event.at` が parse できないとき、`NaN` や
   * 「-1分前」のような嘘の値を出さず、取れない理由を書く側へ倒すこと
   * （AGENTS.md「取れない軸に0の行を作る」と同じ考え方）。
   */
  it('at が壊れていたら、嘘の経過を出さず理由を書く', async () => {
    const delivered = await deliverReport({ at: 'これは日時ではない' });

    expect(delivered).not.toContain('NaN');
    // 負の経過（-1分前など）も出さない。
    expect(delivered).not.toMatch(/-\d+(秒|分|時間|日)/);
    expect(delivered).toContain('経過は測れない');
  });

  /**
   * **この歯が単独で守るもの**: `question` / `permission` には経過の行が
   * 載らないこと（この PR は `kind === 'report'` の分岐だけを変える）。
   */
  it('question / permission には経過が載らない', async () => {
    const s = setup();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-age-question',
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      managerId: 'mgr-age-q',
      kind: 'question',
      text: '経過を混ぜてはいけない質問',
    });

    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () =>
        expect(inputs().find((input) => input.includes('経過を混ぜてはいけない質問'))).toBeTruthy(),
      '『経過を混ぜてはいけない質問』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('経過を混ぜてはいけない質問')) ?? '';
    await s.clone.stop();

    expect(delivered).not.toContain('受け取ってから');
  });
});
