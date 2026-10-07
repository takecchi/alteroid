import { describe, it, expect } from 'vitest';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { CloneHost } from './host.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, lineStartingWith, waitFor, waitForDone } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';

describe('クローン — SDK のエラーを応答として扱わない（日報がエラー文になる穴）', () => {
  const orgSpendLimit =
    "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

  function postDailyReport(clone: CloneHost, date: string): void {
    clone.post({
      type: 'timer',
      id: `evt-timer-${date}`,
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: date,
    });
  }

  const reportsOf = async (stores: Stores) =>
    (await stores.journal.list({ types: ['daily_report'] })) as {
      type: 'daily_report';
      date: string;
      body: string;
      unavailable?: string;
    }[];

  it('assistant.error が付いた本文は日報にならず、枠で保持している回は日報の行を1つも書かない', async () => {
    const s = setup(() => 'ここは日報の本文になってはいけない', createMemoryStores(), {
      assistantErrorAt: () => ({ error: 'billing_error', text: orgSpendLimit }),
    });

    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
      );
    }, '日報のターンが失敗として記録される');

    expect(await reportsOf(s.stores)).toHaveLength(0);

    const failures = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) =>
      entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
    );
    expect(failures[0]?.text).toContain(orgSpendLimit);
    expect(failures[0]?.text).toContain('billing_error');
    expect(failures[0]?.text).toContain('assistant_error');

    const notices = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) => entry.text.startsWith(`${EXCHANGE_KIND_GAUGE_PREFIX}利用上限に当たった`));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain(orgSpendLimit);

    await s.clone.stop();
  });

  it('subtype:success でも is_error が立っていれば応答として扱わない', async () => {
    const s = setup(() => 'これも日報の本文になってはいけない', createMemoryStores(), {
      resultFor: () => ({ subtype: 'success', text: orgSpendLimit, isError: true }),
    });

    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
      );
    }, '日報のターンが失敗として記録される');

    expect(await reportsOf(s.stores)).toHaveLength(0);

    const failures = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) =>
      entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
    );
    expect(failures[0]?.text).toContain('result_is_error');

    await s.clone.stop();
  });

  it('枠ではない失敗では unavailable の印付きで書き、印の行は「日報がある」と数えない', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '部分的に出ていた本文', stores, {
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });

    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => (await reportsOf(stores)).length === 1, '印付きの行が書かれる');
    const placeholder = (await reportsOf(stores))[0];
    expect(placeholder?.body).not.toBe('内部で何かが壊れた');
    expect(placeholder?.body).toContain('作れなかった');
    expect(placeholder?.unavailable).toContain('内部で何かが壊れた');
    await s.clone.stop();

    const again = setup(() => '今日はログイン周りを直した。保留は無い。', stores);
    postDailyReport(again.clone, '2026-08-19');
    await waitFor(async () => {
      const reports = await reportsOf(stores);
      return reports.some((entry) => entry.unavailable === undefined);
    }, '後から本物の日報が書ける');

    const written = (await reportsOf(stores)).filter((entry) => entry.unavailable === undefined);
    expect(written).toHaveLength(1);
    expect(written[0]?.body).toContain('ログイン周り');
    await again.clone.stop();
  });

  it('本物の日報が既にある日は、失敗しても印の行を足さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'daily_report',
      date: '2026-08-19',
      body: 'クローンが道具で書いた日報',
    });

    const s = setup(() => '書いておいた', stores, {
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });
    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => {
      const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
      );
    }, 'ターンが失敗として記録される');

    const reports = await reportsOf(stores);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.unavailable).toBeUndefined();
    await s.clone.stop();
  });

  it('成功したターンでは印を付けない（この機構が普段の日報を壊していないこと）', async () => {
    const s = setup(() => '今日はログイン周りを直した。保留は無い。');
    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => (await reportsOf(s.stores)).length === 1, '日報が書かれる');
    const report = (await reportsOf(s.stores))[0];
    expect(report?.unavailable).toBeUndefined();
    expect(report?.body).toContain('ログイン周り');
    await s.clone.stop();
  });

  it('組織方針で止められた回も日誌に残る（待たないが、記録はする）', async () => {
    const orgPolicy = 'This service is disabled for your organization';
    const s = setup(() => 'なにか', createMemoryStores(), {
      resultFor: () => ({ subtype: 'error_during_execution', text: orgPolicy }),
    });

    s.clone.post(humanMessage('一件目'));

    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        text: string;
      }[];
      return exchanges.some((entry) =>
        entry.text.startsWith(`${EXCHANGE_KIND_GAUGE_PREFIX}組織の方針で止められている`),
      );
    }, '組織方針の知らせが日誌に残る');

    const notices = s.events.filter((event) => event.type === 'usage_limited');
    expect(notices).toHaveLength(0);

    await s.clone.stop();
  });
});

describe('クローン — 処理待ちのあいだに積み上がった発言', () => {
  const waitForFirstTurn = (s: Setup): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

  const waitForDelivered = (s: Setup, text: string): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs ?? []).join('\n').includes(text), `${text} が渡る`);

  // 本数を waitFor で待たない: 期待どおりにならない世界（変異）でタイムアウトになり、歯があった証拠にならないため。最後の発言が届くまで待ってから等値で比べる
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('処理待ちに積み上がった発言は1ターンにまとめて渡る（全文が届いた順に載る）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 250 });

    s.clone.post(humanMessage('一件目'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('二件目'));
    s.clone.post(humanMessage('三件目'));

    await waitForDelivered(s, '三件目');
    await settle();

    expect(s.calls[0]?.inputs).toHaveLength(2);

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain('二件目');
    expect(merged).toContain('三件目');
    expect(merged).toContain('続けて **2 件** まとめて渡す');
    expect(merged.indexOf('二件目')).toBeLessThan(merged.indexOf('三件目'));

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは本文に断り書きを足さない（普通の一往復を重くしない）', async () => {
    const s = setup(() => 'わかった');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const input = s.calls[0]?.inputs[0] ?? '';
    expect(input).toContain('やあ');
    expect(input).not.toContain('の発言が届いた');
    expect(input).not.toContain('まとめて1つの応答で答えよ');

    await s.clone.stop();
  });

  it('会話が違う発言はまとめない（別の端末で話している相手の画面に応答を流さない）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 150 });

    s.clone.post(humanMessage('先客', 'conv-1'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('こちら1', 'conv-1'));
    s.clone.post(humanMessage('あちら', 'conv-2'));
    s.clone.post(humanMessage('こちら2', 'conv-1'));

    await waitForDelivered(s, 'こちら2');
    await settle();

    expect(s.calls[0]?.inputs).toHaveLength(4);
    const second = s.calls[0]?.inputs[1] ?? '';
    expect(second).toContain('こちら1');
    expect(second).not.toContain('あちら');
    expect(second).not.toContain('こちら2');

    await s.clone.stop();
  }, 15_000);

  it('人間以外どうしは、間に別の起点が挟まっても飛び越えない', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('挟まる前'));
    s.clone.post({
      type: 'external',
      id: 'evt-ext',
      at: new Date().toISOString(),
      source: 'webhook',
      payload: '先に届いた外部イベント',
    });
    s.clone.post(humanMessage('挟まった後'));

    await waitForDelivered(s, '挟まった後');
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    expect(inputs).toHaveLength(3);
    expect(inputs[1]).toContain('挟まる前');
    expect(inputs[1]).toContain('挟まった後');
    const merged = inputs[1] ?? '';
    expect(merged.indexOf('挟まる前')).toBeLessThan(merged.indexOf('挟まった後'));
    expect(inputs[2]).toContain('先に届いた外部イベント');

    await s.clone.stop();
  }, 15_000);

  it('まとめた分は1件も器に残らない（起動のたびに配り直される形を作らない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('続き1'));
    s.clone.post(humanMessage('続き2'));

    await waitForDelivered(s, '続き2');
    await settle();

    expect(await stores.inbox.claimPending()).toEqual([]);

    await s.clone.stop();
  }, 15_000);

  it('まとめた件数ぶんの未了 id が断り書きに載る（閉じ方を渡さない未了を作らない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('続き1'));
    s.clone.post(humanMessage('続き2'));

    await waitForDelivered(s, '続き2');
    await settle();

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain('2 件も台帳に載せた');
    expect(merged).toContain('evt-続き1');
    expect(merged).toContain('evt-続き2');
    expect(merged).toContain('閉じるのは id ごとである');

    await s.clone.stop();
  }, 15_000);

  it('まとめて届いた未了が大量でも、id の列挙は抜粋の合図で締まる', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    const count = 50;
    for (let index = 0; index < count; index += 1) {
      s.clone.post(humanMessage(`続き${index}`));
    }

    await waitForDelivered(s, `続き${count - 1}`);
    await settle();

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain(`${count} 件も台帳に載せた`);
    const line = merged.split('\n').find((entry) => entry.includes('台帳に載せた（id:'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(600);
    expect(line).toMatch(/省略/);

    await s.clone.stop();
  }, 15_000);

  it('配り直しの合図はまとめる（束の行が件数を言うので、何が二度目かは言える。issue #783）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(humanMessage('未読1'), '2026-08-20T10:00:00.000Z');
    await stores.inbox.put(humanMessage('未読2'), '2026-08-20T10:00:01.000Z');

    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    await waitForDelivered(s, '未読2');
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    expect(inputs).toHaveLength(1);
    const merged = inputs[0] ?? '';
    // toContain で測らない: 同じ語が別の行に在ると節ごと消しても緑のままになるため、束の行を1行として取り出して全文一致で見る
    const noticeLine = lineStartingWith(merged, '[system] **これは配り直しの束である');
    expect(noticeLine).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 2026-08-20T10:00:00.000Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    expect(merged).toContain('未読1');
    expect(merged).toContain('未読2');

    await s.clone.stop();
  }, 15_000);

  // 先頭に「奪われ役」の非人間を1件多く置く: 最初に配り直される1件は待ち手へ直接渡って走行中のターンになり、insertAfterLast が効く相手の待ち行列が空のままになるため
  it('起動直後の配り直しでも、人間の発言は待ち行列に残っていた非人間より先に読まれる（#restoreUnread の人間優先）', async () => {
    const stores = createMemoryStores();
    const nonHumanA: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-a',
      at: '2026-08-20T10:00:00.000Z',
      source: 'webhook-a',
      payload: '非人間A（claim順で最初・走行中のターンを奪う）',
    };
    const nonHumanC: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-c',
      at: '2026-08-20T10:00:01.000Z',
      source: 'webhook-c',
      payload: '非人間C（待ち行列に積まれて残る）',
    };
    const human = humanMessage('人間の発言だ');
    const nonHumanB: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-b',
      at: '2026-08-20T10:00:03.000Z',
      source: 'webhook-b',
      payload: '非人間B（human より後・飛び越されない）',
    };

    // claim 順は put の第2引数で明示する: humanMessage() は event.at に実時刻を積むので、それを使うと human が最後尾に落ちるため
    await stores.inbox.put(nonHumanA, '2026-08-20T10:00:00.000Z');
    await stores.inbox.put(nonHumanC, '2026-08-20T10:00:01.000Z');
    await stores.inbox.put(human, '2026-08-20T10:00:02.000Z');
    await stores.inbox.put(nonHumanB, '2026-08-20T10:00:03.000Z');

    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    await waitForDelivered(s, '非人間B（human より後・飛び越されない）');
    await settle();

    const joined = (s.calls[0]?.inputs ?? []).join('\n');
    const idxA = joined.indexOf('非人間A（claim順で最初・走行中のターンを奪う）');
    const idxC = joined.indexOf('非人間C（待ち行列に積まれて残る）');
    const idxHuman = joined.indexOf('人間の発言だ');
    const idxB = joined.indexOf('非人間B（human より後・飛び越されない）');

    expect(idxA).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);
    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    expect(idxHuman).toBeLessThan(idxC);

    expect(idxA).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxB);

    expect(idxHuman).toBeLessThan(idxB);

    await s.clone.stop();
  }, 15_000);
});
