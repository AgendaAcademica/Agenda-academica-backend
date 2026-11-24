import { createHash } from "node:crypto";
import {
  areNamesCompatible,
  buildCanonicalDisciplineKey,
  mergeAndDeduplicateEvents,
  normalizeAcademicTerm,
  normalizeDisciplineCode,
  normalizeDisciplineName,
  parseScheduleMetadata,
  selectionIdForKey,
  summarizeActivities,
  type ConsolidatedDiscipline
} from "../services/discipline-consolidation.js";
import { HttpError } from "../usage/types.js";
import type {
  AmbiguityResolution,
  AnalysisPreviewResponse,
  ConfirmAnalysisResponse,
  InclusionMode,
  PreviewDisciplineItem,
  PublishedDiscipline,
  UserQuotaStateResponse
} from "./types.js";

export type UserTermStateRecord = {
  term: string;
  consumedQuotaDisciplineKeys: string[];
  agendaDisciplinesByKey: Record<string, PublishedDiscipline>;
  updatedAt: string;
};

export type AnalysisBatchRecord = {
  analysisId: string;
  uid: string;
  status: "pending_confirmation" | "confirmed";
  termScope: string;
  createdAt: string;
  expiresAtMs: number;
  confirmedAt: string | null;
  confirmedSelectionHash: string | null;
  disciplines: ConsolidatedDiscipline[];
  confirmationResult: ConfirmAnalysisResponse | null;
};

export function emptyUserTermState(term: string): UserTermStateRecord {
  return {
    term,
    consumedQuotaDisciplineKeys: [],
    agendaDisciplinesByKey: {},
    updatedAt: ""
  };
}

function mergeEssentialFields(
  current: Pick<
    ConsolidatedDiscipline,
    "documentTitle" | "disciplineName" | "disciplineCode" | "term" | "professor" | "classroom" | "schedule" | "recommendedColorHex"
  >,
  previous?: PublishedDiscipline
) {
  if (!previous) {
    return {
      documentTitle: current.documentTitle,
      disciplineName: current.disciplineName,
      disciplineCode: current.disciplineCode,
      term: current.term,
      professor: current.professor,
      classroom: current.classroom,
      schedule: current.schedule,
      parsedSchedule: parseScheduleMetadata(current.schedule),
      recommendedColorHex: current.recommendedColorHex
    };
  }
  const pickText = (nextVal: string, prevVal: string) => (nextVal.trim() ? nextVal.trim() : prevVal.trim());
  const schedule = pickText(current.schedule, previous.schedule);
  const color =
    current.recommendedColorHex.toUpperCase() === "#2563EB" && previous.recommendedColorHex.toUpperCase() !== "#2563EB"
      ? previous.recommendedColorHex
      : current.recommendedColorHex || previous.recommendedColorHex || "#2563EB";
  return {
    documentTitle: pickText(current.documentTitle, previous.documentTitle),
    disciplineName: pickText(current.disciplineName, previous.disciplineName),
    disciplineCode: normalizeDisciplineCode(current.disciplineCode) ? current.disciplineCode : previous.disciplineCode,
    term: pickText(current.term, previous.term),
    professor: pickText(current.professor, previous.professor),
    classroom: pickText(current.classroom, previous.classroom),
    schedule,
    parsedSchedule: parseScheduleMetadata(schedule),
    recommendedColorHex: color
  };
}

export function buildPreviewResponse(
  batch: AnalysisBatchRecord,
  statesByTerm: ReadonlyMap<string, UserTermStateRecord>,
  limit: number,
  isUnlimited: boolean
): AnalysisPreviewResponse {
  const scopeState = statesByTerm.get(batch.termScope) ?? emptyUserTermState(batch.termScope);
  const used = scopeState.consumedQuotaDisciplineKeys.length;
  const remaining = Math.max(0, limit - used);

  const newCostByTerm = new Map<string, number>();
  let hasAmbiguous = false;

  const previewItems: PreviewDisciplineItem[] = batch.disciplines.map(discipline => {
    const state = statesByTerm.get(discipline.effectiveTerm) ?? emptyUserTermState(discipline.effectiveTerm);
    const previous = state.agendaDisciplinesByKey[discipline.disciplineKey];
    const essential = mergeEssentialFields(discipline, previous);
    const previouslyConfirmedMode: InclusionMode | null = previous?.inclusionMode ?? null;
    const alreadyCountedInQuota = state.consumedQuotaDisciplineKeys.includes(discipline.disciplineKey);
    const eligibleForFull = discipline.activities.hasExtractedActivities || previouslyConfirmedMode === "FULL";
    const quotaCostIfSelected = eligibleForFull && !alreadyCountedInQuota ? 1 : 0;

    if (discipline.consolidation.ambiguous) hasAmbiguous = true;
    newCostByTerm.set(discipline.effectiveTerm, (newCostByTerm.get(discipline.effectiveTerm) ?? 0) + quotaCostIfSelected);

    return {
      selectionId: discipline.selectionId,
      disciplineKey: discipline.disciplineKey,
      ...essential,
      consolidation: structuredClone(discipline.consolidation),
      activities: structuredClone(discipline.activities),
      quotaEligibility: {
        eligibleForFull,
        alreadyCountedInQuota,
        previouslyConfirmedMode,
        quotaCostIfSelected
      }
    };
  });

  let exceedsAnyTermQuota = false;
  if (!isUnlimited) {
    for (const [term, cost] of newCostByTerm.entries()) {
      const state = statesByTerm.get(term) ?? emptyUserTermState(term);
      const termRemaining = Math.max(0, limit - state.consumedQuotaDisciplineKeys.length);
      if (cost > termRemaining) {
        exceedsAnyTermQuota = true;
        break;
      }
    }
  }

  return {
    status: "PENDING_CONFIRMATION",
    termScope: batch.termScope,
    quota: {
      limit,
      used,
      remaining,
      isUnlimited,
      term: batch.termScope,
      selectionRequired: previewItems.length > 0 && (exceedsAnyTermQuota || hasAmbiguous)
    },
    disciplines: previewItems
  };
}

export function buildUserQuotaResponse(
  state: UserTermStateRecord,
  limit: number,
  isUnlimited: boolean
): UserQuotaStateResponse {
  const used = state.consumedQuotaDisciplineKeys.length;
  return {
    quota: {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      isUnlimited,
      term: state.term,
      selectionRequired: false
    },
    consumedDisciplineKeys: [...state.consumedQuotaDisciplineKeys],
    disciplines: Object.values(state.agendaDisciplinesByKey)
  };
}

function hashSelectionPayload(
  selectedDisciplineIds: string[],
  ambiguityResolutions: AmbiguityResolution[] | undefined
): string {
  const normalized = {
    selectedDisciplineIds: [...new Set(selectedDisciplineIds)].sort(),
    ambiguityResolutions: [...(ambiguityResolutions ?? [])]
      .map(r => ({
        selectionId: r.selectionId,
        action: r.action,
        targetSelectionId: r.targetSelectionId ?? null,
        overrideDisciplineCode: r.overrideDisciplineCode?.trim() ?? null,
        overrideTerm: r.overrideTerm ? normalizeAcademicTerm(r.overrideTerm) : null
      }))
      .sort((a, b) => a.selectionId.localeCompare(b.selectionId))
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function mergeIntoTargetDiscipline(target: ConsolidatedDiscipline, source: ConsolidatedDiscipline): void {
  const essential = mergeEssentialFields(
    target,
    {
      ...source,
      inclusionMode: "ESSENTIAL_ONLY",
      countsTowardsQuota: false,
      preservedFromPreviousConfirmation: false,
      omittedActivitiesCount: 0
    }
  );
  target.documentTitle = essential.documentTitle;
  target.disciplineName = essential.disciplineName;
  target.disciplineCode = essential.disciplineCode;
  target.term = essential.term;
  target.professor = essential.professor;
  target.classroom = essential.classroom;
  target.schedule = essential.schedule;
  target.parsedSchedule = essential.parsedSchedule;
  target.recommendedColorHex = essential.recommendedColorHex;
  target.events = mergeAndDeduplicateEvents(target.events, source.events);
  target.activities = summarizeActivities(target.events);
  target.consolidation.mergedSourcesCount += source.consolidation.mergedSourcesCount;
}

function hasActiveConflictWithAny(item: ConsolidatedDiscipline, others: ConsolidatedDiscipline[]): boolean {
  const code = normalizeDisciplineCode(item.disciplineCode);
  const name = normalizeDisciplineName(item.disciplineName);
  for (const other of others) {
    if (other.selectionId === item.selectionId) continue;
    const otherCode = normalizeDisciplineCode(other.disciplineCode);
    const otherName = normalizeDisciplineName(other.disciplineName);
    if (code && otherCode && code === otherCode && item.effectiveTerm !== other.effectiveTerm) return true;
    if (code && otherCode && code === otherCode && !areNamesCompatible(name, otherName)) return true;
    if (!code && !otherCode && item.effectiveTerm !== other.effectiveTerm && areNamesCompatible(name, otherName)) return true;
  }
  if (item.consolidation.ambiguityReason === "MULTIPLE_CANDIDATES_FOR_NAME") {
    const matching = others.filter(other => {
      if (other.selectionId === item.selectionId || other.effectiveTerm !== item.effectiveTerm) return false;
      return areNamesCompatible(name, normalizeDisciplineName(other.disciplineName));
    });
    return matching.length > 1;
  }
  return false;
}

export function executeConfirmation(params: {
  batch: AnalysisBatchRecord;
  uid: string;
  statesByTerm: ReadonlyMap<string, UserTermStateRecord>;
  selectedDisciplineIds: string[];
  ambiguityResolutions?: AmbiguityResolution[];
  limit: number;
  isUnlimited: boolean;
  nowMs: number;
  nowIso: string;
}): {
  idempotent: boolean;
  response: ConfirmAnalysisResponse;
  updatedBatch?: AnalysisBatchRecord;
  updatedStates?: UserTermStateRecord[];
} {
  const { batch, uid, statesByTerm, selectedDisciplineIds, ambiguityResolutions, limit, isUnlimited, nowMs, nowIso } = params;

  if (batch.uid !== uid) {
    throw new HttpError(403, "ACCESS_DENIED", "Esta conta não está autorizada para este recurso.");
  }

  if (batch.status === "pending_confirmation" && nowMs > batch.expiresAtMs) {
    throw new HttpError(404, "ANALYSIS_NOT_FOUND", "Análise não encontrada ou expirada. Realize uma nova importação.");
  }

  const selectionHash = hashSelectionPayload(selectedDisciplineIds, ambiguityResolutions);
  if (batch.status === "confirmed") {
    if (batch.confirmedSelectionHash === selectionHash && batch.confirmationResult) {
      return { idempotent: true, response: structuredClone(batch.confirmationResult) };
    }
    throw new HttpError(
      409,
      "ANALYSIS_ALREADY_CONFIRMED",
      "Esta análise já foi confirmada anteriormente com outra seleção."
    );
  }

  const working: ConsolidatedDiscipline[] = structuredClone(batch.disciplines);
  const workingById = new Map(working.map(d => [d.selectionId, d]));
  const redirectedIds = new Map<string, string>();
  const explicitlyKeptSeparate = new Set<string>();
  const resolvedSourceIds = new Set<string>();

  for (const resolution of ambiguityResolutions ?? []) {
    const source = workingById.get(resolution.selectionId);
    if (!source) {
      throw new HttpError(
        400,
        "INVALID_DISCIPLINE_SELECTION",
        "Uma ou mais disciplinas referenciadas na revisão não pertencem a esta análise."
      );
    }
    if (!source.consolidation.ambiguous) {
      throw new HttpError(
        400,
        "INVALID_AMBIGUITY_RESOLUTION",
        "A resolução informada refere-se a uma disciplina que não possui ambiguidade."
      );
    }
    if (resolution.action === "MERGE_WITH_TARGET") {
      if (!resolution.targetSelectionId || resolution.targetSelectionId === source.selectionId) {
        throw new HttpError(
          400,
          "INVALID_AMBIGUITY_RESOLUTION",
          "Informe uma disciplina de destino válida para consolidar."
        );
      }
      const target = workingById.get(resolution.targetSelectionId);
      if (!target || redirectedIds.has(target.selectionId)) {
        throw new HttpError(
          400,
          "INVALID_AMBIGUITY_RESOLUTION",
          "Disciplina de destino inválida para consolidação."
        );
      }
      mergeIntoTargetDiscipline(target, source);
      redirectedIds.set(source.selectionId, target.selectionId);
      resolvedSourceIds.add(source.selectionId);
      resolvedSourceIds.add(target.selectionId);
    } else {
      if (resolution.overrideDisciplineCode !== undefined) {
        source.disciplineCode = resolution.overrideDisciplineCode.trim();
      }
      if (resolution.overrideTerm !== undefined) {
        const normalizedTerm = normalizeAcademicTerm(resolution.overrideTerm);
        if (normalizedTerm) {
          source.effectiveTerm = normalizedTerm;
          source.term = normalizedTerm;
        }
      }
      source.disciplineKey = buildCanonicalDisciplineKey(
        source.effectiveTerm,
        source.disciplineCode,
        source.disciplineName
      );
      explicitlyKeptSeparate.add(source.selectionId);
      resolvedSourceIds.add(source.selectionId);
    }
  }

  const surviving = working.filter(d => !redirectedIds.has(d.selectionId));
  const survivingById = new Map(surviving.map(d => [d.selectionId, d]));

  const unresolvedAmbiguousIds: string[] = [];
  for (const discipline of surviving) {
    if (!discipline.consolidation.ambiguous) continue;
    const resolvedExplicitly = explicitlyKeptSeparate.has(discipline.selectionId);
    const stillConflicting = hasActiveConflictWithAny(discipline, surviving);
    if (!resolvedExplicitly && stillConflicting) {
      unresolvedAmbiguousIds.push(discipline.selectionId);
      continue;
    }
    if (!resolvedExplicitly && !stillConflicting) {
      discipline.disciplineKey = buildCanonicalDisciplineKey(
        discipline.effectiveTerm,
        discipline.disciplineCode,
        discipline.disciplineName
      );
    }
    discipline.consolidation.ambiguous = false;
    discipline.consolidation.ambiguityReason = null;
    discipline.consolidation.candidateKeys = [];
    discipline.consolidation.status = discipline.consolidation.mergedSourcesCount > 1 ? "CONSOLIDATED" : "SINGLE";
  }

  if (unresolvedAmbiguousIds.length > 0) {
    throw new HttpError(
      422,
      "AMBIGUOUS_DISCIPLINE_REQUIRES_REVIEW",
      "Há disciplinas com associação ambígua que precisam ser revisadas antes da confirmação.",
      { ambiguousSelectionIds: unresolvedAmbiguousIds }
    );
  }

  // Ensure distinct disciplineKeys among surviving items kept separate explicitly.
  const seenKeys = new Map<string, string>();
  for (const discipline of surviving) {
    const existingOwner = seenKeys.get(discipline.disciplineKey);
    if (existingOwner) {
      const normName = normalizeDisciplineName(discipline.disciplineName);
      discipline.disciplineKey = `${discipline.effectiveTerm}::CUSTOM::${normName || "item"}::${discipline.selectionId}`;
    }
    seenKeys.set(discipline.disciplineKey, discipline.selectionId);
  }

  const resolvedSelectedIds: string[] = [];
  for (const rawId of selectedDisciplineIds) {
    const mappedId = redirectedIds.get(rawId) ?? rawId;
    if (!survivingById.has(mappedId)) {
      throw new HttpError(
        400,
        "INVALID_DISCIPLINE_SELECTION",
        "Uma ou mais disciplinas selecionadas não pertencem a esta análise."
      );
    }
    resolvedSelectedIds.push(mappedId);
  }
  const selectedSet = new Set(resolvedSelectedIds);

  const nextStates = new Map<string, UserTermStateRecord>();
  const getMutableState = (term: string): UserTermStateRecord => {
    let state = nextStates.get(term);
    if (!state) {
      state = structuredClone(statesByTerm.get(term) ?? emptyUserTermState(term));
      nextStates.set(term, state);
    }
    return state;
  };
  getMutableState(batch.termScope);
  for (const d of surviving) getMutableState(d.effectiveTerm);

  const invalidNoActivities: string[] = [];
  for (const d of surviving) {
    if (!selectedSet.has(d.selectionId)) continue;
    const state = getMutableState(d.effectiveTerm);
    const previous = state.agendaDisciplinesByKey[d.disciplineKey];
    if (!d.activities.hasExtractedActivities && previous?.inclusionMode !== "FULL") {
      invalidNoActivities.push(d.selectionId);
    }
  }
  if (invalidNoActivities.length > 0) {
    throw new HttpError(
      422,
      "DISCIPLINE_HAS_NO_ACTIVITIES",
      "A disciplina selecionada possui apenas dados essenciais e não tem atividades extraídas para usar a cota de IA.",
      { invalidSelectionIds: invalidNoActivities }
    );
  }

  // Validate quota atomically across every affected term before mutating any state.
  for (const [term, state] of nextStates.entries()) {
    const existingKeys = new Set(state.consumedQuotaDisciplineKeys);
    const newKeys = new Set<string>();
    for (const d of surviving) {
      if (d.effectiveTerm !== term || !selectedSet.has(d.selectionId)) continue;
      if (!existingKeys.has(d.disciplineKey)) newKeys.add(d.disciplineKey);
    }
    const usedBefore = existingKeys.size;
    const requestedNew = newKeys.size;
    if (!isUnlimited && usedBefore + requestedNew > limit) {
      const remaining = Math.max(0, limit - usedBefore);
      throw new HttpError(
        422,
        "DISCIPLINE_QUOTA_EXCEEDED",
        `Você selecionou ${requestedNew} nova(s) disciplina(s) para extração completa, mas sua cota disponível no plano base é de ${remaining}.`,
        { quota: { limit, used: usedBefore, remaining, requestedNew, term } }
      );
    }
  }

  const scopeBeforeUsed = (statesByTerm.get(batch.termScope) ?? emptyUserTermState(batch.termScope))
    .consumedQuotaDisciplineKeys.length;

  const fullDisciplines: PublishedDiscipline[] = [];
  const essentialOnlyDisciplines: PublishedDiscipline[] = [];
  const allPublished: PublishedDiscipline[] = [];
  let preservedPreviousFullCount = 0;

  for (const d of surviving) {
    const state = getMutableState(d.effectiveTerm);
    const previous = state.agendaDisciplinesByKey[d.disciplineKey];
    const essential = mergeEssentialFields(d, previous);
    const isSelected = selectedSet.has(d.selectionId);

    let published: PublishedDiscipline;
    if (isSelected) {
      if (!state.consumedQuotaDisciplineKeys.includes(d.disciplineKey)) {
        state.consumedQuotaDisciplineKeys.push(d.disciplineKey);
      }
      const events = mergeAndDeduplicateEvents(
        previous?.inclusionMode === "FULL" ? previous.events : [],
        d.events
      );
      published = {
        selectionId: d.selectionId,
        disciplineKey: d.disciplineKey,
        inclusionMode: "FULL",
        countsTowardsQuota: true,
        preservedFromPreviousConfirmation: false,
        omittedActivitiesCount: 0,
        ...essential,
        events
      };
      fullDisciplines.push(published);
    } else if (previous?.inclusionMode === "FULL") {
      preservedPreviousFullCount++;
      published = {
        selectionId: d.selectionId,
        disciplineKey: d.disciplineKey,
        inclusionMode: "FULL",
        countsTowardsQuota: true,
        preservedFromPreviousConfirmation: true,
        omittedActivitiesCount: 0,
        ...essential,
        events: structuredClone(previous.events)
      };
      fullDisciplines.push(published);
    } else {
      published = {
        selectionId: d.selectionId,
        disciplineKey: d.disciplineKey,
        inclusionMode: "ESSENTIAL_ONLY",
        countsTowardsQuota: false,
        preservedFromPreviousConfirmation: false,
        omittedActivitiesCount: d.events.length,
        ...essential,
        events: []
      };
      essentialOnlyDisciplines.push(published);
    }

    state.agendaDisciplinesByKey[d.disciplineKey] = published;
    state.updatedAt = nowIso;
    allPublished.push(published);
  }

  const scopeAfterUsed = getMutableState(batch.termScope).consumedQuotaDisciplineKeys.length;
  const response: ConfirmAnalysisResponse = {
    analysisId: batch.analysisId,
    status: "CONFIRMED",
    confirmedAt: nowIso,
    quota: {
      limit,
      usedBefore: scopeBeforeUsed,
      consumedNow: scopeAfterUsed - scopeBeforeUsed,
      used: scopeAfterUsed,
      remaining: Math.max(0, limit - scopeAfterUsed),
      isUnlimited,
      term: batch.termScope
    },
    summary: {
      totalDisciplinesProcessed: allPublished.length,
      fullCount: fullDisciplines.length,
      essentialOnlyCount: essentialOnlyDisciplines.length,
      preservedPreviousFullCount,
      fullSelectionIds: fullDisciplines.map(d => d.selectionId),
      essentialOnlySelectionIds: essentialOnlyDisciplines.map(d => d.selectionId)
    },
    fullDisciplines,
    essentialOnlyDisciplines,
    disciplines: allPublished
  };

  const updatedBatch: AnalysisBatchRecord = {
    ...batch,
    status: "confirmed",
    confirmedAt: nowIso,
    confirmedSelectionHash: selectionHash,
    disciplines: surviving,
    confirmationResult: response
  };

  return {
    idempotent: false,
    response,
    updatedBatch,
    updatedStates: [...nextStates.values()]
  };
}

export function collectBatchTerms(
  batch: Pick<AnalysisBatchRecord, "termScope" | "disciplines">,
  ambiguityResolutions?: AmbiguityResolution[]
): string[] {
  const terms = new Set<string>([batch.termScope]);
  for (const discipline of batch.disciplines) terms.add(discipline.effectiveTerm);
  for (const resolution of ambiguityResolutions ?? []) {
    if (resolution.overrideTerm) {
      const normalized = normalizeAcademicTerm(resolution.overrideTerm);
      if (normalized) terms.add(normalized);
    }
  }
  return [...terms];
}

export function selectionIdFallback(disciplineKey: string): string {
  return selectionIdForKey(disciplineKey);
}
