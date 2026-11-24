import { applicationDefault, cert, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { AppSecurity } from "../app.js";
import type { UsageConfig } from "./config.js";
import { FirestoreUsageStore } from "./firestore-store.js";
import { UsageService } from "./meter.js";
import { FirestoreDocumentCache } from "../services/document-cache.js";
import { FirestoreDisciplinePlanStore } from "../plan/firestore-plan-store.js";

export function createFirebaseSecurity(config: UsageConfig): AppSecurity & { documentCache: FirestoreDocumentCache } {
  const credential = config.FIREBASE_SERVICE_ACCOUNT_JSON
    ? cert(JSON.parse(config.FIREBASE_SERVICE_ACCOUNT_JSON) as ServiceAccount) : applicationDefault();
  const app = initializeApp({ credential, projectId: config.FIREBASE_PROJECT_ID });
  const db = getFirestore(app, config.FIRESTORE_DATABASE_ID);
  return {
    documentCache: new FirestoreDocumentCache(db),
    verifyToken: token => getAuth(app).verifyIdToken(token, true),
    unlimitedEmails: config.unlimitedEmails, admins: config.admins,
    usage: new UsageService(new FirestoreUsageStore(db), config.limits, config.prices),
    maxConcurrentExtractions: config.MAX_CONCURRENT_EXTRACTIONS,
    maxUploadTotalMb: config.MAX_UPLOAD_TOTAL_MB,
    planStore: new FirestoreDisciplinePlanStore(db)
  };
}
