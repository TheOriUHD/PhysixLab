/** Recognise a PhysixLab scene in clipboard text (UI-42): cheap checks first, so ordinary pastes cost nothing. */
import { LIMITS } from '../../model/limits';
import { isRecord } from './storage';

export interface SceneSniff {
  name: string;
  entities: number;
}

/** A scene's JSON text → its name and entity count; null when the text is not (obviously) a scene. */
export function sniffSceneText(text: string): SceneSniff | null {
  if (text.length < 20 || text.length > LIMITS.maxDocumentChars) return null;
  if (text.trimStart()[0] !== '{' || !text.includes('"entities"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.entities)) return null;
  return {
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 80) : 'Pasted scene',
    entities: raw.entities.length,
  };
}
