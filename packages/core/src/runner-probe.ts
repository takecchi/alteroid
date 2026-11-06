import { reasonOf } from './dropped-record.js';
import type {
  RunnerClient,
  RunnerMcpServersFingerprint,
  RunnerPlacementResources,
} from './runner-protocol.js';

/**
 * `status` から `state` を逆算しない: `unheard`（繋がっていないので聞いていない）は
 * `#runners.list()` がいまどの器を返すかという実装の都合に依存する（`RunnerRevisionStatus` の doc）。
 * `asked` は中身が0件・値が無しでもこれ。`failed` の理由は `reasonOf` で1行に畳む。
 * `GET /runners`（`runnerProbeSchema`）と意味を揃える。
 */
export type RunnerFingerprintProbe =
  { status: 'asked' } | { status: 'unheard' } | { status: 'failed'; error: string };

/**
 * **`.catch(() => undefined)` で握り潰さない。** 「頼まれていない」「聞けなかった」「聞いたが失敗した」を
 * 同じ `undefined` へ潰さないよう `probe` を必ず併せて返し、呼び出し側が判断を省略できないようにする。
 */
export async function probeRunnerFingerprint<T>(
  client: RunnerClient | undefined,
  fingerprints: boolean | undefined,
  fetch: (client: RunnerClient) => Promise<T>,
): Promise<{ value: T | undefined; probe: RunnerFingerprintProbe | undefined }> {
  if (!fingerprints) return { value: undefined, probe: undefined };
  if (client === undefined) return { value: undefined, probe: { status: 'unheard' } };
  try {
    return { value: await fetch(client), probe: { status: 'asked' } };
  } catch (error) {
    return { value: undefined, probe: { status: 'failed', error: reasonOf(error) } };
  }
}

/** `probeRunnerFingerprint` と同じ3状態（`asked` / `unheard` / `failed`）を返す、MCP の登録の指紋の探り。 */
export async function probeRunnerMcpServersFingerprint(
  client: RunnerClient | undefined,
  fingerprints: boolean | undefined,
): Promise<{
  value: RunnerMcpServersFingerprint | undefined;
  probe: RunnerFingerprintProbe | undefined;
}> {
  if (!fingerprints) return { value: undefined, probe: undefined };
  if (client === undefined) return { value: undefined, probe: { status: 'unheard' } };
  try {
    return { value: await client.mcpServers(), probe: { status: 'asked' } };
  } catch (error) {
    return { value: undefined, probe: { status: 'failed', error: reasonOf(error) } };
  }
}

/**
 * `.catch(() => undefined)` で「繋がっていない」「失敗した」を同じ `undefined` に潰さない。
 * `asked` で `resources` が `undefined` のままでも、応答が資源を名乗らなかっただけで失敗ではない。
 */
export async function probeRunnerResources(
  client: RunnerClient | undefined,
  resources: boolean | undefined,
): Promise<{
  value: RunnerPlacementResources | undefined;
  probe: RunnerFingerprintProbe | undefined;
}> {
  if (!resources) return { value: undefined, probe: undefined };
  if (client === undefined) return { value: undefined, probe: { status: 'unheard' } };
  try {
    return { value: (await client.resources()) ?? undefined, probe: { status: 'asked' } };
  } catch (error) {
    return { value: undefined, probe: { status: 'failed', error: reasonOf(error) } };
  }
}
