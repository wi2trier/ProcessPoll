import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAnalytics, useLive } from '../api/hooks';
import type { Question } from '../api/types';
import { BigNumbers } from './AnalyticsPanels';
import { Icon } from './Icon';
import { ResultsTabs } from './ResultsTabs';
import { ErrorBox, Spinner } from './ui';
import { presentationName } from '../lib/presentation';

export function ResultsView({ code, questions, onBack }: { code: string; questions: Question[]; onBack: () => void }) {
  const { t } = useTranslation();
  const traceQs = questions.filter((q) => q.type === 'trace');
  const [qid, setQid] = useState(traceQs[0]?.id);
  useLive(code, null, true);
  const a = useAnalytics(code, null, qid ? { question_id: qid } : null, { refetchInterval: 15000 });
  const current = traceQs.find((q) => q.id === qid);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-5 pb-16 pt-4">
      <button type="button" className="btn-ghost -ml-4" onClick={onBack}><Icon name="back" size={18} /> {t('results.back')}</button>
      <div>
        {traceQs.length > 1 ? (
          <>
            <label htmlFor="res-q" className="sr-only">{t('results.question')}</label>
            <select id="res-q" className="input" value={qid} onChange={(e) => setQid(e.target.value)}>
              {traceQs.map((q) => <option key={q.id} value={q.id}>{presentationName(q)}</option>)}
            </select>
          </>
        ) : (
          <h1 className="text-[30px] font-bold leading-[1.08] tracking-tight sm:text-4xl">{current ? presentationName(current) : t('results.title')}</h1>
        )}
      </div>
      {a.isPending ? (
        <Spinner />
      ) : a.isError && !a.data ? (
        <ErrorBox error={a.error} onRetry={() => void a.refetch()} />
      ) : (
        <>
          <BigNumbers analytics={a.data} />
          <ResultsTabs analytics={a.data} flowHeight={420} />
        </>
      )}
    </div>
  );
}
