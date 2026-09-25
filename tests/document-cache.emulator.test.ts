import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { CACHE_LEASE_MS, DOCUMENT_CACHE_COLLECTION, FirestoreDocumentCache } from "../src/services/document-cache.js";
import { extractedDocumentSchema } from "../src/schemas/academic.schema.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run only through the local Firestore emulator.");
const app = initializeApp({ projectId: "demo-agenda-usage" }, "document-cache-tests");
const db = getFirestore(app);
afterAll(async () => { await db.terminate(); await deleteApp(app); });
const value = extractedDocumentSchema.parse({ disciplines: [{ documentTitle: "Plano", disciplineName: "Cálculo" }] });

describe("Firestore document cache", () => {
  it("persists JSON across store recreation and atomically selects one owner", async () => {
    const key = randomUUID(); const store = new FirestoreDocumentCache(db);
    const results = await Promise.all([store.claim(key, "a", "v1"), store.claim(key, "b", "v1")]);
    expect(results.map(x => x.status).sort()).toEqual(["busy", "owned"]);
    const owner = results[0]!.status === "owned" ? "a" : "b";
    await store.complete(key, owner, value, 60_000);
    expect(await new FirestoreDocumentCache(db).claim(key, "c", "v1")).toEqual({ status: "hit", value });
    const row = (await db.collection(DOCUMENT_CACHE_COLLECTION).doc(key).get()).data()!;
    expect(JSON.parse(row.resultJson)).toEqual(value);
    expect(row.owner).toBeUndefined();
  });
  it("reclaims abandoned leases and fences stale writers and cleanup", async () => {
    let now = Date.now(); const store = new FirestoreDocumentCache(db, () => now); const key = randomUUID();
    expect((await store.claim(key, "old", "v1")).status).toBe("owned");
    now += CACHE_LEASE_MS + 1;
    expect((await store.claim(key, "new", "v1")).status).toBe("owned");
    await store.complete(key, "old", value, 60_000); await store.release(key, "old");
    expect((await store.claim(key, "other", "v1")).status).toBe("busy");
    await store.complete(key, "new", value, 60_000);
    expect((await store.claim(key, "reader", "v1")).status).toBe("hit");
  });
  it("expires results and replaces invalid cached JSON", async () => {
    let now = Date.now(); const store = new FirestoreDocumentCache(db, () => now); const key = randomUUID();
    await store.claim(key, "a", "v1"); await store.complete(key, "a", value, 10);
    now += 11;
    expect((await store.claim(key, "b", "v1")).status).toBe("owned");
    await store.release(key, "b");
    await db.collection(DOCUMENT_CACHE_COLLECTION).doc(key).set({ status: "ready", version: "v1", resultJson: '{"disciplines":[]}', expiresAt: Timestamp.fromMillis(now + 60_000) });
    expect((await store.claim(key, "c", "v1")).status).toBe("owned");
  });
  it("skips oversized results and leaves no pending lock", async () => {
    const key = randomUUID(); const store = new FirestoreDocumentCache(db);
    await store.claim(key, "a", "v1");
    const large = structuredClone(value); large.disciplines[0]!.documentTitle = "á".repeat(410_000);
    await store.complete(key, "a", large, 60_000);
    expect((await db.collection(DOCUMENT_CACHE_COLLECTION).doc(key).get()).exists).toBe(false);
  });
});
