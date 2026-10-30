import type { AttachmentLimits } from '@alteroid/core';
import { vi } from 'vitest';

import { TaskBreakdownReader } from './tasks.js';

// `createRunnerApp` は読み手とモデルの既定を持たない（起動の側 `index.ts` が必ず渡す）。試験はこれを渡す。
// 読み手は呼ぶたびに新しく作る: 走査の結果の控えを、別の試験の app と共有しないため。
export const TEST_MANAGER_MODEL = 'opus';
export const TEST_WORKER_MODEL = 'sonnet';

export function appDefaults(): {
  taskBreakdownReader: TaskBreakdownReader;
  managerModel: string;
  workerModel: string;
} {
  return {
    taskBreakdownReader: new TaskBreakdownReader(),
    managerModel: TEST_MANAGER_MODEL,
    workerModel: TEST_WORKER_MODEL,
  };
}

// 添付の上限は env（`ALTEROID_ATTACHMENT_MAX_*`）だけが決める（app は `readAttachmentLimits()` を呼ぶ）。
// 外部ストレージの別枠（`maxLargeFileBytes`）は runner の app が使わず、blob の設定が無ければ 0 のままなので置かない。
// 後始末は呼び元の `afterEach` で `vi.unstubAllEnvs()`。
export function stubAttachmentLimitsEnv(limits: AttachmentLimits): void {
  vi.stubEnv('ALTEROID_ATTACHMENT_MAX_IMAGE_BYTES', String(limits.maxImageBytes));
  vi.stubEnv('ALTEROID_ATTACHMENT_MAX_FILE_BYTES', String(limits.maxFileBytes));
  vi.stubEnv('ALTEROID_ATTACHMENT_MAX_PER_MESSAGE', String(limits.maxPerMessage));
  vi.stubEnv('ALTEROID_ATTACHMENT_MAX_TOTAL_BYTES', String(limits.maxTotalBytes));
  vi.stubEnv('ALTEROID_ATTACHMENT_RETENTION_DAYS', String(limits.retentionDays));
}
