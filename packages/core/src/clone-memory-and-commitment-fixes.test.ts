import { describe, it, expect } from 'vitest';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingInboxPut,
  flakyInboxPut,
  flakyInboxRemove,
  humanMessage,
} from './testing.js';
import {
  setup,
  wireEvents,
  waitFor,
  waitForDone,
  memoryCardOutlineLines,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 壊れ方の回帰', () => {
  it('応答中に会話終了が来てもループが止まらない（ターンの起動口は受信箱1つ）', async () => {
    // chat を2枚開いて片方を閉じる、という常駐デーモンでは普通の操作。
    // 蒸留が走行中ターンを踏み潰すと、以後クローンが永久に無反応になっていた。
    const s = setup(() => 'A の返事', createMemoryStores(), { delayMs: 120 });

    s.clone.post(humanMessage('MSG-A'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await s.clone.endConversation('conv-1');

    // A の返事は捨てられない
    expect(s.events.some((event) => event.type === 'done')).toBe(true);

    // 以後も普通に応答できる
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('MSG-B', 'conv-2'));
    await waitForDone(events);

    await s.clone.stop();
  }, 10_000);

  it('resume に失敗したら腐ったセッション id を捨てる（人間の手作業を要求しない）', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setCloneSessionId('stale-session-id');

    const s = setup(undefined, stores, { failWith: 'No conversation found with session ID' });
    s.clone.post(humanMessage('やあ'));

    await waitFor(() => s.events.some((event) => event.type === 'error'), 'error イベントが届く');
    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      'session id が消える',
    );
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await s.clone.stop();
  });

  /**
   * **測る対象を本文からカードへ移した**（人間の決定 2026-09-08。上の
   * `memoryCardOutlineLines` の doc）。載せ直しに本文（`NEW-VALUE`）は
   * もう現れない —— 現れるのは**変わったカードの行**で、節id が本文の
   * ハッシュなので、本文だけを直しても行は必ず変わる。
   *
   * **保証は弱まっていない。** 「人間の手編集が次のターンへ届く」ことに加えて、
   * **書き換え前の版が載っていない**（＝古い写しが混ざらない）ことまで見る
   * ようになった。
   */
  it('走行中に人間が記憶を書き換えたら、次のターンで載せ直す（受け入れ基準3）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nOLD-VALUE\n');
    const before = await memoryCardOutlineLines(stores, 'values');

    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    // 人間がエディタで直接書き換える
    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    const after = await memoryCardOutlineLines(stores, 'values');

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const second = (s.calls[0] as FakeCall).inputs[1] ?? '';
    for (const line of after) expect(second).toContain(line);
    for (const line of before) expect(second).not.toContain(line);
    expect(second).toContain('2回目');

    await s.clone.stop();
  });

  it('内部ターンの応答も日誌に残る（見えない層を作らない）', async () => {
    const s = setup(() => '記憶を更新しました');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
    }[];
    expect(exchanges.some((entry) => entry.with === 'self' && entry.role === 'outbound')).toBe(
      true,
    );

    await s.clone.stop();
  });

  it('承認への回答は日誌からも追える', async () => {
    const s = setup();
    await s.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これを送ってよいか',
    });

    await s.clone.answerApproval('ap-1', 'よい');

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations.some((entry) => entry.answer === 'よい')).toBe(true);

    await s.clone.stop();
  });
});

/**
 * `#forget` の消し込み（`inbox.remove`）まわりの直し（issue #256）。
 *
 * **終了条件は2つ**——(1) `commitment_close` と `inbox.remove` の間に失敗が
 * 挟まっても検出できない状態を無くす（ここでは `remove` 単体の一時的な失敗を
 * 拾い直す形で対応する。理由は `#forget` の doc を見よ——ターンをまたぐ
 * トランザクションは安全に組めない） (2) `#forget` のメモリ上の印
 * （`#unread` / `#redelivered` / `#redeliveredClosed`）のクリアが `remove`
 * 成功後に回ること。(2) は private field なので直接は見えないが、**(2) が
 * 直っていなければ (1) の拾い直しは成立しない**（印を先に消すと、拾い直しの
 * 意味が無くなる）——なので下の「拾い直して実際に消える」テストは (2) の
 * 間接証拠でもある。
 */
describe('クローン — commitment_close と inbox.remove の消し込み（issue #256）', () => {
  it('inbox.remove が一時的に失敗しても、拾い直して実際に消える', async () => {
    const base = createMemoryStores();
    // 最初の2回だけ失敗させ、3回目（FORGET_RETRY_ATTEMPTS の最後）で成功させる。
    const { stores, calls } = flakyInboxRemove(base, 2, '瞬断');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForDone(s.events);

    // `done` はターンの `try` の中で先に届く。`#forget` の拾い直し
    // （`FORGET_RETRY_MS` の待ちを挟む）は `finally` 側の後始末なので、
    // 消えるまで別に待つ。
    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, '拾い直した末に inbox から消える');
    expect(calls.length).toBe(3);

    await s.clone.stop();
  }, 10_000);

  it('拾い直しても消せなければ、跡を残したうえで消さずに次の起動へ委ねる', async () => {
    const base = createMemoryStores();
    // `FORGET_RETRY_ATTEMPTS`（3）を超えて恒久的に失敗させる。
    const { stores, calls } = flakyInboxRemove(base, 10, '恒久的な障害');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    const lines = await captureStderr(async () => {
      s.clone.post(event);
      await waitForDone(s.events);
      // 拾い直しの間隔（`FORGET_RETRY_MS` × (1+2) ≒ 600ms）ぶん待って
      // 諦めきるのを待つ。
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });

    // 消せなかったことが跡として残る（黙って消えていない）。
    expect(lines.some((line) => line.includes('未読の消し込み'))).toBe(true);
    // **消していない** — ストアにはまだ残っていて、次の起動
    // （`#restoreUnread` の配り直し、issue #217）に委ねられる。issue #256 が
    // 壊さないよう指示している「消せなかったものは次の起動で配り直される」
    // 設計そのものである。
    const pending = await stores.inbox.claimPending();
    expect(pending.some((p) => p.event.id === event.id)).toBe(true);
    expect(calls.length).toBe(3);

    await s.clone.stop();
  }, 10_000);
});

/**
 * `#remember` の `inbox.put` 拾い直し（issue #1085）。
 *
 * `#forget`（直上の #256）の書く側の対——`put()` の一時的な失敗を
 * `REMEMBER_RETRY_ATTEMPTS` 回まで拾い直し、尽きても `post` を落とさず、
 * 「落とした」ではなく実際の帰結（このプロセスが生きているあいだは配達
 * される・器が入れ替われば失われる）が読める跡を残す。
 */
describe('クローン — #remember の inbox.put 拾い直し（issue #1085）', () => {
  it('put() が一過性に失敗しても、拾い直して DB に書かれる', async () => {
    const base = createMemoryStores();
    // 最初の2回だけ失敗させ、3回目（REMEMBER_RETRY_ATTEMPTS の最後）で成功させる。
    const { stores, calls } = flakyInboxPut(base, 2, '瞬断');
    // ターンをゆっくり終わらせ、`#forget`（拾い直しの完了を待ってから消す）が
    // 先に動いて DB から消してしまう前に、書けたことを観測する窓を作る。
    const s = setup(() => 'わかった', stores, { delayMs: 1500 });

    const event = humanMessage('やあ');
    s.clone.post(event);

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.some((p) => p.event.id === event.id);
    }, '拾い直した末に DB へ書かれる');
    expect(calls.length).toBe(3);

    await waitForDone(s.events);
    await s.clone.stop();
  }, 10_000);

  it('拾い直しても書けなければ、post は落ちずに配達は続き、跡は「落とした」と名乗らない', async () => {
    const stores = failingInboxPut(createMemoryStores(), '恒久的な障害');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    const lines = await captureStderr(async () => {
      s.clone.post(event);
      // 未読を書けないことでその合図の処理まで止めない——ターンは走り切る。
      await waitForDone(s.events);
      // 拾い直しの間隔（`REMEMBER_RETRY_MS` × (1+2) ≒ 600ms）ぶん待って
      // 諦めきるのを待つ。
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });

    // **post は落ちていない**——ターンは最後まで走り、`done` が届いている
    // （直上の `waitForDone` がそれを確かめている）。
    //
    // **跡は「記録できませんでした」だけで終わらない。** 実際には失っていない
    // （このプロセスが生きているあいだは配達される）ことと、本当の帰結
    // （器が入れ替われば失われる）の両方が読める。
    const trace = lines.filter((line) => line.includes('未読の合図をストアへ書けませんでした'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('恒久的な障害');
    expect(trace[0]).not.toContain('落とし');
    expect(trace[0]).toContain('失ってはいない');
    expect(trace[0]).toContain('器が入れ替われば');

    await s.clone.stop();
  }, 10_000);
});

/**
 * 記憶が**二重に文脈へ載らない**こと。
 *
 * 記憶はセッションを組み立てた時点でシステムプロンプトへ焼き込まれる。走行中の
 * 手編集を届けるための載せ直し（`#withFreshMemory`）は、かつて**記憶の全文**を
 * 本文の前に置いていた。つまり1つの文書の1行を直すだけで、変わっていない文書まで
 * 含めた全文が2つ目の写しとして文脈に入り、しかもそれは会話の履歴に残るので
 * 直すたびに増え、resume でも運ばれていた。
 *
 * ここで固定するのは3つである。
 *
 * 1. 変わった文書だけが載る（＝変わっていない文書は二重に載らない）
 * 2. 何も変わっていなければ何も足さない
 * 3. resume では全文を載せ直さず、正本がシステムプロンプト側だと断るだけにする
 *
 * **受け入れ基準3（人間の手編集が次の会話に反映される）を弱めていないこと**は、
 * 上の「走行中に人間が記憶を書き換えたら、次のターンで載せ直す」がそのまま
 * 見ている（あちらも同じ日に、本文からカードへ測り方を移した）。
 *
 * ## ⚠️ 2026-09-08 以降、「本文が載っていない」だけでは 1 を測れない
 *
 * `premise` の焼き込みが全文からカードへ変わり（`memory.ts` の
 * `renderPremiseCard`）、**本文はシステムプロンプトにも載せ直しにも1文字も
 * 現れなくなった。** ⟹ `not.toContain(UNCHANGED_BODY)` は**どこでも真**に
 * なり、そのままでは「変わっていない文書は二重に載らない」を1文字も測って
 * いない状態になる（緑のまま歯が抜ける形）。
 *
 * **だから、載る側の単位（カード）で測り直す。** 本文の不在は
 * 「本文はもう載らない」の回帰として残したうえで、**本題は「変わっていない
 * 文書のカードが載せ直しに出ないこと」**に移してある
 * （`memoryCardOutlineLines`）。**測る対象が実在する側へ移ったので、保証は
 * 弱まっていない。**
 */
describe('クローン — 記憶を二重に載せない', () => {
  /**
   * その名のとおり、載せ直しの中に本文が出てきてはいけない文書。
   *
   * **2026-09-08 以降、これは「本文はもう焼き込みに載らない」の回帰でしかない**
   * （カードには本文が入らないので、どこにも現れない）。**本題のほうは
   * `habitsCard`（この文書のカードの行）で測る。**
   */
  const UNCHANGED_BODY = 'HABIT-BODY-MUST-NOT-BE-RESENT';

  async function twoDocumentStores(): Promise<Stores> {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nOLD-VALUE\n');
    await stores.persona.write('habits', `# 習慣\n\n${UNCHANGED_BODY}\n`);
    return stores;
  }

  /** 2ターン目を同じセッションへ流し、その入力を返す。 */
  async function secondTurn(s: Setup): Promise<string> {
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    return (s.calls[0] as FakeCall).inputs[1] ?? '';
  }

  it('1つの文書を直しても、変わっていない文書の本文は載せ直さない', async () => {
    const stores = await twoDocumentStores();
    const habitsCard = await memoryCardOutlineLines(stores, 'habits');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const second = await secondTurn(s);

    // 直した文書は、どの文書かを指せる見出しつきで載る。**見出しの括弧の中は
    // 見ない** —— カードの全体（`（premise・本文は載っていない…）`）と変わった
    // 範囲だけ（`（カードの変わった範囲だけ）`）のどちらへ倒れるかは量で決まる
    // ので、ここで固定すると分量の都合で歯が落ちる。名指しが在ることを見る。
    expect(second).toContain('<!-- memory: values.md');
    for (const line of valuesCard) expect(second).toContain(line);
    // **これが本題。** 触っていない文書は2つ目の写しにならない —— カード
    // （いま実際に載る単位）でも、本文（もうどこにも載らない）でも。
    for (const line of habitsCard) expect(second).not.toContain(line);
    expect(second).not.toContain(UNCHANGED_BODY);
    expect(second).not.toContain('<!-- memory: habits.md');
    // 絞ったのは載せ直しの側だけである。システムプロンプトには両方載ったまま
    // （載っているのはカードで、本文ではない）。
    const systemPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    for (const line of habitsCard) expect(systemPrompt).toContain(line);
    expect(systemPrompt).toContain('<!-- memory: habits.md');

    await s.clone.stop();
  });

  it('記憶が何も変わっていなければ、ターンの本文に何も足さない', async () => {
    const stores = await twoDocumentStores();
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const second = await secondTurn(s);

    expect(second).not.toContain('記憶が更新された');
    expect(second).not.toContain('<!-- memory:');
    // 本文（もう載らない）だけでなく、いま載る単位（カード）でも出てこない。
    expect(second).not.toContain('OLD-VALUE');
    for (const line of valuesCard) expect(second).not.toContain(line);
    // **「出てこない」が空振りでないことを、同じ文字列で確かめる。** この行は
    // 焼き込みの側には実在する——だから2ターン目に無いことに意味がある。
    for (const line of valuesCard) {
      expect(String((s.calls[0] as FakeCall).options.systemPrompt)).toContain(line);
    }
    // 本文そのものは削られていない（断り書きが前に付く経路があるので末尾で見る）
    expect(second.endsWith('2回目')).toBe(true);

    await s.clone.stop();
  });

  it('セッションを組み立てた最初のターンでは、焼き込んだ記憶を載せ直さない', async () => {
    const stores = await twoDocumentStores();
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const first = (s.calls[0] as FakeCall).inputs[0] ?? '';
    expect(first).not.toContain('記憶が更新された');
    expect(first).not.toContain('OLD-VALUE');
    expect(first).not.toContain(UNCHANGED_BODY);
    for (const line of valuesCard) expect(first).not.toContain(line);
    // 焼き込み自体は起きている（載せ直しが要らないのは、そちらに載っているから）。
    // **焼き込みに在るのはカードで、本文ではない**（`renderPremiseCard`）ので、
    // かつてここで見ていた本文（`OLD-VALUE`）ではなくカードの行で見る。
    const systemPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    for (const line of valuesCard) expect(systemPrompt).toContain(line);

    await s.clone.stop();
  });

  it('記憶を消したら、消えたことを名前で伝える（本文を載せ直さない）', async () => {
    const stores = await twoDocumentStores();
    const habitsCard = await memoryCardOutlineLines(stores, 'habits');
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.remove('habits');
    const second = await secondTurn(s);

    expect(second).toContain('削除された記憶: habits.md');
    // 消した文書を載せるのは「消したのに文脈には居る」という一番まぎらわしい状態。
    // 本文（もう載らない）とカード（いま載る単位）の両方で見る。
    expect(second).not.toContain(UNCHANGED_BODY);
    for (const line of habitsCard) expect(second).not.toContain(line);
    // 残っている文書は変わっていないので、こちらも載せ直さない
    expect(second).not.toContain('OLD-VALUE');
    for (const line of valuesCard) expect(second).not.toContain(line);
    // **上の「出てこない」が空振りでないことを、同じ文字列で確かめる。**
    // どちらの行も焼き込みの側には実在する（消す前に組んだセッションなので、
    // 消した habits のカードもそこには在る）。
    const systemPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    for (const line of [...habitsCard, ...valuesCard]) expect(systemPrompt).toContain(line);

    await s.clone.stop();
  });

  it('記憶が全部消えたら、空になったと伝える', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.remove('values');
    await stores.persona.remove('habits');
    const second = await secondTurn(s);

    expect(second).toContain('（記憶は空になった）');
    expect(second).toContain('削除された記憶:');
    expect(second).toContain('values.md');
    expect(second).toContain('habits.md');

    await s.clone.stop();
  });

  /**
   * **削除された記憶の列挙にも上限が要る（#409）。** `removed` は一度に消えた
   * 文書の件数ぶん伸びる列挙で、`.map().join()` に上限も合図も無かった。
   * 60件をまとめて消すと、切っていない実装ではこの1行だけで数百文字になる
   * ——ここでは抜粋の合図（`excerptLine` の「省略」）が出て、伸び続けないことを
   * 見る。
   */
  it('大量の記憶を一度に消しても、削除された記憶の列挙は抜粋の合図で締まる', async () => {
    const stores = createMemoryStores();
    const slugs = Array.from({ length: 60 }, (_, index) => `doc-${index}`);
    for (const slug of slugs) {
      await stores.persona.write(slug, `# ${slug}\n\nbody\n`);
    }
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    for (const slug of slugs) {
      await stores.persona.remove(slug);
    }
    const second = await secondTurn(s);

    const line = second.split('\n').find((entry) => entry.startsWith('削除された記憶:'));
    expect(line).toBeDefined();
    // 60件の生の列挙をそのまま出せば数百文字になる。ここでは合図が出て、
    // 際限なく伸びていないことを見る。
    expect(line!.length).toBeLessThan(600);
    expect(line).toMatch(/省略/);

    await s.clone.stop();
  });

  /**
   * **ここが resume の側の穴だった。**
   *
   * 前のセッションが載せ直した塊は、履歴として残る。それは
   * 「以降はこちらが現在の記憶である」と名乗る形で、しかもシステムプロンプトより
   * **後ろ**に並ぶ。デーモンが落ちている間に人間が記憶を直していた場合、正本
   * （新しいシステムプロンプト）のほうが新しいのに、古い写しが最後の言葉になる。
   */
  it('resume した最初のターンでは、正本がシステムプロンプト側だと断る（全文を載せ直さない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nV1-OLD\n');

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    // 前のセッションで載せ直しが起きた状態を、実際に人間の手編集で作る
    await stores.persona.write('values', '# 価値観\n\nV2-MID\n');
    // **版の見分けは本文ではなくカードの行で行う**（`memoryCardOutlineLines`）。
    // 節id が中身のハッシュなので、V1 / V2 / V3 は別々の行になる。
    const v2Card = await memoryCardOutlineLines(stores, 'values');
    const { events } = wireEvents(first.clone, 'conv-2');
    first.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    for (const line of v2Card) expect((first.calls[0] as FakeCall).inputs[1] ?? '').toContain(line);
    await first.clone.stop();

    // デーモンが落ちている間に、人間がもう一度直す
    await stores.persona.write('values', '# 価値観\n\nV3-NEWEST\n');
    const v3Card = await memoryCardOutlineLines(stores, 'values');

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);

    const call = second.calls[0] as FakeCall;
    expect(call.options.resume).toBe('sess-fake');
    const input = call.inputs[0] ?? '';
    expect(input).toContain('現在の記憶');
    expect(input).toContain('システムプロンプト');
    // **載せ直して上書きしない。** それはいま塞いでいる二重載せそのものである
    expect(input).not.toContain('V3-NEWEST');
    for (const line of v3Card) expect(input).not.toContain(line);
    expect(input).not.toContain('<!-- memory: values.md');
    // 正本の側には最新が載っていて、古い版は残っていない
    const systemPrompt = String(call.options.systemPrompt);
    for (const line of v3Card) expect(systemPrompt).toContain(line);
    for (const line of v2Card) expect(systemPrompt).not.toContain(line);

    await second.clone.stop();
  });

  it('resume の断りは最初のターンだけで、以降のターンには付かない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nV1\n');

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    await first.clone.stop();

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);
    expect((second.calls[0] as FakeCall).inputs[0] ?? '').toContain('resume');

    const third = await secondTurn(second);
    expect(third).not.toContain('resume');

    await second.clone.stop();
  });

  it('新規に開いたセッションでは resume の断りを出さない（起きていないことを言わない）', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).options.resume).toBeUndefined();
    expect((s.calls[0] as FakeCall).inputs[0] ?? '').not.toContain('resume');

    await s.clone.stop();
  });

  it('内部ターン（蒸留）にも同じ絞り込みが効く（起点ごとに違う載せ方をしない）', async () => {
    const stores = await twoDocumentStores();
    const habitsCard = await memoryCardOutlineLines(stores, 'habits');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    await s.clone.endConversation('conv-1');

    // 蒸留の内部ターンが同じセッションへ流れる（`#runInternal`）
    const distill = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(distill).toContain('記憶へ移すべきものがあるか確認せよ');
    // 変わった文書は載り（人間の会話の起点と同じ）、変わっていない文書は載らない。
    // **どちらもカードの行で見る**（本文はもう載らないので、本文の不在は
    // 「絞り込みが効いた」ことの証拠にならない）。
    for (const line of valuesCard) expect(distill).toContain(line);
    for (const line of habitsCard) expect(distill).not.toContain(line);
    expect(distill).not.toContain(UNCHANGED_BODY);

    await s.clone.stop();
  });

  /**
   * ⭐ 端から端まで通す歯（実測 2026-09-02 の欠陥そのもの）。
   *
   * `#withFreshMemory` は**変わった文書だけ**を `renderMemoryDocuments` へ
   * 渡す。`core`（premise）を `parent` に持つ `child`（fact）を器に置き、
   * `child` だけを書き換えると、載せ直しの差分に `child` しか入らない——
   * `core` は今回変わっていないので、差分だけを見れば「親 core が見つから
   * ない」に見える。実際には `core` は記憶に実在し、単に今回の描画に
   * 含まれていないだけである。`#withFreshMemory` が渡す `presentInMemory`
   * （記憶の全体の slug）でこの2つが区別されることを確かめる。
   *
   * **「親も一緒に載せる」に化けていないこと**も見る —— 直し方が「親を
   * 差分へ含める」だったら二重載せが復活する（このファイルの表題そのもの）。
   */
  it('⭐ 親が差分に含まれないとき、載せ直しは「見つからない」と言わない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('core', '# core\n\n前提の本文\n');
    await stores.persona.write(
      'child',
      '---\ntype: fact\ndescription: 子の要旨\nparent: core\n---\n# child\n\n子の本文\n',
    );
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    // child だけを書き換える。core には触れない。
    await stores.persona.write(
      'child',
      '---\ntype: fact\ndescription: 子の要旨（更新）\nparent: core\n---\n# child\n\n子の本文\n',
    );
    const second = await secondTurn(s);

    expect(second).toContain('記憶が更新された');
    expect(second).not.toContain('が見つからない');
    expect(second).toContain('親 core は在るが、ここに載せた分には含まれない');
    // 直し方が「親も一緒に載せる」に化けていないこと —— core の本文（premise
    // としての全文）は載せ直しに出てこない。
    expect(second).not.toContain('前提の本文');
    expect(second).not.toContain('<!-- memory: core.md -->');

    await s.clone.stop();
  });
});
