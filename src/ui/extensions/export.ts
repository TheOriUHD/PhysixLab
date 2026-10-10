/**
 * DT-1: File > Export commands (glTF/GLB, OBJ, STL, PNG). Each opens a small options dialog; the dialog and the
 * exporters are loaded with a dynamic import() on first use, so they cost nothing at start-up.
 */
import { registerCommand, registerMenuEntry } from '../../app/registry';
import { lazy } from '../../core/lazy';
import type { ExportKind } from '../exportDialog';

const dialog = lazy(() => import('../exportDialog'));

const ITEMS: { kind: ExportKind; id: string; label: string; description: string; keywords: string[]; icon: string }[] =
  [
    {
      kind: 'glb',
      id: 'file.export.gltf',
      label: 'Export 3D scene (glTF / GLB)…',
      description: 'Scene with materials, groups, compound parts and lights; optionally a baked animation',
      keywords: ['gltf', 'glb', 'blender', '3d', 'model', 'download'],
      icon: 'download',
    },
    {
      kind: 'obj',
      id: 'file.export.obj',
      label: 'Export OBJ model (+ MTL)…',
      description: 'Wavefront OBJ with materials, selection or whole scene',
      keywords: ['obj', 'mtl', 'wavefront', '3d', 'model', 'download'],
      icon: 'download',
    },
    {
      kind: 'stl',
      id: 'file.export.stl',
      label: 'Export STL model (3D printing)…',
      description: 'Binary STL, selection or whole scene',
      keywords: ['stl', '3d print', 'printing', 'slicer', 'cad', 'download'],
      icon: 'download',
    },
    {
      kind: 'png',
      id: 'file.export.png',
      label: 'Export image (PNG)…',
      description: 'Screenshot up to 4K, with an optional transparent background',
      keywords: ['png', 'screenshot', 'image', 'picture', 'render', 'transparent', 'download'],
      icon: 'camera',
    },
  ];

ITEMS.forEach((it, i) => {
  registerCommand({
    id: it.id,
    label: it.label,
    category: 'File',
    icon: it.icon,
    description: it.description,
    keywords: it.keywords,
    run: async ({ app }) => {
      (await dialog()).openExportDialog(app, it.kind);
    },
  });
  registerMenuEntry({ id: `menu.${it.id}`, menu: 'file', group: 'io', order: 301 + i, command: it.id });
});
