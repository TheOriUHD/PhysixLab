/**
 * The inspector-section registry — what the Inspector shows for the current selection.
 *
 * The inspector asks every registered section whether it applies to the selection (`appliesTo`) and appends what
 * the applicable ones build, ordered by `order`. The built-in sections are the per-kind panels (body, soft body,
 * joint, light, group, path), the "Organise" (group membership) row and the "Components" section; a package adds
 * a section — "Vehicle", "Camera rig" … — with one registration and never touches the inspector itself.
 *
 * A section whose `fallback` is true is only shown when no ordinary section applied (the mixed-selection summary).
 */
import { Registry } from '../../core/registry';
import type { Entity } from '../../model/types';
import type { App } from '../app';
import type { InspectorContext } from '../../ui/inspector/shared';

export interface InspectorSectionDef {
  id: string;
  /** Ascending; the built-ins use 100 (the kind's own panel), 200 (organise), 300 (components). */
  order: number;
  /** Does the section apply to this (non-empty) selection? */
  appliesTo: (selection: readonly Entity[], app: App) => boolean;
  /**
   * Build the section's DOM. Register `ctx.updaters` (refresh values from the document on every change) and
   * `ctx.live` (refresh readouts of the running simulation) as the built-in panels do.
   */
  build: (ctx: InspectorContext, selection: Entity[]) => HTMLElement[];
  /** Only shown when no non-fallback section applies. */
  fallback?: boolean;
}

export const inspectorSectionRegistry = new Registry<InspectorSectionDef>({
  kind: 'inspector section',
  order: (s) => s.order,
  validate(s) {
    if (!Number.isFinite(s.order)) throw new Error(`inspector section "${s.id}" needs a numeric order`);
    if (typeof s.appliesTo !== 'function' || typeof s.build !== 'function')
      throw new Error(`inspector section "${s.id}" needs appliesTo() and build()`);
  },
});

export const registerInspectorSection = (def: InspectorSectionDef): (() => void) =>
  inspectorSectionRegistry.register(def);
export const unregisterInspectorSection = (id: string): boolean => inspectorSectionRegistry.unregister(id);
export const listInspectorSections = (): readonly InspectorSectionDef[] => inspectorSectionRegistry.list();

/** The sections that apply to a selection, in order (fallbacks only when nothing else applies). */
export function sectionsFor(selection: readonly Entity[], app: App): InspectorSectionDef[] {
  const applicable = inspectorSectionRegistry.list().filter((s) => s.appliesTo(selection, app));
  const regular = applicable.filter((s) => !s.fallback);
  return regular.length ? regular : applicable;
}
