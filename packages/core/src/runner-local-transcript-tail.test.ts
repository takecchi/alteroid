import { describe, expect, it } from 'vitest';

import { createLocalRunner } from './runner-local.js';
import { RUNNER_CAPABILITY_TRANSCRIPT_TAIL, type RunnerEvent } from './runner-protocol.js';

// 同じプロセスの runner も、見回りの末尾の口を持ち、名乗る（#5160）。持たないと見回りは常に unreadable になる。
describe('同じプロセスの runner の transcriptTail（#5160）', () => {
  it('hello で transcript-tail を名乗り、口は host へ渡る（知らない委譲は null）', async () => {
    const runner = createLocalRunner({ runnerId: 'local-tail', workspacePath: '/work/project' });
    const events: RunnerEvent[] = [];
    await runner.connect((event) => events.push(event));

    const hello = events.find((event) => event.type === 'hello');
    expect(hello?.type === 'hello' ? hello.capabilities : undefined).toContain(
      RUNNER_CAPABILITY_TRANSCRIPT_TAIL,
    );
    if (runner.transcriptTail === undefined) throw new Error('transcriptTail の口が無い');
    expect(await runner.transcriptTail('mgr-unknown', 100)).toBeNull();
    await runner.close();
  });
});
