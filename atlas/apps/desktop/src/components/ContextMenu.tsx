import { useLayoutEffect, useRef, useState } from 'react';
import { useUiStore, type MenuItem } from '../store/ui';

// The single, app-global context menu (M14). Right-click handlers publish a
// position and an item list to the UI store; this host renders it as a native-
// feeling dark menu that closes on Escape, click-away, or after an item runs.
// Keyboard: up/down move, Enter activates, right/left open/close a submenu.
export function ContextMenuHost() {
  const menu = useUiStore((s) => s.contextMenu);
  const close = useUiStore((s) => s.closeContextMenu);
  if (!menu) return null;
  return (
    <Menu key={`${menu.x},${menu.y}`} x={menu.x} y={menu.y} items={menu.items} onClose={close} />
  );
}

// Indices of items that can hold keyboard focus (not separators, not disabled).
function focusable(items: MenuItem[]): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (!it.separator && !it.disabled) out.push(i);
  });
  return out;
}

function Menu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // Keyboard focus: the active top-level index, and the open submenu's active
  // index (null when focus is on the top level).
  const [active, setActive] = useState<number>(() => focusable(items)[0] ?? -1);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subActive, setSubActive] = useState<number>(-1);

  // Clamp the menu inside the viewport once its real size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - r.width - 4);
    const ny = Math.min(y, window.innerHeight - r.height - 4);
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) });
    el.focus();
  }, [x, y]);

  const activate = (item: MenuItem) => {
    if (item.separator || item.disabled) return;
    if (item.submenu) return; // parents open, they do not run
    item.onClick?.();
    onClose();
  };

  const move = (delta: number) => {
    const f = focusable(items);
    if (f.length === 0) return;
    const cur = f.indexOf(active);
    const nextIdx = cur === -1 ? 0 : (cur + delta + f.length) % f.length;
    setActive(f[nextIdx] ?? -1);
    setOpenSub(null);
  };

  const openSubmenu = (idx: number) => {
    const item = items[idx];
    if (!item || item.separator || !item.submenu) return;
    setOpenSub(idx);
    setSubActive(focusable(item.submenu)[0] ?? -1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (openSub !== null) setOpenSub(null);
      else onClose();
      return;
    }
    if (openSub !== null) {
      const parent = items[openSub];
      const sub = parent && !parent.separator ? parent.submenu ?? [] : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const f = focusable(sub);
        if (f.length === 0) return;
        const cur = f.indexOf(subActive);
        const d = e.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = cur === -1 ? 0 : (cur + d + f.length) % f.length;
        setSubActive(f[nextIdx] ?? -1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setOpenSub(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = sub[subActive];
        if (item) activate(item);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      openSubmenu(active);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active];
      if (item && !item.separator && item.submenu) openSubmenu(active);
      else if (item) activate(item);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ left: pos.x, top: pos.y }}
        className="absolute min-w-44 rounded-md border border-bg-border bg-bg-raised py-1 text-sm shadow-xl outline-none"
      >
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="my-1 h-px bg-bg-border" />
          ) : (
            <Row
              key={i}
              item={item}
              active={active === i}
              submenuOpen={openSub === i}
              subActive={subActive}
              onHover={() => {
                setActive(i);
                if (item.submenu) openSubmenu(i);
                else setOpenSub(null);
              }}
              onActivate={() => activate(item)}
              onClose={onClose}
            />
          ),
        )}
      </div>
    </div>
  );
}

function Row({
  item,
  active,
  submenuOpen,
  subActive,
  onHover,
  onActivate,
  onClose,
}: {
  item: Exclude<MenuItem, { separator: true }>;
  active: boolean;
  submenuOpen: boolean;
  subActive: number;
  onHover: () => void;
  onActivate: () => void;
  onClose: () => void;
}) {
  const base = 'flex w-full items-center gap-2 px-3 py-1.5 text-left';
  const tone = item.disabled
    ? 'cursor-default text-fg-subtle opacity-50'
    : item.danger
      ? 'text-red-300'
      : 'text-fg';
  const hover = active && !item.disabled ? (item.danger ? 'bg-red-500/20' : 'bg-accent/25') : '';

  return (
    <div className="relative" onMouseEnter={onHover}>
      <button
        type="button"
        disabled={item.disabled}
        onClick={onActivate}
        className={`${base} ${tone} ${hover}`}
      >
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.submenu && <span className="text-fg-subtle">›</span>}
      </button>
      {item.submenu && submenuOpen && (
        <div className="absolute left-full top-0 ml-0.5 min-w-44 rounded-md border border-bg-border bg-bg-raised py-1 shadow-xl">
          {item.submenu.map((sub, j) =>
            sub.separator ? (
              <div key={j} className="my-1 h-px bg-bg-border" />
            ) : (
              <button
                key={j}
                type="button"
                disabled={sub.disabled}
                onClick={() => {
                  sub.onClick?.();
                  onClose();
                }}
                className={`flex w-full items-center px-3 py-1.5 text-left ${
                  sub.disabled
                    ? 'cursor-default text-fg-subtle opacity-50'
                    : sub.danger
                      ? 'text-red-300'
                      : 'text-fg'
                } ${subActive === j ? 'bg-accent/25' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">{sub.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
