import type { ReactNode } from 'react';

type Props = {
  title: string;
  children?: ReactNode;
  className?: string;
};

// A docked panel: a slim uppercase header plus a scrollable body. Used for
// every region except the canvas.
export function Panel({ title, children, className = '' }: Props) {
  return (
    <div className={`flex min-h-0 min-w-0 flex-col bg-bg-panel ${className}`}>
      <div className="flex h-8 shrink-0 items-center border-b border-bg-border px-3 text-xs font-medium uppercase tracking-wide text-fg-muted">
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-sm text-fg-subtle">
        {children}
      </div>
    </div>
  );
}
