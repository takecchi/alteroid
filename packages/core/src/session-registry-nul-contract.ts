import { expectNulRejected } from './nul-contract-support.js';
import type { SessionRegistry } from './store.js';

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

  await registry.addTranscriptGrave({ archiveId: 'arc-\u0000-1' });
  const grave = (await registry.listTranscriptGraves())[0];
  if (grave?.archiveId !== 'arc-\u0000-1') fail('墓標の archiveId が往復しない');
  await registry.addLostSessionGrave({ projectKey: 'p-\u0000-1', sessionId: 's-\u0000-1' });
  const lost = (await registry.listLostSessionGraves())[0];
  if (lost?.projectKey !== 'p-\u0000-1' || lost.sessionId !== 's-\u0000-1') {
    fail('失われたセッションの墓標が往復しない');
  }

  await registry.clear();
}
