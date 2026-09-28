import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import { env } from '../env';

/**
 * Outgoing email, over SMTP, with nothing but Node's own sockets.
 *
 * G-CORE sends two kinds of mail — an invitation to a new account and a
 * password reset — to one person at a time. That is a short SMTP
 * conversation, not a mail library: connect (TLS from the first byte on 465,
 * or STARTTLS on 587), EHLO, AUTH, MAIL FROM, RCPT TO, DATA, QUIT. The rules
 * that matter:
 *
 *  - The mailbox password never crosses an unencrypted connection. A server
 *    that offers no STARTTLS is refused unless `allowPlainAuth` says
 *    otherwise, which only the test server in verify-accounts.ts does.
 *  - Nothing a person typed reaches a header with a line break in it: a name
 *    carrying "\r\nBcc: …" would otherwise add a recipient.
 *  - Bodies go out base64 in UTF-8, so a name with an ñ arrives as typed, and
 *    no line of the message can begin with the "." that ends it.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS from the first byte (465). Otherwise the connection is upgraded with STARTTLS. */
  secure: boolean;
  user?: string;
  pass?: string;
  /** `no-reply@example.com` or `G-CORE <no-reply@example.com>`. */
  from: string;
  /** Tests only: sign in over a plain connection to a local test server. */
  allowPlainAuth?: boolean;
  /** Per reply, in milliseconds. */
  timeoutMs?: number;
}

export interface MailMessage {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html?: string;
}

/** The configured mail account, or null when email is off (no SMTP_HOST). */
export function mailConfig(): SmtpConfig | null {
  const s = env.smtp;
  if (!s.host || !s.from) return null;
  return { host: s.host, port: s.port, secure: s.secure, user: s.user, pass: s.pass, from: s.from };
}

export const mailEnabled = (): boolean => mailConfig() !== null;

// ── Addresses and headers ────────────────────────────────────────────────────

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** The bare address in `Name <a@b.c>` or `a@b.c`; throws on anything else. */
export function addressOf(value: string): string {
  const m = /<([^<>]+)>\s*$/.exec(value);
  const address = (m ? m[1] : value).trim();
  if (!ADDRESS.test(address)) throw new Error(`"${value}" is not an email address`);
  return address;
}

/** The display name in `Name <a@b.c>`, if there is one. */
function displayNameOf(value: string): string | undefined {
  const m = /^(.*?)<[^<>]+>\s*$/.exec(value);
  const name = m?.[1].trim().replace(/^"(.*)"$/, '$1').trim();
  return name || undefined;
}

/** A header value on one line: every CR and LF becomes a space. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A header value that may carry non-ASCII — a subject, a name — as RFC 2047
 * encoded words, each short enough to keep the header line within limits.
 */
export function encodeHeader(value: string): string {
  const clean = oneLine(value);
  if (PRINTABLE_ASCII.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (chunk && Buffer.byteLength(chunk + ch, 'utf8') > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function mailbox(name: string | undefined, address: string): string {
  if (!name) return address;
  const clean = oneLine(name);
  if (!clean) return address;
  if (PRINTABLE_ASCII.test(clean)) return `"${clean.replace(/["\\]/g, '\\$&')}" <${address}>`;
  return `${encodeHeader(clean)} <${address}>`;
}

/** UTF-8 text as base64, in lines of 76 — which never begin with a dot. */
const base64Lines = (s: string) =>
  Buffer.from(s.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}(?=.)/g, '$&\r\n');

/** The whole message — headers and body, CRLF throughout — as it goes after DATA. */
export function buildMessage(cfg: Pick<SmtpConfig, 'from'>, msg: MailMessage, now = new Date()): string {
  const fromAddress = addressOf(cfg.from);
  const toAddress = addressOf(msg.to);
  const headers = [
    `From: ${mailbox(displayNameOf(cfg.from), fromAddress)}`,
    `To: ${mailbox(msg.toName, toAddress)}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${now.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${fromAddress.split('@')[1]}>`,
    'MIME-Version: 1.0',
    // Tells an out-of-office responder not to answer a machine.
    'Auto-Submitted: auto-generated',
  ];
  if (!msg.html) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${base64Lines(msg.text)}\r\n`;
  }
  const boundary = `gcore-${crypto.randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(msg.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(msg.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

// ── The SMTP conversation ────────────────────────────────────────────────────

interface Reply {
  code: number;
  lines: string[];
}

/** Collects the server's replies — "250-…" lines until the "250 …" that ends one. */
function replyReader(socket: net.Socket) {
  let buffer = '';
  let lines: string[] = [];
  const ready: Reply[] = [];
  let waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  let broken: Error | null = null;

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.resolve(reply);
        } else ready.push(reply);
      }
    }
  };
  const fail = (err: Error) => {
    broken ??= err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(err);
    }
  };
  const onError = (err: Error) => fail(err);
  const onClose = () => fail(new Error('the mail server closed the connection'));
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    next(): Promise<Reply> {
      if (ready.length) return Promise.resolve(ready.shift()!);
      if (broken) return Promise.reject(broken);
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: the mail server did not answer`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function open(cfg: SmtpConfig, ms: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const servername = net.isIP(cfg.host) ? undefined : cfg.host;
    const socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername })
      : net.connect({ host: cfg.host, port: cfg.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`could not reach ${cfg.host}:${cfg.port}`));
    }, ms);
    socket.once(cfg.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** STARTTLS: the same connection, encrypted from here on, the certificate checked. */
function upgrade(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

/**
 * Sends one message. Resolves when the server has accepted it; rejects with
 * a readable reason otherwise (never one carrying the mailbox password).
 */
export async function sendMail(msg: MailMessage, cfg: SmtpConfig | null = mailConfig()): Promise<void> {
  if (!cfg) throw new Error('email is not set up — SMTP_HOST is empty');
  const ms = cfg.timeoutMs ?? 20_000;
  // Both addresses are checked before anything is sent.
  const from = addressOf(cfg.from);
  const to = addressOf(msg.to);
  const data = buildMessage(cfg, msg);

  let socket = await open(cfg, ms);
  let reader = replyReader(socket);
  const expect = async (codes: number[], what: string) => {
    const reply = await withTimeout(reader.next(), ms, what);
    if (!codes.includes(reply.code)) {
      throw new Error(`${what}: the mail server answered "${reply.lines.join(' ').slice(0, 200)}"`);
    }
    return reply;
  };
  const say = (line: string, codes: number[], what: string) => {
    socket.write(`${line}\r\n`);
    return expect(codes, what);
  };

  try {
    await expect([220], 'Connecting');
    const hostname = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'gcore';
    let hello = await say(`EHLO ${hostname}`, [250], 'Greeting');
    let encrypted = cfg.secure;
    if (!encrypted && hello.lines.some((l) => /^250[ -]STARTTLS\b/i.test(l))) {
      await say('STARTTLS', [220], 'Starting encryption');
      reader.detach();
      socket = await upgrade(socket, cfg.host);
      reader = replyReader(socket);
      encrypted = true;
      hello = await say(`EHLO ${hostname}`, [250], 'Greeting over TLS');
    }

    if (cfg.user) {
      if (!encrypted && !cfg.allowPlainAuth) {
        throw new Error(`${cfg.host} offers no encryption — the mailbox password was not sent`);
      }
      const offered = hello.lines.find((l) => /^250[ -]AUTH\b/i.test(l))?.toUpperCase() ?? '';
      if (!offered.includes('LOGIN') || offered.includes('PLAIN')) {
        const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ''}`, 'utf8').toString('base64');
        await say(`AUTH PLAIN ${plain}`, [235], 'Signing in to the mail server');
      } else {
        await say('AUTH LOGIN', [334], 'Signing in to the mail server');
        await say(Buffer.from(cfg.user, 'utf8').toString('base64'), [334], 'Signing in to the mail server');
        await say(Buffer.from(cfg.pass ?? '', 'utf8').toString('base64'), [235], 'Signing in to the mail server');
      }
    }

    await say(`MAIL FROM:<${from}>`, [250], 'Naming the sender');
    await say(`RCPT TO:<${to}>`, [250, 251], 'Naming the recipient');
    await say('DATA', [354], 'Starting the message');
    // Dot-stuffing, which base64 bodies never need but a header might.
    socket.write(data.replace(/^\./gm, '..'));
    await say('.', [250], 'Sending the message');
    await say('QUIT', [221], 'Closing').catch(() => undefined);
  } finally {
    reader.detach();
    socket.on('error', () => undefined);
    socket.end();
    setTimeout(() => socket.destroy(), 1_000).unref();
  }
}
