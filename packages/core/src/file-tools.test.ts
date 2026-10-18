import { describe, expect, it } from 'vitest';

import { emptyAttachmentUsage } from './attachment.js';
import { renderFileUsage } from './file-tools.js';

function usageWithKeys(keys: Record<string, { count: number; totalBytes: number }>) {
  return { ...emptyAttachmentUsage(), byIntegrationKey: keys };
}

describe('renderFileUsage: 連携の鍵別', () => {
  it('鍵が空なら、鍵別の行を足さず今の出力のまま', () => {
    const usage = emptyAttachmentUsage();
    expect(renderFileUsage(usage)).toBe('置き場の使用量: 0 件 0 B');
    usage.count = 1;
    usage.totalBytes = 10;
    usage.byFrom.human = { count: 1, totalBytes: 10 };
    expect(renderFileUsage(usage)).toBe('置き場の使用量: 1 件 10 B\n出所別: 人間 1 件 10 B');
  });

  it('大きい順に並び、同じ大きさなら鍵 id の昇順', () => {
    const text = renderFileUsage(
      usageWithKeys({
        'key-b': { count: 2, totalBytes: 500 },
        'key-z': { count: 1, totalBytes: 2048 },
        'key-a': { count: 3, totalBytes: 500 },
      }),
    );
    expect(text.split('\n').at(-1)).toBe(
      '連携の鍵別: key-z 1 件 2.0 KiB / key-a 3 件 500 B / key-b 2 件 500 B',
    );
  });

  it('21 本なら 20 本までで「ほか 1 本」、20 本ちょうどなら出ない', () => {
    const keys = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `key-${String(i).padStart(2, '0')}`,
          { count: 1, totalBytes: 100 + i },
        ]),
      );
    const last21 = renderFileUsage(usageWithKeys(keys(21)))
      .split('\n')
      .at(-1)!;
    expect(last21.endsWith(' / ほか 1 本')).toBe(true);
    expect(last21.split(' / ')).toHaveLength(21);
    expect(last21).not.toContain('key-00');
    expect(renderFileUsage(usageWithKeys(keys(20)))).not.toContain('ほか');
  });
});
