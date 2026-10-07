import type { ApprovalQuestion } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  buildAnswer,
  emptyForm,
  moveCursor,
  setOther,
  setText,
  slotsOf,
  toggleOption,
} from './approvals-form.js';

const single: ApprovalQuestion = {
  id: 'q1',
  prompt: 'デプロイ先',
  options: [
    { id: 'a', label: 'Railway', recommended: true },
    { id: 'b', label: 'Fly' },
  ],
};
const multi: ApprovalQuestion = {
  id: 'q2',
  prompt: '通知先',
  multiple: true,
  options: [
    { id: 'x', label: 'Slack' },
    { id: 'y', label: 'Mail' },
  ],
};
const closed: ApprovalQuestion = {
  id: 'q3',
  prompt: '確認',
  allowOther: false,
  options: [{ id: 'ok', label: 'はい' }],
};

describe('slotsOf', () => {
  it('選択肢と「その他」（allowOther が false でなければ）と最後の文字欄が、上から下へ並ぶ', () => {
    expect(slotsOf([single, closed])).toEqual([
      { kind: 'option', q: 0, o: 0 },
      { kind: 'option', q: 0, o: 1 },
      { kind: 'other', q: 0 },
      { kind: 'option', q: 1, o: 0 },
      { kind: 'text' },
    ]);
  });

  it('設問が無ければ文字欄だけ', () => {
    expect(slotsOf(undefined)).toEqual([{ kind: 'text' }]);
  });

  it('カーソルは端で止まる', () => {
    const slots = slotsOf([single]);
    const form = emptyForm();
    expect(moveCursor(form, slots, -1)).toBe(form);
    expect(moveCursor(form, slots, 99).cursor).toBe(slots.length - 1);
  });
});

describe('選ぶ', () => {
  it('単一選択は排他。別の選択肢を選ぶと前のは外れ、同じものをもう一度で外れる', () => {
    let form = toggleOption(emptyForm(), single, 'a');
    expect(form.picks['q1']).toEqual(['a']);
    form = toggleOption(form, single, 'b');
    expect(form.picks['q1']).toEqual(['b']);
    form = toggleOption(form, single, 'b');
    expect(form.picks['q1']).toEqual([]);
  });

  it('複数選択は選んだ順に重なる', () => {
    let form = toggleOption(emptyForm(), multi, 'y');
    form = toggleOption(form, multi, 'x');
    expect(form.picks['q2']).toEqual(['y', 'x']);
    form = toggleOption(form, multi, 'y');
    expect(form.picks['q2']).toEqual(['x']);
  });

  it('単一選択では「その他」と選択肢が排他（UI が作らない形を API に送らない）', () => {
    let form = toggleOption(emptyForm(), single, 'a');
    form = setOther(form, single, '別の所');
    expect(form.picks['q1']).toEqual([]);
    expect(form.others['q1']).toBe('別の所');
    form = toggleOption(form, single, 'b');
    expect(form.others['q1']).toBeUndefined();
    form = setOther(form, single, '  ');
    expect(form.picks['q1']).toEqual(['b']);
  });

  it('複数選択では「その他」と選択肢が両立する', () => {
    let form = toggleOption(emptyForm(), multi, 'x');
    form = setOther(form, multi, '電話');
    expect(form.picks['q2']).toEqual(['x']);
    expect(form.others['q2']).toBe('電話');
  });
});

describe('buildAnswer', () => {
  it('設問つき: 答えた設問だけを { selections, answer? } で送り、確認の文は foldSelections の畳み方', () => {
    let form = toggleOption(emptyForm(), single, 'a');
    form = setText(form, ' 金曜は避けたい ');
    const built = buildAnswer([single, multi], form);
    expect(built).toEqual({
      ok: true,
      body: {
        selections: [{ questionId: 'q1', optionIds: ['a'] }],
        answer: '金曜は避けたい',
      },
      preview: 'Q1 デプロイ先: (a) Railway［推奨］\nQ2 通知先: 未回答\n補足: 金曜は避けたい',
      unanswered: 1,
    });
  });

  it('その他だけで答えた設問も「答えた」。前後の空白は落とす', () => {
    const form = setOther(emptyForm(), single, '  Fly.io  ');
    const built = buildAnswer([single], form);
    expect(built.ok && built.body).toEqual({
      selections: [{ questionId: 'q1', optionIds: [], other: 'Fly.io' }],
    });
  });

  it('allowOther が false の設問に other を載せない', () => {
    const picked = toggleOption(emptyForm(), closed, 'ok');
    const form = { ...picked, others: { q3: '不要な文' } };
    const built = buildAnswer([closed], form);
    expect(built.ok && built.body).toEqual({
      selections: [{ questionId: 'q3', optionIds: ['ok'] }],
    });
  });

  it('何も答えず補足も無ければ送れない。補足だけなら全設問を空の答えで送る（selections は 1 件以上が要る）', () => {
    expect(buildAnswer([single, multi], emptyForm())).toEqual({
      ok: false,
      reason: '何も答えていない（選ぶか、補足を書いてから送る）',
    });
    const built = buildAnswer([single, multi], setText(emptyForm(), '保留で'));
    expect(built.ok && built.body).toEqual({
      selections: [
        { questionId: 'q1', optionIds: [] },
        { questionId: 'q2', optionIds: [] },
      ],
      answer: '保留で',
    });
    expect(built.ok && built.preview).toBe(
      'Q1 デプロイ先: 未回答\nQ2 通知先: 未回答\n補足: 保留で',
    );
    expect(built.ok && built.unanswered).toBe(2);
  });

  it('設問なし: 自由文を { answer } で送る。空は送れない', () => {
    expect(buildAnswer(undefined, setText(emptyForm(), ' はい '))).toEqual({
      ok: true,
      body: { answer: 'はい' },
      preview: 'はい',
      unanswered: 0,
    });
    expect(buildAnswer([], emptyForm())).toEqual({
      ok: false,
      reason: '回答が空（自由文を書いてから送る）',
    });
  });
});
