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

  // 枠を下ろしたら列の先頭が枠へ上がる。その後に足すと末尾へ入り、上限で落ちるのは本当に最古（#4898）
  const addT = async (id: string): Promise<string[]> =>
    (await registry.addTranscriptGrave({ archiveId: id })).dropped;
  const listT = async (): Promise<string> =>
    (await registry.listTranscriptGraves()).map((g) => g.archiveId).join(',');
  await addT('p-A');
  await addT('p-B');
  await addT('p-C');
  await registry.clearTranscriptGraveIf('p-A');
  if ((await registry.getTranscriptGrave())?.archiveId !== 'p-B') {
    fail('枠を下ろしても列の先頭が枠へ上がらない');
  }
  await addT('p-D');
  if ((await listT()) !== 'p-B,p-C,p-D') fail(`枠を下ろした後に足した並び: ${await listT()}`);
  let promotedDropped: string[] = [];
  for (let i = 0; i < MAX_PENDING_GRAVES - 2; i += 1)
    promotedDropped = await addT(`p-${String(i)}`);
  if (promotedDropped.join(',') !== 'p-B') {
    fail(`上限で落ちたのが最古でない: ${promotedDropped.join(',')}`);
  }
  // 捨てたセッションも同じ
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 'q-A' });
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 'q-B' });
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 'q-C' });
  await registry.clearLostSessionGraveIf('q-A');
  if ((await registry.getLostSessionGrave())?.sessionId !== 'q-B') {
    fail('枠を下ろしても列の先頭が枠へ上がらない（捨てたセッション）');
  }
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 'q-D' });
  if (
    (await registry.listLostSessionGraves()).map((g) => g.sessionId).join(',') !== 'q-B,q-C,q-D'
  ) {
    fail('枠を下ろした後に足した並びが違う（捨てたセッション）');
  }
  await registry.clear();

  // 蒸留の失敗回数は墓標ごと。別の墓標を数えても互いに消えず、下ろすとその墓標の回数だけ消える（#4898）
  const failures = (kind: 'transcript' | 'lost_session', id: string) =>
    registry.graveDistillFailures(kind, id);
  await registry.addTranscriptGrave({ archiveId: 'f-A' });
  await registry.addTranscriptGrave({ archiveId: 'f-B' });
  for (const id of ['f-A', 'f-B', 'f-A', 'f-B', 'f-A']) {
    await registry.noteGraveDistillFailure('transcript', id);
  }
  if ((await failures('transcript', 'f-A')) !== 3) fail('A の失敗回数が B に消された');
  if ((await failures('transcript', 'f-B')) !== 2) fail('B の失敗回数が A に消された');
  if ((await failures('lost_session', 'f-A')) !== 0) fail('失敗回数が種類をまたいだ');
  await registry.clearTranscriptGraveIf('f-A');
  if ((await failures('transcript', 'f-A')) !== 0) fail('墓標を下ろしても失敗回数が残る');
  if ((await failures('transcript', 'f-B')) !== 2) fail('A を下ろしたら B の失敗回数が消えた');
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 'f-L' });
  await registry.noteGraveDistillFailure('lost_session', 'f-L');
  await registry.clearLostSessionGraveIf('f-L');
  if ((await failures('lost_session', 'f-L')) !== 0) fail('捨てたセッションの失敗回数が残る');
  await registry.clearTranscriptGraveIf('f-B');
  await registry.clear();

  // `clear()` は墓標が立ったままの失敗回数も消す。消した欄として数える（#4914）
  // 実装ごとに空の列の行を持つかが違うので、件数は失敗回数の有り無しの差で見る
  await registry.addTranscriptGrave({ archiveId: 'k-T' });
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 'k-L' });
  const withoutFailures = await registry.clear();
  await registry.addTranscriptGrave({ archiveId: 'k-T' });
  await registry.addLostSessionGrave({ projectKey: 'p', sessionId: 'k-L' });
  await registry.noteGraveDistillFailure('transcript', 'k-T');
  await registry.noteGraveDistillFailure('lost_session', 'k-L');
  await registry.noteGraveDistillFailure('lost_session', 'k-L');
  // 失敗回数は種類ごとに1欄: 2つ増える
  if ((await registry.clear()) - withoutFailures !== 2) fail('clear() が失敗回数の欄を数えない');
  if ((await failures('transcript', 'k-T')) !== 0) fail('clear() で失敗回数が残る（墓標）');
  if ((await failures('lost_session', 'k-L')) !== 0)
    fail('clear() で失敗回数が残る（捨てたセッション）');
  // 消した後に同じ印を立て直しても、数え直しになる
  await registry.addTranscriptGrave({ archiveId: 'k-T' });
  if ((await registry.noteGraveDistillFailure('transcript', 'k-T')) !== 1) {
    fail('clear() の後の失敗回数が前の回数の続きになる');
  }
  await registry.clear();
}
