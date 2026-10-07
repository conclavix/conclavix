import { z } from 'zod';
import type { Author } from './collaboration.js';

export const MAX_DECISION_OPTIONS = 6;

const optionSchema = z.string().trim().min(1).max(200);

/** What an agent asks the board with request_board_decision. */
export const requestBoardDecisionSchema = z.strictObject({
  question: z.string().trim().min(1).max(4000),
  options: z
    .array(optionSchema)
    .max(MAX_DECISION_OPTIONS)
    .refine((items) => new Set(items).size === items.length, 'options must be distinct')
    .default([]),
});

export const decisionStatusSchema = z.enum([
  'open',
  'answered',
  'dismissed',
  'withdrawn',
  'superseded',
]);

/** A board answer: one of the offered options, a free-text answer, or both. */
export const answerDecisionSchema = z
  .strictObject({
    option: optionSchema.optional(),
    body: z.string().trim().min(1).max(20000).optional(),
  })
  .refine((value) => value.option !== undefined || value.body !== undefined, {
    message: 'choose an option or write an answer',
  });

export const dismissDecisionSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000).optional(),
});

export const listDecisionsQuerySchema = z.strictObject({
  status: z.enum(['open', 'decided']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type RequestBoardDecisionInput = z.infer<typeof requestBoardDecisionSchema>;
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;
export type AnswerDecisionInput = z.infer<typeof answerDecisionSchema>;
export type DismissDecisionInput = z.infer<typeof dismissDecisionSchema>;
export type ListDecisionsQuery = z.infer<typeof listDecisionsQuerySchema>;

/** The open board question on an issue, as exposed on the issue itself. */
export interface AwaitingBoard {
  decisionId: string;
  since: Date;
  question: string;
  options: string[];
  askedBy: string;
}

export interface Decision {
  id: string;
  status: DecisionStatus;
  question: string;
  options: string[];
  askedAt: Date;
  askedBy: { agentId: string; name: string | null };
  issue: { id: string; key: string; title: string; status: string };
  project: { id: string; key: string; name: string } | null;
  decidedAt: Date | null;
  decidedBy: Author | null;
  answer: string | null;
}
