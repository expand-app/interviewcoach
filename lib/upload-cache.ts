/**
 * IndexedDB cache for in-flight upload blobs.
 *
 * Why this exists: when a user clicks End on a long interview, the
 * resulting video can be 200-600 MB. Uploading that to S3 takes
 * 1-3 minutes on a typical home connection. If the user closes the
 * tab during that window — or the browser crashes, or the network
 * drops — the blob (which lived ONLY in browser memory) is gone
 * forever, and the saved session ends up with `video_s3_key = NULL`
 * on the database row. Audio is small enough to upload before the
 * user can click away; video is the failure mode we keep hitting.
 *
 * Strategy: BEFORE kicking off the S3 PUT, persist each segment blob
 * to IndexedDB keyed by `sessionId + segmentIndex`. The blob lives on
 * disk now — tab close, crash, navigate, all fine. After every
 * segment's S3 PUT succeeds, drop that segment from cache. After
 * concat completes, clear the rest. If anything goes wrong mid-flight,
 * the cache survives.
 *
 * On the next /app mount we list incomplete sessions and attempt
 * resume uploads (see app/app/page.tsx). The user sees their session
 * arrive eventually rather than discovering an audio-only row 24h
 * later.
 *
 * Schema:
 *   db: ic-uploads
 *   store: blobs (keyPath: id, where id = "${sessionId}::${kind}::${segmentIndex}")
 *   value: { id, sessionId, kind, segmentIndex, mime, blob, size, createdAt }
 *
 * Quota: most browsers allow 50%+ of free disk; 600MB is well
 * within tolerance. We rely on the browser to evict in LRU order if
 * pressure hits. New uploads will write fresh entries; resume on the
 * next load reads what's still there.
 */

const DB_NAME = "ic-uploads";
const DB_VERSION = 1;
const STORE = "blobs";

export type UploadKind = "audio" | "video";

export interface CachedBlobRecord {
  id: string;
  sessionId: string;
  kind: UploadKind;
  segmentIndex: number;
  mime: string;
  blob: Blob;
  size: number;
  createdAt: number;
}

function idFor(
  sessionId: string,
  kind: UploadKind,
  segmentIndex: number
): string {
  return `${sessionId}::${kind}::${segmentIndex}`;
}

/** Lazily open (or create) the database. The schema is created on
 *  the upgrade event the first time the DB doesn't exist. Subsequent
 *  opens hit the cached version with no upgrade. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        // Secondary index by sessionId so we can list/clear all
        // segments belonging to one session in a single cursor pass.
        store.createIndex("by_session", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let value: T | undefined;
    let invoked = false;
    Promise.resolve(fn(store))
      .then((v) => {
        value = v;
        invoked = true;
      })
      .catch(reject);
    tx.oncomplete = () => {
      if (invoked) resolve(value as T);
    };
    tx.onerror = () => reject(tx.error || new Error("IndexedDB tx failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB tx aborted"));
  });
}

/** Persist one segment blob. Idempotent — re-storing the same
 *  segmentIndex overwrites cleanly. Errors are surfaced (caller can
 *  decide to proceed without cache or abort). */
export async function cacheBlob(args: {
  sessionId: string;
  kind: UploadKind;
  segmentIndex: number;
  mime: string;
  blob: Blob;
}): Promise<void> {
  const record: CachedBlobRecord = {
    id: idFor(args.sessionId, args.kind, args.segmentIndex),
    sessionId: args.sessionId,
    kind: args.kind,
    segmentIndex: args.segmentIndex,
    mime: args.mime,
    blob: args.blob,
    size: args.blob.size,
    createdAt: Date.now(),
  };
  await withStore("readwrite", (store) => {
    return new Promise<void>((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(req.error || new Error("IndexedDB put failed"));
    });
  });
}

/** Drop one cached segment. Called after its S3 PUT succeeds so we
 *  free disk eagerly rather than waiting for the whole concat path. */
export async function removeCachedSegment(
  sessionId: string,
  kind: UploadKind,
  segmentIndex: number
): Promise<void> {
  await withStore("readwrite", (store) => {
    return new Promise<void>((resolve, reject) => {
      const req = store.delete(idFor(sessionId, kind, segmentIndex));
      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(req.error || new Error("IndexedDB delete failed"));
    });
  });
}

/** List all cached segments for one session. Returns them sorted by
 *  segmentIndex ASC so a resume caller can hand them straight to the
 *  multi-segment uploader. */
export async function getCachedSession(
  sessionId: string
): Promise<CachedBlobRecord[]> {
  return withStore("readonly", (store) => {
    return new Promise<CachedBlobRecord[]>((resolve, reject) => {
      const idx = store.index("by_session");
      const req = idx.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => {
        const rows = (req.result || []) as CachedBlobRecord[];
        rows.sort((a, b) => a.segmentIndex - b.segmentIndex);
        resolve(rows);
      };
      req.onerror = () =>
        reject(req.error || new Error("IndexedDB getAll failed"));
    });
  });
}

/** List unique sessionIds that still have cached blobs. Used at app
 *  mount to discover incomplete uploads from a previous tab. */
export async function listCachedSessionIds(): Promise<string[]> {
  return withStore("readonly", (store) => {
    return new Promise<string[]>((resolve, reject) => {
      const seen = new Set<string>();
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const v = cursor.value as CachedBlobRecord;
          seen.add(v.sessionId);
          cursor.continue();
        } else {
          resolve(Array.from(seen));
        }
      };
      req.onerror = () =>
        reject(req.error || new Error("IndexedDB cursor failed"));
    });
  });
}

/** Clear ALL cached blobs for one session. Called after a successful
 *  end-to-end upload (concat completed, server confirmed). */
export async function clearSessionCache(sessionId: string): Promise<void> {
  await withStore("readwrite", (store) => {
    return new Promise<void>((resolve, reject) => {
      const idx = store.index("by_session");
      const req = idx.openCursor(IDBKeyRange.only(sessionId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () =>
        reject(req.error || new Error("IndexedDB cursor failed"));
    });
  });
}

/** Sweep: clear cache entries older than the given threshold (default
 *  7 days). Belt-and-suspenders cleanup so the IndexedDB doesn't
 *  accumulate stale data from sessions whose resume eventually
 *  succeeded server-side or that the user abandoned. */
export async function pruneStale(
  maxAgeMs = 7 * 24 * 60 * 60 * 1000
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  return withStore("readwrite", (store) => {
    return new Promise<number>((resolve, reject) => {
      let removed = 0;
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const v = cursor.value as CachedBlobRecord;
          if (v.createdAt < cutoff) {
            cursor.delete();
            removed++;
          }
          cursor.continue();
        } else {
          resolve(removed);
        }
      };
      req.onerror = () =>
        reject(req.error || new Error("IndexedDB cursor failed"));
    });
  });
}
