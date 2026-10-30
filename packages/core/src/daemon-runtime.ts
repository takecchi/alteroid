// 型だけを置く: CLI（`@alteroid/core/cli-light`）が読むファイルで、値を足すと CLI の起動が延びる。
/** daemon が `state/daemon.json` に書き、CLI が読む形。書き手と読み手がずれると CLI がデーモンを見失う。 */
export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
  token: string;
}
