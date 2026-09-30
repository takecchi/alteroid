import { join } from 'node:path';

import {
  createMemoryStores,
  createManagerPool,
  createProfileApplier,
  createProfileService,
  createProfileVessel,
  createRunnerRegistry,
} from '@alteroid/core';
import type { CloneHost, ProfileApplier, Stores } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

/**
 * issue #2429。`PUT /profile` の 400 の `detail` は、シェルの stderr の末尾
 * （構文エラーは入力の行を引用し、`set -x` は値ごと吐く）を載せていた。
 * プロファイルは `GH_TOKEN` などの鍵を含むので、値が応答に出た。
 *
 * 偽の値だけを使う。実物の /bin/sh を通す形（`createProfileApplier`）と、
 * 出口の伏せ字だけを確かめる偽の器の形の両方を置く。
 */

const FAKE_VALUE = 'FAKE_SECRET_VALUE_2429';

function fakeCloneHost(stores: Stores): CloneHost {
  return {
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

function appWith(stores: Stores, applier: ProfileApplier) {
  return createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    profile: createProfileService({ stores, applier }),
  });
}

async function putProfile(app: ReturnType<typeof createApp>, script: string) {
  return app.request('/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script }),
  });
}

/** 評価の結果として、決まった error / output を返す偽の器（出口の伏せ字だけを見る）。 */
function rejectingApplier(failure: { error: string; output: string }): ProfileApplier {
  return {
    vessel: {} as never,
    fingerprint: () => undefined,
    env: () => ({}),
    async apply() {
      throw new Error('この歯では使わない');
    },
    async prepare() {
      return {
        ok: false,
        error: failure.error,
        output: failure.output,
        commit: async () => undefined,
        discard: async () => undefined,
      };
    },
  };
}

describe('PUT /profile の失敗の detail は、シェルの stderr の鍵の値を載せない（issue #2429）', () => {
  let stores: Stores;

  beforeEach(() => {
    stores = createMemoryStores();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function realApplier(): ProfileApplier {
    const path = join(makeTempDirSync('alteroid-profile-2429-'), 'profile.sh');
    return createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({ PATH: process.env.PATH }),
    });
  }

  it('実物のシェル: 構文エラーが入力の行を引用しても、値は出ず、診断の文は残る', async () => {
    const response = await putProfile(
      appWith(stores, realApplier()),
      `export OK=1\nexport GH_TOKEN=${FAKE_VALUE} )\n`,
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(FAKE_VALUE);
    const body = JSON.parse(text) as { error: string; detail: string };
    expect(body.error).toBe('プロファイルが読めなかったので保存していない');
    expect(body.detail).toMatch(/syntax error|unexpected/i);
    expect(body.detail).toContain('[REDACTED]');
  });

  it('実物のシェル: set -x の "+ export NAME=値" も、値は出ない', async () => {
    const response = await putProfile(
      appWith(stores, realApplier()),
      `set -x\nexport GH_TOKEN=${FAKE_VALUE}\nexit 3\n`,
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(FAKE_VALUE);
    const body = JSON.parse(text) as { detail: string };
    expect(body.detail).toContain('export GH_TOKEN=');
    expect(body.detail).toContain('プロファイルの評価が失敗した（終了コード 3）');
  });

  it('出口: 器が伏せずに返した stderr でも、名前の形に合わない行の値を環境変数の網で伏せる', async () => {
    vi.stubEnv('DEPLOY_API_TOKEN', FAKE_VALUE);
    const response = await putProfile(
      appWith(
        stores,
        rejectingApplier({
          error: 'プロファイルの評価が失敗した（終了コード 3）',
          // bash の構文エラーの形（入力の行を引用する）＋名前の形に合わない行
          output:
            `profile.sh: line 7: syntax error near unexpected token \`)'\n` +
            `profile.sh: line 7: \`export GH_TOKEN=${FAKE_VALUE} )'\n` +
            `using ${FAKE_VALUE} here`,
        }),
      ),
      'export A=1',
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(FAKE_VALUE);
    const body = JSON.parse(text) as { detail: string };
    expect(body.detail).toContain('プロファイルの評価が失敗した（終了コード 3）');
    expect(body.detail).toContain('line 7: syntax error');
    expect(body.detail).toContain('line 7: `export GH_TOKEN=[REDACTED]');
    expect(body.detail).toContain('using [REDACTED] here');
  });

  it('出口: 長い stderr は切られ、切り口をまたぐ値の断片も残らない', async () => {
    vi.stubEnv('DEPLOY_API_TOKEN', FAKE_VALUE);
    // 値の中ほどが末尾4000字の切り口に当たる位置に置く（先に切ると断片が残る）。
    const output = `${'x'.repeat(10)} ${FAKE_VALUE} ${'y'.repeat(3_987)}`;
    const response = await putProfile(
      appWith(stores, rejectingApplier({ error: '失敗', output })),
      'export A=1',
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).not.toContain(FAKE_VALUE);
    expect(body.detail).not.toContain('_2429');
    expect(body.detail).not.toContain('FAKE_SECRET');
    // error（短い）＋改行＋切られた output。素の長さ（4000 超）は載らない
    expect(body.detail.length).toBeLessThan(4_100);
    expect(body.detail.startsWith('失敗\n')).toBe(true);
  });

  it('対照: 成功したときは今までどおり 200（クローンの反映結果と runners を返す）', async () => {
    const response = await putProfile(appWith(stores, realApplier()), 'export OK_2429=1\n');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      clone: { ok: boolean; names?: string[] };
      runners: unknown[];
      sha256?: string;
    };
    expect(body.clone.ok).toBe(true);
    expect(body.clone.names).toEqual(['OK_2429']);
    expect(body.runners).toEqual([]);
    expect(typeof body.sha256).toBe('string');
  });

  it('対照: 成功でも set -x の出力（clone.output）に値は出ない', async () => {
    const response = await putProfile(
      appWith(stores, realApplier()),
      `set -x\nexport GH_TOKEN=${FAKE_VALUE}\nset +x\n`,
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(FAKE_VALUE);
    const body = JSON.parse(text) as { clone: { output?: string } };
    expect(body.clone.output ?? '').toContain('export GH_TOKEN=');
  });
});
