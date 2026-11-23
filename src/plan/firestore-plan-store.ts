import { createHash } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { HttpError } from "../usage/types.js";
import type { ConsolidatedDiscipline } from "../services/discipline-consolidation.js";
import {
  buildPreviewResponse,
  buildUserQuotaResponse,
  collectBatchTerms,
  emptyUserTermState,
  executeConfirmation,
  type AnalysisBatchRecord,
  type UserTermStateRecord
} from "./plan-engine.js";
import type {
  AmbiguityResolution,
  AnalysisPreviewResponse,
  ConfirmAnalysisResponse,
  DisciplinePlanStore,
  UserQuotaStateResponse
} from "./types.js";

export const PLAN_COLLECTIONS = {
  batches: "backendAnalysisBatches",
  userStates: "backendUserDisciplineStates"
} as const;

export const ANALYSIS_TTL_MS = 7 * 86_400_000;

const uidKey = (uid: string) => createHash("sha256").update(uid).digest("hex");
const termKey = (term: string) =>
  `${term.replace(/[^a-zA-Z0-9_-]/g, "_")}_${createHash("sha256").update(term).digest("hex").slice(0, 8)}`;
const stateDocId = (uid: string, term: string) => `user-${uidKey(uid)}-${termKey(term)}`;

async function storageAccess<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      "PLAN_STORAGE_UNAVAILABLE",
      "O armazenamento do plano acadêmico está temporariamente indisponível. Tente novamente mais tarde."
    );
  }
}

function deserializeState(term: string, raw: FirebaseFirestore.DocumentData | undefined): UserTermStateRecord {
  if (!raw) return emptyUserTermState(term);
  return {
    term: typeof raw.term === "string" && raw.term ? raw.term : term,
    consumedQuotaDisciplineKeys: Array.isArray(raw.consumedQuotaDisciplineKeys)
      ? raw.consumedQuotaDisciplineKeys.filter((item): item is string => typeof item === "string")
      : [],
    agendaDisciplinesByKey:
      typeof raw.agendaDisciplinesJson === "string"
        ? (JSON.parse(raw.agendaDisciplinesJson) as UserTermStateRecord["agendaDisciplinesByKey"])
        : {},
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : ""
  };
}

function serializeState(uid: string, state: UserTermStateRecord) {
  return {
    uidHash: uidKey(uid),
    term: state.term,
    consumedQuotaDisciplineKeys: state.consumedQuotaDisciplineKeys,
    agendaDisciplinesJson: JSON.stringify(state.agendaDisciplinesByKey),
    updatedAt: state.updatedAt
  };
}

function deserializeBatch(raw: FirebaseFirestore.DocumentData | undefined): AnalysisBatchRecord | null {
  if (!raw || typeof raw.analysisId !== "string" || typeof raw.uid !== "string") return null;
  const expiresAtMs =
    raw.expiresAt instanceof Timestamp
      ? raw.expiresAt.toMillis()
      : typeof raw.expiresAtMs === "number"
        ? raw.expiresAtMs
        : 0;
  return {
    analysisId: raw.analysisId,
    uid: raw.uid,
    status: raw.status === "confirmed" ? "confirmed" : "pending_confirmation",
    termScope: typeof raw.termScope === "string" ? raw.termScope : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    expiresAtMs,
    confirmedAt: typeof raw.confirmedAt === "string" ? raw.confirmedAt : null,
    confirmedSelectionHash: typeof raw.confirmedSelectionHash === "string" ? raw.confirmedSelectionHash : null,
    disciplines:
      typeof raw.disciplinesJson === "string" ? (JSON.parse(raw.disciplinesJson) as ConsolidatedDiscipline[]) : [],
    confirmationResult:
      typeof raw.confirmationResultJson === "string"
        ? (JSON.parse(raw.confirmationResultJson) as ConfirmAnalysisResponse)
        : null
  };
}

function serializeBatch(batch: AnalysisBatchRecord) {
  return {
    analysisId: batch.analysisId,
    uid: batch.uid,
    status: batch.status,
    termScope: batch.termScope,
    createdAt: batch.createdAt,
    expiresAt: Timestamp.fromMillis(batch.expiresAtMs),
    confirmedAt: batch.confirmedAt,
    confirmedSelectionHash: batch.confirmedSelectionHash,
    disciplinesJson: JSON.stringify(batch.disciplines),
    confirmationResultJson: batch.confirmationResult ? JSON.stringify(batch.confirmationResult) : null
  };
}

export class FirestoreDisciplinePlanStore implements DisciplinePlanStore {
  constructor(
    private readonly db: Firestore,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = ANALYSIS_TTL_MS
  ) {}

  async createPendingAnalysis(params: {
    analysisId: string;
    uid: string;
    createdAt: string;
    termScope: string;
    disciplines: ConsolidatedDiscipline[];
    limit: number;
    isUnlimited: boolean;
  }): Promise<AnalysisPreviewResponse> {
    return storageAccess(() =>
      this.db.runTransaction(async tx => {
        const terms = collectBatchTerms({ termScope: params.termScope, disciplines: params.disciplines });
        const stateRefs = terms.map(term =>
          this.db.collection(PLAN_COLLECTIONS.userStates).doc(stateDocId(params.uid, term))
        );
        const snapshots = await tx.getAll(...stateRefs);
        const statesByTerm = new Map<string, UserTermStateRecord>();
        terms.forEach((term, idx) => {
          statesByTerm.set(term, deserializeState(term, snapshots[idx]?.data()));
        });

        const batch: AnalysisBatchRecord = {
          analysisId: params.analysisId,
          uid: params.uid,
          status: "pending_confirmation",
          termScope: params.termScope,
          createdAt: params.createdAt,
          expiresAtMs: this.now() + this.ttlMs,
          confirmedAt: null,
          confirmedSelectionHash: null,
          disciplines: structuredClone(params.disciplines),
          confirmationResult: null
        };
        const batchRef = this.db.collection(PLAN_COLLECTIONS.batches).doc(params.analysisId);
        tx.set(batchRef, serializeBatch(batch));

        return buildPreviewResponse(batch, statesByTerm, params.limit, params.isUnlimited);
      })
    );
  }

  async getAnalysisPreview(params: {
    analysisId: string;
    uid: string;
    limit: number;
    isUnlimited: boolean;
  }): Promise<AnalysisPreviewResponse | ConfirmAnalysisResponse> {
    return storageAccess(async () => {
      const batchSnap = await this.db.collection(PLAN_COLLECTIONS.batches).doc(params.analysisId).get();
      const batch = deserializeBatch(batchSnap.data());
      if (!batch) {
        throw new HttpError(404, "ANALYSIS_NOT_FOUND", "Análise não encontrada ou expirada. Realize uma nova importação.");
      }
      if (batch.uid !== params.uid) {
        throw new HttpError(403, "ACCESS_DENIED", "Esta conta não está autorizada para este recurso.");
      }
      if (batch.status === "confirmed" && batch.confirmationResult) {
        return structuredClone(batch.confirmationResult);
      }
      if (this.now() > batch.expiresAtMs) {
        throw new HttpError(404, "ANALYSIS_NOT_FOUND", "Análise não encontrada ou expirada. Realize uma nova importação.");
      }
      const terms = collectBatchTerms(batch);
      const stateRefs = terms.map(term =>
        this.db.collection(PLAN_COLLECTIONS.userStates).doc(stateDocId(params.uid, term))
      );
      const snapshots = await this.db.getAll(...stateRefs);
      const statesByTerm = new Map<string, UserTermStateRecord>();
      terms.forEach((term, idx) => {
        statesByTerm.set(term, deserializeState(term, snapshots[idx]?.data()));
      });
      return buildPreviewResponse(batch, statesByTerm, params.limit, params.isUnlimited);
    });
  }

  async confirmAnalysis(params: {
    analysisId: string;
    uid: string;
    selectedDisciplineIds: string[];
    ambiguityResolutions?: AmbiguityResolution[];
    limit: number;
    isUnlimited: boolean;
    now?: string;
  }): Promise<ConfirmAnalysisResponse> {
    return storageAccess(() =>
      this.db.runTransaction(async tx => {
        const batchRef = this.db.collection(PLAN_COLLECTIONS.batches).doc(params.analysisId);
        const batchSnap = await tx.get(batchRef);
        const batch = deserializeBatch(batchSnap.data());
        if (!batch) {
          throw new HttpError(
            404,
            "ANALYSIS_NOT_FOUND",
            "Análise não encontrada ou expirada. Realize uma nova importação."
          );
        }
        const terms = collectBatchTerms(batch, params.ambiguityResolutions);
        const stateRefs = terms.map(term =>
          this.db.collection(PLAN_COLLECTIONS.userStates).doc(stateDocId(params.uid, term))
        );
        const stateSnaps = await tx.getAll(...stateRefs);
        const statesByTerm = new Map<string, UserTermStateRecord>();
        terms.forEach((term, idx) => {
          statesByTerm.set(term, deserializeState(term, stateSnaps[idx]?.data()));
        });

        const nowMs = this.now();
        const nowIso = params.now ?? new Date(nowMs).toISOString();
        const outcome = executeConfirmation({
          batch,
          uid: params.uid,
          statesByTerm,
          selectedDisciplineIds: params.selectedDisciplineIds,
          ambiguityResolutions: params.ambiguityResolutions,
          limit: params.limit,
          isUnlimited: params.isUnlimited,
          nowMs,
          nowIso
        });

        if (!outcome.idempotent && outcome.updatedBatch && outcome.updatedStates) {
          for (const state of outcome.updatedStates) {
            const ref = this.db.collection(PLAN_COLLECTIONS.userStates).doc(stateDocId(params.uid, state.term));
            tx.set(ref, serializeState(params.uid, state));
          }
          tx.set(batchRef, serializeBatch(outcome.updatedBatch));
        }

        return outcome.response;
      })
    );
  }

  async getUserQuota(params: {
    uid: string;
    term: string;
    limit: number;
    isUnlimited: boolean;
  }): Promise<UserQuotaStateResponse> {
    return storageAccess(async () => {
      const ref = this.db.collection(PLAN_COLLECTIONS.userStates).doc(stateDocId(params.uid, params.term));
      const snap = await ref.get();
      const state = deserializeState(params.term, snap.data());
      return buildUserQuotaResponse(state, params.limit, params.isUnlimited);
    });
  }
}
