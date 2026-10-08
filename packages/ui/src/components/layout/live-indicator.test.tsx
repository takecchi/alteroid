// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LiveIndicator } from './live-indicator';
import { MobileTopBar } from './mobile-top-bar';

afterEach(cleanup);

describe('LiveIndicator の接続先の名前', () => {
  it('札の隣に名前を出し、title に全文を載せる', () => {
    render(
      <LiveIndicator
        status="live"
        connection={{ name: '自宅', title: '自宅 — https://home.example.com' }}
      />,
    );
    const name = screen.getByTitle('自宅 — https://home.example.com');
    expect(name.textContent).toBe('接続先 自宅');
    expect(name.parentElement?.textContent).toContain('受信中');
  });

  // 幅は jsdom では測れないので、縮む側と縮まない側の class で見る
  it('縮むのは名前だけで、札（点と状態の文字）は縮まない', () => {
    render(
      <LiveIndicator
        status="live"
        connection={{ name: 'x'.repeat(200), title: 'x'.repeat(200) }}
      />,
    );
    const name = screen.getByTitle('x'.repeat(200));
    expect(name.className).toContain('truncate');
    expect(name.className).toContain('min-w-0');
    expect(name.parentElement?.className).toContain('min-w-0');
    expect(screen.getByText('受信中').className).toContain('shrink-0');
  });

  it('名前を渡さなければ、札だけを出す（区切りの点も出さない）', () => {
    const { container } = render(<LiveIndicator status="connecting" />);
    expect(container.textContent).toBe('接続中');
  });

  it('狭い画面の上端にも同じ名前が出る', () => {
    render(
      <MobileTopBar
        status="offline"
        connection={{ name: 'nas', title: 'nas — https://nas.example.com' }}
        onOpenNav={() => {}}
      />,
    );
    expect(screen.getByTitle('nas — https://nas.example.com').textContent).toBe('接続先 nas');
    expect(screen.getByText('切断')).toBeTruthy();
  });
});
