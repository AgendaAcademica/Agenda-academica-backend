import { createHash } from "node:crypto";
import type { ActivityType, ExtractedEvent, ExtractedSyllabus, Priority } from "../schemas/academic.schema.js";

export type ParsedSchedule = {
  daysOfWeek: string[];
  timeRanges: string[];
};

export type AmbiguityReason =
  | "CONFLICTING_NAME_FOR_SAME_CODE"
  | "MULTIPLE_CANDIDATES_FOR_NAME"
  | "DIFFERENT_ACADEMIC_TERMS";

export type ConsolidationInfo = {
  status: "SINGLE" | "CONSOLIDATED" | "AMBIGUOUS";
  mergedSourcesCount: number;
  ambiguous: boolean;
  ambiguityReason: AmbiguityReason | null;
  candidateKeys: string[];
};

export type ActivitiesSummary = {
  hasExtractedActivities: boolean;
  totalCount: number;
  evaluativeCount: number;
  countsByType: Partial<Record<ActivityType, number>>;
};

export type ConsolidatedDiscipline = {
  selectionId: string;
  disciplineKey: string;
  effectiveTerm: string;
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
  events: ExtractedEvent[];
};

const CODE_PLACEHOLDERS = new Set(["", "NA", "NONE", "NULL", "SEM", "SEMCODIGO", "SN"]);
const STOPWORDS = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "as", "os", "em", "para", "com"]);
const PRIORITY_RANK: Record<Priority, number> = { BAIXA: 1, MEDIA: 2, ALTA: 3, URGENTE: 4 };
const DEFAULT_COLOR = "#2563EB";

const DAY_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "Segunda", regex: /\bseg(?:unda(?:-feira)?)?\b/g },
  { label: "Terça", regex: /\bter(?:ca(?:-feira)?)?\b/g },
  { label: "Quarta", regex: /\bqua(?:rta(?:-feira)?)?\b/g },
  { label: "Quinta", regex: /\bqui(?:nta(?:-feira)?)?\b/g },
  { label: "Sexta", regex: /\bsex(?:ta(?:-feira)?)?\b/g },
  { label: "Sábado", regex: /\bsab(?:ado)?\b/g },
  { label: "Domingo", regex: /\bdom(?:ingo)?\b/g }
];

export function normalizeDisciplineCode(code: string): string {
  const cleaned = code.trim().toUpperCase().replace(/[\s._/-]+/g, "");
  return CODE_PLACEHOLDERS.has(cleaned) ? "" : cleaned;
}

export function normalizeDisciplineName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeAcademicTerm(term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return "";
  const normalized = trimmed.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const yearFirst = normalized.match(/^(\d{4})\s*[-/._\s]+\s*0?([12])(?:\s*[ºo°]?\s*(?:semestre|periodo))?$/i);
  if (yearFirst) return `${yearFirst[1]}/${yearFirst[2]}`;
  const semFirst = normalized.match(/^0?([12])\s*[ºo°]?\s*(?:semestre|periodo)?(?:\s*d[eo])?\s*[-/._\s]*(\d{4})$/i);
  if (semFirst) return `${semFirst[2]}/${semFirst[1]}`;
  const genericSlash = normalized.match(/^(\d{4})\s*\/\s*(\d{1,2})$/);
  if (genericSlash) return `${genericSlash[1]}/${Number(genericSlash[2])}`;
  return trimmed.toUpperCase().replace(/\s+/g, " ");
}

export function inferDefaultTerm(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}/${now.getUTCMonth() < 6 ? 1 : 2}`;
}

export function selectionIdForKey(disciplineKey: string): string {
  return `disc_${createHash("sha256").update(disciplineKey).digest("hex").slice(0, 16)}`;
}

export function buildCanonicalDisciplineKey(effectiveTerm: string, disciplineCode: string, disciplineName: string): string {
  const normCode = normalizeDisciplineCode(disciplineCode);
  if (normCode) return `${effectiveTerm}::CODE::${normCode}`;
  return `${effectiveTerm}::NAME::${normalizeDisciplineName(disciplineName)}`;
}

export function parseScheduleMetadata(schedule: string): ParsedSchedule {
  const normalized = schedule
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!normalized) return { daysOfWeek: [], timeRanges: [] };

  const dayMatches: Array<{ index: number; label: string }> = [];
  for (const { label, regex } of DAY_PATTERNS) {
    regex.lastIndex = 0;
    const match = regex.exec(normalized);
    if (match) dayMatches.push({ index: match.index, label });
  }
  dayMatches.sort((a, b) => a.index - b.index);
  const daysOfWeek = [...new Set(dayMatches.map(item => item.label))];

  const timeRanges: string[] = [];
  const rangeRegex = /\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|às|as|a|–|—)\s*([01]?\d|2[0-3]):([0-5]\d)\b/g;
  for (const match of normalized.matchAll(rangeRegex)) {
    const start = `${match[1]!.padStart(2, "0")}:${match[2]}`;
    const end = `${match[3]!.padStart(2, "0")}:${match[4]}`;
    const formatted = `${start} - ${end}`;
    if (!timeRanges.includes(formatted)) timeRanges.push(formatted);
  }
  if (timeRanges.length === 0) {
    const singleRegex = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
    for (const match of normalized.matchAll(singleRegex)) {
      const formatted = `${match[1]!.padStart(2, "0")}:${match[2]}`;
      if (!timeRanges.includes(formatted)) timeRanges.push(formatted);
    }
  }
  return { daysOfWeek, timeRanges };
}

export function areNamesCompatible(normA: string, normB: string): boolean {
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if ((normA.length >= 4 && normB.includes(normA)) || (normB.length >= 4 && normA.includes(normB))) return true;

  const rawA = normA.split(" ").filter(Boolean);
  const rawB = normB.split(" ").filter(Boolean);
  const filteredA = rawA.filter(token => !STOPWORDS.has(token));
  const filteredB = rawB.filter(token => !STOPWORDS.has(token));
  const setA = new Set(filteredA.length > 0 ? filteredA : rawA);
  const setB = new Set(filteredB.length > 0 ? filteredB : rawB);
  if (setA.size === 0 || setB.size === 0) return false;

  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap++;
  }
  return overlap / Math.min(setA.size, setB.size) >= 0.6;
}

function mergeText(current: string, incoming: string): string {
  const a = current.trim();
  const b = incoming.trim();
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function mergeSchedule(current: string, incoming: string): string {
  const a = current.trim();
  const b = incoming.trim();
  if (!a) return b;
  if (!b) return a;
  const normA = normalizeDisciplineName(a);
  const normB = normalizeDisciplineName(b);
  if (normA === normB || normA.includes(normB)) return a;
  if (normB.includes(normA)) return b;
  return `${a}; ${b}`;
}

function mergeColor(current: string, incoming: string): string {
  const a = current.trim() || DEFAULT_COLOR;
  const b = incoming.trim() || DEFAULT_COLOR;
  if (a.toUpperCase() === DEFAULT_COLOR && b.toUpperCase() !== DEFAULT_COLOR) return b;
  return a;
}

function mergeSingleEvent(prev: ExtractedEvent, next: ExtractedEvent, fallbackTime: string): ExtractedEvent {
  const prevDesc = prev.description.trim();
  const nextDesc = next.description.trim();
  let description = prevDesc;
  if (!prevDesc) description = nextDesc;
  else if (nextDesc && !prevDesc.toLowerCase().includes(nextDesc.toLowerCase())) {
    description = nextDesc.toLowerCase().includes(prevDesc.toLowerCase()) ? nextDesc : `${prevDesc} | ${nextDesc}`;
  }
  return {
    title: next.title.trim().length > prev.title.trim().length ? next.title.trim() : prev.title.trim(),
    date: prev.date,
    time: prev.time || next.time || fallbackTime,
    activityType: prev.activityType,
    priority: PRIORITY_RANK[next.priority] > PRIORITY_RANK[prev.priority] ? next.priority : prev.priority,
    description,
    dueDate: prev.dueDate ?? next.dueDate ?? null
  };
}

export function mergeAndDeduplicateEvents(
  existing: ExtractedEvent[],
  incoming: ExtractedEvent[],
  fallbackScheduleTime = ""
): ExtractedEvent[] {
  const merged = new Map<string, ExtractedEvent>();
  for (const raw of [...existing, ...incoming]) {
    const normalizedTitle = normalizeDisciplineName(raw.title) || raw.title.trim().toLowerCase();
    const key = `${raw.date}::${raw.activityType}::${normalizedTitle}`;
    const prepared: ExtractedEvent = { ...raw, title: raw.title.trim(), time: raw.time || fallbackScheduleTime };
    const current = merged.get(key);
    merged.set(key, current ? mergeSingleEvent(current, prepared, fallbackScheduleTime) : prepared);
  }
  return [...merged.values()];
}

export function summarizeActivities(events: ExtractedEvent[]): ActivitiesSummary {
  const countsByType: Partial<Record<ActivityType, number>> = {};
  let evaluativeCount = 0;
  for (const event of events) {
    countsByType[event.activityType] = (countsByType[event.activityType] ?? 0) + 1;
    if (event.activityType !== "AULA") evaluativeCount++;
  }
  return {
    hasExtractedActivities: events.length > 0,
    totalCount: events.length,
    evaluativeCount,
    countsByType
  };
}

type IndexedEntry = {
  index: number;
  raw: ExtractedSyllabus;
  normCode: string;
  normName: string;
  normTerm: string;
  effectiveTerm: string;
};

type ProvisionalGroup = {
  items: IndexedEntry[];
  effectiveTerm: string;
  normCode: string;
  normName: string;
  ambiguous: boolean;
  ambiguityReason: AmbiguityReason | null;
  candidateKeys: string[];
};

function buildConsolidatedDiscipline(group: ProvisionalGroup): ConsolidatedDiscipline {
  const first = group.items[0]!;
  let documentTitle = first.raw.documentTitle.trim();
  let disciplineName = first.raw.disciplineName.trim();
  let disciplineCode = first.raw.disciplineCode.trim();
  let term = first.raw.term.trim();
  let professor = first.raw.professor.trim();
  let classroom = first.raw.classroom.trim();
  let schedule = first.raw.schedule.trim();
  let recommendedColorHex = first.raw.recommendedColorHex || DEFAULT_COLOR;
  let events: ExtractedEvent[] = [];

  for (const item of group.items) {
    documentTitle = mergeText(documentTitle, item.raw.documentTitle);
    disciplineName = mergeText(disciplineName, item.raw.disciplineName);
    disciplineCode = normalizeDisciplineCode(disciplineCode) ? disciplineCode : item.raw.disciplineCode.trim();
    term = term || item.raw.term.trim();
    professor = mergeText(professor, item.raw.professor);
    classroom = mergeText(classroom, item.raw.classroom);
    schedule = mergeSchedule(schedule, item.raw.schedule);
    recommendedColorHex = mergeColor(recommendedColorHex, item.raw.recommendedColorHex);
  }

  const parsedSchedule = parseScheduleMetadata(schedule);
  const startTimeMatch = schedule.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const fallbackTime = startTimeMatch ? `${startTimeMatch[1]!.padStart(2, "0")}:${startTimeMatch[2]}` : "";
  for (const item of group.items) {
    events = mergeAndDeduplicateEvents(events, item.raw.events, fallbackTime);
  }

  const effectiveTerm = group.effectiveTerm;
  const resolvedTerm = term || effectiveTerm;
  const disciplineKey = group.ambiguous
    ? `${effectiveTerm}::AMBIGUOUS::${first.index}::${group.normCode || group.normName || "item"}`
    : buildCanonicalDisciplineKey(effectiveTerm, disciplineCode, disciplineName);

  return {
    selectionId: selectionIdForKey(disciplineKey),
    disciplineKey,
    effectiveTerm,
    documentTitle,
    disciplineName,
    disciplineCode,
    term: resolvedTerm,
    professor,
    classroom,
    schedule,
    parsedSchedule,
    recommendedColorHex,
    consolidation: {
      status: group.ambiguous ? "AMBIGUOUS" : group.items.length > 1 ? "CONSOLIDATED" : "SINGLE",
      mergedSourcesCount: group.items.length,
      ambiguous: group.ambiguous,
      ambiguityReason: group.ambiguityReason,
      candidateKeys: group.candidateKeys
    },
    activities: summarizeActivities(events),
    events
  };
}

function entriesHaveSameDisciplineAcrossTerms(a: IndexedEntry, b: IndexedEntry): boolean {
  if (!a.normTerm || !b.normTerm || a.normTerm === b.normTerm) return false;
  if (a.normCode && b.normCode) return a.normCode === b.normCode;
  return areNamesCompatible(a.normName, b.normName);
}

export function consolidateExtractedDisciplines(
  disciplines: ExtractedSyllabus[],
  now: Date = new Date()
): { termScope: string; disciplines: ConsolidatedDiscipline[] } {
  const defaultTerm = inferDefaultTerm(now);
  if (disciplines.length === 0) return { termScope: defaultTerm, disciplines: [] };

  const firstExplicitTerm = disciplines.map(d => normalizeAcademicTerm(d.term)).find(Boolean);
  const termScope = firstExplicitTerm || defaultTerm;

  const entries: IndexedEntry[] = disciplines.map((raw, index) => {
    const normTerm = normalizeAcademicTerm(raw.term);
    return {
      index,
      raw,
      normCode: normalizeDisciplineCode(raw.disciplineCode),
      normName: normalizeDisciplineName(raw.disciplineName),
      normTerm,
      effectiveTerm: normTerm || termScope
    };
  });

  // Detect explicit cross-term conflicts before intra-term consolidation.
  const crossTermPeers = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entriesHaveSameDisciplineAcrossTerms(entries[i]!, entries[j]!)) {
        crossTermPeers.set(i, [...(crossTermPeers.get(i) ?? []), j]);
        crossTermPeers.set(j, [...(crossTermPeers.get(j) ?? []), i]);
      }
    }
  }

  const groups: ProvisionalGroup[] = [];
  const terms = [...new Set(entries.map(e => e.effectiveTerm))];

  for (const term of terms) {
    const termEntries = entries.filter(e => e.effectiveTerm === term && !crossTermPeers.has(e.index));
    const codedEntries = termEntries.filter(e => e.normCode !== "");
    const uncodedEntries = termEntries.filter(e => e.normCode === "");

    const byCode = new Map<string, IndexedEntry[]>();
    for (const entry of codedEntries) {
      const list = byCode.get(entry.normCode) ?? [];
      list.push(entry);
      byCode.set(entry.normCode, list);
    }

    const codedGroupsForTerm: ProvisionalGroup[] = [];
    for (const [code, codeEntries] of byCode.entries()) {
      const hasNameConflict = codeEntries.some((entry, idx) =>
        codeEntries.slice(idx + 1).some(other => !areNamesCompatible(entry.normName, other.normName))
      );
      if (hasNameConflict) {
        const provisionalKeys = codeEntries.map(
          entry => `${term}::AMBIGUOUS::${entry.index}::${entry.normCode}`
        );
        codeEntries.forEach((entry, idx) => {
          groups.push({
            items: [entry],
            effectiveTerm: term,
            normCode: code,
            normName: entry.normName,
            ambiguous: true,
            ambiguityReason: "CONFLICTING_NAME_FOR_SAME_CODE",
            candidateKeys: provisionalKeys.filter((_, peerIdx) => peerIdx !== idx)
          });
        });
      } else {
        const group: ProvisionalGroup = {
          items: codeEntries,
          effectiveTerm: term,
          normCode: code,
          normName: codeEntries[0]!.normName,
          ambiguous: false,
          ambiguityReason: null,
          candidateKeys: []
        };
        codedGroupsForTerm.push(group);
        groups.push(group);
      }
    }

    const uncodedGroupsForTerm: ProvisionalGroup[] = [];
    for (const entry of uncodedEntries) {
      const matchingCoded = codedGroupsForTerm.filter(group =>
        group.items.some(member => areNamesCompatible(entry.normName, member.normName))
      );
      if (matchingCoded.length === 1) {
        matchingCoded[0]!.items.push(entry);
        continue;
      }
      if (matchingCoded.length > 1) {
        groups.push({
          items: [entry],
          effectiveTerm: term,
          normCode: "",
          normName: entry.normName,
          ambiguous: true,
          ambiguityReason: "MULTIPLE_CANDIDATES_FOR_NAME",
          candidateKeys: matchingCoded.map(group => `${term}::CODE::${group.normCode}`)
        });
        continue;
      }

      const matchingUncoded = uncodedGroupsForTerm.filter(group =>
        group.items.some(member => areNamesCompatible(entry.normName, member.normName))
      );
      if (matchingUncoded.length === 1) {
        matchingUncoded[0]!.items.push(entry);
      } else if (matchingUncoded.length > 1) {
        groups.push({
          items: [entry],
          effectiveTerm: term,
          normCode: "",
          normName: entry.normName,
          ambiguous: true,
          ambiguityReason: "MULTIPLE_CANDIDATES_FOR_NAME",
          candidateKeys: matchingUncoded.map(group => `${term}::NAME::${group.normName}`)
        });
      } else {
        const group: ProvisionalGroup = {
          items: [entry],
          effectiveTerm: term,
          normCode: "",
          normName: entry.normName,
          ambiguous: false,
          ambiguityReason: null,
          candidateKeys: []
        };
        uncodedGroupsForTerm.push(group);
        groups.push(group);
      }
    }
  }

  // Add cross-term conflicting items preserving original appearance order.
  for (const [index, peerIndexes] of crossTermPeers.entries()) {
    const entry = entries[index]!;
    groups.push({
      items: [entry],
      effectiveTerm: entry.effectiveTerm,
      normCode: entry.normCode,
      normName: entry.normName,
      ambiguous: true,
      ambiguityReason: "DIFFERENT_ACADEMIC_TERMS",
      candidateKeys: peerIndexes.map(peerIdx => {
        const peer = entries[peerIdx]!;
        return `${peer.effectiveTerm}::AMBIGUOUS::${peer.index}::${peer.normCode || peer.normName || "item"}`;
      })
    });
  }

  groups.sort((a, b) => a.items[0]!.index - b.items[0]!.index);
  return {
    termScope,
    disciplines: groups.map(buildConsolidatedDiscipline)
  };
}
