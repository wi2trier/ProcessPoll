import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import type { SessionStatus } from '../api/types';
import { Icon } from './Icon';
import { IconTip, InfoTip, Tooltip, type TriggerProps } from './Tooltip';

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 9 L16 24 M23 9 L16 24" stroke="#ED8B12" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <rect x="3" y="3" width="12" height="12" rx="3.5" fill="#087C73" />
      <rect x="17" y="3" width="12" height="12" rx="3.5" fill="#087C73" />
      <rect x="10" y="18" width="12" height="12" rx="3.5" fill="#ED8B12" />
    </svg>
  );
}

export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const h = size === 'lg' ? 38 : size === 'sm' ? 22 : 28;
  return (
    <span className={`inline-flex items-center gap-2 font-display font-bold tracking-tight text-ink ${size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-xl'}`}>
      <LogoMark size={h} />
      ProcessPoll
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-3 p-10 text-ink-soft" role="status" aria-live="polite">
      <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-line border-t-brand" aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-line ${className}`} aria-hidden="true" />;
}

export function errorText(t: (k: string) => string, e: unknown): string {
  if (e instanceof ApiError) return t(e.i18nKey);
  return t('errors.unknown');
}

export function ErrorBox({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="rounded-2xl border border-[#F0C9C5] bg-[#FDF1F0] p-4 text-[#7A1A14]">
      <div className="flex items-start gap-3">
        <Icon name="warning" className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          {title && <p className="font-display font-bold">{title}</p>}
          <p>{errorText(t, error)}</p>
          {error instanceof ApiError && error.errors.some((x) => x.field) && (
            <ul className="mt-1 list-disc pl-5 text-sm">
              {error.errors.map((x, i) => <li key={i}>{x.field ? `${x.field}: ` : ''}{x.message}</li>)}
            </ul>
          )}
          {onRetry && (
            <button type="button" className="btn-secondary btn-sm mt-3" onClick={onRetry}>
              {t('common.retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type Tone = 'info' | 'warn' | 'error' | 'success';
const TONES: Record<Tone, string> = {
  info: 'border-brand-tint bg-brand-soft text-ink',
  warn: 'border-[#F6DDB0] bg-orange-light text-[#5C3600]',
  error: 'border-[#F0C9C5] bg-[#FDF1F0] text-[#7A1A14]',
  success: 'border-brand-tint bg-brand-tint text-ink',
};
export function Banner({ tone = 'info', children, live = false }: { tone?: Tone; children: ReactNode; live?: boolean }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${TONES[tone]}`} role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}>
      {children}
    </div>
  );
}

const STATUS_DOT: Record<SessionStatus, string> = {
  open: 'bg-brand',
  paused: 'bg-orange',
  closed: 'bg-slate',
  draft: 'bg-[#4386BD]',
};

export function StatusBadge({ status, large = false }: { status: SessionStatus; large?: boolean }) {
  const { t } = useTranslation();
  return (
    <span data-testid="status-badge" className={`inline-flex items-center gap-2 font-semibold text-ink ${large ? 'text-[clamp(1rem,1.4vw,1.5rem)]' : 'text-sm'}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
      {t(`status.${status}`)}
    </span>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
      <div className="h-full bg-orange transition-[width] duration-300 ease-out" style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }} />
    </div>
  );
}
export function useCopy(): { copied: string | null; copy: (text: string, id?: string) => Promise<void> } {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (text: string, id = 'default') => {
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1800);
    }
  }, []);
  return { copied, copy };
}

export function CopyButton({ text, label, className = 'btn-secondary btn-sm', testId }: { text: string; label?: string; className?: string; testId?: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <button type="button" className={className} onClick={() => void copy(text)} data-testid={testId}>
      <Icon name={copied ? 'check' : 'copy'} size={16} />
      <span aria-live="polite">{copied ? t('common.copied') : (label ?? t('common.copy'))}</span>
    </button>
  );
}

function useDialogBehaviour(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && ref.current) {

        const f = ref.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])');
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [open]);
  return ref;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useDialogBehaviour(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex animate-[scrim_.18s_ease-out] items-end justify-center bg-ink/40 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[92vh] w-full animate-[pop_.2s_ease-out] flex-col rounded-t-3xl bg-white shadow-[0_16px_48px_rgba(22,45,51,0.16)] sm:rounded-3xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-md'}`}
      >
        <div className="flex items-center justify-between gap-4 px-6 pb-2 pt-5">
          <h2 id={titleId} className="font-display text-2xl font-bold tracking-tight">{title}</h2>
          <IconTip label={t('common.close')} placement="bottom">
            <button type="button" className="btn-icon -mr-2" onClick={onClose} aria-label={t('common.close')}>
              <Icon name="x" />
            </button>
          </IconTip>
        </div>
        <div className="overflow-y-auto px-6 py-3">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-3 px-6 pb-6 pt-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useDialogBehaviour(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex animate-[scrim_.18s_ease-out] justify-end bg-ink/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="flex h-full w-full max-w-[640px] animate-[slidein_.22s_ease-out] flex-col bg-white shadow-[-16px_0_48px_rgba(22,45,51,0.12)]">
        <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <h2 id={titleId} className="font-display text-2xl font-bold tracking-tight">{title}</h2>
          <IconTip label={t('common.close')} placement="bottom">
            <button type="button" className="btn-icon -mr-2" onClick={onClose} aria-label={t('common.close')}>
              <Icon name="x" />
            </button>
          </IconTip>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-3 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy} data-testid="confirm-ok">
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-ink-soft">{message}</p>
    </Modal>
  );
}

export function Toggle({ checked, onChange, label, help, tip }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string; tip?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="relative mt-0.5 inline-flex h-7 w-12 shrink-0">
        <input id={id} type="checkbox" role="switch" className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="absolute inset-0 rounded-lg bg-edge transition-colors peer-checked:bg-brand peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand" aria-hidden="true" />
        <span className="absolute left-1 top-1 h-5 w-5 rounded-md bg-white transition-transform peer-checked:translate-x-5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 items-start gap-0.5">
        <label htmlFor={id} className="min-w-0 cursor-pointer">
          <span className="font-semibold">{label}</span>
          {help && <span className="block text-sm text-ink-soft">{help}</span>}
        </label>
        {tip && <InfoTip text={tip} className="mt-0.5" />}
      </div>
    </div>
  );
}

export function AutoTextarea({ minRows = 2, maxRows = 10, value, className = '', ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'rows'> & { value: string; minRows?: number; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = window.getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 24;
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const max = lh * maxRows + pad + border;
    const want = el.scrollHeight + border;
    if (want > 0) el.style.height = `${Math.min(want, max)}px`;
    el.style.overflowY = want > max ? 'auto' : 'hidden';
  }, [maxRows]);
  useLayoutEffect(fit, [fit, value]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);
  return <textarea ref={ref} rows={minRows} value={value} className={`resize-none ${className}`} {...rest} />;
}

export function Disclosure({
  label,
  tip,
  defaultOpen = false,
  children,
  testId,
}: {
  label: string;
  tip?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div data-testid={testId} data-open={open}>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="-ml-1 inline-flex min-h-[40px] items-center gap-1 rounded-lg px-1 font-semibold text-ink-soft hover:text-ink"
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <Icon name="down" size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} /> {label}
        </button>
        {tip && <InfoTip text={tip} />}
      </div>
      <div id={id} hidden={!open} className="mt-2 space-y-4">
        {children}
      </div>
    </div>
  );
}

export function Menu({ label, children, align = 'right', testId }: { label: string; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; testId?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    const first = root.current?.querySelector<HTMLElement>('[role=menuitem]');
    first?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...(root.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[next].focus();
    }
  };

  return (
    <div className="relative" ref={root} onKeyDown={onKey}>
      <IconTip label={label} placement="bottom">
        <button ref={trigger} type="button" className="btn-icon border border-edge bg-white" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)} data-testid={testId}>
          <Icon name="more" />
        </button>
      </IconTip>
      {open && (
        <div role="menu" aria-label={label} className={`absolute z-40 mt-2 min-w-[220px] rounded-2xl border border-line bg-white p-1.5 shadow-[0_8px_24px_rgba(22,45,51,0.08)] ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

const itemCls = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left font-medium hover:bg-surface focus-visible:bg-surface';

function withMenuTip(tip: string | undefined, node: ReactElement<TriggerProps>) {
  return tip ? <Tooltip content={tip} placement="left" descriptionIn="body">{node}</Tooltip> : node;
}
export function MenuButton({ children, onClick, danger = false, testId, tip }: { children: ReactNode; onClick: () => void; danger?: boolean; testId?: string; tip?: string }) {
  return withMenuTip(
    tip,
    <button type="button" role="menuitem" className={`${itemCls} ${danger ? 'text-danger' : ''}`} onClick={onClick} data-testid={testId}>
      {children}
    </button>,
  );
}
export function MenuLink({ children, href, testId, newTab = false, tip }: { children: ReactNode; href: string; testId?: string; newTab?: boolean; tip?: string }) {
  return withMenuTip(
    tip,
    <a role="menuitem" className={itemCls} href={href} data-testid={testId} {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : { download: true })}>
      {children}
    </a>,
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  large = false,
}: {
  tabs: { id: T; label: string; testId?: string; tip?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  large?: boolean;
}) {
  const onKey = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex((x) => x.id === value);
    if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length].id);
    else if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length].id);
    else return;
    e.preventDefault();
  };

  const activeTip = tabs.find((x) => x.id === value)?.tip;
  return (
    <div className="flex items-center gap-2 shadow-[inset_0_-1px_0_0_#EEF1F4]">
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="flex min-w-0 max-w-full gap-3 overflow-x-auto overflow-y-hidden [scrollbar-width:none] sm:gap-7 [&::-webkit-scrollbar]:hidden">
        {tabs.map((tb) => {
          const active = tb.id === value;
          return (
            <button
              key={tb.id}
              role="tab"
              type="button"
              id={`tab-${tb.id}`}
              aria-selected={active}
              aria-controls="tabpanel"
              tabIndex={active ? 0 : -1}
              data-testid={tb.testId}
              onClick={() => onChange(tb.id)}
              className={`min-h-[48px] whitespace-nowrap border-b-2 px-0.5 font-semibold transition-colors focus-visible:outline-offset-[-3px] ${large ? 'text-[clamp(1.1rem,1.5vw,1.9rem)]' : 'text-[15px] sm:text-[17px]'} ${
                active ? 'border-orange text-ink' : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {tb.label}
            </button>
          );
        })}
      </div>
      {activeTip && !large && <InfoTip text={activeTip} placement="bottom" className="ml-auto" />}
    </div>
  );
}
