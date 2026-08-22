import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * runner の `/health` に足した `revision`（roadmap M5 相当。「自分がどの
 * コミットで走っているか」）の配線を確かめる。
 *
 * **本体はここ。** 版が正しく出ることは当然として、**版が取れないときに
 * `null` をそのまま返すこと**（`{status:'unknown'}` のような取り繕いや
 * `'unknown'` という文字列へ化けさせないこと）を固定する。
 *
 * `resolveBuildRevision()` は焼き込み（`CANON_REVISION`）が最優先で、それは
 * このプロセスが実際に何で `pnpm build` されたかに支配される——この開発用
 * checkout では常に git のフル sha が焼かれているので、素の `createRunnerApp`
 * を呼ぶだけでは「取れなかった」を再現できない。だから `RunnerAppDeps.revision`
 * （テスト専用の DI。既定は `resolveBuildRevision()` そのもので、本番の起動経路
 * ・`apps/runner/src/index.ts` はこの引数を渡さない）で、実行中のプロセスの
 * 焼き込み状態とは独立に「取れなかった」状態を注入する。
 */

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

async function readHealth(
  app: ReturnType<typeof createRunnerApp>,
): Promise<Record<string, unknown>> {
  const response = await app.request('/health', { headers: bearer() });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-health-revision-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

describe('runner の /health revision', () => {
  it('版が取れないとき、commit/short/source すべて null をそのまま返す（プレースホルダを返さない）', async () => {
    const host = newHost();
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      revision: { commit: null, short: null, source: null },
    });

    const body = await readHealth(app);

    expect(body.revision).toEqual({ commit: null, short: null, source: null });
    // **プレースホルダに化けていないことを明示する。**
    const serialized = JSON.stringify(body.revision);
    expect(serialized).not.toMatch(/unknown/i);
    await host.shutdown();
  });

  it('版が取れているとき、そのまま渡した値が /health に出る', async () => {
    const host = newHost();
    const rev = { commit: 'a'.repeat(40), short: 'a'.repeat(12), source: 'build' as const };
    const app = createRunnerApp({
      host,
      outbox: new Outbox(),
      tokenSha256: TOKEN_SHA256,
      revision: rev,
    });

    const body = await readHealth(app);

    expect(body.revision).toEqual(rev);
    await host.shutdown();
  });
});
