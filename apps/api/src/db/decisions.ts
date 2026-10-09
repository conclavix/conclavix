import type { Collection, ObjectId } from 'mongodb';
import type { Author, DecisionStatus } from '@conclavix/core';

/**
 * The open board decision an issue's assignee waits for. Set only together with status in_review
 * and cleared when the issue leaves it, so an in_review issue without it waits for something else
 * (sub-issues, a review).
 */
export interface AwaitingBoardDoc {
  decisionId: ObjectId;
  since: Date;
  question: string;
  options: string[];
  askedBy: ObjectId;
}

/** A question an agent put to the board, and how it was settled. */
export interface DecisionDoc {
  _id: ObjectId;
  issueId: ObjectId;
  projectId: ObjectId;
  question: string;
  options: string[];
  askedBy: ObjectId;
  runId: ObjectId | null;
  askedAt: Date;
  status: DecisionStatus;
  decidedAt: Date | null;
  decidedBy: Author | null;
  answer: string | null;
}

/** Board decision fields of an issue; IssueDoc extends this. */
export interface IssueDecisionFields {
  /** The open board question (request_board_decision); see AwaitingBoardDoc. */
  awaitingBoard?: AwaitingBoardDoc | null;
}

/** The decisions collection; Collections extends this. */
export interface DecisionCollections {
  decisions: Collection<DecisionDoc>;
}

/** Open questions oldest first, recently decided ones, and the open question of an issue. */
export async function ensureDecisionIndexes(collections: DecisionCollections): Promise<void> {
  await collections.decisions.createIndex({ status: 1, askedAt: 1 });
  await collections.decisions.createIndex({ status: 1, decidedAt: -1 });
  await collections.decisions.createIndex({ issueId: 1, status: 1 });
}
