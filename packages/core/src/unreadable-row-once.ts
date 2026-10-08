import { createHash } from 'node:crypto';

export interface UnreadableRowOnce {
  sawUnreadable(key: string): boolean;

  sawReadable(key: string): void;
}

// モジュールのトップレベルに置かない: プロセス全体で共有され、別のストアインスタンスの壊れた行を「もう知らせた」と黙らせるため
export function createUnreadableRowOnce(): UnreadableRowOnce {
  const notified = new Set<string>();
  return {
    sawUnreadable(key) {
      if (notified.has(key)) return false;
      notified.add(key);
      return true;
    },
    sawReadable(key) {
      notified.delete(key);
    },
  };
}

// 配列の位置を鍵にしない: 他の行の増減で位置がずれ、再通知と取り違えの黙りの両方が起きうるため
export function unreadableRowKey(id: string | undefined, raw: unknown): string {
  if (id !== undefined) return `id:${id}`;
  return `fingerprint:${fingerprintOf(raw)}`;
}

function fingerprintOf(raw: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? String(raw);
  } catch {
    serialized = String(raw);
  }
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16);
}
