/**
 * 「承認待ち」タブの描画（見た目だけ。キー操作は `app.tsx` の 1 つの `useInput` が持つ）と、
 * 一覧の 1 行・詳細の本文（折り返し済みの物理行）を作る純粋関数。Ink の地雷への対処は
 * `components.tsx` の冒頭と同じ（空の `<Text>` は高さ 0・溢れた子は縮む・1 行は 1 つの `<Text>`・
 * セルは `truncate-end`）。
 *
 * **一覧はタイトルと要旨だけ**（`.claude/skills/listing-and-detail`）: 1 件 1 行（経過・出どころ・
 * 設問の要約か質問の抜粋）。質問の全文・文脈・設問の中身は詳細を明示的に開いて読む。
 *
 * 設問の表示は core の `describeQuestionLines` / `summarizeQuestions` と、畳んだ文の
 * `foldSelections`（`approvals-form.ts`）— CLI の `/approval` `/approvals` と同じ生成元。
 */
import {
  describeQuestionLines,
  summarizeQuestions,
  PERMISSION_GRANT_CONSENT_PHRASE,
} from '@alteroid/core';
import { Box, Text } from 'ink';
import type { FC } from 'react';

import { formatElapsedAgo } from '../format.js';
import type { ApprovalRow } from './api.js';
import { allowsOther, slotsOf } from './approvals-form.js';
import {
  isOpen,
  type DatesState,
  type DayState,
  type DetailState,
  type ListState,
} from './approvals-controller.js';
import type { AnsweredDateRow } from './api.js';
import { oneLine } from './journal-format.js';
import type { DisplayLine } from './log.js';
import type { RichSpan } from './markdown.js';
import { glyph, theme } from './theme.js';
import { redactBody } from '../redact.js';
import { LINE_BREAK, wrapLogical } from './wrap.js';

/** 一覧に出す識別子（長い id は先頭だけ。全文は詳細の頭に出す）。 */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** 出どころ。マネージャー発か、クローン自身の確認か。 */
export const originOf = (row: ApprovalRow): string =>
  row.jobId !== undefined ? `マネージャー ${shortId(row.jobId)}` : 'クローン';

/** 一覧の 1 行に収まる出どころ（幅を食わないよう括弧で短く）。 */
const originTag = (row: ApprovalRow): string =>
  row.jobId !== undefined ? `[${shortId(row.jobId)}]` : '[クローン]';

/** 一覧の 1 行の要旨。設問が在れば設問の要約（先頭）に質問の抜粋を続ける。無ければ質問の抜粋。 */
export function approvalSummary(row: ApprovalRow): string {
  const question = oneLine(redactBody(row.question), 120);
  return row.questions !== undefined && row.questions.length > 0
    ? `${summarizeQuestions(row.questions)}  ${question}`
    : question;
}

/** 一覧の 1 行（選択の印は付けない）。 */
export function approvalListLine(row: ApprovalRow, now: number): string {
  return (
    `${formatElapsedAgo(row.createdAt, now)} ${shortId(row.id)} ${originTag(row)}` +
    `${row.permissionRequest === undefined ? '' : ' [実行許可]'}  ${approvalSummary(row)}`
  );
}

/** 一覧の見出し。初回の読み込みが失敗したときは件数を言わない（空ではない）。 */
export function approvalListTitle(list: ListState): string {
  if (list.status === 'loading' || list.status === 'idle') return '承認待ちを読んでいる…';
  if (list.status === 'error' && list.items.length === 0) {
    return '承認待ちを読めなかった（空ではない）。r で読み直す';
  }
  return `承認待ち（未回答 ${String(list.items.length)} 件 · 古い順）`;
}

function listEmptyText(list: ListState): string {
  return list.unreadable.length > 0
    ? '読めた承認待ちは無い（読めない行が在るので、無いとは言えない）。'
    : '承認待ちは無い。';
}

/** 一覧。窓は選択行が見える範囲だけを描く。 */
export const ApprovalList: FC<{ list: ListState; height: number }> = ({ list, height }) => {
  const { items, selected } = list;
  const ids = list.unreadable.map((u) => u.id).filter((id): id is string => id !== undefined);
  const unreadableLine =
    list.unreadable.length > 0
      ? `⚠ 読めない承認待ちが ${String(list.unreadable.length)} 件ある` +
        `${ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`}（壊れた行であって、回答済みでも取り下げ済みでもない。この一覧には載っていない）`
      : null;
  const errorLine = list.error !== null ? `⚠ ${list.error}` : null;
  const fixed = 1 + (unreadableLine === null ? 0 : 1) + (errorLine === null ? 0 : 1);
  const cap = Math.max(1, height - fixed);
  const start = Math.min(Math.max(0, selected - cap + 1), Math.max(0, items.length - cap));
  const shown = items.slice(start, start + cap);
  const title = approvalListTitle(list);
  return (
    <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {title}
      </Text>
      {unreadableLine !== null ? (
        <Text wrap="truncate-end" color={theme.warn}>
          {unreadableLine}
        </Text>
      ) : null}
      {errorLine !== null ? (
        <Text wrap="truncate-end" color={theme.warn}>
          {errorLine}
        </Text>
      ) : null}
      {list.status === 'ready' && items.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          {listEmptyText(list)}
        </Text>
      ) : null}
      {shown.map((row, i) => {
        const index = start + i;
        return (
          <Box key={row.id} flexShrink={0}>
            <Text wrap="truncate-end" {...(index === selected ? { inverse: true } : {})}>
              {`${index === selected ? glyph.caret : ' '} ${approvalListLine(row, list.loadedAt)}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

// --- 回答済み（決着した日ごと。#3340） ---------------------------------------

/** 決着した日の 1 行（選択の印は付けない）。 */
export const answeredDateLine = (row: AnsweredDateRow): string =>
  `${row.date}  ${String(row.count)} 件`;

/**
 * その日の件の 1 行（選択の印は付けない）。**抜粋だけ**: 状態（回答済み／取り下げ済み）・決着からの経過・
 * id・問いの抜粋に、答え（回答済み）か取り下げた理由（取り下げ済み）の抜粋を続ける。全文は詳細。
 * 決着の日時は `answeredAt`、無ければ `withdrawnAt`（デーモンの日の区切りと同じ決め方）。
 */
export function answeredDayLine(row: ApprovalRow, now: number): string {
  const withdrawn = row.withdrawnAt !== undefined && row.answeredAt === undefined;
  const settledAt = row.answeredAt ?? row.withdrawnAt ?? row.createdAt;
  const tail = withdrawn
    ? `  取り下げた理由: ${row.withdrawnReason === undefined ? '（理由の記録なし）' : oneLine(redactBody(row.withdrawnReason), 60)}`
    : row.answer === undefined
      ? ''
      : `  回答: ${oneLine(redactBody(row.answer), 60)}`;
  return (
    `${withdrawn ? '取り下げ済み' : '回答済み'} ${formatElapsedAgo(settledAt, now)} ` +
    `${shortId(row.id)}  ${oneLine(redactBody(row.question), 80)}${tail}`
  );
}

/** 決着した日の一覧の見出し。初回の読み込みが失敗したときは件数を言わない（空ではない）。 */
export function answeredDatesTitle(dates: DatesState): string {
  if (dates.status === 'loading' || dates.status === 'idle') return '決着した日を読んでいる…';
  if (dates.status === 'error' && dates.items.length === 0) {
    return '決着した日を読めなかった（空ではない）。r で読み直す';
  }
  return `回答済み・取り下げ済み（決着した日 ${String(dates.items.length)} 日 · 新しい日が上）`;
}

/** 決着した日の一覧。窓は選択行が見える範囲だけを描く。 */
export const AnsweredDatesList: FC<{ dates: DatesState; height: number }> = ({ dates, height }) => {
  const { items, selected } = dates;
  const errorLine = dates.error !== null ? `⚠ ${dates.error}` : null;
  const moreLine = dates.maybeMore ? '…これより古い日があるかもしれない（m で続きを読む）' : null;
  const fixed = 1 + (errorLine === null ? 0 : 1) + (moreLine === null ? 0 : 1);
  const cap = Math.max(1, height - fixed);
  const start = Math.min(Math.max(0, selected - cap + 1), Math.max(0, items.length - cap));
  return (
    <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {answeredDatesTitle(dates)}
      </Text>
      {errorLine !== null ? (
        <Text wrap="truncate-end" color={theme.warn}>
          {errorLine}
        </Text>
      ) : null}
      {dates.status === 'ready' && items.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          決着した承認はまだ無い。
        </Text>
      ) : null}
      {items.slice(start, start + cap).map((row, i) => {
        const index = start + i;
        return (
          <Box key={row.date} flexShrink={0}>
            <Text wrap="truncate-end" {...(index === selected ? { inverse: true } : {})}>
              {`${index === selected ? glyph.caret : ' '} ${answeredDateLine(row)}`}
            </Text>
          </Box>
        );
      })}
      {moreLine !== null ? (
        <Text dimColor wrap="truncate-end">
          {moreLine}
        </Text>
      ) : null}
    </Box>
  );
};

/** その日の件の見出し。取れなかったのを 0 件と言わない。 */
export function answeredDayTitle(day: DayState): string {
  const date = day.date ?? '';
  if (day.status === 'loading' || day.status === 'idle') return `${date} の承認を読んでいる…`;
  if (day.status === 'error' && day.items.length === 0) {
    return `${date} の承認を読めなかった（空ではない）。r で読み直す`;
  }
  return `${date} に決着した承認（${String(day.items.length)} 件 · 決着の新しい順）`;
}

/** その日の件の一覧。窓は選択行が見える範囲だけを描く。 */
export const AnsweredDayList: FC<{ day: DayState; height: number }> = ({ day, height }) => {
  const { items, selected } = day;
  const errorLine = day.error !== null ? `⚠ ${day.error}` : null;
  const fixed = 1 + (errorLine === null ? 0 : 1);
  const cap = Math.max(1, height - fixed);
  const start = Math.min(Math.max(0, selected - cap + 1), Math.max(0, items.length - cap));
  return (
    <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {answeredDayTitle(day)}
      </Text>
      {errorLine !== null ? (
        <Text wrap="truncate-end" color={theme.warn}>
          {errorLine}
        </Text>
      ) : null}
      {day.status === 'ready' && items.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          この日に決着した承認は無い。
        </Text>
      ) : null}
      {items.slice(start, start + cap).map((row, i) => {
        const index = start + i;
        return (
          <Box key={row.id} flexShrink={0}>
            <Text wrap="truncate-end" {...(index === selected ? { inverse: true } : {})}>
              {`${index === selected ? glyph.caret : ' '} ${answeredDayLine(row, day.loadedAt)}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

// --- 詳細の本文 -------------------------------------------------------------

export interface ApprovalDoc {
  readonly rows: DisplayLine[];
  /** 答えるフォームのカーソル行（`rows` の index）。フォームが開いていなければ `null`。 */
  readonly focusRow: number | null;
}

interface LineOptions {
  indent?: number;
  kind?: DisplayLine['kind'];
  bold?: boolean;
  dim?: boolean;
  /** 折り返した 2 行目以降の字下げ（既定は `indent`）。 */
  hang?: number;
}

class DocBuilder {
  readonly rows: DisplayLine[] = [];
  constructor(private readonly width: number) {}

  /** 論理行（改行を含んでよい）を折り返して足す。最初の物理行の index を返す。 */
  push(text: string, options: LineOptions = {}): number {
    const first = this.rows.length;
    const indent = options.indent ?? 0;
    const hang = options.hang ?? indent;
    const kind = options.kind ?? 'assistant';
    let lead = true;
    for (const logical of text.split(LINE_BREAK)) {
      const content = Math.max(1, this.width - Math.max(indent, hang));
      for (const piece of wrapLogical(logical, content)) {
        const line = `${' '.repeat(lead ? indent : hang)}${piece}`;
        lead = false;
        const row: DisplayLine = { key: `d${String(this.rows.length)}`, kind, text: line };
        if (options.bold === true || options.dim === true) {
          const span: RichSpan = {
            text: line,
            ...(options.bold === true ? { bold: true } : {}),
            ...(options.dim === true ? { dim: true } : {}),
          };
          row.spans = [span];
        }
        this.rows.push(row);
      }
    }
    return first;
  }

  blank(): void {
    this.push('');
  }
}

const stateLabel = (a: ApprovalRow): string =>
  a.withdrawnAt !== undefined ? '取り下げ済み' : a.answeredAt !== undefined ? '回答済み' : '未回答';

function permissionLines(b: DocBuilder, a: ApprovalRow): void {
  const p = a.permissionRequest;
  if (p === undefined) return;
  b.push('実行許可の要求（request_permission）', { bold: true });
  b.push(`規則: ${redactBody(p.rule)}`, { indent: 2 });
  for (const allow of p.allows) b.push(`通すべき例: ${redactBody(allow)}`, { indent: 2 });
  for (const deny of p.denies) b.push(`拒むべき例: ${redactBody(deny)}`, { indent: 2 });
  b.push(
    `許可するなら「${PERMISSION_GRANT_CONSENT_PHRASE}」とちょうど答える（CLI の /answer と同じ。` +
      '許可として記録されるのは、許可されたアカウントの資格で答えたときだけ）。それ以外の文は許可にならない。',
    { indent: 2, dim: true },
  );
  b.blank();
}

/** 答えるフォームの行（カーソル行の index を返す）。 */
function formLines(b: DocBuilder, a: ApprovalRow, detail: DetailState): number | null {
  const form = detail.form;
  if (form === null) return null;
  const questions = a.questions ?? [];
  const slots = slotsOf(questions);
  const cursorSlot = slots[form.cursor];
  let focus: number | null = null;
  const mark = (on: boolean): string => (on ? `${glyph.caret} ` : '  ');
  const isCursor = (match: (slot: (typeof slots)[number]) => boolean): boolean =>
    cursorSlot !== undefined && match(cursorSlot);

  questions.forEach((question, q) => {
    const kind = question.multiple === true ? '複数選択可' : '単一選択';
    b.push(`Q${String(q + 1)} ${redactBody(question.prompt)}（${kind}）`, { bold: true });
    const picked = new Set(form.picks[question.id] ?? []);
    question.options.forEach((option, o) => {
      const on = picked.has(option.id);
      const box = question.multiple === true ? (on ? '[x]' : '[ ]') : on ? '(●)' : '( )';
      const label =
        `${box} ${String.fromCharCode(97 + (o % 26))}) ${redactBody(option.label)}` +
        `${option.recommended === true ? '［推奨］' : ''}` +
        `${option.description === undefined ? '' : ` — ${redactBody(option.description)}`}`;
      const here = isCursor((s) => s.kind === 'option' && s.q === q && s.o === o);
      const at = b.push(`${mark(here)}${label}`, { indent: 0, hang: 8, bold: here });
      if (here) focus = at;
    });
    if (allowsOther(question)) {
      const text = form.others[question.id] ?? '';
      const on = text.trim() !== '';
      const box = question.multiple === true ? (on ? '[x]' : '[ ]') : on ? '(●)' : '( )';
      const here = isCursor((s) => s.kind === 'other' && s.q === q);
      const at = b.push(`${mark(here)}${box} その他: ${on ? text : '（Space で書く）'}`, {
        hang: 8,
        bold: here,
      });
      if (here) focus = at;
    }
  });
  const hasQuestions = questions.length > 0;
  const here = isCursor((s) => s.kind === 'text');
  const label = hasQuestions ? '補足（任意）' : '回答（自由文）';
  const at = b.push(
    `${mark(here)}${label}: ${form.text.trim() === '' ? '（Space で書く）' : form.text}`,
    { hang: 4, bold: here },
  );
  if (here) focus = at;
  return focus;
}

/**
 * 詳細の本文。読む画面（質問の全文・文脈・出どころ・設問の表示）・答えるフォーム・送る前の確認の
 * どれかを、モードに合わせて組む。確認では、デーモンが回答として残す畳んだ文をそのまま見せる。
 */
export function approvalDocument(detail: DetailState, width: number): ApprovalDoc {
  const b = new DocBuilder(width);
  const a = detail.approval;
  if (a === null) {
    b.push(detail.missing ? `${detail.id}  見つからない` : `${detail.id}  読んでいる…`, {
      bold: true,
    });
    return { rows: b.rows, focusRow: null };
  }

  if (detail.mode === 'confirm' && detail.confirm !== null) {
    b.push('この内容で答える?', { bold: true });
    b.blank();
    b.push(detail.confirm.preview, { indent: 2 });
    b.blank();
    if (detail.confirm.unanswered > 0) {
      b.push(
        `⚠ 答えていない設問が ${String(detail.confirm.unanswered)} 件ある（上の「未回答」のまま送る。` +
          '送ったあとは答え直せない）',
        { kind: 'system' },
      );
    } else {
      b.push('送ったあとは答え直せない（答えた仕事だけが再開する）。', { dim: true });
    }
    return { rows: b.rows, focusRow: null };
  }

  b.push(`[${stateLabel(a)}] ${a.id}`, { bold: true });
  b.push(
    `作成 ${a.createdAt}（${formatElapsedAgo(a.createdAt, detail.loadedAt)}）  出どころ: ${originOf(a)}` +
      `${a.jobId === undefined ? '' : `（${a.jobId}）`}`,
    { dim: true },
  );
  if (a.conversationId !== undefined) b.push(`会話: ${a.conversationId}`, { dim: true });
  b.blank();
  b.push('質問', { bold: true });
  b.push(redactBody(a.question), { indent: 2 });
  if (a.context !== undefined && a.context.trim() !== '') {
    b.blank();
    b.push('背景', { bold: true });
    b.push(redactBody(a.context), { indent: 2 });
  }
  b.blank();
  permissionLines(b, a);
  if (a.answeredAt !== undefined) {
    b.push(`回答（${a.answeredAt}）`, { bold: true });
    b.push(a.answer === undefined ? '（回答の文は記録されていない）' : redactBody(a.answer), {
      indent: 2,
    });
  } else if (a.withdrawnAt !== undefined) {
    b.push(`取り下げ済み（${a.withdrawnAt}）`, { bold: true });
    b.push(a.withdrawnReason === undefined ? '（理由の記録なし）' : redactBody(a.withdrawnReason), {
      indent: 2,
    });
  }

  let focusRow: number | null = null;
  const questions = a.questions ?? [];
  if (detail.mode === 'form' && isOpen(a) && detail.form !== null) {
    b.push(questions.length > 0 ? '設問に答える' : '答える', { bold: true });
    focusRow = formLines(b, a, detail);
  } else if (questions.length > 0) {
    b.push('設問', { bold: true });
    for (const line of describeQuestionLines(questions)) {
      b.push(redactBody(line), { indent: 2, hang: 6 });
    }
    if (isOpen(a)) {
      b.blank();
      b.push(
        detail.form === null
          ? 'a で答える（選んで答える。送る前に確認が出る）。'
          : 'a で書きかけの回答に戻る。',
        { dim: true },
      );
    }
  } else if (isOpen(a)) {
    b.push(
      detail.form === null ? '設問は無い。a で自由文で答える。' : 'a で書きかけの回答に戻る。',
      { dim: true },
    );
  }
  return { rows: b.rows, focusRow };
}

/** 詳細の最下行（ログ直下の 1 行）。優先: 確認 > 送信中・操作の結果 > 取り直しの失敗 > 窓の外 > 操作の案内。 */
export function approvalStatusText(
  detail: DetailState,
  hiddenBelow: number,
): { text: string; tone: 'dim' | 'warn' } {
  if (detail.mode === 'confirm') {
    return { text: 'y で送る / それ以外のキーで戻る（送ったあとは答え直せない）', tone: 'warn' };
  }
  if (detail.notice !== null) {
    return { text: detail.notice, tone: detail.noticeTone === 'warn' ? 'warn' : 'dim' };
  }
  if (detail.error !== null) return { text: `⚠ 取り直せなかった: ${detail.error}`, tone: 'warn' };
  if (detail.missing && detail.approval === null) {
    return { text: 'この承認待ちは見つからない（回答済みの一覧にも無い）', tone: 'warn' };
  }
  if (hiddenBelow > 0) {
    return { text: `↓ あと ${String(hiddenBelow)} 行（PgDn で進む）`, tone: 'dim' };
  }
  return { text: ' ', tone: 'dim' };
}

/** 入力欄のプレースホルダ（何を書く欄か）。 */
export function composerPlaceholder(detail: DetailState): string {
  const cursorKind = slotsOf(detail.approval?.questions)[detail.form?.cursor ?? 0]?.kind ?? null;
  if (detail.busy) return '送信中…';
  if (detail.mode !== 'form') return 'a で答える（i でも）';
  if (cursorKind === 'other') return '「その他」の文を書く（Enter で確定）';
  if (cursorKind === 'text') {
    return (detail.approval?.questions ?? []).length > 0
      ? '補足を書く（Enter で確定。任意）'
      : '回答を書く（Enter で確認へ）';
  }
  return '（「その他」か補足の行で Space を押すと、ここに書ける）';
}
