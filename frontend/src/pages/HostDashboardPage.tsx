import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, exportUrl, type Auth } from '../api/client';
import { useAdminSession, useAnalytics, useLive, useMeta, useNow } from '../api/hooks';
import type { AdminSession, SessionStatus, Settings } from '../api/types';
import { BigNumbers } from '../components/AnalyticsPanels';
import { ComparePanel } from '../components/ComparePanel';
import { DescriptionLine } from '../components/DescriptionLine';
import { EditTextsDialog } from '../components/EditTextsDialog';
import { Icon } from '../components/Icon';
import { Footer, LangSwitch } from '../components/Layout';
import { ModerationDialog } from '../components/ModerationDialog';
import { CopyJoin, JoinInfo } from '../components/QrCard';
import { ResultsTabs } from '../components/ResultsTabs';
import { FieldLabel, InfoTip } from '../components/Tooltip';
import { Banner, ConfirmDialog, CopyButton, ErrorBox, Logo, LogoMark, Menu, MenuButton, MenuLink, Modal, Skeleton, StatusBadge, Toggle } from '../components/ui';
import { presentationName } from '../lib/presentation';
import { elapsedSeconds, formatDuration } from '../lib/stats';
import { findStoredSession, saveStoredSession } from '../lib/storage';
import { sessionLinks } from './HostNewPage';

function DashboardSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="min-h-0 flex-1" role="status" aria-label={t('common.loading')}>
      <div className="h-16 border-b border-line"><div className="mx-auto flex h-full max-w-[1600px] items-center gap-4 px-5 sm:px-8"><Skeleton className="h-7 w-36" /><Skeleton className="ml-auto h-11 w-28" /></div></div>
      <div className="mx-auto max-w-[1600px] space-y-8 px-5 py-10 sm:px-8">
        <Skeleton className="h-28 w-full max-w-3xl" />
        <div className="grid max-w-3xl grid-cols-3 gap-4"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

function KeyPrompt({ code }: { code: string }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [val, setVal] = useState('');
  return (
    <div className="mx-auto max-w-md px-5 py-20">
      <h1 className="text-3xl font-bold tracking-tight">{t('host.keyMissingTitle')}</h1>
      <p className="mt-2 text-ink-soft">{t('host.keyMissingText', { code })}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (val.trim()) nav(`/host/${code}?key=${encodeURIComponent(val.trim())}`, { replace: true });
        }}
        className="mt-6 space-y-4"
      >
        <label htmlFor="host-key" className="sr-only">{t('host.adminKey')}</label>
        <input id="host-key" className="input font-mono" value={val} onChange={(e) => setVal(e.target.value)} autoComplete="off" spellCheck={false} placeholder={t('host.adminKey')} />
        <button type="submit" className="btn-primary w-full" disabled={!val.trim()}>{t('common.open')}</button>
      </form>
      <p className="mt-6 text-center"><Link to="/host" className="underline underline-offset-4">{t('nav.mySessions')}</Link></p>
    </div>
  );
}

function SettingsModal({ open, onClose, session, code, auth }: { open: boolean; onClose: () => void; session: AdminSession; code: string; auth: Auth }) {
  const { t } = useTranslation();
  const demoMode = useMeta().data?.demo_mode ?? false;
  const retentionMax = demoMode ? 7 : 365;
  const qc = useQueryClient();
  const nav = useNavigate();
  const [title, setTitle] = useState(session.title);
  const [s, setS] = useState<Settings>(session.settings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await api.patchSession(code, auth, { title: title.trim() || session.title, settings: s });
      qc.setQueryData(['session', code, 'admin', auth.key], out);
      void qc.invalidateQueries({ queryKey: ['session', code] });
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.deleteSession(code, auth);
      qc.removeQueries({ queryKey: ['session', code] });
      try {
        const raw = window.localStorage.getItem('processpoll:host-sessions');
        if (raw) window.localStorage.setItem('processpoll:host-sessions', JSON.stringify((JSON.parse(raw) as { code: string }[]).filter((x) => x.code !== code)));
      } catch { void 0; }
      nav('/host');
    } catch (e) {
      setErr(e);
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('host.settings')}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy} data-testid="settings-save">{t('common.save')}</button>
          </>
        }
      >
        <div className="space-y-5">
          <div>
            <FieldLabel htmlFor="set-title" tip={t('tips.builder.title')}>{t('hostNew.sessionTitle')}</FieldLabel>
            <input id="set-title" className="input input-sm" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <Toggle checked={s.results_public} onChange={(v) => setS({ ...s, results_public: v })} label={t('hostNew.resultsPublic')} help={t('hostNew.resultsPublicHelp')} tip={t('tips.settings.resultsPublic')} />
          <Toggle checked={s.allow_resubmit} onChange={(v) => setS({ ...s, allow_resubmit: v })} label={t('hostNew.allowResubmit')} tip={t('tips.settings.allowResubmit')} />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="set-ret" tip={t('tips.settings.retention')}>{t('hostNew.retention')}</FieldLabel>
              <input id="set-ret" type="number" min={demoMode ? 7 : 1} max={retentionMax} disabled={demoMode} className="input input-sm" value={demoMode ? 7 : s.retention_days} onChange={(e) => setS({ ...s, retention_days: Math.min(retentionMax, Math.max(1, Number(e.target.value) || 90)) })} />
            </div>
            <div>
              <FieldLabel htmlFor="set-k" tip={t('tips.settings.kMin')}>{t('hostNew.kMin')}</FieldLabel>
              <input id="set-k" type="number" min={1} max={50} className="input input-sm" value={s.k_min} onChange={(e) => setS({ ...s, k_min: Math.min(50, Math.max(1, Number(e.target.value) || 5)) })} />
            </div>
          </div>
          {err != null && <ErrorBox error={err} />}
          <button type="button" className="btn-ghost btn-sm -ml-3 text-danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={16} /> {t('host.deleteSession')}
          </button>
        </div>
      </Modal>
      <ConfirmDialog open={confirmDelete} danger busy={busy} title={t('host.deleteTitle')} message={t('host.deleteText')} confirmLabel={t('host.deleteSession')} onCancel={() => setConfirmDelete(false)} onConfirm={() => void del()} />
    </>
  );
}

function DisplayModal({ open, onClose, session, code }: { open: boolean; onClose: () => void; session: AdminSession; code: string }) {
  const { t } = useTranslation();
  const links = sessionLinks(code, '', session.display_key);
  return (
    <Modal open={open} onClose={onClose} title={t('host.displayTitle')} footer={<button type="button" className="btn-ghost" onClick={onClose}>{t('common.close')}</button>}>
      <div className="space-y-4">
        <p className="text-ink-soft">{t('host.displayInfo')}</p>
        <div>
          <FieldLabel htmlFor="display-link" tip={t('tips.host.displayLink')}>{t('host.displayLink')}</FieldLabel>
          <input id="display-link" readOnly className="input input-sm font-mono !text-sm" value={links.display} onFocus={(e) => e.currentTarget.select()} />
        </div>
        <div className="flex flex-wrap gap-3">
          <CopyButton text={links.display} label={t('host.copyDisplayLink')} className="btn-secondary" />
          <a href={links.display} target="_blank" rel="noopener noreferrer" className="btn-primary" data-testid="open-display">
            <Icon name="monitor" size={18} /> {t('host.openDisplay')}
          </a>
        </div>
      </div>
    </Modal>
  );
}

export default function HostDashboardPage() {
  const { t } = useTranslation();
  const demoMode = useMeta().data?.demo_mode ?? false;
  const { code: rawCode = '' } = useParams();
  const code = rawCode.toUpperCase();
  const [sp] = useSearchParams();
  const qc = useQueryClient();
  const key = sp.get('key') ?? findStoredSession(code)?.admin_key ?? null;
  const auth: Auth | null = useMemo(() => (key ? { kind: 'admin', key } : null), [key]);

  const adminQ = useAdminSession(code, auth);
  const admin = adminQ.data;
  const { tick, state: liveState } = useLive(code, key, !!admin);
  const now = useNow(1000);

  const traceQuestions = useMemo(() => (admin?.questions ?? []).filter((q) => q.type === 'trace'), [admin?.questions]);
  const [qid, setQid] = useState<string | undefined>();
  const activeQid = qid && traceQuestions.some((q) => q.id === qid) ? qid : traceQuestions[0]?.id;
  const analyticsQ = useAnalytics(code, auth, activeQid ? { question_id: activeQid } : null, { enabled: !!admin });
  const analytics = analyticsQ.data;

  const [confirm, setConfirm] = useState<null | 'start' | 'close'>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDisplay, setShowDisplay] = useState(false);
  const [showMod, setShowMod] = useState(false);
  const [showTexts, setShowTexts] = useState(false);

  useEffect(() => {
    if (admin && key && !findStoredSession(code)) {
      saveStoredSession({ code, admin_key: key, display_key: admin.display_key, title: admin.title, created_at: admin.created_at });
    }
  }, [admin, key, code]);

  if (!code) return null;
  if (!auth) return <KeyPrompt code={code} />;
  if (adminQ.isPending) return <DashboardSkeleton />;
  if (adminQ.isError || !admin) {
    const e = adminQ.error;
    const bad = e instanceof ApiError && (e.status === 401 || e.status === 403);
    return (
      <div className="mx-auto max-w-md space-y-5 px-5 py-20" data-testid={bad ? 'invalid-key' : 'host-error'}>
        <ErrorBox error={e} title={bad ? t('host.invalidKeyTitle') : undefined} onRetry={bad ? undefined : () => void adminQ.refetch()} />
        {bad && <p className="text-ink-soft">{t('host.invalidKeyText')}</p>}
        <Link to="/host" className="btn-secondary">{t('nav.mySessions')}</Link>
      </div>
    );
  }

  const status: SessionStatus = (tick?.status ?? admin.status) as SessionStatus;
  const joined = tick?.joined ?? admin.joined;
  const elapsed = elapsedSeconds(admin.opened_at, now, status === 'closed' ? admin.closed_at : null);
  const activeQuestion = traceQuestions.find((q) => q.id === activeQid);
  const n = analytics?.n ?? tick?.submitted ?? admin.submitted;
  const analyticsReady = !!analytics || analyticsQ.isError;
  const waiting = traceQuestions.length > 0 && analyticsReady && n === 0;

  const setStatus = async (next: SessionStatus) => {
    setBusy(true);
    setActionError(null);
    try {
      const out = await api.patchSession(code, auth, { status: next });
      qc.setQueryData(['session', code, 'admin', auth.key], out);
      void qc.invalidateQueries({ queryKey: ['session', code] });
      setConfirm(null);
    } catch (e) {
      setActionError(e);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const question = (centered: boolean) => (
    <div className="min-w-0 max-w-full">
      <h1 className="text-display" data-testid="question-title">{activeQuestion ? presentationName(activeQuestion) : admin.title}</h1>
      <DescriptionLine text={admin.description} className={`mt-3 max-w-3xl text-lg ${centered ? 'mx-auto justify-center' : ''}`} />
      {traceQuestions.length > 1 && (
        <div className={`mt-3 flex items-center gap-1 ${centered ? 'justify-center' : ''}`}>
          <label htmlFor="trace-q" className="sr-only">{t('host.traceQuestion')}</label>
          <select id="trace-q" className="input input-sm !w-auto max-w-full" value={activeQid} onChange={(e) => setQid(e.target.value)} data-testid="trace-select">
            {traceQuestions.map((q) => <option key={q.id} value={q.id}>{presentationName(q)}</option>)}
          </select>
          <InfoTip text={t('tips.host.traceSelect')} />
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur-none" data-testid="host-header">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-5 sm:gap-5 sm:px-8">
          <Link to="/host" aria-label={t('nav.mySessions')} className="shrink-0">
            <span className="sm:hidden"><LogoMark size={28} /></span>
            <span className="hidden sm:inline"><Logo size="sm" /></span>
          </Link>
          <h2 className="hidden min-w-0 max-w-[24rem] truncate text-lg font-bold md:block" title={admin.title} data-testid="host-title">{admin.title}</h2>
          <StatusBadge status={status} />
          {elapsed != null && status !== 'draft' && (
            <span className="hidden text-sm tabular-nums text-ink-soft lg:inline" data-testid="elapsed"><span className="sr-only">{t('host.elapsed')}: </span>{formatDuration(elapsed)}</span>
          )}
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {status === 'open' && (
              <button type="button" className="btn-primary btn-sm !min-h-[44px]" onClick={() => void setStatus('paused')} disabled={busy} data-testid="host-pause"><Icon name="pause" size={16} /> {t('host.pause')}</button>
            )}
            {status === 'paused' && (
              <button type="button" className="btn-primary btn-sm !min-h-[44px]" onClick={() => void setStatus('open')} disabled={busy} data-testid="host-resume"><Icon name="play" size={16} /> {t('host.resume')}</button>
            )}
            <Menu label={t('host.menu')} testId="host-menu">
              {(close) => (
                <>
                  <MenuButton onClick={() => { close(); setShowTexts(true); }} testId="edit-texts" tip={t('tips.host.editTexts')}><Icon name="pen" size={18} /> {t('host.editTexts')}</MenuButton>
                  {traceQuestions.length > 0 && (
                    <MenuButton onClick={() => { close(); setShowMod(true); }} testId="open-moderation" tip={t('tips.moderation.merge')}><Icon name="merge" size={18} /> {t('moderation.open')}</MenuButton>
                  )}
                  <MenuButton onClick={() => { close(); setShowDisplay(true); }} testId="display-settings" tip={t('tips.host.displayLink')}><Icon name="monitor" size={18} /> {t('host.displayLink')}</MenuButton>
                  <div className="my-1 h-px bg-line" />
                  {(['csv', 'xes', 'json'] as const).map((f) => (
                    <MenuLink key={f} href={exportUrl(code, key ?? '', f, activeQid)} testId={`export-${f}`} tip={t(`tips.export.${f}`)}><Icon name="download" size={18} /> {t('host.exportAs', { format: f.toUpperCase() })}</MenuLink>
                  ))}
                  <div className="my-1 h-px bg-line" />
                  <MenuButton onClick={() => { close(); setShowSettings(true); }} testId="host-settings"><Icon name="settings" size={18} /> {t('host.settings')}</MenuButton>
                  {(status === 'open' || status === 'paused') && (
                    <MenuButton danger onClick={() => { close(); setConfirm('close'); }} testId="host-close"><Icon name="stop" size={18} /> {t('host.close')}</MenuButton>
                  )}
                </>
              )}
            </Menu>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-5 py-8 sm:px-8 sm:py-12">
        <div className="space-y-4 empty:hidden">
          {actionError != null && <ErrorBox error={actionError} />}
          {liveState === 'polling' && <Banner tone="warn" live>{t('host.pollingBanner')}</Banner>}
        </div>

        {traceQuestions.length === 0 ? (
          <div className="card px-6 py-16 text-center">
            <p className="text-2xl font-bold">{t('host.noTraceTitle')}</p>
            <p className="mt-1 text-ink-soft">{t('host.noTraceText')}</p>
          </div>
        ) : waiting || (status === 'draft' && !analytics?.n) ? (
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-10 py-6 text-center" data-testid="waiting">
            {question(true)}
            <JoinInfo code={code} size={220} layout="column">
              <p className="mt-3 text-lg text-ink-soft" aria-live="polite">{status === 'draft' ? t('host.draftHint') : t('host.waiting')}</p>
            </JoinInfo>
            {status === 'draft' && (
              <button type="button" className="btn-primary !min-h-[60px] px-10 text-xl" onClick={() => setConfirm('start')} data-testid="host-start"><Icon name="play" size={20} /> {t('host.start')}</button>
            )}
            {status === 'paused' && <p className="text-lg font-semibold">{t('host.pausedHint')}</p>}
            <p className="text-ink-soft"><span data-testid="count-joined">{joined}</span> {t('host.joined')}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:gap-14">
              <div className="min-w-0 space-y-8">
                {question(false)}
                <BigNumbers analytics={analytics} />
              </div>
              <aside className="card min-w-0 p-5 lg:w-[25rem] lg:self-start">
                <JoinInfo code={code} size={112}>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <CopyJoin code={code} />
                    <span className="inline-flex items-center gap-0.5 text-sm text-ink-soft"><span><span data-testid="count-joined">{joined}</span> {t('host.joined')}</span><InfoTip text={t('tips.host.joined')} /></span>
                  </div>
                </JoinInfo>
              </aside>
            </div>

            <div className="mt-12">
              {analyticsQ.isError && !analytics ? (
                <ErrorBox error={analyticsQ.error} onRetry={() => void analyticsQ.refetch()} />
              ) : (
                <ResultsTabs
                  analytics={analytics}
                  groups={<ComparePanel code={code} auth={auth} questions={admin.questions} traceQuestionId={activeQid} kMin={admin.settings.k_min} />}
                />
              )}
            </div>
          </>
        )}
      </main>

      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-2 sm:px-8">
        <span className="inline-flex items-center gap-2 text-sm text-ink-soft" data-testid="connection-indicator" data-state={liveState} role="status">
          <span className={`h-2.5 w-2.5 rounded-full ${liveState === 'live' ? 'bg-brand' : liveState === 'polling' ? 'bg-orange' : 'bg-slate'}`} aria-hidden="true" />
          {t(`connection.${liveState}`)}
        </span>
        <LangSwitch />
      </div>
      <Footer />

      <ConfirmDialog open={confirm === 'start'} title={t('host.confirmStartTitle')} message={t('host.confirmStartText')} confirmLabel={t('host.start')} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void setStatus('open')} />
      <ConfirmDialog open={confirm === 'close'} danger title={t('host.confirmCloseTitle')} message={t('host.confirmCloseText', { days: demoMode ? 7 : admin.settings.retention_days })} confirmLabel={t('host.close')} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void setStatus('closed')} />
      {showSettings && <SettingsModal open onClose={() => setShowSettings(false)} session={admin} code={code} auth={auth} />}
      <DisplayModal open={showDisplay} onClose={() => setShowDisplay(false)} session={admin} code={code} />
      {showTexts && <EditTextsDialog open onClose={() => setShowTexts(false)} session={admin} code={code} auth={auth} />}
      {showMod && <ModerationDialog open onClose={() => setShowMod(false)} code={code} auth={auth} questionId={activeQid} questionName={activeQuestion ? presentationName(activeQuestion) : undefined} />}
    </div>
  );
}
