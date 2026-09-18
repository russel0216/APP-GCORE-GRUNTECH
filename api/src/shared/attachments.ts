import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../env';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

/**
 * One attachment service for every module (model §7).
 *
 * Files are stored on disk under UPLOAD_DIR with a random name; the original
 * filename lives in the database. `capturedAt` is kept because report photos
 * are evidence — a progress or commissioning photo has to carry when it was
 * taken, not when it was uploaded.
 */

fs.mkdirSync(env.uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, env.uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
  'application/zip',
  'application/vnd.dwg',
  'image/vnd.dwg',
]);

export const upload = multer({
  storage,
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error(`File type ${file.mimetype} is not allowed`));
  },
});

export interface SaveAttachmentInput {
  entityType: string;
  entityId: string;
  file: Express.Multer.File;
  uploadedById: string;
  caption?: string;
  capturedAt?: Date;
}

export async function saveAttachment(input: SaveAttachmentInput) {
  return prisma.attachment.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      fileName: input.file.originalname,
      storedName: input.file.filename,
      mimeType: input.file.mimetype,
      size: input.file.size,
      caption: input.caption ?? null,
      capturedAt: input.capturedAt ?? null,
      uploadedById: input.uploadedById,
    },
  });
}

export function attachmentPath(storedName: string): string {
  // Guard against a stored name escaping the upload directory.
  const resolved = path.resolve(env.uploadDir, storedName);
  if (!resolved.startsWith(path.resolve(env.uploadDir))) {
    throw badRequest('Invalid attachment path');
  }
  return resolved;
}

export async function deleteAttachment(id: string): Promise<void> {
  const row = await prisma.attachment.findUnique({ where: { id } });
  if (!row) return;
  await prisma.attachment.delete({ where: { id } });
  try {
    fs.unlinkSync(attachmentPath(row.storedName));
  } catch {
    /* the row is gone; a stray file on disk is not worth failing the request */
  }
}
