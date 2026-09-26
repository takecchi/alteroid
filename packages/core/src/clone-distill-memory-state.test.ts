import { describe, expect, it } from 'vitest';

import { CloneDistillMemoryState } from './clone-distill-memory-state.js';
import type { MemoryDocument } from './schema.js';

/**
 * `clone-distill-memory-state.ts` の歯。**純粋なクラスなので I/O のモック無しで
 * 全分岐に通せる**（`clone-redelivery-state.test.ts` / `runner-sdk-session.test.ts`
 * と同じ作法。前例は PR #1532 / #1611）。
 *
 * ここが固定するのは、切り出した12フィールドの**状態の器としての性質**
 * ——サイズの記録・tick の差分・消費する読み4本（文脈窓の断り・索引の載せ
 * 直し・resume の断り・蒸留の区間の断り）・記憶の写しの差分と差し替えである。
 * `Clone` が「いつ呼ぶか・断り書きの文面・蒸留を投げるかどうか」を決める
 * 判断は `clone.test.ts`（ブラックボックス）が引き続き持つ——ここでは扱わない。
 */

/**
 * テスト用の最小の `MemoryDocument`。このクラスが実際に読むのは `slug` /
 * `content` の2本だけ（`diffAgainstRecorded` / `commitMemory` の実装を見よ）
 * なので、他の必須フィールド（`title` / `updatedAt` 等）はここでは要らない
 * ——`unknown` 経由でキャストする（`runner-resume-state.test.ts` の
 * `beginResume` のフィクスチャと同じ作法）。
 */
function doc(slug: string, content: string): MemoryDocument {
  return { slug, content } as unknown as MemoryDocument;
}

describe('CloneDistillMemoryState — 初期状態', () => {
  it('生成直後はサイズ0、tick の記録は null', () => {
    const s = new CloneDistillMemoryState();
    expect(s.systemPromptChars).toBe(0);
    expect(s.promptMemoryChars).toBe(0);
    expect(s.lastTickMemoryFloorChars).toBeNull();
    expect(s.lastTickMemoryBaselineChars).toBeNull();
  });

  it('生成直後は transcriptPath が null', () => {
    const s = new CloneDistillMemoryState();
    expect(s.transcriptPath).toBeNull();
  });

  it('生成直後は文脈窓の断り・索引の載せ直しの印がどちらも立っていない（false）', () => {
    const s = new CloneDistillMemoryState();
    expect(s.takeContextWindowFoldNoticePending()).toBe(false);
    expect(s.takeMemoryIndexRefreshPending()).toBe(false);
  });

  it('生成直後は hasUndistilledActivity が true（初期値は蒸留する側に倒す）', () => {
    const s = new CloneDistillMemoryState();
    expect(s.hasUndistilledActivity).toBe(true);
  });

  it('生成直後は resumedHistoryHasMemory が false、distillGapNoticePending が true', () => {
    const s = new CloneDistillMemoryState();
    expect(s.takeResumedHistoryHasMemory()).toBe(false);
    expect(s.takeDistillGapNoticePending()).toBe(true);
  });

  it('bootAt は生成時刻の ISO 文字列で、読み直しても変わらない', () => {
    const s = new CloneDistillMemoryState();
    const first = s.bootAt;
    expect(() => new Date(first)).not.toThrow();
    expect(s.bootAt).toBe(first);
  });
});

describe('CloneDistillMemoryState — recordBuiltSizes（#buildOptions が呼ぶ）', () => {
  it('systemPromptChars / promptMemoryChars をまとめて立てる', () => {
    const s = new CloneDistillMemoryState();
    s.recordBuiltSizes(1234, 567);
    expect(s.systemPromptChars).toBe(1234);
    expect(s.promptMemoryChars).toBe(567);
  });

  it('呼び直すと上書きされる', () => {
    const s = new CloneDistillMemoryState();
    s.recordBuiltSizes(1234, 567);
    s.recordBuiltSizes(1, 2);
    expect(s.systemPromptChars).toBe(1);
    expect(s.promptMemoryChars).toBe(2);
  });
});

describe('CloneDistillMemoryState — recordTick（#memoryFloorDigestLine が末尾で呼ぶ）', () => {
  it('floorChars / baselineChars をまとめて立てる', () => {
    const s = new CloneDistillMemoryState();
    s.recordTick(100, 50);
    expect(s.lastTickMemoryFloorChars).toBe(100);
    expect(s.lastTickMemoryBaselineChars).toBe(50);
  });

  it('測れなかった回は呼ばれない前提なので、呼ばなければ null のまま残る', () => {
    const s = new CloneDistillMemoryState();
    expect(s.lastTickMemoryFloorChars).toBeNull();
    expect(s.lastTickMemoryBaselineChars).toBeNull();
  });
});

describe('CloneDistillMemoryState — transcriptPath（setTranscriptPath / clearTranscriptPath）', () => {
  it('setTranscriptPath で値を持ち、上書きできる', () => {
    const s = new CloneDistillMemoryState();
    s.setTranscriptPath('/tmp/a.jsonl');
    expect(s.transcriptPath).toBe('/tmp/a.jsonl');
    s.setTranscriptPath('/tmp/b.jsonl');
    expect(s.transcriptPath).toBe('/tmp/b.jsonl');
  });

  it('clearTranscriptPath で null へ戻す（#ensureQuery が新しいセッションのたびに呼ぶ）', () => {
    const s = new CloneDistillMemoryState();
    s.setTranscriptPath('/tmp/a.jsonl');
    s.clearTranscriptPath();
    expect(s.transcriptPath).toBeNull();
  });
});

describe('CloneDistillMemoryState — 文脈窓で畳んだ断り（arm / take、消費する読み）', () => {
  it('armContextWindowFoldNotice で立ち、takeContextWindowFoldNoticePending で読んで下ろす', () => {
    const s = new CloneDistillMemoryState();
    s.armContextWindowFoldNotice();
    expect(s.takeContextWindowFoldNoticePending()).toBe(true);
    // 消費した後は false のまま。
    expect(s.takeContextWindowFoldNoticePending()).toBe(false);
  });

  it('立てていなければ false', () => {
    const s = new CloneDistillMemoryState();
    expect(s.takeContextWindowFoldNoticePending()).toBe(false);
  });

  it('何度でも立て直せる（文脈窓では再び畳むことがある）', () => {
    const s = new CloneDistillMemoryState();
    s.armContextWindowFoldNotice();
    expect(s.takeContextWindowFoldNoticePending()).toBe(true);
    s.armContextWindowFoldNotice();
    expect(s.takeContextWindowFoldNoticePending()).toBe(true);
  });
});

describe('CloneDistillMemoryState — 記憶の索引の載せ直し（arm / take、消費する読み）', () => {
  it('armMemoryIndexRefresh で立ち、takeMemoryIndexRefreshPending で読んで下ろす', () => {
    const s = new CloneDistillMemoryState();
    s.armMemoryIndexRefresh();
    expect(s.takeMemoryIndexRefreshPending()).toBe(true);
    expect(s.takeMemoryIndexRefreshPending()).toBe(false);
  });

  it('#buildOptions は戻り値を使わず、無条件に下ろすためだけに呼べる', () => {
    const s = new CloneDistillMemoryState();
    s.armMemoryIndexRefresh();
    // 戻り値を捨てても、状態としては下りている。
    s.takeMemoryIndexRefreshPending();
    expect(s.takeMemoryIndexRefreshPending()).toBe(false);
  });
});

describe('CloneDistillMemoryState — hasUndistilledActivity（markActivity / markDistilled）', () => {
  it('markActivity で true になる（既に true でも無害）', () => {
    const s = new CloneDistillMemoryState();
    expect(s.hasUndistilledActivity).toBe(true);
    s.markDistilled();
    expect(s.hasUndistilledActivity).toBe(false);
    s.markActivity();
    expect(s.hasUndistilledActivity).toBe(true);
  });

  it('markDistilled で false になる', () => {
    const s = new CloneDistillMemoryState();
    s.markDistilled();
    expect(s.hasUndistilledActivity).toBe(false);
  });
});

describe('CloneDistillMemoryState — resumedHistoryHasMemory（setResumedHistoryHasMemory / take、消費する読み）', () => {
  it('setResumedHistoryHasMemory(true) の後は take で true、消費後は false', () => {
    const s = new CloneDistillMemoryState();
    s.setResumedHistoryHasMemory(true);
    expect(s.takeResumedHistoryHasMemory()).toBe(true);
    expect(s.takeResumedHistoryHasMemory()).toBe(false);
  });

  it('setResumedHistoryHasMemory(false) の後は take で false', () => {
    const s = new CloneDistillMemoryState();
    s.setResumedHistoryHasMemory(false);
    expect(s.takeResumedHistoryHasMemory()).toBe(false);
  });
});

describe('CloneDistillMemoryState — distillGapNoticePending（消費する読み。再び立てる口は無い）', () => {
  it('生成直後は true。take で読んで下ろすと、以後は false のまま', () => {
    const s = new CloneDistillMemoryState();
    expect(s.takeDistillGapNoticePending()).toBe(true);
    expect(s.takeDistillGapNoticePending()).toBe(false);
  });
});

describe('CloneDistillMemoryState — diffAgainstRecorded（読むだけ。#memoryOnRecord には触れない）', () => {
  it('記録が空のとき、渡した全文書が changed になる', () => {
    const s = new CloneDistillMemoryState();
    const docs = [doc('a', 'A'), doc('b', 'B')];
    const { changed, removed } = s.diffAgainstRecorded(docs);
    expect(changed).toEqual(docs);
    expect(removed).toEqual([]);
  });

  it('commitMemory で記録した後、同じ内容を渡すと changed / removed は両方空', () => {
    const s = new CloneDistillMemoryState();
    const docs = [doc('a', 'A')];
    s.commitMemory(docs);
    const { changed, removed } = s.diffAgainstRecorded(docs);
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('内容が変わった文書だけが changed に載る', () => {
    const s = new CloneDistillMemoryState();
    s.commitMemory([doc('a', 'A'), doc('b', 'B')]);
    const { changed, removed } = s.diffAgainstRecorded([doc('a', 'A'), doc('b', 'B2')]);
    expect(changed).toEqual([doc('b', 'B2')]);
    expect(removed).toEqual([]);
  });

  it('記録に在って渡された集合に無い slug は removed に載る', () => {
    const s = new CloneDistillMemoryState();
    s.commitMemory([doc('a', 'A'), doc('b', 'B')]);
    const { changed, removed } = s.diffAgainstRecorded([doc('a', 'A')]);
    expect(changed).toEqual([]);
    expect(removed).toEqual(['b']);
  });

  it('diffAgainstRecorded を呼んだだけでは #memoryOnRecord は変わらない（読むだけ）', () => {
    const s = new CloneDistillMemoryState();
    const first = [doc('a', 'A')];
    s.commitMemory(first);
    // 変わった内容で diff だけを呼ぶ。
    s.diffAgainstRecorded([doc('a', 'CHANGED')]);
    // まだ commitMemory していないので、記録は "A" のままのはず——
    // 次の diff で再び "CHANGED" が changed に出ることで確かめる。
    const { changed } = s.diffAgainstRecorded([doc('a', 'CHANGED')]);
    expect(changed).toEqual([doc('a', 'CHANGED')]);
  });
});

describe('CloneDistillMemoryState — commitMemory（退避してから差し替える）', () => {
  it('初回は空の Map を返し、渡した文書で記録を埋める', () => {
    const s = new CloneDistillMemoryState();
    const seenBefore = s.commitMemory([doc('a', 'A')]);
    expect(seenBefore.size).toBe(0);
    // 埋まったことは diffAgainstRecorded で確認する。
    const { changed } = s.diffAgainstRecorded([doc('a', 'A')]);
    expect(changed).toEqual([]);
  });

  it('2回目は、1回目に積んだ内容をそのまま返す（退避）', () => {
    const s = new CloneDistillMemoryState();
    s.commitMemory([doc('a', 'A')]);
    const seenSecond = s.commitMemory([doc('a', 'A2')]);
    expect(seenSecond.get('a')).toBe('A');
  });

  it('渡さなかった文書は記録から消える（丸ごと差し替え）', () => {
    const s = new CloneDistillMemoryState();
    s.commitMemory([doc('a', 'A'), doc('b', 'B')]);
    s.commitMemory([doc('a', 'A')]);
    const { removed } = s.diffAgainstRecorded([doc('a', 'A')]);
    // 既に b は無いので、これ以上 removed には出ない（前回の commitMemory で消えている）。
    expect(removed).toEqual([]);
  });
});

describe('CloneDistillMemoryState — forgetMemory（クリアだけ。差し替えない）', () => {
  it('forgetMemory の後、全文書が changed として戻る', () => {
    const s = new CloneDistillMemoryState();
    s.commitMemory([doc('a', 'A')]);
    s.forgetMemory();
    const { changed } = s.diffAgainstRecorded([doc('a', 'A')]);
    expect(changed).toEqual([doc('a', 'A')]);
  });

  it('forgetMemory した直後に commitMemory すると、返る退避は空である', () => {
    const s = new CloneDistillMemoryState();
    s.commitMemory([doc('a', 'A')]);
    s.forgetMemory();
    const seen = s.commitMemory([doc('a', 'A2')]);
    expect(seen.size).toBe(0);
  });
});
