import { describe, expect, it, vi } from 'vitest';

vi.mock('@alteroid/storage-fs', () => ({ initWorkspace: vi.fn() }));

const { program } = await import('../index.js');

describe('alteroid tui の登録', () => {
  it('サブコマンドとして登録されている。既存のサブコマンドは残っている', () => {
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('tui');
    expect(names).toContain('chat');
    expect(names).toContain('conversations');
  });

  it('tui の説明文が help に出る', () => {
    const tui = program.commands.find((c) => c.name() === 'tui');
    expect(tui?.description()).toContain('TUI');
  });
});
