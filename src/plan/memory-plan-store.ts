import {
  ANALYSIS_TTL_MS
} from "./firestore-plan-store.js";
import {
  buildPreviewResponse,
  buildUserQuotaResponse,
  emptyUserTermState,
  executeConfirmation,
  type AnalysisBatchRecord,
  type UserTermStateRecord
} from "./plan-engine.js";
import { HttpError } from "../usage/types.js";
import type { ConsolidatedDiscipline } from "../services/discipline-consolidation.js";
import type {
  AmbiguityResolution,
  AnalysisPreviewResponse,
  ConfirmAnalysisResponse,
  DisciplinePlanStore,
  UserQuotaStateResponse
} from "./types.js";

export class MemoryDisciplinePlanStore implements DisciplinePlanStore {
  readonly batches = new Map<string, AnalysisBatchRecord>();
  readonly userStates = new Map<string, UserTermStateRecord>();
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = ANALYSIS_TTL_MS
  ) {}

  private stateKey(uid: string, term: string): string {
    return `${uid}::${term}`;
  }

  private getStatesMap(uid: string, terms: string[]): Map<string, UserTermStateRecord> {
    const map = new Map<string, UserTermStateRecord>();
    for (const term of terms) {
      const existing = this.userStates.get(this.stateKey(uid, term));
      map.set(term, existing ? structuredClone(existing) : emptyUserTermState(term));
    }
    return map;
  }

  private async runExclusive<T>(action: () => Promise<T> | T): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async createPendingAnalysis(params: {
    analysisId: string;
    uid: string;
    createdAt: string;
    termScope: string;
    disciplines: ConsolidatedDiscipline[];
    limit: number;
    isUnlimited: boolean;
  }): Promise<AnalysisPreviewResponse> {
    return this.runExclusive(() => {
      const terms = new Set<string>([params.termScope, ...params.disciplines.map(d => d.effectiveTerm)]);
      const statesByTerm = this.getStatesMap(params.uid, [...terms]);
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
      this.batches.set(params.analysisId, batch);
      return buildPreviewResponse(batch, statesByTerm, params.limit, params.isUnlimited);
    });
  }

  async getAnalysisPreview(params: {
    analysisId: string;
    uid: string;
    limit: number;
    isUnlimited: boolean;
  }): Promise<AnalysisPreviewResponse | ConfirmAnalysisResponse> {
    return this.runExclusive(() => {
      const batch = this.batches.get(params.analysisId);
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
      const terms = new Set<string>([batch.termScope, ...batch.disciplines.map(d => d.effectiveTerm)]);
      const statesByTerm = this.getStatesMap(params.uid, [...terms]);
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
    return this.runExclusive(() => {
      const batch = this.batches.get(params.analysisId);
      if (!batch) {
        throw new HttpError(404, "ANALYSIS_NOT_FOUND", "Análise não encontrada ou expirada. Realize uma nova importação.");
      }
      const terms = new Set<string>([
        batch.termScope,
        ...batch.disciplines.map(d => d.effectiveTerm),
        ...(params.ambiguityResolutions?.map(r => r.overrideTerm).filter((t): t is string => Boolean(t)) ?? [])
      ]);
      const statesByTerm = this.getStatesMap(params.uid, [...terms]);
      const nowMs = this.now();
      const nowIso = params.now ?? new Date(nowMs).toISOString();
      const outcome = executeConfirmation({
        batch: structuredClone(batch),
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
          this.userStates.set(this.stateKey(params.uid, state.term), structuredClone(state));
        }
        this.batches.set(params.analysisId, structuredClone(outcome.updatedBatch));
      }
      return outcome.response;
    });
  }

  async getUserQuota(params: {
    uid: string;
    term: string;
    limit: number;
    isUnlimited: boolean;
  }): Promise<UserQuotaStateResponse> {
    return this.runExclusive(() => {
      const state = this.userStates.get(this.stateKey(params.uid, params.term)) ?? emptyUserTermState(params.term);
      return buildUserQuotaResponse(structuredClone(state), params.limit, params.isUnlimited);
    });
  }
}
