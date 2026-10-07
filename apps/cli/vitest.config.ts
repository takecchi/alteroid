import { workspaceVitestConfig } from '../../vitest.workspace-config.js';

// 中身は書かない: 正本は `vitest.workspace-config.ts`
export default workspaceVitestConfig(import.meta.url);
