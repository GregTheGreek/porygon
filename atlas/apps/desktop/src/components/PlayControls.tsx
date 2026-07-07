import { ToolbarButton } from './ToolbarButton';

// The play-mode tools (M8): a Reset that returns the player to its spawn cell,
// plus the movement hint. Play state is ephemeral and lives in the Canvas
// engine, so Reset is a plain callback into the engine rather than store state.
export function PlayControls({ onReset }: { onReset: () => void }) {
  return (
    <>
      <span className="mx-1 h-4 w-px bg-bg-border" />
      <ToolbarButton
        active={false}
        title="Return the player to the spawn cell"
        onClick={onReset}
      >
        Reset
      </ToolbarButton>
      <span className="ml-1 text-xs text-fg-subtle">Arrows / WASD to walk</span>
    </>
  );
}
