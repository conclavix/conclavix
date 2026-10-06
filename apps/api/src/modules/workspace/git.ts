import { execFile, spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';

/**
 * Options every git call starts with: no hooks, no fsmonitor command, no replace refs, no
 * transport, and raw paths in output. Repositories are written by agents later on, so nothing a
 * repository could configure for itself is allowed to start a program.
 */
const BASE_ARGS: readonly string[] = [
  '--no-replace-objects',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'diff.external=',
  '-c',
  'user.name=Conclavix',
  '-c',
  'user.email=conclavix@localhost',
];

/**
 * A minimal environment: no inherited secrets, no system or user git configuration, no
 * prompts, literal pathspecs (`:(glob)` and friends are plain names) and stable C-locale output.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_PAGER: 'cat',
  };
}

/** The git subcommand in an argument list, for error messages. */
function commandOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '-c') i += 1;
    else if (!arg.startsWith('-')) return arg;
  }
  return 'git';
}

export class GitError extends Error {
  /** A failed git call; the message never reaches API clients, it is only logged. */
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly reason: 'exit' | 'timeout' | 'output_limit' | 'spawn',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitCallOptions {
  /** Working directory; defaults to the process directory. */
  cwd?: string;
  timeoutMs?: number;
  /** Largest stdout accepted; past it the call fails, or is cut short with `allowTruncate`. */
  maxBytes?: number;
  /** Return the output read so far instead of failing when `maxBytes` is reached. */
  allowTruncate?: boolean;
  input?: string;
  /** Extra environment variables on top of the minimal git environment. */
  env?: Record<string, string>;
}

export interface GitResult {
  stdout: Buffer;
  truncated: boolean;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Runs the git binary with fixed argument arrays and no shell. */
export class Git {
  constructor(private readonly bin: string = 'git') {}

  /** Run git with `args` after the safety options; resolves with stdout as a buffer. */
  run(args: readonly string[], options: GitCallOptions = {}): Promise<GitResult> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bin,
        [...BASE_ARGS, ...args],
        {
          cwd: options.cwd,
          env: { ...gitEnv(), ...options.env },
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: maxBytes,
          encoding: 'buffer',
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          const err = stderr.toString('utf8').slice(0, 2000);
          if (!error) {
            resolve({ stdout, truncated: false });
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            if (options.allowTruncate) {
              resolve({ stdout: stdout.subarray(0, maxBytes), truncated: true });
              return;
            }
            reject(
              new GitError(
                `git ${commandOf(args)} exceeded the output limit`,
                null,
                err,
                'output_limit',
              ),
            );
            return;
          }
          if (error.killed) {
            reject(new GitError(`git ${commandOf(args)} timed out`, null, err, 'timeout'));
            return;
          }
          if (typeof code === 'string') {
            reject(new GitError(`git could not be started: ${code}`, null, err, 'spawn'));
            return;
          }
          const exitCode = typeof code === 'number' ? code : null;
          reject(
            new GitError(`git ${commandOf(args)} failed with ${exitCode}`, exitCode, err, 'exit'),
          );
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input ?? '');
    });
  }

  /** Run git and return trimmed stdout as UTF-8 text. */
  async text(args: readonly string[], options: GitCallOptions = {}): Promise<string> {
    return (await this.run(args, options)).stdout.toString('utf8').trim();
  }

  /** True when git exits 0, false on exit code 1 or 128; other failures throw. */
  async succeeds(args: readonly string[], options: GitCallOptions = {}): Promise<boolean> {
    try {
      await this.run(args, options);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.reason === 'exit') return false;
      throw error;
    }
  }

  /**
   * Start git and return its stdout as a stream. The process is killed after `timeoutMs`, and the
   * stream fails once more than `maxBytes` came through, so a huge or stuck archive cannot hold
   * the request forever.
   */
  stream(
    args: readonly string[],
    options: { cwd?: string; timeoutMs: number; maxBytes: number },
  ): Readable {
    const child = spawn(this.bin, [...BASE_ARGS, ...args], {
      cwd: options.cwd,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const out = new PassThrough();
    let bytes = 0;
    let stderr = '';
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      out.destroy(error);
    };
    const timer = setTimeout(
      () => fail(new GitError(`git ${commandOf(args)} timed out`, null, stderr, 'timeout')),
      options.timeoutMs,
    );
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        fail(
          new GitError(
            `git ${commandOf(args)} exceeded the output limit`,
            null,
            '',
            'output_limit',
          ),
        );
      }
    });
    child.stdout.pipe(out, { end: false });
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(new GitError(`git could not be started: ${error.message}`, null, '', 'spawn'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code === 0) out.end();
      else fail(new GitError(`git ${commandOf(args)} failed with ${code}`, code, stderr, 'exit'));
    });
    out.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    return out;
  }
}
