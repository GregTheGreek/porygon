// A used/total budget bar for the Tileset Builder (M9). Over-budget is
// deliberately unmistakable: the bar and numbers turn red and the row shows an
// "over budget" flag. `note` carries extra detail (e.g. the tile range).
type Props = {
  label: string;
  used: number;
  total: number;
  note?: string;
};

export function BudgetMeter({ label, used, total, note }: Props) {
  const over = used > total;
  const ratio = total > 0 ? used / total : 0;
  const pct = Math.min(ratio, 1) * 100;
  // Green under 80%, amber approaching the limit, red once over.
  const near = !over && ratio >= 0.8;
  const barColor = over
    ? 'bg-red-500'
    : near
      ? 'bg-amber-500'
      : 'bg-accent';
  const numColor = over ? 'text-red-400' : 'text-fg';

  const exact = `${used} of ${total} used${note ? ` (${note})` : ''}${
    over ? ' - over budget' : ''
  }`;

  return (
    <div title={exact}>
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-fg-muted">
          {label}
        </span>
        <span className={`font-mono text-xs ${numColor}`}>
          {used} / {total}
          {over && <span className="ml-1 font-medium">over budget</span>}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded bg-bg-input">
        <div
          className={`h-full ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {note && <div className="mt-0.5 text-xs text-fg-subtle">{note}</div>}
    </div>
  );
}
