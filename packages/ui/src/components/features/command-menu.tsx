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
  value: string;
  label: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  keywords?: string[];
}

export interface CommandMenuGroup {
  heading: string;
  items: readonly CommandMenuItem[];
}

// 開け閉めとキーの割り当ては呼ぶ側が持つ: この層はルーターも大域のキーも知らないため
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
