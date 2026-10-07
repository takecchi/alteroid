import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { countsAsUndistilledActivity } from './distill-gap.js';
import { humanExchanges } from './conversation.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, setup, wireEvents, waitFor, waitForTerminal } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 枠に当たり続けたセッションは畳んで作り直す（Issue #1240）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  const BIG_BODY = 'x'.repeat(90_000);

  async function releaseAttemptCount(stores: Stores): Promise<number> {
    const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return rows.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  async function waitForReleaseAttempts(stores: Stores, expected: number): Promise<void> {
    await waitFor(
      async () => (await releaseAttemptCount(stores)) === expected,
      `解除の試行が${String(expected)}回になる`,
    );
  }

  function tick(id: string): InboxEvent {
    return { type: 'self_initiative', id, at: new Date().toISOString(), reason: 'テスト用tick' };
  }

  async function driveToTwoAccumulations(stores: Stores, s: Setup): Promise<void> {
    s.clone.post(humanMessage(BIG_BODY));
    await waitFor(() => s.clone.usageBlocked, '1回目で枠に当たって保持される');

    s.clone.post(tick('evt-si-1'));
    await waitForReleaseAttempts(stores, 1);
    await waitFor(() => s.clone.usageBlocked, '再試行1回目もまた枠に当たる');
  }

  it('2本ぶん（180,000文字。閾値未満）までは畳まない。resume 素材は残る', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    await driveToTwoAccumulations(stores, s);
    expect(await stores.sessions.getCloneSessionId()).not.toBeNull();

    await s.clone.stop();
  });

  it('3本ぶん（270,000文字。閾値超え）で、resume 素材を捨てて次は新しいセッションで走る', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    await driveToTwoAccumulations(stores, s);

    s.clone.post(tick('evt-si-2'));
    await waitForReleaseAttempts(stores, 2);

    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      '積算が閾値を超え、resume 素材が捨てられる',
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    s.clone.post(tick('evt-si-3'));
    await waitFor(() => s.calls.length > 1, '新しいセッションが開くこと');
    await s.clone.stop();

    expect(s.calls.length).toBeGreaterThan(1);
  });

  it('成功すると積算は0へ戻る——前の枠当たりの分を次の枠当たりへ持ち越さない', async () => {
    const stores = createMemoryStores();
    // 回数ではなく可変フラグで駆動する: resultFor は sideQuery（蒸留）からも turnIndex=0 で呼ばれ、通し番号だと側道の呼び出しで数字がずれるため
    let succeedNow = false;
    const s = setup(undefined, stores, {
      resultFor: () =>
        succeedNow
          ? { subtype: 'success', text: 'わかった' }
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });

    await driveToTwoAccumulations(stores, s);
    const inputsSoFar = (s.calls[0] as FakeCall).inputs.length;

    succeedNow = true;
    s.clone.post(tick('evt-si-2'));
    await waitFor(() => !s.clone.usageBlocked, '解除された発言が成功し、枠が解ける');
    // 次の枠当たりを起こす前に静まるまで少し待つ: 成功直後も残った合図の処理が続き、s.calls[0].inputs が動いて次の測定の基準がぶれるため
    await new Promise((resolve) => setTimeout(resolve, 80));
    succeedNow = false;
    expect(await stores.sessions.getCloneSessionId()).not.toBeNull();

    s.clone.post(humanMessage(BIG_BODY));
    await waitFor(() => s.clone.usageBlocked, '2本目の枠当たり: 新しい発言だけで枠に当たる');

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await stores.sessions.getCloneSessionId()).not.toBeNull();
    expect((s.calls[0] as FakeCall).inputs.length).toBeGreaterThan(inputsSoFar);

    await s.clone.stop();
  });

  it('畳んだ理由を「枠」だと人間へ言う（文脈窓だとは言わない。記録は消えたと言わない）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    await driveToTwoAccumulations(stores, s);
    s.clone.post(tick('evt-si-2'));
    await waitForReleaseAttempts(stores, 2);
    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      '積算が閾値を超え、resume 素材が捨てられる',
    );

    const rows = (await stores.journal.list({ types: ['exchange'], with: ['human'] })) as {
      role: string;
      text: string;
    }[];
    // #reportFailure が書く1行だけを採る: with: 'human' の outbound にはターン失敗前の本文の控えも載り、混同するため
    const outbound = rows.filter(
      (row) => row.role === 'outbound' && row.text.startsWith('いま利用上限に当たっているので'),
    );
    const last = outbound[0];
    await s.clone.stop();

    expect(last?.text).toContain('次の発言から新しく開き直す');
    expect(last?.text).toContain('枠（利用上限）');
    expect(last?.text).toContain('消えていない');
    expect(last?.text).not.toContain('失われ');
  });
});

describe('クローン — 枠の回復予定時刻（resetsAt）より前は再武装しない（Issue #1240 続き）', () => {
  const PAST_RESETS_AT_MS = 1_700_000_000_000;
  const FUTURE_RESETS_AT_MS = () => Date.now() + 60 * 60 * 1000;

  function setupRateLimited(resetsAt: number): Setup {
    return setup(undefined, createMemoryStores(), {
      // result 側の文言を上限のプレフィックスに当てない: classifyUsageNotice が resetsAt を持たない notice で #usageBlocked を上書きするため
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    });
  }

  async function releaseAttemptCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  function tick(id: string): InboxEvent {
    return { type: 'self_initiative', id, at: new Date().toISOString(), reason: 'テスト用tick' };
  }

  // self_initiative ではなく external を使う: self_initiative は isSameTick で畳まれ、前の1本が待ち行列に残っているうちに次を post すると消えるため
  function internalSignal(id: string): InboxEvent {
    return { type: 'external', id, at: new Date().toISOString(), source: `test-internal-${id}` };
  }

  it('resetsAt より前に届いた self_initiative は再武装しない', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    const inputsBefore = (s.calls[0] as FakeCall).inputs.length;
    s.clone.post(tick('evt-si-1'));

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);
    expect((s.calls[0] as FakeCall).inputs.length).toBe(inputsBefore);

    await s.clone.stop();
  });

  it('resetsAt より後（もう過ぎている）なら self_initiative でも再武装する', async () => {
    const s = setupRateLimited(PAST_RESETS_AT_MS);
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(tick('evt-si-1'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  it('resetsAt が分からない（文言だけの通知）なら、従来どおり self_initiative でも再武装する', async () => {
    const spendLimitMessage = "You've hit your individual spend limit for this account.";
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(tick('evt-si-1'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  it('token-pool の復帰通知（external）は resetsAt より前でも常に再武装する', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post({
      type: 'external',
      id: 'evt-tokenpool-1',
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    });
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  describe('⚠️ Issue #1223 再発: 同じ鍵の観測ベース回復は resetsAt 前なら再武装しない', () => {
    function setupRateLimitedWithIdentity(
      resetsAt: number,
      identity: () => { tokenId: string; generation: number } | undefined,
    ): Setup {
      const stores = createMemoryStores();
      const { fn, calls } = fakeSdk(undefined, {
        resultSubtype: 'error_during_execution',
        resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
      });
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        tokenIdentity: identity,
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events, waitForEvents } = wireEvents(clone, 'conv-1');
      return { clone, stores, calls, events, waitForEvents };
    }

    function reopenedNotice(tokenId: string, observedRecovery: boolean): InboxEvent {
      return {
        type: 'external',
        id: `evt-tokenpool-${tokenId}-${String(observedRecovery)}`,
        at: new Date().toISOString(),
        source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
        payload: { text: 'ダミー本文', tokenId, observedRecovery },
      };
    }

    it('同じ鍵・観測ベースの回復は再武装しない（抑止へ回る）', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => ({
        tokenId: 'tok-a',
        generation: 1,
      }));
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-a', true));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(s.clone.usageReleasePending).toBe(false);
      expect(await releaseAttemptCount(s)).toBe(0);

      await s.clone.stop();
    });

    it('違う鍵を指していれば、観測ベースでも常に再武装する', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => ({
        tokenId: 'tok-a',
        generation: 1,
      }));
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-b', true));
      await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

      await s.clone.stop();
    });

    it('観測ベースでない（「回した」「冷却が明けた」相当）なら、同じ鍵でも常に再武装する', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => ({
        tokenId: 'tok-a',
        generation: 1,
      }));
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-a', false));
      await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

      await s.clone.stop();
    });

    it('いまの鍵の身元が分からない（tokenIdentity 未設定）なら、判定できないので常に再武装する', async () => {
      const s = setupRateLimitedWithIdentity(FUTURE_RESETS_AT_MS(), () => undefined);
      s.clone.post(humanMessage('一件目'));
      await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

      s.clone.post(reopenedNotice('tok-a', true));
      await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

      await s.clone.stop();
    });
  });

  it('人間の発言は resetsAt より前でも常に再武装する', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(humanMessage('二件目'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  function managerNotice(id: string, synthesized: boolean): InboxEvent {
    return {
      type: 'manager_message',
      id,
      at: new Date().toISOString(),
      managerId: 'mgr-limit',
      kind: 'report',
      text: '（このターンは応答を返さずに終わった: success/429 / result_is_error）',
      ...(synthesized ? { synthesized: true as const } : {}),
    };
  }

  it('🔴 機構が合成したマネージャーの失敗の知らせは、resetsAt より前なら再武装しない', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    const inputsBefore = (s.calls[0] as FakeCall).inputs.length;
    s.clone.post(managerNotice('evt-mgr-synth-1', true));
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-mgr-synth-1');
    }, '合成された知らせが未読のまま保持される');

    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);
    expect((s.calls[0] as FakeCall).inputs.length).toBe(inputsBefore);

    await s.clone.stop();
  });

  it('マネージャー本人の報告（synthesized なし）は、resetsAt より前でも従来どおり再武装する', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(managerNotice('evt-mgr-own-1', false));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  it('機構が合成した知らせでも、resetsAt が過ぎていれば再武装する', async () => {
    const s = setupRateLimited(PAST_RESETS_AT_MS);
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(managerNotice('evt-mgr-synth-past', true));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    await s.clone.stop();
  });

  function resetsAtText(at: number): { text: string; expected: number } {
    const target = at - (at % 60_000) + 2 * 60 * 60 * 1000;
    const date = new Date(target);
    const hour24 = date.getUTCHours();
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    const meridiem = hour24 < 12 ? 'am' : 'pm';
    return {
      text:
        "You've hit your org's monthly spend limit · ask your admin to raise it at " +
        `claude.ai/admin-settings/usage · your session limit resets ${String(hour12)}:${minute}${meridiem} (UTC)`,
      expected: target,
    };
  }

  it('🔴 文言だけの枠でも、文言の時刻を回復予定時刻として持ち、それより前は内部の合図で再武装しない', async () => {
    const { text, expected } = resetsAtText(Date.now());
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: text,
    });
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    expect(s.clone.usageBlockedResetsAt).toBe(expected);

    s.clone.post(tick('evt-si-text-1'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);

    await s.clone.stop();
  });

  it('抑止した回数は捨てず、実際に解除を試した1行へ畳んで出て0へ戻る', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(internalSignal('evt-si-1'));
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-si-1');
    }, 'evt-si-1 が未読のまま保持される');
    s.clone.post(internalSignal('evt-si-2'));
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-si-2');
    }, 'evt-si-2 が未読のまま保持される');
    expect(s.clone.usageReleasePending).toBe(false);
    expect(await releaseAttemptCount(s)).toBe(0);

    s.clone.post(humanMessage('二件目'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 1, '解除の試行が1回になる');

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const releaseLine = exchanges.find((entry) => entry.text.includes('枠の解除を試す'));
    expect(releaseLine?.text).toContain('再武装を抑止: 2 回');

    await waitFor(() => s.clone.usageBlocked, '二件目の再試行がまた枠に当たる');
    s.clone.post(internalSignal('evt-si-3'));
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'evt-si-3');
    }, 'evt-si-3 が未読のまま保持される');
    s.clone.post(humanMessage('三件目'));
    await waitFor(async () => (await releaseAttemptCount(s)) === 2, '解除の試行が2回になる');

    const exchangesAfter = (await s.stores.journal.list({ types: ['exchange'] })) as {
      text: string;
    }[];
    const releaseLines = exchangesAfter.filter((entry) => entry.text.includes('枠の解除を試す'));
    expect(releaseLines).toHaveLength(2);
    expect(releaseLines[0]?.text).toContain('再武装を抑止: 1 回');
    expect(releaseLines[0]?.text).not.toContain('再武装を抑止: 2 回');
    expect(releaseLines[1]?.text).toContain('再武装を抑止: 2 回');

    await s.clone.stop();
  });
});

describe('クローン — token-pool の復帰通知: 畳んだ件数だけが違う2通の扱い（Issue #1298）', () => {
  const FUTURE_RESETS_AT_MS = () => Date.now() + 60 * 60 * 1000;

  function setupRateLimited(resetsAt: number): Setup {
    return setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    });
  }

  async function releaseAttemptCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  function tokenPoolReopenedNotice(
    id: string,
    folded: number,
    options?: { readonly tokenId?: string; readonly how?: string; readonly identity?: string },
  ): InboxEvent {
    const tokenId = options?.tokenId ?? 'tok-a';
    const how = options?.how ?? 'また通るようになった';
    const base =
      `認証トークンが通る状態に戻った（${how}）: ` +
      `「本命」（id ${tokenId}）。枠で止まっていた仕事は、ここから再開できる。`;
    const text =
      folded <= 0
        ? base
        : `${base}（この間に同じ合図が ${String(folded + 1)} 件届き、1件にまとめた）`;
    return {
      type: 'external',
      id,
      at: new Date().toISOString(),
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text },
      ...(options?.identity !== undefined ? { identity: options.identity } : {}),
    };
  }

  it('陽性対照（直す前）: identity を渡さなければ、folded だけが違う2通は別の行のまま（後方互換）', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(tokenPoolReopenedNotice('evt-reopen-1', 4));
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).entries.some((p) => p.event.id === 'evt-reopen-1'),
      '1件目（folded=4）が受信箱に積まれる',
    );

    s.clone.post(tokenPoolReopenedNotice('evt-reopen-2', 7));
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).entries.some((p) => p.event.id === 'evt-reopen-2'),
      '2件目（folded=7）が受信箱に積まれる',
    );

    const pending = (await s.stores.inbox.peekPending()).entries;
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-1' || p.event.id === 'evt-reopen-2',
    );
    expect(reopenRows).toHaveLength(2);

    await s.clone.stop();
  });

  it('直った後: identity が同じなら、folded だけが違う2通は1行に畳まれる。合図は消えず、クローンは再開できる', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    const identity = '5:tok-aまた通るようになった';
    s.clone.post(tokenPoolReopenedNotice('evt-reopen-1', 4, { identity }));
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).entries.some((p) => p.event.id === 'evt-reopen-1'),
      '1件目（folded=4）が受信箱に積まれる（代表）',
    );

    s.clone.post(tokenPoolReopenedNotice('evt-reopen-2', 7, { identity }));
    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        text: string;
      }[];
      return exchanges.some((entry) => entry.text.includes('受信箱の行は増やさずに'));
    }, '2件目が行を増やさずに畳まれた跡が日誌に付く');

    const pending = (await s.stores.inbox.peekPending()).entries;
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-1' || p.event.id === 'evt-reopen-2',
    );
    expect(reopenRows).toHaveLength(1);
    expect(reopenRows[0]?.event.id).toBe('evt-reopen-1');

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const foldLines = exchanges.filter((entry) => entry.text.includes('受信箱の行は増やさずに'));
    expect(foldLines).toHaveLength(1);
    expect(foldLines[0]?.text).toContain('external source.chars=10 payload=yes');
    expect(foldLines[0]?.text).toContain('本文と届いた時刻はこのあと束ね読み');

    await waitFor(async () => (await releaseAttemptCount(s)) >= 1, '解除の試行が走る');

    await s.clone.stop();
  });

  it('陰性対照: identity が同じでも tokenId が違えば別の行のまま（合図は消えない）', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-a', 0, { tokenId: 'tok-a', identity: 'id-a' }),
    );
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).entries.some((p) => p.event.id === 'evt-reopen-a'),
      'トークン A の復帰通知が受信箱に積まれる',
    );

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-b', 0, { tokenId: 'tok-b', identity: 'id-b' }),
    );
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).entries.some((p) => p.event.id === 'evt-reopen-b'),
      'トークン B の復帰通知が受信箱に積まれる',
    );

    const pending = (await s.stores.inbox.peekPending()).entries;
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-a' || p.event.id === 'evt-reopen-b',
    );
    expect(reopenRows).toHaveLength(2);

    await s.clone.stop();
  });

  it('陰性対照: 同じトークンでも how が違えば別の行のまま（根拠の強さが違うので潰さない）', async () => {
    const s = setupRateLimited(FUTURE_RESETS_AT_MS());
    s.clone.post(humanMessage('一件目'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-rotated', 0, {
        how: '回した',
        identity: 'id-回した',
      }),
    );
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).entries.some(
          (p) => p.event.id === 'evt-reopen-rotated',
        ),
      '「回した」の通知が受信箱に積まれる',
    );

    s.clone.post(
      tokenPoolReopenedNotice('evt-reopen-recovered', 0, {
        how: 'また通るようになった',
        identity: 'id-また通るようになった',
      }),
    );
    await waitFor(
      async () =>
        (await s.stores.inbox.peekPending()).entries.some(
          (p) => p.event.id === 'evt-reopen-recovered',
        ),
      '「また通るようになった」の通知が受信箱に積まれる',
    );

    const pending = (await s.stores.inbox.peekPending()).entries;
    const reopenRows = pending.filter(
      (p) => p.event.id === 'evt-reopen-rotated' || p.event.id === 'evt-reopen-recovered',
    );
    expect(reopenRows).toHaveLength(2);

    await s.clone.stop();
  });
});

describe('クローン — 保持中の内部の合図は、失敗記録を1件ごとに日誌へ書かない（Issue #1240 続き）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";
  const internalFailureMark = `${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`;

  async function internalFailureCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return exchanges.filter(
      (entry) => entry.with === 'self' && entry.text.startsWith(internalFailureMark),
    ).length;
  }

  function internalSignal(id: string): InboxEvent {
    return { type: 'external', id, at: new Date().toISOString(), source: `test-internal-${id}` };
  }

  it('保持件数が増えても、内部の失敗記録は再武装の回数ぶんしか増えない（N×M にならない）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(internalSignal('evt-1'));
    await waitFor(async () => (await internalFailureCount(s)) === 1, '1本目の失敗が記録される');
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(internalSignal('evt-2'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 2,
      '1本目の再試行の失敗が記録される',
    );

    s.clone.post(internalSignal('evt-3'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 3,
      '2周目の再試行の失敗が記録される',
    );

    s.clone.post(internalSignal('evt-4'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 4,
      '3周目の再試行の失敗が記録される',
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await internalFailureCount(s)).toBe(4);

    await s.clone.stop();
  });

  it('畳んだ件数は失われず、実際に解除を試した1行へ「畳んだ」件数として残り、そのつど0へ戻る', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(internalSignal('evt-1'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');

    s.clone.post(internalSignal('evt-2'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 2,
      '1本目の再試行の失敗が記録される',
    );
    await waitFor(() => s.clone.usageBlocked, '1本目の再試行もまた枠に当たる');

    s.clone.post(internalSignal('evt-3'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 3,
      '2周目の再試行の失敗が記録される',
    );
    await waitFor(() => s.clone.usageBlocked, '2周目の再試行もまた枠に当たる');

    s.clone.post(internalSignal('evt-4'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 4,
      '3周目の再試行の失敗が記録される',
    );

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const releaseLines = exchanges
      .filter((entry) => entry.text.includes('枠の解除を試す'))
      .map((entry) => entry.text);
    expect(releaseLines).toHaveLength(3);
    expect(releaseLines[2]).not.toContain('内部の失敗記録を畳んだ');
    expect(releaseLines[1]).toContain('内部の失敗記録を畳んだ: 1 件');
    expect(releaseLines[0]).toContain('内部の失敗記録を畳んだ: 2 件');
    expect(releaseLines[0]).not.toContain('内部の失敗記録を畳んだ: 3 件');

    await s.clone.stop();
  });

  const FOLD_COUNT_SCOPE_PHRASES = [
    'この枠の区間でこのプロセスが数えた分だけ',
    '器の入れ替えを跨いだ分',
    'ターンの成功で枠が降りた回の分',
    '下限',
  ] as const;

  it('解除の1行の件数は、この枠の区間・このプロセスの分だけで下限であることを名乗る（件数が0の行には付けない）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(internalSignal('evt-1'));
    await waitFor(() => s.clone.usageBlocked, '枠に当たって保持される');
    s.clone.post(internalSignal('evt-2'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 2,
      '1本目の再試行の失敗が記録される',
    );
    await waitFor(() => s.clone.usageBlocked, '1本目の再試行もまた枠に当たる');
    s.clone.post(internalSignal('evt-3'));
    await waitFor(
      async () => (await internalFailureCount(s)) === 3,
      '2周目の再試行の失敗が記録される',
    );

    const releaseEntries = (
      (await s.stores.journal.list({ types: ['exchange'] })) as JournalEntry[]
    ).filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('枠の解除を試す'),
    );
    expect(releaseEntries).toHaveLength(2);
    const [folded, empty] = releaseEntries;
    expect(folded?.text).toContain('内部の失敗記録を畳んだ: 1 件');
    for (const phrase of FOLD_COUNT_SCOPE_PHRASES) {
      expect(folded?.text).toContain(phrase);
      expect(empty?.text).not.toContain(phrase);
    }

    expect(folded && countsAsUndistilledActivity(folded)).toBe(false);
    expect(humanExchanges(releaseEntries)).toEqual([]);

    await s.clone.stop();
  });

  it('解除の1行は、旧い文言でも射程を名乗る新しい文言でも「自分に向けて書いた記録」と判定される（陽性対照）', () => {
    const oldText =
      '枠の解除を試す。新しい合図が届いたので、保持していた 2 件を配り直す。' +
      ' 人間が待っていない内部の失敗記録を畳んだ: 2 件。';
    const newText = `${oldText}${FOLD_COUNT_SCOPE_PHRASES.join('／')}`;
    const entries: JournalEntry[] = [oldText, newText].map((text, i) => ({
      type: 'exchange',
      id: `release-${String(i)}`,
      at: '2026-09-23T00:00:00.000Z',
      with: 'self',
      role: 'outbound',
      text,
    }));
    for (const entry of entries) {
      expect(countsAsUndistilledActivity(entry)).toBe(false);
    }
    expect(humanExchanges(entries)).toEqual([]);
  });

  it('会話に紐づく失敗（人間との対話ターンが失敗した）は、内部の合図と混ざっても1文字も変わらない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);

    const humanFailureMark = `${EXCHANGE_KIND_FAILURE_PREFIX}人間との対話ターンが失敗した`;
    const rows = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const humanFailures = rows.filter(
      (entry) => entry.with === 'self' && entry.text.startsWith(humanFailureMark),
    );
    expect(humanFailures).toHaveLength(1);
    expect(humanFailures[0]?.text).toContain(spendLimitMessage);

    s.clone.post(internalSignal('evt-1'));
    await waitFor(async () => {
      const after = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return (
        after.filter((entry) => entry.with === 'self' && entry.text.startsWith(humanFailureMark))
          .length === 2
      );
    }, '一件目の再試行の失敗がもう1件記録される');

    await s.clone.stop();
  });
});
