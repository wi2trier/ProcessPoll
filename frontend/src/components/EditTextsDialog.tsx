import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Auth } from '../api/client';
import type { AdminSession } from '../api/types';
import { optionalSectionOpen } from '../lib/builder';
import { MAX_DESCRIPTION, MAX_LABEL } from '../lib/presentation';
import { diffTexts, hasChanges, initialTexts, textIssues, type TextEdits } from '../lib/textEdits';
import { Counter, PreviewLine } from './QuestionBuilder';
import { FieldLabel, InfoTip } from './Tooltip';
import { AutoTextarea, Banner, Disclosure, ErrorBox, Modal } from './ui';

export function EditTextsDialog({ open, onClose, session, code, auth }: { open: boolean; onClose: () => void; session: AdminSession; code: string; auth: Auth }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const questions = useMemo(() => [...session.questions].sort((a, b) => a.position - b.position), [session.questions]);
  const [edits, setEdits] = useState<TextEdits>(() => initialTexts({ description: session.description, questions }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [showIssues, setShowIssues] = useState(false);

  const issues = textIssues(edits);
  const patch = diffTexts({ description: session.description, questions }, edits);
  const changed = hasChanges(patch);

  const setQ = (id: string, p: Partial<TextEdits['questions'][string]>) => setEdits((e) => ({ ...e, questions: { ...e.questions, [id]: { ...e.questions[id], ...p } } }));

  const save = async () => {
    setShowIssues(true);
    if (issues.any) return;
    if (!changed) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      let last: AdminSession | null = null;
      if (patch.description !== undefined) last = await api.patchSession(code, auth, { description: patch.description });
      for (const q of patch.questions) last = await api.patchQuestion(code, auth, q.id, q.body);
      if (last) qc.setQueryData(['session', code, 'admin', auth.key], last);
      void qc.invalidateQueries({ queryKey: ['session', code] });
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={t('host.editTextsTitle')}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy} data-testid="texts-save">{t('common.save')}</button>
        </>
      }
    >
      <div className="space-y-6" data-testid="edit-texts">
        <p className="flex items-start gap-1 text-ink-soft">
          <span>{t('host.editTextsIntro')}</span>
          <InfoTip text={t('tips.host.editTexts')} />
        </p>

        <div>
          <FieldLabel
            htmlFor="texts-description"
            tip={t('tips.builder.description')}
            hint={<Counter value={edits.description.length} max={MAX_DESCRIPTION} />}
          >
            {t('builder.description')}
          </FieldLabel>
          <AutoTextarea
            id="texts-description"
            minRows={3}
            maxRows={8}
            className="input input-sm"
            placeholder={t('builder.descriptionPlaceholder')}
            value={edits.description}
            maxLength={MAX_DESCRIPTION}
            onChange={(e) => setEdits({ ...edits, description: e.target.value })}
            data-testid="texts-description"
          />
          {showIssues && issues.description && <p className="mt-1 font-semibold text-danger" role="alert">{t('builder.issue.description_too_long')}</p>}
        </div>

        <ol className="space-y-5">
          {questions.map((q, i) => {
            const e = edits.questions[q.id];
            const qi = issues.questions[q.id];
            return (
              <li key={q.id} className="rounded-2xl border border-line p-4" data-testid="texts-question">
                <p className="mb-3 flex items-center gap-2 font-bold">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">{i + 1}</span>
                  <span className="sr-only">{t('host.editTextsQuestion', { n: i + 1 })}: </span>
                  {t(`builder.type.${q.type}`)}
                </p>
                <div className="space-y-4">
                  <div>
                    <FieldLabel htmlFor={`texts-prompt-${q.id}`} tip={t('tips.builder.question')}>{t('builder.prompt')}</FieldLabel>
                    <AutoTextarea
                      id={`texts-prompt-${q.id}`}
                      className="input input-sm py-2.5"
                      minRows={1}
                      maxRows={5}
                      value={e.prompt}
                      maxLength={500}
                      onChange={(ev) => setQ(q.id, { prompt: ev.target.value.replace(/\s*[\r\n]+\s*/g, ' ') })}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') ev.preventDefault(); }}
                      aria-invalid={showIssues && !!qi?.prompt}
                      data-testid="texts-prompt"
                    />
                    {showIssues && qi?.prompt && <p className="mt-1 font-semibold text-danger" role="alert">{t('builder.issue.prompt_required')}</p>}
                  </div>
                  <Disclosure label={t('builder.optional')} tip={t('tips.builder.optional')} defaultOpen={optionalSectionOpen(q)} testId="texts-optional">
                    <div>
                      <FieldLabel htmlFor={`texts-label-${q.id}`} tip={t('tips.builder.label')} hint={<Counter value={e.label.length} max={MAX_LABEL} />}>{t('builder.label')}</FieldLabel>
                      <input
                        id={`texts-label-${q.id}`}
                        className="input input-sm"
                        placeholder={t(`builder.labelPlaceholder.${q.type}`)}
                        value={e.label}
                        maxLength={MAX_LABEL}
                        onChange={(ev) => setQ(q.id, { label: ev.target.value })}
                        data-testid="texts-label"
                      />
                    </div>
                    <PreviewLine q={{ prompt: e.prompt, label: e.label }} />
                    <div>
                      <FieldLabel htmlFor={`texts-help-${q.id}`} tip={t('tips.builder.help')}>{t('builder.help')}</FieldLabel>
                      <input
                        id={`texts-help-${q.id}`}
                        className="input input-sm"
                        placeholder={t('builder.helpPlaceholder')}
                        value={e.help}
                        maxLength={1000}
                        onChange={(ev) => setQ(q.id, { help: ev.target.value })}
                        data-testid="texts-help"
                      />
                    </div>
                  </Disclosure>
                </div>
              </li>
            );
          })}
        </ol>

        {err != null && <ErrorBox error={err} />}
        {showIssues && issues.any && <Banner tone="error" live>{t('hostNew.fixIssues', { count: (issues.description ? 1 : 0) + Object.keys(issues.questions).length })}</Banner>}
      </div>
    </Modal>
  );
}
