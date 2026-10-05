import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { useDisplayText } from '@/lib/display-text';

import { Badge, Button, Card, Textarea } from '../../common';
import { Markdown } from '../../markdown';
import { isSubmitShortcut } from '../chat/ime';
import { Timestamp } from '../timestamp';
import {
  ApprovalQuestionsForm,
  type ApprovalQuestionView,
  type ApprovalQuestionsAnswer,
} from './approval-questions';

export type ApprovalState = 'unanswered' | 'answered' | 'withdrawn';

/** 「許可」「却下」で送る文言。画面の既存の文言のまま（変えると回答の記録が変わる）。 */
export const APPROVAL_QUICK_ANSWERS = {
  allow: 'はい、進めてよい',
  deny: 'いいえ、やらないで',
} as const;

/**
 * 承認待ちの1件（クローンが人間に確かめたいこと）。
 *
 * - **クローンが書いた文字列（`question` / `context`）だけを Markdown で描く。**
 *   人間の回答（`answer`）は素のテキストのまま（自分が書いた文字が勝手に化けない
 *   ため。`chat-message.tsx` と同じ線）
 * - 状態の札は3つ: 未回答（注意）・回答済・取り下げ済。回答済みと取り下げ済みを
 *   混ぜない——前者は人間が応えた終端、後者はクローンが不要と判断した終端である
 * - 未回答のときだけ回答欄を出す。⌘/Ctrl + Enter で送る。IME の確定の Enter では
 *   送らない（`chat/ime.ts`）
 * - **設問つき（`questions`、issue #2525）の未回答は、回答欄の代わりに設問の要約1行と
 *   「選択肢を開いて答える」を出す。** 開くと選択肢のフォーム（`ApprovalQuestionsForm`）が出て、
 *   「回答」で `onSubmitQuestions` へ一括で渡す。一覧に設問を全文で並べない（詳細は開いた側）。
 *   許可・却下の定型文は出さない（複数の設問への「はい」は意味を持たない）。
 *   `questions` が無い・空なら、これまでの回答欄のまま
 * - `jobLink` はどのマネージャーの件かへのリンク（画面が `<Link>` で渡す）
 * - `footer` は回答済みのときの経緯（画面の `TracePanel`）などを置く口
 * - **省略可能な口（既定の振る舞いは変えない）。** 画面が今の表示をそのまま出せるように
 *   足した: `time`（時刻の位置に差し込む。渡すと `Timestamp` は出ない）・`isSubmitKey`
 *   （送るキーの判定。既定は `isSubmitShortcut`）・`trailing`（`error` の後ろ。カードの
 *   いちばん下）
 */
export function ApprovalCard({
  state,
  createdAt,
  createdLabel,
  time,
  jobLink,
  question,
  context,
  answer,
  answeredVia,
  withdrawnReason,
  draft = '',
  onDraftChange,
  onSubmit,
  busy = false,
  error,
  footer,
  trailing,
  isSubmitKey = isSubmitShortcut,
  questions,
  questionsSummary,
  onSubmitQuestions,
}: {
  state: ApprovalState;
  /** `time` を渡すときは要らない（渡しても使わない）。 */
  createdAt?: string;
  /** 「3 分前」（整形は呼ぶ側）。 */
  createdLabel?: string;
  /** 時刻の位置に差し込むもの。渡すと `Timestamp`（相対の表示と JST/UTC の tooltip）の代わりに出る。 */
  time?: ReactNode;
  jobLink?: ReactNode;
  question: string;
  context?: string;
  answer?: string;
  /** 回答経路の説明（記録が無い古い行では渡さない）。 */
  answeredVia?: string;
  withdrawnReason?: string;
  draft?: string;
  onDraftChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  busy?: boolean;
  error?: ReactNode;
  footer?: ReactNode;
  /** `error` の後ろ（カードのいちばん下）に置くもの。 */
  trailing?: ReactNode;
  /** 回答欄で「送る」キーかの判定。既定は `isSubmitShortcut`（IME の確定の Enter を除く）。 */
  isSubmitKey?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 設問つきの承認待ちの設問（無い・空なら普通の回答欄）。 */
  questions?: readonly ApprovalQuestionView[];
  /**
   * 設問の1行の要約（一覧・閉じた状態に出す）。**文言は呼ぶ側が作って渡す**（ui は logic も core も
   * import しない。定義は `@alteroid/core/approval-questions-format`、画面は `@alteroid/logic` の
   * `summarizeQuestions` から引く）。
   */
  questionsSummary?: string;
  /** 設問のフォームの「回答」で呼ぶ。 */
  onSubmitQuestions?: (answer: ApprovalQuestionsAnswer) => void;
}) {
  const { body } = useDisplayText();
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const hasQuestions = questions !== undefined && questions.length > 0;
  return (
    <Card className="p-4">
      {/*
        **本3 で `Badge` に `shrink-0` が入り、縮まなくなった。** メタ行の
        バッジ（未回答/回答済/取り下げ済）は文字数を持たないので普段は
        問題ないが、`job {jobId}` は `z.string()` に長さの上限が無く、他の
        バッジ・時刻表示と合わせて `flex-wrap` が無いと押し出す側へ振れる。
        承認待ちの画面の「まとめて送る」の帯
        （`grep -Fn -- 'mb-4 flex flex-wrap items-center gap-3' apps/web/app/routes/approvals.tsx`）に
        既に在る流儀へ揃える。

        **取り下げ済み（`accent`）を回答済み（`neutral`）と別のトーンにする
        （#963）。** 両方とも「もう待っていない」点は同じだが、次の一手が
        違う——回答済みは人間が既に応えた終端、取り下げ済みはクローンが
        自分で不要と判断した終端で、混同すると「答えたのに何も起きて
        いない」ように見える。
      */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Badge tone={state === 'withdrawn' ? 'accent' : state === 'answered' ? 'neutral' : 'warn'}>
          {state === 'withdrawn' ? '取り下げ済' : state === 'answered' ? '回答済' : '未回答'}
        </Badge>
        {time !== undefined ? (
          time
        ) : createdAt !== undefined ? (
          <Timestamp at={createdAt} label={createdLabel} />
        ) : null}
        {jobLink !== undefined && <span className="font-mono">{jobLink}</span>}
      </div>

      {/*
        **クローン（AI）が書いた文字列だけを Markdown で描く。** `question` は
        クローンが書いた設問なのでこの線の内側である（線そのものの根拠は下の
        `answer` の側のコメントに在る）。

        **`whitespace-pre-wrap` は外してよい。** `Markdown` は
        `mdast-util-newline-to-break`（`remark-breaks` の中身）を掛けていて単独の
        改行を `<br>` にするので、行区切りはこれまでどおり保たれる
        （`packages/ui/src/components/markdown.tsx` の doc に理由が逐語で在る）。
      */}
      <Markdown>{body(question)}</Markdown>

      {context !== undefined && context !== '' && (
        /*
          `context` もクローンが書いた文字列なので Markdown で描く。

          **スクロールの箱（`max-h-48 overflow-y-auto`）は残す。** 外すと長い背景が
          回答欄を画面外へ押し出す。`apps/web/app/routes/manager-detail.tsx` の
          `RequestCard` が同じ流儀 —
          **文字は1つも捨てず、スクロールへ閉じ込める。**

          `min-w-0` は中の表・コードブロックが `overflow-x-auto` で収まるため
          （`markdown.tsx` の `table` / `pre` が横スクロールを持つ）。`text-xs` は
          落とす — `Markdown` のルートが `text-sm` を持つので、外から掛けても効かない。
        */
        <div className="mt-2 max-h-48 min-w-0 overflow-y-auto rounded-md border border-border bg-background p-2 text-muted-foreground">
          <Markdown>{body(context)}</Markdown>
        </div>
      )}

      {state === 'withdrawn' ? (
        /*
          **クローンが取り下げた件（#963）。** 回答欄は出さない——回答済みの
          分岐と同じ理由で、取り下げも「もう入力を受け付ける状態ではない」
          終端である。`withdrawnReason` はクローンが書いた自由文だが、
          `answer`（人間の発言）と同じ枠に置くので素のテキストのままにする
          （Markdown にするかどうかで枠の意味を変えない）。
        */
        <p className="mt-3 rounded-md border border-border bg-background p-2 text-sm break-words whitespace-pre-wrap">
          <span className="mr-2 text-[11px] text-muted-foreground">取り下げた理由</span>
          {withdrawnReason === undefined ? '（理由の記録なし）' : body(withdrawnReason)}
        </p>
      ) : state === 'answered' ? (
        /*
          **`answer` は Markdown にしない。** これは人間が打った文だからである。
          repo の既存方針が `packages/ui/src/components/features/chat/chat-message.tsx`
          （`grep -Fn -- 'クローンの行だけを Markdown にする' packages/ui/src/components/features/chat/chat-message.tsx`）
          に逐語で在る —
          「**クローンの行だけを Markdown にする。** 人間が打った本文
          （`role === 'human'`）は素のテキストのままにする — 自分が書いた文字が
          勝手に化けないため」。`question` / `context` はクローンが書いた文字列
          なので線の内側だが、`answer` は外側である。**「承認待ちも全部 Markdown に
          しよう」と思ったら、まずその行を読むこと**
          （`grep -Fn -- '回答（answer）は Markdown の描画経路を通らない' apps/web/app/routes/approvals.test.tsx`
          がこの判断を押さえている）。

          **`whitespace-pre-wrap` は Markdown 化とは別の、不具合の修正である。**
          `packages/ui/src/styles.css` の `white-space` 指定は `pre` に対する1件だけで
          `p` を狙う規則が無いため、ここは CSS 既定の `white-space: normal` で
          描かれていた — 人間が改行を入れて答えても1行に潰れていた（`question` /
          `context` には効いていたのに `answer` だけ無いという見落としである）。
        */
        <>
          <p className="mt-3 rounded-md border border-border bg-background p-2 text-sm break-words whitespace-pre-wrap">
            <span className="mr-2 text-[11px] text-muted-foreground">回答</span>
            {answer === undefined ? undefined : body(answer)}
          </p>
          {answeredVia !== undefined && (
            <p className="mt-1 text-[11px] text-muted-foreground">回答経路: {answeredVia}</p>
          )}
        </>
      ) : hasQuestions ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {questionsSummary === undefined ? undefined : body(questionsSummary)}
            </span>
            <Button
              size="sm"
              aria-expanded={questionsOpen}
              onClick={() => setQuestionsOpen((open) => !open)}
            >
              {questionsOpen ? '閉じる' : '選択肢を開いて答える'}
            </Button>
          </div>
          {/* 閉じても入力は捨てない（unmount せず隠す）。 */}
          <div hidden={!questionsOpen}>
            <ApprovalQuestionsForm
              questions={questions}
              busy={busy}
              onSubmit={(answer) => onSubmitQuestions?.(answer)}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Textarea
            rows={2}
            value={draft}
            placeholder="答える（書いておくと「まとめて送る」の対象になる。この場ですぐ送ってもよい）"
            onChange={(event) => onDraftChange?.(event.target.value)}
            onKeyDown={(event) => {
              // 長文になりうるので Enter は改行のまま。送信は Cmd/Ctrl+Enter。
              if (isSubmitKey(event)) {
                event.preventDefault();
                if (draft.trim() !== '') onSubmit?.(draft);
              }
            }}
          />
          {/*
            **本3 で `Button` が狭い画面で `h-11`（44px）になり、以前より
            横幅を食う。** ボタン3つ＋ショートカット表示が横一列に並ぶこの行は
            折り返さないと画面外へ出る側へ振れるので `flex-wrap` を足す。
          */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={draft.trim() === ''}
              onClick={() => onSubmit?.(draft)}
            >
              回答する
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onSubmit?.(APPROVAL_QUICK_ANSWERS.allow)}
            >
              許可
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onSubmit?.(APPROVAL_QUICK_ANSWERS.deny)}
            >
              却下
            </Button>
            <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter</span>
          </div>
        </div>
      )}

      {footer}
      {error !== undefined && <div className="mt-2">{error}</div>}
      {trailing}
    </Card>
  );
}
