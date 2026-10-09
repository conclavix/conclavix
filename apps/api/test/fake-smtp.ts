import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

export interface FakeSmtpOptions {
  /** Accepted credentials; without them every AUTH succeeds. */
  credentials?: { user: string; pass: string };
  /** Echo the received AUTH argument in the rejection, like a careless server might. */
  echoAuth?: boolean;
  rejectSender?: boolean;
  rejectRecipients?: string[];
}

export interface FakeSmtp {
  port: number;
  /** Credentials seen in AUTH commands, decoded. */
  logins: { user: string; pass: string }[];
  messages: { from: string; to: string[]; data: string }[];
  close(): Promise<void>;
}

const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

/** A minimal in-process SMTP server for tests: plain text, EHLO, AUTH PLAIN/LOGIN, one mail. */
export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const logins: FakeSmtp['logins'] = [];
  const messages: FakeSmtp['messages'] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let state: 'command' | 'data' | 'auth-plain' | 'login-user' | 'login-pass' = 'command';
    let loginUser = '';
    let mail: { from: string; to: string[]; data: string } = { from: '', to: [], data: '' };
    const reply = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    const checkLogin = (user: string, pass: string, raw: string): void => {
      logins.push({ user, pass });
      const expected = options.credentials;
      if (!expected || (expected.user === user && expected.pass === pass)) {
        reply('235 2.7.0 Authentication successful');
      } else {
        reply(`535 5.7.8 Authentication failed${options.echoAuth ? ` for ${raw}` : ''}`);
      }
    };
    const plain = (arg: string): void => {
      const [, user = '', pass = ''] = decode(arg).split('\u0000');
      checkLogin(user, pass, arg);
    };

    const auth = (arg: string): void => {
      const [mechanism = '', initial] = arg.split(' ');
      if (mechanism.toUpperCase() === 'PLAIN') {
        if (initial) plain(initial);
        else {
          state = 'auth-plain';
          reply('334 ');
        }
      } else if (mechanism.toUpperCase() === 'LOGIN') {
        state = 'login-user';
        reply('334 VXNlcm5hbWU6');
      } else {
        reply('504 5.5.4 Unrecognized authentication type');
      }
    };
    const mailFrom = (arg: string): void => {
      if (options.rejectSender) {
        reply('553 5.7.1 Sender address rejected: not owned by user');
        return;
      }
      mail = { from: arg.replace(/^FROM:\s*/i, ''), to: [], data: '' };
      reply('250 2.1.0 Ok');
    };
    const rcptTo = (arg: string): void => {
      const to = arg.replace(/^TO:\s*/i, '').replace(/[<>]/g, '');
      if (options.rejectRecipients?.includes(to)) {
        reply(`550 5.1.1 <${to}>: Recipient address rejected: User unknown`);
        return;
      }
      mail.to.push(to);
      reply('250 2.1.5 Ok');
    };
    const commands: Record<string, (arg: string) => void> = {
      EHLO: () => {
        reply('250-fake.smtp.test');
        reply('250-AUTH PLAIN LOGIN');
        reply('250 8BITMIME');
      },
      HELO: () => reply('250 fake.smtp.test'),
      AUTH: auth,
      MAIL: mailFrom,
      RCPT: rcptTo,
      DATA: () => {
        state = 'data';
        reply('354 End data with <CR><LF>.<CR><LF>');
      },
      RSET: () => reply('250 2.0.0 Ok'),
      NOOP: () => reply('250 2.0.0 Ok'),
      QUIT: () => {
        reply('221 2.0.0 Bye');
        socket.end();
      },
    };

    const handle = (line: string): void => {
      if (state === 'auth-plain') {
        state = 'command';
        plain(line);
        return;
      }
      if (state === 'login-user') {
        loginUser = decode(line);
        state = 'login-pass';
        reply('334 UGFzc3dvcmQ6');
        return;
      }
      if (state === 'login-pass') {
        state = 'command';
        checkLogin(loginUser, decode(line), line);
        return;
      }
      const [verb = '', ...rest] = line.split(' ');
      const command = commands[verb.toUpperCase()];
      if (command) command(rest.join(' '));
      else reply('502 5.5.2 Command not recognized');
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (state === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          mail.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          messages.push(mail);
          state = 'command';
          reply('250 2.0.0 Ok: queued as FAKE123');
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    });
    reply('220 fake.smtp.test ESMTP');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    logins,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port on which nothing listens: bound once, then released. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
