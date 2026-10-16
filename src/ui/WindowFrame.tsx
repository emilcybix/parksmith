import './windows.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Phase 42: a small floating window: a title bar that drags it (kept inside the screen), a close button, Esc closes it
 * while the focus is inside, and the focus moves into it on open and back to whatever had it on close. It floats over
 * the park (the world keeps running and keeps its keys outside the window), docked beside the utility rail by default.
 * Both Phase 42 windows use it; a later window can too.
 */
export interface WindowFrameProps {
  id: string;
  title: string;
  /** The default dock offset from the top (px), so two windows open together do not sit exactly on top of each other. */
  dockOffset?: number;
  onClose: () => void;
  children: ReactNode;
}

/** Keeps a window's top-left corner so at least its title bar stays on screen. */
export const clampWindowPosition = (
  x: number, y: number, width: number, viewportWidth: number, viewportHeight: number,
): { x: number; y: number } => ({
  x: Math.min(Math.max(x, 8 - width + 120), Math.max(8, viewportWidth - 120)),
  y: Math.min(Math.max(y, 8), Math.max(8, viewportHeight - 48)),
});

export const WindowFrame = ({ id, title, dockOffset = 0, onClose, children }: WindowFrameProps): React.JSX.Element => {
  const frameRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    frameRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('button')) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag.current === null) return;
    const width = frameRef.current?.offsetWidth ?? 360;
    setPosition(clampWindowPosition(event.clientX - drag.current.dx, event.clientY - drag.current.dy, width, window.innerWidth, window.innerHeight));
  };
  const endDrag = (): void => { drag.current = null; };

  return (
    <section
      ref={frameRef}
      className={`game-window game-window-${id}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`game-window-${id}-title`}
      tabIndex={-1}
      style={position === null ? { top: `${94 + dockOffset}px` } : { left: `${position.x}px`, top: `${position.y}px` }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        event.preventDefault();
        onClose();
      }}
    >
      <header className="game-window-title" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <strong id={`game-window-${id}-title`}>{title}</strong>
        <button className="game-window-close" onClick={onClose} aria-label={`Close ${title}`} title="Close (Esc)">×</button>
      </header>
      <div className="game-window-body">{children}</div>
    </section>
  );
};
