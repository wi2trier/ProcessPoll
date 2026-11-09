import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAnalytics, usePublicSession } from '../api/hooks';
import type { Question } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Footer, LangSwitch, PrivacyLink } from '../components/Layout';
import { QuestionField } from '../components/QuestionField';
import { IconTip } from '../components/Tooltip';
import { Banner, ErrorBox, Logo, Progress, Spinner } from '../components/ui';
import { buildAnswers, emptyAnswer, type FieldErrors, type RawAnswer, type RawAnswers } from '../lib/answers';
import { isRetryable } from '../lib/apiErrors';
import { normalizeJoinCode } from '../lib/joinCode';
import { clearDraft, loadParticipant, saveParticipant } from '../lib/storage';
import { uuid } from '../lib/uuid';
import { canSkip, deriveSteps, firstInvalidStep, primaryAction, progress, validateStep } from '../lib/wizard';

const ResultsView = lazy(() => import('../components/ResultsView').then((m) => ({ default: m.ResultsView })));

const MAX_AUTO_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Frame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={`mx-auto flex w-full items-center justify-between px-5 py-3 ${wide ? 'max-w-3xl' : 'max-w-[560px]'}`}>
        <Link to="/" aria-label="ProcessPoll"><Logo size="sm" /></Link>
        <LangSwitch />
      </header>
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

function Notice({ icon, title, text, children, testId, tone = 'neutral' }: { icon: IconName; title: string; text?: string; children?: ReactNode; testId?: string; tone?: 'neutral' | 'success' }) {
  return (
    <div className="mx-auto flex max-w-[560px] flex-col items-center px-5 pb-16 pt-[12vh] text-center" data-testid={testId} role="status" aria-live="polite">
      <span className={`flex h-20 w-20 items-center justify-center rounded-2xl ${tone === 'success' ? 'bg-brand text-white' : 'bg-line text-ink'}`}>
        <Icon name={icon} size={38} />
      </span>
      <h1 className="mt-8 text-4xl font-bold leading-[1.05] tracking-tight">{title}</h1>
      {text && <p className="mt-3 text-lg text-ink-soft">{text}</p>}
      <div className="mt-8 flex flex-col items-center gap-3">{children}</div>
    </div>
  );
}

function AnonymityNote() {
  const { t } = useTranslation();
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-sm text-ink-soft [@media(max-height:500px)]:hidden">
      <Icon name="lock" size={14} /> {t('participant.anonymous')} <PrivacyLink className="font-semibold underline underline-offset-2" />
    </p>
  );
}

function Intro({ title, description }: { title: string; description: string }) {
  const textId = useId();
  return (
    <section className="mb-7 rounded-2xl border border-line bg-white px-4 py-3.5" aria-labelledby={`${textId}-title`} data-testid="poll-intro">
      <h2 id={`${textId}-title`} className="font-display text-base font-bold leading-snug">{title}</h2>
      <p id={textId} className="mt-1 whitespace-pre-line break-words text-ink-soft" data-testid="poll-description">
        {description}
      </p>
    </section>
  );
}

function QuestionRow(props: {
  code: string;
  question: Question;
  value: RawAnswer;
  onChange: (v: RawAnswer) => void;
  error?: FieldErrors[string];
  serverError?: string;
}) {
  const { code, question, ...rest } = props;
  const qid = question.id;

  const fetchSuggestions = useCallback((q: string) => api.suggestLabels(code, qid, q), [code, qid]);
  return <QuestionField question={question} fetchSuggestions={question.type === 'trace' ? fetchSuggestions : undefined} {...rest} />;
}

export default function ParticipantPage() {
  const { t } = useTranslation();
  const params = useParams();
  const code = normalizeJoinCode(params.code ?? '');
  const sessionQ = usePublicSession(code);
  const refetchSession = sessionQ.refetch;
  const session = sessionQ.data;

  const [answers, setAnswers] = useState<RawAnswers>({});
  const [restored, setRestored] = useState(false);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [phase, setPhase] = useState<'form' | 'thanks' | 'results'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [retryInfo, setRetryInfo] = useState<number | null>(null);
  const [joinError, setJoinError] = useState<unknown>(null);
  const joinStarted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const questions = useMemo(() => [...(session?.questions ?? [])].sort((a, b) => a.position - b.position), [session?.questions]);
  const steps = useMemo(() => deriveSteps(questions), [questions]);
  const resultsPublic = !!session?.settings?.results_public;
  const allowResubmit = !!session?.settings?.allow_resubmit;
  const firstTrace = questions.find((q) => q.type === 'trace');

  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => void refetchSession(), 5000);
    return () => clearInterval(id);

  }, [code, refetchSession]);

  const doJoin = useCallback(async (forceNew = false) => {
    const st = loadParticipant(code);
    const res = await api.join(code, forceNew ? undefined : st.token);
    saveParticipant(code, { token: res.participant_token });
    return res;
  }, [code]);

  const runJoin = useCallback(async () => {
    setJoinError(null);
    try {
      const res = await doJoin();
      if (!mounted.current) return;
      setHasSubmitted(res.has_submitted);
      if (res.has_submitted) saveParticipant(code, { submitted: true });
    } catch (e) {
      if (mounted.current) setJoinError(e);
    }
  }, [doJoin, code]);

  useEffect(() => {
    if (!session || joinStarted.current) return;
    joinStarted.current = true;
    void runJoin();
  }, [session, runJoin]);

  useEffect(() => {
    if (!session || restored) return;
    const st = loadParticipant(code);
    const draft = (st.draft ?? {}) as RawAnswers;
    const init: RawAnswers = {};
    for (const q of session.questions) {
      const d = draft[q.id];
      init[q.id] = d !== undefined && (Array.isArray(d) === Array.isArray(emptyAnswer(q))) ? d : emptyAnswer(q);
    }
    setAnswers(init);
    setRestored(true);
  }, [session, restored, code]);

  useEffect(() => {
    if (!restored) return;
    const id = setTimeout(() => saveParticipant(code, { draft: answers }), 300);
    return () => clearTimeout(id);
  }, [answers, restored, code]);

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo?.({ top: 0 });
    document.querySelector<HTMLElement>('[data-wizard] h1')?.focus();
  }, [step, phase]);

  const setAnswer = (qid: string, v: RawAnswer) => {
    setAnswers((a) => ({ ...a, [qid]: v }));
    setErrors((e) => {
      if (!e[qid]) return e;
      const n = { ...e };
      delete n[qid];
      return n;
    });
    setServerErrors((e) => {
      if (!e[qid]) return e;
      const n = { ...e };
      delete n[qid];
      return n;
    });
  };

  const current = steps[Math.min(step, Math.max(0, steps.length - 1))];
  const action = primaryAction(step, steps.length);

  const goNext = () => {
    if (!current) return;
    const err = validateStep(current, answers);
    if (err) {
      setErrors((e) => ({ ...e, [current.question.id]: err }));
      return;
    }
    setSubmitError(null);
    setStep((s) => Math.min(steps.length - 1, s + 1));
  };

  const submit = async () => {
    if (!session || submitting) return;
    setSubmitError(null);
    setServerErrors({});
    const { answers: payload, errors: errs } = buildAnswers(questions, answers);
    setErrors(errs);
    const bad = firstInvalidStep(steps, answers);
    if (bad >= 0) {
      setStep(bad);
      return;
    }
    setSubmitting(true);

    let st = loadParticipant(code);
    let key = st.idempotencyKey;
    if (!key) {
      key = uuid();
      saveParticipant(code, { idempotencyKey: key });
    }
    let reJoined = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          st = loadParticipant(code);
          let token = st.token;
          if (!token) token = (await doJoin()).participant_token;
          await api.submit(code, token, key, payload);
          break;
        } catch (e) {
          if (e instanceof ApiError && e.status === 401 && !reJoined) {
            reJoined = true;
            await doJoin(true);
            continue;
          }
          if (e instanceof ApiError && isRetryable(e.status) && attempt < MAX_AUTO_RETRIES) {
            if (mounted.current) setRetryInfo(attempt + 1);
            await sleep(e.retryAfter != null ? Math.max(500, e.retryAfter * 1000) : 1000 * 2 ** attempt);
            continue;
          }
          throw e;
        }
      }
      saveParticipant(code, { submitted: true, idempotencyKey: undefined });
      if (!allowResubmit) clearDraft(code);
      if (mounted.current) {
        setHasSubmitted(true);
        setPhase('thanks');
      }
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError) {
        if (e.status === 422 && e.errors.some((x) => x.question_id)) {
          const m: Record<string, string> = {};
          for (const it of e.errors) if (it.question_id) m[it.question_id] = it.message;
          setServerErrors(m);
          const idx = steps.findIndex((s) => m[s.question.id]);
          if (idx >= 0) setStep(idx);
          saveParticipant(code, { idempotencyKey: undefined });
        } else if (e.status === 409 && e.detail === 'already_submitted') {
          setHasSubmitted(true);
          saveParticipant(code, { submitted: true, idempotencyKey: undefined });
        } else if (e.status === 403) {
          void sessionQ.refetch();
        } else if (!isRetryable(e.status)) {
          saveParticipant(code, { idempotencyKey: undefined });
        }
      }
      setSubmitError(e);
    } finally {
      if (mounted.current) {
        setSubmitting(false);
        setRetryInfo(null);
      }
    }
  };

  if (!code) return <Frame><div className="mx-auto max-w-[560px] p-5"><ErrorBox error={new ApiError(404, { detail: 'not_found' })} /></div></Frame>;

  if (sessionQ.isPending) return <Frame><Spinner /></Frame>;

  if (sessionQ.isError || !session) {
    const e = sessionQ.error;
    if (e instanceof ApiError && e.status === 404) {
      return (
        <Frame>
          <Notice icon="warning" testId="invalid-code" title={t('participant.invalidTitle')} text={t('participant.invalidText', { code })}>
            <Link to="/" className="btn-primary">{t('participant.tryAnother')}</Link>
          </Notice>
        </Frame>
      );
    }
    if (e instanceof ApiError && e.status === 429) {
      return (
        <Frame>
          <Notice icon="clock" testId="too-many-attempts" title={t('participant.tooManyTitle')} text={t('participant.tooManyText')}>
            <button type="button" className="btn-primary" onClick={() => void sessionQ.refetch()}>{t('common.retry')}</button>
            <Link to="/" className="btn-ghost">{t('participant.tryAnother')}</Link>
          </Notice>
        </Frame>
      );
    }
    return <Frame><div className="mx-auto max-w-[560px] p-5"><ErrorBox error={e} onRetry={() => void sessionQ.refetch()} /></div></Frame>;
  }

  const status = session.status;
  const resultsBtn = resultsPublic && firstTrace ? <ResultsButton code={code} questionId={firstTrace.id} onClick={() => setPhase('results')} /> : null;

  if (phase === 'results') {
    return (
      <Frame wide>
        <Suspense fallback={<Spinner />}>
          <ResultsView code={code} questions={questions} onBack={() => setPhase(hasSubmitted ? 'thanks' : 'form')} />
        </Suspense>
      </Frame>
    );
  }

  if (status === 'draft') {
    return <Frame><Notice icon="clock" testId="state-draft" title={t('participant.draftTitle')} text={session.title} /></Frame>;
  }

  if (status === 'closed') {
    return (
      <Frame>
        <Notice icon="lock" testId="state-closed" title={t('participant.closedTitle')} text={hasSubmitted ? t('participant.closedSubmitted') : undefined}>
          {resultsBtn}
        </Notice>
      </Frame>
    );
  }

  if (phase === 'thanks') {
    return (
      <Frame>
        <Notice icon="check" tone="success" testId="submit-success" title={t('participant.thanksTitle')} text={t('participant.anonymous')}>
          {resultsBtn}
          <PrivacyLink className="text-sm font-semibold text-ink-soft underline underline-offset-2" />
          {allowResubmit && status === 'open' && (
            <button type="button" className="btn-secondary" onClick={() => { setStep(0); setPhase('form'); }}>{t('participant.editAgain')}</button>
          )}
        </Notice>
      </Frame>
    );
  }

  if (hasSubmitted && !allowResubmit) {
    return (
      <Frame>
        <Notice icon="check" tone="success" testId="state-already-submitted" title={t('participant.alreadyTitle')}>
          {resultsBtn}
        </Notice>
      </Frame>
    );
  }

  if (status === 'paused') {
    return <Frame><Notice icon="pause" testId="state-paused" title={t('participant.pausedTitle')} text={t('participant.pausedText')} /></Frame>;
  }

  if (!current) return <Frame><Spinner /></Frame>;

  const submitErr = submitError instanceof ApiError ? submitError : null;
  const q = current.question;
  const showBanner = !!submitError && !(submitErr?.status === 422 && serverErrors[q.id]);
  const skippable = canSkip(current, answers);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-wizard>
      <div className="fixed inset-x-0 top-0 z-30"><Progress value={progress(step, steps.length)} label={t('participant.progress', { n: step + 1, total: steps.length })} /></div>
      <header className="mx-auto flex h-14 w-full max-w-[560px] items-center justify-between px-3 pt-1.5">
        {step > 0 ? (
          <IconTip label={t('participant.back')} placement="bottom">
            <button type="button" className="btn-icon" onClick={() => { setSubmitError(null); setStep((s) => Math.max(0, s - 1)); }} aria-label={t('participant.back')} data-testid="wizard-back">
              <Icon name="back" />
            </button>
          </IconTip>
        ) : (
          <span className="pl-2"><Logo size="sm" /></span>
        )}
        <LangSwitch />
      </header>

      <form
        className="mx-auto w-full max-w-[560px] flex-1 px-5 pb-48 pt-4 [@media(max-height:500px)]:pb-32"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (action === 'submit') void submit();
          else goNext();
        }}
      >
        {step === 0 && session.description?.trim() ? (
          <Intro title={session.title} description={session.description.trim()} />
        ) : (
          <h2 className="sr-only">{session.title}</h2>
        )}
        {hasSubmitted && allowResubmit && <div className="mb-4"><Banner tone="info">{t('participant.resubmitInfo')}</Banner></div>}
        {joinError != null && (
          <div className="mb-4"><ErrorBox error={joinError} onRetry={() => { joinStarted.current = true; void runJoin(); }} /></div>
        )}
        <div key={q.id} className="animate-[fadein_.2s_ease-out]">
          <QuestionRow
            code={code}
            question={q}
            value={answers[q.id] ?? emptyAnswer(q)}
            onChange={(v) => setAnswer(q.id, v)}
            error={errors[q.id]}
            serverError={serverErrors[q.id]}
          />
        </div>
        <div aria-live="polite" className="mt-4 space-y-3">
          {retryInfo != null && <Banner tone="warn" live>{t('participant.retrying', { n: retryInfo, max: MAX_AUTO_RETRIES })}</Banner>}
          {showBanner && <ErrorBox error={submitError} />}
        </div>

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 [@media(max-height:500px)]:pb-2 [@media(max-height:500px)]:pt-2">
          <div className="mx-auto max-w-[560px]">
            {action === 'next' ? (
              <button type="submit" className="btn-primary w-full !min-h-[56px] text-lg" data-testid="wizard-next">
                {t('participant.next')}
              </button>
            ) : (
              <button type="submit" className="btn-primary w-full !min-h-[56px] text-lg" disabled={submitting} data-testid="trace-submit">
                {submitting ? t('participant.submitting') : submitError && isSubmitRetry(submitError) ? t('participant.retrySubmit') : t('participant.submit')}
              </button>
            )}
            <div className="mt-1 flex min-h-[40px] items-center justify-center">
              {skippable ? (
                <button type="button" className="btn-ghost btn-sm" onClick={action === 'submit' ? () => void submit() : goNext} data-testid="wizard-skip">
                  {t('participant.skip')}
                </button>
              ) : action === 'submit' ? (
                <AnonymityNote />
              ) : null}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function isSubmitRetry(e: unknown): boolean {
  return e instanceof ApiError && isRetryable(e.status);
}

function ResultsButton({ code, questionId, onClick }: { code: string; questionId: string; onClick: () => void }) {
  const { t } = useTranslation();
  const a = useAnalytics(code, null, { question_id: questionId });
  if (a.isError || !a.data || a.data.n === 0) return null;
  return (
    <button type="button" className="btn-primary" onClick={onClick} data-testid="see-results">
      <Icon name="chart" size={18} /> {t('participant.seeResults')}
    </button>
  );
}
