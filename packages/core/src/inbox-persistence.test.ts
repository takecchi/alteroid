import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import {
  ALWAYS_REDELIVER,
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  createClone,
} from './clone.js';
import type { RedeliveryGate } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, JobStatus } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, failingInboxPut, humanMessage } from './testing.js';

// 器の死を `stop()` で代用しない: 片付けの経路しか通らず、「終える前に消える」が再現できないため

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(behavior: 'reply' | 'hang' = 'reply'): Fake {
  const inputs: string[] = [];
  const forever = new Promise<void>(() => undefined);

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        if (behavior === 'hang') await forever;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

function bootClone(
  stores: Stores,
  behavior: 'reply' | 'hang' = 'reply',
  redeliveryGate: RedeliveryGate = ALWAYS_REDELIVER,
): Fake & { clone: CloneHost } {
  const fake = fakeSdk(behavior);
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate,
  });
  return { ...fake, clone };
}

// `source` に予約語（`token-pool` 等）を使わない: `commitmentFor` が特別扱いし、台帳が開く前提の歯が赤くなるため
function externalNotice(
  payload: string,
  id = 'evt-ext',
  at = '2026-08-01T00:00:00.000Z',
): InboxEvent {
  return { type: 'external', id, at, source: 'redelivery-gate-probe', payload };
}

function report(text: string, id = 'evt-report'): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date(0).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

function gatedSdk(): Fake & { release: () => void } {
  const inputs: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstDone = false;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        if (!firstDone) {
          firstDone = true;
          await gate;
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs, release };
}

function bootGatedClone(stores: Stores): Fake & { clone: CloneHost; release: () => void } {
  const fake = gatedSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { ...fake, clone };
}

async function idle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('未読の永続化', () => {
  it('クローンが暇なときに届いた合図も器に残る（queue を通らない経路）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores, 'hang');
    await idle();

    clone.post(report('PR #99 をマージした'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');

    const pending = await stores.inbox.claimPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-report');
    expect((pending[0]?.event as { text: string }).text).toBe('PR #99 をマージした');
  });

  it('処理を終えたら器から消える（再起動のたびに処理済みを配り直さない）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores);

    clone.post(report('終わった'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');
    await clone.stop();

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('終える前に器が落ちたら、次の起動で配り直される（本文ごと）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('作業者が3本走っている。判断を仰ぎたい'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).toContain('作業者が3本走っている。判断を仰ぎたい');
    expect(prompt).toContain('マネージャー mgr-1 から届いた');

    await reborn.clone.stop();
  });

  it('配り直しだと分かる形で届く（二度目だと分からないのは受け入れない）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('同じ報告'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).toContain('配り直し');
    expect(prompt).toContain('1 回目の配達');
    expect(prompt.indexOf('配り直し')).toBeLessThan(prompt.indexOf('同じ報告'));

    const journal = await stores.journal.list({ types: ['exchange'] });
    expect(
      journal.some(
        (entry) =>
          entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
      ),
    ).toBe(true);

    await reborn.clone.stop();
  });

  it('配り直すたびに回数が上がる（毎回落ちているなら、それが見える）', async () => {
    const stores = createMemoryStores();

    const first = bootClone(stores, 'hang');
    await idle();
    first.clone.post(report('処理するたびに器が落ちる合図'));
    await waitFor(() => first.inputs.length > 0, '合図が処理に入る');

    const second = bootClone(stores, 'hang');
    await waitFor(() => second.inputs.length > 0, '1 回目の配り直し');
    expect(second.inputs[0] ?? '').toContain('1 回目の配達');

    const third = bootClone(stores);
    await waitFor(() => third.inputs.length > 0, '2 回目の配り直し');
    const prompt = third.inputs[0] ?? '';
    expect(prompt).toContain('2 回目の配達');
    expect(prompt).toContain('2 回以上配り直している');

    await third.clone.stop();
  });

  it('未読が複数あるときは、回数を「この合図で落ちた」の根拠にしない（(α) と (β) を分ける）', async () => {
    const stores = createMemoryStores();

    const first = bootClone(stores, 'hang');
    await idle();
    first.clone.post(report('先頭の合図', 'evt-a'));
    first.clone.post(report('居合わせただけの合図 1', 'evt-b'));
    first.clone.post(report('居合わせただけの合図 2', 'evt-c'));
    await waitFor(() => first.inputs.length > 0, '先頭が処理に入る');

    const second = bootClone(stores, 'hang');
    await waitFor(() => second.inputs.length > 0, '1 回目の配り直し');

    const third = bootClone(stores);
    await waitFor(() => third.inputs.length > 0, '2 回目の配り直し');
    const prompt = third.inputs[0] ?? '';

    expect(prompt).toContain('最大 2 回の配達');
    expect(prompt).toContain('3 件');
    expect(prompt).not.toContain('2 回以上配り直している');
    expect(prompt).toContain('この合図の処理が落ちた回数ではない');

    await third.clone.stop();
  });

  it('未読が1件だけなら、日誌の1行は回数をそのまま名乗る（journal_read で読み返す側に余計な修飾を足さない）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('たった1件の合図'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const journal = await stores.journal.list({ types: ['exchange'] });
    const matches = journal.filter(
      (entry) =>
        entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
    );
    const head = matches[0];
    const line = head && head.type === 'exchange' ? head.text : '';

    expect(line).toContain('回目の配達、');
    expect(line).not.toContain('器が入れ替わった回数');

    await reborn.clone.stop();
  });

  it('未読が複数あるときは、日誌の1行も「器が入れ替わった回数」だと名乗る（#700 が渡す側でやったことを、読み返す側にも及ぼす）', async () => {
    const stores = createMemoryStores();

    const first = bootClone(stores, 'hang');
    await idle();
    first.clone.post(report('先頭の合図', 'evt-a'));
    first.clone.post(report('居合わせただけの合図 1', 'evt-b'));
    first.clone.post(report('居合わせただけの合図 2', 'evt-c'));
    await waitFor(() => first.inputs.length > 0, '先頭が処理に入る');

    const reborn = bootClone(stores);
    await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

    const journal = await stores.journal.list({ types: ['exchange'] });
    const matches = journal.filter(
      (entry) =>
        entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
    );
    const head = matches[0];
    const line = head && head.type === 'exchange' ? head.text : '';

    expect(line).toContain('器が入れ替わった回数');
    expect(line).toContain('3 件');
    expect(line).toContain('処理が落ちた回数ではない');

    await reborn.clone.stop();
  });

  describe('N件の live な未読を一括で拾い直すときの「配り直した」の畳み方', () => {
    it("with: 'self' の「配り直した」行は1本だけである（N本でもN+1本でもない）", async () => {
      const stores = createMemoryStores();
      const ids = ['evt-fold-a', 'evt-fold-b', 'evt-fold-c'];
      for (const [i, id] of ids.entries()) {
        const at = `2026-08-09T00:00:0${i}.000Z`;
        await stores.inbox.put(report(`畳みテスト ${i}`, id), at);
      }

      // `hang` の clone は `.stop()` を呼ばない: 止まったままの1件目のターンを待ち続けて `clone.stop()` が返らないため
      const { inputs } = bootClone(stores, 'hang');
      await waitFor(() => inputs.length > 0, '先頭が処理に入る');

      const exchanges = await stores.journal.list({ types: ['exchange'] });
      const matches = exchanges.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.with === 'self' &&
          entry.text.includes('未読のまま残っていた合図を配り直した'),
      );
      expect(matches.length).toBe(1);
    });

    it('その1本から、N件それぞれの配達回数・受け取り時刻・合図の形が読める', async () => {
      const stores = createMemoryStores();
      const records = [
        { id: 'evt-detail-a', at: '2026-08-09T01:00:00.000Z' },
        { id: 'evt-detail-b', at: '2026-08-09T01:00:01.000Z' },
        { id: 'evt-detail-c', at: '2026-08-09T01:00:02.000Z' },
      ];
      for (const r of records) {
        await stores.inbox.put(report(`詳細テスト ${r.id}`, r.id), r.at);
      }

      const { inputs } = bootClone(stores, 'hang');
      await waitFor(() => inputs.length > 0, '先頭が処理に入る');

      const exchanges = await stores.journal.list({ types: ['exchange'] });
      const folded = exchanges.find(
        (entry) =>
          entry.type === 'exchange' &&
          entry.with === 'self' &&
          entry.text.includes('未読のまま残っていた合図を配り直した'),
      );
      const text = folded && folded.type === 'exchange' ? folded.text : '';

      for (const r of records) {
        expect(text).toContain(r.at);
      }
      expect(text.match(/1回目の配達/g)?.length).toBe(3);
      expect(text.match(/manager_message managerId=/g)?.length).toBe(3);
    });

    it('この1本は、record 自身の本文（#record が書く exchange with:human）より前に書かれる', async () => {
      const stores = createMemoryStores();

      // `clone.post()` を経由しない: `post()` は受理した瞬間に `#record` を呼び、別の本文がもう1本 journal に載ってしまうため
      await stores.inbox.put(humanMessage('order-probe-1'), '2026-08-09T02:00:00.000Z');
      await stores.inbox.put(humanMessage('order-probe-2'), '2026-08-09T02:00:01.000Z');

      // `hang` の clone は `.stop()` を呼ばない: 止まったままの1件目のターンを待ち続けて `clone.stop()` が返らないため
      const { inputs } = bootClone(stores, 'hang');
      await waitFor(() => inputs.length > 0, '先頭が処理に入る');
      await waitForJournal(stores, 'order-probe-2');

      const exchanges = await stores.journal.list({ types: ['exchange'], order: 'asc' });
      const headlineIndex = exchanges.findIndex(
        (entry) =>
          entry.type === 'exchange' &&
          entry.with === 'self' &&
          entry.text.includes('未読のまま残っていた合図を配り直した'),
      );
      const bodyIndexes = exchanges
        .map((entry, index) => ({ entry, index }))
        .filter(
          ({ entry }) =>
            entry.type === 'exchange' && entry.with === 'human' && entry.role === 'inbound',
        )
        .map(({ index }) => index);

      expect(headlineIndex).toBeGreaterThanOrEqual(0);
      expect(bodyIndexes.length).toBeGreaterThanOrEqual(2);
      for (const bodyIndex of bodyIndexes) {
        expect(headlineIndex).toBeLessThan(bodyIndex);
      }
    });
  });

  it('例外で終わった合図も消える（記録は残っているので、永久に配り直さない）', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      jobs: { ...base.jobs, getApproval: () => Promise.reject(new Error('台帳が壊れている')) },
    };
    const { clone } = bootClone(stores);

    clone.post({
      type: 'human_answer',
      id: 'evt-answer',
      at: new Date(0).toISOString(),
      approvalId: 'apv-1',
      answer: 'よい',
    });

    await waitForJournal(stores, '内部ターンが失敗した');

    await waitForNoUnread(stores);
    await clone.stop();
  });

  it('未読を書けなくても post は落ちない。有界の拾い直しが尽きたあと、跡が stderr に1行残る（本文は出ない、issue #1085）', async () => {
    const stores = failingInboxPut(createMemoryStores(), '器が閉じている');
    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';

    const lines = await captureStderr(async () => {
      const { clone, inputs } = bootClone(stores);
      clone.post(humanMessage(secret));
      await waitFor(() => inputs.length > 0, '合図が処理に入る');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await clone.stop();
    });

    const trace = lines.filter((line) => line.includes('未読の合図をストアへ書けませんでした'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('器が閉じている');
    expect(trace[0]).toContain('器が入れ替われば');
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    expect(trace[0]).toContain(`chars=${secret.length}`);
  }, 10_000);

  it('消し込みが書き込みを追い越さない（追い越すと永久に配り直される）', async () => {
    const base = createMemoryStores();
    const written: string[] = [];
    const stores: Stores = {
      ...base,
      inbox: {
        ...base.inbox,
        put: async (event, at) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await base.inbox.put(event, at);
          written.push(event.id);
        },
      },
    };

    const { clone, inputs } = bootClone(stores);
    clone.post(report('速く終わる報告'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');
    await clone.stop();

    // 書き込みが器へ落ちるまで待ってから見る: 待たないと追い越しの跡がまだ現れず、壊れていても通るため
    await waitFor(() => written.length > 0, '未読の書き込みが終わる');
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('蒸留は器に置かない（拾い直しても対象のセッションはもう無い）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores);

    clone.post(humanMessage('やあ'));
    await waitFor(() => inputs.length > 0, '発言が処理に入る');
    await clone.endConversation('conv-1');
    await clone.stop();

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  // 二度載らないよう直さない: 受理の瞬間の追記が器へ届く前に落ちた発言が消える側へ倒れるため
  it('配り直しでは本文が二度載る（消えるより配り直す。回数は直す前と同じ）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(humanMessage('MSG-TWICE', 'conv-1'));
    await waitForJournal(stores, 'MSG-TWICE');
    expect(await inboundCount(stores, 'MSG-TWICE')).toBe(1);

    const reborn = bootClone(stores);
    await expect.poll(() => inboundCount(stores, 'MSG-TWICE'), { timeout: 3000 }).toBe(2);

    await reborn.clone.stop();
  });

  it('配り直しでも発言の本文が日誌に残る（受理の瞬間の追記が落ちていても）', async () => {
    const stores = createMemoryStores();

    await captureStderr(async () => {
      const dying = bootClone(droppingFirstJournalAppend(stores), 'hang');
      await idle();
      dying.clone.post(humanMessage('MSG-BODY', 'conv-1'));
      await waitFor(() => dying.inputs.length > 0, '発言が処理に入る');
      // `with: ['human']` で絞る: `#commit` 段1 の記録（`exchange with=self`）は独立した2本目の呼び出しで、普通に成功するため
      expect(await stores.journal.list({ types: ['exchange'], with: ['human'] })).toEqual([]);

      const reborn = bootClone(stores);
      await waitForJournal(stores, 'MSG-BODY');
      await reborn.clone.stop();
    });
  });
});

async function inboundCount(stores: Stores, text: string): Promise<number> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.filter(
    (entry) => entry.type === 'exchange' && entry.role === 'inbound' && entry.text === text,
  ).length;
}

// 全部は落とさない: 配り直しの側の追記も落ちて、直したことが見えなくなるため
function droppingFirstJournalAppend(stores: Stores): Stores {
  let first = true;
  return {
    ...stores,
    journal: {
      ...stores.journal,
      append(entry) {
        if (first) {
          first = false;
          return Promise.reject(new Error('器が閉じている'));
        }
        return stores.journal.append(entry);
      },
    },
  };
}

async function waitForJournal(stores: Stores, needle: string): Promise<void> {
  await waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange'] });
    return entries.some((entry) => entry.type === 'exchange' && entry.text.includes(needle));
  }, `日誌に「${needle}」が出る`);
}

async function waitForNoUnread(stores: Stores): Promise<void> {
  await waitFor(async () => (await stores.inbox.claimPending()).length === 0, '未読が消える');
}

async function waitForCommitment(stores: Stores, id: string): Promise<void> {
  await waitFor(async () => (await stores.commitments.get(id)) !== null, `台帳に ${id} が現れる`);
}

// `commitment_close` を呼ばせず台帳を直接閉じる: `fakeSdk` はツール呼び出しを再現しないため
describe('片付け済みの配り直し（ターンを起こさずに畳む）', () => {
  it('既に commitment_close で片付けていたら、ターンを1本も起こさない（本文も断り書きもモデルへ渡らない）', async () => {
    // 最初の1回分の日誌書き込みだけを落とす: 落とさないと dying が書いた全文で満たせてしまうため
    const base = createMemoryStores();
    let droppedFirstManagerExchange = false;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append(entry) {
          if (
            !droppedFirstManagerExchange &&
            entry.type === 'exchange' &&
            entry.with === 'manager' &&
            entry.role === 'inbound'
          ) {
            droppedFirstManagerExchange = true;
            return Promise.reject(new Error('最初の1回だけ落とす（検証のため）'));
          }
          return base.journal.append(entry);
        },
      },
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('CLOSED-REPORT 本文はこれだけ長くしておく', 'evt-closed'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-closed');

    expect(
      await stores.commitments.close(
        'evt-closed',
        '2026-08-02T00:00:00.000Z',
        'もう対応済み',
        'clone',
      ),
    ).toBe(true);

    const reborn = bootClone(stores);
    // 「畳んだ跡」を待つ形にしない: 畳まない側の壊れ方が待ちの時間切れとして出て、赤の出どころが自分のアサーションでなくなるため
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    expect(reborn.inputs).toEqual([]);

    expect(droppedFirstManagerExchange).toBe(true);
    const journal = await stores.journal.list({ types: ['exchange'] });
    const exchanges = journal.flatMap((entry) => (entry.type === 'exchange' ? [entry] : []));
    expect(
      exchanges.some(
        (entry) =>
          entry.role === 'inbound' &&
          entry.with === 'manager' &&
          entry.text.includes('CLOSED-REPORT 本文はこれだけ長くしておく'),
      ),
    ).toBe(true);

    const folded = exchanges.find((entry) => entry.text.includes('ターンを起こさずに畳んだ'));
    const foldedText = folded?.text ?? '';
    expect(foldedText).toContain('再起動後の配り直しである');
    expect(foldedText).toContain('片付けた時刻');
    expect(foldedText).toContain('2026-08-02T00:00:00.000Z');
    expect(foldedText).toContain('もう対応済み');
    expect(foldedText).toContain('journal_read');
    expect(foldedText).toContain('mgr-1');
    expect(
      exchanges.some((entry) => entry.text.includes('未読のまま残っていた合図を配り直した')),
    ).toBe(true);

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('human_message でも同じくターンを起こさない（配線は起点ごとに分かれているので `manager_message` だけでは足りない）', async () => {
    const stores = createMemoryStores();
    const text = 'CLOSED-HUMAN-MSG 本文はこれだけ長くしておく';
    const event = humanMessage(text);

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(event);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, event.id);

    expect(
      await stores.commitments.close(event.id, '2026-08-02T00:00:00.000Z', 'もう対応済み', 'clone'),
    ).toBe(true);

    const reborn = bootClone(stores);
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    expect(reborn.inputs).toEqual([]);
    const journal = await stores.journal.list({ types: ['exchange'] });
    const exchanges = journal.flatMap((entry) => (entry.type === 'exchange' ? [entry] : []));
    expect(exchanges.some((entry) => entry.with === 'human' && entry.text === text)).toBe(true);
    expect(exchanges.some((entry) => entry.text.includes('journal_read'))).toBe(true);
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('human で閉じていても同じくターンを1本も起こさず畳み、日誌には「人間が既にこの合図を片付けている」と載る', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(
      report('CLOSED-BY-HUMAN-REPORT 本文はこれだけ長くしておく', 'evt-closed-human'),
    );
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-closed-human');

    expect(
      await stores.commitments.close(
        'evt-closed-human',
        '2026-08-02T00:00:00.000Z',
        '人間が対応済みと判断した',
        'human',
      ),
    ).toBe(true);

    const reborn = bootClone(stores);
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    expect(reborn.inputs).toEqual([]);

    const journal = await stores.journal.list({ types: ['exchange'] });
    const exchanges = journal.flatMap((entry) => (entry.type === 'exchange' ? [entry] : []));
    const folded = exchanges.find((entry) => entry.text.includes('ターンを起こさずに畳んだ'));
    const foldedText = folded?.text ?? '';
    expect(foldedText).toContain('人間が既にこの合図を片付けている');
    expect(foldedText).toContain('片付けた時刻（POST /commitments/:id/close）');
    expect(foldedText).not.toContain('クローンは既にこの合図を片付けている');
    expect(foldedText).toContain('2026-08-02T00:00:00.000Z');
    expect(foldedText).toContain('人間が対応済みと判断した');

    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('external も畳むが、`external_event` の本文追記は落とさない（`journal_read` の案内が空を指さない）', async () => {
    const base = createMemoryStores();
    let droppedFirstExternal = false;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append(entry) {
          if (!droppedFirstExternal && entry.type === 'external_event') {
            droppedFirstExternal = true;
            return Promise.reject(new Error('最初の1回だけ落とす（検証のため）'));
          }
          return base.journal.append(entry);
        },
      },
    };
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-ext',
      at: '2026-08-01T00:00:00.000Z',
      source: 'github',
      payload: 'CLOSED-EXTERNAL 本文はこれだけ長くしておく',
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(event);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, event.id);
    expect(
      await stores.commitments.close(event.id, '2026-08-02T00:00:00.000Z', '対応済み', 'clone'),
    ).toBe(true);

    const reborn = bootClone(stores);
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    expect(reborn.inputs).toEqual([]);
    expect(droppedFirstExternal).toBe(true);
    const events = await stores.journal.list({ types: ['external_event'] });
    expect(
      events.some(
        (entry) =>
          entry.type === 'external_event' &&
          entry.source === 'github' &&
          entry.summary.includes('CLOSED-EXTERNAL 本文はこれだけ長くしておく'),
      ),
    ).toBe(true);
    expect(await stores.inbox.claimPending()).toEqual([]);
  });

  it('片付け済みの配り直しを畳むとき、本文（journalIncomingBody）→「畳んだ」の1行、の順で journal.append が呼ばれる（characterization。Issue #1744）', async () => {
    const base = createMemoryStores();
    const order: string[] = [];
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          if (entry.type === 'external_event') order.push('body');
          else if (
            entry.type === 'exchange' &&
            entry.text.includes('片付け済みの配り直しなので、ターンを起こさずに畳んだ')
          ) {
            order.push('folded-line');
          }
          return base.journal.append(entry);
        },
      },
    };

    const event: InboxEvent = {
      type: 'external',
      id: 'evt-fold-order',
      at: '2026-08-01T00:00:00.000Z',
      source: 'github',
      payload: '畳む順序を確かめるための本文',
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(event);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, event.id);
    expect(
      await stores.commitments.close(event.id, '2026-08-02T00:00:00.000Z', '対応済み', 'clone'),
    ).toBe(true);

    order.length = 0;

    const reborn = bootClone(stores);
    await waitForNoUnread(stores);
    await reborn.clone.stop();

    expect(order).toEqual(['body', 'folded-line']);
  });

  it('未了（クローンがまだ片付けていない）合図の配り直しは、1文字も変えず全文のままターンへ届く（畳まない）', async () => {
    const stores = createMemoryStores();

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('OPEN-REPORT 本文はこれだけ長くしておく', 'evt-open'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-open');

    const reborn = bootClone(stores);
    // 「入力が来ること」を待つ形にしない: 誤って畳んだ壊れ方が待ちの時間切れとして出て、赤の出どころが自分のアサーションでなくなるため
    await waitForNoUnread(stores);

    // 数えるのは `stop()` の前: `stop()` はセッションが在れば shutdown の蒸留を投げ、後で数えると2本目が混じるため
    expect(reborn.inputs).toHaveLength(1);
    const prompt = reborn.inputs[0] ?? '';
    expect(prompt).toContain('OPEN-REPORT 本文はこれだけ長くしておく');
    expect(prompt).not.toContain('クローンは既にこの合図を片付けている');
    const journal = await stores.journal.list({ types: ['exchange'] });
    expect(
      journal.some(
        (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
      ),
    ).toBe(false);

    await reborn.clone.stop();
  });

  it('片付き確認（commitments.get）が失敗しても全文で配る。ターンは落ちない（雑音であって喪失ではない側へ倒す）', async () => {
    const base = createMemoryStores();
    let failNextGet = false;
    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        get: (id: string) => {
          if (failNextGet) return Promise.reject(new Error('台帳が読めない'));
          return base.commitments.get(id);
        },
      },
    };

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report('THROW-REPORT 本文はこれだけ長くしておく', 'evt-throw'));
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitForCommitment(stores, 'evt-throw');
    expect(
      await stores.commitments.close('evt-throw', new Date().toISOString(), '片付けた', 'clone'),
    ).toBe(true);

    failNextGet = true;
    const lines = await captureStderr(async () => {
      const reborn = bootClone(stores);
      await waitFor(() => reborn.inputs.length > 0, '拾い直した合図が処理に入る');

      const prompt = reborn.inputs[0] ?? '';
      expect(prompt).toContain('THROW-REPORT 本文はこれだけ長くしておく');

      await reborn.clone.stop();
    });
    expect(lines.some((line) => line.includes('配り直しの片付き確認'))).toBe(true);
  });
});

describe('redeliveryGate（Issue #783 続き）: `#restoreUnread` の門', () => {
  it('述語が偽を返しても、受信箱の行も台帳の行も消えない（次の起動でまた配り直しの対象になる）', async () => {
    const stores = createMemoryStores();
    const event = externalNotice('GATED-NOTICE 本文はこれだけ長くしておく', 'evt-gated');
    await stores.inbox.put(event, event.at);

    const alwaysFold: RedeliveryGate = () => false;
    const { clone, inputs } = bootClone(stores, 'reply', alwaysFold);
    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    expect(inputs).toEqual([]);

    const remaining = (await stores.inbox.peekPending()).entries;
    expect(remaining.some((r) => r.event.id === event.id)).toBe(true);

    await waitForCommitment(stores, event.id);
    const commitment = await stores.commitments.get(event.id);
    expect(commitment).not.toBeNull();
    expect(commitment?.closedAt).toBeUndefined();

    await clone.stop();
  });

  it('畳んだ跡が日誌に残る（型ごとの本文追記と「畳んだ」の1行の両方）', async () => {
    const stores = createMemoryStores();
    const event = externalNotice('GATED-NOTICE-2 本文はこれだけ長くしておく', 'evt-gated-2');
    await stores.inbox.put(event, event.at);

    const alwaysFold: RedeliveryGate = () => false;
    const { clone } = bootClone(stores, 'reply', alwaysFold);
    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    const externalEvents = await stores.journal.list({ types: ['external_event'] });
    expect(
      externalEvents.some(
        (entry) =>
          entry.type === 'external_event' &&
          entry.source === 'redelivery-gate-probe' &&
          entry.summary.includes('GATED-NOTICE-2 本文はこれだけ長くしておく'),
      ),
    ).toBe(true);

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const folded = exchanges.find(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
    );
    const foldedText = folded && folded.type === 'exchange' ? folded.text : '';
    expect(foldedText).toContain('配り直しの門がいま配る意味は無いと答えた');
    expect(foldedText).toContain('モデルへは1文字も渡していない');
    expect(foldedText).toContain('合図も台帳の行も消していない');

    await clone.stop();
  });

  describe('N件の gated な未読を一括で拾い直すときの「畳んだ」の畳み方', () => {
    it('「畳んだ」行は1本だけである（N本でもN+1本でもない）', async () => {
      const stores = createMemoryStores();
      const ids = ['evt-gatefold-a', 'evt-gatefold-b', 'evt-gatefold-c'];
      for (const [i, id] of ids.entries()) {
        const at = `2026-08-10T00:00:0${i}.000Z`;
        await stores.inbox.put(report(`門畳みテスト ${i}`, id), at);
      }

      const alwaysFold: RedeliveryGate = () => false;
      const { clone } = bootClone(stores, 'reply', alwaysFold);
      await waitForJournal(stores, '門畳みテスト 2');

      const exchanges = await stores.journal.list({ types: ['exchange'] });
      const matches = exchanges.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.with === 'self' &&
          entry.text.includes('ターンを起こさずに畳んだ'),
      );
      expect(matches.length).toBe(1);

      await clone.stop();
    });

    it('その1本から、N件それぞれの合図の形・畳んだ理由・件数のどれも失われていない', async () => {
      const stores = createMemoryStores();
      const items = [
        { id: 'evt-gatefold-detail-a', text: 'A'.repeat(5), at: '2026-08-10T01:00:00.000Z' },
        { id: 'evt-gatefold-detail-b', text: 'B'.repeat(9), at: '2026-08-10T01:00:01.000Z' },
        { id: 'evt-gatefold-detail-c', text: 'C'.repeat(13), at: '2026-08-10T01:00:02.000Z' },
      ];
      for (const item of items) {
        await stores.inbox.put(report(item.text, item.id), item.at);
      }

      const alwaysFold: RedeliveryGate = () => false;
      const { clone } = bootClone(stores, 'reply', alwaysFold);
      await waitForJournal(stores, `chars=${items[2]?.text.length}`);

      const exchanges = await stores.journal.list({ types: ['exchange'] });
      const folded = exchanges.find(
        (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
      );
      const text = folded && folded.type === 'exchange' ? folded.text : '';

      expect(text).toContain('まとめて3件');
      for (const item of items) {
        expect(text).toContain(`chars=${item.text.length}`);
      }
      expect(text).toContain('[1]');
      expect(text).toContain('[2]');
      expect(text).toContain('[3]');
      expect(text).toContain('配り直しの門がいま配る意味は無いと答えた');
      expect(text).toContain('モデルへは1文字も渡していない');
      expect(text).toContain('合図も台帳の行も消していない');
      expect(text).toContain('次の起動でまた拾い直され');

      const bodies = exchanges.filter(
        (entry) =>
          entry.type === 'exchange' && entry.with === 'manager' && entry.role === 'inbound',
      );
      expect(bodies.length).toBe(3);

      await clone.stop();
    });
  });

  it('述語を渡さなければ、フォールドされそうな形の合図も含めて全件配られる（既定の挙動を1文字も変えない）', async () => {
    const stores = createMemoryStores();
    const a = externalNotice(
      'WOULD-BE-GATED-IF-CONFIGURED',
      'evt-nogate-a',
      '2026-08-01T00:00:00.000Z',
    );
    const b = externalNotice('SECOND-EVENT-BODY', 'evt-nogate-b', '2026-08-01T00:00:01.000Z');
    await stores.inbox.put(a, a.at);
    await stores.inbox.put(b, b.at);

    const { clone, inputs } = bootClone(stores, 'reply');

    await waitFor(() => inputs.some((i) => i.includes('SECOND-EVENT-BODY')), '2件目まで処理に入る');
    expect(inputs.some((i) => i.includes('WOULD-BE-GATED-IF-CONFIGURED'))).toBe(true);

    await waitForNoUnread(stores);
    await clone.stop();
  });

  it('述語が投げても、配る側へ倒れて全文でターンが起きる（判定できないのは雑音であって喪失ではない）', async () => {
    const stores = createMemoryStores();
    const event = externalNotice('THROW-GATE-NOTICE 本文はこれだけ長くしておく', 'evt-throw-gate');
    await stores.inbox.put(event, event.at);

    const throwingGate: RedeliveryGate = () => {
      throw new Error('判定できない（テスト用）');
    };

    const lines = await captureStderr(async () => {
      const { clone, inputs } = bootClone(stores, 'reply', throwingGate);
      await waitFor(
        () => inputs.some((i) => i.includes('THROW-GATE-NOTICE')),
        '配る側へ倒れて処理に入る',
      );
      await clone.stop();
    });

    expect(lines.some((line) => line.includes('配り直しの門の判定'))).toBe(true);
  });

  it('畳まれた合図はモデルへ1文字も渡らない（配られる合図と混在させて確かめる）', async () => {
    const stores = createMemoryStores();
    const folded = externalNotice(
      'FOLDED-UNIQUE-PAYLOAD',
      'evt-mix-fold',
      '2026-08-01T00:00:00.000Z',
    );
    const delivered = externalNotice(
      'DELIVERED-UNIQUE-PAYLOAD',
      'evt-mix-deliver',
      '2026-08-01T00:00:01.000Z',
    );
    await stores.inbox.put(folded, folded.at);
    await stores.inbox.put(delivered, delivered.at);

    const gate: RedeliveryGate = (event) => event.id !== folded.id;
    const { clone, inputs } = bootClone(stores, 'reply', gate);

    await waitFor(
      () => inputs.some((i) => i.includes('DELIVERED-UNIQUE-PAYLOAD')),
      '配られる側が処理に入る',
    );
    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    expect(inputs.some((i) => i.includes('DELIVERED-UNIQUE-PAYLOAD'))).toBe(true);
    expect(inputs.join('')).not.toContain('FOLDED-UNIQUE-PAYLOAD');

    await clone.stop();
  });
});

describe('redeliveryGate（Issue #783 続き）: 配り直すその瞬間の usageBlocked で評価する', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  function fakeSdkWithResultFor(
    resultFor: (turnIndex: number) => { subtype: string; text: string } | undefined,
  ): Fake {
    const inputs: string[] = [];
    let turnIndex = 0;
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
          const override = resultFor(turnIndex);
          turnIndex += 1;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: override?.subtype ?? 'success',
            result: override?.text ?? 'ok',
            session_id: 'sess-fake',
            uuid: 'uuid-result',
          } as unknown as SDKMessage;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, inputs };
  }

  it('ループの途中で usageBlocked が変わると、同じ起動の中で前半と後半で扱いが変わる（ループの外で1回だけ評価する実装だと赤くなる）', async () => {
    const base = createMemoryStores();
    const first = externalNotice(
      'FIRST-GATE-TIMING',
      'evt-timing-first',
      '2026-08-01T00:00:00.000Z',
    );
    const second = externalNotice(
      'SECOND-GATE-TIMING',
      'evt-timing-second',
      '2026-08-01T00:00:01.000Z',
    );
    await base.inbox.put(first, first.at);
    await base.inbox.put(second, second.at);

    const stores: Stores = {
      ...base,
      commitments: {
        ...base.commitments,
        async get(id) {
          if (id === second.id) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return base.commitments.get(id);
        },
      },
    };

    const { fn, inputs } = fakeSdkWithResultFor((turnIndex) =>
      turnIndex === 0 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    );

    const gate: RedeliveryGate = (_event, { usageBlocked }) => !usageBlocked;

    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      redeliveryGate: gate,
    });

    await waitFor(() => inputs.some((i) => i.includes('FIRST-GATE-TIMING')), '1件目が処理に入る');

    await waitForJournal(stores, 'ターンを起こさずに畳んだ');

    expect(inputs.some((i) => i.includes('FIRST-GATE-TIMING'))).toBe(true);
    expect(inputs.join('')).not.toContain('SECOND-GATE-TIMING');

    const journal = await stores.journal.list({ types: ['exchange'] });
    const foldedCount = journal.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
    ).length;
    expect(foldedCount).toBe(1);

    await clone.stop();
  });
});

async function waitForAbsentFromPending(stores: Stores, id: string): Promise<void> {
  await waitFor(async () => {
    const remaining = (await stores.inbox.peekPending()).entries;
    return !remaining.some((r) => r.event.id === id);
  }, `${id} が受信箱から消える`);
}

describe('拾い直した token-pool の合図の消し込み（Issue #783 段1）', () => {
  it('token-pool の合図は起動時に受信箱から消え、日誌には本文追記と「消した」の1行が両方残り、モデルへは1文字も渡らない', async () => {
    const stores = createMemoryStores();
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-token-pool-stale',
      at: '2026-08-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: 'TOKEN-POOL-STALE-PAYLOAD',
    };
    await stores.inbox.put(event, event.at);

    const { clone, inputs } = bootClone(stores, 'reply');
    await waitForJournal(stores, 'ターンを起こさずに消した');
    await waitForAbsentFromPending(stores, event.id);

    const externalEvents = await stores.journal.list({ types: ['external_event'] });
    expect(
      externalEvents.some(
        (entry) =>
          entry.type === 'external_event' &&
          entry.source === DAEMON_TOKEN_POOL_REOPENED_SOURCE &&
          entry.summary.includes('TOKEN-POOL-STALE-PAYLOAD'),
      ),
    ).toBe(true);

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const dropped = exchanges.find(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに消した'),
    );
    const droppedText = dropped && dropped.type === 'exchange' ? dropped.text : '';
    expect(droppedText).toContain('モデルへは1文字も渡していない');

    expect(inputs).toEqual([]);
    expect(inputs.join('')).not.toContain('TOKEN-POOL-STALE-PAYLOAD');

    await clone.stop();
  });

  it('同じ起動の中で token-pool だけが消え、runner-registry と自由文字列の external は受信箱に残る（門は常に畳む設定に固定——門の気分ではなく合図の性質で決めていることの確認）', async () => {
    const stores = createMemoryStores();
    const tokenPool: InboxEvent = {
      type: 'external',
      id: 'evt-mix-token-pool',
      at: '2026-08-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: 'MIX-TOKEN-POOL-PAYLOAD',
    };
    const runnerRegistry: InboxEvent = {
      type: 'external',
      id: 'evt-mix-runner-registry',
      at: '2026-08-01T00:00:01.000Z',
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
      payload: 'MIX-RUNNER-REGISTRY-PAYLOAD',
    };
    const freeform: InboxEvent = {
      type: 'external',
      id: 'evt-mix-freeform',
      at: '2026-08-01T00:00:02.000Z',
      source: 'webhook-from-somewhere-outside',
      payload: 'MIX-FREEFORM-PAYLOAD',
    };
    await stores.inbox.put(tokenPool, tokenPool.at);
    await stores.inbox.put(runnerRegistry, runnerRegistry.at);
    await stores.inbox.put(freeform, freeform.at);

    const alwaysFold: RedeliveryGate = () => false;
    const { clone, inputs } = bootClone(stores, 'reply', alwaysFold);

    await waitForAbsentFromPending(stores, tokenPool.id);
    await waitForJournal(stores, 'まとめて2件');

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const folded = exchanges.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに畳んだ'),
    );
    expect(folded).toHaveLength(1);
    const foldedText = folded[0] && folded[0].type === 'exchange' ? folded[0].text : '';
    expect(foldedText).toContain(`source.chars=${DAEMON_RUNNER_REGISTRY_SOURCE.length}`);
    expect(foldedText).toContain(`source.chars=${'webhook-from-somewhere-outside'.length}`);

    const remaining = (await stores.inbox.peekPending()).entries;
    const remainingIds = remaining.map((r) => r.event.id);
    expect(remainingIds).not.toContain(tokenPool.id);
    expect(remainingIds).toContain(runnerRegistry.id);
    expect(remainingIds).toContain(freeform.id);

    expect(inputs).toEqual([]);

    await clone.stop();
  });

  it('redeliveryGate を省略した既定のクローンでも token-pool の合図は消える（消し込みは門の設定と独立である）', async () => {
    const stores = createMemoryStores();
    const event: InboxEvent = {
      type: 'external',
      id: 'evt-token-pool-no-gate',
      at: '2026-08-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: 'NO-GATE-TOKEN-POOL-PAYLOAD',
    };
    await stores.inbox.put(event, event.at);

    const { clone, inputs } = bootClone(stores, 'reply');
    await waitForJournal(stores, 'ターンを起こさずに消した');
    await waitForAbsentFromPending(stores, event.id);

    expect(inputs).toEqual([]);

    await clone.stop();
  });
});

describe('InboxStore.pending（#358。読むだけで配達回数を進めない）', () => {
  it('件数といちばん古い時刻を返す（0件のときは oldestAt を作らない）', async () => {
    const stores = createMemoryStores();
    expect(await stores.inbox.pending()).toEqual({ count: 0 });

    await stores.inbox.put(report('2件目', 'evt-2'), '2026-08-11T00:00:00.000Z');
    await stores.inbox.put(report('1件目', 'evt-1'), '2026-08-10T00:00:00.000Z');

    expect(await stores.inbox.pending()).toEqual({
      count: 2,
      oldestAt: '2026-08-10T00:00:00.000Z',
    });
  });

  it('pending() を何度呼んでも claimPending() の deliveries は動かない', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(report('本文', 'evt-1'), '2026-08-10T00:00:00.000Z');

    await stores.inbox.pending();
    await stores.inbox.pending();
    await stores.inbox.pending();

    const claimed = await stores.inbox.claimPending();
    expect(claimed[0]?.deliveries).toBe(1);
  });
});

describe('manager_message.statusAtDelivery は #restoreUnread を通っても積まれた当時の値のまま残る（issue #879）', () => {
  // `statusAtDelivery` を配り直すたびに「いま」の状態へ差し替えない: `inboxEventValidity` が差を見つけられず、黙って `unchanged` 側へ倒れ続けるため
  it('起動前に stores.inbox へ直に積んだ statusAtDelivery は、#restoreUnread が拾い直した後も変わらない', async () => {
    const stores = createMemoryStores();
    const claimedStatus: JobStatus = 'running';
    const event: InboxEvent = {
      type: 'manager_message',
      id: 'evt-status-at-delivery',
      at: '2026-08-01T00:00:00.000Z',
      managerId: 'mgr-1',
      kind: 'report',
      text: '終わった',
      statusAtDelivery: claimedStatus,
    };
    await stores.inbox.put(event, event.at);

    // `hang` の clone は `.stop()` を呼ばない: 未完のターンの決着を待ち続けて戻らないため
    const { inputs } = bootClone(stores, 'hang');
    await waitFor(() => inputs.length > 0, '#restoreUnread が拾い直した合図が処理に入る');

    const pending = (await stores.inbox.peekPending()).entries;
    const restored = pending.find((row) => row.event.id === event.id);
    const restoredClaim =
      restored?.event.type === 'manager_message' ? restored.event.statusAtDelivery : undefined;

    expect(
      restoredClaim,
      'statusAtDelivery が claimedStatus と違う（＝ #restoreUnread がこの欄を書き換えた）。' +
        ' inbox-validity.ts の inboxEventValidity は「積まれた当時の値が動かないこと」を' +
        ' 前提に組んである — この欄を新しい値へ差し替える直しは、その述語が差を1件も' +
        ' 見つけられなくなる形で#879を黙って無力化する。直すなら inbox-validity.ts の' +
        ' 述語（と inbox-validity.test.ts）も一緒に設計し直すこと。',
    ).toBe(claimedStatus);
  });
});

async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  label: string,
): Promise<void> {
  await waitFor(predicate, label);
}

describe('受信箱の畳み込み（Issue #954 続き。inboxCollapseKey / #foldIntoPendingCollapse）', () => {
  it('429 の再現: 同一マネージャー×同一本文の manager_message を3連投しても、受信箱の未読は1件・台帳も1件のまま', async () => {
    const stores = createMemoryStores();
    const { clone } = bootClone(stores, 'hang');
    await idle();

    const body = "You've hit your session limit · resets 5:10pm (UTC)";
    // 3連投の間に `await` を挟まない: 挟むと、実装ではなくテストの都合で畳み込みの窓が閉じてしまうため
    clone.post(report(body, 'evt-429-1'));
    clone.post(report(body, 'evt-429-2'));
    clone.post(report(body, 'evt-429-3'));

    await waitForCommitment(stores, 'evt-429-1');

    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-429-1');

    const open = (await stores.commitments.list()).entries;
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe('evt-429-1');
  });

  it('token-pool の再現: 同一 payload の external（source: token-pool）を3連投しても、受信箱の未読は1件', async () => {
    const stores = createMemoryStores();
    const { clone } = bootClone(stores, 'hang');
    await idle();

    const tokenPoolNotice = (id: string): InboxEvent => ({
      type: 'external',
      id,
      at: '2026-09-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
      payload: { text: '枠が開いた' },
    });
    clone.post(tokenPoolNotice('evt-tp-1'));
    clone.post(tokenPoolNotice('evt-tp-2'));
    clone.post(tokenPoolNotice('evt-tp-3'));

    await waitForCondition(
      async () => (await stores.inbox.peekPending()).entries.some((r) => r.event.id === 'evt-tp-1'),
      '代表（1件目）が受信箱に残る',
    );
    await idle();

    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-tp-1');
  });

  it('陰性対照: external（source: webhook。デーモン自身の合図ではない）の同文3連投は畳まない（3件とも残る）', async () => {
    const stores = createMemoryStores();
    const { clone } = bootClone(stores, 'hang');
    await idle();

    const webhookNotice = (id: string): InboxEvent => ({
      type: 'external',
      id,
      at: '2026-09-01T00:00:00.000Z',
      source: 'webhook',
      payload: { text: '外から届いた同文' },
    });
    clone.post(webhookNotice('evt-wh-1'));
    clone.post(webhookNotice('evt-wh-2'));
    clone.post(webhookNotice('evt-wh-3'));

    await waitForCondition(
      async () => (await stores.inbox.peekPending()).entries.length === 3,
      '3件とも受信箱に残る',
    );

    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending.map((r) => r.event.id).sort()).toEqual(['evt-wh-1', 'evt-wh-2', 'evt-wh-3']);
  });

  it('陰性対照: human_message の同文2連投は畳まない（2件とも残る）', async () => {
    const stores = createMemoryStores();
    const { clone } = bootClone(stores, 'hang');
    await idle();

    // `humanMessage()` を同文2連投に使わない: id まで衝突し、`stores.inbox.put` の上書きが畳み込みのように見えてしまうため
    const at = new Date().toISOString();
    clone.post({
      type: 'human_message',
      id: 'evt-human-1',
      at,
      text: '同じ発言',
      conversationId: 'conv-1',
    });
    clone.post({
      type: 'human_message',
      id: 'evt-human-2',
      at,
      text: '同じ発言',
      conversationId: 'conv-1',
    });

    await waitForCondition(
      async () => (await stores.inbox.peekPending()).entries.length === 2,
      '2件とも受信箱に残る',
    );
  });

  it('陰性対照: manager_message は managerId が違えば畳まない（2件とも残る）', async () => {
    const stores = createMemoryStores();
    const { clone } = bootClone(stores, 'hang');
    await idle();

    const body = '同じ本文';
    const at = new Date(0).toISOString();
    clone.post({
      type: 'manager_message',
      id: 'evt-mgr-a',
      at,
      managerId: 'mgr-a',
      kind: 'report',
      text: body,
    });
    clone.post({
      type: 'manager_message',
      id: 'evt-mgr-b',
      at,
      managerId: 'mgr-b',
      kind: 'report',
      text: body,
    });

    await waitForCondition(
      async () => (await stores.inbox.peekPending()).entries.length === 2,
      '2件とも受信箱に残る',
    );
  });

  it('陰性対照: manager_message は本文が違えば畳まない（2件とも残る）', async () => {
    const stores = createMemoryStores();
    const { clone } = bootClone(stores, 'hang');
    await idle();

    clone.post(report('本文A', 'evt-text-a'));
    clone.post(report('本文B', 'evt-text-b'));

    await waitForCondition(
      async () => (await stores.inbox.peekPending()).entries.length === 2,
      '2件とも受信箱に残る',
    );
  });

  it('日誌は畳まない: 3連投しても、生の本文は日誌に3件ぶん残る（429の文言を1文字も失わない）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs } = bootClone(stores, 'hang');
    await idle();

    const body = "You've hit your session limit · resets 5:10pm (UTC)";
    clone.post(report(body, 'evt-j-1'));
    clone.post(report(body, 'evt-j-2'));
    clone.post(report(body, 'evt-j-3'));

    await waitFor(() => inputs.length > 0, '代表がターンへ渡る');

    async function bodyCount(): Promise<number> {
      const exchanges = await stores.journal.list({ types: ['exchange'] });
      return exchanges.filter(
        (entry) =>
          entry.type === 'exchange' && entry.with === 'manager' && entry.text.includes(body),
      ).length;
    }

    await waitForCondition(async () => (await bodyCount()) >= 3, '日誌に3件ぶんの本文が残る');

    expect(await bodyCount()).toBe(3);
    // 受信箱が1件のままであることも見る: 別の束ね経路でも `bodyCount() === 3` は満たされ、畳み込みを固有に測れないため
    expect((await stores.inbox.peekPending()).entries).toHaveLength(1);
  });

  it('⭐ 鍵が落ちること: 代表が片付いて受信箱から消えたあと、同じ本文がもう1件届けば新しく1件積まれる（畳み込みが「二度と受け取らない」になっていないことの歯）', async () => {
    const stores = createMemoryStores();
    // `hang` ではなく `reply` で起こす: `hang` では代表が永遠に片付かず、`#forget` が走らないため
    const { clone, inputs } = bootClone(stores, 'reply');
    await idle();

    const body = '片付いたあとにもう一度届く本文';
    clone.post(report(body, 'evt-drop-1'));
    await waitFor(() => inputs.length > 0, '1件目がターンへ渡る');
    await waitForNoUnread(stores);

    clone.post(report(body, 'evt-drop-2'));
    await waitForCondition(
      async () =>
        (await stores.inbox.peekPending()).entries.some((r) => r.event.id === 'evt-drop-2'),
      '2件目が新しく受信箱に積まれる',
    );

    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-drop-2');

    await clone.stop();
  });

  it('器の入れ替えを跨いでも畳む: 未読が残った状態で Clone を作り直しても（#restoreUnread が索引を作り直す）、同じ本文が来れば畳まれる', async () => {
    const stores = createMemoryStores();
    const body = '器の入れ替えを跨ぐ本文';

    const dying = bootClone(stores, 'hang');
    await idle();
    dying.clone.post(report(body, 'evt-cross-1'));
    await waitForCondition(
      async () => (await stores.inbox.peekPending()).entries.length === 1,
      '1件目が受信箱に残る',
    );

    // `hang` で起こす: `reply` だと拾い直した1件目がすぐ片付いて鍵が落ち、索引の再構築ではなく「鍵が落ちる」歯と同じものを測ることになるため
    const reborn = bootClone(stores, 'hang');
    await waitFor(() => reborn.inputs.length > 0, '#restoreUnread が拾い直した合図が処理に入る');

    reborn.clone.post(report(body, 'evt-cross-2'));
    await idle();

    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-cross-1');
  });

  it('停止中の枝でも畳む: stop() 後に同文が2件届いても、受信箱の行は1件しか増えない', async () => {
    const stores = createMemoryStores();
    const { clone } = bootClone(stores, 'reply');
    await clone.stop();

    const body = '停止中に届いた同文';
    clone.post(report(body, 'evt-stopped-1'));
    clone.post(report(body, 'evt-stopped-2'));

    await idle();
    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe('evt-stopped-1');
  });
});

describe('消した合図は配達されない（issue #1049）', () => {
  it('既に待ち行列へ載った合図でも、器から消して配達を止めれば、モデルには届かない', async () => {
    const stores = createMemoryStores();
    const { clone, inputs, release } = bootGatedClone(stores);

    clone.post(report('先客', 'evt-blocker'));
    await waitFor(() => inputs.length > 0, '1件目が処理に入る');

    clone.post(report('消される報告', 'evt-doomed'));
    clone.post(report('残る報告', 'evt-kept'));
    await idle();

    const removed = await stores.inbox.removeMany(['evt-doomed']);
    expect(removed).toEqual(['evt-doomed']);
    expect(await clone.dropQueuedInboxEvents(removed)).toBe(1);

    release();
    await waitFor(() => inputs.some((t) => t.includes('残る報告')), '後続が配達される');
    await idle();

    expect(inputs.some((t) => t.includes('先客'))).toBe(true);
    expect(inputs.some((t) => t.includes('残る報告'))).toBe(true);
    expect(inputs.some((t) => t.includes('消される報告'))).toBe(false);

    await clone.stop();
  });

  it('消していない合図は配達され続ける（消す口が配達を止めすぎていないことの対照）', async () => {
    const stores = createMemoryStores();
    const { clone, inputs, release } = bootGatedClone(stores);

    clone.post(report('先客', 'evt-blocker'));
    await waitFor(() => inputs.length > 0, '1件目が処理に入る');
    clone.post(report('無関係な報告', 'evt-other'));
    await idle();

    expect(await clone.dropQueuedInboxEvents(['evt-not-here'])).toBe(0);

    release();
    await waitFor(() => inputs.some((t) => t.includes('無関係な報告')), '後続が配達される');

    await clone.stop();
  });

  it('拾い直しの最中に消された合図は、待ち行列へ積まれない（器の入れ替えを跨いだ経路）', async () => {
    const stores = createMemoryStores();
    for (const id of ['evt-r1', 'evt-r2', 'evt-r3']) {
      const event = report(`拾い直し ${id}`, id);
      await stores.inbox.put(event, event.at);
    }

    let releaseJournal!: () => void;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    let gated = false;
    const inner = stores.journal.append.bind(stores.journal);
    const gatedStores: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        async append(entry) {
          if (!gated) {
            gated = true;
            await journalGate;
          }
          return inner(entry);
        },
      },
    };

    const fake = gatedSdk();
    const clone = createClone({
      stores: gatedStores,
      queryFn: fake.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      redeliveryGate: ALWAYS_REDELIVER,
    });

    await waitFor(() => gated, '拾い直しが1件目の日誌で止まる');

    const removed = await stores.inbox.removeMany(['evt-r3']);
    expect(removed).toEqual(['evt-r3']);
    await clone.dropQueuedInboxEvents(removed);

    releaseJournal();
    fake.release();
    await waitFor(() => fake.inputs.some((t) => t.includes('拾い直し evt-r2')), '残りが配達される');
    await idle();

    expect(fake.inputs.some((t) => t.includes('拾い直し evt-r1'))).toBe(true);
    expect(fake.inputs.some((t) => t.includes('拾い直し evt-r2'))).toBe(true);
    expect(fake.inputs.some((t) => t.includes('拾い直し evt-r3'))).toBe(false);

    await clone.stop();
  });
});

function usageLimitedFirstTurnSdk(): Fake {
  const inputs: string[] = [];
  let turn = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        const limited = turn === 0;
        turn += 1;
        if (limited) {
          yield {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
            session_id: 'sess-fake',
            uuid: 'uuid-ratelimit',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            result: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
            session_id: 'sess-fake',
            uuid: 'uuid-result-limited',
          } as unknown as SDKMessage;
          continue;
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

describe('枠で保持している合図も落とす（issue #1049。#deferred の経路）', () => {
  it('枠で保持されているあいだに消された合図は、解除されても配達されない', async () => {
    const stores = createMemoryStores();
    const fake = usageLimitedFirstTurnSdk();
    const clone = createClone({
      stores,
      queryFn: fake.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(report('枠で保持される報告', 'evt-held'));
    await waitFor(() => fake.inputs.length > 0, '1件目が処理に入る');
    await waitFor(() => clone.usageBlocked, '枠が閉じる');

    const before = fake.inputs.length;

    const removed = await stores.inbox.removeMany(['evt-held']);
    expect(removed).toEqual(['evt-held']);
    expect(await clone.dropQueuedInboxEvents(removed)).toBe(1);

    clone.post(report('解除を起こす報告', 'evt-trigger'));
    await waitFor(
      () => fake.inputs.slice(before).some((t) => t.includes('解除を起こす報告')),
      '解除後の合図が配達される',
    );
    await idle();

    expect(fake.inputs.slice(before).some((t) => t.includes('枠で保持される報告'))).toBe(false);

    await clone.stop();
  });
});
