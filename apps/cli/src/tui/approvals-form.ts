// 突き合わせを二重に判定しない: 知らない id・単一選択で 2 つ以上などはデーモンが 400 で返すため
import { foldSelections } from '@alteroid/core/cli-light';
import type { ApprovalQuestion, ApprovalSelection } from '@alteroid/core';

import type { ApprovalAnswerBody } from './api.js';

export type Slot =
  | { readonly kind: 'option'; readonly q: number; readonly o: number }
  | { readonly kind: 'other'; readonly q: number }
  | { readonly kind: 'text' };

export interface FormState {
  readonly picks: Readonly<Record<string, readonly string[]>>;
  readonly others: Readonly<Record<string, string>>;
  readonly text: string;
  readonly cursor: number;
}

export const emptyForm = (cursor = 0): FormState => ({ picks: {}, others: {}, text: '', cursor });

export const allowsOther = (question: ApprovalQuestion): boolean => question.allowOther !== false;

export function slotsOf(questions: readonly ApprovalQuestion[] | undefined): Slot[] {
  const slots: Slot[] = [];
  (questions ?? []).forEach((question, q) => {
    question.options.forEach((_, o) => slots.push({ kind: 'option', q, o }));
    if (allowsOther(question)) slots.push({ kind: 'other', q });
  });
  slots.push({ kind: 'text' });
  return slots;
}

export function moveCursor(form: FormState, slots: readonly Slot[], delta: number): FormState {
  const cursor = Math.min(Math.max(0, form.cursor + delta), Math.max(0, slots.length - 1));
  return cursor === form.cursor ? form : { ...form, cursor };
}

export function toggleOption(
  form: FormState,
  question: ApprovalQuestion,
  optionId: string,
): FormState {
  const current = form.picks[question.id] ?? [];
  const has = current.includes(optionId);
  if (question.multiple === true) {
    const next = has ? current.filter((id) => id !== optionId) : [...current, optionId];
    return { ...form, picks: { ...form.picks, [question.id]: next } };
  }
  const others = { ...form.others };
  delete others[question.id];
  return {
    ...form,
    picks: { ...form.picks, [question.id]: has ? [] : [optionId] },
    others,
  };
}

export function setOther(form: FormState, question: ApprovalQuestion, text: string): FormState {
  const others = { ...form.others, [question.id]: text };
  const hasText = text.trim() !== '';
  if (question.multiple !== true && hasText) {
    return { ...form, others, picks: { ...form.picks, [question.id]: [] } };
  }
  return { ...form, others };
}

export function setText(form: FormState, text: string): FormState {
  return form.text === text ? form : { ...form, text };
}

export type BuiltAnswer =
  | {
      readonly ok: true;
      readonly body: ApprovalAnswerBody;
      readonly preview: string;
      readonly unanswered: number;
    }
  | { readonly ok: false; readonly reason: string };

export function buildAnswer(
  questions: readonly ApprovalQuestion[] | undefined,
  form: FormState,
): BuiltAnswer {
  const text = form.text.trim();
  if (questions === undefined || questions.length === 0) {
    if (text === '') return { ok: false, reason: '回答が空（自由文を書いてから送る）' };
    return { ok: true, body: { answer: text }, preview: text, unanswered: 0 };
  }
  const answered: ApprovalSelection[] = [];
  const all: ApprovalSelection[] = [];
  for (const question of questions) {
    const optionIds = [...(form.picks[question.id] ?? [])];
    const other = allowsOther(question) ? (form.others[question.id] ?? '').trim() : '';
    const selection: ApprovalSelection = {
      questionId: question.id,
      optionIds,
      ...(other === '' ? {} : { other }),
    };
    all.push(selection);
    if (optionIds.length > 0 || other !== '') answered.push(selection);
  }
  if (answered.length === 0 && text === '') {
    return { ok: false, reason: '何も答えていない（選ぶか、補足を書いてから送る）' };
  }
  // 補足だけのときは全設問を空の答えで送る: API は `selections` に 1 件以上を要るため
  const selections = answered.length > 0 ? answered : all;
  return {
    ok: true,
    body: { selections, ...(text === '' ? {} : { answer: text }) },
    preview: foldSelections(questions, selections, text),
    unanswered: questions.length - answered.length,
  };
}

export function isBlankForm(form: FormState): boolean {
  return (
    form.text.length === 0 &&
    Object.values(form.picks).every((ids) => ids.length === 0) &&
    Object.values(form.others).every((text) => text.length === 0)
  );
}
