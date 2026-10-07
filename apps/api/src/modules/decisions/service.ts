import { ObjectId } from 'mongodb';
import type {
  AnswerDecisionInput,
  Author,
  Decision,
  DismissDecisionInput,
  Issue,
  ListDecisionsQuery,
  RequestBoardDecisionInput,
} from '@conclavix/core';
import type { AgentDoc, Database, IssueDoc } from '../../db.js';
import type { AwaitingBoardDoc, DecisionDoc } from '../../db/decisions.js';
import { conflict, notFound, unprocessable } from '../../errors.js';
import { CommentRepository } from '../comments/repository.js';
import { isClosed } from '../issues/graph.js';
import { IssueRepository } from '../issues/repository.js';

/** Statuses listed as recently decided; superseded questions were replaced by a newer one. */
const DECIDED = ['answered', 'dismissed', 'withdrawn'] as const;

/** Who asks: the run's agent on the run's own issue. */
export interface DecisionAsker {
  agent: Pick<AgentDoc, '_id'>;
  issue: Pick<IssueDoc, '_id' | 'key'>;
  runId: ObjectId | null;
}

/** The comment that puts the question on the issue thread. */
export function questionComment(question: string, options: string[]): string {
  const lines = ['**Board decision requested**', '', question];
  if (options.length > 0) {
    lines.push('', 'Options:', ...options.map((option, index) => `${index + 1}. ${option}`));
  }
  return lines.join('\n');
}

/** The comment a board answer posts: the chosen option first, then the free text. */
export function answerComment(input: AnswerDecisionInput): string {
  const parts = [
    ...(input.option === undefined ? [] : [`**Decision:** ${input.option}`]),
    ...(input.body === undefined ? [] : [input.body]),
  ];
  return parts.join('\n\n');
}

/** The comment a dismissal posts, so the woken agent knows it has to go on without an answer. */
export function dismissComment(input: DismissDecisionInput): string {
  const text =
    '**Decision request dismissed:** the board will not decide this. Continue with your own ' +
    'judgement or take another route.';
  return input.reason === undefined ? text : `${text}\n\n${input.reason}`;
}

/** Board decisions agents ask for: asking, listing, answering and dismissing. */
export class DecisionService {
  private readonly issues: IssueRepository;
  private readonly comments: CommentRepository;

  constructor(private readonly database: Database) {
    this.issues = new IssueRepository(database);
    this.comments = new CommentRepository(database);
  }

  private get collections() {
    return this.database.collections;
  }

  /**
   * Put a question to the board: in one transaction the issue moves to in_review with
   * awaitingBoard set, the question is recorded and posted as the agent's comment. A question
   * still open on the issue is superseded by the new one.
   */
  async request(
    asker: DecisionAsker,
    input: RequestBoardDecisionInput,
  ): Promise<{ decisionId: string; issue: Issue }> {
    const now = new Date();
    const awaiting: AwaitingBoardDoc = {
      decisionId: new ObjectId(),
      since: now,
      question: input.question,
      options: input.options,
      askedBy: asker.agent._id,
    };
    const issue = await this.issues.update(
      asker.issue.key,
      { status: 'in_review' },
      async (session, before) => {
        if (isClosed(before.status)) {
          throw unprocessable(`${before.key} is ${before.status}; reopen it before asking`);
        }
        if (before.awaitingBoard) {
          await this.collections.decisions.updateOne(
            { _id: before.awaitingBoard.decisionId, status: 'open' },
            { $set: { status: 'superseded', decidedAt: now, decidedBy: null, answer: null } },
            { session },
          );
        }
        await this.collections.decisions.insertOne(
          {
            _id: awaiting.decisionId,
            issueId: before._id,
            projectId: before.projectId,
            question: input.question,
            options: input.options,
            askedBy: asker.agent._id,
            runId: asker.runId,
            askedAt: now,
            status: 'open',
            decidedAt: null,
            decidedBy: null,
            answer: null,
          },
          { session },
        );
        await this.collections.comments.insertOne(
          {
            _id: new ObjectId(),
            issueId: before._id,
            author: { type: 'agent', agentId: asker.agent._id.toHexString() },
            body: questionComment(input.question, input.options),
            createdAt: now,
          },
          { session },
        );
      },
      { set: { awaitingBoard: awaiting } },
    );
    return { decisionId: awaiting.decisionId.toHexString(), issue };
  }

  async list(query: ListDecisionsQuery): Promise<{ items: Decision[]; total: number }> {
    const open = query.status === 'open';
    const filter = open ? { status: 'open' as const } : { status: { $in: [...DECIDED] } };
    const [docs, total] = await Promise.all([
      this.collections.decisions
        .find(filter)
        .sort(open ? { askedAt: 1, _id: 1 } : { decidedAt: -1, _id: -1 })
        .limit(query.limit)
        .toArray(),
      this.collections.decisions.countDocuments(filter),
    ]);
    return { items: await this.describe(docs), total };
  }

  async count(): Promise<{ open: number }> {
    return { open: await this.collections.decisions.countDocuments({ status: 'open' }) };
  }

  /**
   * Answer with an option and/or free text: posted as a board comment, which wakes the agent.
   * The comment is bound to this decision, so a concurrent answer or a newer question makes it a
   * 409 with nothing written; options are fixed per decision, so checking them here is safe.
   */
  async answer(id: ObjectId, input: AnswerDecisionInput, author: Author): Promise<Decision> {
    const decision = await this.openDecision(id);
    if (input.option !== undefined && !decision.options.includes(input.option)) {
      throw unprocessable('option is not one of the offered options', {
        options: decision.options,
      });
    }
    await this.comments.create(
      decision.issueId.toHexString(),
      { body: answerComment(input) },
      author,
      { outcome: 'answered', decisionId: decision._id },
    );
    return this.get(id);
  }

  /** Decline to decide: the agent is woken with a comment saying so. */
  async dismiss(id: ObjectId, input: DismissDecisionInput, author: Author): Promise<Decision> {
    const decision = await this.openDecision(id);
    await this.comments.create(
      decision.issueId.toHexString(),
      { body: dismissComment(input) },
      author,
      { outcome: 'dismissed', decisionId: decision._id },
    );
    return this.get(id);
  }

  private async openDecision(id: ObjectId): Promise<DecisionDoc> {
    const decision = await this.collections.decisions.findOne({ _id: id });
    if (!decision) {
      throw notFound('Decision');
    }
    if (decision.status !== 'open') {
      throw conflict(`the decision is already ${decision.status}`);
    }
    return decision;
  }

  private async get(id: ObjectId): Promise<Decision> {
    const decision = await this.collections.decisions.findOne({ _id: id });
    if (!decision) {
      throw notFound('Decision');
    }
    const [described] = await this.describe([decision]);
    if (!described) {
      throw notFound('Decision');
    }
    return described;
  }

  /** Join issue, project and agent names; a deleted issue drops the decision from the list. */
  private async describe(docs: DecisionDoc[]): Promise<Decision[]> {
    const unique = (ids: ObjectId[]) => [
      ...new Map(ids.map((id) => [id.toHexString(), id])).values(),
    ];
    const [issues, projects, agents] = await Promise.all([
      this.collections.issues
        .find(
          { _id: { $in: unique(docs.map((doc) => doc.issueId)) } },
          { projection: { key: 1, title: 1, status: 1 } },
        )
        .toArray(),
      this.collections.projects
        .find(
          { _id: { $in: unique(docs.map((doc) => doc.projectId)) } },
          { projection: { key: 1, name: 1 } },
        )
        .toArray(),
      this.collections.agents
        .find({ _id: { $in: unique(docs.map((doc) => doc.askedBy)) } }, { projection: { name: 1 } })
        .toArray(),
    ]);
    const byId = <T extends { _id: ObjectId }>(rows: T[]) =>
      new Map(rows.map((row) => [row._id.toHexString(), row]));
    const issueById = byId(issues);
    const projectById = byId(projects);
    const agentById = byId(agents);
    return docs.flatMap((doc): Decision[] => {
      const issue = issueById.get(doc.issueId.toHexString());
      if (!issue) {
        return [];
      }
      const project = projectById.get(doc.projectId.toHexString());
      return [
        {
          id: doc._id.toHexString(),
          status: doc.status,
          question: doc.question,
          options: doc.options,
          askedAt: doc.askedAt,
          askedBy: {
            agentId: doc.askedBy.toHexString(),
            name: agentById.get(doc.askedBy.toHexString())?.name ?? null,
          },
          issue: {
            id: issue._id.toHexString(),
            key: issue.key,
            title: issue.title,
            status: issue.status,
          },
          project: project
            ? { id: project._id.toHexString(), key: project.key, name: project.name }
            : null,
          decidedAt: doc.decidedAt,
          decidedBy: doc.decidedBy,
          answer: doc.answer,
        },
      ];
    });
  }
}
