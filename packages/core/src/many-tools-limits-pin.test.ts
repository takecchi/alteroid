import { describe, expect, it } from 'vitest';

import * as archivePrune from './archive-prune.js';
import * as cliLight from './cli-light.js';
import * as index from './index.js';
import * as inboxRemoveMany from './clone-tools-inbox-remove-many.js';
import * as removeManyLimit from './remove-many-limit.js';
import * as taskSetStatusMany from './task-set-status-many.js';
import * as tools from './tools.js';

// まとめて消す／閉じる 3 道具（task_set_status_many・inbox_remove_many・archive_remove_many）の定数の値と公開名の経路を縛る。
// 定義を 1 か所へ寄せても、各公開名が同じ値を指し続けることの歯
describe('まとめて消す／閉じる 3 道具の定数', () => {
  it('task_set_status_many の定数（task-set-status-many.ts）', () => {
    expect(taskSetStatusMany.CLOSE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(taskSetStatusMany.CLOSE_MANY_LIMIT_MAX).toBe(2_000);
    expect(taskSetStatusMany.CLOSE_MANY_JOURNAL_ID_CHARS).toBe(3_600);
    expect(taskSetStatusMany.CLOSE_MANY_IDS_SHOWN).toBe(20);
    expect(taskSetStatusMany.CLOSE_MANY_SOURCES_SHOWN).toBe(8);
  });

  it('inbox_remove_many の定数（remove-many-limit.ts・clone-tools-inbox-remove-many.ts）', () => {
    expect(removeManyLimit.REMOVE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(removeManyLimit.REMOVE_MANY_LIMIT_MAX).toBe(2_000);
    expect(inboxRemoveMany.REMOVE_MANY_JOURNAL_ID_CHARS).toBe(3_600);
  });

  it('archive_remove_many の定数（archive-prune.ts）', () => {
    expect(archivePrune.ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(archivePrune.ARCHIVE_REMOVE_MANY_LIMIT_MAX).toBe(2_000);
    expect(archivePrune.ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS).toBe(3_600);
  });

  it('tools.ts・index.ts・cli-light.ts の公開名', () => {
    expect(tools.CLOSE_MANY_LIMIT_MAX).toBe(2_000);
    expect(tools.CLOSE_MANY_JOURNAL_ID_CHARS).toBe(3_600);
    expect(tools.REMOVE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(tools.REMOVE_MANY_LIMIT_MAX).toBe(2_000);
    expect(tools.REMOVE_MANY_JOURNAL_ID_CHARS).toBe(3_600);
    expect(index.REMOVE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(index.REMOVE_MANY_LIMIT_MAX).toBe(2_000);
    expect(index.REMOVE_MANY_JOURNAL_ID_CHARS).toBe(3_600);
    expect(index.ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(index.ARCHIVE_REMOVE_MANY_LIMIT_MAX).toBe(2_000);
    expect(index.ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS).toBe(3_600);
    expect(cliLight.REMOVE_MANY_LIMIT_DEFAULT).toBe(500);
    expect(cliLight.REMOVE_MANY_LIMIT_MAX).toBe(2_000);
  });
});
