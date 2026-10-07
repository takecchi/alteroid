import { describeManagerState } from '@alteroid/core';
import { Box, Text } from 'ink';
import type { FC } from 'react';

import { formatElapsedAgo } from '../format.js';
import type { ManagerRow, ManagerStatus } from './api.js';
import { oneLine } from './journal-format.js';
import { redactBody, sanitizeForTerminal } from '../redact.js';
import type { DetailState, ListState } from './managers-controller.js';
import { glyph, theme } from './theme.js';

export const DETAIL_HEAD_ROWS = 4;

const STATUS_LABEL: Record<ManagerStatus, string> = {
  running: '実行中',
  waiting_human: '人間待ち',
  // 「完了」と書かない: マネージャー自身のターンが終わって待機しているだけで、仕事が終わったとは限らない。
  done: '待機中',
  failed: '失敗',
  lost: 'セッションへ戻れず',
  stopped: '停止済み',
};

export function filterLabel(filter: ManagerStatus | null): string {
  return filter === null ? 'すべて' : (STATUS_LABEL[filter] ?? filter);
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

export function stateText(row: ManagerRow): string {
  return describeManagerState(row.status, row.live, row.awaitingBackground);
}

export function managerListLine(row: ManagerRow, now: number): string {
  const wait = row.waiting.length > 0 ? ` ⏸確認待ち${String(row.waiting.length)}` : '';
  // 組み立てたあとで掃除する: 状態の字面・id・経過など、redactBody を通らない欄も含むため
  return sanitizeForTerminal(
    `[${stateText(row)}] ${shortId(row.managerId)} ${formatElapsedAgo(row.updatedAt, now)}` +
      `${wait}  ${oneLine(redactBody(row.request), 120)}`,
  );
}

export function managerNotes(row: ManagerRow): string[] {
  const notes: string[] = [];
  // 先頭に置く: 確かめる前に起こし直すと取り返しがつかず、末尾が切れる狭い端末でも見えるようにするため
  if (row.runnerVanished === true) {
    notes.push('宛先の器が名簿から消えている（状態は走行中のまま。確かめる前に起こし直さない）');
  }
  const first = row.waiting[0];
  if (first !== undefined) {
    notes.push(
      `返事待ち ${String(row.waiting.length)} 件: ${oneLine(redactBody(first.summary), 60)}` +
        '（答えるのは Web か alteroid chat の /reply /allow /deny）',
    );
  }
  if (row.status === 'lost') {
    notes.push(
      '前のセッションへ戻れなかった。成果が外へ出ていることがある — 起こし直す前に確かめる',
    );
  }
  if (row.runnerLostSince !== undefined) {
    notes.push(
      `宛先の器が ${row.runnerLostSince} 以降 名乗っていない（この委譲が失われたという意味ではない）`,
    );
  }
  if (row.sessionMissingSince !== undefined) {
    notes.push(
      `runner が ${row.sessionMissingSince} の時点でこの委譲のセッションを持っていなかった`,
    );
  }
  if (row.lastFailure !== undefined) {
    notes.push(
      `直近の失敗: ${sanitizeForTerminal(row.lastFailure.code)}（${sanitizeForTerminal(row.lastFailure.at)}）`,
    );
  }
  return notes.map(sanitizeForTerminal);
}

export function detailStatusText(
  detail: DetailState,
  hiddenBelow: number,
): { text: string; tone: 'dim' | 'warn' } {
  if (detail.confirmStop) {
    return {
      text: 'このマネージャーを止める? y で止める / それ以外のキーでやめる（この仕事だけが止まる）',
      tone: 'warn',
    };
  }
  // 後ろの状態を隠さず並べる: 操作結果（notice）は消える経路が無いため
  const parts: string[] = [];
  if (detail.notice !== null) parts.push(detail.notice);
  if (detail.error !== null) parts.push(`⚠ 取り直せなかった: ${detail.error}`);
  if (detail.notice !== null) {
    if (hiddenBelow > 0) parts.push(`↓ あと ${String(hiddenBelow)} 行`);
    return {
      text: sanitizeForTerminal(parts.join(' · ')),
      tone: detail.error !== null ? 'warn' : 'dim',
    };
  }
  if (detail.error !== null) return { text: sanitizeForTerminal(parts.join(' · ')), tone: 'warn' };
  if (detail.missing) return { text: 'このマネージャーは見つからない（404）', tone: 'warn' };
  if (hiddenBelow > 0) {
    return {
      text: `↓ あと ${String(hiddenBelow)} 行（PgDn で進む。末尾まで行くと追従に戻る）`,
      tone: 'dim',
    };
  }
  if (detail.transcriptStatus === 'loading') return { text: '生ログを読んでいる…', tone: 'dim' };
  if (detail.transcriptStatus === 'none') return { text: '生ログはまだ無い', tone: 'dim' };
  return { text: ' ', tone: 'dim' };
}

export function managerListTitle(list: ListState): string {
  if (list.status === 'loading' || list.status === 'idle') return '委譲を読んでいる…';
  if (list.status === 'error' && list.items.length === 0) {
    return '委譲を読めなかった（空ではない）。r で読み直す';
  }
  return `委譲（絞り: ${filterLabel(list.filter)} · ${String(list.items.length)} 件読み込み済み · 新しい順）`;
}

function listEmptyText(list: ListState): string {
  const unreadable = list.unreadable.length > 0;
  if (unreadable) {
    return list.filter === null
      ? '読めたマネージャーは無い（読めない行が在るので、居ないとは言えない）。'
      : '読めた範囲では、この状態のマネージャーは無い（読めない行の状態は分からない）。';
  }
  return list.filter === null
    ? 'まだ1体も起きていない。会話で依頼するか、発意 tick を待つ。'
    : 'この状態のマネージャーは無い（f で絞りを変えれば他の状態も出る）。';
}

export const ManagerList: FC<{ list: ListState; height: number }> = ({ list, height }) => {
  const { items, selected } = list;
  const unreadableLine =
    list.unreadable.length > 0
      ? `読めない委譲が ${String(list.unreadable.length)} 件ある（壊れた行であって、居ないのでも畳まれたのでもない。この一覧には載っていない）`
      : null;
  const errorLine = list.error !== null ? `⚠ ${list.error}` : null;
  const olderLine =
    list.older === 'progress'
      ? list.olderLoading
        ? '古い側を読んでいる…'
        : `m で古い側をもっと見る（いま ${String(items.length)} 件）`
      : list.older === 'blocked'
        ? `古い側へ自動では進めない（いま ${String(items.length)} 件。全部読み終えたのではない）。m でもう一度、f で絞りを変えると先頭から読み直す`
        : items.length > 0
          ? `これより古い委譲は無い（全 ${String(items.length)} 件）`
          : null;
  const fixed = 1 + (unreadableLine === null ? 0 : 1) + (errorLine === null ? 0 : 1) + 1;
  const cap = Math.max(1, height - fixed);
  const start = Math.min(Math.max(0, selected - cap + 1), Math.max(0, items.length - cap));
  const shown = items.slice(start, start + cap);
  const title = managerListTitle(list);
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
          <Box key={row.managerId} flexShrink={0}>
            <Text wrap="truncate-end" {...(index === selected ? { inverse: true } : {})}>
              {`${index === selected ? glyph.caret : ' '} ${managerListLine(row, list.loadedAt)}`}
            </Text>
          </Box>
        );
      })}
      <Text dimColor wrap="truncate-end">
        {olderLine ?? ' '}
      </Text>
    </Box>
  );
};

export const ManagerDetailHead: FC<{ detail: DetailState }> = ({ detail }) => {
  const m = detail.manager;
  if (m === null) {
    return (
      <Box flexDirection="column" height={DETAIL_HEAD_ROWS} flexShrink={0} overflow="hidden">
        <Text bold wrap="truncate-end">
          {sanitizeForTerminal(`${detail.id}  ${detail.missing ? '見つからない' : '読んでいる…'}`)}
        </Text>
        <Text> </Text>
        <Text> </Text>
        <Text> </Text>
      </Box>
    );
  }
  const notes = managerNotes(m);
  return (
    <Box flexDirection="column" height={DETAIL_HEAD_ROWS} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end">
        <Text bold>{sanitizeForTerminal(`[${stateText(m)}]`)}</Text>
        {sanitizeForTerminal(` ${m.managerId}`)}
      </Text>
      <Text wrap="truncate-end" dimColor>
        {sanitizeForTerminal(
          `${m.cwd}  作成 ${m.startedAt}  更新 ${formatElapsedAgo(m.updatedAt, detail.loadedAt)}`,
        )}
      </Text>
      <Text wrap="truncate-end">{`依頼: ${oneLine(redactBody(m.request), 300)}`}</Text>
      <Text wrap="truncate-end" color={theme.warn}>
        {notes.length > 0 ? sanitizeForTerminal(`⚠ ${notes.join(' / ')}`) : ' '}
      </Text>
    </Box>
  );
};

export const DetailStatusRow: FC<{ text: string; tone: 'dim' | 'warn' }> = ({ text, tone }) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end" {...(tone === 'warn' ? { color: theme.warn } : { dimColor: true })}>
      {text.length > 0 ? sanitizeForTerminal(text) : ' '}
    </Text>
  </Box>
);
