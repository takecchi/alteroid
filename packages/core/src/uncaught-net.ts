import { noteUncaught } from './dropped-record.js';

export function installUncaughtNet(prefix: string): () => void {
  const listener = (error: Error, origin: string): void => {
    noteUncaught(prefix, origin, error);
  };
  // uncaughtException にしない: 既定のスタックと終了が止まり、器が壊れたと判定できる唯一の材料（プロセスの終了）が消えるため
  process.on('uncaughtExceptionMonitor', listener);
  return () => {
    process.off('uncaughtExceptionMonitor', listener);
  };
}
