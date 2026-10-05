import { expectNulRejected } from './nul-contract-support.js';
import type { SessionRegistry } from './store.js';

/**
 * `SessionRegistry` の入口の NUL の約束（issue #2927。teto の判断、2026-10-05）を、
 * **実装1つに対して**測る。3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * - `setCloneSessionId` の id と `setProjectKey` の鍵は `NulNotAllowedError` で断り、何も変えない
 * - 墓標（`TranscriptGrave` / `LostSessionGrave`）は JSON 文字列として保存する。`JSON.stringify` が
 *   NUL を `\u0000` の6文字に直すので、器に生の NUL は届かない。3実装とも往復で値が変わらない
 *   （断りも落としもしない。現状のまま）
 *
 * 呼ぶ前の器は空であること。終わったときは `clear()` で空に戻す。vitest に依存しない。
 */
export async function verifySessionRegistryNulContract(registry: SessionRegistry): Promise<void> {
  function fail(message: string): never {
    throw new Error(`SessionRegistry の NUL の契約違反: ${message}`);
  }

  await registry.setCloneSessionId('sess-keep');
  await registry.setProjectKey('proj-keep');

  await expectNulRejected(
    fail,
    'setCloneSessionIdのNUL',
    () => registry.setCloneSessionId('sess-\u0000-nul'),
    'sess-',
  );
  await expectNulRejected(
    fail,
    'setProjectKeyのNUL',
    () => registry.setProjectKey('proj-\u0000-nul'),
    'proj-',
  );
  if ((await registry.getCloneSessionId()) !== 'sess-keep')
    fail('NULで断った後に session id が変わった');
  if ((await registry.getProjectKey()) !== 'proj-keep')
    fail('NULで断った後に projectKey が変わった');

  // 墓標は JSON 文字列で持つので、NUL を含む値も往復する（現状のまま）。
  await registry.setTranscriptGrave({ archiveId: 'arc-\u0000-1' });
  const grave = await registry.getTranscriptGrave();
  if (grave?.archiveId !== 'arc-\u0000-1') fail('墓標の archiveId が往復しない');
  await registry.setLostSessionGrave({ projectKey: 'p-\u0000-1', sessionId: 's-\u0000-1' });
  const lost = await registry.getLostSessionGrave();
  if (lost?.projectKey !== 'p-\u0000-1' || lost.sessionId !== 's-\u0000-1') {
    fail('失われたセッションの墓標が往復しない');
  }

  await registry.clear();
}
