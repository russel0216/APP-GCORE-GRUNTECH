import { PrismaClient } from '@prisma/client';
import { env } from './env';

export const prisma = new PrismaClient({
  log: env.isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export async function connectDb(retries = 5, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(
        `DB connection attempt ${attempt}/${retries} failed, retrying in ${delayMs / 1000}s…`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
