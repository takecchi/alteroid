import { describe, expect, it } from 'vitest';

import {
  describeQuestionLines,
  describeQuestionsViolation,
  describeSelectionsViolation,
  foldSelections,
  summarizeQuestions,
} from './approval-choices.js';
import type { ApprovalQuestion } from './schema.js';

const questions: ApprovalQuestion[] = [
  {
    id: 'target',
    prompt: 'デプロイ先',
    options: [
      { id: 'railway', label: 'Railway', recommended: true, description: '既存の基盤' },
      { id: 'fly', label: 'Fly.io' },
    ],
  },
  {
    id: 'notify',
    prompt: '通知先',
    multiple: true,
    allowOther: false,
    options: [
      { id: 'slack', label: 'Slack' },
      { id: 'mail', label: 'メール' },
    ],
  },
];

describe('describeQuestionsViolation（道具の入力の id 一意性）', () => {
  it('正しい設問は通す。選択肢の id が設問をまたいで同じなのは許す', () => {
    expect(describeQuestionsViolation(questions)).toBeNull();
    expect(
      describeQuestionsViolation([
        { id: 'a', prompt: 'p', options: [{ id: 'x', label: 'X' }] },
        { id: 'b', prompt: 'p', options: [{ id: 'x', label: 'X' }] },
      ]),
    ).toBeNull();
  });

  it('設問 id の重複を弾く', () => {
    const dup = [questions[0]!, { ...questions[1]!, id: 'target' }];
    expect(describeQuestionsViolation(dup)).toContain('"target"');
  });

  it('設問の中の選択肢 id の重複を弾く', () => {
    const dup: ApprovalQuestion[] = [
      {
        id: 'q',
        prompt: 'p',
        options: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      },
    ];
    expect(describeQuestionsViolation(dup)).toContain('"a"');
  });
});

describe('describeSelectionsViolation（selections と questions の突き合わせ）', () => {
  it('正しい回答は通す。答えの無い設問があってもよい（空配列も可）', () => {
    expect(
      describeSelectionsViolation(questions, [
        { questionId: 'target', optionIds: ['railway'], other: 'ただし来週' },
      ]),
    ).toBeNull();
    expect(describeSelectionsViolation(questions, [])).toBeNull();
    expect(
      describeSelectionsViolation(questions, [
        { questionId: 'notify', optionIds: ['slack', 'mail'] },
      ]),
    ).toBeNull();
    // 何も選ばず other だけ
    expect(
      describeSelectionsViolation(questions, [{ questionId: 'target', optionIds: [], other: 'x' }]),
    ).toBeNull();
  });

  it.each([
    ['questions が無い承認待ち', undefined, [{ questionId: 'target', optionIds: [] }], 'questions'],
    ['questions が空', [], [{ questionId: 'target', optionIds: [] }], 'questions'],
    ['知らない設問', questions, [{ questionId: 'nope', optionIds: [] }], 'nope'],
    ['知らない選択肢', questions, [{ questionId: 'target', optionIds: ['nope'] }], 'nope'],
    [
      '単一選択で2つ',
      questions,
      [{ questionId: 'target', optionIds: ['railway', 'fly'] }],
      '単一選択',
    ],
    [
      'allowOther:false に other',
      questions,
      [{ questionId: 'notify', optionIds: [], other: 'x' }],
      'allowOther',
    ],
    [
      '同じ設問が2回',
      questions,
      [
        { questionId: 'target', optionIds: ['railway'] },
        { questionId: 'target', optionIds: [] },
      ],
      '2回',
    ],
    [
      '同じ選択肢が2回',
      questions,
      [{ questionId: 'notify', optionIds: ['slack', 'slack'] }],
      '2回',
    ],
  ])('弾く: %s', (_label, qs, selections, mention) => {
    const violation = describeSelectionsViolation(qs, selections);
    expect(violation).not.toBeNull();
    expect(violation).toContain(mention);
  });

  it('allowOther の既定は true（other を書ける）', () => {
    expect(
      describeSelectionsViolation(
        [{ id: 'q', prompt: 'p', options: [{ id: 'a', label: 'A' }] }],
        [{ questionId: 'q', optionIds: [], other: '自由' }],
      ),
    ).toBeNull();
  });

  it('文言に人間が書いた other の本文を混ぜない', () => {
    const violation = describeSelectionsViolation(questions, [
      { questionId: 'notify', optionIds: [], other: 'SECRET-BODY' },
    ]);
    expect(violation).not.toContain('SECRET-BODY');
  });
});

describe('foldSelections（人間が読める文へ畳む）', () => {
  it('設問・選んだ選択肢のラベル・推奨の印・その他・補足が全部読める', () => {
    const folded = foldSelections(
      questions,
      [
        { questionId: 'target', optionIds: ['railway'], other: 'Fly も検討' },
        { questionId: 'notify', optionIds: ['slack', 'mail'] },
      ],
      '金曜は避けたい',
    );
    expect(folded).toBe(
      [
        'Q1 デプロイ先: (a) Railway［推奨］ / その他: Fly も検討',
        'Q2 通知先: (a) Slack / (b) メール',
        '補足: 金曜は避けたい',
      ].join('\n'),
    );
  });

  it('未回答の設問は「未回答」と出す。補足が無ければ補足の行は出さない', () => {
    const folded = foldSelections(questions, [{ questionId: 'notify', optionIds: ['mail'] }]);
    expect(folded).toBe('Q1 デプロイ先: 未回答\nQ2 通知先: (b) メール');
    expect(
      foldSelections(questions, [{ questionId: 'target', optionIds: [], other: '  ' }]),
    ).toContain('Q1 デプロイ先: 未回答');
  });

  it('選択肢の記号は設問の中の位置（推奨でない2番目は (b)）', () => {
    expect(foldSelections(questions, [{ questionId: 'target', optionIds: ['fly'] }])).toContain(
      'Q1 デプロイ先: (b) Fly.io',
    );
  });
});

describe('一覧と詳細の描き方', () => {
  it('一覧は件数だけ（本文を出さない）', () => {
    const line = summarizeQuestions(questions);
    expect(line).toContain('設問 2 件');
    expect(line).toContain('複数選択 1');
    expect(line).not.toContain('Railway');
  });

  it('詳細は id・推奨・単一/複数・その他の可否を出す', () => {
    const lines = describeQuestionLines(questions).join('\n');
    expect(lines).toContain('Q1 [id=target] デプロイ先（単一選択・その他を書ける）');
    expect(lines).toContain('(a) [id=railway] Railway［推奨］ — 既存の基盤');
    expect(lines).toContain('Q2 [id=notify] 通知先（複数選択可・その他は書けない）');
  });
});
