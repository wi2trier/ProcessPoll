import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMeta } from '../api/hooks';
import { LANGUAGES } from '../i18n';
import { Logo } from './ui';

export function LangSwitch() {
  const { i18n, t } = useTranslation();
  const current = i18n.language?.startsWith('de') ? 'de' : 'en';
  return (
    <div role="group" aria-label={t('common.language')} className="inline-flex items-center text-sm font-semibold text-ink">
      {LANGUAGES.map((l, i) => (
        <span key={l} className="inline-flex items-center">
          {i > 0 && <span aria-hidden="true" className="opacity-30">|</span>}
          <button
            type="button"
            lang={l}
            aria-pressed={current === l}
            onClick={() => void i18n.changeLanguage(l)}
            className={`min-h-[40px] rounded-lg px-2.5 uppercase ${current === l ? 'underline decoration-2 underline-offset-4' : 'opacity-60 hover:opacity-100'}`}
          >
            {l}
          </button>
        </span>
      ))}
    </div>
  );
}

export function PrivacyLink({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return <Link className={className} to="/privacy" data-testid="privacy-link">{t('footer.privacy')}</Link>;
}

export function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="px-4 py-6 text-center text-sm text-ink-soft">
      <nav aria-label={t('footer.nav')} className="flex items-center justify-center gap-2">
        <PrivacyLink className="underline-offset-2 hover:underline" />
        <span aria-hidden="true">·</span>
        <Link className="underline-offset-2 hover:underline" to="/contact">{t('footer.contact')}</Link>
        <span aria-hidden="true">·</span>
        <Link className="underline-offset-2 hover:underline" to="/imprint">{t('footer.imprint')}</Link>
      </nav>
    </footer>
  );
}

export function DemoBanner() {
  const { t } = useTranslation();
  if (!useMeta().data?.demo_mode) return null;
  return (
    <aside role="status" className="border-b border-orange/40 bg-orange-light px-4 py-3 text-center text-sm font-semibold text-[#5C3600]">
      <span>{t('demo.banner')}</span>
    </aside>
  );
}

export function SiteLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <a href="#main" className="sr-only-focusable rounded bg-white px-3 py-2 font-semibold shadow">{t('common.skipToContent')}</a>
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-3">
        <Link to="/" aria-label="ProcessPoll"><Logo size="sm" /></Link>
        <LangSwitch />
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

interface EBProps {
  children: ReactNode;
  fallback: (reset: () => void, error: Error) => ReactNode;
}
export class ErrorBoundary extends Component<EBProps, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }
  reset = () => this.setState({ error: null });
  render() {
    if (this.state.error) return this.props.fallback(this.reset, this.state.error);
    return this.props.children;
  }
}

export function CrashFallback({ reset }: { reset: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="mx-auto my-20 max-w-md px-5 text-center">
      <h1 className="text-3xl font-bold">{t('errors.crashTitle')}</h1>
      <p className="mt-3 text-ink-soft">{t('errors.crashText')}</p>
      <div className="mt-6 flex justify-center gap-3">
        <button type="button" className="btn-secondary" onClick={reset}>{t('common.retry')}</button>
        <button type="button" className="btn-primary" onClick={() => window.location.assign('/')}>{t('common.home')}</button>
      </div>
    </div>
  );
}
