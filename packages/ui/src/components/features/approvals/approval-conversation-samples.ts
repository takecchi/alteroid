import type { ApprovalConversationMessage } from './approval-conversation';

const LONG_REPLY = [
  '確認したいことが3つある。',
  '1. 本番の DB へ migrate を当ててよいか（`usage_daily_key_idx` を作り直す）',
  '2. 当てているあいだ `/usage` が数秒遅くなるが、夜の release/prod より前に当ててよいか',
  '3. 戻すときは `down` を当てる。手順は PR の本文に書いた',
  'どれも記憶に根拠が無かったので、承認待ちに上げた。',
  '答えが来るまでは、ほかの作業（テストの書き足し・Issue の整理）を進めておく。',
].join('\n');

/** 見本帳の「長い会話」。同じ会話から確認がいくつも上がった形を作る。 */
export const LONG_CONVERSATION: ApprovalConversationMessage[] = [
  { id: 'm1', role: 'inbound', text: '索引が遅いので作り直して' },
  { id: 'm2', role: 'outbound', text: LONG_REPLY },
  { id: 'm3', role: 'inbound', text: '1 と 2 は進めてよい。3 は手順を見てから決める' },
  { id: 'm4', role: 'outbound', text: LONG_REPLY },
  { id: 'm5', role: 'inbound', text: '手順を読んだ。進めてよい' },
  {
    id: 'm6',
    role: 'outbound',
    text: 'migrate を当てた。続けて、通知先を変える件で確認を上げた。\n'.repeat(5).trim(),
  },
  { id: 'm7', role: 'inbound', text: 'わかった' },
];
