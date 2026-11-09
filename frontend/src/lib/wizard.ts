import type { Question } from '../api/types';
import { isAnswered, validateAnswer, type FieldError, type RawAnswers } from './answers';

export interface WizardStep {
  question: Question;

  optional: boolean;
}

export function deriveSteps(questions: Question[]): WizardStep[] {
  return [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question) => ({ question, optional: !question.required }));
}

export function validateStep(step: WizardStep, answers: RawAnswers): FieldError | undefined {
  return validateAnswer(step.question, answers[step.question.id]).error;
}

export function canSkip(step: WizardStep, answers: RawAnswers): boolean {
  return step.optional && !isAnswered(answers[step.question.id]);
}

export function primaryAction(index: number, total: number): 'next' | 'submit' {
  return index >= total - 1 ? 'submit' : 'next';
}

export function progress(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (index + 1) / total));
}

export function firstInvalidStep(steps: WizardStep[], answers: RawAnswers): number {
  return steps.findIndex((s) => validateStep(s, answers) !== undefined);
}
