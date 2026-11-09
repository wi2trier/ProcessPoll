import { activityTone } from '../lib/colors';
import { unmaskLabel } from '../lib/labels';

export function ActivityChip({ label, size = 'md', quiet = false, className = '' }: { label: string; size?: 'sm' | 'md'; quiet?: boolean; className?: string }) {
  const tone = activityTone(label);
  const sizing = size === 'sm' ? 'px-2 py-1 text-[15px]' : 'px-3 py-1.5 text-base';
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-xl font-medium text-ink ${sizing} ${quiet ? 'bg-line' : ''} ${className}`}
      style={quiet ? undefined : { backgroundColor: tone.bg }}
      title={unmaskLabel(label)}
      data-testid="variant-pill"
    >
      <span className="min-w-0 break-words">{unmaskLabel(label)}</span>
    </span>
  );
}

export function VariantChips({ steps, max, size = 'md', quiet = false }: { steps: string[]; max?: number; size?: 'sm' | 'md'; quiet?: boolean }) {
  const shown = max && steps.length > max ? steps.slice(0, max) : steps;
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label={steps.map(unmaskLabel).join(' → ')}>
      {shown.map((s, i) => (
        <li key={`${i}-${s}`} className="flex min-w-0 max-w-full items-center gap-1">
          {i > 0 && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#AAB6C0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          )}
          <ActivityChip label={s} size={size} quiet={quiet} />
        </li>
      ))}
      {max && steps.length > max && <li className="text-ink-soft">+{steps.length - max}</li>}
    </ol>
  );
}
