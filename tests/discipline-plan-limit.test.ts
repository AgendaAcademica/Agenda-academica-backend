import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { FirestoreDisciplinePlanStore, PLAN_COLLECTIONS } from "../src/plan/firestore-plan-store.js";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { extractedDocumentSchema, type ExtractedDocument, type ExtractedSyllabus } from "../src/schemas/academic.schema.js";
import type { AcademicExtractor } from "../src/services/academic-extractor.js";
import { consolidateExtractedDisciplines } from "../src/services/discipline-consolidation.js";
import { HttpError } from "../src/usage/types.js";
import { MemoryDisciplinePlanStore, MemoryUsageStore, testSecurity } from "./support.js";

function makeSyllabus(overrides: Partial<ExtractedSyllabus> & { disciplineName: string }): ExtractedSyllabus {
  return extractedDocumentSchema.parse({
    disciplines: [
      {
        documentTitle: `Plano - ${overrides.disciplineName}`,
        disciplineName: overrides.disciplineName,
        disciplineCode: overrides.disciplineCode ?? "",
        professor: overrides.professor ?? "Prof. Teste",
        term: overrides.term ?? "2026/2",
        classroom: overrides.classroom ?? "Sala 101",
        schedule: overrides.schedule ?? "Segunda e Quarta, 08:00 - 10:00",
        recommendedColorHex: overrides.recommendedColorHex ?? "#2563EB",
        events: overrides.events ?? [
          {
            title: `Prova 1 - ${overrides.disciplineName}`,
            date: "2026-12-01",
            time: "08:00",
            activityType: "PROVA",
            priority: "URGENTE"
          },
          {
            title: `Trabalho - ${overrides.disciplineName}`,
            date: "2026-12-10",
            time: "23:59",
            activityType: "TRABALHO",
            priority: "ALTA"
          }
        ]
      }
    ]
  }).disciplines[0]!;
}

function setupApp(
  extractedDoc: ExtractedDocument | (() => Promise<ExtractedDocument>),
  options: { limit?: number; planStore?: MemoryDisciplinePlanStore; unlimited?: boolean } = {}
) {
  const env = loadEnv({
    NODE_ENV: "test",
    GEMINI_API_KEY: "test",
    ...(options.limit !== undefined ? { BASE_PLAN_DISCIPLINE_LIMIT: String(options.limit) } : {})
  });
  const usageStore = new MemoryUsageStore();
  const planStore = options.planStore ?? new MemoryDisciplinePlanStore();
  const security = testSecurity(usageStore, planStore);
  if (options.unlimited) {
    security.verifyToken = async token => ({ uid: token, email: "team@example.com", email_verified: true });
    security.unlimitedEmails = new Set(["team@example.com"]);
  }
  const extractDocuments = typeof extractedDoc === "function"
    ? vi.fn(extractedDoc)
    : vi.fn().mockResolvedValue(extractedDoc);
  const extractor: AcademicExtractor = { extractDocuments };
  const app = createApp(env, extractor, security);
  return { app, env, planStore, usageStore, extractDocuments };
}

async function uploadExtract(app: ReturnType<typeof createApp>, token = "user-a", count = 1) {
  const req = request(app).post("/api/v1/documents/extract").set("Authorization", `Bearer ${token}`);
  for (let i = 0; i < count; i++) {
    req.attach("files", Buffer.from(`%PDF-1.7 doc-${i}`), {
      filename: `doc-${i}.pdf`,
      contentType: "application/pdf"
    });
  }
  return req;
}

describe("BASE_PLAN_DISCIPLINE_LIMIT configuration", () => {
  it("uses 6 as default and accepts valid positive integers", () => {
    expect(loadEnv({ NODE_ENV: "test" }).BASE_PLAN_DISCIPLINE_LIMIT).toBe(6);
    expect(loadEnv({ NODE_ENV: "test", BASE_PLAN_DISCIPLINE_LIMIT: "4" }).BASE_PLAN_DISCIPLINE_LIMIT).toBe(4);
    expect(loadEnv({ NODE_ENV: "test", BASE_PLAN_DISCIPLINE_LIMIT: " 12 " }).BASE_PLAN_DISCIPLINE_LIMIT).toBe(12);
  });

  it.each(["0", "-1", "-10", "6.5", "abc", "", "   "])(
    "fails explicitly at startup for invalid BASE_PLAN_DISCIPLINE_LIMIT=%j",
    invalid => {
      expect(() => loadEnv({ NODE_ENV: "test", BASE_PLAN_DISCIPLINE_LIMIT: invalid })).toThrow(
        "BASE_PLAN_DISCIPLINE_LIMIT deve ser um número inteiro positivo maior que zero."
      );
    }
  );
});

describe("discipline consolidation and activity deduplication", () => {
  it("consolidates multiple documents of the same discipline and deduplicates equivalent activities", () => {
    const doc1 = makeSyllabus({
      disciplineCode: "MAT-201",
      disciplineName: "Álgebra Linear",
      professor: "",
      classroom: "Bloco A - 102",
      schedule: "Segunda e Quarta, 08:00 - 10:00",
      events: [
        {
          title: "Prova 1",
          date: "2026-12-01",
          time: "",
          activityType: "PROVA",
          priority: "ALTA",
          description: "Capítulos 1 e 2",
          dueDate: null
        }
      ]
    });
    const doc2 = makeSyllabus({
      disciplineCode: "",
      disciplineName: "Algebra Linear",
      professor: "Profa. Ada",
      classroom: "",
      schedule: "",
      events: [
        {
          title: "Prova 1",
          date: "2026-12-01",
          time: "08:00",
          activityType: "PROVA",
          priority: "URGENTE",
          description: "",
          dueDate: null
        },
        {
          title: "Entrega Lista 1",
          date: "2026-12-08",
          time: "23:59",
          activityType: "PRAZO_ENTREGA",
          priority: "MEDIA",
          description: "Lista no AVA",
          dueDate: "2026-12-08"
        }
      ]
    });

    const result = consolidateExtractedDisciplines([doc1, doc2]);
    expect(result.termScope).toBe("2026/2");
    expect(result.disciplines).toHaveLength(1);
    const merged = result.disciplines[0]!;
    expect(merged.disciplineCode).toBe("MAT-201");
    expect(merged.professor).toBe("Profa. Ada");
    expect(merged.classroom).toBe("Bloco A - 102");
    expect(merged.parsedSchedule).toEqual({
      daysOfWeek: ["Segunda", "Quarta"],
      timeRanges: ["08:00 - 10:00"]
    });
    expect(merged.consolidation).toEqual({
      status: "CONSOLIDATED",
      mergedSourcesCount: 2,
      ambiguous: false,
      ambiguityReason: null,
      candidateKeys: []
    });
    expect(merged.events).toHaveLength(2);
    expect(merged.events[0]).toMatchObject({
      title: "Prova 1",
      time: "08:00",
      priority: "URGENTE",
      description: "Capítulos 1 e 2"
    });
  });
});

describe("base plan discipline quota and post-analysis selection", () => {
  it("T02: analyzes 8 disciplines, returns full preview without exposing raw events, and confirms 6 FULL vs 2 ESSENTIAL_ONLY", async () => {
    const eightDisciplines = Array.from({ length: 8 }, (_, idx) =>
      makeSyllabus({
        disciplineCode: `INF${101 + idx}`,
        disciplineName: `Disciplina ${idx + 1}`,
        classroom: `Sala ${200 + idx}`,
        professor: `Prof. ${idx + 1}`
      })
    );
    const { app, planStore } = setupApp({ disciplines: eightDisciplines });

    const extractRes = await uploadExtract(app, "user-a", 8);
    expect(extractRes.status).toBe(200);
    expect(extractRes.body.analysisId).toBe(extractRes.body.meta.operationId);
    expect(extractRes.body.meta.disciplinesCount).toBe(8);
    expect(extractRes.body.data.status).toBe("PENDING_CONFIRMATION");
    expect(extractRes.body.data.quota).toEqual({
      limit: 6,
      used: 0,
      remaining: 6,
      isUnlimited: false,
      term: "2026/2",
      selectionRequired: true
    });
    expect(extractRes.body.data.disciplines).toHaveLength(8);
    for (const item of extractRes.body.data.disciplines) {
      expect(item.selectionId).toMatch(/^disc_[a-f0-9]{16}$/);
      expect(item.events).toBeUndefined();
      expect(item.activities.hasExtractedActivities).toBe(true);
      expect(item.activities.totalCount).toBe(2);
      expect(item.parsedSchedule.daysOfWeek).toEqual(["Segunda", "Quarta"]);
      expect(item.quotaEligibility.eligibleForFull).toBe(true);
    }

    // Raw complete events are preserved internally prior to confirmation.
    const storedBatch = planStore.batches.get(extractRes.body.analysisId)!;
    expect(storedBatch.status).toBe("pending_confirmation");
    expect(storedBatch.disciplines[7]!.events).toHaveLength(2);
    expect(planStore.userStates.size).toBe(0);

    const selectedIds = extractRes.body.data.disciplines.slice(0, 6).map((d: { selectionId: string }) => d.selectionId);
    const confirmRes = await request(app)
      .post(`/api/v1/documents/extractions/${extractRes.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: selectedIds });

    expect(confirmRes.status).toBe(200);
    const confirmed = confirmRes.body.data;
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.quota).toEqual({
      limit: 6,
      usedBefore: 0,
      consumedNow: 6,
      used: 6,
      remaining: 0,
      isUnlimited: false,
      term: "2026/2"
    });
    expect(confirmed.summary).toMatchObject({
      totalDisciplinesProcessed: 8,
      fullCount: 6,
      essentialOnlyCount: 2,
      preservedPreviousFullCount: 0
    });
    expect(confirmed.fullDisciplines).toHaveLength(6);
    expect(confirmed.fullDisciplines.every((d: { events: unknown[]; inclusionMode: string }) => d.inclusionMode === "FULL" && d.events.length === 2)).toBe(true);
    expect(confirmed.essentialOnlyDisciplines).toHaveLength(2);
    for (const essential of confirmed.essentialOnlyDisciplines) {
      expect(essential.inclusionMode).toBe("ESSENTIAL_ONLY");
      expect(essential.countsTowardsQuota).toBe(false);
      expect(essential.omittedActivitiesCount).toBe(2);
      expect(essential.events).toEqual([]);
      expect(essential.classroom).toMatch(/^Sala 20/);
      expect(essential.professor).toMatch(/^Prof\. /);
    }
  });

  it("T03: atomically rejects selections exceeding quota without partial application and keeps batch pending", async () => {
    const eightDisciplines = Array.from({ length: 8 }, (_, idx) =>
      makeSyllabus({ disciplineCode: `MAT${101 + idx}`, disciplineName: `Matéria ${idx + 1}` })
    );
    const { app, planStore } = setupApp({ disciplines: eightDisciplines });
    const extractRes = await uploadExtract(app, "user-a", 1);
    const analysisId = extractRes.body.analysisId;
    const sevenIds = extractRes.body.data.disciplines.slice(0, 7).map((d: { selectionId: string }) => d.selectionId);

    const rejected = await request(app)
      .post(`/api/v1/documents/extractions/${analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: sevenIds });

    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe("DISCIPLINE_QUOTA_EXCEEDED");
    expect(rejected.body.quota).toEqual({
      limit: 6,
      used: 0,
      remaining: 6,
      requestedNew: 7,
      term: "2026/2"
    });
    expect(planStore.userStates.size).toBe(0);
    expect(planStore.batches.get(analysisId)!.status).toBe("pending_confirmation");

    // User can adjust selection to 6 and succeed on retry.
    const sixIds = sevenIds.slice(0, 6);
    const ok = await request(app)
      .post(`/api/v1/documents/extractions/${analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: sixIds });
    expect(ok.status).toBe(200);
    expect(ok.body.data.quota.used).toBe(6);
  });

  it("T04: consumes only 1 quota slot when multiple files represent the same discipline", async () => {
    const page1 = makeSyllabus({ disciplineCode: "MAT201", disciplineName: "Álgebra Linear", classroom: "A1" });
    const page2 = makeSyllabus({ disciplineCode: "MAT-201", disciplineName: "Algebra Linear", classroom: "" });
    const page3 = makeSyllabus({ disciplineCode: "", disciplineName: "Álgebra Linear", professor: "Ada" });
    const { app } = setupApp({ disciplines: [page1, page2, page3] });

    const extractRes = await uploadExtract(app, "user-a", 3);
    expect(extractRes.status).toBe(200);
    expect(extractRes.body.data.disciplines).toHaveLength(1);
    expect(extractRes.body.data.disciplines[0].consolidation.mergedSourcesCount).toBe(3);

    const confirmRes = await request(app)
      .post(`/api/v1/documents/extractions/${extractRes.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: [extractRes.body.data.disciplines[0].selectionId] });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.quota.used).toBe(1);
    expect(confirmRes.body.data.quota.remaining).toBe(5);
  });

  it("T05: dynamically enforces changed BASE_PLAN_DISCIPLINE_LIMIT (4 and 8) without hardcode", async () => {
    const eightDisciplines = Array.from({ length: 8 }, (_, idx) =>
      makeSyllabus({ disciplineCode: `FIS${101 + idx}`, disciplineName: `Física ${idx + 1}` })
    );

    const lowLimit = setupApp({ disciplines: eightDisciplines }, { limit: 4 });
    const extract4 = await uploadExtract(lowLimit.app);
    expect(extract4.body.data.quota.limit).toBe(4);
    const ids5 = extract4.body.data.disciplines.slice(0, 5).map((d: { selectionId: string }) => d.selectionId);
    const fail5 = await request(lowLimit.app)
      .post(`/api/v1/documents/extractions/${extract4.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: ids5 });
    expect(fail5.status).toBe(422);
    expect(fail5.body.code).toBe("DISCIPLINE_QUOTA_EXCEEDED");

    const highLimit = setupApp({ disciplines: eightDisciplines }, { limit: 8 });
    const extract8 = await uploadExtract(highLimit.app);
    expect(extract8.body.data.quota.limit).toBe(8);
    expect(extract8.body.data.quota.selectionRequired).toBe(false);
    const all8Ids = extract8.body.data.disciplines.map((d: { selectionId: string }) => d.selectionId);
    const ok8 = await request(highLimit.app)
      .post(`/api/v1/documents/extractions/${extract8.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: all8Ids });
    expect(ok8.status).toBe(200);
    expect(ok8.body.data.quota).toMatchObject({ limit: 8, used: 8, remaining: 0 });
    expect(ok8.body.data.fullDisciplines).toHaveLength(8);
  });

  it("T06 & T07: accounts for prior quota usage, allows re-sending counted disciplines at 0 cost, and preserves non-selected FULL disciplines", async () => {
    const planStore = new MemoryDisciplinePlanStore();
    const initial4 = Array.from({ length: 4 }, (_, idx) =>
      makeSyllabus({ disciplineCode: `BIO${101 + idx}`, disciplineName: `Biologia ${idx + 1}` })
    );
    const firstBatch = setupApp({ disciplines: initial4 }, { planStore });
    const ex1 = await uploadExtract(firstBatch.app);
    await request(firstBatch.app)
      .post(`/api/v1/documents/extractions/${ex1.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: ex1.body.data.disciplines.map((d: { selectionId: string }) => d.selectionId) });

    // Second upload includes BIO101 (re-sent, will be selected), BIO102 (re-sent, NOT selected), and 3 new ones (BIO105, BIO106, BIO107)
    const secondDocs = [
      makeSyllabus({ disciplineCode: "BIO101", disciplineName: "Biologia 1", classroom: "Lab Novo" }),
      makeSyllabus({ disciplineCode: "BIO102", disciplineName: "Biologia 2", events: [] }),
      makeSyllabus({ disciplineCode: "BIO105", disciplineName: "Biologia 5" }),
      makeSyllabus({ disciplineCode: "BIO106", disciplineName: "Biologia 6" }),
      makeSyllabus({ disciplineCode: "BIO107", disciplineName: "Biologia 7" })
    ];
    const secondBatch = setupApp({ disciplines: secondDocs }, { planStore });
    const ex2 = await uploadExtract(secondBatch.app);

    expect(ex2.body.data.quota).toMatchObject({ limit: 6, used: 4, remaining: 2, selectionRequired: true });
    const byCode = Object.fromEntries(
      ex2.body.data.disciplines.map((d: { disciplineCode: string }) => [d.disciplineCode, d])
    );
    expect(byCode.BIO101.quotaEligibility).toEqual({
      eligibleForFull: true,
      alreadyCountedInQuota: true,
      previouslyConfirmedMode: "FULL",
      quotaCostIfSelected: 0
    });
    expect(byCode.BIO105.quotaEligibility.quotaCostIfSelected).toBe(1);

    // Selecting BIO101 (cost 0) + BIO105, BIO106, BIO107 (cost 3) exceeds remaining 2 -> 422
    const exceed = await request(secondBatch.app)
      .post(`/api/v1/documents/extractions/${ex2.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({
        selectedDisciplineIds: [
          byCode.BIO101.selectionId,
          byCode.BIO105.selectionId,
          byCode.BIO106.selectionId,
          byCode.BIO107.selectionId
        ]
      });
    expect(exceed.status).toBe(422);
    expect(exceed.body.quota).toMatchObject({ used: 4, remaining: 2, requestedNew: 3 });

    // Selecting BIO101 (cost 0) + BIO105 + BIO106 (cost 2) succeeds; BIO102 preserves previous FULL events; BIO107 is ESSENTIAL_ONLY
    const ok = await request(secondBatch.app)
      .post(`/api/v1/documents/extractions/${ex2.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({
        selectedDisciplineIds: [byCode.BIO101.selectionId, byCode.BIO105.selectionId, byCode.BIO106.selectionId]
      });
    expect(ok.status).toBe(200);
    expect(ok.body.data.quota).toMatchObject({ usedBefore: 4, consumedNow: 2, used: 6, remaining: 0 });
    expect(ok.body.data.summary.preservedPreviousFullCount).toBe(1);

    const bio102Published = ok.body.data.fullDisciplines.find((d: { disciplineCode: string }) => d.disciplineCode === "BIO102");
    expect(bio102Published).toMatchObject({
      inclusionMode: "FULL",
      preservedFromPreviousConfirmation: true,
      countsTowardsQuota: true
    });
    expect(bio102Published.events).toHaveLength(2);

    const bio107Published = ok.body.data.essentialOnlyDisciplines.find((d: { disciplineCode: string }) => d.disciplineCode === "BIO107");
    expect(bio107Published.inclusionMode).toBe("ESSENTIAL_ONLY");
    expect(bio107Published.events).toEqual([]);
  });

  it("T08: supports enrollment receipt (ESSENTIAL_ONLY) followed by syllabus upgrade (FULL)", async () => {
    const planStore = new MemoryDisciplinePlanStore();
    const enrollmentDoc = makeSyllabus({
      disciplineCode: "ENG301",
      disciplineName: "Engenharia de Software",
      classroom: "Pavilhão B - 302",
      schedule: "Terça e Quinta, 14:00 - 16:00",
      professor: "Profa. Grace",
      events: []
    });
    const step1 = setupApp({ disciplines: [enrollmentDoc] }, { planStore });
    const ex1 = await uploadExtract(step1.app);
    expect(ex1.body.data.disciplines[0].activities.hasExtractedActivities).toBe(false);
    expect(ex1.body.data.disciplines[0].quotaEligibility.eligibleForFull).toBe(false);

    const confirm1 = await request(step1.app)
      .post(`/api/v1/documents/extractions/${ex1.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: [] });
    expect(confirm1.status).toBe(200);
    expect(confirm1.body.data.quota).toMatchObject({ used: 0, remaining: 6 });
    expect(confirm1.body.data.essentialOnlyDisciplines[0]).toMatchObject({
      disciplineCode: "ENG301",
      inclusionMode: "ESSENTIAL_ONLY",
      classroom: "Pavilhão B - 302"
    });

    // Follow-up syllabus without classroom/schedule upgrades ENG301 to FULL while retaining receipt metadata.
    const syllabusDoc = makeSyllabus({
      disciplineCode: "ENG301",
      disciplineName: "Engenharia de Software",
      classroom: "",
      schedule: "",
      professor: ""
    });
    const step2 = setupApp({ disciplines: [syllabusDoc] }, { planStore });
    const ex2 = await uploadExtract(step2.app);
    const previewItem = ex2.body.data.disciplines[0];
    expect(previewItem.classroom).toBe("Pavilhão B - 302");
    expect(previewItem.schedule).toBe("Terça e Quinta, 14:00 - 16:00");
    expect(previewItem.quotaEligibility).toEqual({
      eligibleForFull: true,
      alreadyCountedInQuota: false,
      previouslyConfirmedMode: "ESSENTIAL_ONLY",
      quotaCostIfSelected: 1
    });

    const confirm2 = await request(step2.app)
      .post(`/api/v1/documents/extractions/${ex2.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: [previewItem.selectionId] });
    expect(confirm2.status).toBe(200);
    expect(confirm2.body.data.quota).toMatchObject({ usedBefore: 0, consumedNow: 1, used: 1, remaining: 5 });
    expect(confirm2.body.data.fullDisciplines[0]).toMatchObject({
      disciplineCode: "ENG301",
      inclusionMode: "FULL",
      classroom: "Pavilhão B - 302",
      schedule: "Terça e Quinta, 14:00 - 16:00",
      professor: "Profa. Grace"
    });
    expect(confirm2.body.data.fullDisciplines[0].events).toHaveLength(2);
  });

  it("T09: handles mixed content where only a subset of disciplines have extracted activities", async () => {
    const mixed = [
      makeSyllabus({ disciplineCode: "CMP101", disciplineName: "Compiladores" }),
      makeSyllabus({ disciplineCode: "RED102", disciplineName: "Redes" }),
      makeSyllabus({ disciplineCode: "ESO103", disciplineName: "Ética", events: [] }),
      makeSyllabus({ disciplineCode: "HUM104", disciplineName: "Sociologia", events: [] }),
      makeSyllabus({ disciplineCode: "ADM105", disciplineName: "Gestão", events: [] })
    ];
    const { app } = setupApp({ disciplines: mixed });
    const ex = await uploadExtract(app);
    const withActivities = ex.body.data.disciplines.filter((d: { activities: { hasExtractedActivities: boolean } }) => d.activities.hasExtractedActivities);
    const withoutActivities = ex.body.data.disciplines.filter((d: { activities: { hasExtractedActivities: boolean } }) => !d.activities.hasExtractedActivities);
    expect(withActivities).toHaveLength(2);
    expect(withoutActivities).toHaveLength(3);
    expect(withoutActivities.every((d: { quotaEligibility: { eligibleForFull: boolean } }) => d.quotaEligibility.eligibleForFull === false)).toBe(true);

    // Selecting a discipline without activities is rejected explicitly.
    const badSelect = await request(app)
      .post(`/api/v1/documents/extractions/${ex.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: [withoutActivities[0].selectionId] });
    expect(badSelect.status).toBe(422);
    expect(badSelect.body.code).toBe("DISCIPLINE_HAS_NO_ACTIVITIES");

    const ok = await request(app)
      .post(`/api/v1/documents/extractions/${ex.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: withActivities.map((d: { selectionId: string }) => d.selectionId) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.summary).toMatchObject({ fullCount: 2, essentialOnlyCount: 3 });
    expect(ok.body.data.quota.used).toBe(2);
  });

  it("T10: flags ambiguous discipline associations for RF05 review and resolves them on confirm", async () => {
    const conflictA = makeSyllabus({ disciplineCode: "MAT201", disciplineName: "Álgebra Linear", term: "2026/2" });
    const conflictB = makeSyllabus({ disciplineCode: "MAT201", disciplineName: "Física Experimental", term: "2026/2" });
    const { app } = setupApp({ disciplines: [conflictA, conflictB] });

    const ex = await uploadExtract(app);
    expect(ex.body.data.quota.selectionRequired).toBe(true);
    expect(ex.body.data.disciplines).toHaveLength(2);
    expect(ex.body.data.disciplines[0].consolidation.ambiguous).toBe(true);
    expect(ex.body.data.disciplines[0].consolidation.ambiguityReason).toBe("CONFLICTING_NAME_FOR_SAME_CODE");

    const ids = ex.body.data.disciplines.map((d: { selectionId: string }) => d.selectionId);
    const unresolved = await request(app)
      .post(`/api/v1/documents/extractions/${ex.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: ids });
    expect(unresolved.status).toBe(422);
    expect(unresolved.body.code).toBe("AMBIGUOUS_DISCIPLINE_REQUIRES_REVIEW");

    const resolved = await request(app)
      .post(`/api/v1/documents/extractions/${ex.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({
        selectedDisciplineIds: ids,
        ambiguityResolutions: [
          {
            selectionId: ids[1],
            action: "KEEP_SEPARATE",
            overrideDisciplineCode: "FIS201"
          }
        ]
      });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.fullDisciplines).toHaveLength(2);
    expect(resolved.body.data.quota.used).toBe(2);
  });

  it("T11: ensures idempotency, concurrency safety, semester isolation, authorization, and quota lookup", async () => {
    const planStore = new MemoryDisciplinePlanStore();
    // Exhaust 5 of 6 slots in 2026/2
    const five = Array.from({ length: 5 }, (_, idx) =>
      makeSyllabus({ disciplineCode: `SIS${101 + idx}`, disciplineName: `Sistemas ${idx + 1}`, term: "2026/2" })
    );
    const initApp = setupApp({ disciplines: five }, { planStore }).app;
    const exInit = await uploadExtract(initApp);
    await request(initApp)
      .post(`/api/v1/documents/extractions/${exInit.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: exInit.body.data.disciplines.map((d: { selectionId: string }) => d.selectionId) });

    // Two concurrent batches racing for the last remaining slot in 2026/2
    const batchA = setupApp({ disciplines: [makeSyllabus({ disciplineCode: "SIS201", disciplineName: "Comp A", term: "2026/2" })] }, { planStore });
    const batchB = setupApp({ disciplines: [makeSyllabus({ disciplineCode: "SIS202", disciplineName: "Comp B", term: "2026/2" })] }, { planStore });
    const exA = await uploadExtract(batchA.app);
    const exB = await uploadExtract(batchB.app);

    const [resA, resB] = await Promise.all([
      request(batchA.app)
        .post(`/api/v1/documents/extractions/${exA.body.analysisId}/confirm`)
        .set("Authorization", "Bearer user-a")
        .send({ selectedDisciplineIds: [exA.body.data.disciplines[0].selectionId] }),
      request(batchB.app)
        .post(`/api/v1/documents/extractions/${exB.body.analysisId}/confirm`)
        .set("Authorization", "Bearer user-a")
        .send({ selectedDisciplineIds: [exB.body.data.disciplines[0].selectionId] })
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 422]);
    const winnerId = resA.status === 200 ? exA.body.analysisId : exB.body.analysisId;
    const winnerApp = resA.status === 200 ? batchA.app : batchB.app;
    const winnerSelection = resA.status === 200 ? exA.body.data.disciplines[0].selectionId : exB.body.data.disciplines[0].selectionId;

    // Idempotent retry on winner returns 200 without charging extra quota; different selection returns 409.
    const repeat = await request(winnerApp)
      .post(`/api/v1/documents/extractions/${winnerId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: [winnerSelection] });
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.quota.used).toBe(6);

    const conflict = await request(winnerApp)
      .post(`/api/v1/documents/extractions/${winnerId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: [] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("ANALYSIS_ALREADY_CONFIRMED");

    // Cross-user access denied
    const forbidden = await request(winnerApp)
      .get(`/api/v1/documents/extractions/${winnerId}`)
      .set("Authorization", "Bearer user-b");
    expect(forbidden.status).toBe(403);

    // Next semester (2027/1) has a fresh quota of 6 while 2026/2 stays at 6/6.
    const nextTermApp = setupApp({
      disciplines: [makeSyllabus({ disciplineCode: "IA301", disciplineName: "IA Avançada", term: "2027/1" })]
    }, { planStore }).app;
    const exNextTerm = await uploadExtract(nextTermApp);
    expect(exNextTerm.body.data.quota).toMatchObject({ term: "2027/1", limit: 6, used: 0, remaining: 6 });

    const quota2026 = await request(nextTermApp).get("/api/v1/documents/quota?term=2026/2").set("Authorization", "Bearer user-a");
    expect(quota2026.status).toBe(200);
    expect(quota2026.body.data.quota).toMatchObject({ term: "2026/2", used: 6, remaining: 0 });
  });

  it("handles unlimited user exemptions, invalid JSON payloads, and storage unavailability cleanly", async () => {
    const eight = Array.from({ length: 8 }, (_, idx) =>
      makeSyllabus({ disciplineCode: `UNL${100 + idx}`, disciplineName: `Ilimitada ${idx + 1}` })
    );
    const { app, planStore } = setupApp({ disciplines: eight }, { unlimited: true });
    const ex = await uploadExtract(app);
    expect(ex.body.data.quota.isUnlimited).toBe(true);
    expect(ex.body.data.quota.selectionRequired).toBe(false);

    const confirmAll = await request(app)
      .post(`/api/v1/documents/extractions/${ex.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({ selectedDisciplineIds: ex.body.data.disciplines.map((d: { selectionId: string }) => d.selectionId) });
    expect(confirmAll.status).toBe(200);
    expect(confirmAll.body.data.fullDisciplines).toHaveLength(8);
    expect(confirmAll.body.data.quota.isUnlimited).toBe(true);

    const invalidJson = await request(app)
      .post(`/api/v1/documents/extractions/${ex.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .set("Content-Type", "application/json")
      .send("{invalid");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body.code).toBe("INVALID_JSON");

    vi.spyOn(planStore, "getUserQuota").mockRejectedValueOnce(
      new HttpError(503, "PLAN_STORAGE_UNAVAILABLE", "O armazenamento do plano acadêmico está temporariamente indisponível.")
    );
    const unavailable = await request(app)
      .get("/api/v1/documents/quota")
      .set("Authorization", "Bearer user-a");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: "PLAN_STORAGE_UNAVAILABLE", retryable: true });
  });

  it("handles MULTIPLE_CANDIDATES_FOR_NAME, DIFFERENT_ACADEMIC_TERMS, MERGE_WITH_TARGET, GET extraction, 404/400 errors, and expiration", async () => {
    // MULTIPLE_CANDIDATES_FOR_NAME + MERGE_WITH_TARGET
    const topA = makeSyllabus({ disciplineCode: "INF301", disciplineName: "Tópicos Especiais" });
    const topB = makeSyllabus({ disciplineCode: "INF302", disciplineName: "Tópicos Especiais" });
    const uncoded = makeSyllabus({
      disciplineCode: "",
      disciplineName: "Tópicos Especiais",
      classroom: "Sala Extra",
      events: [{ title: "Seminário Final", date: "2026-12-15", time: "10:00", activityType: "SEMINARIO", priority: "ALTA", description: "", dueDate: null }]
    });
    const { app } = setupApp({ disciplines: [topA, topB, uncoded] });
    const ex = await uploadExtract(app);
    expect(ex.body.data.disciplines).toHaveLength(3);
    const ambiguousItem = ex.body.data.disciplines.find((d: { consolidation: { ambiguous: boolean } }) => d.consolidation.ambiguous);
    expect(ambiguousItem.consolidation.ambiguityReason).toBe("MULTIPLE_CANDIDATES_FOR_NAME");

    const targetItem = ex.body.data.disciplines.find((d: { disciplineCode: string }) => d.disciplineCode === "INF301");
    const mergedConfirm = await request(app)
      .post(`/api/v1/documents/extractions/${ex.body.analysisId}/confirm`)
      .set("Authorization", "Bearer user-a")
      .send({
        selectedDisciplineIds: [targetItem.selectionId, ambiguousItem.selectionId],
        ambiguityResolutions: [
          {
            selectionId: ambiguousItem.selectionId,
            action: "MERGE_WITH_TARGET",
            targetSelectionId: targetItem.selectionId
          }
        ]
      });
    expect(mergedConfirm.status).toBe(200);
    expect(mergedConfirm.body.data.fullDisciplines).toHaveLength(1);
    expect(mergedConfirm.body.data.fullDisciplines[0].events).toHaveLength(3);
    expect(mergedConfirm.body.data.quota.used).toBe(1);

    // GET extraction returns confirmed state
    const getConfirmed = await request(app)
      .get(`/api/v1/documents/extractions/${ex.body.analysisId}`)
      .set("Authorization", "Bearer user-a");
    expect(getConfirmed.status).toBe(200);
    expect(getConfirmed.body.data.status).toBe("CONFIRMED");

    // DIFFERENT_ACADEMIC_TERMS
    const term1 = makeSyllabus({ disciplineCode: "EST101", disciplineName: "Estatística", term: "2026/1" });
    const term2 = makeSyllabus({ disciplineCode: "EST101", disciplineName: "Estatística", term: "2026/2" });
    const crossTerm = consolidateExtractedDisciplines([term1, term2]);
    expect(crossTerm.disciplines).toHaveLength(2);
    expect(crossTerm.disciplines.every(d => d.consolidation.ambiguous && d.consolidation.ambiguityReason === "DIFFERENT_ACADEMIC_TERMS")).toBe(true);

    // 404 & 400 validation errors
    expect((await request(app).get("/api/v1/documents/extractions/missing-id").set("Authorization", "Bearer user-a")).status).toBe(404);
    expect((await request(app).post("/api/v1/documents/extractions/missing-id/confirm").set("Authorization", "Bearer user-a").send({ selectedDisciplineIds: "invalid" })).status).toBe(400);

    let now = 1_000_000;
    const expiringStore = new MemoryDisciplinePlanStore(() => now, 500);
    const expiringApp = setupApp({ disciplines: [topA] }, { planStore: expiringStore }).app;
    const exExp = await uploadExtract(expiringApp);
    expect((await request(expiringApp).get(`/api/v1/documents/extractions/${exExp.body.analysisId}`).set("Authorization", "Bearer user-a")).status).toBe(200);
    now += 1_000;
    expect((await request(expiringApp).get(`/api/v1/documents/extractions/${exExp.body.analysisId}`).set("Authorization", "Bearer user-a")).status).toBe(404);
    expect((await request(expiringApp).post(`/api/v1/documents/extractions/${exExp.body.analysisId}/confirm`).set("Authorization", "Bearer user-a").send({ selectedDisciplineIds: [] })).status).toBe(404);
  });

  it("FirestoreDisciplinePlanStore persists batches and states transactionally and wraps storage failures", async () => {
    const docs = new Map<string, Record<string, unknown>>();
    const cloneFirestoreData = (data: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v instanceof Timestamp ? v : structuredClone(v)])
      );
    const docRef = (path: string) => ({
      path,
      async get() {
        const data = docs.get(path);
        return { exists: Boolean(data), data: () => (data ? cloneFirestoreData(data) : undefined) };
      }
    });
    const fakeDb = {
      collection(name: string) {
        return { doc: (id: string) => docRef(`${name}/${id}`) };
      },
      async getAll(...refs: Array<{ path: string; get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }> }>) {
        return Promise.all(refs.map(ref => ref.get()));
      },
      async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        const tx = {
          get: (ref: { get: () => Promise<unknown> }) => ref.get(),
          getAll: (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map(ref => ref.get())),
          set: (ref: { path: string }, data: Record<string, unknown>) => {
            docs.set(ref.path, cloneFirestoreData(data));
          }
        };
        return fn(tx);
      }
    } as unknown as Firestore;

    const store = new FirestoreDisciplinePlanStore(fakeDb, () => Date.parse("2026-11-23T12:00:00.000Z"));
    const consolidated = consolidateExtractedDisciplines([makeSyllabus({ disciplineCode: "MAT201", disciplineName: "Álgebra" })]);
    const preview = await store.createPendingAnalysis({
      analysisId: "analysis-1",
      uid: "uid-1",
      createdAt: "2026-11-23T12:00:00.000Z",
      termScope: consolidated.termScope,
      disciplines: consolidated.disciplines,
      limit: 6,
      isUnlimited: false
    });
    expect(preview.disciplines).toHaveLength(1);
    expect(docs.has(`${PLAN_COLLECTIONS.batches}/analysis-1`)).toBe(true);

    const confirmed = await store.confirmAnalysis({
      analysisId: "analysis-1",
      uid: "uid-1",
      selectedDisciplineIds: [preview.disciplines[0]!.selectionId],
      limit: 6,
      isUnlimited: false
    });
    expect(confirmed.quota.used).toBe(1);
    expect((await store.getUserQuota({ uid: "uid-1", term: "2026/2", limit: 6, isUnlimited: false })).consumedDisciplineKeys).toEqual([
      "2026/2::CODE::MAT201"
    ]);
    expect(((await store.getAnalysisPreview({ analysisId: "analysis-1", uid: "uid-1", limit: 6, isUnlimited: false })) as { status: string }).status).toBe("CONFIRMED");

    const brokenStore = new FirestoreDisciplinePlanStore({
      collection: () => ({ doc: () => ({}) }),
      runTransaction: () => Promise.reject(new Error("unavailable"))
    } as unknown as Firestore);
    await expect(
      brokenStore.confirmAnalysis({ analysisId: "a", uid: "u", selectedDisciplineIds: [], limit: 6, isUnlimited: false })
    ).rejects.toMatchObject({ status: 503, code: "PLAN_STORAGE_UNAVAILABLE" });
  });
});
