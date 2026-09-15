import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { FirestoreUsageStore, COLLECTIONS } from "../src/usage/firestore-store.js";
import { limits } from "./support.js";
import type { Attempt, Operation } from "../src/usage/types.js";

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Run only through the local Firebase emulators.");
const projectId = "demo-agenda-usage";
const app = initializeApp({ projectId }, "usage-tests");
const db = getFirestore(app);
const store = new FirestoreUsageStore(db);
afterAll(async () => { await db.terminate(); await deleteApp(app); });
const op = (uid: string): Operation => ({ id: randomUUID(), uid, createdAt: "2026-09-14T12:00:00.000Z", status: "pending", cache: "miss", filesCount: 1, totalBytes: 20, durationMs: null, errorCode: null });
const attempt = (operation: Operation): Attempt => ({ id: randomUUID(), uid: operation.uid, operationId: operation.id, createdAt: operation.createdAt,
  provider: "gemini", requestedModel: "test", actualModel: null, status: "pending", usage: null, estimatedCostUsd: null, price: null,
  durationMs: null, providerRequestId: null, errorCode: null });

describe("Firestore persistence and atomic quotas", () => {
  it("admits only one simultaneous request for the last user slot", async () => {
    const uid = randomUUID();
    const results = await Promise.allSettled([store.reserveOperation(op(uid), { ...limits, userDailyRequests: 1 }), store.reserveOperation(op(uid), { ...limits, userDailyRequests: 1 })]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
  });
  it("preserves pending attempts across store recreation and settles only once", async () => {
    const operation = op(randomUUID()); await store.reserveOperation(operation, limits);
    const a = attempt(operation); await store.reserveAttempt(a, limits);
    const recreated = new FirestoreUsageStore(db);
    expect((await recreated.report("2026-09-14", "2026-09-15")).attempts.find(x => x.id === a.id)?.status).toBe("pending");
    a.status = "success"; a.estimatedCostUsd = 0.25;
    await Promise.all([store.finishAttempt(a), recreated.finishAttempt(a)]);
    const daily = await db.collection(COLLECTIONS.quotas).where("estimatedCostUsd", "==", 0.25).get();
    expect(daily.docs.length).toBeGreaterThanOrEqual(1);
    await expect(store.reserveAttempt(attempt(operation), { ...limits, userDailyUsd: 0.25 })).rejects.toMatchObject({ code: "USER_COST_LIMIT" });
  });
  it("enforces global attempt quota across users", async () => {
    const date = "2026-09-15T12:00:00.000Z";
    const a = { ...attempt(op(randomUUID())), createdAt: date };
    const b = { ...attempt(op(randomUUID())), createdAt: date };
    const results = await Promise.allSettled([store.reserveAttempt(a, { ...limits, globalDailyAttempts: 1 }), store.reserveAttempt(b, { ...limits, globalDailyAttempts: 1 })]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
  });
  it("allows Firebase token validation and denies client access to backend ledgers", async () => {
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=test`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${randomUUID()}@example.com`, password: "test-password-123", returnSecureToken: true })
    });
    const account = await response.json() as { idToken: string; localId: string };
    expect(response.ok).toBe(true);
    expect((await getAuth(app).verifyIdToken(account.idToken, true)).uid).toBe(account.localId);
    const operation = op(account.localId); await store.reserveOperation(operation, limits);
    const base = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/(default)/documents`;
    for (const collection of Object.values(COLLECTIONS)) {
      const read = await fetch(`${base}/${collection}`, { headers: { Authorization: `Bearer ${account.idToken}` } });
      expect(read.status).toBe(403);
      const write = await fetch(`${base}/${collection}?documentId=forged`, { method: "POST", headers: { Authorization: `Bearer ${account.idToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields: { estimatedCostUsd: { doubleValue: 0 } } }) });
      expect(write.status).toBe(403);
    }
    const anonymous = await fetch(`${base}/${COLLECTIONS.operations}/${operation.id}`);
    expect(anonymous.status).toBe(403);
    await getAuth(app).updateUser(account.localId, { disabled: true });
    await expect(getAuth(app).verifyIdToken(account.idToken, true)).rejects.toMatchObject({ code: "auth/user-disabled" });
  });
});
