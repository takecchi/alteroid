import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { UnreadableApprovalError } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * `Clone#answerApproval` が、読めない承認の行（`UnreadableApprovalError`）を
 * 「存在しない」に畳まず、「在るが読めない」と言う（#2279）。
 *
 * メモリ実装は壊れた行を持てないので、fs / pg が読めない行に対してすることを
 * 差し替えで模す（実ストアでの確認は `apps/daemon/src/approval-unreadable-row.test.ts`）。
 */
const neverCalled = (() => {
  throw new Error('SDK は呼ばれないはず');
}) as unknown as typeof sdkQuery;

function boot() {
  const stores = createMemoryStores();
  const clone = createClone({
    stores,
    queryFn: neverCalled,
    env: {},
    redeliveryGate: ALWAYS_REDELIVER,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: neverCalled, env: {} }),
    ]),
  });
  return { stores, clone };
}

describe('Clone#answerApproval — 読めない承認の行', () => {
  it('getApproval が UnreadableApprovalError を投げたら、「存在しない」ではなくそのまま「在るが読めない」で断る。日誌は書かない', async () => {
    const { stores, clone } = boot();
    stores.jobs.getApproval = async (id) => {
      throw new UnreadableApprovalError({ id });
    };

    const error = await clone.answerApproval('ap-bad', 'よい').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnreadableApprovalError);
    expect((error as Error).message).toContain('承認待ち ap-bad は在るが読めない');
    expect((error as Error).message).not.toContain('存在しない');
    expect(await stores.journal.list({ types: ['escalation'] })).toHaveLength(0);
    await clone.stop();
  });

  it('本当に無い id は従来どおり「存在しない」', async () => {
    const { clone } = boot();
    await expect(clone.answerApproval('ap-nowhere', 'よい')).rejects.toThrow(
      '承認待ち ap-nowhere は存在しない',
    );
    await clone.stop();
  });
});
