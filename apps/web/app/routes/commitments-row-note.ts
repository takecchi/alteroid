import { clipLine } from '~/lib/clip-line';
import type { Commitment } from '@alteroid/logic';

export interface RowNote {
  commitment: Commitment;
  draft?: string;
  reason?: string;
  editFailure?: unknown;
  closeFailure?: unknown;
  closedHere?: true;
}
export type RowNotePatch = Partial<Omit<RowNote, 'commitment'>>;

export function isEmptyNote(note: RowNote): boolean {
  return (
    note.draft === undefined &&
    note.reason === undefined &&
    note.editFailure === undefined &&
    note.closeFailure === undefined
  );
}

export function sameNote(a: RowNote, b: RowNote): boolean {
  return (
    a.commitment === b.commitment &&
    a.draft === b.draft &&
    a.reason === b.reason &&
    a.editFailure === b.editFailure &&
    a.closeFailure === b.closeFailure &&
    a.closedHere === b.closedHere
  );
}

export function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

const SNIPPET_MAX = 20;

export function snippet(body: string): string {
  return clipLine(body, SNIPPET_MAX);
}
