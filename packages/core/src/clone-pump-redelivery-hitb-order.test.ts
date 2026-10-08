import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone, REDELIVERY_COUNT_PREFIX_B } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

const AT = '2026-08-12T00:00:00.000Z';

describe('Clone#pump — #noteRedeliveryPredicateHitB の位置（characterization。Issue #1744 の一部）', () => {
  it(
    'manager_message（kind: report）で validity notice が非空になる回、' +
      'hitB の日誌書き込み → 本文追記の日誌書き込み → モデルへの入力、の順で呼ばれる',
    async () => {
      const order: string[] = [];
      const base = createMemoryStores();
      const stores: Stores = {
        ...base,
        journal: {
          ...base.journal,
          append: async (entry) => {
            if (
              entry.type === 'exchange' &&
              entry.with === 'self' &&
              entry.role === 'outbound' &&
              entry.text.includes(REDELIVERY_COUNT_PREFIX_B)
            ) {
              order.push('hitb-journal');
            }
            if (entry.type === 'exchange' && entry.with === 'manager' && entry.role === 'inbound') {
              order.push('incoming-body-journal');
            }
            return base.journal.append(entry);
          },
        },
      };

      const { fn } = fakeSdk((input) => {
        order.push('model-input');
        void input;
        return 'わかった';
      });
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
        ]),
      });

      const event: InboxEvent = {
        type: 'manager_message',
        id: 'evt-hitb-order',
        at: AT,
        managerId: 'mgr-hitb-order',
        kind: 'report',
        text: '終わった',
        statusAtDelivery: 'running',
      };
      clone.post(event);

      await waitFor(() => order.includes('model-input'), 'モデルへ入力が渡る');
      // clone.stop() より前に読む: stop() 自身が蒸留の内部ターンをもう1本起こし、その journal 書き込みが紛れ込むため
      expect(order).toEqual(['hitb-journal', 'incoming-body-journal', 'model-input']);

      await clone.stop();
    },
  );
});
