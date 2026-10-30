import { describe, expect, it } from 'vitest';

import { runnersListResponseSchema } from './openapi.js';

const BASE_RUNNER = {
  label: 'http://runner-a:4518',
  state: 'connected',
  since: '2026-10-30T00:00:00.000Z',
  credentials: [],
  credentialsProbe: { status: 'unheard' },
  profileProbe: { status: 'unheard' },
  revision: { status: 'unheard' },
};

function response(runner: Record<string, unknown>): unknown {
  return { runners: [runner], daemonRevision: { status: 'unknown' } };
}

describe('GET /runners の managerPeers（#5850）', () => {
  it('managerPeers の無い runner の行は応答の形として受け付けない（daemon は常に載せる）', () => {
    expect(runnersListResponseSchema.safeParse(response(BASE_RUNNER)).success).toBe(false);
  });

  it('名乗らない runner の `unknown` は、欄そのものが無いこととは別の値として受け付ける', () => {
    const parsed = runnersListResponseSchema.safeParse(
      response({ ...BASE_RUNNER, managerPeers: { status: 'unknown' } }),
    );
    expect(parsed.success).toBe(true);
  });
});
