import { z } from "zod";
import type { ExtractedEvent } from "../schemas/academic.schema.js";
import type {
  ActivitiesSummary,
  ConsolidatedDiscipline,
  ConsolidationInfo,
  ParsedSchedule
} from "../services/discipline-consolidation.js";

export const ambiguityResolutionSchema = z.object({
  selectionId: z.string().min(1),
  action: z.enum(["MERGE_WITH_TARGET", "KEEP_SEPARATE"]),
  targetSelectionId: z.string().min(1).optional(),
  overrideDisciplineCode: z.string().optional(),
  overrideTerm: z.string().optional()
});
export type AmbiguityResolution = z.infer<typeof ambiguityResolutionSchema>;

export const confirmAnalysisRequestSchema = z.object({
  selectedDisciplineIds: z.array(z.string().min(1)).max(100),
  ambiguityResolutions: z.array(ambiguityResolutionSchema).optional()
});
export type ConfirmAnalysisRequest = z.infer<typeof confirmAnalysisRequestSchema>;

export type InclusionMode = "FULL" | "ESSENTIAL_ONLY";

export type QuotaSummary = {
  limit: number;
  used: number;
  remaining: number;
  isUnlimited: boolean;
  term: string;
  selectionRequired: boolean;
};

export type PreviewDisciplineItem = {
  selectionId: string;
  disciplineKey: string;
  documentTitle: string;
  disciplineName: string;
  disciplineCode: string;
  term: string;
  professor: string;
  classroom: string;
  schedule: string;
  parsedSchedule: ParsedSchedule;
  recommendedColorHex: string;
  consolidation: ConsolidationInfo;
  activities: ActivitiesSummary;
  quotaEligibility: {
    eligibleForFull: boolean;
    alreadyCountedInQuota: boolean;
    previouslyConfirmedMode: InclusionMode | null;
    quotaCostIfSelected: number;
  };
};

export type AnalysisPreviewResponse = {
  status: "PENDING_CONFIRMATION";
  termScope: string;
  quota: QuotaSummary;
  disciplines: PreviewDisciplineItem[];
};

export type PublishedDiscipline = {
  selectionId: string;
  disciplineKey: string;
  inclusionMode: InclusionMode;
  countsTowardsQuota: boolean;
  preservedFromPreviousConfirmation: boolean;
  omittedActivitiesCount: number;
  documentTitle: string;
  disciplineName: string;
  disciplineCode: string;
  term: string;
  professor: string;
  classroom: string;
  schedule: string;
  parsedSchedule: ParsedSchedule;
  recommendedColorHex: string;
  events: ExtractedEvent[];
};

export type ConfirmAnalysisResponse = {
  analysisId: string;
  status: "CONFIRMED";
  confirmedAt: string;
  quota: {
    limit: number;
    usedBefore: number;
    consumedNow: number;
    used: number;
    remaining: number;
    isUnlimited: boolean;
    term: string;
  };
  summary: {
    totalDisciplinesProcessed: number;
    fullCount: number;
    essentialOnlyCount: number;
    preservedPreviousFullCount: number;
    fullSelectionIds: string[];
    essentialOnlySelectionIds: string[];
  };
  fullDisciplines: PublishedDiscipline[];
  essentialOnlyDisciplines: PublishedDiscipline[];
  disciplines: PublishedDiscipline[];
};

export type UserQuotaStateResponse = {
  quota: QuotaSummary;
  consumedDisciplineKeys: string[];
  disciplines: PublishedDiscipline[];
};

export interface DisciplinePlanStore {
  createPendingAnalysis(params: {
    analysisId: string;
    uid: string;
    createdAt: string;
    termScope: string;
    disciplines: ConsolidatedDiscipline[];
    limit: number;
    isUnlimited: boolean;
  }): Promise<AnalysisPreviewResponse>;

  getAnalysisPreview(params: {
    analysisId: string;
    uid: string;
    limit: number;
    isUnlimited: boolean;
  }): Promise<AnalysisPreviewResponse | ConfirmAnalysisResponse>;

  confirmAnalysis(params: {
    analysisId: string;
    uid: string;
    selectedDisciplineIds: string[];
    ambiguityResolutions?: AmbiguityResolution[];
    limit: number;
    isUnlimited: boolean;
    now?: string;
  }): Promise<ConfirmAnalysisResponse>;

  getUserQuota(params: {
    uid: string;
    term: string;
    limit: number;
    isUnlimited: boolean;
  }): Promise<UserQuotaStateResponse>;
}
