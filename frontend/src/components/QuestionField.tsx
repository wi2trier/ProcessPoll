import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChoiceConfig, NumberConfig, Question, TextConfig, TraceConfig } from '../api/types';
import type { FieldError, RawAnswer } from '../lib/answers';
import { Icon } from './Icon';
import { TraceEditor } from './TraceEditor';

interface Props {
  question: Question;
  value: RawAnswer;
  onChange: (v: RawAnswer) => void;
  error?: FieldError;
  serverError?: string;
  fetchSuggestions?: (q: string) => Promise<string[]>;
}

function Tile({ type, name, checked, disabled, label, onChange }: { type: 'radio' | 'checkbox'; name: string; checked: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return (
    <label className={`relative block ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
      <input type={type} name={name} className="peer sr-only" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="flex min-h-[60px] items-center justify-between gap-3 rounded-xl border border-edge bg-white px-5 py-3 text-[18px] font-semibold transition-colors hover:border-brand peer-checked:border-brand peer-checked:bg-brand-soft peer-checked:ring-1 peer-checked:ring-brand peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand">
        <span className="min-w-0 break-words">{label}</span>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center ${type === 'radio' ? 'rounded-full' : 'rounded-md'} border ${checked ? 'border-brand bg-brand text-white' : 'border-edge bg-white'}`} aria-hidden="true">
          {checked && <Icon name="check" size={16} />}
        </span>
      </span>
    </label>
  );
}

export function QuestionField({ question: q, value, onChange, error, serverError, fetchSuggestions }: Props) {
  const { t } = useTranslation();
  const uid = useId();
  const promptId = `${uid}-prompt`;
  const errId = `${uid}-err`;
  const helpId = `${uid}-help`;
  const msg = error ? t(`validation.${error.code}`, { ...error.params, defaultValue: t('validation.invalid') }) : serverError;
  const describedBy = [q.help ? helpId : '', msg ? errId : ''].filter(Boolean).join(' ') || undefined;

  const cfgChoice = q.config as Partial<ChoiceConfig>;
  const options = Array.isArray(cfgChoice.options) ? cfgChoice.options : [];

  let body: ReactNode = null;
  switch (q.type) {
    case 'trace':
      body = (
        <TraceEditor
          config={q.config as TraceConfig}
          value={(Array.isArray(value) ? value : []) as string[]}
          onChange={(v) => onChange(v)}
          fetchSuggestions={fetchSuggestions}
          inputId={`${uid}-input`}
          describedBy={describedBy}
          invalid={!!msg}
        />
      );
      break;
    case 'single_choice':
      body = (
        <div role="radiogroup" aria-labelledby={promptId} aria-describedby={describedBy} className="space-y-3">
          {options.map((o) => (
            <Tile key={o} type="radio" name={uid} label={o} checked={value === o} onChange={() => onChange(o)} />
          ))}
        </div>
      );
      break;
    case 'multiple_choice': {
      const sel = Array.isArray(value) ? value : [];
      const max = cfgChoice.max_selected ?? undefined;
      body = (
        <div role="group" aria-labelledby={promptId} aria-describedby={describedBy} className="space-y-3">
          {max ? <p className="muted">{t('question.maxSelected', { max })}</p> : null}
          {options.map((o) => {
            const checked = sel.includes(o);
            return (
              <Tile
                key={o}
                type="checkbox"
                name={uid}
                label={o}
                checked={checked}
                disabled={!checked && !!max && sel.length >= max}
                onChange={() => onChange(checked ? sel.filter((x) => x !== o) : [...sel, o])}
              />
            );
          })}
        </div>
      );
      break;
    }
    case 'number': {
      const c = q.config as Partial<NumberConfig>;
      body = (
        <div>
          <input
            type="number"
            inputMode={c.integer ? 'numeric' : 'decimal'}
            aria-labelledby={promptId}
            aria-describedby={describedBy}
            aria-invalid={!!msg}
            className="input max-w-[14rem] text-center text-2xl font-bold"
            min={c.min ?? undefined}
            max={c.max ?? undefined}
            step={c.integer ? 1 : 'any'}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
          {(c.min != null || c.max != null) && <p className="muted mt-2">{t('question.numberRange', { min: c.min ?? '−∞', max: c.max ?? '∞' })}</p>}
        </div>
      );
      break;
    }
    case 'text': {
      const c = q.config as Partial<TextConfig>;
      const max = c.max_length ?? 500;
      const v = typeof value === 'string' ? value : '';
      body = (
        <div>
          <textarea
            rows={4}
            aria-labelledby={promptId}
            aria-describedby={describedBy}
            aria-invalid={!!msg}
            className="input"
            maxLength={max}
            value={v}
            onChange={(e) => onChange(e.target.value)}
          />
          <p className="muted mt-2 flex justify-between gap-4">
            <span>{t('question.textPrivacy')}</span>
            <span className="tabular-nums" aria-hidden="true">{v.length}/{max}</span>
          </p>
        </div>
      );
      break;
    }
  }

  return (
    <section data-testid={`question-${q.type}`} aria-labelledby={promptId}>
      <h1 id={promptId} tabIndex={-1} className="text-[30px] font-bold leading-[1.08] tracking-tight focus:outline-none sm:text-4xl">
        {q.prompt}
        {q.required && <span className="sr-only"> ({t('question.required')})</span>}
      </h1>
      {q.help ? (
        <p id={helpId} className="mt-2 text-lg text-ink-soft">{q.help}</p>
      ) : q.type === 'trace' ? (
        <p className="mt-2 text-lg text-ink-soft">{t('trace.defaultHelp')}</p>
      ) : null}
      {!q.required && <p className="mt-1 text-sm font-semibold text-ink-soft">{t('question.optional')}</p>}
      <div className="mt-6">{body}</div>
      {msg && (
        <p id={errId} role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-[#F0C9C5] bg-[#FDF1F0] px-4 py-3 font-semibold text-[#7A1A14]">
          <Icon name="warning" size={20} className="mt-0.5 shrink-0" />
          <span>{msg}</span>
        </p>
      )}
    </section>
  );
}
