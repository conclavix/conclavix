import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { SettingsService } from '../settings/service.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Resolve true when the mail was handed to SMTP, false when no SMTP is configured. */
  send(mail: Mail): Promise<boolean>;
}

/**
 * Sends through the SMTP settings in effect at the time of sending. Without SMTP a mail is not
 * dropped silently: a warning includes a masked recipient and subject (never the body, which may hold
 * a reset link) so an operator can act.
 */
export class SettingsMailer implements Mailer {
  constructor(
    private readonly settings: SettingsService,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(mail: Mail): Promise<boolean> {
    const { smtp } = await this.settings.current();
    if (!smtp.host || !smtp.from) {
      this.log.warn(
        { to: mail.to.replace(/^[^@]*/, '***'), subject: mail.subject },
        'SMTP is not configured; mail was NOT sent. Configure SMTP or reset the password as an admin.',
      );
      return false;
    }
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
    });
    await transport.sendMail({
      from: smtp.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
    return true;
  }
}
