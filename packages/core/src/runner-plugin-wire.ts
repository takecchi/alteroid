import { PLUGIN_LIMITS, type RunnerPlugin } from './plugins.js';
import { RUNNER_PLUGIN_RETAIN_MAX_NAMES, type RunnerSetPluginCommand } from './runner-protocol.js';

const PER_FILE_OVERHEAD_BYTES = 192;
const BODY_SLACK_BYTES = 4096;

// 数値を重ねて書かず `PLUGIN_LIMITS` から導く: 検査（`parseRunnerPlugin`）を抜けた巨大な本文への最後の歯止めだから。
export const RUNNER_PLUGIN_BODY_LIMIT_BYTES =
  Math.ceil(PLUGIN_LIMITS.maxTotalBytes / 3) * 4 +
  PLUGIN_LIMITS.maxFiles * (PLUGIN_LIMITS.maxPathLength + PER_FILE_OVERHEAD_BYTES) +
  BODY_SLACK_BYTES;

export const RUNNER_PLUGIN_RETAIN_BODY_LIMIT_BYTES =
  RUNNER_PLUGIN_RETAIN_MAX_NAMES * (64 + 8) + BODY_SLACK_BYTES;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodeRunnerPlugin(plugin: RunnerPlugin): RunnerSetPluginCommand {
  return {
    name: plugin.name,
    sourceSha: plugin.sourceSha,
    scope: plugin.scope,
    enableHooks: plugin.enableHooks,
    enableMcp: plugin.enableMcp,
    contentSha256: plugin.contentSha256,
    files: plugin.files.map((file) => ({
      path: file.path,
      executable: file.executable,
      content: Buffer.from(file.content).toString('base64'),
    })),
  };
}

// 不正な base64（空白・url-safe・padding 欠け）は黙って許さず投げる。文言に値は載せない。
export function decodeRunnerPlugin(command: RunnerSetPluginCommand): unknown {
  return {
    name: command.name,
    sourceSha: command.sourceSha,
    scope: command.scope,
    enableHooks: command.enableHooks,
    enableMcp: command.enableMcp,
    contentSha256: command.contentSha256,
    files: command.files.map((file, index) => {
      if (!BASE64_PATTERN.test(file.content)) {
        throw new Error(`files.${index}.content: base64 として読めない`);
      }
      return {
        path: file.path,
        executable: file.executable,
        content: new Uint8Array(Buffer.from(file.content, 'base64')),
      };
    }),
  };
}
