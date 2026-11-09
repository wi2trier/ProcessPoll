import type {
  AnswerIn,
  AnswerValue,
  ChoiceConfig,
  NumberConfig,
  Question,
  TextConfig,
  TraceConfig,
} from '../api/types';
import { cleanLabel, toSteps, makeItems, validateTrace, withTraceDefaults } from './traceLogic';

export type RawAnswer = string | string[] | undefined;
export type RawAnswers = Record<string, RawAnswer>;

export interface FieldError {
  code: string;
  params?: Record<string, string | number>;
}
export type FieldErrors = Record<string, FieldError>;

export function emptyAnswer(q: Question): RawAnswer {
  return q.type === 'trace' || q.type === 'multiple_choice' ? [] : '';
}

export function isAnswered(raw: RawAnswer): boolean {
  if (raw === undefined) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  return raw.trim() !== '';
}

export function validateAnswer(q: Question, r: RawAnswer): { error?: FieldError; value: AnswerValue | null } {
  if (!isAnswered(r)) return { error: q.required ? { code: 'required' } : undefined, value: null };
  switch (q.type) {
    case 'trace': {
      const cfg = withTraceDefaults(q.config as Partial<TraceConfig>);
      const items = makeItems((r as string[]).map(cleanLabel).filter(Boolean));
      const errs = validateTrace(items, cfg, q.required);
      return {
        error: errs.length ? { code: `trace_${errs[0]}`, params: { min: cfg.min_steps, max: cfg.max_steps, len: cfg.max_label_length } } : undefined,
        value: { steps: toSteps(items) },
      };
    }
    case 'single_choice': {
      const cfg = q.config as Partial<ChoiceConfig>;
      const v = r as string;
      return { error: cfg.options && !cfg.options.includes(v) ? { code: 'invalid_option' } : undefined, value: { value: v } };
    }
    case 'multiple_choice': {
      const cfg = q.config as Partial<ChoiceConfig>;
      const vs = r as string[];
      return {
        error: cfg.max_selected && vs.length > cfg.max_selected ? { code: 'too_many_selected', params: { max: cfg.max_selected } } : undefined,
        value: { values: vs },
      };
    }
    case 'number': {
      const cfg = q.config as Partial<NumberConfig>;
      const n = Number((r as string).replace(',', '.'));
      let error: FieldError | undefined;
      if (!Number.isFinite(n)) error = { code: 'invalid_number' };
      else if (cfg.integer && !Number.isInteger(n)) error = { code: 'number_integer' };
      else if (cfg.min != null && n < cfg.min) error = { code: 'number_min', params: { min: cfg.min } };
      else if (cfg.max != null && n > cfg.max) error = { code: 'number_max', params: { max: cfg.max } };
      return { error, value: { value: Number.isFinite(n) ? n : 0 } };
    }
    case 'text': {
      const cfg = q.config as Partial<TextConfig>;
      const v = (r as string).trim();
      return { error: cfg.max_length && v.length > cfg.max_length ? { code: 'text_too_long', params: { max: cfg.max_length } } : undefined, value: { value: v } };
    }
  }
}

export function buildAnswers(questions: Question[], raw: RawAnswers): { answers: AnswerIn[]; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const answers: AnswerIn[] = [];
  for (const q of questions) {
    const { error, value } = validateAnswer(q, raw[q.id]);
    if (error) errors[q.id] = error;
    answers.push({ question_id: q.id, value });
  }
  return { answers, errors };
}
