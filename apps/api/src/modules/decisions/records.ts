import type { ClientSession, ObjectId } from 'mongodb';
import type { Author } from '@conclavix/core';
import type { Collections } from '../../db.js';
import { AppError } from '../../errors.js';

/** An answer or dismissal for a decision that is no longer the issue's open question. */
export class DecisionClosed extends AppError {
  constructor() {
    super(409, 'conflict', 'the decision is no longer open; reload the list');
  }
}

/** How the board settled an open decision. */
export type BoardOutcome = 'answered' | 'dismissed';

/** Record the board's answer or dismissal on a decision that is still open; false otherwise. */
export async function settleDecision(
  collections: Collections,
  decisionId: ObjectId,
  outcome: BoardOutcome,
  by: Author,
  answer: string | null,
  session: ClientSession,
): Promise<boolean> {
  const result = await collections.decisions.updateOne(
    { _id: decisionId, status: 'open' },
    { $set: { status: outcome, decidedAt: new Date(), decidedBy: by, answer } },
    { session },
  );
  return result.modifiedCount === 1;
}

/** Close a decision whose issue left in_review without a board answer. */
export async function withdrawDecision(
  collections: Collections,
  decisionId: ObjectId,
  session: ClientSession,
): Promise<void> {
  await collections.decisions.updateOne(
    { _id: decisionId, status: 'open' },
    { $set: { status: 'withdrawn', decidedAt: new Date(), decidedBy: null, answer: null } },
    { session },
  );
}
