// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential } from './auth.js';
import { loadApprovalDrafts, saveApprovalDrafts } from './approval-drafts.js';
import {
  chatDraftEpoch,
  clearChatDrafts,
  loadChatDraft,
  loadChatDraftMark,
  loadEditDrafts,
  saveChatDraft,
  saveChatDraftMark,
  saveEditDraft,
} from './chat-drafts.js';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  sessionStorage.clear();
});

describe('チャットの書きかけの本文（#3400）', () => {
  it('会話ごとに残り、新しい会話（id 無し）は別の鍵', () => {
    saveChatDraft('conv-a', 'A の書きかけ');
    saveChatDraft(undefined, '新しい会話の書きかけ');
    expect(loadChatDraft('conv-a')).toBe('A の書きかけ');
    expect(loadChatDraft('conv-b')).toBe('');
    expect(loadChatDraft(undefined)).toBe('新しい会話の書きかけ');
  });

  it('空にしたら鍵ごと消える', () => {
    saveChatDraft('conv-a', 'x');
    saveChatDraft('conv-a', '');
    expect(sessionStorage.length).toBe(0);
  });

  it('全部消す（ログアウト）。ほかの鍵には触れない', () => {
    saveChatDraft('conv-a', 'x');
    saveChatDraft(undefined, 'y');
    sessionStorage.setItem('other', 'keep');
    clearChatDrafts();
    expect(loadChatDraft('conv-a')).toBe('');
    expect(loadChatDraft(undefined)).toBe('');
    expect(sessionStorage.getItem('other')).toBe('keep');
  });

  it('資格情報を捨てると、書きかけも消える', () => {
    saveChatDraft('conv-a', 'x');
    storeCredential('http://daemon.test', null);
    expect(loadChatDraft('conv-a')).toBe('');
  });

  it('保存先が投げても、何も起きない（書きかけを残せないだけ）', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() => saveChatDraft('conv-a', 'x')).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(loadChatDraft('conv-a')).toBe('');
  });
});

describe('承認カードの書きかけもログアウトで消す（#3706）', () => {
  it('ログアウトで alteroid.approvalDrafts も消える（ほかの鍵は残る）', () => {
    saveApprovalDrafts({ texts: { 'ap-1': '前の人の回答' }, questions: {} });
    sessionStorage.setItem('alteroid.approvalLeftovers', '{}');
    sessionStorage.setItem('other', 'keep');
    storeCredential('http://daemon.test', null);
    expect(sessionStorage.getItem('alteroid.approvalDrafts')).toBeNull();
    expect(sessionStorage.getItem('alteroid.approvalLeftovers')).toBeNull();
    expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} });
    expect(sessionStorage.getItem('other')).toBe('keep');
  });

  it('待っている書き込みは、決めた時点の epoch が今と違えば（ログアウトを挟んだ）書かない', () => {
    const epoch = chatDraftEpoch();
    saveApprovalDrafts({ texts: { 'ap-1': 'x' }, questions: {} }, epoch);
    expect(loadApprovalDrafts().texts).toEqual({ 'ap-1': 'x' });
    clearChatDrafts();
    saveApprovalDrafts({ texts: { 'ap-1': '書き戻し' }, questions: {} }, epoch);
    expect(loadApprovalDrafts().texts).toEqual({});
    saveApprovalDrafts({ texts: { 'ap-1': '新しい' }, questions: {} }, chatDraftEpoch());
    expect(loadApprovalDrafts().texts).toEqual({ 'ap-1': '新しい' });
  });
});

describe('編集の書きかけ（#3707）', () => {
  const meta = {
    id: 'att-1',
    name: 'a.png',
    mediaType: 'image/png',
    size: 4,
    sha256: 'a'.repeat(64),
  };

  it('発言の id を鍵に、本文と添付の控えを残して読み戻す。消せる', () => {
    saveEditDraft('m1', { text: '直した', attachments: [meta] });
    saveEditDraft('m2', { text: '別', attachments: [] });
    expect(loadEditDrafts()).toEqual(
      new Map([
        ['m1', { text: '直した', attachments: [meta] }],
        ['m2', { text: '別', attachments: [] }],
      ]),
    );
    saveEditDraft('m1', undefined);
    expect([...loadEditDrafts().keys()]).toEqual(['m2']);
  });

  it('壊れた値は読み飛ばし、ほかを巻き込まない。本文の鍵とも混ざらない', () => {
    sessionStorage.setItem('alteroid.editDraft:bad', '{oops');
    sessionStorage.setItem('alteroid.editDraft:bad2', JSON.stringify({ text: 1 }));
    sessionStorage.setItem(
      'alteroid.editDraft:bad3',
      JSON.stringify({ text: 'x', attachments: [1] }),
    );
    saveEditDraft('ok', { text: 'x', attachments: [] });
    saveChatDraft('conv-a', 'body');
    expect([...loadEditDrafts().keys()]).toEqual(['ok']);
  });

  it('ログアウトで消える', () => {
    saveEditDraft('m1', { text: '直した', attachments: [meta] });
    storeCredential('http://daemon.test', null);
    expect(loadEditDrafts().size).toBe(0);
  });
});

describe('入力欄へ戻した文の印（#3708）', () => {
  it('保存して読み戻せる。新しい会話（id 無し）は別の鍵', () => {
    saveChatDraftMark('conv-a', { clientMessageId: 'cm-1', unconfirmed: true, supersedes: 'j1' });
    expect(loadChatDraftMark('conv-a')).toEqual({
      clientMessageId: 'cm-1',
      unconfirmed: true,
      supersedes: 'j1',
    });
    expect(loadChatDraftMark(undefined)).toBeUndefined();
    saveChatDraftMark(undefined, { clientMessageId: 'cm-2', unconfirmed: true });
    expect(loadChatDraftMark(undefined)?.clientMessageId).toBe('cm-2');
    saveChatDraftMark('conv-a', undefined);
    expect(loadChatDraftMark('conv-a')).toBeUndefined();
  });

  it('本文の鍵（古い形の平文の値）は変えない。印が無ければ普通の下書きのまま', () => {
    sessionStorage.setItem('alteroid.chatDraft:conv-a', '古い形の下書き');
    expect(loadChatDraft('conv-a')).toBe('古い形の下書き');
    expect(loadChatDraftMark('conv-a')).toBeUndefined();
  });

  it('壊れた・知らない形の値は無いものとして読む。意味のある印が無ければ無い', () => {
    sessionStorage.setItem('alteroid.chatDraftMark:a', 'not json');
    sessionStorage.setItem('alteroid.chatDraftMark:b', '[1]');
    sessionStorage.setItem(
      'alteroid.chatDraftMark:c',
      JSON.stringify({ unconfirmed: 'yes', clientMessageId: 3 }),
    );
    sessionStorage.setItem(
      'alteroid.chatDraftMark:d',
      JSON.stringify({ v: 9, unconfirmed: true, future: 1 }),
    );
    for (const id of ['a', 'b', 'c']) expect(loadChatDraftMark(id)).toBeUndefined();
    expect(loadChatDraftMark('d')).toEqual({ unconfirmed: true });
  });

  it('ログアウトで消える', () => {
    saveChatDraftMark('conv-a', { unconfirmed: true });
    storeCredential('http://daemon.test', null);
    expect(loadChatDraftMark('conv-a')).toBeUndefined();
  });
});
