export function DescriptionLine({ text, className = '', textClassName = '' }: { text: string | null | undefined; className?: string; textClassName?: string }) {
  const value = (text ?? '').trim();
  if (!value) return null;
  return (
    <div className={`min-w-0 ${className}`} data-testid="description">
      <p className={`min-w-0 whitespace-pre-line break-words text-ink-soft ${textClassName}`} data-testid="description-text">
        {value}
      </p>
    </div>
  );
}
