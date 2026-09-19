/**
 * Reset a user's password from the server console.
 *
 *   npx tsx scripts/reset-password.ts admin@gruntech.com
 *   npx tsx scripts/reset-password.ts admin@gruntech.com "TheNewPassword"
 *
 * With no password given it generates one and prints it once.
 *
 * There is no "forgot password" e-mail in G-Core — it would need an SMTP
 * account, a token table and a public endpoint, which is three new things to
 * secure for a problem that shell access already solves. This script is the
 * intended way out of a locked account, and needing shell access to run it is
 * the point rather than a limitation.
 *
 * Every reset is written to the audit log, because "who changed the managing
 * director's password, and when" is exactly the question an audit trail exists
 * to answer.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { audit } from '../src/shared/audit';

/** Readable at a glance and still hard to guess: two words, digits, a symbol. */
function generate(): string {
  const words = [
    'Harbour', 'Lantern', 'Compass', 'Meridian', 'Anchor', 'Quarry',
    'Cobalt', 'Granite', 'Falcon', 'Juniper', 'Marble', 'Tundra',
  ];
  const pick = () => words[crypto.randomInt(words.length)];
  const digits = String(crypto.randomInt(1000, 10000));
  const symbol = '!@#$%'[crypto.randomInt(5)];
  return `${pick()}-${pick()}-${digits}${symbol}`;
}

(async () => {
  const [email, given] = process.argv.slice(2);

  if (!email) {
    console.error('\nUsage: npx tsx scripts/reset-password.ts <email> [new password]\n');
    const users = await prisma.user.findMany({
      select: { email: true, name: true, isActive: true, isSuperAdmin: true },
      orderBy: { email: 'asc' },
      take: 50,
    });
    console.error('Users on this database:\n');
    for (const u of users) {
      const tags = [u.isSuperAdmin ? 'super admin' : null, u.isActive ? null : 'INACTIVE']
        .filter(Boolean)
        .join(', ');
      console.error(`  ${u.email.padEnd(32)} ${u.name}${tags ? `  (${tags})` : ''}`);
    }
    console.error('');
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, name: true, isActive: true, isSuperAdmin: true },
  });

  if (!user) {
    console.error(`\nNo user with the email "${email}".`);
    console.error('Run with no arguments to list the accounts that do exist.\n');
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  const password = given ?? generate();
  if (password.length < 8) {
    console.error('\nThat password is under 8 characters. Pick a longer one.\n');
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  if (env.isProduction) {
    console.log('\n*** This is a PRODUCTION database. ***');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(password, 10) },
  });

  await audit({
    entityType: 'user',
    entityId: user.id,
    action: 'UPDATED',
    summary: `Password reset from the server console for ${user.email}`,
    actorName: 'console (reset-password.ts)',
  });

  console.log(`
Password reset.

  User      ${user.name} <${user.email}>${user.isSuperAdmin ? '  [super admin]' : ''}
  Password  ${password}
${user.isActive ? '' : '\n  NOTE: this account is INACTIVE and still cannot sign in. Reactivate it in Admin > Users.\n'}
Printed once, and stored only as a hash. Sign in and change it from
Account > Change password.
`);

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nReset failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await prisma.$disconnect();
});
