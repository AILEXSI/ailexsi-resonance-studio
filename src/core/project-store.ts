/**
 * Local-first project persistence (V0.1.2).
 * Uses localStorage. Blob URLs cannot survive reload — sanitized on load.
 */

import type { Project } from "./models";
import { createEmptyProject, ensureMultiTrack, sanitizeMediaAssets } from "./models";

const KEY = "ailexsi-resonance-studio-project-v0.1";

export function loadProject(): Project {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return createEmptyProject();
    const parsed = JSON.parse(raw) as Project;
    if (!parsed.id || !Array.isArray(parsed.tracks)) return createEmptyProject();
    return sanitizeMediaAssets(ensureMultiTrack(parsed));
  } catch {
    return createEmptyProject();
  }
}

export function saveProject(project: Project): void {
  const toSave: Project = {
    ...project,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(toSave));
}

export function clearProject(): void {
  localStorage.removeItem(KEY);
}
