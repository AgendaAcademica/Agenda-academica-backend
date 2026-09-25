import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { HttpError, type Attempt, type Operation, type Report, type UsageLimits, type UsageStore } from "./types.js";

export const COLLECTIONS = { operations: "backendUsageOperations", attempts: "backendUsageAttempts", quotas: "backendUsageQuotas" } as const;
const uidKey = (uid: string) => createHash("sha256").update(uid).digest("hex");
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
function check(value: number, max: number, code: string) {
  if (value >= max) throw new HttpError(429, code, "O limite de uso foi atingido. Aguarde a renovação da cota ou contate o administrador.");
}
export class FirestoreUsageStore implements UsageStore {
  constructor(private readonly db: Firestore) {}
  private daily(uid: string, date: string) {
    return [this.db.collection(COLLECTIONS.quotas).doc(`user-${uidKey(uid)}-${date.slice(0, 10)}`),
      this.db.collection(COLLECTIONS.quotas).doc(`global-${date.slice(0, 10)}`)] as const;
  }
  async reserveOperation(operation: Operation, limits: UsageLimits) {
    const [userRef, globalRef] = this.daily(operation.uid, operation.createdAt);
    const minute = operation.createdAt.slice(0, 16);
    const operationRef = this.db.collection(COLLECTIONS.operations).doc(operation.id);
    await this.db.runTransaction(async tx => {
      const [user, global, existing] = await tx.getAll(userRef, globalRef, operationRef);
      if (existing!.exists) return; // Safe to retry an uncertain transaction commit.
      const u = user!.data() ?? {}, g = global!.data() ?? {};
      const minuteCount = u.minute === minute ? number(u.minuteCount) : 0;
      const charge = operation.cache === "miss" ? 1 : 0;
      if (charge) {
        check(number(u.requests), limits.userDailyRequests, "USER_DAILY_QUOTA");
        check(number(g.requests), limits.globalDailyRequests, "GLOBAL_DAILY_QUOTA");
      }
      check(minuteCount, limits.userRequestsPerMinute, "USER_RATE_LIMIT");
      tx.set(userRef, { requests: number(u.requests) + charge, minute, minuteCount: minuteCount + 1 }, { merge: true });
      tx.set(globalRef, { requests: number(g.requests) + charge }, { merge: true });
      tx.create(operationRef, operation);
    });
  }
  async finishOperation(id: string, result: Pick<Operation, "status" | "cache" | "durationMs" | "errorCode">) {
    await this.db.collection(COLLECTIONS.operations).doc(id).update(result);
  }
  async reserveAttempt(attempt: Attempt, limits: UsageLimits) {
    const [userRef, globalRef] = this.daily(attempt.uid, attempt.createdAt);
    const ref = this.db.collection(COLLECTIONS.attempts).doc(attempt.id);
    await this.db.runTransaction(async tx => {
      const [user, global, existing] = await tx.getAll(userRef, globalRef, ref);
      if (existing!.exists) return;
      const u = user!.data() ?? {}, g = global!.data() ?? {};
      check(number(u.attempts), limits.userDailyAttempts, "USER_AI_QUOTA");
      check(number(g.attempts), limits.globalDailyAttempts, "GLOBAL_AI_QUOTA");
      check(number(u.estimatedCostUsd), limits.userDailyUsd, "USER_COST_LIMIT");
      check(number(g.estimatedCostUsd), limits.globalDailyUsd, "GLOBAL_COST_LIMIT");
      tx.set(userRef, { attempts: number(u.attempts) + 1 }, { merge: true });
      tx.set(globalRef, { attempts: number(g.attempts) + 1 }, { merge: true });
      // Pending records survive restarts; unknown outcomes remain visible for reconciliation.
      tx.create(ref, attempt);
    });
  }
  async finishAttempt(attempt: Attempt) {
    const [userRef, globalRef] = this.daily(attempt.uid, attempt.createdAt);
    const ref = this.db.collection(COLLECTIONS.attempts).doc(attempt.id);
    await this.db.runTransaction(async tx => {
      const [existing, user, global] = await tx.getAll(ref, userRef, globalRef);
      if (!existing!.exists) throw new Error("Missing attempt reservation");
      if (existing!.data()!.status !== "pending") return;
      for (const [snapshot, dailyRef] of [[user!, userRef], [global!, globalRef]] as const) {
        const data = snapshot.data() ?? {};
        tx.set(dailyRef, { estimatedCostUsd: number(data.estimatedCostUsd) + (attempt.estimatedCostUsd ?? 0),
          unknownCostAttempts: number(data.unknownCostAttempts) + (attempt.estimatedCostUsd === null ? 1 : 0) }, { merge: true });
      }
      tx.set(ref, attempt);
    });
  }
  async report(from: string, to: string): Promise<Report> {
    // Single-field range queries use the default createdAt index in Standard/native mode.
    // This adapter targets the Core API already used by the Android app; confirm database edition before deployment.
    const read = (collection: string) => this.db.collection(collection).where("createdAt", ">=", from)
      .where("createdAt", "<", to).orderBy("createdAt").limit(10_001).get();
    const [operations, attempts] = await Promise.all([read(COLLECTIONS.operations), read(COLLECTIONS.attempts)]);
    if (operations.size > 10_000 || attempts.size > 10_000)
      throw new HttpError(422, "REPORT_TOO_LARGE", "Há muitos registros. Reduza o período do relatório.");
    return { operations: operations.docs.map(d => d.data() as Operation), attempts: attempts.docs.map(d => d.data() as Attempt) };
  }
}
