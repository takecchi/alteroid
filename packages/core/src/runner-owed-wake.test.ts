import { describe, expect, it } from 'vitest';

import { owedWakeReopenedNudge, RunnerOwedWake } from './runner-owed-wake.js';

/** 担当が背景処理を1本残してターンを閉じた状態を作る。 */
function closedTurnWith(task: { id: string; taskType: string }): RunnerOwedWake {
  const owed = new RunnerOwedWake();
  owed.noteTurnActivity();
  owed.noteLiveSet([task]);
  owed.noteTurnEnded();
  return owed;
}

describe('RunnerOwedWake: 背景処理の完了で CLI が起こすはずのターンを、まだ回していないか', () => {
  it('ターンの外で一覧から消えた背景処理は、借りとして残る', () => {
    const owed = closedTurnWith({ id: 'agent-1', taskType: 'local_agent' });
    owed.noteLiveSet([]);
    expect(owed.takeOwed()).toEqual([{ id: 'agent-1', taskType: 'local_agent' }]);
  });

  it('完了の知らせだけでも（一覧から消える前でも）借りに数える', () => {
    const owed = closedTurnWith({ id: 'bash-1', taskType: 'local_bash' });
    owed.noteTaskFinished('bash-1');
    expect(owed.takeOwed()).toEqual([{ id: 'bash-1', taskType: 'local_bash' }]);
  });

  it('一覧に載ったことのない id の完了の知らせ（前景の作業者）は借りに数えない', () => {
    const owed = new RunnerOwedWake();
    owed.noteTurnActivity();
    owed.noteTaskFinished('foreground-agent');
    owed.noteTurnEnded();
    expect(owed.takeOwed()).toEqual([]);
  });

  it('借りが生じた後に始まったターンが終われば、借りは返る', () => {
    const owed = closedTurnWith({ id: 'agent-1', taskType: 'local_agent' });
    owed.noteTaskFinished('agent-1');
    owed.noteTurnActivity();
    owed.noteLiveSet([]);
    owed.noteTurnEnded();
    expect(owed.takeOwed()).toEqual([]);
  });

  it('借りより前に始まったターンの終わりでは返さない（途中で届いた知らせは次のターンへ回されうる）', () => {
    const owed = new RunnerOwedWake();
    owed.noteTurnActivity();
    owed.noteLiveSet([{ id: 'bash-1', taskType: 'local_bash' }]);
    owed.noteLiveSet([]);
    owed.noteTurnEnded();
    expect(owed.takeOwed()).toEqual([{ id: 'bash-1', taskType: 'local_bash' }]);
  });

  it('始まったターンが開いたままなら返さない（終わりを見るまで借りは残る）', () => {
    const owed = closedTurnWith({ id: 'agent-1', taskType: 'local_agent' });
    owed.noteLiveSet([]);
    owed.noteTurnActivity();
    expect(owed.takeOwed()).toEqual([{ id: 'agent-1', taskType: 'local_agent' }]);
  });

  it('増えた背景処理は借りに数えない', () => {
    const owed = new RunnerOwedWake();
    owed.noteLiveSet([{ id: 'bash-1', taskType: 'local_bash' }]);
    expect(owed.takeOwed()).toEqual([]);
  });

  it('CLI の再起動で一覧を空から数え直しても、消えたとは数えない', () => {
    const owed = closedTurnWith({ id: 'agent-1', taskType: 'local_agent' });
    owed.resetLiveSet();
    owed.noteLiveSet([]);
    expect(owed.takeOwed()).toEqual([]);
  });

  it('取り出した借りは空になる（同じ借りで二度起こさない）', () => {
    const owed = closedTurnWith({ id: 'agent-1', taskType: 'local_agent' });
    owed.noteLiveSet([]);
    expect(owed.takeOwed()).toHaveLength(1);
    expect(owed.takeOwed()).toEqual([]);
  });
});

describe('owedWakeReopenedNudge', () => {
  it('id・種類・command・出力の置き場所を並べ、待たずに確かめて続けよと言う', () => {
    const text = owedWakeReopenedNudge([
      { id: 'agent-1', taskType: 'local_agent', outputFile: '/tmp/agent-1.output' },
      { id: 'bash-1', taskType: 'local_bash', command: 'pnpm test', outputFile: null },
    ]);
    expect(text).toContain('- id=agent-1 種類=local_agent 出力: /tmp/agent-1.output');
    expect(text).toContain('- id=bash-1 種類=local_bash command=pnpm test 出力: 取れなかった');
    expect(text).toContain('待っていても来ない');
    expect(text).toContain('続きを進めよ');
  });
});
