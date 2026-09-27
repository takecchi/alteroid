import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForDone,
  isTerminal,
  waitForTerminal,
  flushPendingMicrotasks,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

/**
 * 枠（利用上限）に当たったら、合図を捨てずに保持し、次の合図が来たときに
 * 試し直す（`clone.ts` の `#usageBlocked` / `#deferred`）。
 *
 * タイマーは持たない。「試す」の契機は常に**新しい合図の到着**である。`post()`
 * は解除の印を立てるだけで、保持していた合図を FIFO の順で受信箱へ戻すのは
 * `#pump` の先頭である（**そこへ寄せてあるのが競合を塞いでいる本体** —
 * 下の「終端を出した直後…」／「短絡した合図の後始末の直前に…」の2本が、
 * 寄せる前に何が失われていたかを名指しで踏む）。戻した先頭が枠でまた落ちれば
 * `#usageBlocked` が再び立ち、残りはまた保持される（`#pump` の枠チェック）。
 */
describe('クローン — 枠（利用上限）が閉じたら保持して次の合図で試す', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /**
   * 実際に SDK へ投げられた入力を「何件目か」の並びへ畳む。**FIFO を見るための
   * 目である。**
   *
   * 完全一致では見ない — `#notices` の `redelivery` / `commitment` が本文の前に
   * 付くので、部分一致で畳む。どれにも当たらない入力は `'?'` にして**捨てない**
   * （落とすと、余計な入力が1件混ざったことが並びから消える）。
   */
  function labelOrder(call: FakeCall): string[] {
    return call.inputs.map((text) => {
      for (const label of ['一件目', '二件目', '三件目']) {
        if (text.includes(label)) return label;
      }
      return '?';
    });
  }

  it('枠に当たったとき、usage_limited が error より先に届く', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    const usageLimitedIndex = s.events.findIndex((event) => event.type === 'usage_limited');
    const errorIndex = s.events.findIndex((event) => event.type === 'error');
    expect(usageLimitedIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(usageLimitedIndex).toBeLessThan(errorIndex);

    const usageLimitedEvent = s.events[usageLimitedIndex] as Extract<
      ChatStreamEvent,
      { type: 'usage_limited' }
    >;
    expect(usageLimitedEvent.message).toContain(spendLimitMessage);

    await s.clone.stop();
  });

  it('枠に当たった合図は forget されない（stores.inbox に未読として残る）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);

    // `waitForTerminal` は `error` の到着（`#reportFailure` 内の同期 `#emit`）
    // だけを見ており、`#pump` の `finally`（`#settleInboxEvent`）はそのあとの
    // 非同期の続きなので、消えて**いない**ことを確かめるにはそこまで待つ。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === event.id);
    }, '枠に当たった合図が未読として残る');

    await s.clone.stop();
  });

  it('枠が閉じている間に届いた2本目は、ターンが回らないのに error で終端する', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');
    const inputsBeforeSecondPost = (s.calls[0] as FakeCall).inputs.length;

    s.clone.post(humanMessage('二件目'));
    // 2本目の到着は「保持していた1本目の再試行」を1回だけ誘発する。その再試行も
    // 同じ理由（固定の spendLimitMessage）で失敗するので枠は閉じたままで、
    // 2本目自身は短絡される。terminal は合計3件になる
    // （1本目の初回失敗・1本目の再試行の失敗・2本目の短絡）。
    //
    // 何を待っているか: 「terminal が3件になったこと」であって「3秒以内に
    // なったか」ではない。`s.waitForEvents` は `clone.subscribe` の callback
    // が出来事の到着ごとに同期で条件を確かめる（`waitForEvents` の doc 参照）。
    // 経緯: 元は `expect.poll(..., { timeout: 3000 })` でポーリングしていた。
    // PR #90 の変異試験自身が「落ち方の所要時間が3000ms台＝ポーリングの
    // 待ち切れ」と自己申告していた（弱い証拠）。
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual([
      'error',
      'error',
      'error',
    ]);

    // 2本目自身はターンを回さない ＝ 呼び出し回数（query 呼び出し）も入力も
    // 2本目の分は増えていない（増えたのは1本目の再試行の1件だけ）。
    expect(s.calls.length).toBe(1);
    const inputsAfterSecondPost = (s.calls[0] as FakeCall).inputs.length;
    expect(inputsAfterSecondPost).toBe(inputsBeforeSecondPost + 1);
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('3本目の合図が来たら、保持していた合図が FIFO の順で配り直され、実際に投げられる', async () => {
    // 最初の2ターン（0, 1回目の入力）だけ失敗させ、3回目以降は通常どおり
    // 成功させる。**固定値のスタブにしないための `resultFor`**（何回目かで
    // 挙動を変える）。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目')); // turn 0: 失敗
    await waitForTerminal(s.events);

    s.clone.post(humanMessage('二件目')); // 1本目の再試行（turn 1: 失敗）を誘発。2本目自身は短絡される
    //
    // **この待ちだけは、以前は `expect.poll` のまま残されていた。** 決定的な待ちへ
    // 変えると直後の `post('三件目')` が二件目を迷子にする、というのが理由で、
    // それは**テストの問題ではなく production 側の競合**だった（`post()` が
    // その場で `#usageBlocked` を降ろし、まだ `#deferred` へ積まれていない
    // 合図を取り残していた）。`expect.poll` のポーリング間隔がその後始末を
    // 待つ時間を偶然与えていたので、穴が隠れていただけである。
    //
    // 競合は `clone.ts` の `#pump` 先頭（解除をそこへ寄せた）で塞いであり、
    // 隙間そのものを名指しで踏む本が2本ある（下の「終端を出した直後…」／
    // 「短絡した合図の後始末の直前に…」）。**塞いだので、ここもポーリングを
    // 使わない形へ揃えられる。**
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);

    s.clone.post(humanMessage('三件目')); // 保持していた[一件目, 二件目]を戻し、三件目も積む
    // 一件目(turn 2) → 二件目(turn 3) → 三件目(turn 4) の順に実際に投げられ、
    // 今度はすべて成功する（`done` が3件増える）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);

    // 入力に載ったテキストの出現順で FIFO を確かめる（`labelOrder` の doc）。
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
      '三件目',
    ]);

    await s.clone.stop();
  });

  /**
   * ## 割り込む一点を、待ちの速さではなく `#emit` の同期性で名指しする
   *
   * 下の2本は「終端（`error`）は出したが、その合図の後始末
   * （`#settleInboxEvent`）はまだ走っていない」という**一点**に `post()` を
   * 差し込む。`#emit` は購読者の callback を同期で呼ぶので、callback の中で
   * `post()` を呼べばその一点に必ず入る。
   *
   * **`await` を挟んだ待ちの後に `post()` する形では、この窓に入れるかどうかが
   * ホストの速さで変わる**（＝踏めた回だけ壊れ、踏まなかった回は緑になる）。
   * 実際に PR #110 は、`expect.poll` のポーリング間隔が偶然この後始末を待って
   * いたおかげでこの穴を見ずに済んでいた。ここでは**タイミングに一切頼らずに
   * 毎回踏む**ので、直っていなければ必ず落ちる。
   *
   * **どちらの本も、直す前の世界でも「待ち」は必ず抜ける形にしてある** —
   * 落ちるのは `toEqual` の不一致であって、待ちのタイムアウトではない
   * （AGENTS.md「タイムアウトは歯があった証拠にならない」）。
   */
  it('終端を出した直後（後始末の前）に次の合図が届いても、枠で保持した合図は消えない', async () => {
    // 1ターン目（一件目の初回）だけ枠で失敗させ、以降は成功させる。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    // 一件目の `error` を emit している最中に二件目を post する（上の doc）。
    let injected = false;
    const unsubscribe = s.clone.subscribe('conv-1', (event) => {
      if (event.type !== 'error' || injected) return;
      injected = true;
      s.clone.post(humanMessage('二件目'));
    });

    s.clone.post(humanMessage('一件目'));

    // **入力が2件になること自体は、直る前も後も起きる** — 直す前は
    // [一件目, 二件目]（一件目が `#forget` されて消え、二件目だけが走る）、
    // 直した後は [一件目, 一件目]（保持した一件目が先に配り直される）。
    // だからこの待ちはどちらの世界でも抜け、下の `toEqual` で落ちる。
    // `s.calls[0]` は `query()` が呼ばれるまで `undefined` である（`post` は同期で
    // 返るので、待ちの初回は必ずその前に走る）。**`?.` で受けること** — 素で
    // 読むと待ちの中で TypeError になり、「歯が無い」ではなく「テストが壊れた」で
    // 落ちる。
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '2件目の入力が投げられる');
    // 直す前の壊れ方: `post()` がその場で `#usageBlocked` を降ろしていたので、
    // `#pump` の `finally` が読む時点では `null` ＝ `defer: false` になり、
    // **枠で失敗しただけの一件目が `#forget` される**（器からも消えるので
    // 再起動でも戻らない ＝ 人間の発言が黙って失われる）。
    //
    // **先頭2件だけを見る（`slice`）。** 待ちが抜けた時点で3件目が既に投げられて
    // いることがあり、配列まるごとの一致で見ると**直っているのに落ちる**
    // （実測でそうなった）。見たいのは「2件目に何が投げられたか」なので、
    // 直す前の世界との違い（`二件目` か `一件目` か）はこの先頭2件で決まる。
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 2)).toEqual(['一件目', '一件目']);

    // 保持した一件目が消えていない ＝ 両方に返る（二件目は一件目の後）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual(['一件目', '一件目', '二件目']);

    unsubscribe();
    await s.clone.stop();
  });

  it('短絡した合図の後始末の直前に3本目が届いても、2本目は迷子にならず FIFO を保つ', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目')); // turn 0: 失敗 → 保持（terminal 1件目）
    await waitForTerminal(s.events);

    // 三件目を撃つのは**二件目の短絡の `error`**（terminal 3件目）である。
    // 一件目の再試行の失敗（terminal 2件目）ではない — 件数で名指しするので、
    // どの `error` に入ったかがホストの速さで変わらない。
    let injected = false;
    const unsubscribe = s.clone.subscribe('conv-1', (event) => {
      if (event.type !== 'error' || injected) return;
      if (s.events.filter(isTerminal).length < 3) return;
      injected = true;
      s.clone.post(humanMessage('三件目'));
    });

    s.clone.post(humanMessage('二件目')); // 一件目の再試行（turn 1: 失敗）＋二件目の短絡

    // **入力が4件になること自体は、直る前も後も起きる** — 直す前は
    // [一件目, 一件目, 一件目, 三件目]（二件目が `#deferred` に取り残されて
    // このプロセスでは二度と処理されない）、直した後は
    // [一件目, 一件目, 一件目, 二件目]。
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 4, '4件目の入力が投げられる');
    // **先頭4件だけを見る**（上の本と同じ理由。5件目が既に投げられていることが
    // あり、配列まるごとの一致では直っているのに落ちる）。
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 4)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
    ]);

    // 三件目まで含めて FIFO（到着順）で全部に返る。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
      '三件目',
    ]);

    unsubscribe();
    await s.clone.stop();
  });

  it('枠が閉じている間に2件が続けて届いても、配り直しは到着順のまま（待ち行列を追い越さない）', async () => {
    // 1ターン目（一件目の初回）だけ枠で失敗させる。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目')); // turn 0: 失敗 → 保持
    await waitForTerminal(s.events);

    // **続けて2件 post する。** 1件目の `post` は待っている `#pump` へ直接渡り、
    // 2件目は待ち行列に並ぶ（`Inbox#push` の waiter 経路）。つまり解除の時点で
    // **待ち行列には既に別の合図が居る** — 保持していた分を `push`（末尾）で
    // 戻すと、あとから届いた三件目に追い越される。`Inbox#unshift`（先頭へ戻す）
    // でなければ到着順が崩れる、というのがこの本の見ている歯である。
    s.clone.post(humanMessage('二件目'));
    s.clone.post(humanMessage('三件目'));

    // **2件目に何が投げられるかで決まる。** 先頭へ戻していれば保持していた
    // 一件目の再試行、末尾へ積んでいれば追い越した三件目になる。**どちらの
    // 世界でも入力は2件以上になる**ので、この待ちはタイムアウトせず、下の
    // `toEqual` が落ちる（AGENTS.md「タイムアウトは歯があった証拠にならない」）。
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '2件目の入力が投げられる');
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 2)).toEqual(['一件目', '一件目']);

    // 二件目と三件目は**1ターンにまとめて**読まれる（#123 のまとめ読み。連続する
    // 同じ会話の人間の発言なので `drainWhile` が両方取る）。保持していた一件目は
    // `#heldForUsage` で対象外なので、まとめられずに単独で先に読まれる。
    // ＝ ターンは「一件目(初回) → 一件目(再試行) → 二件目＋三件目」の3本。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual(['一件目', '一件目', '二件目']);
    // 3本目のターンに両方の本文が、到着順で載っている（`labelOrder` は最初に
    // 当たった1つを返すので、まとめられた側はここで別に見る）。
    const merged = inputs[2] ?? '';
    expect(merged).toContain('二件目');
    expect(merged).toContain('三件目');
    expect(merged.indexOf('二件目')).toBeLessThan(merged.indexOf('三件目'));

    await s.clone.stop();
  });

  /**
   * **解除を `#pump` へ移したことで新しく開いた口を塞いでいるのがこの本である。**
   *
   * 解除が `post()` に在ったあいだ、閉じた受信箱へ戻してしまう心配は無かった —
   * `post()` は先頭で `#stopped` を見て return するからである。`#pump` の先頭へ
   * 移すと、そのガードが効かない側へ出る: `stop()` は `#inbox.close()` を呼ぶが、
   * `for await` は待ち行列に残った分を吐き出しながら回り続けるので、**閉じた後に
   * 解除の地点へ来る**ことがありうる。`Inbox#unshift` は閉じた受信箱では投げ、
   * そこは `try` の外なので、投げれば受信箱のループごと死ぬ（`#pump` は `void`
   * で起こしてあるので unhandled rejection ＝ デーモンごと落ちうる。走行中の
   * マネージャーも巻き添えになる）。
   *
   * **この順序は `#query === null` でなければ作れない。** `stop()` は `#query` が
   * 在れば蒸留を `await` するので、その間に `#pump` が先頭へ到達して印を消費して
   * しまう。枠に当たった直後にセッションが終わる台本（`endSessionAfterTurn`）で
   * `#query` を null にすると、`stop()` は `await` を1つも通さずに `#inbox.close()`
   * まで進む。
   *
   * **落ち方について正直に言う。** ガードを外すとこの本は
   * 「unhandled rejection ＋ 待ちのタイムアウト」で落ちる。**アサーションの不一致
   * ではない**（AGENTS.md「タイムアウトは歯があった証拠にならない」）。それでも
   * 付ける理由は、unhandled rejection が汎用のタイムアウトとは違って**原因を
   * 名指しする**特定の信号だからである。
   */
  it('受信箱が閉じた後に解除の印が残っていても、受信箱のループを殺さない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
      // 1本目のターンを出し終えたらセッションを終わらせる ＝ `#query` が null。
      endSessionAfterTurn: 0,
    });

    const first = humanMessage('一件目');
    s.clone.post(first);
    await waitForTerminal(s.events);
    // 保持されたこと（＝`#deferred` へ積み終わったこと）を器の側で待つ。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === first.id);
    }, '一件目が未読として保持される');
    // **この本が要る場所（#1220 の観測点ずれ）。** 上の2つの待ちは「終端の
    // 出来事が来たか」「器が未読を覚えたか」しか見ておらず、**`#read()` の
    // `finally` が `this.#query = null` を打ち終えたか**は見ていない。壁時計の
    // ポーリングだった頃は、そこへ実時間が経つことで黙って追いついていた
    // （`flushPendingMicrotasks` の doc に実測を書いた）。追いつく前に
    // `post(second); stop();` へ進むと、`stop()` が `#query` をまだ非 null と
    // 見て蒸留を待ち、その間に「二件目」の解除が先に走ってしまう——この本が
    // 検出したい「受信箱を閉じた後に解除の印が残っている」状況そのものが
    // 作れなくなる。
    await flushPendingMicrotasks();
    const terminalsBefore = s.events.filter(isTerminal).length;

    // 印を立てて（`post`）、`#pump` が先頭へ戻る前に閉じる（`stop`）。
    const second = humanMessage('二件目');
    s.clone.post(second);
    await s.clone.stop();

    // **解除しなかったほうの被害は無い。** 二件目には「枠で保持した」終端が届き、
    await s.waitForEvents((events) => events.filter(isTerminal).length === terminalsBefore + 1);
    // どちらの合図も器に未読のまま残る（次の起動で `#restoreUnread` が拾い直す。
    // この機構が生死をまたげる理由がそれである）。
    const pending = await s.stores.inbox.claimPending();
    expect(pending.map((p) => p.event.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('org_policy では待たない（保持せず、従来どおり失敗として消える）', async () => {
    // SDK のプレフィックス集合そのもの（自前の文言を作らない）。
    const orgPolicyMessage = 'This service is disabled for your org by admin decision.';
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: orgPolicyMessage,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);

    expect(s.events.filter(isTerminal).map((e) => e.type)).toEqual(['error']);
    // 「待たない」＝ usage_limited を出さない。
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(false);

    // 「保持しない」＝ 従来どおり forget されて器から消える。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, 'org_policy の合図は保持されず forget される');

    await s.clone.stop();
  });

  it('rate_limit_event の status: rejected でも枠が閉じたと判定する', async () => {
    // `result` の文言には上限のプレフィックスを一切含めない。届く usage_limited
    // が rate_limit_event 経路だけで説明できることを確かめるため。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(true);

    s.clone.post(humanMessage('二件目'));
    // 1本目の再試行（同じ rate_limit_event が毎ターン付くので再び失敗）＋
    // 2本目の短絡で terminal は合計3件になる。何を待っているか・経緯は
    // 上（`枠が閉じている間に届いた2本目は…`）と同じ（`s.waitForEvents` の
    // doc 参照）。
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);

    // 2本目はターンを回さない ＝ rate_limit_event 経路だけでも保持が効いている。
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('rate_limit_event で status: rejected が来ても、同じターンの result が成功したら保持されない', async () => {
    // `rate_limit_info` の `status` は枠1つぶんの状態でしかない
    // （`rateLimitFactsSchema` — `status` とは別に `overageStatus` /
    // `usingOverage` / `overageResetsAt` がある）。`five_hour` が `rejected`
    // でも課金枠（overage）に落ちてターンは成功する組み合わせが構造上あり、
    // `usage-limits.ts` の `usageTransitionOf` は `entered_overage` として
    // 名前まで付けている通常の遷移である。この組み合わせで、答えが返って
    // 終わった合図まで保持・再送されない（＝成功した仕事の二重実行にならない）
    // ことを確かめる。
    const s = setup(undefined, createMemoryStores(), {
      rateLimitEventAt: (turnIndex) =>
        turnIndex === 0
          ? { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true }
          : undefined,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);
    // 検知そのものは起きる（usage_limited は届く）が、ターンは成功して done。
    expect(s.events.filter(isTerminal).map((e) => e.type)).toEqual(['done']);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, '成功したターンの合図は保持されず forget される');

    await s.clone.stop();
  });

  it('（追加確認）system/notification の上限文言でも枠が閉じたと判定する', async () => {
    // 検知3経路の最後の1つ。必須の6本には無いが、`#dispatch` の `case 'system'`
    // に足した分岐を素通りさせないためにここで直接確かめる。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。system 通知だけが上限の理由を運ぶ）',
      systemNoticeAt: () => ({ subtype: 'notification', text: spendLimitMessage }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(true);

    s.clone.post(humanMessage('二件目'));
    // 何を待っているか・経緯は上（`枠が閉じている間に届いた2本目は…`）と同じ
    // （`s.waitForEvents` の doc 参照）。
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('同じ transition の通知が2回届いても、日誌のその行は1件しか増えない', async () => {
    // `transition` は待たない（まだ動く）分類なので、ターンは毎回 done で
    // 終わり、`system` の通知は毎ターン繰り返し届く（`usage-limits.ts` の
    // `usageTransitionOf` の doc「毎ターン届く同じ事実で受信箱を埋めないこと」
    // と同じ場面）。`#notices`（`CloneNotices` の `#usage`）で畳んでいなければ、
    // 同じ文言の行がターンの数だけ日誌に増える。
    const transitionMessage = "You're now using extra usage until your limit resets.";
    const s = setup(undefined, createMemoryStores(), {
      systemNoticeAt: () => ({ subtype: 'notification', text: transitionMessage }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForDone(s.events);

    s.clone.post(humanMessage('二件目'));
    // 何を待っているか・経緯は上（`枠が閉じている間に届いた2本目は…`）と同じ
    // （`s.waitForEvents` の doc 参照）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const matching = exchanges.filter((entry) => entry.text.includes(transitionMessage));
    expect(matching).toHaveLength(1);

    await s.clone.stop();
  });

  /**
   * ## 保持（枠）の間、配り直しの印（`#redelivered`）は消えない ── 解除で戻ってきても断り書きは付く
   *
   * **なぜこの歯が要るか。** Issue https://github.com/takecchi/alteroid/issues/351 は
   * 「枠解除ブロック（この `describe` が検証している `#pump` 先頭の解除処理）が
   * `#redelivered` / `#redeliveredClosed` の `Map` 2つを触らないので、解除で戻って
   * きた配り直しの合図は断り書き無しの全文で届く」と書いていた。**これは逆である。**
   *
   * - `#redelivered` を**消すのは `#forget` の1箇所だけ**（`clone.ts` の `#forget`）
   * - 枠で保持する枝（`#settleInboxEvent` の `else if (defer)`）は **`#forget` を
   *   呼ばない**
   * - ⟹ **保持している間、印は消えない ⟹ 解除で戻ってきた合図にも断り書きは付く**
   *
   * **そしてこれは偶然ではなく、意図して選ばれている。** `#settleInboxEvent` の
   * 当該枝に逐語でこう書いてある（`grep -Fn -- '保持したことを覚えておく' packages/core/src/clone.ts`）:
   *
   * > 保持したことを覚えておく（`#heldForUsage` の doc）。**印を消すのは
   * > `#forget` と同じ側である** ── 保持している間に消すと、解除で戻ってきた
   * > 合図が「初めて届いたもの」に見えてまとめ読みの対象へ戻る。
   *
   * Issue #351 は 2026-08-27 に `not planned` で閉じた（前提が成り立たなかった
   * ため）。**⟹ 閉じたことで、この振る舞いを守るものが doc のコメントだけになった。
   * ⟹ だからここに歯を入れる。**
   *
   * **筋書き**: (1) 器（`stores.inbox`）に未読の合図を直接残し、前のプロセスが
   * 死んだ状況を作る → クローンを起こして `#restoreUnread` に拾わせる
   * （＝ `#redelivered` に印が立つ）。(2) 枠を閉じて、その合図を保持させる。
   * (3) 枠を解除して、戻ってきた合図が実際にターンへ載るところまで進める。
   * (4) そのターンの入力に配り直しの断り書き（「これは配り直しである」/
   * 「回目の配達」）が載っていることを、SDK へ実際に渡った入力（`FakeCall.inputs`）
   * で見る。**`#redelivered` の Map を直接覗かない** ── private field を覗く形は
   * 実装を変えた瞬間に意味を失うので、外から見える振る舞い（ターンへ渡る入力）
   * で固定する。
   */
  it('枠で保持された合図が解除で戻ってきても、配り直しの断り書きは付いたまま届く（#351 は逆を主張していたが、印を消すのは #forget だけである）', async () => {
    const stores = createMemoryStores();
    const held = humanMessage('一件目');
    // 前のプロセスが死んだ状況（未読のまま器に残った合図）を直接作る。
    await stores.inbox.put(held, new Date(0).toISOString());

    const s = setup(undefined, stores, {
      // turn 0（#restoreUnread が拾い直した一件目の初回試行）だけ枠で失敗させる。
      // それ以降（解除後の再試行・二件目）は成功させる。
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    // #restoreUnread が起動直後に一件目を拾い直し、#redelivered に印を立てて配る
    // （このテストは一件目について `post()` を1度も呼んでいない）。枠で失敗する
    // ので保持される。
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === held.id);
    }, '拾い直した一件目が枠で保持される');

    // 新しい合図（二件目）を届けて、枠の解除を試させる。
    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);

    const inputs = (s.calls[0] as FakeCall).inputs;
    // turn 0: #restoreUnread からの初回配達。配り直しの断り書きが付く（前提）。
    expect(inputs[0] ?? '').toContain('一件目');
    expect(inputs[0] ?? '').toContain('これは配り直しである');
    expect(inputs[0] ?? '').toContain('回目の配達');

    // turn 1: 枠の解除で戻ってきた同じ一件目。**ここが #351 の逆を確かめる本体**
    // ―― 保持している間 #forget を呼んでいないので #redelivered は消えておらず、
    // 解除後の再試行にも断り書きが付く。
    expect(inputs[1] ?? '').toContain('一件目');
    expect(inputs[1] ?? '').toContain('これは配り直しである');
    expect(inputs[1] ?? '').toContain('回目の配達');

    // turn 2: 二件目自身は #restoreUnread を経由していないので、断り書きは付かない
    // （対照 ―― どんな入力にも常に付くわけではないことを見る）。
    expect(inputs[2] ?? '').toContain('二件目');
    expect(inputs[2] ?? '').not.toContain('これは配り直しである');

    await s.clone.stop();
  });
});

/**
 * **枠（利用上限）で保持している間、人間へ返す1行を積み上げない**
 * （`clone.ts` の `#notices`。`clone-notices.ts` の `CloneNotices` の
 * `#humanFailure`）。
 *
 * ## 人間の報告（2026-09-07）
 *
 * > トークンの上限にあたった状態で会話をすると、「いま利用上限に当たっているので、
 * > この発言にはまだ返せない。発言は捨てずに保持していて、枠が開いたら試し直して
 * > 返信する。」が定期的に積み上がり続ける。
 *
 * ## 機構（直す前）
 *
 * 保持した発言は**新しい合図が届くたびに**試し直される（`#usageBlocked` の doc。
 * 誰も話しかけなければ `self_initiative` が既定間隔ごとに試す）。試し直しは毎回
 * 同じ理由で落ち、`#reportFailure` はそのたびに `with: 'human'` の1行を書く。
 * ⟹ **保持している発言の件数 × tick の回数**だけ、一字一句同じ行が増える。
 * 人間は何もしていないのに増えるので「定期的に積み上がり続ける」に見える。
 *
 * ## 歯を3本に分ける（畳みすぎ＝黙って失う、を同時に測る）
 *
 * 1. **畳む** —— tick を何回受けても、人間へ返る行は増えない
 * 2. **取りこぼさない** —— 人間から新しい発言が来たら、必ず1行返る
 * 3. **畳んだことが記録に残る** —— 畳んだ回は日誌（`self`）に1件ずつ、何件目か
 *    付きで残り、**失敗そのものの記録は1件も畳まれていない**
 *
 * ## 同期は「失敗の記録の件数」で取る（畳み込みの跡では待たない）
 *
 * 待ちの条件に「畳んだ」旨の日誌行を使うと、**直す前の世界ではその行が永久に
 * 出ない** ＝ 落ち方がタイムアウトになる（AGENTS.md「タイムアウトは歯があった
 * 証拠にならない」）。`#reportFailure` 前半の `with: 'self'` の失敗の記録は
 * **畳まないので直す前と後で同じ件数だけ出る** ⟹ そこを barrier にすれば、
 * 直っていない世界でも待ちは抜けて**アサーション不一致で落ちる。**
 */
describe('クローン — 枠で保持している間、人間へ返す1行を積み上げない', () => {
  const spendLimit = "You've hit your individual spend limit for this account.";
  /** 人間へ返る1行の頭（`#reportFailure`）。 */
  const heldNotice = 'いま利用上限に当たっているので';
  /** 畳んだ回の跡（`with: 'self'`）。 */
  const foldedMark = '人間へ返す1行は畳んだ';
  /** 失敗そのものの記録（畳まない側。barrier に使う）。 */
  const failureMark = '人間との対話ターンが失敗した';

  async function rows(stores: Stores): Promise<{ with: string; role: string; text: string }[]> {
    return (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
    }[];
  }
  const count = (
    entries: { with: string; role: string; text: string }[],
    who: string,
    fragment: string,
  ): number =>
    entries.filter(
      (entry) => entry.with === who && entry.role === 'outbound' && entry.text.includes(fragment),
    ).length;

  /**
   * 枠が閉じたまま、発言2本を保持している状態を作る。
   *
   * 返り値の `s` はそのまま使い回す（`stop()` は呼び出し側でする）。
   */
  async function setupHeld(): Promise<Setup> {
    const s = setup(undefined, createMemoryStores(), {
      // **固定値のスタブにしない**（何回目かで挙動を変える `resultFor`）。ここでは
      // 全ターン枠で落とす —— 枠が開かないまま tick が来る、という筋書きそのもの。
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimit }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    // 一件目の初回失敗ぶんの記録（1件）が器へ届くまで待つ。
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === 1,
      '1件目の失敗',
    );

    // 二件目の到着が「保持していた一件目の再試行」を1回だけ誘発する。その再試行も
    // 同じ理由で落ちるので枠は閉じたままで、二件目自身は短絡される（＝失敗の記録は
    // 合計3件になる）。
    s.clone.post(humanMessage('二件目'));
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === 3,
      '一件目の再試行と二件目の短絡',
    );
    return s;
  }

  /** 発意 tick を1本入れて、枠の解除（＝保持分の試し直し）を1周させる。 */
  async function tick(s: Setup, id: string, expectedFailures: number): Promise<void> {
    s.clone.post({
      type: 'self_initiative',
      id,
      at: new Date().toISOString(),
      reason: '定期 tick',
    });
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === expectedFailures,
      `${id} で保持分が試し直される`,
    );
  }

  it('歯1: tick を2回受けても、人間へ返る1行は増えない（発言2本ぶんの2行のまま）', async () => {
    const s = await setupHeld();
    // 保持しているのは2本。ここまでで人間へ返っているのは**発言1件につき1行**。
    expect(count(await rows(s.stores), 'human', heldNotice)).toBe(2);

    // tick 1周ごとに、保持している2本が試し直されて2件の失敗の記録が増える
    // （3 → 5 → 7）。**直す前は、この2件ぶんがそのまま人間へ返る行になっていた。**
    await tick(s, 'evt-tick-1', 5);
    await tick(s, 'evt-tick-2', 7);

    const entries = await rows(s.stores);
    // 失敗そのものは7件起きている（畳んでいない）。
    expect(count(entries, 'self', failureMark)).toBe(7);
    // **人間へ返る行は2行のまま。** 直す前はここが 6 になる（2 + 2 + 2）。
    expect(count(entries, 'human', heldNotice)).toBe(2);

    await s.clone.stop();
  });

  it('歯2: 人間から新しい発言が来たら、保持中でも必ず1行返る（畳みすぎていない）', async () => {
    const s = await setupHeld();
    await tick(s, 'evt-tick-1', 5);
    expect(count(await rows(s.stores), 'human', heldNotice)).toBe(2);

    // 三件目。**これは新しい発言なので、返事が消えてはいけない**（#92 が塞いだ
    // 「自分の発言だけがあって返信が無い」へ戻る）。到着は保持分（2本）の
    // 試し直しも誘発するので、失敗の記録は 5 → 8 になる。
    s.clone.post(humanMessage('三件目'));
    await waitFor(
      async () => count(await rows(s.stores), 'self', failureMark) === 8,
      '三件目の到着で保持分が試し直される',
    );

    // **1行だけ増える。** 「何でも畳む」実装ならここが 2 のまま（＝人間の発言が
    // 無視されたように見える）、畳まない実装なら 5 以上になる。
    expect(count(await rows(s.stores), 'human', heldNotice)).toBe(3);

    await s.clone.stop();
  });

  it('歯3: 畳んだ回は日誌（self）に1件ずつ、何件目か付きで残る', async () => {
    const s = await setupHeld();
    await tick(s, 'evt-tick-1', 5);

    const entries = await rows(s.stores);
    // 畳んだのは「二件目の短絡（1件）」＋「tick 1周ぶんの2件」＝3件。
    expect(count(entries, 'self', foldedMark)).toBe(3);
    const folded = entries
      .filter((entry) => entry.with === 'self' && entry.text.includes(foldedMark))
      .map((entry) => entry.text);
    // **何件目かが行に入っている。** 「畳んだ」だけでは、何件ぶんが人間へ返らな
    // かったのかを後から数えられない。**数え直しは「最後に返した1行」からである**
    // （人間の新しい発言でこの記憶は落ちるので、会話の通算にはならない）。
    expect(folded.some((text) => text.includes('最後に返した1行から数えて 1 件目'))).toBe(true);
    expect(folded.some((text) => text.includes('最後に返した1行から数えて 2 件目'))).toBe(true);
    // 畳んだ行にも本文が残っている —— 記録の側では1文字も失っていない。
    expect(folded.every((text) => text.includes(heldNotice))).toBe(true);

    await s.clone.stop();
  });
});

/**
 * `#settleInboxEvent` に足した「枠で保持している間、中身を持たない合図
 * （`isTick`）で在庫を作らない」の3本（`clone.ts` の `#foldsIntoHeldTick` /
 * `#noteFoldedTick` / `#deferred` / `isTick` / `isSameTick`）。
 *
 * 上の「枠が閉じたら保持して次の合図で試す」ブロックが確かめているのは FIFO・
 * 再試行そのものであり、ここで確かめるのは**その保持の中身が増え続けないこと**
 * （歯1・2）と、**畳んでも再試行の回数そのものは1回も減らないこと**（歯3）で
 * ある。3本とも `self_initiative` / `timer` 起点のターンは `ChatStreamEvent` を
 * 1件も出さない（`#conversationOf` が `human_message` 以外に `null` を返し、
 * `#emit` が `null` で即 return する）ので、`waitForTerminal` はここでは使えない。
 *
 * **歯1 の同期は「tick 自身の跡」を待たない。** かつては「畳んだ」旨の
 * 日誌行が出るのを待っていたが、畳み込みを殺す変異（`#foldsIntoHeldTick` を
 * `return false` にする）でも、畳み込みを `post()` 側へ動かす変異（畳まれた
 * tick が受信箱へ一切積まれなくなる）でも、その日誌行は永久に出ない —
 * どちらも**アサーション不一致ではなくタイムアウトで落ちる**形になってしまい、
 * 「タイムアウトは歯があった証拠にならない」に反する。代わりに `postTickThenPacer`
 * （下）で「tick を post した直後に、畳み込みの対象外である人間の発言
 * （pacer）を post し、その pacer 自身の終端が来るまで待つ」形にする。
 * 受信箱は直列 FIFO で、`#pump` の `for await` は1件の後始末
 * （`#settleInboxEvent` を含む）が完全に終わってから次を取り出すので、pacer
 * 自身の終端が観測できた時点で、直前に積んだ tick の後始末は必ず完了して
 * いる。**tick が畳まれたか保持されたかに関わらず**pacer は必ず受信箱を
 * 通って終端まで届くので、この待ちはどの変異が当たっていても必ず抜ける。
 * 歯2はこの変更の対象外（`calls[0].inputs.length` を直接見る既存の形のまま）。
 *
 * **歯3 は `postTickThenPacer` を使わない（過去に使っていたが、それ自体が
 * 歯3を測れなくしていたため外した）。** 歯3が測りたいのは「tick が**単独で**
 * 解除を1回起こすこと」であり、pacer（人間の発言）は畳み込みの対象外なので
 * それ自身の `post()` が必ず解除を1回起こしてしまう。畳み込みを `post()` 側へ
 * 戻す変異（tick が受信箱へ一切積まれなくなる）が当たっても、pacer 自身の
 * 解除が測定対象の代わりに数を稼いでしまい、期待する回数と実際の回数が
 * 偶然一致して歯が落ちない（実測でこの変異は歯3を生き残らせた）。歯3では
 * 代わりに `releaseAttemptCount`（日誌の「枠の解除を試す」行数）だけを見て
 * 同期する — 詳しい理由は歯3のテスト本体のコメントを見よ。
 *
 * **⚠️ この3本は `humanPriority: false`（人間優先を切った状態）に固定してある。**
 * `postTickThenPacer`（pacer 同期）も歯3の `releaseAttemptCount` 直接待ちも、
 * 「tick を post した直後に別の合図を post すれば、待ち行列上でも tick が先・
 * 後続が後という順序のまま処理される」という FIFO の歩調取りを前提にしている。
 * 人間優先（既定で有効。`CLONE_HUMAN_PRIORITY_ENV_KEY`）が入ると、pacer 自身が
 * 人間の発言なので待ち行列の人間の最後尾へ割り込みうる — 前提が崩れる（実測:
 * `humanPriority` を既定のまま歯1を走らせると `selfInitiatives` が1件のはずが
 * 2件になって落ちる）。**これらが測っているのは「FIFO の下での畳み込み」であって、
 * 「人間優先が有効なままでの畳み込み」ではない。人間優先が有効なままでの畳み込みは
 * 別の歯（`人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない`）が
 * 測る。**
 */
describe('クローン — 枠で保持している間、中身を持たない合図で在庫を作らない', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /**
   * `humanPriority: false` に固定したセットアップ。**このブロックの3本
   * （歯1・2・3）専用。** 上のブロック doc の「⚠️」の理由により、FIFO の
   * 歩調取り（`postTickThenPacer` / `releaseAttemptCount` 直接待ち）はこの前提
   * が崩れると測れなくなる。`setup()`（ファイル冒頭）は `env` を渡す口しか
   * 持たないので、ここでは `setupWithHumanPriority`（ファイル末尾）と同じ形で
   * `createClone` を直接呼び、`CloneOptions.humanPriority` を直渡しする。
   */
  function setupFixedFifo(
    reply?: (input: string) => string,
    stores: Stores = createMemoryStores(),
    sdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ): Setup {
    const { fn, calls } = fakeSdk(reply, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      humanPriority: false,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  /**
   * **tick を畳んだ**旨の日誌の行数（`#noteFoldedTick`）。
   *
   * **`'畳んだ'` では絞らない。** 枠が閉じている間に畳むものは tick だけではなく、
   * 人間へ返す1行も畳む（`#notices` の `#humanFailure`。「枠で保持している間、
   * 人間へ返す1行を積み上げない」の describe）。その跡も「畳んだ」と書くので、`'畳んだ'` で
   * 数えるとこの歯は**別の機構の行まで数える** —— 実際に 2 を期待する行が 8 を
   * 数えた。
   *
   * **絞り込みは `#noteFoldedTick` の逐語で行う**（`grep -Fn -- '枠で保持している
   * 同じ合図' packages/core/src/clone.ts`）。**保証は弱くなっていない** —— 数える
   * 対象を「畳んだと書いてある行すべて」から「tick を畳んだ行」へ特定しただけで、
   * この歯が測りたかったもの（`#noteFoldedTick` が正しい場所で走るか）はそのまま
   * である（AGENTS.md「対象をスコープして特定する ⟹ 保証が強くなる」）。
   */
  async function foldedNoteCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠で保持している同じ合図')).length;
  }

  /**
   * 解除の試行が `expected` 回に達するまで待つ。**当初は歯3専用だったが、
   * 「人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない」
   * （後述）も同じ待ちを使う。**
   *
   * ⛔ **壁時計の打ち切りを持たない**（#1220）。ここにはかつて
   * `RELEASE_WAIT_BUDGET_MS = 15_000` が在り、「共有の `waitFor` は 3 秒で
   * 諦めるので、この歯だけ負荷に耐える側へ倒す」という理由で独自の予算を
   * 持っていた。⟹ **その理由のほうが消えた** —— `waitFor` から打ち切り
   * そのものが無くなったので、別の予算を持つ意味が無い（`waitFor` の doc）。
   *
   * ## この待ちが言えないこと（計器の側に貼る）
   *
   * **「起きなかった（実装の退行）」と「器が遅すぎた（飽和）」を区別できない。**
   * どちらも同じ落ち方で出る。**赤を見たら、実装の退行を探しに行く前に
   * 器の負荷を疑うこと** — 他の歯（歯1・歯2）はアサーションの不一致で数十 ms
   * のうちに落ちるので、**そちらが緑のままここだけが数秒かけて落ちているなら、
   * 退行の可能性が高い。逆に全体が遅いなら飽和を先に疑う。**
   *
   * ⚠️ **落ち方は変わった。** 打ち切りを持っていた頃はこの関数自身が理由付きの
   * 例外を投げたが、いまは `it()` の明示のタイムアウトで落ちる。**理由は
   * `afterEach` が stderr へ出す待ちの `label` に載せてある**（`waitFor` の doc）
   * ので、下の `label` を無内容にしないこと。
   */
  async function waitForReleaseAttempts(s: Setup, expected: number, what: string): Promise<void> {
    await waitFor(
      async () => (await releaseAttemptCount(s)) === expected,
      `${what}: 解除の試行が ${expected} 回になるのを待っている`,
    );
  }

  /**
   * 解除の試行が `baseline` より増えるまで待つ。**目標を固定値にできない歯用**
   * （「人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない」）。
   * 人間の発言も枠の解除を誘発しうる（`post()` の `#releaseRequested` は起点の
   * 種類を問わない）ので、そのぶんの回数を歯の側で先読みできない。**打ち切りを
   * 持たない理由と断り書きは `waitForReleaseAttempts` と同じなのでそちらを見よ。**
   */
  async function waitForReleaseAttemptsAbove(
    s: Setup,
    baseline: number,
    what: string,
  ): Promise<void> {
    await waitFor(
      async () => (await releaseAttemptCount(s)) > baseline,
      `${what}: 解除の試行が ${baseline} 回より増えるのを待っている`,
    );
  }

  /** 「枠の解除を試す」旨の日誌の行数（＝解除を試した回数そのもの）。 */
  async function releaseAttemptCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  /**
   * `stores.inbox.put` の呼び出し回数を合図 id ごとに数える薄いラッパー。
   *
   * `#remember`（`clone.ts`）は `post()` の中で「受理した時点」に呼ばれ、
   * `#foldsIntoHeldTick` の判定より**前**にある。だから畳まれる側の tick でも、
   * 畳み込みが `#settleInboxEvent`（受信箱から取り出した後）で起きている限り
   * 必ず一度は `put` が呼ばれる。**畳み込みを `post()` 側（受信箱へ積む前）へ
   * 動かす変異が当たると、畳まれる側の tick はここが 0 のまま残る** — 歯1 の
   * `foldedNoteCount`（日誌の跡）とは別の観測点（器への書き出しそのもの）で、
   * 同じ「畳み込みが正しい場所で起きているか」を確かめる。
   */
  function withInboxPutSpy(stores: Stores): {
    stores: Stores;
    putCallCountFor: (id: string) => number;
  } {
    const counts = new Map<string, number>();
    const original = stores.inbox;
    const spiedInbox: Stores['inbox'] = {
      ...original,
      async put(event, at) {
        counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
        return original.put(event, at);
      },
    };
    return {
      stores: { ...stores, inbox: spiedInbox },
      putCallCountFor: (id) => counts.get(id) ?? 0,
    };
  }

  /**
   * ある conversation の終端（`done` か `error`）が来るまで待つ。`s.events`
   * （`wireEvents`）は `conv-1` にしか張っていないので、pacer 専用の
   * conversation で終端を見るにはここで別に購読を張る必要がある。
   */
  function waitForTerminalOn(clone: CloneHost, conversationId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = clone.subscribe(conversationId, (event) => {
        if (event.type === 'done' || event.type === 'error') {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * tick を1件 post した直後に、専用の conversation を持つ人間の発言
   * （pacer）を1件 post し、その pacer 自身の終端（`done`/`error`）が来る
   * まで待つ。
   *
   * **同期の根拠はファイル冒頭の doc comment を参照。** ここでは繰り返さない
   * — 要は「pacer は畳み込みの対象外なので必ず受信箱を通り、直列 FIFO の
   * 性質上、pacer の終端が来た時点で直前の tick の後始末は必ず終わっている」
   * という一点である。**tick 自身の跡（畳んだ日誌・在庫の中身）はここでは
   * 一切見ない。**
   *
   * pacer の conversation id は呼び出しごとに変える — 起点や他の pacer の
   * 終端と混ざらないようにするため（`conv-1` を共有すると「何件目の終端か」
   * を数える形になり、脆くなる）。
   */
  async function postTickThenPacer(
    clone: CloneHost,
    tick: InboxEvent,
    pacerConversationId: string,
  ): Promise<void> {
    const terminal = waitForTerminalOn(clone, pacerConversationId);
    clone.post(tick);
    clone.post(humanMessage(`pacer(${pacerConversationId})`, pacerConversationId));
    await terminal;
  }

  // **この歯は2つの要求を同時に見ている。** (1) 在庫が増えないこと
  // （`selfInitiatives` が1件のまま — M1「畳み込みを殺す」・M2「何でも畳む」が
  // 壊す）と、(2) 畳んだ跡が日誌に残ること（`foldedNoteCount` — M3「畳み込みを
  // `post()` 側へ戻す」が壊す。`post()` 側で畳むと `#noteFoldedTick` を通らない）。
  // **だから3つの変異全部でこの歯が落ちる。** どちらも本物の要求なのでアサー
  // ションは1つも削らない — 「なぜ全部の変異で落ちるのか」を次に読む者が
  // 疑わずに済むように、ここへ明記しておく。
  it('歯1: 発意 tick を続けて送っても、保持する在庫は1件のまま増えない', async () => {
    const s = setupFixedFifo(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    // 既存テスト（「枠に当たった合図は forget されない」）と同じ待ち方 — 起点が
    // 未読として保持し終わるまで待つ。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // 1本目: まだ何も保持していないので畳めない（`#deferred` に self_initiative
    // が無い）。実際にモデルへ渡る「起点」の再試行を1回誘発して、初めて
    // `#deferred` に self_initiative が1件乗る。同期は tick 自身の跡ではなく
    // pacer（人間の発言）の終端を待つ（`postTickThenPacer` の doc）。
    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-1', at: new Date().toISOString(), reason: '1本目' },
      'conv-pacer-1',
    );

    // 2本目: 既に保持している self_initiative（1本目）へ畳まれる（はず）。
    // 畳まれた分は `#forget` されて器の未読からも消える。
    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-2', at: new Date().toISOString(), reason: '2本目' },
      'conv-pacer-2',
    );

    // 3本目も同様に畳まれる（はず）。
    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-3', at: new Date().toISOString(), reason: '3本目' },
      'conv-pacer-3',
    );

    const pending = await s.stores.inbox.claimPending();
    const selfInitiatives = pending.filter((p) => p.event.type === 'self_initiative');
    // 在庫は1件だけ（3回届いたのに増えていない）。
    //
    // **「1件」が言えるのは、1件ずつ順番に送った場合に限る。** 極端に詰めて送ると
    // 2件になりうる — 畳み込みの相手は `#deferred` に**入った後**の合図なので、
    // 受信箱から取り出されてから `#settleInboxEvent` が積むまでの間に次が届くと、
    // その1件は畳む相手を見つけられない（`#pump` の「`isTick` の畳み込みは
    // 『処理中の1件＋待ち行列の1件』を残す形で効いている」と同じ形の下限である）。
    // **実世界の tick は既定で55分間隔**（`apps/daemon/src/schedule.ts` の
    // `DEFAULT_INITIATIVE_EVERY_MINUTES`）なのでこの形で書いてある。
    //
    // **だから「2件になった」を回帰と読まないこと。** 詰めて送れば起きる正常な
    // 下限であって、在庫が青天井に増える（直す前は3回で3件だった）のとは別物である。
    expect(selfInitiatives).toHaveLength(1);
    // 動いていないのは**先に保持していた側**（1本目）である。畳むのは新しく
    // 届いた方だけで、既に保持している側は触らない。
    expect(selfInitiatives[0]?.event.id).toBe('evt-si-1');
    // 畳んだ跡が2件、日誌に残る（2本目・3本目のぶん）。
    expect(await foldedNoteCount(s)).toBe(2);
    // 起点（人間の発言）は畳み込みの対象外なので、未読のまま残っている。
    expect(pending.some((p) => p.event.id === origin.id)).toBe(true);

    await s.clone.stop();
  });

  it('歯2: 中身を持つ合図・別の日のタイマーは畳まれず、枠が開けば到着順に処理される', async () => {
    // 枠を「途中までは閉じたまま、合図で明示的に開けるまでは開かない」形にする
    // ための可変フラグ。再試行が何回起きるかを数えずに済ませるための口
    // （`resultFor` は毎ターン呼ばれるので、フラグを見るだけで済む）。
    let releaseGateOpen = false;
    const s = setupFixedFifo(undefined, createMemoryStores(), {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // **畳まれてはいけない**もの4種。1件ずつ post し、前の分が誘発した「起点」の
    // 再試行が実際に投げられたことを待ってから次を送る。
    const second = humanMessage('二件目');
    s.clone.post(second);
    await waitFor(async () => (s.calls[0]?.inputs.length ?? 0) >= 2, '二件目が誘発した再試行');

    const manager = {
      type: 'manager_message' as const,
      id: 'evt-manager',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report' as const,
      text: 'マネージャーからの一件（目印テキスト）',
    };
    s.clone.post(manager);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 3,
      'manager_message が誘発した再試行',
    );

    const timerA = {
      type: 'timer' as const,
      id: 'evt-timer-a',
      at: new Date().toISOString(),
      kind: 'custom-check',
      target: '2026-08-20',
    };
    s.clone.post(timerA);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 4,
      'timer(08-20) が誘発した再試行',
    );

    // kind / cause は同じで target だけが違う ＝ 別の日 ＝ 別の仕事（`isSameTick`
    // の doc）なので、timerA が保持中でも畳まれてはいけない。
    const timerB = {
      type: 'timer' as const,
      id: 'evt-timer-b',
      at: new Date().toISOString(),
      kind: 'custom-check',
      target: '2026-08-21',
    };
    s.clone.post(timerB);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 5,
      'timer(08-21) が誘発した再試行',
    );

    // ここまでの5件（起点＋畳まれてはいけない4件）は、すべて未読として保持
    // されている。1件も畳まれていない。
    const heldIds = [origin.id, second.id, manager.id, timerA.id, timerB.id];
    const pendingBeforeOpen = await s.stores.inbox.claimPending();
    for (const id of heldIds) {
      expect(pendingBeforeOpen.some((p) => p.event.id === id)).toBe(true);
    }
    expect(await foldedNoteCount(s)).toBe(0);

    // 枠を開けて、続きの合図（トリガー）を送る。これで保持していた分から順に
    // 配り直され、実際に成功して処理される。
    releaseGateOpen = true;
    const trigger = humanMessage('トリガー');
    s.clone.post(trigger);
    // 起点・二件目・トリガーの3件だけが人間の発言（chat の宛先を持つ）なので、
    // `done` は3件。manager_message / timer は宛先が無い内部ターンなので
    // `ChatStreamEvent` を出さない（このブロックの doc）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);

    // 到着順のまま処理されたことを、`calls[0].inputs` に載った本文の出現順で
    // 確かめる（`labelOrder` と同じ考え方。ここは型が混ざるので専用の目印で見る）。
    //
    // **単なる部分一致では見られない。** `#recentDigest`（tick 系のプロンプトに
    // 載る「引き受けたまま終わっていない仕事」一覧）は、その時点で台帳に載って
    // いる全件を列挙する。`post()` は同期でその場で台帳へ載せる（`#commit` の
    // doc）ので、**まだ自分の番が来ていない合図でも、後から届いた分の digest には
    // 先に載る**（実測: `トリガー` は一覧の最後に post するが、その digest 一覧
    // 自体は timerA/timerB の番でもう出現していた）。だから「その合図**自身**の
    // ターン本文」に固有の並び（`commitmentNoticeFor` が本文の直前に必ず挟む
    // `\n\n---\n` の直後）で狙う — digest の列挙側にはこの並びが出ない
    // （`- evt-x（...）\n  本文` という別の形である）。
    const inputs = (s.calls[0] as FakeCall).inputs;
    const firstIndexOf = (marker: string) => inputs.findIndex((text) => text.includes(marker));
    const order = {
      二件目: firstIndexOf('\n\n---\n二件目'),
      manager: firstIndexOf('（報告）\n\nマネージャーからの一件（目印テキスト）'),
      timerA: firstIndexOf('対象: 2026-08-20'),
      timerB: firstIndexOf('対象: 2026-08-21'),
      トリガー: firstIndexOf('\n\n---\nトリガー'),
    };
    for (const [label, index] of Object.entries(order)) {
      expect(index, `${label} が calls[0].inputs に見つからない`).toBeGreaterThanOrEqual(0);
    }
    expect(order.二件目).toBeLessThan(order.manager);
    expect(order.manager).toBeLessThan(order.timerA);
    expect(order.timerA).toBeLessThan(order.timerB);
    expect(order.timerB).toBeLessThan(order.トリガー);

    await s.clone.stop();
  });

  /**
   * ## 歯3 が守っているもの
   *
   * `#foldsIntoHeldTick` による畳み込みを `post()` 側（受信箱へ積む前）に移すと、
   * 畳まれた tick は受信箱へ何も積まない ＝ `#pump` の `for await` が次の要素を
   * 受け取れず、`#releaseRequested` の印を見に来る機会そのものが無くなる。
   * tick（`self_initiative` / `timer`）は「枠が開いたかを試す」ための**唯一の
   * 定期的な契機**なので、そうなった瞬間、枠が実際には開いているのに誰も
   * 気づかず再試行が静かに止まる — 費用は増えないが、仕事も二度と進まない。
   *
   * 実装（`clone.ts` の `#settleInboxEvent` 内）はこれを避け、畳み込みを
   * **受信箱から取り出した後**（＝解除の印は必ず処理済み）に置いている。だから
   * 「畳まれた」こと自体は歯1で確かめた在庫の話とは別に、**畳まれてもなお
   * 解除の試行そのものは1回も減っていない**ことを、ここで別に確かめる。
   *
   * 見るのは2つ — (1) 実際にモデルへ渡った回数（`calls[0].inputs`）、
   * (2) 日誌の「枠の解除を試す」行数（＝解除を試した回数そのもの、畳まれた
   * 分も含めて減っていないか）。この歯は「畳んだ跡」（`foldedNoteCount`）を
   * 1つも見ない — 見るのは解除の回数と実際の再試行回数だけである（畳んだ跡の
   * 記録は歯1の役割）。
   *
   * **ここでは `postTickThenPacer`（pacer 同期）を使わない。過去に使っていて、
   * それ自体がこの歯を測れなくしていたと判明したため外した。** 測りたいのは
   * 「tick が**単独で**解除を1回起こすこと」である。`#releaseRequested` は
   * 真偽値であってカウンタではない（`post()` が立てるのは印だけで、何回届いた
   * かは覚えない）。pacer（人間の発言）は畳み込みの対象外なので、pacer 自身の
   * `post()` も枠が閉じていれば必ず解除の印を立てる。つまり:
   *
   * - 正しい実装: tick が受信箱を通って解除の印を立てる → 解除1回
   * - 畳み込みを `post()` 側へ戻す変異: tick は畳まれて受信箱へ一切積まれず
   *   解除の印を立てない。**しかし直後の pacer が同じ印を立ててしまい**、
   *   結局どちらも解除1回になる — **回数が一致してしまい、歯は落ちない**
   *   （実測: この形の歯3はこの変異を生き延びた）。
   *
   * だから同期には、解除を起こしうる別の合図（pacer を含む）を一切混ぜない。
   * 代わりに tick を1件ずつ post し、その都度 `releaseAttemptCount` が
   * 1つずつ増えるのを直接待つ。
   */
  it('歯3: 発意 tick を畳んでも、枠が開いたかを試した回数は3回のまま減らない', async () => {
    const { stores, putCallCountFor } = withInboxPutSpy(createMemoryStores());
    const s = setupFixedFifo(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // 1件目の tick。この時点で `#deferred` に self_initiative は無いので
    // 畳まれる相手が居ない。届いたこと自体が `#releaseRequested` を立て、
    // `#pump` が次にこれを取り出した時点で解除を1回試す（保持していた起点を
    // 配り直し、その再試行がまた枠に当たって保持し直す）。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-1',
      at: new Date().toISOString(),
      reason: '1本目',
    });
    await waitForReleaseAttempts(s, 1, '1件目の tick');

    // 2件目の tick。ここでは既に `#deferred` に1件目（self_initiative）が
    // 保持されているので `#foldsIntoHeldTick` が真になり、この合図自体は
    // `#settleInboxEvent` で畳まれて捨てられる（在庫が増えないことは歯1の
    // 役割）。**畳み込みは受信箱から取り出した後で起きるので、届いた事実は
    // 必ず一度受信箱を通り、`#releaseRequested` を立てる。だから畳まれても
    // 解除の試行そのものは1回も減らない** — これがこの歯の本体である。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-2',
      at: new Date().toISOString(),
      reason: '2本目',
    });
    // **この待ちが歯の本体である。**
    //
    // 退行する（畳み込みを `post()` 側へ戻す＝上の doc の M3）と、この2件目の
    // tick は `post()` の時点で捨てられ、受信箱へ一切積まれない。積まれなければ
    // `#releaseRequested` を立てる機会そのものが無く、解除は起きない ＝ この
    // 待ちはタイムアウトで抜ける。
    //
    // **これは前回の壊れ方（postTickThenPacer を歯3にも使っていた版）とは別物
    // である。** 前回は「畳んだ跡が日誌に出るのを待つ」形で同期していたため、
    // **歯が測っているものとは無関係な理由で**、アサーションに到達する前に
    // タイムアウトしていた（＝タイムアウトが測定の代わりになっていなかった）。
    // **ここでのタイムアウトは、測っている当のものが起きなかったことそのもので
    // ある** — 「tick が単独で解除を起こす」の否定は「何も起きない」であり、
    // 何も起きないことは待つ以外に観測できない。**だからこのタイムアウトは
    // 測定であって、事故ではない。** AGENTS.md「タイムアウトは歯があった証拠に
    // ならない」は、**測っているものと無関係な待ちで落ちる形**を戒めたもので
    // あり、これはそれではない。
    await waitForReleaseAttempts(
      s,
      2,
      '2件目の tick（畳まれても回数は減らない — この待ちが歯の本体）',
    );

    // 3件目の tick。同様に畳まれるが、解除の試行はまた1回増える。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-3',
      at: new Date().toISOString(),
      reason: '3本目',
    });
    await waitForReleaseAttempts(s, 3, '3件目の tick（畳まれても回数は減らない）');

    // (1) 実際にモデルへ渡った回数。起点＋3回の再試行＝4回。全件が「起点」の
    // 本文を運んでいる（再試行は本文を変えない）。
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs.every((text) => text.includes('起点'))).toBe(true);
    expect(inputs).toHaveLength(4);

    // (2) 解除を試した回数そのもの。
    expect(await releaseAttemptCount(s)).toBe(3);

    // (3) 畳まれた分も含めて、tick はすべて一度は器へ書き出されている
    // （`withInboxPutSpy` の doc）。**畳み込みが `#settleInboxEvent` に在る
    // ＝ 合図が器へ書かれた後に畳む**ということなので、畳んだ側が `#forget`
    // で消しに行く必要がある、という実装の形がここに出ている。
    //
    // **この観測点も、畳み込みを `post()` 側へ動かす変異を捕まえる。**
    // `post()` の畳み込みは `#remember`（＝器への書き出し）より**前**に
    // return するので、2件目・3件目は器へ1度も書かれず 0 になる。
    // ただし実際にその変異を当てたときに落ちるのは (2) の待ちのほうで
    // （`releaseAttemptCount` が 2 にならずタイムアウトする）、ここまで
    // 到達しない。**「捕まえる観測点」と「実際に落ちる観測点」は別である。**
    expect(putCallCountFor('evt-si-1')).toBe(1);
    expect(putCallCountFor('evt-si-2')).toBe(1);
    expect(putCallCountFor('evt-si-3')).toBe(1);

    await s.clone.stop();
    // **明示のタイムアウト。** 上の `waitForReleaseAttempts` の予算より必ず大きく
    // すること — vitest の既定は 5 秒なので、付けないとこちらが先に当たり、
    // あの断り書き（「退行か飽和かを区別できない」）が読まれないまま
    // 汎用のタイムアウトに化ける。
  }, 30_000);

  /**
   * ## この歯が守っているもの
   *
   * 上の3本（歯1・2・3）は `humanPriority: false` に固定してある（このブロック
   * doc の「⚠️」）。**それだけだと、実際に出荷される設定（`humanPriority: true`
   * が既定）について畳み込みを測る歯が1本も無くなる** — そこが壊れても緑の
   * ままになる。ここではその穴を埋める。
   *
   * 足場に `postTickThenPacer` は使えない。人間優先の下では pacer（人間の
   * 発言）が待ち行列上で tick を追い越しうるので、「pacer の終端＝直前の tick
   * の後始末が完了している」という FIFO 前提が成り立たない。代わりに歯3と
   * 同じ形 — `releaseAttemptCount`（日誌の「枠の解除を試す」行数）を直接
   * 待つ — を使う。
   *
   * **単に `humanPriority: true` を渡すだけの歯にしないため、1件目の tick を
   * 保持させた後、実際に「もう1件人間の発言を挟む」場面を通す。** この post は
   * `Clone#post` の `this.#humanPriority && isHumanOriginated(event) ? …` の
   * 分岐を毎回、真の側（`isHumanOriginated` を `Inbox#push` へ渡す側）で通る
   * — `humanPriority: false` にすればここは必ず `undefined` になる。**その
   * 人間の発言そのものが「新しい合図」として枠の解除をもう1回誘発しうる**
   * （`post()` の `#releaseRequested` は起点の種類を問わない）ので、2件目の
   * tick を送った後の `releaseAttemptCount` を固定値ではなく「人間の発言を
   * 挟んだ時点の値より増えていること」で待つ（固定値にすると、人間の発言が
   * 誘発する解除の回数が変わっただけで歯が壊れたことになり、測りたいもの —
   * 畳み込みそのもの — とは無関係な理由で落ちる）。
   *
   * **⚠️ この歯が示さないこと。** ここで人間の発言を挟む時点では `#pump` は
   * 必ず待ち手（`Inbox` の `#waiters`）が居る状態まで進んでいる（`releaseAttemptCount`
   * を直接待つ設計そのものが、待ち行列が捌け切るまで待つ形だからである）。
   * `Inbox#push` は待ち手が居ればそのまま渡す（＝クローンが暇なとき、割り込む
   * 相手が待ち行列に居ない）ので、**この歯だけでは `insertAfterLast` による
   * 待ち行列上の並べ替えそのもの（人間以外を実際に飛び越す分岐）は踏まない。**
   * 実測: この `it` は `humanPriority: true` を `false` に変えても、他の
   * assert を1つも変えずに緑のまま通る（畳み込みの成否は「`#deferred` に
   * 同種の tick が既に居るか」だけで決まり、その周りに何が・どの順で
   * 積まれたかには依らないため）。**並べ替えそのもの（人間が人間以外を
   * 飛び越す・人間以外どうしは飛び越さない）は上の
   * `describe('クローン — 人間が待っている合図を待ち行列の先頭側へ入れる', ...)`
   * が別に測っている。**
   *
   * ## ⚠️ この歯は「干渉しないこと」を測っていない
   *
   * **`humanPriority` を `false` に反転しても、この歯は緑のまま通る**（実測、
   * 2026-08-22）。だから**フラグの効果を測ってはいない。**
   *
   * **そしてそれは歯の作りが悪いのではなく、干渉が構造的に起きないからである。**
   * 畳み込みが成立するかは `#deferred` に同種の tick が既に居るかだけで決まり、
   * 順序が効くのは **tick どうしの前後**だけである。**tick はすべて人間以外なので、
   * 人間優先は tick どうしの順序を1ミリも動かさない**（動かすのは「人間 対 それ
   * 以外」の1段だけ）。**だから落ちる歯は書けない。書けば嘘の歯になる。**
   *
   * **その構造そのものを守っているのは、下の有界性の歯である**
   * （`割り込める起点が人間の速さで来るものだけであること`）。tick を人間起点に
   * した瞬間に前提が崩れるので、あちらがコンパイルで止める。
   *
   * **ここが測っているのは1つだけ** — **出荷される設定（`humanPriority: true`）
   * の下で、畳み込みが壊れたら落ちること。** それは被覆として要る（#168 の歯3本は
   * `humanPriority: false` に固定してあるので、既定の設定を通る歯がここしかない）。
   *
   * 見るのは歯1と同じ2点 — (1) 未読の `self_initiative` が1件だけ（畳んでも
   * 在庫が増えない）、(2) 畳んだ跡の日誌が1件（畳み込みが実際に起きた証拠）。
   */
  it('人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      { resultSubtype: 'error_during_execution', resultText: spendLimitMessage },
      // 人間優先は既定で有効（`resolveCloneHumanPriority({}) === true`）。
      // ここでは明示的に渡し、この歯が `humanPriority: true` の下で測っている
      // ことを自明にする。
      { ALTEROID_CLONE_HUMAN_PRIORITY: 'true' },
    );

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // 1件目の tick。まだ `#deferred` に self_initiative は無いので畳めない。
    // 届いたこと自体が枠の解除を1回誘発する（歯3と同じ理由）。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-1',
      at: new Date().toISOString(),
      reason: '1本目',
    });
    await waitForReleaseAttempts(s, 1, '1件目の tick');
    const attemptsAfterTick1 = await releaseAttemptCount(s);

    // 枠で保持している最中に、もう1件人間が発言する（`humanPriority: true` の
    // 分岐を実際に通す一手。上の doc の「⚠️」に、ここが示すこと・示さない
    // ことの線引きがある）。人間優先下でも枠のロジック（保持・未読）は
    // 変わらないことをここで確かめる。
    const second = humanMessage('もう一件');
    s.clone.post(second);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === second.id);
    }, '2件目の人間の発言が未読として保持される');

    // 2件目の tick。既に `#deferred` に1件目（self_initiative）が保持されて
    // いるので畳まれる（はず）。解除の試行そのものは1回も減らない —
    // **ただし目標値は固定しない。** 直前の人間の発言（`second`）自体も
    // 枠の解除をもう1回誘発しうる（上の doc）ので、「2件目の tick を送る前の
    // 値より増えている」ことだけを待つ。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-2',
      at: new Date().toISOString(),
      reason: '2本目',
    });
    await waitForReleaseAttemptsAbove(
      s,
      attemptsAfterTick1,
      '2件目の tick が枠の解除をもう一度誘発する（人間優先が有効でも回数は減らない）',
    );

    const pending = await s.stores.inbox.claimPending();
    const selfInitiatives = pending.filter((p) => p.event.type === 'self_initiative');
    // 未読の self_initiative は1件だけ（人間優先が有効でも在庫は増えない）。
    expect(selfInitiatives).toHaveLength(1);
    expect(selfInitiatives[0]?.event.id).toBe('evt-si-1');
    // 畳んだ跡が日誌に1件だけ残る（2本目のぶん）。
    expect(await foldedNoteCount(s)).toBe(1);
    // 人間の発言（起点・2件目）は畳み込みの対象外なので、両方とも未読のまま。
    expect(pending.some((p) => p.event.id === origin.id)).toBe(true);
    expect(pending.some((p) => p.event.id === second.id)).toBe(true);

    await s.clone.stop();
  }, 30_000);
});
