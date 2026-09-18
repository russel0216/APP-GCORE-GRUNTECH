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

export const env = {
  nodeEnv: read('NODE_ENV') ?? 'development',
  isProduction: read('NODE_ENV') === 'production',
  port: Number(read('PORT') ?? 5100),
  databaseUrl: required('DATABASE_URL', 'postgresql://gcore:gcore@localhost:5433/gcore'),
  jwtSecret: required('JWT_SECRET', 'dev-only-change-me'),
  jwtExpiresIn: read('JWT_EXPIRES_IN') ?? '12h',
  uploadDir: read('UPLOAD_DIR') ?? path.resolve(__dirname, '..', 'uploads'),
  maxUploadMb: Number(read('MAX_UPLOAD_MB') ?? 25),
  corsOrigin: (read('CORS_ORIGIN') ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
};

if (env.isProduction && env.jwtSecret === 'dev-only-change-me') {
  throw new Error('JWT_SECRET must be set to a real secret in production.');
}
