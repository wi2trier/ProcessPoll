import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function PrivacyPage() {
  const { t } = useTranslation();
  return (
    <article className="mx-auto max-w-2xl px-5 py-10" data-testid="privacy-page">
      <h1 className="text-4xl font-bold tracking-tight">{t('privacy.title')}</h1>
      <p>{t('privacy.operator')}</p>
    </article>
  );
}
export function ImprintPage() {
  const { t } = useTranslation();
  return (
    <article className="mx-auto max-w-2xl space-y-5 px-5 py-10">
      <h1 className="text-4xl font-bold tracking-tight">{t('imprint.title')}</h1>
      <p>{t('imprint.operator')}</p>
    </article>
  );
}

export function ContactPage() {
  const { t } = useTranslation();
  return (
    <article className="mx-auto max-w-2xl space-y-5 px-5 py-10">
      <h1 className="text-4xl font-bold tracking-tight">{t('contact.title')}</h1>
      <p>{t('contact.operator')}</p>
    </article>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md px-5 py-24 text-center" data-testid="not-found">
      <p className="font-display text-8xl font-bold text-brand">404</p>
      <h1 className="mt-2 text-3xl font-bold">{t('notFound.title')}</h1>
      <Link to="/" className="btn-primary mt-8">{t('common.home')}</Link>
    </div>
  );
}
