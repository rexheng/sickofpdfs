// PDFs and thumbnails in R2 (contracts §7 "Blobs"). One object per fingerprint at `pdf/<sha[0..2]>/<sha>.pdf`; aliases upload
// nothing. Only a document the server already holds (pushed with label 'learning', not forgotten) may have a file, so a
// receipt's bytes can never arrive here: its documents row was refused first.
//
//   up to 32 MiB   one PUT; R2 checks the bytes against the SHA-256 (the document id) and refuses a mismatch
//   above that     multipart through the Worker in 32 MiB parts. The parts are kept in `blob_upload`, so an upload cut off
//                  halfway resumes where it stopped, even after a restart. R2 cannot check a whole multipart object's SHA-256,
//                  so the size is checked here and every device re-hashes what it downloads (contracts §7).
// The Worker only streams bytes; it never reads or hashes a PDF itself (the free plan's 10 ms of CPU would not allow it).

import type { Env } from '../env';
import { blobKey, thumbKey } from './service';

export const PART_SIZE = 32 * 1024 * 1024;
export const MAX_BLOB = 1024 * 1024 * 1024; // spec: files over 1 GiB stay in Chrome's own viewer
const MAX_THUMB = 512 * 1024;

export class BlobError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410 | 411 | 413 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

interface DocRow {
  byte_size: number;
  blob_stored: number;
}

/** The document, or why there can be no file for it. */
export async function documentForFile(env: Env, sha: string): Promise<DocRow> {
  const [d, f] = await env.META.batch<Record<string, unknown>>([
    env.META.prepare('SELECT byte_size, blob_stored FROM documents WHERE id = ?').bind(sha),
    // forgotten, and not saved again since (a save after the Forget is a new reading)
    env.META.prepare('SELECT 1 AS x FROM forgotten f WHERE f.document_id = ? AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = f.document_id AND d.created_at > f.at)').bind(sha),
  ]);
  if (f?.results.length) throw new BlobError(410, 'forgotten', 'This document was forgotten.');
  const doc = d?.results[0] as unknown as DocRow | undefined;
  if (!doc) throw new BlobError(404, 'unknown_document', 'Push the document before its file.');
  return doc;
}

const markStored = (env: Env, sha: string) => env.META.prepare('UPDATE documents SET blob_stored = 1 WHERE id = ? AND blob_stored = 0').bind(sha).run();

function contentLength(req: Request): number {
  const v = req.headers.get('content-length');
  if (v === null || !/^\d+$/.test(v)) throw new BlobError(411, 'length_required', 'Send Content-Length.');
  return Number(v);
}

export async function headBlob(env: Env, sha: string): Promise<{ size: number } | null> {
  const o = await env.BLOBS.head(blobKey(sha));
  return o ? { size: o.size } : null;
}

export async function putBlob(env: Env, sha: string, req: Request): Promise<{ stored: true; existed: boolean }> {
  const doc = await documentForFile(env, sha);
  const len = contentLength(req);
  if (len > PART_SIZE) throw new BlobError(413, 'use_multipart', 'Files over 32 MiB upload in parts (POST …/multipart).');
  if (doc.byte_size > 0 && len !== doc.byte_size) throw new BlobError(422, 'size_mismatch', 'The file is not the size the document says.');
  if (await env.BLOBS.head(blobKey(sha))) {
    await markStored(env, sha);
    return { stored: true, existed: true };
  }
  if (!req.body) throw new BlobError(400, 'no_body', 'Send the file.');
  try {
    await env.BLOBS.put(blobKey(sha), req.body, { sha256: sha, httpMetadata: { contentType: 'application/pdf' } });
  } catch (e) {
    // R2 refuses bytes whose SHA-256 is not the document id
    throw new BlobError(422, 'hash_mismatch', `The file does not match its fingerprint (${e instanceof Error ? e.message.slice(0, 80) : 'refused'}).`);
  }
  await markStored(env, sha);
  return { stored: true, existed: false };
}

export async function getBlob(env: Env, sha: string, req: Request): Promise<Response | null> {
  const o = await env.BLOBS.get(blobKey(sha), { range: req.headers, onlyIf: req.headers });
  if (!o) return null;
  const h = new Headers({ 'content-type': 'application/pdf', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', etag: o.httpEtag });
  if (!('body' in o)) return new Response(null, { status: 304, headers: h });
  const r = o.range as { offset?: number; length?: number } | undefined;
  if (r && (r.offset !== undefined || r.length !== undefined) && req.headers.has('range')) {
    const offset = r.offset ?? 0;
    const length = r.length ?? o.size - offset;
    h.set('content-range', `bytes ${offset}-${offset + length - 1}/${o.size}`);
    h.set('content-length', String(length));
    return new Response(o.body, { status: 206, headers: h });
  }
  h.set('content-length', String(o.size));
  return new Response(o.body, { status: 200, headers: h });
}

// ─── Multipart ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface UploadRow {
  upload_id: string;
  part_size: number;
  byte_size: number;
  parts: string;
}
type Part = { partNumber: number; etag: string };

const partsOf = (u: UploadRow): Part[] => {
  try {
    return (JSON.parse(u.parts) as Part[]).sort((a, b) => a.partNumber - b.partNumber);
  } catch {
    return [];
  }
};

/** Starts an upload, or says where the one already in flight stopped. */
export async function startMultipart(env: Env, sha: string): Promise<{ done: true } | { uploadId: string; partSize: number; partCount: number; parts: Part[] }> {
  const doc = await documentForFile(env, sha);
  if (await env.BLOBS.head(blobKey(sha))) {
    await markStored(env, sha);
    return { done: true };
  }
  if (!(doc.byte_size > PART_SIZE) || doc.byte_size > MAX_BLOB) throw new BlobError(400, 'bad_size', 'Multipart is for files from 32 MiB to 1 GiB; send a smaller one in one PUT.');
  const existing = await env.META.prepare('SELECT upload_id, part_size, byte_size, parts FROM blob_upload WHERE sha256 = ?').bind(sha).first<UploadRow>();
  if (existing) return { uploadId: existing.upload_id, partSize: existing.part_size, partCount: Math.ceil(existing.byte_size / existing.part_size), parts: partsOf(existing) };
  const up = await env.BLOBS.createMultipartUpload(blobKey(sha), { httpMetadata: { contentType: 'application/pdf' } });
  await env.META.prepare("INSERT INTO blob_upload (sha256, upload_id, part_size, byte_size, parts, started_at) VALUES (?, ?, ?, ?, '[]', ?) ON CONFLICT(sha256) DO NOTHING")
    .bind(sha, up.uploadId, PART_SIZE, doc.byte_size, Date.now())
    .run();
  const row = await env.META.prepare('SELECT upload_id, part_size, byte_size, parts FROM blob_upload WHERE sha256 = ?').bind(sha).first<UploadRow>();
  if (row && row.upload_id !== up.uploadId) await up.abort().catch(() => undefined); // another start won the race
  const u = row ?? { upload_id: up.uploadId, part_size: PART_SIZE, byte_size: doc.byte_size, parts: '[]' };
  return { uploadId: u.upload_id, partSize: u.part_size, partCount: Math.ceil(u.byte_size / u.part_size), parts: partsOf(u) };
}

async function uploadRow(env: Env, sha: string): Promise<UploadRow> {
  const u = await env.META.prepare('SELECT upload_id, part_size, byte_size, parts FROM blob_upload WHERE sha256 = ?').bind(sha).first<UploadRow>();
  if (!u) throw new BlobError(404, 'no_upload', 'Start the upload first (POST …/multipart).');
  return u;
}

export async function putPart(env: Env, sha: string, partNumber: number, req: Request): Promise<Part> {
  await documentForFile(env, sha);
  const u = await uploadRow(env, sha);
  const count = Math.ceil(u.byte_size / u.part_size);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count) throw new BlobError(400, 'bad_part', `Parts are numbered 1 to ${count}.`);
  const expected = partNumber < count ? u.part_size : u.byte_size - u.part_size * (count - 1);
  if (contentLength(req) !== expected) throw new BlobError(422, 'bad_part_size', `Part ${partNumber} must be ${expected} bytes.`);
  if (!req.body) throw new BlobError(400, 'no_body', 'Send the part.');
  const part = await env.BLOBS.resumeMultipartUpload(blobKey(sha), u.upload_id).uploadPart(partNumber, req.body);
  // One statement, so two parts arriving at once both land in the list
  await env.META.prepare(
    "UPDATE blob_upload SET parts = (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(blob_upload.parts) WHERE json_extract(value, '$.partNumber') <> ?1 UNION ALL SELECT json_object('partNumber', ?1, 'etag', ?2))) WHERE sha256 = ?3",
  )
    .bind(partNumber, part.etag, sha)
    .run();
  return { partNumber, etag: part.etag };
}

export async function completeMultipart(env: Env, sha: string): Promise<{ stored: true }> {
  await documentForFile(env, sha);
  const u = await uploadRow(env, sha);
  const parts = partsOf(u);
  const count = Math.ceil(u.byte_size / u.part_size);
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !parts.some((p) => p.partNumber === n));
  if (missing.length) throw new BlobError(409, 'parts_missing', `Parts still missing: ${missing.slice(0, 20).join(', ')}.`);
  const object = await env.BLOBS.resumeMultipartUpload(blobKey(sha), u.upload_id).complete(parts);
  if (object.size !== u.byte_size) {
    await env.BLOBS.delete(blobKey(sha));
    await env.META.prepare('DELETE FROM blob_upload WHERE sha256 = ?').bind(sha).run();
    throw new BlobError(422, 'size_mismatch', 'The finished file is not the size the document says. Upload it again.');
  }
  await env.META.batch([env.META.prepare('UPDATE documents SET blob_stored = 1 WHERE id = ?').bind(sha), env.META.prepare('DELETE FROM blob_upload WHERE sha256 = ?').bind(sha)]);
  return { stored: true };
}

export async function abortMultipart(env: Env, sha: string): Promise<void> {
  const u = await env.META.prepare('SELECT upload_id FROM blob_upload WHERE sha256 = ?').bind(sha).first<{ upload_id: string }>();
  if (!u) return;
  await env.BLOBS.resumeMultipartUpload(blobKey(sha), u.upload_id).abort().catch(() => undefined);
  await env.META.prepare('DELETE FROM blob_upload WHERE sha256 = ?').bind(sha).run();
}

// ─── Thumbnails ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function putThumb(env: Env, sha: string, req: Request): Promise<void> {
  await documentForFile(env, sha);
  const len = contentLength(req);
  if (len > MAX_THUMB) throw new BlobError(413, 'too_large', 'A thumbnail is at most 512 KB.');
  const bytes = new Uint8Array(await req.arrayBuffer());
  const isWebp = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (!isWebp) throw new BlobError(400, 'not_webp', 'A thumbnail must be a WebP image.');
  await env.BLOBS.put(thumbKey(sha), bytes, { httpMetadata: { contentType: 'image/webp' } });
}

export async function getThumb(env: Env, sha: string): Promise<Response | null> {
  const o = await env.BLOBS.get(thumbKey(sha));
  if (!o) return null;
  return new Response(o.body, { headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
