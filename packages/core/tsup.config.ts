import { defineConfig } from 'tsup';

export default defineConfig({
  // ブラウザが読む軽い口を別 entry に分ける: core 本体から値を import するとサーバ専用のドメイン層ごとブラウザバンドルへ入るため
  // clone-tool-relay-child.ts を package.json の exports に載せない: 外から import される口ではなく、clone.ts が絶対パスで spawn する実行専用の成果物のため
  entry: [
    'src/index.ts',
    'src/cli-light.ts',
    'src/usage-format.ts',
    'src/revision-format.ts',
    'src/journal-search.ts',
    'src/clone-tool-relay-child.ts',
    'src/permission-rule.ts',
    'src/permission-staleness.ts',
    'src/answered-via.ts',
    'src/trace-action.ts',
    'src/mask-url.ts',
    'src/redact.ts',
    'src/manager-activity.ts',
    'src/job-status-running.ts',
    'src/cgroup-events-format.ts',
    'src/system-error-format.ts',
    'src/unpushed-work-observation-format.ts',
    'src/journal-diagnostics-format.ts',
    'src/approval-questions-format.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // escape を止める: esbuild は既定で非 ASCII を `\uXXXX` へ escape し、dist を生のバイト列で照合する検査が「届いていない」と誤判定するため
  esbuildOptions(options) {
    options.charset = 'utf8';
  },
});
