import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../env';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';
import type { ResolvedUser } from '../permissions/resolve';

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

/**
 * Drawing and model files, accepted by EXTENSION (2026-10-09, the CAD job
 * order): a browser sends a SketchUp model, and often an AutoCAD drawing, as
 * `application/octet-stream` or under a vendor type of its own, so a MIME
 * list cannot admit them without admitting everything. Each of these is a
 * document format a viewer opens, never something a browser would run.
 */
const CAD_EXTENSIONS = new Set([
  '.dwg', '.dxf', '.dwt', '.dwf', '.dwfx',
  '.skp', '.layout', '.skb',
  '.rvt', '.rfa', '.ifc', '.nwd', '.nwc',
  '.stp', '.step', '.igs', '.iges', '.stl', '.sat', '.x_t',
  '.3ds', '.obj', '.fbx', '.dae', '.max', '.blend',
  '.rar', '.7z',
]);

export function isCadFile(fileName: string): boolean {
  return CAD_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function accept(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (ALLOWED.has(file.mimetype) || isCadFile(file.originalname)) return cb(null, true);
  cb(new Error(`File type ${file.mimetype} is not allowed`));
}

export const upload = multer({
  storage,
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
  fileFilter: accept,
});

/** The same store with the CAD ceiling: a drawing or a model is many times the size of a photo. */
export const cadUpload = multer({
  storage,
  limits: { fileSize: env.maxCadUploadMb * 1024 * 1024 },
  fileFilter: accept,
});

/** Which uploads take the CAD ceiling: the files on a CAD job order, its revisions and its comments. */
export function isCadEntity(entityType: string): boolean {
  return entityType === 'cad_job_order' || entityType === 'cad_revision' || entityType === 'cad_comment';
}

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

/*
  Who may read, or add to, the files on a record.

  The attachment routes are generic — one pair of URLs for every entity type —
  so on their own they only know that the caller is signed in. That was enough
  while every attached record was one a colleague could open anyway; it stops
  being enough for an evaluation, a clearance or a training certificate, where
  the file IS the sensitive part. The module that owns such a record registers
  the same visibility rule its own detail route applies, and the attachment
  routes ask it before listing, serving or accepting a file. A type nobody
  registered keeps the old behaviour: any signed-in user.
*/
export type AttachmentGuard = (user: ResolvedUser, entityId: string) => Promise<boolean>;

const guards = new Map<string, AttachmentGuard>();

export function registerAttachmentGuard(entityType: string, guard: AttachmentGuard): void {
  guards.set(entityType, guard);
}

export async function mayAccessAttachments(
  user: ResolvedUser,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const guard = guards.get(entityType);
  if (!guard || user.isSuperAdmin) return true;
  return guard(user, entityId);
}
