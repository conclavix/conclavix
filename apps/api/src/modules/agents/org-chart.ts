import type { OrgChartNode } from '@conclavix/core';
import type { AgentDoc } from '../../db.js';
import { avatarUrl } from '../avatars/url.js';

/**
 * Build the legacy org-chart forest from the deprecated `reportsTo` field (an agent's single
 * delegator). Agents with no or several delegators appear as roots.
 */
export function buildOrgChart(docs: AgentDoc[]): OrgChartNode[] {
  const nodes = new Map<string, OrgChartNode>();
  for (const doc of docs) {
    nodes.set(doc._id.toHexString(), {
      id: doc._id.toHexString(),
      name: doc.name,
      role: doc.role,
      title: doc.title,
      status: doc.status,
      avatarUrl: avatarUrl('agent', doc._id.toHexString(), doc.avatarEtag),
      reports: [],
    });
  }
  const roots: OrgChartNode[] = [];
  for (const doc of docs) {
    const node = nodes.get(doc._id.toHexString());
    const parent = doc.reportsTo ? nodes.get(doc.reportsTo.toHexString()) : undefined;
    if (!node) {
      continue;
    }
    if (parent) {
      parent.reports.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
