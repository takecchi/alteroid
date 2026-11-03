import { describe, expect, it } from 'vitest';

import { readAppSources } from './app-sources.test-support.js';

describe('HTTP の口の POST /inbox/remove（ソースを読む検査）', () => {
  it('removeMany を直に呼ぶ本番コードは、共有ヘルパ（removeInboxEventsAndStopDelivery）の中だけである', () => {
    // HTTP の口（app.ts と app-routes-*.ts）は全部読む。
    // 入口は app-sources.test-support.ts（packages/core/src/inbox-backlog.test.ts から移した検査）
    const sources = readAppSources().map((entry) => ({
      rel: `apps/daemon/src/${entry.name}`,
      source: entry.source,
    }));
    expect(sources.length).toBeGreaterThanOrEqual(1);
    for (const { rel, source } of sources) expect(source.length, rel).toBeGreaterThan(0);

    const offenders = sources
      .filter(({ source }) =>
        source
          .split('\n')
          .some((line) => !line.trimStart().startsWith('//') && line.includes('inbox.removeMany(')),
      )
      .map(({ rel }) => rel);

    expect(
      offenders,
      'removeInboxEventsAndStopDelivery を通さずに inbox.removeMany を呼んでいる。' +
        '器の行だけが消えて配達は続く（issue #1049）。',
    ).toEqual([]);
  });
});
