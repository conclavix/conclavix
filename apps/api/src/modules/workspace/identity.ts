/**
 * Commit identities and message text for agent commits. Kept free of other imports so the runner
 * entry point can use it without loading the workspace modules.
 */

/** Default domain of agent commit addresses; `.invalid` never receives mail (RFC 2606). */
export const DEFAULT_AGENT_EMAIL_DOMAIN = 'conclavix.invalid';

/** Characters of a merge message body supplied by an agent. */
export const MAX_MERGE_MESSAGE = 4000;

export interface CommitIdentity {
  name: string;
  email: string;
}

/** An identity git accepts: no angle brackets, newlines or other control characters. */
export function safeIdent(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned === '' ? fallback : cleaned;
}

/** One line of plain text: control characters become spaces. */
export const oneLine = (text: string): string =>
  text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The commit identity of an agent: `Conclavix <agent name>` with a per-agent no-reply address. */
export function agentIdentity(
  agent: { _id: { toHexString(): string }; name: string },
  domain: string = DEFAULT_AGENT_EMAIL_DOMAIN,
): CommitIdentity {
  return {
    name: `Conclavix ${oneLine(agent.name)}`,
    email: `agent-${agent._id.toHexString()}@${domain}`,
  };
}

/** A message body from an agent: LF line ends, no control characters but tabs, bounded. */
export function cleanMessage(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, ' ')
    .slice(0, MAX_MERGE_MESSAGE)
    .trim();
}
