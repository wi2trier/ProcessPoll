import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { computePosition, type Placement, type Position } from '../lib/tooltipPosition';
import { Icon } from './Icon';

export interface TriggerProps {
  'aria-describedby'?: string;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
  onClick?: MouseEventHandler<HTMLElement>;
}

const openTooltip: { close: (() => void) | null } = { close: null };

function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

function portalTarget(): HTMLElement {
  return (document.fullscreenElement as HTMLElement | null) ?? document.body;
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  describe = true,
  delay = 120,
  toggleOnClick = false,
  wide = false,
  descriptionIn = 'inline',
}: {
  content: string;
  children: ReactElement<TriggerProps>;
  placement?: Placement;
  describe?: boolean;
  delay?: number;

  toggleOnClick?: boolean;

  wide?: boolean;

  descriptionIn?: 'inline' | 'body';
}) {
  const id = useId();
  const tipId = `${id}-tip`;
  const descId = `${id}-desc`;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const tipEl = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerType = useRef<string>('mouse');
  const pressed = useRef(false);
  const pinned = useRef(false);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  const hide = useCallback(() => {
    clearTimers();
    pinned.current = false;
    if (openTooltip.close === hide) openTooltip.close = null;
    setOpen(false);
    setPos(null);
  }, []);
  const show = useCallback((el: HTMLElement | null) => {
    if (el) trigger.current = el;

    if (openTooltip.close && openTooltip.close !== hide) openTooltip.close();
    openTooltip.close = hide;
    setTarget(portalTarget());
    setOpen(true);
  }, [hide]);
  useEffect(() => () => {
    clearTimers();
    if (openTooltip.close === hide) openTooltip.close = null;
  }, [hide]);

  const place = useCallback(() => {
    const t = trigger.current;
    const tip = tipEl.current;
    if (!t || !tip) return;
    const r = t.getBoundingClientRect();
    const next = computePosition({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, { width: tip.offsetWidth, height: tip.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, placement);
    setPos((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.placement === next.placement ? cur : next));
  }, [placement]);
  useLayoutEffect(() => {
    if (open) place();
  }, [open, content, place]);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const again = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {

        e.stopPropagation();
        hide();
      }
    };
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (trigger.current?.contains(n) || tipEl.current?.contains(n)) return;
      hide();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again, true);
    };
  }, [open, place, hide]);

  const p = children.props;
  const trig = cloneElement(children, {
    'aria-describedby': describe ? [p['aria-describedby'], descId].filter(Boolean).join(' ') : p['aria-describedby'],
    onPointerEnter: (e) => {
      p.onPointerEnter?.(e);
      if (e.pointerType !== 'mouse') return;
      pointerType.current = 'mouse';
      const el = e.currentTarget;
      clearTimers();
      openTimer.current = setTimeout(() => show(el), delay);
    },
    onPointerLeave: (e) => {
      p.onPointerLeave?.(e);
      if (e.pointerType !== 'mouse') return;
      clearTimers();
      if (!pinned.current) closeTimer.current = setTimeout(hide, 120);
    },
    onPointerDown: (e) => {
      p.onPointerDown?.(e);
      pointerType.current = e.pointerType;
      if (!toggleOnClick && open) hide();
      pressed.current = true;
      setTimeout(() => {
        pressed.current = false;
      }, 400);
    },
    onFocus: (e) => {
      p.onFocus?.(e);

      if (!pressed.current && focusVisible(e.currentTarget)) show(e.currentTarget);
    },
    onBlur: (e) => {
      p.onBlur?.(e);
      hide();
    },
    onClick: (e) => {
      p.onClick?.(e);
      if (toggleOnClick) {
        if (open && pointerType.current !== 'mouse') hide();
        else {
          pinned.current = pointerType.current === 'mouse';
          show(e.currentTarget);
        }
      } else {
        hide();
      }
    },
  });

  return (
    <>
      {trig}
      {describe && (descriptionIn === 'body' ? createPortal(<span id={descId} className="sr-only">{content}</span>, document.body) : <span id={descId} className="sr-only">{content}</span>)}
      {open &&
        createPortal(
          <div
            ref={tipEl}
            id={tipId}
            role={describe ? 'tooltip' : undefined}
            aria-hidden={describe ? undefined : true}
            data-placement={pos?.placement}
            onPointerEnter={() => {
              if (closeTimer.current) clearTimeout(closeTimer.current);
            }}
            onPointerLeave={() => {
              if (!pinned.current) closeTimer.current = setTimeout(hide, 120);
            }}
            style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0 }}
            className={`pointer-events-auto z-[90] w-max rounded-lg bg-ink px-3 py-2 text-left text-sm font-medium leading-snug text-white shadow-[0_6px_20px_rgba(22,45,51,0.25)] transition-opacity duration-150 ${wide ? 'max-h-[60vh] max-w-[min(30rem,calc(100vw-1rem))] overflow-y-auto whitespace-pre-line break-words' : 'max-w-[min(18rem,calc(100vw-1rem))]'} ${pos ? 'opacity-100' : 'opacity-0'}`}
          >
            {content}
          </div>,
          target ?? document.body,
        )}
    </>
  );
}

export function InfoTip({
  text,
  placement = 'top',
  className = '',
  label,
  wide = false,
  describe = true,
}: {
  text: string;
  placement?: Placement;
  className?: string;

  label?: string;
  wide?: boolean;

  describe?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip content={text} placement={placement} toggleOnClick wide={wide} describe={describe}>
      <button
        type="button"
        aria-label={label ?? t('tips.more')}
        data-testid="infotip"
        className={`relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate hover:text-ink before:absolute before:-inset-2.5 before:content-[''] ${className}`}
      >
        <Icon name="info" size={16} />
      </button>
    </Tooltip>
  );
}

export function FieldLabel({ htmlFor, id, children, tip, hint, className = '' }: { htmlFor?: string; id?: string; children: ReactNode; tip?: string; hint?: ReactNode; className?: string }) {
  return (
    <div className={`mb-1 flex min-h-[24px] items-center gap-0.5 ${className}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} id={id} className="text-sm font-semibold text-ink">{children}</label>
      ) : (
        <span id={id} className="text-sm font-semibold text-ink">{children}</span>
      )}
      {tip && <InfoTip text={tip} />}
      {hint}
    </div>
  );
}

export function IconTip({ label, placement = 'top', children }: { label: string; placement?: Placement; children: ReactElement<TriggerProps> }) {
  return (
    <Tooltip content={label} placement={placement} describe={false}>
      {children}
    </Tooltip>
  );
}
