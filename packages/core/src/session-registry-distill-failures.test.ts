import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('SessionRegistry（memory）— 墓標の蒸留失敗回数（#4752）', () => {
  it('未記録なら 0、数えると増え、別の印では 1 から数え直し、kind は独立している', async () => {
    const sessions = createMemoryStores().sessions;
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(1);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(2);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);

    // 別の印のぶんは数えていない。数えても a の回数は消えない（#4898）
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'b')).toBe(1);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);

    // もう一方の kind には触れない
    expect(await sessions.graveDistillFailures('lost_session', 'b')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('lost_session', 'b')).toBe(1);
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(1);
  });
});
