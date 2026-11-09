import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useMeta } from '../api/hooks';
import type { CreateSessionOut, Settings } from '../api/types';
import { Icon } from '../components/Icon';
import { QuestionBuilder } from '../components/QuestionBuilder';
import { FieldLabel, InfoTip } from '../components/Tooltip';
import { AutoTextarea, Banner, CopyButton, ErrorBox, Toggle } from '../components/ui';
import { DEFAULT_SETTINGS, morningDescription, morningTemplate, toQuestionsIn, validateBuilder, type BuilderQuestion } from '../lib/builder';
import { emptyToNull, MAX_DESCRIPTION } from '../lib/presentation';
import { saveStoredSession } from '../lib/storage';

export function sessionLinks(code: string, adminKey: string, displayKey: string) {
  const o = typeof window !== 'undefined' ? window.location.origin : '';
  return {
    host: `${o}/host/${code}?key=${encodeURIComponent(adminKey)}`,
    display: `${o}/display/${code}?key=${encodeURIComponent(displayKey)}`,
    join: `${o}/j/${code}`,
  };
}

function SaveLinkScreen({ created, stored }: { created: CreateSessionOut; stored: boolean }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const links = sessionLinks(created.code, created.admin_key, created.display_key);
  return (
    <div className="mx-auto max-w-xl px-5 py-12" data-testid="host-saved">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-white"><Icon name="check" size={32} /></span>
      <h1 className="mt-6 text-4xl font-bold tracking-tight">{t('hostNew.createdTitle')}</h1>
      <p className="mt-1 text-lg text-ink-soft">{t('hostNew.createdCode')} <strong className="font-mono text-ink" data-testid="created-code">{created.code}</strong></p>

      <FieldLabel htmlFor="host-link" tip={t('tips.host.hostLink')} className="mt-8">{t('hostNew.hostLink')}</FieldLabel>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input id="host-link" readOnly className="input input-sm font-mono !text-sm" value={links.host} onFocus={(e) => e.currentTarget.select()} data-testid="host-link" />
        <CopyButton text={links.host} className="btn-primary shrink-0" testId="host-link-copy" />
      </div>
      <p className="mt-4 flex items-start gap-2 font-semibold text-orange-dark" role="note">
        <Icon name="warning" size={20} className="mt-0.5 shrink-0" /> {t('hostNew.warning')}
      </p>
      {!stored && <div className="mt-4"><Banner tone="error" live>{t('hostNew.storageFailed')}</Banner></div>}

      <button type="button" className="btn-primary mt-10 !min-h-[56px] px-10 text-lg" onClick={() => nav(`/host/${created.code}?key=${encodeURIComponent(created.admin_key)}`)} data-testid="host-continue">
        {t('hostNew.toDashboard')}
      </button>
    </div>
  );
}

function TemplateTile({ title, text, onClick, testId }: { title: string; text: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} className="group flex min-h-[180px] flex-col justify-between rounded-2xl border border-line bg-white p-6 text-left transition-colors hover:border-brand">
      <span className="font-display text-3xl font-bold tracking-tight">{title}</span>
      <span className="mt-6 flex items-end justify-between gap-4 text-ink-soft">
        <span>{text}</span>
        <Icon name="next" size={24} className="shrink-0 text-ink transition-transform group-hover:translate-x-1" />
      </span>
    </button>
  );
}

export default function HostNewPage() {
  const { t } = useTranslation();
  const demoMode = useMeta().data?.demo_mode ?? false;
  const retentionMax = demoMode ? 7 : 365;
  const [step, setStep] = useState<'template' | 'edit'>('template');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [questions, setQuestions] = useState<BuilderQuestion[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [created, setCreated] = useState<{ out: CreateSessionOut; stored: boolean } | null>(null);

  const issues = validateBuilder(title, questions, description);

  if (created) return <SaveLinkScreen created={created.out} stored={created.stored} />;

  if (step === 'template') {
    return (
      <div className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{t('hostNew.title')}</h1>
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          <TemplateTile testId="template-morning" title={t('hostNew.templateMorning')} text={t('hostNew.templateMorningText')} onClick={() => { setQuestions(morningTemplate(t)); setTitle(t('templates.morning.title')); setDescription(morningDescription(t)); setSettings({ ...DEFAULT_SETTINGS, retention_days: demoMode ? 7 : DEFAULT_SETTINGS.retention_days }); setStep('edit'); }} />
          <TemplateTile testId="template-empty" title={t('hostNew.templateEmpty')} text={t('hostNew.templateEmptyText')} onClick={() => { setQuestions([]); setTitle(''); setDescription(''); setSettings({ ...DEFAULT_SETTINGS, retention_days: demoMode ? 7 : DEFAULT_SETTINGS.retention_days }); setStep('edit'); }} />
        </div>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setShowIssues(true);
    if (issues.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.createSession({ title: title.trim(), description: emptyToNull(description), questions: toQuestionsIn(questions), settings });
      const stored = saveStoredSession({
        code: out.code,
        admin_key: out.admin_key,
        display_key: out.display_key,
        title: out.session?.title ?? title.trim(),
        created_at: out.session?.created_at ?? new Date().toISOString(),
      });
      setCreated({ out, stored });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto max-w-2xl space-y-8 px-5 py-8" noValidate>
      <div>
        <button type="button" className="btn-ghost btn-sm -ml-3" onClick={() => setStep('template')}><Icon name="back" size={16} /> {t('hostNew.templates')}</button>
        <label htmlFor="s-title" className="sr-only">{t('hostNew.sessionTitle')}</label>
        <div className="mt-2 flex items-end gap-1">
          <input id="s-title" className="min-w-0 flex-1 border-0 border-b-2 border-edge bg-transparent pb-2 font-display text-4xl font-bold tracking-tight placeholder:text-edge focus:border-brand focus:outline-none" placeholder={t('hostNew.sessionTitle')} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-testid="session-title" aria-invalid={showIssues && !title.trim()} />
          <InfoTip text={t('tips.builder.title')} className="mb-3" />
        </div>
        {showIssues && !title.trim() && <p className="mt-2 font-semibold text-danger" role="alert">{t('builder.issue.title_required')}</p>}

        <div className="mt-5">
          <FieldLabel htmlFor="s-description" tip={t('tips.builder.description')} hint={<span className={`ml-auto text-sm tabular-nums ${description.length >= MAX_DESCRIPTION ? 'font-semibold text-danger' : 'text-ink-soft'}`} aria-hidden="true">{t('builder.counter', { count: description.length, max: MAX_DESCRIPTION })}</span>}>
            {t('builder.description')}
          </FieldLabel>
          <AutoTextarea
            id="s-description"
            minRows={3}
            maxRows={10}
            className="input input-sm"
            placeholder={t('builder.descriptionPlaceholder')}
            value={description}
            maxLength={MAX_DESCRIPTION}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="session-description"
            aria-invalid={showIssues && issues.some((x) => x.code === 'description_too_long')}
          />
          {showIssues && issues.some((x) => x.code === 'description_too_long') && <p className="mt-1 font-semibold text-danger" role="alert">{t('builder.issue.description_too_long')}</p>}
        </div>
      </div>

      <QuestionBuilder questions={questions} onChange={setQuestions} issues={showIssues ? issues : []} />

      <details className="group card p-5">
        <summary className="flex cursor-pointer list-none items-center justify-between text-lg font-bold">
          {t('hostNew.advanced')}
          <Icon name="down" size={20} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-5 space-y-5">
          <Toggle checked={settings.results_public} onChange={(v) => setSettings({ ...settings, results_public: v })} label={t('hostNew.resultsPublic')} help={t('hostNew.resultsPublicHelp')} tip={t('tips.settings.resultsPublic')} />
          <Toggle checked={settings.allow_resubmit} onChange={(v) => setSettings({ ...settings, allow_resubmit: v })} label={t('hostNew.allowResubmit')} tip={t('tips.settings.allowResubmit')} />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="s-ret" tip={t('tips.settings.retention')}>{t('hostNew.retention')}</FieldLabel>
              <input id="s-ret" type="number" min={demoMode ? 7 : 1} max={retentionMax} disabled={demoMode} className="input input-sm" value={demoMode ? 7 : settings.retention_days} onChange={(e) => setSettings({ ...settings, retention_days: num(e.target.value, 1, retentionMax, 90) })} />
            </div>
            <div>
              <FieldLabel htmlFor="s-k" tip={t('tips.settings.kMin')}>{t('hostNew.kMin')}</FieldLabel>
              <input id="s-k" type="number" min={1} max={50} className="input input-sm" value={settings.k_min} onChange={(e) => setSettings({ ...settings, k_min: num(e.target.value, 1, 50, 5) })} />
            </div>
          </div>
        </div>
      </details>

      {showIssues && issues.length > 0 && <Banner tone="error" live>{t('hostNew.fixIssues', { count: issues.length })}</Banner>}
      {error != null && <ErrorBox error={error} />}
      <div className="flex justify-end">
        <button type="submit" className="btn-primary !min-h-[56px] px-10 text-lg" disabled={busy} data-testid="create-session">
          {busy ? t('common.loading') : t('hostNew.create')}
        </button>
      </div>
    </form>
  );
}
