import type { TraceConfig } from '../api/types';

export interface TraceItem {
  id: string;
  label: string;
}

export type TraceError =
  | 'empty'
  | 'too_long'
  | 'duplicate'
  | 'max_steps'
  | 'not_in_pool'
  | 'min_steps'
  | 'required';

export const DEFAULT_TRACE_CONFIG: TraceConfig = {
  mode: 'free',
  allow_repeats: true,
  allow_skip: true,
  min_steps: 2,
  max_steps: 30,
  activities: [],
  allow_custom: false,
  suggest_existing: true,
  max_label_length: 80,
};

export function withTraceDefaults(c: Partial<TraceConfig> | null | undefined): TraceConfig {
  return { ...DEFAULT_TRACE_CONFIG, ...(c ?? {}), activities: Array.isArray(c?.activities) ? c.activities : [] };
}

export function cleanLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function labelKey(raw: string): string {
  return cleanLabel(raw.normalize('NFKC'))
    .toLowerCase()
    .replace(/[\s.,;:!?]+$/u, '');
}

let counter = 0;
export function newItemId(): string {
  counter += 1;
  return `s${Date.now().toString(36)}${counter}`;
}

export function makeItems(steps: string[], makeId: () => string = newItemId): TraceItem[] {
  return steps.map((label) => ({ id: makeId(), label }));
}

export function toSteps(items: TraceItem[]): string[] {
  return items.map((i) => i.label);
}

export interface AddResult {
  items: TraceItem[];
  error?: TraceError;
}

export function checkLabel(items: TraceItem[], raw: string, cfg: TraceConfig): TraceError | undefined {
  const label = cleanLabel(raw);
  if (!label) return 'empty';
  if (label.length > cfg.max_label_length) return 'too_long';
  if (items.length >= cfg.max_steps) return 'max_steps';
  if (!cfg.allow_repeats) {
    const k = labelKey(label);
    if (items.some((i) => labelKey(i.label) === k)) return 'duplicate';
  }
  return undefined;
}

export function addStep(
  items: TraceItem[],
  raw: string,
  cfg: TraceConfig,
  makeId: () => string = newItemId,
): AddResult {
  const error = checkLabel(items, raw, cfg);
  if (error) return { items, error };
  return { items: [...items, { id: makeId(), label: cleanLabel(raw) }] };
}

export function removeStep(items: TraceItem[], index: number): TraceItem[] {
  if (index < 0 || index >= items.length) return items;
  return items.filter((_, i) => i !== index);
}

export function moveStep(items: TraceItem[], from: number, to: number): TraceItem[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

export function repeatedIndices(items: TraceItem[]): Set<number> {
  const seen = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = labelKey(it.label);
    seen.set(k, [...(seen.get(k) ?? []), i]);
  });
  const out = new Set<number>();
  for (const idxs of seen.values()) if (idxs.length > 1) idxs.forEach((i) => out.add(i));
  return out;
}

export function poolChipState(
  label: string,
  items: TraceItem[],
  cfg: TraceConfig,
): { used: number; disabled: boolean } {
  const k = labelKey(label);
  const used = items.filter((i) => labelKey(i.label) === k).length;
  const disabled = items.length >= cfg.max_steps || (!cfg.allow_repeats && used > 0);
  return { used, disabled };
}

export function validateTrace(items: TraceItem[], cfg: TraceConfig, required: boolean): TraceError[] {
  const errs: TraceError[] = [];
  if (items.length === 0) {
    if (required) errs.push('required');
    return errs;
  }
  if (items.length < cfg.min_steps) errs.push('min_steps');
  if (items.length > cfg.max_steps) errs.push('max_steps');
  if (items.some((i) => cleanLabel(i.label).length > cfg.max_label_length)) errs.push('too_long');
  if (!cfg.allow_repeats) {
    const keys = items.map((i) => labelKey(i.label));
    if (new Set(keys).size !== keys.length) errs.push('duplicate');
  }
  if (cfg.mode === 'select_sort' && !cfg.allow_custom) {
    const pool = new Set(cfg.activities.map(labelKey));
    if (items.some((i) => !pool.has(labelKey(i.label)))) errs.push('not_in_pool');
  }
  return errs;
}

export function suggestLabels(all: string[], query: string, limit = 6): string[] {
  const q = labelKey(query);
  if (!q) return [];
  const starts: string[] = [];
  const contains: string[] = [];
  const seen = new Set<string>();
  for (const l of all) {
    const k = labelKey(l);
    if (seen.has(k) || k === q) continue;
    seen.add(k);
    if (k.startsWith(q)) starts.push(l);
    else if (k.includes(q)) contains.push(l);
  }
  return [...starts, ...contains].slice(0, limit);
}
