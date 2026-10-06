import { Position } from '@vue-flow/core';
import { HANDLES, type HandleId } from './rules';

export interface HandleSpec {
  id: HandleId;
  type: 'source' | 'target';
  position: Position;
  label: string;
}

export const HANDLE_SPECS: HandleSpec[] = [
  {
    id: HANDLES.delegationIn,
    type: 'target',
    position: Position.Left,
    label: 'Receives delegation',
  },
  { id: HANDLES.delegatesOut, type: 'source', position: Position.Right, label: 'Delegates to' },
  { id: HANDLES.reportsIn, type: 'target', position: Position.Top, label: 'Receives reports' },
  { id: HANDLES.reportsOut, type: 'source', position: Position.Bottom, label: 'Reports to' },
];

/** Two-letter initials for the avatar placeholder. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]?.[0] ?? ''}${words.at(-1)?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase() || '?';
}
