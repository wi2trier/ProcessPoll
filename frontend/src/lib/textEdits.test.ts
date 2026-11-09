import { describe, expect, it } from 'vitest';
import { diffTexts, hasChanges, initialTexts, textIssues } from './textEdits';

const session = {
  description: 'Intro',
  questions: [
    { id: 'a', prompt: 'What is your role?', label: 'Role', help: null },
    { id: 'b', prompt: 'Describe your morning.', label: null, help: 'In order' },
  ],
};

describe('text editing', () => {
  it('starts from the current texts, with missing values as empty strings', () => {
    const e = initialTexts(session);
    expect(e.description).toBe('Intro');
    expect(e.questions.a).toEqual({ prompt: 'What is your role?', label: 'Role', help: '' });
    expect(e.questions.b).toEqual({ prompt: 'Describe your morning.', label: '', help: 'In order' });
    expect(initialTexts({ description: null, questions: [] }).description).toBe('');
  });

  it('sends nothing when nothing changed', () => {
    const p = diffTexts(session, initialTexts(session));
    expect(p).toEqual({ questions: [] });
    expect(hasChanges(p)).toBe(false);
  });

  it('sends only the changed fields, trimmed', () => {
    const e = initialTexts(session);
    e.questions.a.prompt = '  Which role do you have?  ';
    e.questions.b.label = ' Morning ';
    const p = diffTexts(session, e);
    expect(p.description).toBeUndefined();
    expect(p.questions).toEqual([
      { id: 'a', body: { prompt: 'Which role do you have?' } },
      { id: 'b', body: { label: 'Morning' } },
    ]);
    expect(hasChanges(p)).toBe(true);
  });

  it('removes the description, the label and the hint with null', () => {
    const e = initialTexts(session);
    e.description = '   ';
    e.questions.a.label = '';
    e.questions.b.help = '';
    const p = diffTexts(session, e);
    expect(p.description).toBeNull();
    expect(p.questions).toEqual([
      { id: 'a', body: { label: null } },
      { id: 'b', body: { help: null } },
    ]);
  });

  it('treats whitespace-only differences as no change', () => {
    const e = initialTexts(session);
    e.description = ' Intro ';
    expect(diffTexts(session, e).description).toBeUndefined();
  });

  it('never sends an empty question text', () => {
    const e = initialTexts(session);
    e.questions.a.prompt = '   ';
    expect(diffTexts(session, e).questions).toEqual([]);
    const issues = textIssues(e);
    expect(issues.any).toBe(true);
    expect(issues.questions.a).toEqual({ prompt: true });
  });

  it('flags texts that exceed the API limits', () => {
    const e = initialTexts(session);
    e.description = 'x'.repeat(1001);
    e.questions.b.label = 'y'.repeat(81);
    const i = textIssues(e);
    expect(i.description).toBe(true);
    expect(i.questions.b).toEqual({ label: true });
    expect(textIssues(initialTexts(session)).any).toBe(false);
  });
});
