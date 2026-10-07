import { describe, expect, it } from 'vitest';

import {
  describeAccountUsageView,
  usageLayerLabel,
  usageSiteLabel,
  USAGE_LAYER_LABELS,
  USAGE_SITE_LABELS,
} from './usage-view.js';

describe('usageLayerLabel / usageSiteLabel', () => {
  it('既知の値は日本語の名前に、知らない値は値のまま出す（版ずれで行を捨てない）', () => {
    expect(usageLayerLabel('clone')).toBe(USAGE_LAYER_LABELS.clone);
    expect(usageSiteLabel('peer')).toBe(USAGE_SITE_LABELS.peer);
    expect(usageLayerLabel('future-layer')).toBe('future-layer');
    expect(usageSiteLabel('future-site')).toBe('future-site');
  });
});

describe('describeAccountUsageView', () => {
  const at = '2026-10-05T02:12:26.957Z';

  it('ログインしていないときは、利用者の言葉で状態と次の行動を言い、診断の行は details へ寄せる', () => {
    const view = describeAccountUsageView({
      state: 'unavailable',
      at,
      reason: 'claude.ai にログインしていない（鍵が届けば取れる）',
      cause: 'not_logged_in',
      accountKeys: ['apiProvider', 'tokenSource'],
    });
    expect(view.tone).toBe('info');
    expect(view.action).toBe('Claude にログインすると、残りが見えます。');
    expect(view.lines).toEqual([]);
    const visible = [view.headline, view.action].join('\n');
    expect(visible).not.toMatch(/apiKeySource|accountInfo|T\d\d:\d\d/);
    expect(view.details.join('\n')).toContain('apiKeySource');
    expect(view.details.join('\n')).not.toContain(at);
  });

  it('取れなかったとき（failed）は警告の調子で、0 とは言わない', () => {
    const view = describeAccountUsageView({ state: 'failed', at, reason: '答えなかった' });
    expect(view.tone).toBe('warn');
    expect(view.headline).toContain('取得できませんでした');
  });

  it('取れているときは、枠の名前を言い換え、取得した時刻を端末の時刻で出す', () => {
    const view = describeAccountUsageView({
      state: 'ok',
      usage: {
        at,
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [{ kind: 'five_hour', utilization: 42 }],
      },
    });
    expect(view.tone).toBe('ok');
    const text = view.lines.join('\n');
    expect(text).toContain('5時間の枠: 42% 使用');
    expect(text).not.toContain('five_hour');
    expect(text).not.toContain(at);
    expect(text).toContain('取得した時刻:');
  });
});
