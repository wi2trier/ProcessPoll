import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type Auth } from '../api/client';
import { useAnalytics, useLive, usePublicSession } from '../api/hooks';
import { BigNumbers } from '../components/AnalyticsPanels';
import { DescriptionLine } from '../components/DescriptionLine';
import { JoinInfo } from '../components/QrCard';
import { ResultsTabs } from '../components/ResultsTabs';
import { ErrorBox, Logo, Spinner, StatusBadge } from '../components/ui';
import { presentationName } from '../lib/presentation';

function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 900 : window.innerHeight));
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}

export default function DisplayPage() {
  const { t } = useTranslation();
  const { code: raw = '' } = useParams();
  const code = raw.toUpperCase();
  const [sp] = useSearchParams();
  const key = sp.get('key');
  const auth: Auth | null = useMemo(() => (key ? { kind: 'display', key } : null), [key]);
  const vh = useViewportHeight();

  const sessionQ = usePublicSession(code);
  const session = sessionQ.data;
  const { tick, state } = useLive(code, key, !!session);
  const traceQ = session?.questions.find((q) => q.type === 'trace');
  const analyticsQ = useAnalytics(code, auth, traceQ ? { question_id: traceQ.id } : null, { enabled: !!session });
  const a = analyticsQ.data;

  if (sessionQ.isPending) return <div className="min-h-0 flex-1 bg-white"><Spinner /></div>;
  if (sessionQ.isError || !session) {
    return <div className="min-h-0 flex-1 bg-white p-8"><div className="mx-auto max-w-lg"><ErrorBox error={sessionQ.error} onRetry={() => void sessionQ.refetch()} /></div></div>;
  }
  const status = tick?.status ?? session.status;
  const forbidden = analyticsQ.error instanceof ApiError && (analyticsQ.error.status === 401 || analyticsQ.error.status === 403);
  const banner = status === 'paused' ? t('display.paused') : status === 'closed' ? t('display.closed') : status === 'draft' ? t('display.draft') : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white p-[clamp(1.25rem,2.5vw,3.5rem)] text-ink" data-testid="display-page">
      <header className="flex items-center justify-between gap-4">
        <Logo size="md" />
        <div className="flex items-center gap-5 text-[clamp(1rem,1.4vw,1.5rem)]">
          <StatusBadge status={status} large />
          <span className="tabular-nums text-ink-soft"><span data-testid="display-joined">{tick?.joined ?? 0}</span> {t('host.joined')}</span>
        </div>
      </header>

      <div className="mt-[clamp(1.5rem,3vw,4rem)] grid items-center gap-[clamp(1.5rem,3vw,4rem)] lg:grid-cols-[1fr_auto]">
        <div>
          <h1 className="text-[clamp(2.25rem,5vw,6rem)] font-display font-bold leading-[1.06] tracking-tight" data-testid="display-title">{traceQ ? presentationName(traceQ) : session.title}</h1>
          <DescriptionLine text={session.description} className="mt-[clamp(0.75rem,1.5vw,2rem)] max-w-[70rem]" textClassName="text-[clamp(1.1rem,1.8vw,2.25rem)] leading-snug" />
          {banner && <p className="mt-6 text-[clamp(1.25rem,2vw,2.5rem)] font-semibold text-orange-dark">{banner}</p>}
        </div>
        <JoinInfo code={code} size={320} fluid layout="column" />
      </div>

      <div className="mt-[clamp(1.5rem,3vw,4rem)] flex-1">
        {forbidden ? (
          <ErrorBox error={analyticsQ.error} title={t('display.keyProblem')} />
        ) : (
          <div className="space-y-[clamp(1.5rem,3vw,3.5rem)]">
            <BigNumbers analytics={a} large />
            <ResultsTabs analytics={a} large initial="flow" flowHeight={Math.max(420, Math.round(vh * 0.62))} flowControls={false} />
          </div>
        )}
      </div>
      <footer className="mt-8 flex items-center justify-center gap-2 text-ink-soft" data-state={state}>
        <span className={`h-2.5 w-2.5 rounded-full ${state === 'live' ? 'bg-brand' : 'bg-orange'}`} aria-hidden="true" />
        {t(`connection.${state}`)}
      </footer>
    </div>
  );
}
