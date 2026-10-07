import { PLUGIN_LIMITS, type RunnerPlugin } from './plugins.js';
import { RUNNER_PLUGIN_RETAIN_MAX_NAMES, type RunnerSetPluginCommand } from './runner-protocol.js';

/** 1ファイルぶんの JSON の枠（キー名・引用符・base64 の padding）の余裕。path の長さは別に足す。 */
const PER_FILE_OVERHEAD_BYTES = 192;
/** name・sha・scope などの固定の欄の余裕。 */
const BODY_SLACK_BYTES = 4096;

/**
 * runner の `POST /plugins/:name` が受ける本文の上限（バイト）。
 *
 * 数値を重ねて書かず、`PLUGIN_LIMITS`（合計バイト・ファイル数・path の長さ）から導く。
 * 合計上限の base64（×4/3）に、ファイル数ぶんの JSON の枠と path を足した値で、受け側の検査
 * （`parseRunnerPlugin`）を抜けた巨大な本文への最後の歯止めである。
 */
export const RUNNER_PLUGIN_BODY_LIMIT_BYTES =
  Math.ceil(PLUGIN_LIMITS.maxTotalBytes / 3) * 4 +
  PLUGIN_LIMITS.maxFiles * (PLUGIN_LIMITS.maxPathLength + PER_FILE_OVERHEAD_BYTES) +
  BODY_SLACK_BYTES;

/** runner の `PUT /plugins` が受ける本文の上限（バイト）。名前の個数の上限から導く。 */
export const RUNNER_PLUGIN_RETAIN_BODY_LIMIT_BYTES =
  RUNNER_PLUGIN_RETAIN_MAX_NAMES * (64 + 8) + BODY_SLACK_BYTES;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** plugin 1本を送る本文にする。content を base64 にする。 */
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

/**
 * 受けた本文の content を bytes に戻す。**検査はしない**（`parseRunnerPlugin` の仕事）。
 * base64 として正しくない綴り（空白・url-safe・padding 欠け）は黙って許さず投げる。
 * 文言に値は載せない。
 */
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
