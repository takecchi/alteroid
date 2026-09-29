import { workspaceVitestConfig } from '../../vitest.workspace-config.js';

// パッケージのディレクトリで vitest を直接叩いても root の設定
// （setupFiles・clearMocks・別名）が効くようにする（#2157）。
// 中身は書かない——正本は `vitest.workspace-config.ts` の doc。
export default workspaceVitestConfig(import.meta.url);
