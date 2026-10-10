/**
 * DT-31: plugin manifest. A plugin is one JavaScript file that starts with a manifest comment:
 *
 *   /* @physicslab-plugin
 *   { "id": "my-plugin", "name": "My plugin", "version": "1.0.0", "description": "…", "permissions": ["scene.write"] }
 *   *\/
 *
 * The manifest is read as DATA (JSON) before any of the plugin's code runs, so the permission prompt can show exactly
 * what the plugin asks for.
 */
export const PERMISSIONS = {
  ui: 'Add commands, panels and example scenes to PhysicsLab',
  'scene.read': 'Read the scene: objects, settings, selection, poses',
  'scene.write': 'Change the scene (every change can be undone)',
  simulation: 'Start, pause, step and reset the simulation',
  view: 'Move the camera',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: Permission[];
}

export const MAX_PLUGIN_CHARS = 200_000;

export class ManifestError extends Error {}

const HEADER = /\/\*\s*@physicslab-plugin\s*([\s\S]*?)\*\//;

export function parseManifest(source: string): PluginManifest {
  if (typeof source !== 'string' || !source.trim()) throw new ManifestError('The plugin is empty');
  if (source.length > MAX_PLUGIN_CHARS)
    throw new ManifestError(`The plugin is larger than ${MAX_PLUGIN_CHARS} characters`);
  const m = HEADER.exec(source);
  if (!m) throw new ManifestError('The plugin must start with a /* @physicslab-plugin { … } */ manifest comment');
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    throw new ManifestError('The manifest comment is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ManifestError('The manifest must be an object');
  const r = raw as Record<string, unknown>;
  const id = r['id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(id))
    throw new ManifestError('manifest.id must be 2–40 lowercase letters, digits or dashes, starting with a letter');
  const name = r['name'];
  if (typeof name !== 'string' || !name.trim() || name.length > 60)
    throw new ManifestError('manifest.name is required (max 60 characters)');
  const version = typeof r['version'] === 'string' && /^\d+\.\d+\.\d+$/.test(r['version']) ? r['version'] : null;
  if (!version) throw new ManifestError('manifest.version must look like 1.0.0');
  const description = typeof r['description'] === 'string' ? r['description'].slice(0, 300) : '';
  const perms = r['permissions'] ?? [];
  if (!Array.isArray(perms)) throw new ManifestError('manifest.permissions must be a list');
  const permissions: Permission[] = [];
  for (const p of perms) {
    if (typeof p !== 'string' || !Object.hasOwn(PERMISSIONS, p))
      throw new ManifestError(
        `Unknown permission "${String(p).slice(0, 30)}". Available: ${Object.keys(PERMISSIONS).join(', ')}. Network, storage and DOM access cannot be requested.`,
      );
    if (!permissions.includes(p as Permission)) permissions.push(p as Permission);
  }
  return { id, name: name.trim(), version, description, permissions };
}
