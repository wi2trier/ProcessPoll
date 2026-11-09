import type { PatchQuestionIn, Question } from '../api/types';
import { emptyToNull, MAX_DESCRIPTION, MAX_LABEL } from './presentation';

export interface QuestionTexts {
  prompt: string;
  label: string;
  help: string;
}
export interface TextEdits {
  description: string;
  questions: Record<string, QuestionTexts>;
}

interface SessionTexts {
  description?: string | null;
  questions: Pick<Question, 'id' | 'prompt' | 'label' | 'help'>[];
}

export function initialTexts(session: SessionTexts): TextEdits {
  return {
    description: session.description ?? '',
    questions: Object.fromEntries(session.questions.map((q) => [q.id, { prompt: q.prompt, label: q.label ?? '', help: q.help ?? '' }])),
  };
}

export interface TextPatch {

  description?: string | null;
  questions: { id: string; body: PatchQuestionIn }[];
}

export function diffTexts(session: SessionTexts, edits: TextEdits): TextPatch {
  const out: TextPatch = { questions: [] };
  const desc = emptyToNull(edits.description);
  if (desc !== emptyToNull(session.description)) out.description = desc;
  for (const q of session.questions) {
    const e = edits.questions[q.id];
    if (!e) continue;
    const body: PatchQuestionIn = {};
    const prompt = e.prompt.trim();
    if (prompt && prompt !== q.prompt) body.prompt = prompt;
    const label = emptyToNull(e.label);
    if (label !== emptyToNull(q.label)) body.label = label;
    const help = emptyToNull(e.help);
    if (help !== emptyToNull(q.help)) body.help = help;
    if (Object.keys(body).length > 0) out.questions.push({ id: q.id, body });
  }
  return out;
}

export function hasChanges(p: TextPatch): boolean {
  return p.description !== undefined || p.questions.length > 0;
}

export interface TextIssues {
  description: boolean;

  questions: Record<string, { prompt?: boolean; label?: boolean }>;
  any: boolean;
}

export function textIssues(edits: TextEdits): TextIssues {
  const questions: TextIssues['questions'] = {};
  let any = false;
  const description = edits.description.trim().length > MAX_DESCRIPTION;
  if (description) any = true;
  for (const [id, e] of Object.entries(edits.questions)) {
    const issue: { prompt?: boolean; label?: boolean } = {};
    if (!e.prompt.trim()) issue.prompt = true;
    if (e.label.trim().length > MAX_LABEL) issue.label = true;
    if (issue.prompt || issue.label) {
      questions[id] = issue;
      any = true;
    }
  }
  return { description, questions, any };
}
