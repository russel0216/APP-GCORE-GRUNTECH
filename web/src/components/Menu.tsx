import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

/*
  The one small menu (2026-10-08): the board's "+ New" and card moves, and
  every list's "..." menu. Put it inside an element with `.menu-wrap` (or
  the board's `.pipe-menu-wrap`) so it opens under its button.
*/

/**
 * A small `role=menu`: focus lands on the first item, ↑/↓ (and Home/End)
 * cycle, Escape or a click elsewhere closes it and the caller puts focus back.
 */
export function Menu({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      onClose();
    }
  }

  return (
    <div ref={ref} className="menu-pop" role="menu" aria-label={label} onKeyDown={onKey}>
      {children}
    </div>
  );
}
