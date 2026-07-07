type Props = {
  version: string;
};

export function Toolbar({ version }: Props) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-bg-border bg-bg-raised px-3 select-none">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-fg">Porygon</span>
        <span className="text-xs text-fg-subtle">Object Authoring</span>
      </div>
      <span className="font-mono text-xs text-fg-subtle">
        {version ? `v${version}` : ''}
      </span>
    </div>
  );
}
