/**
 * 画面が使う型。**すべて生成 spec から導出する。**
 *
 * 手で書き写した型を置くと `apps/daemon/openapi.json` と二重管理になり、必ずずれる
 * （api-client がそうしないのと同じ理由）。経路が変われば、ここが壊れて気づく。
 */
import type { JournalEntry, paths } from '@alteroid/api-client';

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<T> = T extends { responses: { 200: infer R } } ? Json<R> : never;

export type { ChatStreamEvent, JournalEntry } from '@alteroid/api-client';

export type JournalEntryType = JournalEntry['type'];

export type ManagerSummary = Ok<paths['/managers']['get']>['managers'][number];
export type ManagerStatus = ManagerSummary['status'];

export type PendingApproval = Ok<paths['/approvals']['get']>['approvals'][number];

export type DailyReport = Ok<paths['/reports']['get']>['reports'][number];

export type ScheduleEntry = Ok<paths['/schedule']['get']>['entries'][number];

export type MemorySummary = Ok<paths['/memory']['get']>['documents'][number];
export type MemoryDocument = Ok<paths['/memory/{slug}']['get']>['document'];

export type ConversationSummary = Ok<paths['/conversations']['get']>['conversations'][number];
export type ConversationDetail = Ok<paths['/conversations/{id}']['get']>;
export type ConversationMessage = ConversationDetail['messages'][number];

export type RunnerSummary = Ok<paths['/runners']['get']>['runners'][number];

export type Health = Ok<paths['/health']['get']>;
