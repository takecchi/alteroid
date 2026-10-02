import { describe, expect, it } from 'vitest';

import { describeManagerProvider } from './manager-provider.js';

describe('describeManagerProvider の再 export（#486 S9）', () => {
  it('core の正本と同じ字面を返す', () => {
    expect(describeManagerProvider('codex')).toBe('codex');
    expect(describeManagerProvider(undefined)).toContain('不明');
  });
});
