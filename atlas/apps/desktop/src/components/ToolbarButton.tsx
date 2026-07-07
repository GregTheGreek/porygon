// A small toggle button shared by the Canvas layer controls (mode toggle,
// overlay visibility, and the per-mode tool pickers). `active` renders the
// accent highlight the M6 controls established.
export function ToolbarButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-1.5 py-0.5 disabled:opacity-40 ${
        active ? 'bg-accent/20 text-accent' : 'text-fg-subtle hover:bg-bg-input hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
