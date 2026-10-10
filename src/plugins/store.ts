/** DT-31: where installed plugins are remembered. localStorage in the app; an in-memory twin for tests. */
import type { Permission, PluginManifest } from './manifest';

export interface PluginRecord {
  manifest: PluginManifest;
  source: string;
  enabled: boolean;
  /** Permissions the user approved (a subset of the manifest's). */
  granted: Permission[];
  /** "paste", "file: x.js", "url: https://…", "example". */
  origin: string;
  installedAt: number;
}

export interface PluginStore {
  load(): PluginRecord[];
  save(list: PluginRecord[]): void;
}

const KEY = 'physixlab.plugins.v1';
const MAX_TOTAL_CHARS = 1_500_000;

export class LocalPluginStore implements PluginStore {
  load(): PluginRecord[] {
    try {
      const raw = localStorage.getItem(KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(list)
        ? (list as PluginRecord[]).filter((r) => r && typeof r.source === 'string' && r.manifest?.id)
        : [];
    } catch {
      return [];
    }
  }
  save(list: PluginRecord[]): void {
    try {
      const text = JSON.stringify(list);
      if (text.length > MAX_TOTAL_CHARS) throw new Error('Plugins use too much space');
      localStorage.setItem(KEY, text);
    } catch (e) {
      console.warn('[plugins] could not save', e);
      throw e instanceof Error ? e : new Error('Could not save plugins');
    }
  }
}

export class MemoryPluginStore implements PluginStore {
  list: PluginRecord[] = [];
  load(): PluginRecord[] {
    return structuredClone(this.list);
  }
  save(list: PluginRecord[]): void {
    this.list = structuredClone(list);
  }
}
