// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import * as card from './home-report-card';

afterEach(cleanup);

function Icon() {
  return null;
}

describe('HomeReportCard の本文の高さ', () => {
  it('畳んでいる間は本文を max-h-96（24rem）で頭打ちにする', () => {
    const { container } = render(
      <card.HomeReportCard icon={Icon} title="日報">
        <p>本文</p>
      </card.HomeReportCard>,
    );
    expect(container.querySelector('.max-h-96')).not.toBeNull();
  });

  // 高さはクラスの1か所だけに書く: 値だけの定数を別に置くと、片方だけ変えたときに黙ってずれる
  it('高さを別の定数として持たない', () => {
    expect(Object.keys(card)).not.toContain('HOME_REPORT_MAX_HEIGHT');
  });
});
