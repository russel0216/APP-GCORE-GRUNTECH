/**
 * Accounts: one creation (an employee and their login together), invitations,
 * password resets and the SMTP sender behind them.
 *
 *   npx tsx scripts/verify-accounts.ts
 *
 * The SMTP half talks to a fake mail server this script starts on 127.0.0.1,
 * and needs nothing else. The rest checks routes over HTTP against the local
 * API on :5100 (see CLAUDE.md), and says so loudly if it is not running. It
 * creates its own people, and removes them afterwards.
 */
import net from 'node:net';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { addressOf, buildMessage, encodeHeader, sendMail, type SmtpConfig } from '../src/shared/mail';
import { hashToken, linkEmail, linkFor } from '../src/shared/accounts';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const TAG = 'ZZACCT';
const DOMAIN = '@verifya.local';

async function cleanup() {
  await prisma.employee.deleteMany({ where: { lastName: { startsWith: TAG } } });
  const users = await prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    // Account tokens and roles go with the user (onDelete: Cascade).
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.industry.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function makeUser(name: string, email: string, roleKeys: string[], superAdmin = false) {
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  return prisma.user.create({
    data: {
      name,
      email,
      isSuperAdmin: superAdmin,
      passwordHash: await bcrypt.hash('not-a-real-password', 10),
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
}

// ── A fake mail server ───────────────────────────────────────────────────────

interface Captured {
  commands: string[];
  data: string;
  user: string;
  pass: string;
}

/** Speaks just enough SMTP to receive one message and remember everything it was told. */
function fakeSmtp(auth = 'PLAIN LOGIN'): Promise<{ port: number; got: Captured; close: () => Promise<void> }> {
  const got: Captured = { commands: [], data: '', user: '', pass: '' };
  const server = net.createServer((sock) => {
    sock.setEncoding('latin1');
    let buffer = '';
    let inData = false;
    let loginStep = 0;
    sock.write('220 fake.local ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          got.data = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          inData = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (loginStep === 1) {
          got.user = Buffer.from(line, 'base64').toString('utf8');
          loginStep = 2;
          sock.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (loginStep === 2) {
          got.pass = Buffer.from(line, 'base64').toString('utf8');
          loginStep = 0;
          sock.write('235 ok\r\n');
          continue;
        }
        got.commands.push(/^AUTH PLAIN /i.test(line) ? 'AUTH PLAIN ***' : line);
        if (/^EHLO/i.test(line)) sock.write(`250-fake.local\r\n250-AUTH ${auth}\r\n250 8BITMIME\r\n`);
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
          got.user = user;
          got.pass = pass;
          sock.write('235 ok\r\n');
        } else if (/^AUTH LOGIN/i.test(line)) {
          loginStep = 1;
          sock.write('334 VXNlcm5hbWU6\r\n');
        } else if (/^(MAIL FROM|RCPT TO)/i.test(line)) sock.write('250 ok\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          sock.write('354 go ahead\r\n');
        } else if (/^QUIT/i.test(line)) {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('500 what\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        got,
        close: () => new Promise((done) => server.close(() => done())),
      }),
    ),
  );
}

/** The decoded text of each base64 part of a captured message. */
function decodedParts(data: string): string[] {
  const parts: string[] = [];
  for (const m of data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|\r\n$|$)/g)) {
    parts.push(Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
  }
  return parts;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const BASE = `http://localhost:${env.port}/api`;

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function http(token: string | null, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, text };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The token out of a link's #fragment. */
const tokenOf = (link: unknown) => String(link ?? '').split('#token=')[1] ?? '';

async function main() {
  console.log('\nG-CORE accounts verification\n');
  await cleanup();

  // ── 1. The SMTP sender, against a fake server ──────────────────────────────
  console.log('Sending mail (a fake SMTP server on 127.0.0.1)');

  const plain = await fakeSmtp();
  const cfg: SmtpConfig = {
    host: '127.0.0.1',
    port: plain.port,
    secure: false,
    user: 'no-reply@gruntech.test',
    pass: 'app-password-123',
    from: 'G-CORE <no-reply@gruntech.test>',
    allowPlainAuth: true,
    timeoutMs: 5_000,
  };
  const text = 'Hi Niño,\n\nYour link:\nhttps://gruntech.gcore.tech/welcome#token=abc\n\n.a line that starts with a dot';
  let sendError = '';
  try {
    await sendMail(
      {
        to: 'nino@gruntech.test',
        toName: 'Niño Dela Cruz\r\nBcc: stranger@elsewhere.test',
        subject: 'Imbitasyon sa G-CORE — Niño',
        text,
        html: '<p>Hi Niño</p>',
      },
      cfg,
    );
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }
  await plain.close();
  const got = plain.got;
  check('a message goes through a plain conversation end to end', !sendError && got.data.length > 0, sendError);
  check('it signs in with the mailbox user and password (AUTH PLAIN)', got.user === cfg.user && got.pass === cfg.pass);
  check('the envelope names the sender and the recipient', got.commands.includes('MAIL FROM:<no-reply@gruntech.test>') && got.commands.includes('RCPT TO:<nino@gruntech.test>'));
  check(
    'a line break in a name cannot add a recipient',
    !/^Bcc:/im.test(got.data) && !got.commands.some((c) => /stranger/i.test(c)),
    got.data.split('\r\n').find((l) => /^To:/.test(l)),
  );
  check('a non-ASCII subject goes as an encoded word', /^Subject: =\?UTF-8\?B\?/m.test(got.data));
  const parts = decodedParts(got.data);
  check(
    'the text arrives as typed, ñ and all, in both parts',
    parts.length === 2 && parts[0] === text.replace(/\n/g, '\r\n') && parts[1] === '<p>Hi Niño</p>',
    JSON.stringify(parts.map((p) => p.slice(0, 40))),
  );
  check('no line of the message starts with the dot that would end it', !got.data.split('\r\n').some((l) => l.startsWith('.')));
  check('it says Date, Message-ID and MIME', /^Date: /m.test(got.data) && /^Message-ID: <.+@gruntech\.test>/m.test(got.data) && /^MIME-Version: 1\.0/m.test(got.data));
  check('the From header carries the display name', /^From: "G-CORE" <no-reply@gruntech\.test>/m.test(got.data));

  const noTls = await fakeSmtp();
  let refused = '';
  try {
    await sendMail({ to: 'a@gruntech.test', subject: 'x', text: 'x' }, { ...cfg, port: noTls.port, allowPlainAuth: false });
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  await noTls.close();
  check(
    'a server that offers no encryption never receives the mailbox password',
    /offers no encryption/.test(refused) && !noTls.got.commands.some((c) => /^AUTH/i.test(c)),
    refused,
  );
  check('and the error does not carry the password', !refused.includes(cfg.pass!));

  const loginOnly = await fakeSmtp('LOGIN');
  let loginError = '';
  try {
    await sendMail({ to: 'a@gruntech.test', subject: 'x', text: 'x' }, { ...cfg, port: loginOnly.port });
  } catch (err) {
    loginError = err instanceof Error ? err.message : String(err);
  }
  await loginOnly.close();
  check('a server that only offers AUTH LOGIN gets AUTH LOGIN', !loginError && loginOnly.got.user === cfg.user && loginOnly.got.pass === cfg.pass, loginError);

  let badAddress = false;
  try {
    addressOf('someone\r\n@gruntech.test');
  } catch {
    badAddress = true;
  }
  check('an address with a line break in it is refused before anything is sent', badAddress);
  const longSubject = encodeHeader('Ang iyong G-CORE account sa Gruntechnology Corp — mag-set ng password ñ ñ ñ ñ ñ ñ ñ');
  check(
    'a long non-ASCII subject is folded into encoded words of legal length',
    longSubject.split('\r\n ').every((w) => w.length <= 75) && longSubject.includes('\r\n '),
  );
  check('a plain ASCII subject stays readable', encodeHeader('Reset your G-CORE password') === 'Reset your G-CORE password');
  const built = buildMessage({ from: 'no-reply@gruntech.test' }, { to: 'x@gruntech.test', subject: 's', text: 'x'.repeat(5000) });
  check('no line is longer than SMTP allows', built.split('\r\n').every((l) => l.length <= 998));

  // ── 2. Links and the emails that carry them ────────────────────────────────
  console.log('\nOne-time links');

  const inviteLink = linkFor('INVITE', 'RAWTOKEN123456789012345');
  check('an invitation link carries its token in the #fragment, which no server log sees', inviteLink.endsWith('/welcome#token=RAWTOKEN123456789012345') && !inviteLink.includes('?'));
  check('a reset link goes to the reset page', linkFor('RESET', 'x').includes('/reset-password#token='));
  check('only a hash of a token is ever stored, and the same token always hashes the same', hashToken('abc') === hashToken('abc') && hashToken('abc') !== 'abc' && hashToken('abc').length === 64);
  const email = linkEmail('INVITE', {
    name: '<script>alert(1)</script> Reyes',
    email: 'r@gruntech.test',
    link: inviteLink,
    expiresAt: new Date('2026-10-05T01:13:00Z'),
    org: 'Gruntechnology Corp',
    inviter: 'Carter Gasiong',
  });
  check('the invitation says who set it up, and carries the link', email.text.includes('Carter Gasiong has set up your G-CORE account at Gruntechnology Corp') && email.text.includes(inviteLink));
  check('it says when the link runs out, in Manila time', email.text.includes('Oct 5, 2026') && email.text.includes('Manila'));
  check('a name cannot inject markup into the HTML email', !email.html.includes('<script>') && email.html.includes('&lt;script&gt;'));

  // ── 3. Over HTTP ───────────────────────────────────────────────────────────
  if (!(await apiReachable())) {
    failed++;
    console.log(`\n  ✗ API is not reachable at ${BASE} — start it (cd api && npm run dev) and run this again`);
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exitCode = 1;
    return;
  }

  const admin = await makeUser(`${TAG} Admin`, `admin${DOMAIN}`, [], true);
  const hr = await makeUser(`${TAG} HR`, `hr${DOMAIN}`, ['hr']);
  const adminT = signToken(admin.id, admin.email);
  const hrT = signToken(hr.id, hr.email);
  const department = await prisma.department.create({ data: { code: `${TAG}-D`, name: `${TAG} Operations` } });
  const employeeRole = await prisma.role.findUniqueOrThrow({ where: { key: 'employee' } });

  const options = await http(null, 'GET', '/auth/options');
  const mailOn = options.body.mail === true;
  check('the sign-in page can ask whether email is set up, before anyone signs in', options.status === 200 && typeof options.body.mail === 'boolean');
  const status = await http(adminT, 'GET', '/users/mail-status');
  check('Admin sees the mail set-up, and never the mailbox password', status.status === 200 && !('pass' in status.body) && !status.text.includes('SMTP_PASS'));

  console.log('\nInvitations from Admin › Users');
  const invited = await http(adminT, 'POST', '/users', { name: `${TAG} Invitee One`, email: `one${DOMAIN}`, roleIds: [employeeRole.id] });
  const invite1 = invited.body.invite as { link: string; emailed: boolean; expiresAt: string } | null;
  check('a user added without a password is invited', invited.status === 201 && invited.body.invitePending === true && !!invite1, invited.text.slice(0, 200));
  check('the administrator gets the link to pass on', !!invite1 && invite1.link.includes('/welcome#token=') && invite1.emailed === mailOn);
  check(
    'an invitation lasts a week',
    !!invite1 && Math.abs(new Date(invite1.expiresAt).getTime() - Date.now() - 7 * 86_400_000) < 120_000,
  );
  const signInEarly = await http(null, 'POST', '/auth/login', { email: `one${DOMAIN}`, password: 'anything-at-all' });
  check('nobody can sign in to an invited account before it is accepted', signInEarly.status === 401);

  const t1 = tokenOf(invite1?.link);
  const seen = await http(null, 'POST', '/auth/link', { token: t1 });
  check('the link says whose it is and what it is for', seen.status === 200 && seen.body.purpose === 'INVITE' && seen.body.email === `one${DOMAIN}`);
  check('a made-up link is gone (410)', (await http(null, 'POST', '/auth/link', { token: 'x'.repeat(43) })).status === 410);
  const weak = await http(null, 'POST', '/auth/welcome', { token: t1, password: 'short' });
  check('a password under 8 characters is refused', weak.status === 400);
  check('and the refused try does not use up the link', (await http(null, 'POST', '/auth/link', { token: t1 })).status === 200);
  const accepted = await http(null, 'POST', '/auth/welcome', { token: t1, password: 'Welcome-2026!', phone: '0917 000 0001' });
  check('accepting the invitation signs them in', accepted.status === 200 && typeof accepted.body.token === 'string', accepted.text.slice(0, 200));
  const meNow = await http(String(accepted.body.token), 'GET', '/auth/me');
  check('with a session that works', meNow.status === 200 && (meNow.body.user as { email?: string })?.email === `one${DOMAIN}`);
  const oneRow = await prisma.user.findUniqueOrThrow({ where: { email: `one${DOMAIN}` } });
  check('the account is no longer pending, and keeps the mobile they gave', !oneRow.invitePending && oneRow.phone === '0917 000 0001');
  check('the link works once — a second use is gone (410)', (await http(null, 'POST', '/auth/welcome', { token: t1, password: 'Another-2026!' })).status === 410);
  check('and they can sign in with the password they chose', (await http(null, 'POST', '/auth/login', { email: `one${DOMAIN}`, password: 'Welcome-2026!' })).status === 200);
  check(
    'the acceptance is in the audit trail, by them',
    (await prisma.auditLog.count({ where: { entityId: oneRow.id, actorId: oneRow.id, summary: { contains: 'Accepted the invitation' } } })) === 1,
  );
  check('the database holds only the hash of the link', (await prisma.accountToken.count({ where: { tokenHash: hashToken(t1) } })) === 1 && (await prisma.accountToken.count({ where: { tokenHash: t1 } })) === 0);
  const resendDone = await http(adminT, 'POST', `/users/${oneRow.id}/invite`);
  check('someone who has chosen a password is not re-invited — a reset is offered instead', resendDone.status === 400 && /reset/i.test(resendDone.text));

  console.log('\nResending, and resets an administrator issues');
  const two = await http(adminT, 'POST', '/users', { name: `${TAG} Invitee Two`, email: `two${DOMAIN}` });
  const firstLink = tokenOf((two.body.invite as { link: string }).link);
  const again = await http(adminT, 'POST', `/users/${two.body.id}/invite`);
  const secondLink = tokenOf((again.body as { link?: string }).link);
  check('a new invitation can be sent', again.status === 200 && secondLink.length > 20 && secondLink !== firstLink);
  check('and it kills the one before', (await http(null, 'POST', '/auth/link', { token: firstLink })).status === 410 && (await http(null, 'POST', '/auth/link', { token: secondLink })).status === 200);
  const setByHand = await http(adminT, 'PATCH', `/users/${two.body.id}`, { password: 'SetByAdmin-1' });
  const twoRow = await prisma.user.findUniqueOrThrow({ where: { id: String(two.body.id) } });
  check('a password set by an administrator completes the invitation', setByHand.status === 200 && !twoRow.invitePending);
  check('and the link still out stops working', (await http(null, 'POST', '/auth/link', { token: secondLink })).status === 410);

  const reset = await http(adminT, 'POST', `/users/${oneRow.id}/reset-link`);
  const resetLink = tokenOf((reset.body as { link?: string }).link);
  check('an administrator can issue a reset link', reset.status === 200 && String(reset.body.link).includes('/reset-password#token='));
  check(
    'which lasts a day, since it may travel by chat',
    Math.abs(new Date(String(reset.body.expiresAt)).getTime() - Date.now() - 24 * 3_600_000) < 120_000,
  );
  check('a reset link is not an invitation', (await http(null, 'POST', '/auth/welcome', { token: resetLink, password: 'Wrong-Door-1' })).status === 410);
  const used = await http(null, 'POST', '/auth/reset', { token: resetLink, password: 'Brand-New-2026' });
  check('using it sets the new password and signs them in', used.status === 200 && typeof used.body.token === 'string');
  check('the old password stops working', (await http(null, 'POST', '/auth/login', { email: `one${DOMAIN}`, password: 'Welcome-2026!' })).status === 401);
  check('the new one works', (await http(null, 'POST', '/auth/login', { email: `one${DOMAIN}`, password: 'Brand-New-2026' })).status === 200);
  check('and the link is spent', (await http(null, 'POST', '/auth/reset', { token: resetLink, password: 'Again-2026-x' })).status === 410);

  console.log('\nForgot password');
  const known = await http(null, 'POST', '/auth/forgot', { email: `one${DOMAIN}` });
  const unknown = await http(null, 'POST', '/auth/forgot', { email: `nobody-at-all${DOMAIN}` });
  check('the answer is the same whether or not the address has an account', known.status === 200 && known.text === unknown.text, `${known.text} / ${unknown.text}`);
  check('and it says whether email is set up', known.body.mail === mailOn);
  if (!mailOn) {
    check(
      'with email off, no reset link is made that nobody could receive',
      (await prisma.accountToken.count({ where: { userId: oneRow.id, purpose: 'RESET', usedAt: null } })) === 0,
    );
  }

  console.log('\nOne creation: an employee and their login together');
  // A throwaway team, so the seeded industries are never touched.
  const team = await prisma.industry.create({ data: { code: 'ZQ', name: `${TAG} Utilities Team` } });
  const offTeam = await prisma.industry.create({ data: { code: 'ZQX', name: `${TAG} Retired Team`, isActive: false } });
  const hire = await http(adminT, 'POST', '/employees', {
    employeeNo: `${TAG}-001`,
    firstName: 'Liza',
    lastName: `${TAG} Soberano`,
    departmentId: department.id,
    industryId: team.id,
    position: 'Service Engineer',
    mobile: '0917 111 2222',
    login: { email: `liza${DOMAIN}` },
  });
  const hireLogin = hire.body.login as { user: { id: string; name: string; invitePending: boolean }; invite: { link: string } | null } | null;
  check('saving the employee also makes their login, and links it', hire.status === 201 && !!hireLogin && hire.body.userId === hireLogin.user.id, hire.text.slice(0, 200));
  const lizaUser = hireLogin ? await prisma.user.findUniqueOrThrow({ where: { id: hireLogin.user.id }, include: { roles: { include: { role: true } } } }) : null;
  check('the login carries their name, department, position and mobile from the record', lizaUser?.name === `Liza ${TAG} Soberano` && lizaUser.departmentId === department.id && lizaUser.position === 'Service Engineer' && lizaUser.phone === '0917 111 2222');
  check('it starts with the self-service Employee role', !!lizaUser && lizaUser.roles.map((r) => r.role.key).join(',') === 'employee');
  check('and the invitation is ready to go', !!hireLogin?.invite?.link && hireLogin.user.invitePending === true);
  const lizaToken = tokenOf(hireLogin?.invite?.link);
  const lizaLink = await http(null, 'POST', '/auth/link', { token: lizaToken });
  check('the invitation asks for their own details, since HR keeps a record', lizaLink.status === 200 && !!lizaLink.body.personal && (lizaLink.body.personal as { mobile?: string }).mobile === '0917 111 2222');
  const lizaFacts = lizaLink.body.facts as { team?: string; position?: string; employeeNo?: string } | null;
  check(
    'and shows their team, position and employee number from the HR record',
    lizaFacts?.team === `${TAG} Utilities Team` && lizaFacts?.position === 'Service Engineer' && lizaFacts?.employeeNo === `${TAG}-001`,
    JSON.stringify(lizaFacts),
  );
  const lizaIn = await http(null, 'POST', '/auth/welcome', {
    token: lizaToken,
    password: 'Liza-Joins-2026',
    phone: '0917 333 4444',
    personal: {
      mobile: '0917 333 4444',
      address: '12 Rizal St, Marikina',
      birthDate: '1995-02-14',
      emergencyContactName: 'Maria Soberano',
      emergencyContactPhone: '0917 555 6666',
      // Not theirs to change — sent anyway, as a hand-made request could.
      employeeNo: `${TAG}-999`,
      position: 'President',
      industryId: offTeam.id,
    },
    employeeNo: `${TAG}-999`,
    position: 'President',
  });
  const lizaEmp = await prisma.employee.findUniqueOrThrow({ where: { employeeNo: `${TAG}-001` } });
  check(
    'the invitation cannot change the employee number, position or team',
    lizaEmp.position === 'Service Engineer' && lizaEmp.industryId === team.id &&
      (await prisma.employee.count({ where: { employeeNo: `${TAG}-999` } })) === 0 &&
      (await prisma.user.findUniqueOrThrow({ where: { id: lizaEmp.userId! } })).position === 'Service Engineer',
  );
  check(
    'what they fill in lands on their employee record',
    lizaIn.status === 200 &&
      lizaEmp.address === '12 Rizal St, Marikina' &&
      lizaEmp.birthDate?.toISOString().slice(0, 10) === '1995-02-14' &&
      lizaEmp.emergencyContactName === 'Maria Soberano' &&
      lizaEmp.mobile === '0917 333 4444',
    lizaIn.text.slice(0, 160),
  );
  const lizaProfile = await http(String(lizaIn.body.token), 'GET', '/auth/profile');
  check('and they can see it on their own profile later', (lizaProfile.body.personal as { address?: string } | null)?.address === '12 Rizal St, Marikina');
  check(
    'My Account shows the same team, position and employee number',
    JSON.stringify(lizaProfile.body.facts) === JSON.stringify({ team: `${TAG} Utilities Team`, position: 'Service Engineer', employeeNo: `${TAG}-001` }),
    JSON.stringify(lizaProfile.body.facts),
  );
  const selfTeam = await http(String(lizaIn.body.token), 'PATCH', '/auth/profile', { personal: { industryId: offTeam.id, position: 'President' } });
  check(
    'and the profile cannot change them either',
    selfTeam.status === 200 && (await prisma.employee.findUniqueOrThrow({ where: { id: lizaEmp.id } })).industryId === team.id,
  );

  // HR sets the team; the register filters by it; a team in use is not deleted.
  const listed = await http(adminT, 'GET', `/employees?industryId=${team.id}`);
  check(
    'the register filters by team and returns it on each row',
    listed.status === 200 &&
      (listed.body.rows as { id: string; industry: { name: string } | null }[]).some((r) => r.id === lizaEmp.id && r.industry?.name === `${TAG} Utilities Team`),
  );
  const noTeam = await http(adminT, 'GET', `/employees?industryId=none&search=${encodeURIComponent(TAG)}`);
  check('?industryId=none lists only people with no team yet', noTeam.status === 200 && !(noTeam.body.rows as { id: string }[]).some((r) => r.id === lizaEmp.id));
  const bogusTeam = await http(adminT, 'PATCH', `/employees/${lizaEmp.id}`, { industryId: 'no-such-industry' });
  check('a team that does not exist is refused (400)', bogusTeam.status === 400, bogusTeam.text.slice(0, 120));
  const retired = await http(adminT, 'PATCH', `/employees/${lizaEmp.id}`, { industryId: offTeam.id });
  check('a switched-off team is refused (400)', retired.status === 400, retired.text.slice(0, 120));
  const dropTeam = await http(adminT, 'DELETE', `/reference/industries/${team.id}`);
  check('an industry with people on its team cannot be deleted', dropTeam.status === 400 && !!(await prisma.industry.findUnique({ where: { id: team.id } })), dropTeam.text.slice(0, 120));
  const moved = await http(String(lizaIn.body.token), 'PATCH', '/auth/profile', { personal: { address: '7 Bonifacio Ave, Pasig' } });
  check('and correct it there', moved.status === 200 && (await prisma.employee.findUniqueOrThrow({ where: { id: lizaEmp.id } })).address === '7 Bonifacio Ave, Pasig');
  const noRecord = await http(String(used.body.token), 'PATCH', '/auth/profile', { personal: { address: 'x' } });
  check('an account with no employee record has no personal details to change', noRecord.status === 400);

  const byHr = await http(hrT, 'POST', '/employees', {
    employeeNo: `${TAG}-002`,
    firstName: 'Paolo',
    lastName: `${TAG} Contis`,
    login: { email: `paolo${DOMAIN}` },
  });
  check('HR without admin.users.create cannot make a login (403)', byHr.status === 403, byHr.text.slice(0, 160));
  check('and nothing half-made is left behind — no employee either', (await prisma.employee.count({ where: { employeeNo: `${TAG}-002` } })) === 0);
  const hrPlain = await http(hrT, 'POST', '/employees', { employeeNo: `${TAG}-002`, firstName: 'Paolo', lastName: `${TAG} Contis` });
  check('HR can still save the employee on their own', hrPlain.status === 201);
  const hrInvite = await http(hrT, 'POST', `/employees/${hrPlain.body.id}/login`, { email: `paolo${DOMAIN}` });
  check('and inviting them later needs the same right (403)', hrInvite.status === 403);

  const taken = await http(adminT, 'POST', '/employees', {
    employeeNo: `${TAG}-003`,
    firstName: 'Dup',
    lastName: `${TAG} Email`,
    login: { email: `liza${DOMAIN}` },
  });
  check('a login email already in use refuses the save (409)', taken.status === 409);
  check('and the employee is not created without it', (await prisma.employee.count({ where: { employeeNo: `${TAG}-003` } })) === 0);

  console.log('\nInviting someone already on the register');
  const later = await http(adminT, 'POST', `/employees/${hrPlain.body.id}/login`, { email: `paolo${DOMAIN}` });
  const paoloEmp = await prisma.employee.findUniqueOrThrow({ where: { id: String(hrPlain.body.id) } });
  check('an existing employee gets a login and an invitation in one step', later.status === 201 && paoloEmp.userId === (later.body.user as { id: string }).id && !!(later.body.invite as { link?: string } | null)?.link);
  check('a second login for them is refused (409)', (await http(adminT, 'POST', `/employees/${hrPlain.body.id}/login`, { email: `paolo2${DOMAIN}` })).status === 409);

  const loose = await http(adminT, 'POST', '/employees', { employeeNo: `${TAG}-004`, firstName: 'Kim', lastName: `${TAG} Chiu` });
  const linked = await http(adminT, 'POST', '/users', { name: `Kim ${TAG} Chiu`, email: `kim${DOMAIN}`, employeeId: loose.body.id });
  check('Admin › Users can link the new login to an employee in the same save', linked.status === 201 && (await prisma.employee.findUniqueOrThrow({ where: { id: String(loose.body.id) } })).userId === linked.body.id);
  const twice = await http(adminT, 'POST', '/users', { name: 'Kim again', email: `kim2${DOMAIN}`, employeeId: loose.body.id });
  check('but not to an employee who already has one (409)', twice.status === 409);
  check('and that refusal made no login', (await prisma.user.count({ where: { email: `kim2${DOMAIN}` } })) === 0);

  const off = await http(adminT, 'POST', '/users', { name: `${TAG} Switched Off`, email: `off${DOMAIN}` });
  const offToken = tokenOf((off.body.invite as { link: string }).link);
  await http(adminT, 'PATCH', `/users/${off.body.id}`, { isActive: false });
  check('the link of a switched-off account stops working', (await http(null, 'POST', '/auth/link', { token: offToken })).status === 410);

  const detail = await http(adminT, 'GET', `/users/${linked.body.id}`);
  check('the account page says when the invitation went and until when', !!(detail.body.invite as { sentAt?: string } | null)?.sentAt && (detail.body.invite as { live?: boolean }).live === true);
  check('and which employee it belongs to', (detail.body.employee as { employeeNo?: string } | null)?.employeeNo === `${TAG}-004`);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
