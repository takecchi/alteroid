import type { TurnInputText } from './turn-input.js';

export class CloneNotices {
  readonly #turn: Record<TurnNoticeKey, string> = {
    redelivery: '',
    superseded: '',
    validity: '',
    mergedBatchTruncation: '',
    commitment: '',
    situation: '',
  };

  // 文字列が違う1行は畳まない: 文言が変わるのは人間が知らない新しい事実で、新しい発言への返事を消すと「自分の発言だけがあって返信が無い」へ戻るため
  readonly #humanFailure = new Map<string, { text: string; folded: number }>();

  // manager.ts の Pool#usageNotices のように文言の集合にしない: こちらが畳むのは日誌への書き込みだけで、文言が交互に届いてもターンは焼かれないため
  // 畳むのは日誌だけにする: 2件目以降の合図は別の会話から来ているかもしれず、usage_limited まで畳むと送り主に何も見えなくなるため
  readonly #usage = new Map<string, string>();

  // 複数の断り書きをまとめて渡す形にしない: 6本は await を挟んで1本ずつ代入されることがあり、途中状態の見え方が変わるため
  set(key: TurnNoticeKey, text: string): void {
    this.#turn[key] = text;
  }

  forTurn(): Pick<TurnInputText, TurnNoticeKey> {
    return { ...this.#turn };
  }

  clearTurn(): void {
    for (const key of TURN_NOTICE_KEYS) this.#turn[key] = '';
  }

  foldHumanFailure(conversationId: string, text: string): number | null {
    const said = this.#humanFailure.get(conversationId);
    if (said !== undefined && said.text === text) {
      const folded = said.folded + 1;
      this.#humanFailure.set(conversationId, { text, folded });
      return folded;
    }
    this.#humanFailure.set(conversationId, { text, folded: 0 });
    return null;
  }

  // 会話をまたいで消さない: 別の会話で返してある1行の記憶が消え、そちらの試し直しでまた1行増えるため
  forgetConversation(conversationId: string): void {
    this.#humanFailure.delete(conversationId);
  }

  noteUsage(kind: string, text: string): boolean {
    if (this.#usage.get(kind) !== text) {
      this.#usage.set(kind, text);
      return true;
    }
    return false;
  }
}

// 断り書きを起点ごとに配らない: 組み立ての起点は散っていて、入れ忘れた起点にだけ断りの無いターンが生まれる。ターンの入口は1か所のため
export type TurnNoticeKey =
  'redelivery' | 'superseded' | 'validity' | 'mergedBatchTruncation' | 'commitment' | 'situation';

const TURN_NOTICE_KEYS: readonly TurnNoticeKey[] = [
  'redelivery',
  'superseded',
  'validity',
  'mergedBatchTruncation',
  'commitment',
  'situation',
];
