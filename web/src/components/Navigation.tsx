import { createContext, useContext, useEffect, useId, type ReactNode } from 'react';

/*
  Back, and leaving with unsaved changes — the two things every page needs and
  no page should draw for itself (2026-10-09, the owner's call: "uniformity of
  button location — modify, delete, back").

  BACK is drawn by the Shell, top-left, above the page's header, on every page
  deeper than its menu entry: "← Back to Quotations". A page whose natural way
  back is somewhere else says so with `useBackLink(to, label)` — an editor
  goes back to the record it is editing, a progress report to its project.
  No page draws its own Back button or a breadcrumb that repeats it.

  UNSAVED CHANGES: a page holding edits calls `useUnsavedChanges(dirty)`.
  While it is true, any link the person clicks inside the app (the Back link,
  the menu, a link in the page) stops and asks first, in one bar at the foot
  of the screen, and closing the tab or reloading asks through the browser.
*/

export interface BackTarget {
  to: string;
  label: string;
}

export interface NavigationApi {
  setBack: (owner: string, target: BackTarget | null) => void;
  setDirty: (owner: string, dirty: boolean) => void;
}

export const NavigationContext = createContext<NavigationApi>({
  setBack: () => {},
  setDirty: () => {},
});

export function NavigationProvider({ value, children }: { value: NavigationApi; children: ReactNode }) {
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/**
 * Where "← Back to …" goes from this page, when it is not the menu entry's
 * list: the record an editor is editing, the project a report belongs to.
 * Pass nothing (or null) to keep the Shell's own.
 */
export function useBackLink(to: string | null | undefined, label: string | null | undefined) {
  const { setBack } = useContext(NavigationContext);
  const owner = useId();
  useEffect(() => {
    if (!to || !label) return;
    setBack(owner, { to, label });
    return () => setBack(owner, null);
  }, [owner, to, label, setBack]);
}

/**
 * Holds the person on the page while `dirty`: links inside the app ask first,
 * and the browser asks before the tab closes or reloads. Set it false the
 * moment the save succeeds, before navigating away.
 */
export function useUnsavedChanges(dirty: boolean) {
  const { setDirty } = useContext(NavigationContext);
  const owner = useId();
  useEffect(() => {
    setDirty(owner, dirty);
    return () => setDirty(owner, false);
  }, [owner, dirty, setDirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
