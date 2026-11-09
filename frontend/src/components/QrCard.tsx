import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from './ui';

export function joinUrl(code: string): string {
  return `${window.location.origin}/j/${code}`;
}

export function JoinInfo({ code, size = 128, layout = 'row', fluid = false, children }: { code: string; size?: number; layout?: 'row' | 'column'; fluid?: boolean; children?: ReactNode }) {
  const { t } = useTranslation();
  const url = joinUrl(code);
  const shown = url.replace(/^https?:\/\//, '');
  const big = size > 200;
  return (
    <div className={`flex ${layout === 'column' ? 'flex-col items-center text-center' : 'items-center'} gap-5`} data-testid="qr-card">
      <div className={`shrink-0 rounded-xl border border-line bg-white ${fluid ? 'w-[clamp(180px,20vw,420px)] p-[clamp(10px,1.2vw,24px)]' : (big ? 'w-[min(220px,62vw)] p-3' : size > 150 ? 'w-[min(180px,50vw)] p-3' : 'w-[104px] p-2 sm:w-[132px] sm:p-2.5')}`} role="img" aria-label={t('qr.alt', { url })}>
        <QRCodeSVG value={url} size={size} level="M" marginSize={0} fgColor="#162D33" style={{ width: '100%', height: 'auto', display: 'block' }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`mt-1 leading-snug text-ink-soft ${big ? 'text-[clamp(1rem,1.6vw,1.75rem)]' : 'text-sm'}`}>{t('qr.goTo')}</p>
        <p className={`font-semibold leading-snug [overflow-wrap:anywhere] ${big ? 'text-[clamp(1.1rem,1.8vw,2rem)]' : 'text-sm'}`} data-testid="join-url">
          {shown.split('/').map((part, i) => (i === 0 ? part : <span key={i}><wbr />/{part}</span>))}
        </p>
        <p className={`whitespace-nowrap font-display font-bold leading-none tracking-wider text-brand ${big ? 'mt-3 text-[clamp(2.5rem,5vw,6rem)]' : 'mt-1 text-3xl'}`} data-testid="session-code">{code}</p>
        {children}
      </div>
    </div>
  );
}

export function CopyJoin({ code }: { code: string }) {
  return <CopyButton text={joinUrl(code)} className="btn-secondary btn-sm" testId="copy-join" />;
}
