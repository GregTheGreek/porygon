import { useToasts, type ToastKind } from '../store/toasts';

// The one always-visible notification surface (P2.1). Rendered once at the app
// root, stacked at the bottom-right, above the workspace but non-blocking: the
// container is click-through and only the toast cards take pointer events, so it
// never steals focus or covers the UI. Dark-styled to match ContextMenu and the
// command palette. Info/success clear themselves; errors stay until dismissed
// (see store/toasts.ts).
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2 rounded-md border ${border(t.kind)} bg-bg-raised px-3 py-2 text-sm text-fg shadow-xl`}
        >
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot(t.kind)}`} />
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            title="Dismiss"
            className="shrink-0 rounded px-1 leading-none text-fg-subtle hover:text-fg"
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}

function border(kind: ToastKind): string {
  if (kind === 'error') return 'border-red-500/40';
  if (kind === 'success') return 'border-green-500/40';
  return 'border-bg-border';
}

function dot(kind: ToastKind): string {
  if (kind === 'error') return 'bg-red-400';
  if (kind === 'success') return 'bg-green-400';
  return 'bg-accent';
}
