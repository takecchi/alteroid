// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readStoredRecord, writeStored } from './session-store.js';

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  sessionStorage.clear();
});

describe('readStoredRecord', () => {
  it('レコードならそのまま返す', () => {
    sessionStorage.setItem('k', '{"a":1}');
    expect(readStoredRecord('k')).toEqual({ a: 1 });
  });

  it('鍵が無い・JSON が壊れている・レコードでない、のどれでも undefined', () => {
    expect(readStoredRecord('none')).toBeUndefined();
    sessionStorage.setItem('k', '{oops');
    expect(readStoredRecord('k')).toBeUndefined();
    for (const raw of ['[1]', 'null', '"text"', '7']) {
      sessionStorage.setItem('k', raw);
      expect(readStoredRecord('k')).toBeUndefined();
    }
  });

  it('保存先が投げても、投げずに undefined', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('SecurityError');
    };
    try {
      expect(() => readStoredRecord('k')).not.toThrow();
      expect(readStoredRecord('k')).toBeUndefined();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe('writeStored', () => {
  it('書き、undefined で鍵を消す', () => {
    writeStored('k', 'v');
    expect(sessionStorage.getItem('k')).toBe('v');
    writeStored('k', undefined);
    expect(sessionStorage.getItem('k')).toBeNull();
  });

  it('保存先が投げても黙る（書くときも消すときも）', () => {
    const originalSet = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    Storage.prototype.removeItem = () => {
      throw new Error('SecurityError');
    };
    try {
      expect(() => writeStored('k', 'v')).not.toThrow();
      expect(() => writeStored('k', undefined)).not.toThrow();
    } finally {
      Storage.prototype.setItem = originalSet;
      Storage.prototype.removeItem = originalRemove;
    }
  });
});
