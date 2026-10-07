import { describe, it, expect } from 'vitest';
import type { InboxEvent } from './schema.js';
import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — managerPrompt は event.foldedTurn を見て見出しを切り替える（Issue #1848）', () => {
  const managerMessage = (
    id: string,
    managerId: string,
    text: string,
    foldedTurn?: true,
  ): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
    ...(foldedTurn === undefined ? {} : { foldedTurn }),
  });

  it('foldedTurn: true（failedReportText 相当の本文）は見出しが「直近のターンの中身」になり、「（報告）」は出ない', async () => {
    const s = setup();
    const body =
      '（このターンは応答を返さずに終わった: success/429 / result_is_error）' +
      "You've hit your individual spend limit for this account.";
    s.clone.post(managerMessage('failed-1', 'mgr-failed', body, true));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes(body)),
      '失敗ターンの報告のターンが投げられる',
    );

    const input = (s.calls[0] as FakeCall).inputs.find((text) => text.includes(body)) ?? '';
    expect(input).toContain('マネージャー mgr-failed から届いた。（直近のターンの中身）');
    expect(input).not.toContain('（報告）');

    await s.clone.stop();
  });

  it('foldedTurn: true（unreportedText 相当の本文）は見出しが「直近のターンの中身」になり、「（報告）」は出ない', async () => {
    const s = setup();
    const body =
      '（このターンは結果を受け取らないまま畳まれた: デーモンから停止を指示された。）\n' +
      '（以下は畳まれる前にマネージャーが書いていた本文である。ターンの途中の発言が' +
      '混ざっていることがある）\n\n途中まで書いていた内容';
    s.clone.post(managerMessage('unreported-1', 'mgr-unreported', body, true));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes(body)),
      '未受信で畳まれたターンの報告のターンが投げられる',
    );

    const input = (s.calls[0] as FakeCall).inputs.find((text) => text.includes(body)) ?? '';
    expect(input).toContain('マネージャー mgr-unreported から届いた。（直近のターンの中身）');
    expect(input).not.toContain('（報告）');

    await s.clone.stop();
  });

  it('foldedTurn が無い、普通の報告では見出しは「（報告）」のまま', async () => {
    const s = setup();
    const body = '普通に完遂した報告の本文';
    s.clone.post(managerMessage('plain-1', 'mgr-plain', body));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes(body)),
      '普通の報告のターンが投げられる',
    );

    const input = (s.calls[0] as FakeCall).inputs.find((text) => text.includes(body)) ?? '';
    expect(input).toContain('マネージャー mgr-plain から届いた。（報告）');
    expect(input).not.toContain('直近のターンの中身');

    await s.clone.stop();
  });
});
