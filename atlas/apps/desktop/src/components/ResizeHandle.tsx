import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback } from 'react';

type Props = {
  // `vertical` sits between columns and resizes their width (drag left/right).
  // `horizontal` sits between rows and resizes their height (drag up/down).
  orientation: 'vertical' | 'horizontal';
  onDelta: (delta: number) => void;
};

export function ResizeHandle({ orientation, onDelta }: Props) {
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const isVertical = orientation === 'vertical';
      let last = isVertical ? e.clientX : e.clientY;

      function onMove(ev: PointerEvent) {
        const current = isVertical ? ev.clientX : ev.clientY;
        onDelta(current - last);
        last = current;
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
    },
    [orientation, onDelta],
  );

  const shape =
    orientation === 'vertical'
      ? 'w-px cursor-col-resize'
      : 'h-px cursor-row-resize';

  return (
    <div
      onPointerDown={onPointerDown}
      className={`shrink-0 bg-bg-border transition-colors hover:bg-accent ${shape}`}
    />
  );
}
