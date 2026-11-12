import { describe, expect, it } from 'vitest';

import { RETIRED_ENV_KEYS, retiredEnvWarnings } from './retired-env.js';

const SECRET = 'sk-secret-value-12345';

describe('外した環境変数の一覧', () => {
  it('外した 5 つの名前だけを持つ（許可の振る舞いに関わる変数や docs にある変数は入らない）', () => {
    expect([...RETIRED_ENV_KEYS]).toEqual([
      'ALTEROID_SYNTHESIZED_NOTICE_WINDOW_MS',
      'ALTEROID_MERGED_BATCH_SIZE_LIMIT',
      'ALTEROID_PEER_MAX_SESSIONS',
      'ALTEROID_PEER_IDLE_MINUTES',
      'ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES',
    ]);
    expect(RETIRED_ENV_KEYS).not.toContain('ALTEROID_CLONE_PERMISSION_MODE');
  });
});

describe('retiredEnvWarnings', () => {
  it('何も置かれていなければ何も言わない', () => {
    expect(retiredEnvWarnings({})).toEqual([]);
    expect(retiredEnvWarnings({ ALTEROID_CLONE_PERMISSION_MODE: 'auto', PATH: '/bin' })).toEqual(
      [],
    );
  });

  it.each(['', '   ', '\t\n'])('空・空白だけ（%j）は置かれていないと見る', (value) => {
    expect(retiredEnvWarnings({ ALTEROID_PEER_MAX_SESSIONS: value })).toEqual([]);
  });

  it('置かれていれば、名前だけを言い、値は出さない', () => {
    const lines = retiredEnvWarnings({ ALTEROID_MERGED_BATCH_SIZE_LIMIT: SECRET });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ALTEROID_MERGED_BATCH_SIZE_LIMIT');
    expect(lines[0]).toContain('もう読まれません');
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('複数が置かれていれば、変数ごとに1行（一覧の順）。値はどれも出さない', () => {
    const lines = retiredEnvWarnings({
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES: `${SECRET}-a`,
      ALTEROID_SYNTHESIZED_NOTICE_WINDOW_MS: `${SECRET}-b`,
      ALTEROID_PEER_IDLE_MINUTES: `${SECRET}-c`,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('ALTEROID_SYNTHESIZED_NOTICE_WINDOW_MS');
    expect(lines[1]).toContain('ALTEROID_PEER_IDLE_MINUTES');
    expect(lines[2]).toContain('ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES');
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('一覧の全部が置かれていれば、全部の名前が1行ずつ出る', () => {
    const env = Object.fromEntries(RETIRED_ENV_KEYS.map((key) => [key, SECRET]));
    const lines = retiredEnvWarnings(env);
    expect(lines).toHaveLength(RETIRED_ENV_KEYS.length);
    RETIRED_ENV_KEYS.forEach((key, i) => {
      expect(lines[i]).toContain(key);
    });
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
