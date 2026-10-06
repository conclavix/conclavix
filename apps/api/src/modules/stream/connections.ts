/** Re-runs the access check for one open stream; false (or a throw) ends the stream. */
export type Reauthorize = () => Promise<boolean>;

interface Connection {
  userId: string | null;
  reauthorize: Reauthorize;
  close: () => void;
}

/**
 * Open board streams and who they belong to. A stream is authorised once when it opens, so
 * anything that can take access away (ban, delete, password reset, sign-out, session or token
 * revocation, role or MFA changes) asks for that user's streams to be checked again. Each
 * stream also re-checks itself periodically, which covers expiry and changes made by another
 * process such as the CLI.
 */
export class StreamConnections {
  private readonly connections = new Set<Connection>();

  /** Track an open stream; the returned function forgets it. */
  add(connection: Connection): () => void {
    this.connections.add(connection);
    return () => {
      this.connections.delete(connection);
    };
  }

  get size(): number {
    return this.connections.size;
  }

  /** Re-check every open stream of the user and close those that lost access. */
  async recheckUser(userId: string): Promise<void> {
    const mine = [...this.connections].filter((connection) => connection.userId === userId);
    await Promise.all(mine.map((connection) => this.check(connection)));
  }

  /** Re-check one stream; failing closed, so a check that cannot run ends the stream too. */
  async check(connection: Connection): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await connection.reauthorize();
    } catch {
      allowed = false;
    }
    if (!allowed && this.connections.has(connection)) {
      this.connections.delete(connection);
      connection.close();
    }
  }
}
