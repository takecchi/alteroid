/**
 * 承認待ちに答えるフォームの状態と遷移（純粋・I/O 無し・React 無し）。
 *
 * 設問つきの承認待ち（`questions`）は、設問ごとに選択肢を選ぶ。単一選択は排他、`multiple` は複数。
 * `allowOther` が既定の true なら選択肢の最後に「その他」の自由入力がある。最後に補足の自由文
 * （`answer`）が任意で書ける。設問の無い承認待ちは、自由文の回答 1 欄だけ。
 *
 * **送る本文と、確認で見せる文は同じ入力から作る**（`buildAnswer`）。畳んだ文は core の
 * `foldSelections` — デーモンが回答として残す文と同じ関数なので、確認の画面で見たものがそのまま残る。
 *
 * **CLI `/answer` と同じ意味**: 構造化した回答は `{ selections, answer? }`、自由文は `{ answer }`。
 * 突き合わせ（知らない id・単一選択で 2 つ以上・`allowOther:false` に `other` など）はデーモンが
 * 400 で返す — ここで二重に判定しない。ただし UI の側で作らない形（単一選択の複数選び、
 * `allowOther:false` の「その他」）は、そもそも作れないようにしてある。
 */
import { foldSelections } from '@alteroid/core/cli-light';
import type { ApprovalQuestion, ApprovalSelection } from '@alteroid/core';

import type { ApprovalAnswerBody } from './api.js';

/** カーソルが止まる行（フォームの上から下へ平らに並べたもの）。 */
export type Slot =
  | { readonly kind: 'option'; readonly q: number; readonly o: number }
  | { readonly kind: 'other'; readonly q: number }
  /** 補足（設問つき）/ 回答の自由文（設問なし）。 */
  | { readonly kind: 'text' };

export interface FormState {
  /** 設問 id → 選んだ選択肢 id（選んだ順）。 */
  readonly picks: Readonly<Record<string, readonly string[]>>;
  /** 設問 id → 「その他」の文。 */
  readonly others: Readonly<Record<string, string>>;
  /** 補足（設問つき）/ 回答の自由文（設問なし）。 */
  readonly text: string;
  /** `slotsOf` の何番目にカーソルがあるか。 */
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

/** 選択肢を選ぶ/外す。単一選択は排他（別の選択肢と「その他」は外れる）。同じものをもう一度で外れる。 */
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

/** 「その他」の文を置く。単一選択で文が在れば、選んでいた選択肢は外れる（排他）。 */
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
      /** `POST /approvals/{id}/answer` へそのまま送る本文。 */
      readonly body: ApprovalAnswerBody;
      /** 確認の画面で見せる文（設問つきは `foldSelections` で畳んだ文）。 */
      readonly preview: string;
      /** 答えの無い設問の数（送ってよいが、確認で見えるようにする）。 */
      readonly unanswered: number;
    }
  | { readonly ok: false; readonly reason: string };

/** フォームから送る本文と確認の文を作る。 */
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
  // 答えた設問だけを送る（CLI `/answer --select` と同じ）。1 つも無く補足だけのときは、
  // `selections` を空にできない（API は 1 件以上を要る）ので、全設問を空の答えで送る。
  const selections = answered.length > 0 ? answered : all;
  return {
    ok: true,
    body: { selections, ...(text === '' ? {} : { answer: text }) },
    preview: foldSelections(questions, selections, text),
    unanswered: questions.length - answered.length,
  };
}
