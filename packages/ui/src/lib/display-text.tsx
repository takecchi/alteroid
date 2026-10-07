import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export interface DisplayText {
  body: (text: string) => string;
  error: (text: string) => string;
}

const identity = (text: string): string => text;

const DEFAULT_DISPLAY_TEXT: DisplayText = { body: identity, error: identity };

const DisplayTextContext = createContext<DisplayText>(DEFAULT_DISPLAY_TEXT);

export function DisplayTextProvider({
  value,
  children,
}: {
  value: DisplayText;
  children: ReactNode;
}) {
  return <DisplayTextContext.Provider value={value}>{children}</DisplayTextContext.Provider>;
}

export function useDisplayText(): DisplayText {
  return useContext(DisplayTextContext);
}
