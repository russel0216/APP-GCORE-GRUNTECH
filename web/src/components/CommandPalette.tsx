import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Global search / command palette — Ctrl+K (model §8.3).
 *
 * One box over every record type the user is allowed to see, plus the
 * navigation they have access to. The point is that finding PO-2026-0142 never
 * requires first knowing that purchase orders live under G-CHAIN.
 */

interface Hit {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  link: string;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { me } = useAuth();

  // Navigation is searchable too — "where is receiving?" is the most common
  // thing anyone asks of a system this size.
  const navHits = useMemo<Hit[]>(() => {
    if (!me || term.trim().length < 2) return [];
    const q = term.toLowerCase();
    const out: Hit[] = [];
    for (const mod of me.menu) {
      for (const sub of mod.submodules) {
        const label = `${mod.label} › ${sub.label}`;
        if (label.toLowerCase().includes(q)) {
          out.push({ kind: 'nav', id: `${mod.key}.${sub.key}`, title: sub.label, subtitle: mod.label, link: sub.path });
        }
      }
    }
    return out.slice(0, 6);
  }, [term, me]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (term.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ hits: Hit[] }>(`/search${qs({ q: term })}`);
        if (!cancelled) setHits(res.hits);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term]);

  const all = useMemo(() => [...navHits, ...hits], [navHits, hits]);

  useEffect(() => setCursor(0), [all.length]);

  function go(hit: Hit) {
    onClose();
    navigate(hit.link);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, all.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    }
    if (e.key === 'Enter' && all[cursor]) {
      e.preventDefault();
      go(all[cursor]);
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, Hit[]>();
    for (const hit of all) {
      const list = map.get(hit.kind) ?? [];
      list.push(hit);
      map.set(hit.kind, list);
    }
    return [...map.entries()];
  }, [all]);

  const labels: Record<string, string> = {
    nav: 'Go to',
    user: 'People',
    approval: 'Approvals',
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search records, people, or jump to a screen…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-results">
          {term.trim().length < 2 ? (
            <div className="palette-group" style={{ padding: '18px' }}>
              Type at least two characters. Records you cannot open will not appear.
            </div>
          ) : loading && !all.length ? (
            <div className="palette-group" style={{ padding: '18px' }}>
              Searching…
            </div>
          ) : !all.length ? (
            <div className="palette-group" style={{ padding: '18px' }}>
              Nothing matched “{term}”.
            </div>
          ) : (
            grouped.map(([kind, list]) => (
              <div key={kind}>
                <div className="palette-group">{labels[kind] ?? kind}</div>
                {list.map((hit) => {
                  const index = all.indexOf(hit);
                  return (
                    <div
                      key={`${hit.kind}-${hit.id}`}
                      className={`palette-hit${index === cursor ? ' active' : ''}`}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => go(hit)}
                    >
                      <div>
                        <div className="title">{hit.title}</div>
                        {hit.subtitle && <div className="sub">{hit.subtitle}</div>}
                      </div>
                      <span className="kbd">↵</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
