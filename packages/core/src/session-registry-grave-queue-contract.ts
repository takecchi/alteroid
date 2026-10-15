import { MAX_PENDING_GRAVES } from './grave-queue.js';
import type { SessionRegistry } from './store.js';

/**
 * 墓標を上書きせずに複数持てること（#4884）を、器（メモリ・fs・pg）で同じに測る。
 * 枠の1つ（`getTranscriptGrave`）は古い方のまま残り、足した順（古い順）で並び、下ろすのは id 単位で、上限を超えたら古い方から落ちる。
 */
export async function verifySessionRegistryGraveQueueContract(
  registry: SessionRegistry,
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`SessionRegistry の墓標の列の契約違反: ${message}`);
  }
  await registry.clear();

  // 足しても消えない・同じものは二重に積まない
  await registry.addTranscriptGrave({ archiveId: 'arc-A' });
  await registry.addTranscriptGrave({ archiveId: 'arc-B' });
  const dup = await registry.addTranscriptGrave({ archiveId: 'arc-A' });
  if (dup.dropped.length !== 0) fail('同じ墓標の再追加で何かが落ちた');
  const ids = (await registry.listTranscriptGraves()).map((g) => g.archiveId);
  if (ids.join(',') !== 'arc-A,arc-B') fail(`並びが古い順でない: ${ids.join(',')}`);
  if ((await registry.getTranscriptGrave())?.archiveId !== 'arc-A') {
    fail('枠（getTranscriptGrave）が古い方でない');
  }

  // id 単位で下ろす（列の側も）
  if (!(await registry.clearTranscriptGraveIf('arc-B'))) fail('列の墓標を下ろせない');
  if (await registry.clearTranscriptGraveIf('arc-B')) fail('下ろした墓標がもう一度下りた');
  if ((await registry.listTranscriptGraves()).map((g) => g.archiveId).join(',') !== 'arc-A') {
    fail('列の墓標を下ろした後の並びが違う');
  }
  await registry.addTranscriptGrave({ archiveId: 'arc-C' });
  if (!(await registry.clearTranscriptGraveIf('arc-A'))) fail('枠の墓標を下ろせない');
  if ((await registry.listTranscriptGraves()).map((g) => g.archiveId).join(',') !== 'arc-C') {
    fail('枠を下ろした後に列の墓標が消えた');
  }
  await registry.clearTranscriptGraveIf('arc-C');

  // 上限を超えたら古い方から落とし、落とした id を返す
  let droppedAll: string[] = [];
  for (let i = 0; i < MAX_PENDING_GRAVES + 2; i += 1) {
    const { dropped } = await registry.addTranscriptGrave({ archiveId: `arc-${String(i)}` });
    droppedAll = [...droppedAll, ...dropped];
  }
  if (droppedAll.join(',') !== 'arc-0,arc-1') fail(`上限で落ちたもの: ${droppedAll.join(',')}`);
  const kept = await registry.listTranscriptGraves();
  if (kept.length !== MAX_PENDING_GRAVES) fail(`上限の件数が違う: ${String(kept.length)}`);
  if (kept[0]?.archiveId !== 'arc-2') fail('上限の後の先頭が違う');

  // 捨てたセッションの墓標も同じ
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 's-A' });
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 's-B' });
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 's-A' });
  if ((await registry.listLostSessionGraves()).map((g) => g.sessionId).join(',') !== 's-A,s-B') {
    fail('捨てたセッションの墓標の並びが違う');
  }
  if (!(await registry.clearLostSessionGraveIf('s-B'))) fail('列の捨てたセッションを下ろせない');
  if (!(await registry.clearLostSessionGraveIf('s-A'))) fail('枠の捨てたセッションを下ろせない');
  if ((await registry.listLostSessionGraves()).length !== 0) fail('下ろし切っても残っている');

  await registry.clear();
  if ((await registry.listTranscriptGraves()).length !== 0) fail('clear() で列が消えない');
}
