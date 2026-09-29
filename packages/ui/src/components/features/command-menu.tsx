import type { ComponentType } from 'react';

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

export interface CommandMenuItem {
  /** 選んだときに `onSelect` へ渡る値（行き先の URL など）。 */
  value: string;
  label: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** 名前以外で引っかけたい語（「費用」で「利用状況」を出す、など）。 */
  keywords?: string[];
}

export interface CommandMenuGroup {
  heading: string;
  items: readonly CommandMenuItem[];
}

/**
 * 名前を打って行き先・操作へ飛ぶ（⌘K の窓）。
 *
 * 行き先は20を超えていて、脇の面を上から目で追うより打ったほうが早い。
 * **脇の面の代わりではない** — 何があるかを知らない人は一覧を見るしかないので、
 * 両方に同じ行き先を置く（呼ぶ側が同じ配列から作る）。
 *
 * 開け閉めとキーの割り当ては呼ぶ側が持つ（この層はルーターも大域のキーも知らない）。
 */
export function CommandMenu({
  open,
  onOpenChange,
  groups,
  onSelect,
  placeholder = '行き先や操作の名前を打つ',
  emptyText = '当てはまるものが無い',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandMenuGroup[];
  onSelect: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="行き先を探す"
      description="名前を打って、行き先か操作を選ぶ"
    >
      <Command>
        <CommandInput placeholder={placeholder} />
        <CommandList>
          <CommandEmpty>{emptyText}</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group.heading} heading={group.heading}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.value}
                    value={`${item.label} ${item.value}`}
                    keywords={item.keywords}
                    onSelect={() => {
                      onSelect(item.value);
                      onOpenChange(false);
                    }}
                  >
                    {Icon !== undefined && <Icon aria-hidden />}
                    {item.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
