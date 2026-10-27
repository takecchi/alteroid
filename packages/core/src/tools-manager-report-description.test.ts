import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

describe('manager_report の説明文 — 載っている報告を引き直さない案内', () => {
  it('全文が載っている報告は引き直さず、状態の注記は manager_list の行を見ると言う', () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const description = tools.find((entry) => entry.name === 'manager_report')?.description ?? '';

    expect(description).toContain('注記だけを返す');
    expect(description).toContain(
      '全文が載っている報告に未 push などの状態の注記だけが要るなら、引き直さず manager_list の行を見る',
    );
  });
});
