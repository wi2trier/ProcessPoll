import { beforeAll, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import { newQuestion, validateBuilder, type BuilderQuestion } from '../lib/builder';
import { QuestionBuilder } from './QuestionBuilder';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function Harness({ initial }: { initial: BuilderQuestion[] }) {
  const [qs, setQs] = useState(initial);
  return <QuestionBuilder questions={qs} onChange={setQs} issues={[]} />;
}

describe('QuestionBuilder: question, field label and hint', () => {
  it('shows an example placeholder that fits the question type', () => {
    render(<Harness initial={[newQuestion('trace'), newQuestion('single_choice'), newQuestion('number')]} />);
    const inputs = screen.getAllByTestId('builder-prompt');
    expect(inputs[0]).toHaveAttribute('placeholder', expect.stringContaining('morning routine'));
    expect(inputs[1]).toHaveAttribute('placeholder', expect.stringContaining('current role'));
    expect(inputs[2]).toHaveAttribute('placeholder', expect.stringContaining('hours'));
  });

  it('keeps the Optional section closed while it is empty and opens it on demand', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[newQuestion('single_choice', 'What is your current role?')]} />);
    const toggle = screen.getByTestId('builder-optional-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('builder-label')).not.toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('builder-label')).toBeVisible();
  });

  it('opens the Optional section from the start when a label or a hint already exists', () => {
    const withLabel = { ...newQuestion('single_choice', 'What is your current role?'), label: 'Role' };
    const withHint = { ...newQuestion('text', 'Anything else?'), help: 'Short answers are fine.' };
    render(<Harness initial={[withLabel, withHint]} />);
    const toggles = screen.getAllByTestId('builder-optional-toggle');
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('builder-label')[0]).toHaveValue('Role');
  });

  it('the preview line shows what participants see and what the presentation shows, and follows typing', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[newQuestion('single_choice', 'What is your current role?')]} />);
    await user.click(screen.getByTestId('builder-optional-toggle'));
    const preview = screen.getByTestId('builder-preview');

    expect(within(preview).getByTestId('preview-participants')).toHaveTextContent('What is your current role?');
    expect(within(preview).getByTestId('preview-presentation')).toHaveTextContent('What is your current role?');
    await user.type(screen.getByTestId('builder-label'), 'Role');
    expect(within(preview).getByTestId('preview-presentation')).toHaveTextContent('Role');
    expect(within(preview).getByTestId('preview-participants')).toHaveTextContent('What is your current role?');
    expect(preview).toHaveTextContent('Participants see: What is your current role? · Presentation shows: Role');
  });

  it('counts the field label and stops at 80 characters', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ ...newQuestion('text', 'Anything else?'), label: 'x' }]} />);
    expect(screen.getByText('1 / 80')).toBeInTheDocument();
    await user.type(screen.getByTestId('builder-label'), 'y'.repeat(100));
    expect((screen.getByTestId('builder-label') as HTMLInputElement).value).toHaveLength(80);
    expect(screen.getByText('80 / 80')).toBeInTheDocument();
  });

  it('Enter in the question field neither adds a line break nor submits an enclosing form', async () => {
    const user = userEvent.setup();
    let submitted = false;
    render(
      <form onSubmit={(e) => { e.preventDefault(); submitted = true; }}>
        <Harness initial={[newQuestion('text')]} />
      </form>,
    );
    const field = screen.getByTestId('builder-prompt');
    await user.type(field, 'First line{Enter}second line');
    expect(field).toHaveValue('First linesecond line');
    expect(submitted).toBe(false);
  });

  it('every field of a question has an "i" with a text', () => {
    render(<Harness initial={[newQuestion('trace')]} />);

    expect(screen.getAllByTestId('infotip').length).toBeGreaterThanOrEqual(7);
  });
});

describe('validation of the new texts', () => {
  it('a missing question text is reported per question, a too long label as well', () => {
    const q = { ...newQuestion('text', ''), label: 'y'.repeat(81) };
    const issues = validateBuilder('Title', [q]);
    expect(issues).toContainEqual({ code: 'prompt_required', index: 0 });
    expect(issues).toContainEqual({ code: 'label_too_long', index: 0 });
  });
});
