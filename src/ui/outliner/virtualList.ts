/**
 * UI-A: fixed-row-height window rendering. Only the rows in (and just around) the viewport exist in the DOM,
 * however many items the list has; scrolling recycles the row elements. Rows are positioned absolutely inside
 * a spacer of the full height, so the scrollbar is the real one.
 */

/** The index range [first, last) to build for a scroll position (pure, unit-tested). */
export function visibleRange(
  scrollTop: number,
  viewHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
): [number, number] {
  if (count <= 0 || rowHeight <= 0) return [0, 0];
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan);
  return [Math.min(first, count), Math.max(Math.min(first, count), last)];
}

export interface VirtualListOptions {
  rowHeight: number;
  overscan?: number;
  /** Fill `el` for item `index` (called for every visible row on each refresh). */
  render: (index: number, el: HTMLElement) => void;
}

export class VirtualList {
  readonly el: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly pool: HTMLElement[] = [];
  private readonly live = new Map<number, HTMLElement>();
  private count = 0;
  private readonly overscan: number;
  private raf = 0;

  constructor(private readonly opts: VirtualListOptions) {
    this.overscan = opts.overscan ?? 6;
    this.spacer = document.createElement('div');
    this.spacer.className = 'o-spacer';
    this.el = document.createElement('div');
    this.el.className = 'o-scroll';
    this.el.appendChild(this.spacer);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  get rowHeight(): number {
    return this.opts.rowHeight;
  }

  /** Number of row elements currently in the DOM (tests / diagnostics). */
  get mounted(): number {
    return this.live.size;
  }

  setCount(n: number): void {
    this.count = n;
    this.spacer.style.height = `${n * this.opts.rowHeight}px`;
    this.refresh();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.refresh();
    });
  }

  /** Re-render every visible row (data changed) and recycle rows that left the window. */
  refresh(): void {
    const h = this.el.clientHeight || 400;
    const [a, b] = visibleRange(this.el.scrollTop, h, this.opts.rowHeight, this.count, this.overscan);
    for (const [i, el] of this.live) {
      if (i < a || i >= b) {
        this.live.delete(i);
        el.style.display = 'none';
        el.className = '';
        el.textContent = '';
        el.removeAttribute('data-sig');
        el.removeAttribute('data-id');
        this.pool.push(el);
      }
    }
    for (let i = a; i < b; i++) {
      let el = this.live.get(i);
      if (!el) {
        el = this.pool.pop();
        if (!el) {
          el = document.createElement('div');
          this.spacer.appendChild(el);
        }
        el.style.display = '';
        this.live.set(i, el);
      }
      el.style.transform = `translateY(${i * this.opts.rowHeight}px)`;
      el.style.height = `${this.opts.rowHeight}px`;
      this.opts.render(i, el);
    }
  }

  /** The row element of item `index`, if it is mounted. */
  rowAt(index: number): HTMLElement | undefined {
    return this.live.get(index);
  }

  /** Scroll so item `index` is fully visible (no-op when it already is). */
  reveal(index: number): void {
    const top = index * this.opts.rowHeight;
    const h = this.el.clientHeight;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + this.opts.rowHeight > this.el.scrollTop + h) this.el.scrollTop = top + this.opts.rowHeight - h;
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}
