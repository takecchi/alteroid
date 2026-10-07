import { describe, expect, it } from 'vitest';

import {
  RETIRED_LAYER_PROVIDER_ENV_KEYS,
  retiredLayerProviderNotices,
} from './retired-provider-env.js';

describe('もう読まない層の provider の変数（2026-10-07 の決定）', () => {
  it('対象は3つ（クローン・マネージャーの provider と、クローンの PEERS）', () => {
    expect([...RETIRED_LAYER_PROVIDER_ENV_KEYS]).toEqual([
      'ALTEROID_CLONE_PROVIDER',
      'ALTEROID_MANAGER_PROVIDER',
      'ALTEROID_CLONE_PEERS',
    ]);
  });

  it('置かれていなければ何も出さない（空・空白も未設定）', () => {
    expect(retiredLayerProviderNotices({}, 'alteroidd')).toEqual([]);
    expect(
      retiredLayerProviderNotices(
        { ALTEROID_CLONE_PROVIDER: '', ALTEROID_MANAGER_PROVIDER: '  ' },
        'alteroidd',
      ),
    ).toEqual([]);
  });

  it('置かれた変数ごとに名前を出して1行。値は出さない。残る口（ALTEROID_MANAGER_PEERS）を案内する', () => {
    const lines = retiredLayerProviderNotices(
      {
        ALTEROID_CLONE_PROVIDER: 'codex-secret-looking-value',
        ALTEROID_CLONE_PEERS: 'codex',
        ALTEROID_MANAGER_PEERS: 'codex',
      },
      'alteroid-runner',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^alteroid-runner: ALTEROID_CLONE_PROVIDER はもう読みません/);
    expect(lines[1]).toMatch(/^alteroid-runner: ALTEROID_CLONE_PEERS はもう読みません/);
    for (const line of lines) {
      expect(line).toContain('2026-10-07');
      expect(line).toContain('ALTEROID_MANAGER_PEERS');
      expect(line).not.toContain('codex-secret-looking-value');
      expect(line).not.toContain('\n');
    }
  });
});
