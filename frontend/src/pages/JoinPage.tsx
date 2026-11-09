import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isPlausibleJoinCode, normalizeJoinCode } from '../lib/joinCode';

export default function JoinPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = normalizeJoinCode(code);
    if (!isPlausibleJoinCode(c)) {
      setError(t('join.invalid'));
      return;
    }
    nav(`/p/${encodeURIComponent(c)}`);
  };

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-5 pb-16 pt-[14vh] text-center">
      <h1 className="mt-8 text-4xl font-bold tracking-tight sm:text-5xl">{t('join.title')}</h1>
      <form onSubmit={submit} className="mt-8 w-full" noValidate>
        <label htmlFor="join-code" className="sr-only">{t('join.codeLabel')}</label>
        <input
          id="join-code"
          data-testid="join-code-input"
          className="input text-center font-display text-2xl font-bold uppercase tracking-widest placeholder:font-medium placeholder:normal-case placeholder:tracking-normal"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(''); }}
          placeholder="MORN-24"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          aria-invalid={!!error}
          aria-describedby="join-hint"
          autoFocus
        />
        <p id="join-hint" role={error ? 'alert' : undefined} className={`mt-3 min-h-[1.5rem] text-base ${error ? 'font-semibold text-danger' : ''}`}>
          {error}
        </p>
        <button type="submit" className="btn-primary mt-3 !min-h-[56px] px-12 text-lg" data-testid="join-submit">
          {t('join.submit')}
        </button>
      </form>
      <p className="mt-16 text-base">
        <Link to="/host/new" className="font-semibold text-ink-soft underline underline-offset-4 hover:text-ink" data-testid="create-poll-link">{t('join.createPoll')}</Link>
      </p>
    </div>
  );
}

export function JoinRedirect() {
  const { code = '' } = useParams();
  return <Navigate to={`/p/${encodeURIComponent(normalizeJoinCode(code))}`} replace />;
}
