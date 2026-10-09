import { describe, expect, it } from 'vitest';

import { validatePermissionRequest } from './permission-rule.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return {
    stores,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

describe('request_permission と NUL（検算は残る値で行う）', () => {
  it.each([
    [
      'denies の例が、NUL を落とすと規則に一致する',
      {
        rule: 'Bash(gh pr\u0000:*)',
        allows: ['gh pr\u0000 view'],
        denies: ['gh pr'],
      },
    ],
    [
      '規則の中身が NUL だけで、落とすと Bash() になる',
      { rule: 'Bash(\u0000)', allows: ['\u0000'], denies: ['gh pr view'] },
    ],
  ])('積まれた要求は、残った値でも検算を通る（さもなくば断る）: %s', async (_label, input) => {
    const h = harness();
    await h.call('request_permission', { ...input, reason: '理由' });

    const pending = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    for (const approval of pending) {
      const stored = approval.permissionRequest;
      expect(stored).toBeDefined();
      expect(validatePermissionRequest(stored!)).toEqual({ ok: true });
    }
  });

  it('上の2形は、キューに積まずに断る（陽性対照: 断ったことを直接見る）', async () => {
    const h = harness();
    const first = await h.call('request_permission', {
      rule: 'Bash(gh pr\u0000:*)',
      allows: ['gh pr\u0000 view'],
      denies: ['gh pr'],
      reason: '理由',
    });
    const second = await h.call('request_permission', {
      rule: 'Bash(\u0000)',
      allows: ['\u0000'],
      denies: ['gh pr view'],
      reason: '理由',
    });
    expect(first).toContain('request_permission を拒否した');
    expect(second).toContain('request_permission を拒否した');
    expect((await h.stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(0);
  });

  it('NUL が混ざっても検算が通る要求は、落とした値で積まれ、質問文と承認の行の値が一致する', async () => {
    const h = harness();
    const reply = await h.call('request_permission', {
      rule: 'Bash(gh pr\u0000 view)',
      allows: ['gh pr view\u0000'],
      denies: ['gh pr list'],
      reason: '理\u0000由',
    });
    expect(reply).toContain('承認待ちキューに積んだ');

    const pending = (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(pending).toHaveLength(1);
    const approval = pending[0]!;
    expect(approval.permissionRequest).toEqual({
      rule: 'Bash(gh pr view)',
      allows: ['gh pr view'],
      denies: ['gh pr list'],
    });
    expect(approval.question).toContain('以降 Bash(gh pr view) を');
    expect(approval.question).not.toContain('\u0000');
  });
});
