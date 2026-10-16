import type { ViewTransform } from '../contracts/view';

/**
 * The `uView` uniform of the frame groups (Phase 26): (c, s, ox, oy) of the view transform, written only when
 * the transform's `revision` moved. A steady frame (any view) costs one integer compare and writes nothing; a
 * turn writes four floats once. Pure (a plain Float32Array), so Node tests exercise it without a GPU.
 * An omitted transform is the identity (view 0, revision 0), like `createViewTransform()`.
 */
export class ViewUniformSync {
  /** The revision the target holds. The target starts as the identity, which is revision 0. */
  private applied = 0;
  /** How many times `sync` wrote (diagnostics, tests). */
  writes = 0;

  /** Writes `target` when the revision differs from the applied one; returns whether it did. */
  sync(target: Float32Array, view: Readonly<ViewTransform> | undefined): boolean {
    const revision = view === undefined ? 0 : view.revision;
    if (revision === this.applied) return false;
    this.applied = revision;
    this.writes += 1;
    target[0] = view === undefined ? 1 : view.c;
    target[1] = view === undefined ? 0 : view.s;
    target[2] = view === undefined ? 0 : view.ox;
    target[3] = view === undefined ? 0 : view.oy;
    return true;
  }
}
