import { useRef, useState } from 'react';
import { Menu } from './Menu';

export interface ToolsMenuItem {
  label: string;
  /** A short line under the label saying what it does. */
  hint?: string;
  onSelect: () => void;
}

/**
 * The ⋯ menu at the right end of a screen's toolbar (2026-11-17, the owner's
 * call: "the 3 dot button should be standard and can be viewed in all menu").
 * The same button and menu a list's toolbar carries (DataList), for a screen
 * that is not a list — the board, the forecast, the calendar.
 */
export function ToolsMenu({ items, label = 'More tools' }: { items: ToolsMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="menu-wrap tools-menu">
      <button
        ref={button}
        type="button"
        className="btn btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={items.map((i) => i.label.replace(/…$/, '')).join(', ')}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <Menu
          label={label}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
              {item.hint && <span className="menu-pop-why">{item.hint}</span>}
            </button>
          ))}
        </Menu>
      )}
    </div>
  );
}
