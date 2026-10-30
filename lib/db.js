import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { defaultDb, migrate } from './model.js';

const DB_PATH = 'state/main.json';
const AUTH_PATH = 'state/gmail-auth.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path) {
  const r = await get(path, { access: 'private', useCache: false });
  if (!r) return { data: null, etag: null };
  if (r.statusCode !== 200) throw new Error(`Storage read failed (${r.statusCode})`);
  const text = await new Response(r.stream).text();
  return { data: JSON.parse(text), etag: r.blob.etag };
}

async function writeJson(path, data, etag) {
  const opts = { access: 'private', contentType: 'application/json', addRandomSuffix: false };
  if (etag) opts.ifMatch = etag;
  else opts.allowOverwrite = false;
  const res = await put(path, JSON.stringify(data), opts);
  return res.etag;
}

function isConflict(e) {
  return e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String(e && e.message));
}

export async function loadDb() {
  const { data, etag } = await readJson(DB_PATH);
  return { db: migrate(data || defaultDb()), etag };
}

// Read-modify-write with optimistic concurrency. `fn` may run more than once,
// so it must only change the db object (no external side effects).
export async function mutateDb(fn) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    const { db, etag } = await loadDb();
    const result = await fn(db);
    db.updatedAt = Date.now();
    try {
      await writeJson(DB_PATH, db, etag);
      return { db, result };
    } catch (e) {
      if (!isConflict(e)) throw e;
      lastErr = e;
      await sleep(80 * (i + 1) + Math.random() * 250);
    }
  }
  throw lastErr || new Error('Could not save changes, please retry');
}

export async function loadAuth() {
  const { data, etag } = await readJson(AUTH_PATH);
  return { auth: data, etag };
}

export async function mutateAuth(fn) {
  for (let i = 0; i < 6; i++) {
    const { auth, etag } = await loadAuth();
    const next = fn(auth ? { ...auth } : {});
    try {
      await writeJson(AUTH_PATH, next, etag);
      return next;
    } catch (e) {
      if (!isConflict(e)) throw e;
      await sleep(100 * (i + 1));
    }
  }
  throw new Error('Could not save Gmail connection');
}
