import { isBody } from '../../model/types';
import type { App } from '../app';
import { captureThumbnail } from '../data/thumbnail';
import { listDataSources } from './dataExport';
import { buildReportHtml, type ReportInput } from './report';

const n = (v: number, d = 3) => String(+v.toFixed(d));
const v3 = (v: readonly number[]) => `(${v.map((x) => n(x, 3)).join(', ')})`;

/** Gathers the lab report's content from the live app: scene settings, object table, recorded charts, a screenshot. */
export async function collectReportInput(app: App, notes?: string): Promise<ReportInput> {
  const s = app.store.settings;
  const bodies = app.store.bodies();
  const shot = await captureThumbnail(app.viewport, 960).catch(() => undefined);
  const charts = listDataSources()
    .map((src) => ({ title: src.label, table: src.table(app) }))
    .filter((c): c is { title: string; table: NonNullable<typeof c.table> } => !!c.table && c.table.rows.length > 1);
  return {
    title: app.store.name,
    generatedAt: new Date(),
    screenshot: shot,
    parameters: [
      ['Gravity (m/s²)', v3(s.gravity)],
      ['Physics rate', `${s.physicsHz} Hz`],
      ['Solver iterations', String(s.solverIterations)],
      ['Air drag', String(s.airDrag)],
      ['Random seed', String(s.seed)],
      ['Objects', `${bodies.length} bodies, ${app.store.joints().length} joints, ${app.store.size} entities in total`],
    ],
    objects: {
      header: ['Name', 'Shape', 'Type', 'Material', 'Mass (kg)', 'Position (m)'],
      rows: app.store
        .toDocument()
        .entities.filter(isBody)
        .map((b) => [
          b.name,
          b.shape.type,
          b.bodyType,
          b.material.preset,
          b.bodyType === 'dynamic' && app.sim.client.info.mass[b.id] ? n(app.sim.client.info.mass[b.id]) : '-',
          v3(b.position),
        ]),
    },
    charts,
    notes,
  };
}

export async function buildReport(app: App, notes?: string): Promise<string> {
  return buildReportHtml(await collectReportInput(app, notes));
}
