import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/ui';
import { listStoredSessions, removeStoredSession } from '../lib/storage';

export default function HostListPage() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState(() => listStoredSessions());
  const [forget, setForget] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-4xl font-bold tracking-tight">{t('hostList.title')}</h1>
        <Link to="/host/new" className="btn-primary"><Icon name="plus" size={18} /> {t('join.createPoll')}</Link>
      </div>
      {sessions.length === 0 ? (
        <p className="card px-6 py-14 text-center text-lg text-ink-soft" data-testid="host-list-empty">{t('hostList.empty')}</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="host-list">
          {sessions.map((s) => (
            <li key={s.code} className="flex flex-wrap items-center gap-3 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xl font-bold">{s.title}</p>
                <p className="text-ink-soft">
                  <span className="font-mono font-semibold text-ink">{s.code}</span>
                  {s.created_at && <> · {new Date(s.created_at).toLocaleDateString()}</>}
                </p>
              </div>
              <Link to={`/host/${s.code}?key=${encodeURIComponent(s.admin_key)}`} className="btn-primary btn-sm">{t('hostList.open')}</Link>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setForget(s.code)}>{t('hostList.forget')}</button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={forget !== null}
        title={t('hostList.forgetTitle')}
        message={t('hostList.forgetText')}
        confirmLabel={t('hostList.forget')}
        danger
        onCancel={() => setForget(null)}
        onConfirm={() => {
          if (forget) removeStoredSession(forget);
          setSessions(listStoredSessions());
          setForget(null);
        }}
      />
    </div>
  );
}
