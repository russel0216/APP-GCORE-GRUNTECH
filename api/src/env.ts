import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Reads an environment variable, treating an EMPTY string as unset.
 *
 * `??` alone does not: a commented-out-but-still-present `UPLOAD_DIR=""` in a
 * .env file yields '', which then silently defeats every default downstream.
 */
function read(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function required(name: string, fallback?: string): string {
  const value = read(name) ?? fallback;
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy api/.env.example to api/.env and fill it in.`,
    );
  }
  return value;
}

const isProduction = read('NODE_ENV') === 'production';
const corsOrigin = (read('CORS_ORIGIN') ?? 'http://localhost:5173').split(',').map((s) => s.trim());

export const env = {
  nodeEnv: read('NODE_ENV') ?? 'development',
  isProduction,
  port: Number(read('PORT') ?? 5100),
  databaseUrl: required('DATABASE_URL', 'postgresql://gcore:gcore@localhost:5433/gcore'),
  jwtSecret: required('JWT_SECRET', 'dev-only-change-me'),
  jwtExpiresIn: read('JWT_EXPIRES_IN') ?? '12h',
  uploadDir: read('UPLOAD_DIR') ?? path.resolve(__dirname, '..', 'uploads'),
  maxUploadMb: Number(read('MAX_UPLOAD_MB') ?? 25),
  corsOrigin,
  /**
   * Where the web app is reached from outside — printed into calendar files
   * and hand-off links, which leave the browser and cannot use a relative
   * path. In production that is the tunnel's hostname; in development the
   * first CORS origin is the Vite dev server.
   */
  appUrl: read('APP_URL') ?? (isProduction ? 'https://gruntech.gcore.tech' : corsOrigin[0]),
  /**
   * Outgoing email — invitations and password resets. Any mail provider's
   * SMTP account works (Google Workspace with an app password, Microsoft 365,
   * the web host's mailbox). Unset SMTP_HOST means email is off: an
   * administrator is shown each link to pass on instead, and the sign-in
   * page says a reset has to come from an administrator.
   *
   *   SMTP_HOST=smtp.gmail.com      SMTP_PORT=465 (implicit TLS) or 587 (STARTTLS)
   *   SMTP_USER=no-reply@gruntechnology.com   SMTP_PASS=<app password>
   *   MAIL_FROM="G-CORE <no-reply@gruntechnology.com>"   (defaults to SMTP_USER)
   */
  smtp: {
    host: read('SMTP_HOST'),
    port: Number(read('SMTP_PORT') ?? 587),
    /** Implicit TLS from the first byte (port 465). Otherwise STARTTLS is required before the password is sent. */
    secure: (read('SMTP_SECURE') ?? (read('SMTP_PORT') === '465' ? 'true' : 'false')) === 'true',
    user: read('SMTP_USER'),
    pass: read('SMTP_PASS'),
    from: read('MAIL_FROM') ?? read('SMTP_USER'),
  },
};

if (env.isProduction && env.jwtSecret === 'dev-only-change-me') {
  throw new Error('JWT_SECRET must be set to a real secret in production.');
}
