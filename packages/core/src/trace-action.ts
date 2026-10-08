import type { JournalEntryType } from './schema.js';

export type TraceActionLike =
  | { type: 'decision'; decision: string; grounds: string }
  | { type: 'memory_update'; action?: string; slug: string; summary: string }
  | { type: 'tool_use'; tool: string; outcome?: 'failed' | 'interrupted'; input?: unknown }
  | { type: 'exchange'; with: 'human' | 'manager' | 'self'; text: string }
  // 最後の枝を `{ type: string }` にしない: switch の分岐で decision 型固有の欄へ触れなくなるため
  | { type: Exclude<JournalEntryType, 'decision' | 'memory_update' | 'tool_use' | 'exchange'> };

export function describeTraceAction(entry: TraceActionLike): string {
  switch (entry.type) {
    case 'decision':
      return `判断: ${entry.decision}（根拠: ${entry.grounds}）`;
    case 'memory_update':
      return `記憶の更新 ${entry.action ?? 'write'} ${entry.slug}: ${entry.summary}`;
    case 'tool_use':
      return (
        `道具 ${entry.tool}` +
        (entry.outcome === undefined ? '' : `（${entry.outcome}）`) +
        (entry.input === undefined ? '' : `: ${JSON.stringify(entry.input)}`)
      );
    case 'exchange':
      return `${entry.with === 'human' ? '人間への返答' : '発言'}: ${entry.text}`;
    default:
      return entry.type;
  }
}
