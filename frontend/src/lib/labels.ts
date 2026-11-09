import { END_ID, START_ID } from '../api/types';

export function unmaskLabel(label: string): string {
  return label === `\\${START_ID}` || label === `\\${END_ID}` ? label.slice(1) : label;
}

export function displayName(id: string, start: string, end: string): string {
  if (id === START_ID) return start;
  if (id === END_ID) return end;
  return unmaskLabel(id);
}
