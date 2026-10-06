import type { RouteLocationRaw } from 'vue-router';
import type { RunCode } from '../api/types';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The chip label and the stats line of a coding agent's run. */
export function codeSummary(code: RunCode): { label: string; stats: string } {
  const label = code.commit ? `${code.branch} @ ${code.commit.slice(0, 10)}` : code.branch;
  const parts = [
    code.commit ? 'committed' : 'no new commit',
    plural(code.files, 'file'),
    `+${code.insertions} -${code.deletions}`,
  ];
  if (code.agentCommits > 0) parts.push(`${plural(code.agentCommits, 'commit')} by the agent`);
  return { label, stats: parts.join(' · ') };
}

/** The project's Code tab at the run's commit, or at the branch when there is none. */
export function codeLink(code: RunCode, issueKey: string): RouteLocationRaw {
  const projectKey = issueKey.split('-')[0] ?? issueKey;
  return {
    name: 'project',
    params: { projectKey },
    query: {
      tab: 'code',
      branch: code.branch,
      ...(code.commit && code.synced ? { commit: code.commit } : {}),
    },
  };
}
