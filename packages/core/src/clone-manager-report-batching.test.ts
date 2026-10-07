import { describe, it, expect } from 'vitest';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, lineStartingWith, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — 同じマネージャーの連続する report をまとめて読む（#562）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  const managerMessage = (
    id: string,
    managerId: string,
    text: string,
    kind: 'report' | 'question' | 'permission' = 'report',
    requestId?: string,
  ): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind,
    text,
    ...(requestId === undefined ? {} : { requestId }),
  });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('同じマネージャーの連続する report 3件が1ターンにまとめて読まれ、全文が届く', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-batch', '報告1本目'));
    s.clone.post(managerMessage('r2', 'mgr-batch', '報告2本目'));
    s.clone.post(managerMessage('r3', 'mgr-batch', '報告3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('報告3本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);

    const merged = inputs[1] ?? '';
    expect(merged).toContain('報告1本目');
    expect(merged).toContain('報告2本目');
    expect(merged).toContain('報告3本目');
    expect(merged.indexOf('報告1本目')).toBeLessThan(merged.indexOf('報告2本目'));
    expect(merged.indexOf('報告2本目')).toBeLessThan(merged.indexOf('報告3本目'));

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '3件とも消し込まれる',
    );

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const managerExchanges = exchanges.filter((entry) => entry.with === 'manager');
    expect(managerExchanges.filter((entry) => entry.text.includes('報告1本目'))).toHaveLength(1);
    expect(managerExchanges.filter((entry) => entry.text.includes('報告2本目'))).toHaveLength(1);
    expect(managerExchanges.filter((entry) => entry.text.includes('報告3本目'))).toHaveLength(1);

    await s.clone.stop();
  }, 15_000);

  it(
    '巨大な報告5件（各1.5万字。件ごとは予算未満だが合計は予算超過）の束は予算に収まり、' +
      '切った件数と journal_read での取り方を名乗る。省いた分の全文は journal_read で実際に引ける（issue #955）',
    async () => {
      const s = setup();

      s.clone.post(humanMessage('先客'));
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

      const huge = (label: string): string => `${label}先頭` + 'x'.repeat(15_000) + `${label}末尾`;
      for (let i = 1; i <= 5; i += 1) {
        s.clone.post(managerMessage(`huge${i}`, 'mgr-huge', huge(`報告${i}`)));
      }

      const batchHeadline = 'マネージャー mgr-huge から届いた報告を、処理待ちのあいだに続けて';
      await waitFor(
        () => (s.calls[0]?.inputs ?? []).some((input) => input.includes(batchHeadline)),
        'まとめたターンが投げられる',
      );
      await settle();

      const inputs = (s.calls[0] as FakeCall).inputs;
      // 束ねられたターンを固定 index でなく内容で探す: commitment / situation の断り書きが同じターンの body の前に連結されることがあるため
      const merged = inputs.find((input) => input.includes(batchHeadline)) ?? '';
      expect(merged).not.toBe('');

      expect(merged.length).toBeLessThan(60_000);

      expect(merged).toContain(huge('報告5'));
      expect(merged).not.toContain(huge('報告1'));

      const noticeLine = lineStartingWith(merged, '⚠ 本文の合計が文字数の予算');
      expect(noticeLine).toContain('journal_read');
      expect(noticeLine).toContain('types: ["exchange"]');
      expect(noticeLine).toMatch(
        /古い \d+ 件（5 件中、新しい \d+ 件だけを本文つきで出した）は本文を省いた/,
      );

      const sinceMatch = /since: "([^"]+)"/.exec(noticeLine);
      expect(sinceMatch).not.toBeNull();
      const since = sinceMatch?.[1] ?? '';

      const exchanges = (await s.stores.journal.list({
        types: ['exchange'],
        with: ['manager'],
        since,
        limit: 200,
      })) as { text: string }[];
      expect(exchanges.some((entry) => entry.text.includes(huge('報告1')))).toBe(true);
      expect(exchanges.some((entry) => entry.text.includes(huge('報告5')))).toBe(true);

      await s.clone.stop();
    },
    20_000,
  );

  it('巨大な単発の報告（6万字）は予算で切り、全文の取り方を名乗る。その取り方で全文が引ける（issue #955）', async () => {
    const s = setup();
    const huge = '単発先頭' + 'y'.repeat(60_000) + '単発末尾';
    s.clone.post(managerMessage('huge-single', 'mgr-single', huge));
    await waitFor(
      () =>
        (s.calls[0]?.inputs ?? []).some((input) =>
          input.includes('マネージャー mgr-single から届いた。（報告）'),
        ),
      '単発の報告のターンが投げられる',
    );
    await settle();
    const input =
      (s.calls[0] as FakeCall).inputs.find((text) =>
        text.includes('マネージャー mgr-single から届いた。（報告）'),
      ) ?? '';

    expect(input.length).toBeLessThan(60_000);
    expect(input).toContain('単発先頭');
    expect(input).not.toContain('単発末尾');
    const notice = lineStartingWith(input, '⚠ 本文が文字数の予算');
    expect(notice).toContain('journal_read');
    const since = /since: "([^"]+)"/.exec(notice)?.[1] ?? '';
    expect(since).not.toBe('');
    const exchanges = (await s.stores.journal.list({
      types: ['exchange'],
      with: ['manager'],
      since,
      limit: 200,
    })) as { text: string }[];
    expect(exchanges.some((entry) => entry.text.includes(huge))).toBe(true);

    await s.clone.stop();
  }, 20_000);

  it('予算に収まる単発の報告は1文字も変えず、予算の断りも出さない（issue #955）', async () => {
    const s = setup();
    s.clone.post(managerMessage('small-single', 'mgr-small', '小さな報告の本文'));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('小さな報告の本文')),
      '単発の報告のターンが投げられる',
    );
    const input =
      (s.calls[0] as FakeCall).inputs.find((text) => text.includes('小さな報告の本文')) ?? '';
    expect(input).not.toContain('文字数の予算');
    await s.clone.stop();
  });

  it('束の最新1件だけで予算を超える回も、全文の取り方を名乗る（issue #955）', async () => {
    const s = setup();
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    s.clone.post(managerMessage('small-1', 'mgr-mix', '小さい報告'));
    s.clone.post(
      managerMessage('huge-last', 'mgr-mix', '最新先頭' + 'z'.repeat(60_000) + '最新末尾'),
    );
    const batchHeadline = 'マネージャー mgr-mix から届いた報告を、処理待ちのあいだに続けて';
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes(batchHeadline)),
      'まとめたターンが投げられる',
    );
    await settle();
    const merged =
      (s.calls[0] as FakeCall).inputs.find((input) => input.includes(batchHeadline)) ?? '';
    expect(merged.length).toBeLessThan(60_000);
    expect(merged).toContain('最新先頭');
    expect(merged).not.toContain('最新末尾');
    const notice = lineStartingWith(merged, '⚠ 本文の合計が文字数の予算');
    expect(notice).toContain('journal_read');
    expect(merged).not.toContain('小さい報告');
    await s.clone.stop();
  }, 20_000);

  it('まとめた本文にも、1件ごとに受け取ってからの経過が載る', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('age1', 'mgr-age', '報告1本目'));
    s.clone.post(managerMessage('age2', 'mgr-age', '報告2本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('報告2本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const merged = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(merged.split('受け取ってから').length - 1).toBe(2);
    expect(merged).toContain('受け取った時刻:');

    await s.clone.stop();
  }, 15_000);

  it('間に別のマネージャーの報告が挟まったら、そこで止まる（飛び越えない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('a1', 'mgr-A', 'A1本目'));
    s.clone.post(managerMessage('a2', 'mgr-A', 'A2本目'));
    s.clone.post(managerMessage('b1', 'mgr-B', 'B1本目'));
    s.clone.post(managerMessage('a3', 'mgr-A', 'A3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[3]?.includes('A3本目') ?? false,
      '4本目（A3単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(4);

    expect(inputs[1] ?? '').toContain('A1本目');
    expect(inputs[1] ?? '').toContain('A2本目');
    expect(inputs[1] ?? '').not.toContain('B1本目');
    expect(inputs[1] ?? '').not.toContain('A3本目');

    expect(inputs[2] ?? '').toContain('B1本目');
    expect(inputs[2] ?? '').not.toContain('A1本目');
    expect(inputs[2] ?? '').not.toContain('A3本目');

    expect(inputs[3] ?? '').toContain('A3本目');
    expect(inputs[3] ?? '').not.toContain('A1本目');
    expect(inputs[3] ?? '').not.toContain('B1本目');

    await s.clone.stop();
  }, 15_000);

  it('連続する report の途中に人間の発言が挟まったら、そこで止まる（人間優先を切って純粋な到着順で確かめる）', async () => {
    // 人間優先を切る: 既定だと insertAfterLast が人間の発言を待ち行列の先頭側へ入れ直し、呼んだ順と並んだ順がずれるため
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_CLONE_HUMAN_PRIORITY: '0' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('a1', 'mgr-A', 'A1本目'));
    s.clone.post(managerMessage('a2', 'mgr-A', 'A2本目'));
    s.clone.post(humanMessage('割り込む人間'));
    s.clone.post(managerMessage('a3', 'mgr-A', 'A3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[3]?.includes('A3本目') ?? false,
      '4本目（A3単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(4);

    expect(inputs[1] ?? '').toContain('A1本目');
    expect(inputs[1] ?? '').toContain('A2本目');
    expect(inputs[1] ?? '').not.toContain('割り込む人間');
    expect(inputs[1] ?? '').not.toContain('A3本目');
    expect(inputs[2] ?? '').toContain('割り込む人間');
    expect(inputs[3] ?? '').toContain('A3本目');
    expect(inputs[3] ?? '').not.toContain('A1本目');
    expect(inputs[3] ?? '').not.toContain('A2本目');

    await s.clone.stop();
  }, 15_000);

  it('question / permission はまとめられない（同じマネージャーの report のすぐ後ろでも止まる）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-Q', '報告1本目'));
    s.clone.post(managerMessage('r2', 'mgr-Q', '報告2本目'));
    s.clone.post(managerMessage('q1', 'mgr-Q', '質問1本目', 'question', 'req-1'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('質問1本目') ?? false,
      '3本目（question単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('報告1本目');
    expect(inputs[1] ?? '').toContain('報告2本目');
    expect(inputs[1] ?? '').not.toContain('質問1本目');
    expect(inputs[2] ?? '').toContain('質問1本目');
    expect(inputs[2] ?? '').not.toContain('報告1本目');
    expect(inputs[2] ?? '').not.toContain('報告2本目');
    expect(inputs[2]).toContain('manager_send');

    await s.clone.stop();
  }, 15_000);

  it('#redelivered に載っている報告はまとめられる（issue #783: 配り直しの束）', async () => {
    const stores = createMemoryStores();
    const r1 = managerMessage('r1', 'mgr-X', '前回届いた報告1');
    const r2 = managerMessage('r2', 'mgr-X', '前回届いた報告2');
    await stores.inbox.put(r1, new Date(0).toISOString());
    await stores.inbox.put(r2, new Date(1).toISOString());

    const s = setup(undefined, stores);

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('前回届いた報告2'),
      '報告2が渡る',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(1);
    const merged = inputs[0] ?? '';
    const noticeLine = lineStartingWith(merged, '[system] **これは配り直しの束である');
    expect(noticeLine).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 1970-01-01T00:00:00.000Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    expect(merged).toContain('前回届いた報告1');
    expect(merged).toContain('前回届いた報告2');

    await s.clone.stop();
  }, 15_000);

  it('束の上限に当たっても、外れた分は次の反復でそのまま処理される（1件も失われない。issue #783）', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      {},
      {
        ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2',
      },
    );

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    for (let i = 1; i <= 5; i += 1) {
      s.clone.post(managerMessage(`lim${i}`, 'mgr-limit', `上限テスト報告${i}`));
    }

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('上限テスト報告5'),
      '5件目ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(4);
    expect(inputs[1] ?? '').toContain('上限テスト報告1');
    expect(inputs[1] ?? '').toContain('上限テスト報告2');
    expect(inputs[1] ?? '').not.toContain('上限テスト報告3');
    expect(inputs[2] ?? '').toContain('上限テスト報告3');
    expect(inputs[2] ?? '').toContain('上限テスト報告4');
    expect(inputs[2] ?? '').not.toContain('上限テスト報告5');
    expect(inputs[3] ?? '').toContain('上限テスト報告5');

    const joined = inputs.join('\n');
    for (let i = 1; i <= 5; i += 1) {
      expect(joined).toContain(`上限テスト報告${i}`);
    }

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '5件とも消し込まれる',
    );
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const managerExchanges = exchanges.filter((entry) => entry.with === 'manager');
    for (let i = 1; i <= 5; i += 1) {
      expect(
        managerExchanges.filter((entry) => entry.text.includes(`上限テスト報告${i}`)),
      ).toHaveLength(1);
    }

    await s.clone.stop();
  }, 15_000);

  it('配り直しが上限を超えても束が複数に割れ、1件も失われない（issue #783）', async () => {
    const stores = createMemoryStores();
    for (let i = 1; i <= 5; i += 1) {
      await stores.inbox.put(
        managerMessage(`red${i}`, 'mgr-redlimit', `配り直しテスト${i}`),
        new Date(i - 1).toISOString(),
      );
    }

    const s = setup(undefined, stores, {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('配り直しテスト5'),
      '5件目が渡る',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(lineStartingWith(inputs[0] ?? '', '[system] **これは配り直しの束である')).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 1970-01-01T00:00:00.000Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    expect(inputs[0] ?? '').toContain('配り直しテスト1');
    expect(inputs[0] ?? '').toContain('配り直しテスト2');
    expect(lineStartingWith(inputs[1] ?? '', '[system] **これは配り直しの束である')).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 1970-01-01T00:00:00.002Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    expect(inputs[1] ?? '').toContain('配り直しテスト3');
    expect(inputs[1] ?? '').toContain('配り直しテスト4');
    expect(inputs[2] ?? '').toContain('これは配り直しである');
    expect(inputs[2] ?? '').toContain('配り直しテスト5');

    const joined = inputs.join('\n');
    for (let i = 1; i <= 5; i += 1) {
      expect(joined).toContain(`配り直しテスト${i}`);
    }

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '5件とも消し込まれる',
    );

    await s.clone.stop();
  }, 15_000);

  it('枠で保持した report はまとめ読みの対象から外れる（#heldForUsage）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(managerMessage('r1', 'mgr-Y', '報告1本目'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '一件目のターンが投げられる');
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'r1');
    }, '一件目が未読として保持される');

    s.clone.post(managerMessage('r2', 'mgr-Y', '報告2本目'));
    s.clone.post(managerMessage('r3', 'mgr-Y', '報告3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('報告3本目') ?? false,
      '2件目・3件目ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('報告1本目');
    expect(inputs[1] ?? '').not.toContain('報告2本目');
    expect(inputs[2] ?? '').toContain('報告2本目');
    expect(inputs[2] ?? '').toContain('報告3本目');
    expect(inputs[2] ?? '').not.toContain('報告1本目');

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは従来どおりの本文のまま（断り書きが載らない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-Z', '単独の報告'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('単独の報告') ?? false,
      '2本目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);
    const solo = inputs[1] ?? '';
    // 逐語の完全一致で固定しない: 本文に時刻依存の「受け取ってからの経過」が挟まるため
    expect(solo).toContain('[system] マネージャー mgr-Z から届いた。（報告）');
    expect(solo).toContain('単独の報告');
    expect(solo).toContain('受け取ってから');
    expect(solo).toContain(
      '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。',
    );
    expect(solo).toContain('学びや判断の基準になったことがあれば記憶へ移すこと。');
    expect(solo).not.toContain('続けて');
    expect(solo).not.toContain('まとめて読んでから');
    expect(solo).not.toContain('**(1)**');

    await s.clone.stop();
  }, 15_000);

  it('上限ちょうど（切らない）: 断り書きが1文字も載らない', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('exact1', 'mgr-exact', 'ちょうど上限1本目'));
    s.clone.post(managerMessage('exact2', 'mgr-exact', 'ちょうど上限2本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('ちょうど上限2本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const merged = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(merged).toContain('ちょうど上限1本目');
    expect(merged).toContain('ちょうど上限2本目');
    expect(merged).not.toContain('このターンへ束ねる合図は、上限');
    expect(merged).not.toContain('1件も失われていない');

    await s.clone.stop();
  }, 15_000);

  it('上限+1（切る・残り1件）: 断り書きが1行、値は限度2・束2・残り1', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-plus1', '上限+1テスト1本目'));
    s.clone.post(managerMessage('r2', 'mgr-plus1', '上限+1テスト2本目'));
    s.clone.post(managerMessage('r3', 'mgr-plus1', '上限+1テスト3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('上限+1テスト3本目') ?? false,
      '3本目（単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);

    const truncated = inputs[1] ?? '';
    expect(truncated).toContain('上限+1テスト1本目');
    expect(truncated).toContain('上限+1テスト2本目');
    expect(truncated).not.toContain('上限+1テスト3本目');
    expect(lineStartingWith(truncated, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。$/,
    );
    expect(truncated).toContain(
      '**1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。',
    );

    const solo = inputs[2] ?? '';
    expect(solo).toContain('上限+1テスト3本目');
    expect(solo).not.toContain('このターンへ束ねる合図は、上限');

    await s.clone.stop();
  }, 15_000);

  it('上限+2（切る・残り2件）: 続く束はちょうど上限で切っていない', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-plus2', '上限+2テスト1本目'));
    s.clone.post(managerMessage('r2', 'mgr-plus2', '上限+2テスト2本目'));
    s.clone.post(managerMessage('r3', 'mgr-plus2', '上限+2テスト3本目'));
    s.clone.post(managerMessage('r4', 'mgr-plus2', '上限+2テスト4本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('上限+2テスト4本目') ?? false,
      '2本目の束（3+4）ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);

    const firstBatch = inputs[1] ?? '';
    expect(firstBatch).toContain('上限+2テスト1本目');
    expect(firstBatch).toContain('上限+2テスト2本目');
    expect(lineStartingWith(firstBatch, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 2 件連続して残っている。$/,
    );

    const secondBatch = inputs[2] ?? '';
    expect(secondBatch).toContain('上限+2テスト3本目');
    expect(secondBatch).toContain('上限+2テスト4本目');
    expect(secondBatch).not.toContain('このターンへ束ねる合図は、上限');

    await s.clone.stop();
  }, 15_000);

  it('人間の発言でも同じ断り書きが載る（`#mergedHumanBatch` 経由でも共有の実装を通る）', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(humanMessage('人間1本目'));
    s.clone.post(humanMessage('人間2本目'));
    s.clone.post(humanMessage('人間3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('人間3本目') ?? false,
      '3本目（単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    const truncated = inputs[1] ?? '';
    expect(lineStartingWith(truncated, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。$/,
    );

    await s.clone.stop();
  }, 15_000);
});

describe('クローン — 中身の同じ external をまとめて読む（#841）', () => {
  const externalEvent = (id: string, source: string, payload: unknown, at: string): InboxEvent => ({
    type: 'external',
    id,
    at,
    source,
    payload,
  });

  const managerMessage = (id: string, managerId: string, text: string): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
  });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('中身（source・payload）が完全に同じ external が3件連続で届くと、1ターンへ束ねられ、本文に件数と全件の届いた時刻が載る', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '枠が開いた' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(
      externalEvent('e2', 'token-pool', { text: '枠が開いた' }, '2026-09-01T00:00:01.000Z'),
    );
    s.clone.post(
      externalEvent('e3', 'token-pool', { text: '枠が開いた' }, '2026-09-01T00:00:02.000Z'),
    );

    await waitFor(
      () =>
        (s.calls[0]?.inputs ?? []).some((input) =>
          input.includes('同じ中身の合図を続けて **3 件** まとめて渡す'),
        ),
      'まとめたターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);

    const merged = inputs[1] ?? '';
    // toContain('3 件') で測らない: 台帳の断り書きが同じ部分文字列を満たし、件数を落としても緑のままになるため、行ごと逐語で固定する
    expect(lineStartingWith(merged, '処理待ちのあいだに、同じ中身の合図を続けて')).toBe(
      '処理待ちのあいだに、同じ中身の合図を続けて **3 件** まとめて渡す' +
        '（本文は1回だけ。全件で `source` と中身が一致している）。',
    );
    expect(merged).toContain('2026-09-01T00:00:00.000Z');
    expect(merged).toContain('2026-09-01T00:00:01.000Z');
    expect(merged).toContain('2026-09-01T00:00:02.000Z');
    expect(merged.split('枠が開いた').length - 1).toBe(1);

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '3件とも消し込まれる',
    );

    const externals = (await s.stores.journal.list({ types: ['external_event'] })) as {
      source: string;
    }[];
    expect(externals.filter((entry) => entry.source === 'token-pool')).toHaveLength(3);

    await s.clone.stop();
  }, 15_000);

  it('🔴 source が違えば payload が同じでも束ねない（2ターンのまま）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '同じ中身' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(
      externalEvent('e2', 'runner-registry', { text: '同じ中身' }, '2026-09-01T00:00:01.000Z'),
    );

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('runner-registry')),
      '2件目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('source: token-pool');
    expect(inputs[1] ?? '').not.toContain('runner-registry');
    expect(inputs[2] ?? '').toContain('source: runner-registry');
    expect(inputs[2] ?? '').not.toContain('token-pool');

    await s.clone.stop();
  }, 15_000);

  it('🔴 source が同じでも payload が違えば束ねない（2ターンのまま）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(externalEvent('e1', 'token-pool', { text: '中身A' }, '2026-09-01T00:00:00.000Z'));
    s.clone.post(externalEvent('e2', 'token-pool', { text: '中身B' }, '2026-09-01T00:00:01.000Z'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('中身B')),
      '2件目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('中身A');
    expect(inputs[1] ?? '').not.toContain('中身B');
    expect(inputs[2] ?? '').toContain('中身B');
    expect(inputs[2] ?? '').not.toContain('中身A');

    await s.clone.stop();
  }, 15_000);

  it('🔴 external と human_message が混在すると束ねない', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '同じ中身' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(humanMessage('割り込む人間'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('割り込む人間')),
      '人間の発言のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('token-pool');
    expect(inputs[1] ?? '').not.toContain('割り込む人間');
    expect(inputs[2] ?? '').toContain('割り込む人間');
    expect(inputs[2] ?? '').not.toContain('token-pool');

    await s.clone.stop();
  }, 15_000);

  it('🔴 external と manager_message（report）が混在すると束ねない', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '同じ中身' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(managerMessage('r1', 'mgr-mix', '報告本文'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('報告本文')),
      'マネージャーの報告のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('token-pool');
    expect(inputs[1] ?? '').not.toContain('報告本文');
    expect(inputs[2] ?? '').toContain('報告本文');
    expect(inputs[2] ?? '').not.toContain('token-pool');

    await s.clone.stop();
  }, 15_000);

  it('束の上限に当たっても、外れた分は次の反復でそのまま処理される（1件も失われない。issue #783 と同じ機構）', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    // source は 'token-pool' にしない: commitmentFor がその文字列を台帳を開かない合図として特別扱いし、待っている「台帳に載せた」の断り書きが出なくなるため
    for (let i = 1; i <= 5; i += 1) {
      s.clone.post(
        externalEvent(`lim${i}`, 'ci', { text: '同じ中身' }, `2026-09-01T00:00:0${i}.000Z`),
      );
    }

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('id: `lim5`')),
      '5件目ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(4);
    expect(inputs[1] ?? '').toContain('2 件');
    expect(inputs[2] ?? '').toContain('2 件');
    expect(inputs[3] ?? '').not.toContain('まとめて渡す');

    const joined = inputs.join('\n');
    for (let i = 1; i <= 5; i += 1) {
      expect(joined).toContain('`lim' + String(i) + '`');
    }

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '5件とも消し込まれる',
    );

    await s.clone.stop();
  }, 15_000);

  it('external の束が上限で切れたときも、まとめ読みの断り書き（`CloneNotices` の `mergedBatchTruncation`）が載る', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(externalEvent('trunc1', 'ci', { text: '同じ中身' }, '2026-09-01T00:00:01.000Z'));
    s.clone.post(externalEvent('trunc2', 'ci', { text: '同じ中身' }, '2026-09-01T00:00:02.000Z'));
    s.clone.post(externalEvent('trunc3', 'ci', { text: '同じ中身' }, '2026-09-01T00:00:03.000Z'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('id: `trunc3`')),
      '3件目（単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);

    const truncated = inputs[1] ?? '';
    expect(lineStartingWith(truncated, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。$/,
    );
    expect(truncated).toContain(
      '**1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。',
    );

    const solo = inputs[2] ?? '';
    expect(solo).not.toContain('このターンへ束ねる合図は、上限');

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは既存の buildExternalEventPrompt の本文がそのまま出る（単発経路の非回帰）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(externalEvent('solo', 'ci', { status: 'failure' }, new Date().toISOString()));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('failure') ?? false,
      '2本目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);
    const solo = inputs[1] ?? '';
    expect(solo).toContain(
      '[system] 外部から出来事が届いた（source: ci）。人間はこれを見ていない。',
    );
    expect(solo).not.toContain('まとめて渡す');

    await s.clone.stop();
  }, 15_000);

  it('鍵が作れない payload（循環参照）でも束ねず、受信箱のループは死なない', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    const circular: Record<string, unknown> = { text: '循環参照' };
    circular.self = circular;

    s.clone.post(externalEvent('circ1', 'token-pool', circular, '2026-09-01T00:00:00.000Z'));
    s.clone.post(externalEvent('circ2', 'token-pool', circular, '2026-09-01T00:00:01.000Z'));
    s.clone.post(
      externalEvent('normal', 'token-pool', { text: '正常' }, '2026-09-01T00:00:02.000Z'),
    );

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('正常')),
      '循環参照の後も処理が続く',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(4);

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '4件とも消し込まれる',
    );

    await s.clone.stop();
  }, 15_000);
});
