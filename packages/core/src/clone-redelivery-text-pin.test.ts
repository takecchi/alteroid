import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Clone` の private メソッド `#redeliveredLiveHeadline`（日誌の見出し）と `#redeliveryNoticeFor`（ターンの入力に添える断り書き）の出力を、`createClone` 経由で逐語に固定する。
// 期待の文字列は仕様を先に書いたものではない: 今の作りの出力を `vitest -u` で生成し、目で読んで確かめたものを置いている。「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 文面の枝（1件か束か・`alone` か・配達回数）は、`#restoredCohort`（同じ起動で拾い直した件数＝`claimPending` の総数。stale も数える）と `redeliveryState` の記録で決まる。
// `#restoredCohort` が 0 の枝は、この経路では観測できない: 0 件なら配り直しの記録が1件も作られず、どちらのメソッドにも呼ばれない。境目は 1（alone）と 2（alone でない）で固定する。

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(): Fake {
  const inputs: string[] = [];
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

function bootClone(stores: Stores, reportSettleMs = 0): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { ...fake, clone };
}

function report(id: string, text: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: '2026-08-01T00:00:00.000Z',
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

function staleTokenPool(id: string): InboxEvent {
  return {
    type: 'external',
    id,
    at: '2026-08-01T00:00:00.000Z',
    source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    payload: { note: 'stale' },
  };
}

const NOTICE_START = '[system] **これは配り直し';
const NOTICE_END = '\n---\n';
// `[復旧]` の行だけを見る: stale を消す側の行（`#dropStaleRedelivery`）も同じ語を含むが、そちらは別の文面で、この試験の対象ではない
const HEADLINE_MARK = '[復旧] 未読のまま残っていた合図を配り直した';

/** 入力のうち断り書きの部分だけを取り出す（断り書きが無ければ空文字）。 */
function noticeOf(prompt: string): string {
  const start = prompt.indexOf(NOTICE_START);
  if (start < 0) return '';
  const end = prompt.indexOf(NOTICE_END, start);
  return prompt.slice(start, end + NOTICE_END.length);
}

async function headlinesOf(stores: Stores): Promise<string[]> {
  const journal = await stores.journal.list({ types: ['exchange'] });
  return journal.flatMap((entry) =>
    entry.type === 'exchange' && entry.text.includes(HEADLINE_MARK) ? [entry.text] : [],
  );
}

describe('配り直しの文面（#redeliveryNoticeFor・#redeliveredLiveHeadline）の逐語固定', () => {
  it('1件・同じ起動の未読が1件・1回目の配達（alone）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(report('evt-a', '本文A'), '2026-08-01T10:00:00.000Z');

    const { clone, inputs } = bootClone(stores);
    await waitFor(() => inputs.length > 0, '拾い直した合図が処理に入る');

    expect(noticeOf(inputs[0] ?? '')).toMatchInlineSnapshot(`
      "[system] **これは配り直しである（1 回目の配達）。**2026-08-01T10:00:00.000Z に受け取ったまま、処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。
      同じ内容に既に応答しているかもしれない。日誌（\`journal_read\`）と \`manager_list\` を見て、同じ仕事を二度起こさないこと。

      ---
      "
    `);
    expect(await headlinesOf(stores)).toMatchInlineSnapshot(`
      [
        "[復旧] 未読のまま残っていた合図を配り直した（1回目の配達、2026-08-01T10:00:00.000Z に受け取ったもの）: manager_message managerId=mgr-1 kind=report chars=3",
      ]
    `);

    await clone.stop();
  });

  it('1件・同じ起動の未読が1件・2回目の配達（alone で、この合図の処理そのものが落ちている可能性）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(report('evt-a', '本文A'), '2026-08-01T10:00:00.000Z');
    // 前の器が拾い直しただけで落ちたことにする: `claimPending` が配達回数を進める
    await stores.inbox.claimPending();

    const { clone, inputs } = bootClone(stores);
    await waitFor(() => inputs.length > 0, '拾い直した合図が処理に入る');

    expect(noticeOf(inputs[0] ?? '')).toMatchInlineSnapshot(`
      "[system] **これは配り直しである（2 回目の配達）。**2026-08-01T10:00:00.000Z に受け取ったまま、処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。
      同じ内容に既に応答しているかもしれない。日誌（\`journal_read\`）と \`manager_list\` を見て、同じ仕事を二度起こさないこと。
      **2 回以上配り直している。** 器が入れ替わった時点で受信箱に在った未読はこの1件だけだった ⟹ この合図の処理そのものが落ちている可能性がある。同じやり方をもう一度なぞる前に、なぜ落ちたかを先に見ること。

      ---
      "
    `);
    expect(await headlinesOf(stores)).toMatchInlineSnapshot(`
      [
        "[復旧] 未読のまま残っていた合図を配り直した（2回目の配達、2026-08-01T10:00:00.000Z に受け取ったもの）: manager_message managerId=mgr-1 kind=report chars=3",
      ]
    `);

    await clone.stop();
  });

  it('1件・同じ起動の未読が2件（live 1件 + stale 1件。alone でない側の最小）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(report('evt-a', '本文A'), '2026-08-01T10:00:00.000Z');
    await stores.inbox.put(staleTokenPool('evt-stale'), '2026-08-01T10:00:01.000Z');

    const { clone, inputs } = bootClone(stores);
    await waitFor(() => inputs.length > 0, '拾い直した合図が処理に入る');

    expect(noticeOf(inputs[0] ?? '')).toMatchInlineSnapshot(`
      "[system] **これは配り直しである（1 回目の配達）。**2026-08-01T10:00:00.000Z に受け取ったまま、処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。
      同じ内容に既に応答しているかもしれない。日誌（\`journal_read\`）と \`manager_list\` を見て、同じ仕事を二度起こさないこと。
      **この回数は「器が入れ替わった回数」であって、この合図の処理が落ちた回数ではない。**同じ起動で一緒に拾い直した未読が 2 件あり、この合図はそのうちの1件である（配達回数は残っている未読の**全行**で一緒に進む）。**まだ一度も処理されていない可能性がある** — この回数を「この合図で落ちた」の根拠にしないこと。

      ---
      "
    `);
    expect(await headlinesOf(stores)).toMatchInlineSnapshot(`
      [
        "[復旧] 未読のまま残っていた合図を配り直した（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 2 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T10:00:00.000Z に受け取ったもの）: manager_message managerId=mgr-1 kind=report chars=3",
      ]
    `);

    await clone.stop();
  });

  it('2件以上の束・全件に記録あり（最大の配達回数・最も古い時刻）。日誌は [1] [2] の列挙', async () => {
    const stores = createMemoryStores();
    // A は2回目・B は1回目の配達にし、最大が2・最古は B（A より前の時刻）になるようにする
    await stores.inbox.put(report('evt-a', '本文A'), '2026-08-01T10:00:05.000Z');
    await stores.inbox.claimPending();
    await stores.inbox.put(report('evt-b', '本文B'), '2026-08-01T10:00:00.000Z');

    const { clone, inputs } = bootClone(stores);
    await waitFor(() => inputs.length > 0, '拾い直した合図が処理に入る');
    // 束になって1回で届く前提を崩さない: 2回に割れたら、この試験が固定したい形ではない
    expect(inputs).toHaveLength(1);

    expect(noticeOf(inputs[0] ?? '')).toMatchInlineSnapshot(`
      "[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 2 回の配達、最も古いものは 2026-08-01T10:00:00.000Z に受け取った）。**処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。
      同じ内容に既に応答しているかもしれない。日誌（\`journal_read\`）と \`manager_list\` を見て、同じ仕事を二度起こさないこと。
      **この回数は「器が入れ替わった回数」であって、この合図の処理が落ちた回数ではない。**同じ起動で一緒に拾い直した未読が 2 件あり、この合図はそのうちの1件である（配達回数は残っている未読の**全行**で一緒に進む）。**まだ一度も処理されていない可能性がある** — この回数を「この合図で落ちた」の根拠にしないこと。

      ---
      "
    `);
    expect(await headlinesOf(stores)).toMatchInlineSnapshot(`
      [
        "[復旧] 未読のまま残っていた合図を配り直した（まとめて2件。回数はいずれも器が入れ替わった回数——同じ起動で一緒に拾い直した未読が 2 件あり、配達回数は残っている未読の全行で一緒に進む — それぞれの合図の処理が落ちた回数ではない）:
      [1] 1回目の配達、2026-08-01T10:00:00.000Z に受け取ったもの: manager_message managerId=mgr-1 kind=report chars=3
      [2] 2回目の配達、2026-08-01T10:00:05.000Z に受け取ったもの: manager_message managerId=mgr-1 kind=report chars=3",
      ]
    `);

    await clone.stop();
  });

  it('2件以上の束のうち記録があるのは一部だけ（生で届いた合図が混ざる）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(report('evt-a', '本文A'), '2026-08-01T10:00:00.000Z');

    // 報告をまとめる待ち時間を取る: 0 だと拾い直した1件が先に単独で届き、束にならない
    const { clone, inputs } = bootClone(stores, 300);
    clone.post(report('evt-live', '生で届いた本文'));
    await waitFor(() => inputs.join('\n').includes('生で届いた本文'), '両方が処理に入る');

    // 束になって1回で届いた場合だけ、束の枝（記録 1 件 / 束 2 件）を固定できる
    expect(inputs).toHaveLength(1);
    expect(noticeOf(inputs[0] ?? '')).toMatchInlineSnapshot(`
      "[system] **これは配り直しの束である（束 2 件のうち 1 件が配り直し、最大 1 回の配達、最も古いものは 2026-08-01T10:00:00.000Z に受け取った）。**処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。
      同じ内容に既に応答しているかもしれない。日誌（\`journal_read\`）と \`manager_list\` を見て、同じ仕事を二度起こさないこと。
      **この回数は「器が入れ替わった回数」であって、この合図の処理が落ちた回数ではない。**同じ起動で一緒に拾い直した未読が 1 件あり、この合図はそのうちの1件である（配達回数は残っている未読の**全行**で一緒に進む）。**まだ一度も処理されていない可能性がある** — この回数を「この合図で落ちた」の根拠にしないこと。

      ---
      "
    `);
    expect(await headlinesOf(stores)).toMatchInlineSnapshot(`
      [
        "[復旧] 未読のまま残っていた合図を配り直した（1回目の配達、2026-08-01T10:00:00.000Z に受け取ったもの）: manager_message managerId=mgr-1 kind=report chars=3",
      ]
    `);

    await clone.stop();
  });

  it('記録の無い1件（配り直しではない）には断り書きも見出しも付かない', async () => {
    const stores = createMemoryStores();

    const { clone, inputs } = bootClone(stores);
    clone.post(report('evt-live', '生で届いた本文'));
    await waitFor(() => inputs.length > 0, '合図が処理に入る');

    expect(noticeOf(inputs[0] ?? '')).toBe('');
    expect(inputs[0] ?? '').not.toContain('配り直し');
    expect(await headlinesOf(stores)).toEqual([]);

    await clone.stop();
  });
});
