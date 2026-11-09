import type {
  ChoiceConfig,
  NumberConfig,
  QuestionIn,
  QuestionType,
  Settings,
  TextConfig,
  TraceConfig,
} from '../api/types';
import { emptyToNull, MAX_DESCRIPTION, MAX_LABEL, presentationName } from './presentation';
import { DEFAULT_TRACE_CONFIG } from './traceLogic';

export interface BuilderQuestion extends QuestionIn {
  uid: string;
}

export const DEFAULT_SETTINGS: Settings = {
  results_public: false,
  allow_resubmit: false,
  retention_days: 90,
  k_min: 5,
};

let n = 0;
export function newUid(): string {
  n += 1;
  return `q${Date.now().toString(36)}${n}`;
}

export function defaultConfig(type: QuestionType): TraceConfig | ChoiceConfig | NumberConfig | TextConfig {
  switch (type) {
    case 'trace':
      return { ...DEFAULT_TRACE_CONFIG, activities: [] };
    case 'single_choice':
    case 'multiple_choice':
      return { options: ['', ''] };
    case 'number':
      return { integer: true, min: null, max: null, bins: null };
    case 'text':
      return { max_length: 500 };
  }
}

export function newQuestion(type: QuestionType, prompt = ''): BuilderQuestion {
  return {
    uid: newUid(),
    type,
    prompt,
    label: null,
    help: null,
    required: type === 'trace',
    config: defaultConfig(type),
  };
}

export type Translate = (key: string) => string;

export function morningDescription(t: Translate): string {
  return t('templates.morning.description');
}

export function morningTemplate(t: Translate): BuilderQuestion[] {
  const trace = newQuestion('trace', t('templates.morning.prompt'));
  trace.label = t('templates.morning.promptLabel');
  trace.help = t('templates.morning.help');
  trace.config = { ...DEFAULT_TRACE_CONFIG, mode: 'free', allow_repeats: true, suggest_existing: true };
  const role = newQuestion('single_choice', t('templates.morning.roleQuestion'));
  role.label = t('templates.morning.role');
  role.required = false;
  role.config = { options: [t('templates.morning.roleStudent'), t('templates.morning.roleLecturer'), t('templates.morning.roleOther')] };
  const exp = newQuestion('single_choice', t('templates.morning.experienceQuestion'));
  exp.label = t('templates.morning.experience');
  exp.required = false;
  exp.config = { options: [t('templates.morning.expBeginner'), t('templates.morning.expIntermediate'), t('templates.morning.expAdvanced')] };
  return [trace, role, exp];
}

export type BuilderIssue =
  | { code: 'title_required' }
  | { code: 'no_questions' }
  | { code: 'description_too_long' }
  | { code: 'label_too_long'; index: number }
  | { code: 'prompt_required'; index: number }
  | { code: 'options_min'; index: number }
  | { code: 'options_max'; index: number }
  | { code: 'options_duplicate'; index: number }
  | { code: 'pool_min'; index: number }
  | { code: 'steps_range'; index: number }
  | { code: 'bins_invalid'; index: number }
  | { code: 'number_range'; index: number };

export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function parseNumberList(text: string): number[] | null {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map(Number);
  return nums.every(Number.isFinite) ? nums : [NaN];
}

export function validateBuilder(title: string, questions: BuilderQuestion[], description = ''): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  if (!title.trim()) issues.push({ code: 'title_required' });
  if (description.trim().length > MAX_DESCRIPTION) issues.push({ code: 'description_too_long' });
  if (questions.length === 0) issues.push({ code: 'no_questions' });
  questions.forEach((q, index) => {
    if (!q.prompt.trim()) issues.push({ code: 'prompt_required', index });
    if ((q.label ?? '').trim().length > MAX_LABEL) issues.push({ code: 'label_too_long', index });
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      const opts = ((q.config as ChoiceConfig).options ?? []).map((o) => o.trim()).filter(Boolean);
      if (opts.length < 2) issues.push({ code: 'options_min', index });
      if (opts.length > 30) issues.push({ code: 'options_max', index });
      if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) issues.push({ code: 'options_duplicate', index });
    }
    if (q.type === 'trace') {
      const c = q.config as TraceConfig;
      if (c.mode === 'select_sort' && (c.activities ?? []).filter((a) => a.trim()).length < 2) issues.push({ code: 'pool_min', index });
      if (!(c.min_steps >= 1) || c.max_steps > 50 || c.max_steps < c.min_steps) issues.push({ code: 'steps_range', index });
    }
    if (q.type === 'number') {
      const c = q.config as NumberConfig;
      if (c.min != null && c.max != null && c.min > c.max) issues.push({ code: 'number_range', index });
      if (c.bins && c.bins.length) {
        const sorted = c.bins.every((b, i) => Number.isFinite(b) && (i === 0 || b > c.bins![i - 1]));
        if (!sorted) issues.push({ code: 'bins_invalid', index });
      }
    }
  });
  return issues;
}

export function toQuestionsIn(questions: BuilderQuestion[]): QuestionIn[] {
  return questions.map((q) => {
    let config = q.config;
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      const c = q.config as ChoiceConfig;
      config = { options: c.options.map((o) => o.trim()).filter(Boolean), ...(q.type === 'multiple_choice' && c.max_selected ? { max_selected: c.max_selected } : {}) };
    } else if (q.type === 'trace') {
      const c = q.config as TraceConfig;
      config = { ...c, activities: c.mode === 'select_sort' ? c.activities.map((a) => a.trim()).filter(Boolean) : [] };
    } else if (q.type === 'number') {
      const c = q.config as NumberConfig;
      const out: NumberConfig = { integer: c.integer };
      if (c.min != null) out.min = c.min;
      if (c.max != null) out.max = c.max;
      if (c.bins && c.bins.length) out.bins = c.bins;
      config = out;
    }
    return { type: q.type, prompt: q.prompt.trim(), label: emptyToNull(q.label), help: q.help?.trim() ? q.help.trim() : null, required: q.required, config };
  });
}

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length || from === to) return arr;
  const next = arr.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

export function optionalSectionOpen(q: Pick<QuestionIn, 'label' | 'help'>): boolean {
  return !!(q.label ?? '').trim() || !!(q.help ?? '').trim();
}

export function previewTexts(q: { prompt: string; label?: string | null }): { participants: string; presentation: string } {
  return { participants: q.prompt.trim(), presentation: presentationName({ prompt: q.prompt.trim(), label: q.label }) };
}
