// The center region: the empty dark surface where artwork will be edited.
export function Canvas() {
  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center border-b border-bg-border px-3 text-xs font-medium uppercase tracking-wide text-fg-muted">
        Canvas
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-sm text-fg-subtle">Import artwork to begin.</p>
      </div>
    </div>
  );
}
