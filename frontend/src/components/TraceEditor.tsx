import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TraceConfig } from '../api/types';
import {
  addStep,
  checkLabel,
  cleanLabel,
  makeItems,
  moveStep,
  poolChipState,
  removeStep,
  suggestLabels,
  toSteps,
  withTraceDefaults,
  type TraceError,
  type TraceItem,
} from '../lib/traceLogic';
import { Icon } from './Icon';
import { IconTip } from './Tooltip';

interface Props {
  config: TraceConfig;
  value: string[];
  onChange: (steps: string[]) => void;

  fetchSuggestions?: (q: string) => Promise<string[]>;
  inputId?: string;
  describedBy?: string;
  invalid?: boolean;
}

function SortableRow({
  item,
  index,
  total,
  onMove,
  onRemove,
}: {
  item: TraceItem;
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const small = 'flex h-6 w-9 items-center justify-center rounded-md text-ink-soft hover:bg-line hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent';
  return (
    <li
      ref={setNodeRef}
      data-testid="trace-item"
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={`flex min-h-[56px] items-center gap-2 rounded-xl border border-line bg-white py-1.5 pl-3 pr-1 shadow-card ${isDragging ? 'border-brand ring-2 ring-brand' : ''}`}
    >
      <span className="w-5 shrink-0 text-center text-sm font-bold text-ink-soft" aria-hidden="true">{index + 1}</span>
      <span className="min-w-0 flex-1 break-words py-1.5 text-[17px] font-semibold leading-snug">{item.label}</span>
      <div className="flex shrink-0 flex-col">
        <IconTip label={t('trace.moveUp', { label: item.label })} placement="left">
          <button type="button" className={small} onClick={() => onMove(index, index - 1)} disabled={index === 0} aria-label={t('trace.moveUp', { label: item.label })}>
            <Icon name="up" size={16} />
          </button>
        </IconTip>
        <IconTip label={t('trace.moveDown', { label: item.label })} placement="left">
          <button type="button" className={small} onClick={() => onMove(index, index + 1)} disabled={index === total - 1} aria-label={t('trace.moveDown', { label: item.label })}>
            <Icon name="down" size={16} />
          </button>
        </IconTip>
      </div>
      <IconTip label={t('trace.dragHandle', { label: item.label })}>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t('trace.dragHandle', { label: item.label })}
          className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-ink-soft hover:text-ink active:cursor-grabbing"
        >
          <Icon name="drag" size={20} />
        </button>
      </IconTip>
      <IconTip label={t('trace.remove', { label: item.label })}>
        <button type="button" className="btn-icon !h-10 !w-10" onClick={() => onRemove(index)} aria-label={t('trace.remove', { label: item.label })} data-testid="trace-remove">
          <Icon name="x" size={18} />
        </button>
      </IconTip>
    </li>
  );
}

export function TraceEditor({ config: rawConfig, value, onChange, fetchSuggestions, inputId, describedBy, invalid }: Props) {
  const { t } = useTranslation();
  const cfg = useMemo(() => withTraceDefaults(rawConfig), [rawConfig]);
  const [items, setItems] = useState<TraceItem[]>(() => makeItems(value));
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<TraceError | null>(null);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const listId = `${id}-suggestions`;
  const inputRef = useRef<HTMLInputElement>(null);

  const lastEmitted = useRef<string>(JSON.stringify(value));
  useEffect(() => {
    const s = JSON.stringify(value);
    if (s !== lastEmitted.current) {
      lastEmitted.current = s;
      setItems(makeItems(value));
    }
  }, [value]);

  const commit = useCallback(
    (next: TraceItem[], announce?: string) => {
      setItems(next);
      const steps = toSteps(next);
      lastEmitted.current = JSON.stringify(steps);
      onChange(steps);
      if (announce) setMessage(announce);
    },
    [onChange],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const pending = text.trim() ? checkLabel(items, text, cfg) : undefined;
  const hint: TraceError | undefined = error ?? (pending === 'duplicate' || pending === 'max_steps' ? pending : undefined);

  const [remote, setRemote] = useState<string[]>([]);
  const canSuggest = cfg.mode === 'free' && cfg.suggest_existing && !!fetchSuggestions;
  const fetchRef = useRef(fetchSuggestions);
  fetchRef.current = fetchSuggestions;
  useEffect(() => {
    const q = text.trim();
    if (!canSuggest || !q) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchRef.current?.(q).then(
        (l) => { if (!cancelled) setRemote(Array.isArray(l) ? l : []); },
        () => { if (!cancelled) setRemote([]); },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, canSuggest]);
  const matches = useMemo(() => (canSuggest ? suggestLabels(remote, text) : []), [canSuggest, remote, text]);
  const showList = focused && matches.length > 0;

  const tryAdd = (raw: string) => {
    const res = addStep(items, raw, cfg);
    if (res.error) {
      setError(res.error);
      return false;
    }
    setError(null);
    commit(res.items, t('trace.added', { label: cleanLabel(raw), n: res.items.length }));
    setText('');
    setActive(-1);
    return true;
  };

  const submitAdd = () => {
    const raw = active >= 0 && showList ? matches[active] : text;
    if (tryAdd(raw)) inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.nativeEvent.isComposing) submitAdd();
      return;
    }
    if (!showList) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a <= 0 ? matches.length - 1 : a - 1));
    } else if (e.key === 'Escape') {
      setActive(-1);
      setFocused(false);
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active: a, over } = e;
    if (!over || a.id === over.id) return;
    const from = items.findIndex((i) => i.id === a.id);
    const to = items.findIndex((i) => i.id === over.id);
    if (from < 0 || to < 0) return;
    commit(arrayMove(items, from, to), t('trace.moved', { label: items[from].label, n: to + 1 }));
  };

  const onMove = (from: number, to: number) => {
    commit(moveStep(items, from, to), t('trace.moved', { label: items[from]?.label ?? '', n: to + 1 }));
  };
  const onRemove = (index: number) => {
    commit(removeStep(items, index), t('trace.removedMsg', { label: items[index]?.label ?? '' }));
    inputRef.current?.focus();
  };

  const mode = cfg.mode;
  const atMax = items.length >= cfg.max_steps;
  const hasInput = mode === 'free' || cfg.allow_custom;

  const restrictions: string[] = [];
  if (!cfg.allow_repeats) restrictions.push(t('trace.eachOnce'));
  if (cfg.min_steps > 1 && items.length < cfg.min_steps) restrictions.push(t('trace.atLeast', { min: cfg.min_steps }));
  if (atMax) restrictions.push(t('trace.error.max_steps', { max: cfg.max_steps }));
  const hintText = hint ? t(`trace.error.${hint}`, { max: cfg.max_steps, len: cfg.max_label_length }) : restrictions.join(' · ');

  return (
    <div className="space-y-4" data-testid="trace-editor" data-mode={mode}>
      {mode === 'select_sort' && cfg.activities.length > 0 && (
        <div role="group" aria-label={t('trace.poolTitle')} className="flex flex-wrap gap-2">
          {cfg.activities.map((a) => {
            const st = poolChipState(a, items, cfg);
            return (
              <button
                key={a}
                type="button"
                data-testid="pool-chip"
                disabled={st.disabled}
                onClick={() => tryAdd(a)}
                aria-label={st.used > 0 ? t('trace.poolChipUsed', { label: a, count: st.used }) : t('trace.poolChip', { label: a })}
                className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-edge bg-white px-4 text-[17px] font-semibold transition-colors hover:border-brand disabled:border-line disabled:bg-surface disabled:text-slate"
              >
                {a}
                {st.used > 0 && <span className="text-sm text-ink-soft">×{st.used}</span>}
              </button>
            );
          })}
        </div>
      )}

      {items.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ol className="space-y-2" aria-label={t('trace.listLabel')}>
              {items.map((it, i) => (
                <SortableRow key={it.id} item={it} index={i} total={items.length} onMove={onMove} onRemove={onRemove} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {items.length === 0 && mode === 'select_sort' && (
        <p className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-ink-soft" data-testid="trace-empty">{t('trace.emptySelect')}</p>
      )}

      {hasInput && (
        <div className="relative">
          <label htmlFor={id} className="sr-only">
            {mode === 'select_sort' ? t('trace.customLabel') : t('trace.addLabel')}
          </label>
          <input
            ref={inputRef}
            id={id}
            data-testid="trace-input"
            type="text"
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="done"
            maxLength={cfg.max_label_length}
            value={text}
            disabled={atMax}
            placeholder={mode === 'select_sort' ? t('trace.customPlaceholder') : t('trace.addPlaceholder')}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              setActive(-1);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 && showList ? `${listId}-${active}` : undefined}
            aria-describedby={`${id}-hint${describedBy ? ` ${describedBy}` : ''}`}
            aria-invalid={hint || invalid ? true : undefined}
            className={`input pr-16 ${invalid && !hint ? '!border-danger' : ''}`}
          />
          <button
            type="button"
            onClick={submitAdd}
            data-testid="trace-add"
            className="absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-30"
            disabled={!text.trim() || atMax || pending === 'duplicate'}
            aria-label={t('trace.add')}
          >
            <Icon name="plus" size={22} />
          </button>
          {showList && (
            <ul id={listId} role="listbox" aria-label={t('trace.suggestions')} className="absolute left-0 right-0 z-20 mt-1.5 max-h-60 overflow-auto rounded-xl border border-brand bg-white p-1.5">
              {matches.map((m, i) => (
                <li
                  key={m}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (tryAdd(m)) inputRef.current?.focus();
                  }}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-[17px] font-medium ${i === active ? 'bg-line' : 'hover:bg-surface'}`}
                >
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p id={`${id}-hint`} data-testid="trace-hint" className={`min-h-[1.5rem] text-sm ${hint ? 'font-semibold text-orange-dark' : 'text-ink-soft'}`} aria-live="polite">
        {hintText}
      </p>
      {mode === 'free' && <p className="text-sm text-ink-soft">{t('question.textPrivacy')}</p>}
      <p className="sr-only" role="status" aria-live="polite">{message}</p>
    </div>
  );
}
