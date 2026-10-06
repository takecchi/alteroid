// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential } from './auth.js';
import { clearChatDrafts, loadChatDraft, saveChatDraft } from './chat-drafts.js';

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
