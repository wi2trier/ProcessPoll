import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChoiceConfig, NumberConfig, QuestionType, TextConfig, TraceConfig } from '../api/types';
import { moveItem, newQuestion, optionalSectionOpen, parseLines, parseNumberList, previewTexts, type BuilderIssue, type BuilderQuestion } from '../lib/builder';
import { MAX_LABEL } from '../lib/presentation';
import { Icon } from './Icon';
import { FieldLabel, IconTip, InfoTip } from './Tooltip';
import { AutoTextarea, Disclosure, Toggle } from './ui';

const TYPES: QuestionType[] = ['trace', 'single_choice', 'multiple_choice', 'number', 'text'];

function NumField({ label, value, onChange, min, max, id, tip }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void; min?: number; max?: number; id: string; tip?: string }) {
  return (
    <div>
      <FieldLabel htmlFor={id} tip={tip}>{label}</FieldLabel>
      <input id={id} type="number" className="input input-sm" min={min} max={max} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
    </div>
  );
}

function LinesField({ label, help, tip, value, onChange, id, rows = 4 }: { label: string; help?: string; tip?: string; value: string[]; onChange: (v: string[]) => void; id: string; rows?: number }) {

  const [text, setText] = useState(value.join('\n'));
  return (
    <div>
      <FieldLabel htmlFor={id} tip={tip}>{label}</FieldLabel>
      <textarea
        id={id}
        rows={rows}
        className="input input-sm"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()));
        }}
        onBlur={() => onChange(parseLines(text))}
      />
      {help && <p className="muted mt-1">{help}</p>}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options, label, tip }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; label: string; tip?: string }) {
  const labelId = useId();
  return (
    <div>
      <FieldLabel id={labelId} tip={tip}>{label}</FieldLabel>
      <div role="group" aria-labelledby={labelId} className="inline-flex rounded-xl border border-line bg-white p-1">
        {options.map((o) => (
          <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)} className={`min-h-[40px] rounded-lg px-5 font-semibold ${value === o.id ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink'}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TraceMain({ cfg, onChange, uid }: { cfg: TraceConfig; onChange: (c: TraceConfig) => void; uid: string }) {
  const { t } = useTranslation();
  const set = (p: Partial<TraceConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="space-y-4">
      <Segmented
        label={t('builder.trace.mode')}
        tip={t('tips.builder.traceMode')}
        value={cfg.mode}
        onChange={(m) => set({ mode: m })}
        options={[
          { id: 'free', label: t('builder.trace.modeFree') },
          { id: 'select_sort', label: t('builder.trace.modeSelect') },
        ]}
      />
      {cfg.mode === 'select_sort' && <LinesField id={`${uid}-pool`} rows={5} label={t('builder.trace.pool')} tip={t('tips.builder.tracePool')} help={t('builder.trace.poolHelp')} value={cfg.activities} onChange={(v) => set({ activities: v })} />}
      <Toggle checked={cfg.allow_repeats} onChange={(v) => set({ allow_repeats: v })} label={t('builder.trace.allowRepeats')} tip={t('tips.builder.traceRepeats')} />
    </div>
  );
}

function TraceMore({ cfg, onChange, uid }: { cfg: TraceConfig; onChange: (c: TraceConfig) => void; uid: string }) {
  const { t } = useTranslation();
  const set = (p: Partial<TraceConfig>) => onChange({ ...cfg, ...p });
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <NumField id={`${uid}-min`} label={t('builder.trace.minSteps')} tip={t('tips.builder.traceSteps')} min={1} max={50} value={cfg.min_steps} onChange={(v) => set({ min_steps: v ?? 1 })} />
        <NumField id={`${uid}-max`} label={t('builder.trace.maxSteps')} min={1} max={50} value={cfg.max_steps} onChange={(v) => set({ max_steps: v ?? 30 })} />
        <NumField id={`${uid}-len`} label={t('builder.trace.maxLabel')} tip={t('tips.builder.traceMaxLabel')} min={10} max={120} value={cfg.max_label_length} onChange={(v) => set({ max_label_length: v ?? 80 })} />
      </div>
      {cfg.mode === 'free' ? (
        <Toggle checked={cfg.suggest_existing} onChange={(v) => set({ suggest_existing: v })} label={t('builder.trace.suggest')} help={t('builder.trace.suggestHelp')} tip={t('tips.builder.traceSuggest')} />
      ) : (
        <Toggle checked={cfg.allow_custom} onChange={(v) => set({ allow_custom: v })} label={t('builder.trace.allowCustom')} tip={t('tips.builder.traceCustom')} />
      )}
      <Toggle checked={cfg.allow_skip} onChange={(v) => set({ allow_skip: v })} label={t('builder.trace.allowSkip')} tip={t('tips.builder.traceSkip')} />
    </>
  );
}

export function PreviewLine({ q }: { q: { prompt: string; label?: string | null } }) {
  const { t } = useTranslation();
  const p = previewTexts(q);
  const empty = <span className="italic">{t('builder.previewEmpty')}</span>;
  return (
    <p className="rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink-soft" data-testid="builder-preview">
      <span>{t('builder.previewParticipants')}: </span>
      <strong className="break-words font-semibold text-ink" data-testid="preview-participants">{p.participants || empty}</strong>
      <span> · </span>
      <span>{t('builder.previewPresentation')}: </span>
      <strong className="break-words font-semibold text-ink" data-testid="preview-presentation">{p.presentation || empty}</strong>
    </p>
  );
}

export function Counter({ value, max }: { value: number; max: number }) {
  const { t } = useTranslation();
  return (
    <span className={`ml-auto text-sm tabular-nums ${value >= max ? 'font-semibold text-danger' : 'text-ink-soft'}`} aria-hidden="true">
      {t('builder.counter', { count: value, max })}
    </span>
  );
}

export function QuestionBuilder({
  questions,
  onChange,
  issues,
}: {
  questions: BuilderQuestion[];
  onChange: (q: BuilderQuestion[]) => void;
  issues: BuilderIssue[];
  templates?: ReactNode;
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const update = (i: number, p: Partial<BuilderQuestion>) => onChange(questions.map((q, k) => (k === i ? { ...q, ...p } : q)));
  const issuesFor = (i: number) => issues.filter((x) => 'index' in x && x.index === i);

  return (
    <div className="space-y-5">
      {questions.length === 0 && <p className="rounded-2xl border border-dashed border-edge px-6 py-10 text-center text-ink-soft">{t('builder.noQuestions')}</p>}

      <ol className="space-y-5">
        {questions.map((q, i) => {
          const uid = `${baseId}-${q.uid}`;
          const qi = issuesFor(i);
          const hasMore = q.type === 'trace' || q.type === 'multiple_choice';
          return (
            <li key={q.uid} className="card p-5" data-testid="builder-question">
              {}
              <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-0.5">
                  <span className="font-bold">{t(`builder.type.${q.type}`)}</span>
                  <InfoTip text={t(`tips.builder.type.${q.type}`)} />
                </span>
                <span className="ml-auto flex shrink-0">
                  <IconTip label={t('builder.moveUp', { n: i + 1 })}>
                    <button type="button" className="btn-icon !h-9 !w-9 sm:!h-10 sm:!w-10" disabled={i === 0} onClick={() => onChange(moveItem(questions, i, i - 1))} aria-label={t('builder.moveUp', { n: i + 1 })}><Icon name="up" size={18} /></button>
                  </IconTip>
                  <IconTip label={t('builder.moveDown', { n: i + 1 })}>
                    <button type="button" className="btn-icon !h-9 !w-9 sm:!h-10 sm:!w-10" disabled={i === questions.length - 1} onClick={() => onChange(moveItem(questions, i, i + 1))} aria-label={t('builder.moveDown', { n: i + 1 })}><Icon name="down" size={18} /></button>
                  </IconTip>
                  <IconTip label={t('builder.remove', { n: i + 1 })}>
                    <button type="button" className="btn-icon !h-9 !w-9 sm:!h-10 sm:!w-10" onClick={() => onChange(questions.filter((_, k) => k !== i))} aria-label={t('builder.remove', { n: i + 1 })}><Icon name="trash" size={18} /></button>
                  </IconTip>
                </span>
              </div>

              <div className="space-y-4">
                <div>
                  <FieldLabel htmlFor={`${uid}-prompt`} tip={t('tips.builder.question')} hint={<Counter value={q.prompt.length} max={300} />}>{t('builder.prompt')}</FieldLabel>
                  {}
                  <AutoTextarea
                    id={`${uid}-prompt`}
                    className="input !min-h-[56px] py-3.5"
                    minRows={1}
                    maxRows={6}
                    placeholder={t(`builder.promptPlaceholder.${q.type}`)}
                    value={q.prompt}
                    maxLength={300}
                    onChange={(e) => update(i, { prompt: e.target.value.replace(/\s*[\r\n]+\s*/g, ' ') })}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                    data-testid="builder-prompt"
                    aria-required="true"
                  />
                </div>

                {q.type === 'trace' && <TraceMain uid={uid} cfg={q.config as TraceConfig} onChange={(c) => update(i, { config: c })} />}

                {(q.type === 'single_choice' || q.type === 'multiple_choice') && (
                  <LinesField id={`${uid}-opts`} label={t('builder.options')} tip={t('tips.builder.options')} help={t('builder.optionsHelp')} value={(q.config as ChoiceConfig).options} onChange={(v) => update(i, { config: { ...(q.config as ChoiceConfig), options: v } })} />
                )}

                {q.type === 'number' && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <NumField id={`${uid}-nmin`} label={t('builder.number.min')} tip={t('tips.builder.numberRange')} value={(q.config as NumberConfig).min} onChange={(v) => update(i, { config: { ...(q.config as NumberConfig), min: v } })} />
                    <NumField id={`${uid}-nmax`} label={t('builder.number.max')} value={(q.config as NumberConfig).max} onChange={(v) => update(i, { config: { ...(q.config as NumberConfig), max: v } })} />
                    <div className="sm:col-span-2">
                      <Toggle checked={(q.config as NumberConfig).integer} onChange={(v) => update(i, { config: { ...(q.config as NumberConfig), integer: v } })} label={t('builder.number.integer')} tip={t('tips.builder.numberInteger')} />
                    </div>
                    <div className="sm:col-span-2">
                      <FieldLabel htmlFor={`${uid}-bins`} tip={t('tips.builder.numberBins')}>{t('builder.number.bins')}</FieldLabel>
                      <input
                        id={`${uid}-bins`}
                        className="input input-sm"
                        defaultValue={((q.config as NumberConfig).bins ?? []).join(', ')}
                        placeholder="18, 25, 40"
                        onChange={(e) => update(i, { config: { ...(q.config as NumberConfig), bins: parseNumberList(e.target.value) } })}
                      />
                      <p className="muted mt-1">{t('builder.number.binsHelp')}</p>
                    </div>
                  </div>
                )}

                {q.type === 'text' && (
                  <div className="max-w-[12rem]">
                    <NumField id={`${uid}-tmax`} label={t('builder.text.maxLength')} tip={t('tips.builder.textMax')} min={10} max={2000} value={(q.config as TextConfig).max_length} onChange={(v) => update(i, { config: { max_length: v ?? 500 } })} />
                  </div>
                )}

                <Toggle checked={q.required} onChange={(v) => update(i, { required: v })} label={t('builder.required')} tip={t('tips.builder.required')} />

                {}
                <Disclosure label={t('builder.optional')} tip={t('tips.builder.optional')} defaultOpen={optionalSectionOpen(q)} testId="builder-optional">
                  <div>
                    <FieldLabel htmlFor={`${uid}-label`} tip={t('tips.builder.label')} hint={<Counter value={(q.label ?? '').length} max={MAX_LABEL} />}>{t('builder.label')}</FieldLabel>
                    <input
                      id={`${uid}-label`}
                      className="input input-sm"
                      placeholder={t(`builder.labelPlaceholder.${q.type}`)}
                      value={q.label ?? ''}
                      maxLength={MAX_LABEL}
                      onChange={(e) => update(i, { label: e.target.value })}
                      data-testid="builder-label"
                    />
                  </div>
                  <PreviewLine q={q} />
                  <div>
                    <FieldLabel htmlFor={`${uid}-help`} tip={t('tips.builder.help')}>{t('builder.help')}</FieldLabel>
                    <input id={`${uid}-help`} className="input input-sm" placeholder={t('builder.helpPlaceholder')} value={q.help ?? ''} maxLength={500} onChange={(e) => update(i, { help: e.target.value || null })} data-testid="builder-help" />
                  </div>
                </Disclosure>

                {hasMore && (
                  <Disclosure label={t('builder.more')} tip={t('tips.builder.more')} testId="builder-more">
                    {q.type === 'trace' && <TraceMore uid={uid} cfg={q.config as TraceConfig} onChange={(c) => update(i, { config: c })} />}
                    {q.type === 'multiple_choice' && (
                      <div className="max-w-[12rem]">
                        <NumField id={`${uid}-maxsel`} label={t('builder.maxSelected')} tip={t('tips.builder.maxSelected')} min={1} max={30} value={(q.config as ChoiceConfig).max_selected} onChange={(v) => update(i, { config: { ...(q.config as ChoiceConfig), max_selected: v } })} />
                      </div>
                    )}
                  </Disclosure>
                )}
              </div>

              {qi.length > 0 && (
                <ul className="mt-4 space-y-1 font-semibold text-danger" role="alert">
                  {qi.map((x) => <li key={x.code}>{t(`builder.issue.${x.code}`)}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('builder.addQuestion')}>
        {TYPES.map((type) => (
          <button key={type} type="button" className="btn-secondary btn-sm" onClick={() => onChange([...questions, newQuestion(type)])} data-testid={`add-${type}`}>
            <Icon name="plus" size={16} /> {t(`builder.type.${type}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
