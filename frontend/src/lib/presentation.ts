export interface NamedQuestion {
  prompt: string;
  label?: string | null;
}

export function presentationName(q: NamedQuestion): string {
  const label = q.label?.trim();
  return label ? label : q.prompt;
}

export function groupByName(g: NamedQuestion): string {
  return presentationName(g);
}

export function emptyToNull(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

export const MAX_DESCRIPTION = 1000;
export const MAX_LABEL = 80;
