import { CORE_VERSION } from '@alteroid/core';

/**
 * @alteroid/storage-fs — ローカル用ストレージドライバ（Markdown / JSONL / JSON）。
 * 実装は M1（docs/roadmap.md）。core への依存はワークスペース間解決の検証を兼ねる。
 */
export const STORAGE_FS_INFO = { core: CORE_VERSION } as const;
