import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/project';
import { getObjectProblems, type Problem } from '../lib/api';

// The bottom-strip Problems panel: one home for all three validity tiers,
// absorbing the previously scattered per-view Problems sections (Inspector's
// Tier 1, the Builder's Tier 2). Selection in the centre region is mutually
// exclusive, so the panel shows Tier 1 for the selected object, or Tier 2
// (budgets) + Tier 3 (compile) for the selected tileset.
export function ProblemsPanel() {
  const objectId = useProjectStore((s) => s.selectedObjectId);
  const tilesetId = useProjectStore((s) => s.selectedTilesetId);
  const object = useProjectStore((s) =>
    s.open && s.selectedObjectId
      ? s.open.project.objects.find((o) => o.id === s.selectedObjectId) ?? null
      : null,
  );
  const budget = useProjectStore((s) => s.budget);
  const compileResult = useProjectStore((s) => s.compileResult);
  const compileError = useProjectStore((s) => s.compileError);

  // Tier 1 problems for the selected object, fetched from Rust (validity.rs)
  // so the wording stays with the schema owner. Depends only on artwork
  // dimensions, which are fixed per object, so this refetch key is enough.
  const [tier1, setTier1] = useState<Problem[]>([]);
  useEffect(() => {
    if (!object) {
      setTier1([]);
      return;
    }
    let alive = true;
    getObjectProblems(object)
      .then((p) => alive && setTier1(p))
      .catch(() => alive && setTier1([]));
    return () => {
      alive = false;
    };
  }, [object?.id, object?.width, object?.height, object]);

  if (!objectId && !tilesetId) {
    return <p className="text-sm text-fg-subtle">Select an object or tileset to see its problems.</p>;
  }

  const tier2 = tilesetId ? budget?.problems ?? [] : [];
  const tier3 = tilesetId ? compileResult?.problems ?? [] : [];
  const shown = objectId ? tier1 : [...tier2, ...tier3];

  const compiledClean =
    !!tilesetId && !!compileResult && compileResult.success && tier2.length === 0;

  return (
    <div className="space-y-2">
      {shown.length === 0 && !compileError ? (
        <p className="text-sm text-fg-subtle">
          {compiledClean ? 'Compiled with no problems.' : 'No problems detected.'}
        </p>
      ) : (
        <ul className="space-y-1">
          {shown.map((p, i) => (
            <ProblemItem key={i} problem={p} />
          ))}
        </ul>
      )}

      {compileError && (
        <p className="whitespace-pre-wrap rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-200">
          {compileError}
        </p>
      )}

      {/* Tier 3 keeps the raw compiler report available for bug reports, but
          never as the primary message (bible rule). */}
      {tilesetId && compileResult && !compileResult.success && compileResult.details && (
        <CompilerDetails details={compileResult.details} />
      )}
    </div>
  );
}

const TIER_STYLE: Record<Problem['tier'], { badge: string; box: string; label: string }> = {
  Object: {
    badge: 'text-amber-400/80',
    box: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    label: 'Object',
  },
  Tileset: {
    badge: 'text-red-400/80',
    box: 'border-red-500/40 bg-red-500/10 text-red-200',
    label: 'Tileset',
  },
  Export: {
    badge: 'text-orange-400/80',
    box: 'border-orange-500/40 bg-orange-500/10 text-orange-200',
    label: 'Compile',
  },
};

function ProblemItem({ problem }: { problem: Problem }) {
  const style = TIER_STYLE[problem.tier];
  return (
    <li className={`rounded border px-2 py-1.5 text-xs ${style.box}`}>
      <span className={`mr-1 font-medium uppercase tracking-wide ${style.badge}`}>
        {style.label}
      </span>
      {problem.message}
    </li>
  );
}

// Collapsible raw compiler output. Collapsed by default so the mapped
// artist-facing problem stays the headline.
function CompilerDetails({ details }: { details: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-fg-subtle underline hover:text-fg"
      >
        {open ? 'Hide' : 'Show'} compiler details (for bug reports)
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded border border-bg-border bg-bg-input p-2 font-mono text-[11px] leading-snug text-fg-muted">
          {details}
        </pre>
      )}
    </div>
  );
}
