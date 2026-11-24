import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { MAX_DOCUMENTS_PER_UPLOAD } from "../config/upload.js";
import { confirmAnalysisRequestSchema, type DisciplinePlanStore } from "../plan/types.js";
import {
  consolidateExtractedDisciplines,
  inferDefaultTerm,
  normalizeAcademicTerm
} from "../services/discipline-consolidation.js";
import { CachedAcademicExtractor, type AcademicExtractor, type ExtractionRunner } from "../services/academic-extractor.js";
import { PersistentAcademicExtractor } from "../services/document-cache.js";
import { HttpError } from "../usage/types.js";
import type { UsageService } from "../usage/meter.js";
import { boundedMemoryStorage } from "./upload-storage.js";

const supportedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

function hasValidSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "application/pdf") return buffer.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  return false;
}

export function documentsRouter(
  extractor: AcademicExtractor,
  maxMb: number,
  usage: UsageService,
  maxTotalMb: number,
  planStore: DisciplinePlanStore,
  basePlanDisciplineLimit: number,
  extractConcurrencyLimit: RequestHandler
): Router {
  const router = Router();
  const upload = multer({
    storage: boundedMemoryStorage(Math.floor(maxTotalMb * 1024 * 1024)),
    limits: {
      fileSize: Math.floor(maxMb * 1024 * 1024),
      files: MAX_DOCUMENTS_PER_UPLOAD,
      fields: 0,
      parts: MAX_DOCUMENTS_PER_UPLOAD + 1
    }
  });

  router.post(
    "/extract",
    extractConcurrencyLimit,
    upload.fields([
      { name: "file", maxCount: MAX_DOCUMENTS_PER_UPLOAD },
      { name: "files", maxCount: MAX_DOCUMENTS_PER_UPLOAD }
    ]),
    async (req, res, next) => {
      try {
        const grouped = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
        const files = [...(grouped.file ?? []), ...(grouped.files ?? [])];
        if (files.length === 0) {
          res.status(400).json({ error: `Envie de 1 a ${MAX_DOCUMENTS_PER_UPLOAD} documentos PDF ou imagens nos campos 'file' ou 'files'.` });
          return;
        }
        if (files.some(file => !supportedMimeTypes.has(file.mimetype) || !hasValidSignature(file.buffer, file.mimetype))) {
          res.status(415).json({ error: "O arquivo deve ser um PDF, JPEG, PNG ou WebP válido." });
          return;
        }
        res.locals.processingExtraction = true;
        const academicFiles = files.map(file => ({ buffer: file.buffer, fileName: file.originalname, mimeType: file.mimetype }));
        let operationId = "";
        let cache = "miss";
        const run: ExtractionRunner = async (cacheState, action) => {
          const result = await usage.run(
            res.locals.uid,
            files.length,
            files.reduce((sum, file) => sum + file.size, 0),
            action,
            cacheState,
            res.locals.unlimitedUserUsage === true
          );
          operationId = result.operationId;
          cache = result.cache;
          return result.data;
        };
        const extracted = extractor instanceof CachedAcademicExtractor || extractor instanceof PersistentAcademicExtractor
          ? await extractor.extractDocuments(academicFiles, run)
          : await run("miss", () => extractor.extractDocuments(academicFiles));

        const analysisId = operationId || randomUUID();
        const consolidated = consolidateExtractedDisciplines(extracted.disciplines);
        const preview = await planStore.createPendingAnalysis({
          analysisId,
          uid: res.locals.uid,
          createdAt: new Date().toISOString(),
          termScope: consolidated.termScope,
          disciplines: consolidated.disciplines,
          limit: basePlanDisciplineLimit,
          isUnlimited: res.locals.unlimitedUserUsage === true
        });
        const eventsCount = consolidated.disciplines.reduce((sum, discipline) => sum + discipline.events.length, 0);
        const mimeType = files.length === 1
          ? files[0]!.mimetype
          : files.every(file => file.mimetype.startsWith("image/"))
            ? "multipart/images"
            : "multipart/documents";
        res.json({
          analysisId,
          data: preview,
          meta: {
            operationId,
            cache,
            fileName: files.map(file => file.originalname).join(", "),
            fileSize: files.reduce((sum, file) => sum + file.size, 0),
            filesCount: files.length,
            disciplinesCount: consolidated.disciplines.length,
            eventsCount,
            mimeType
          }
        });
      } catch (error) {
        next(error);
      } finally {
        res.locals.releaseExtraction?.();
      }
    }
  );

  router.get("/quota", async (req, res, next) => {
    try {
      const rawTerm = typeof req.query.term === "string" ? req.query.term.trim() : "";
      const term = rawTerm ? normalizeAcademicTerm(rawTerm) : inferDefaultTerm();
      const result = await planStore.getUserQuota({
        uid: res.locals.uid,
        term,
        limit: basePlanDisciplineLimit,
        isUnlimited: res.locals.unlimitedUserUsage === true
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.get("/extractions/:analysisId", async (req, res, next) => {
    try {
      const analysisId = req.params.analysisId?.trim();
      if (!analysisId) throw new HttpError(400, "INVALID_ANALYSIS_ID", "Identificador de análise inválido.");
      const result = await planStore.getAnalysisPreview({
        analysisId,
        uid: res.locals.uid,
        limit: basePlanDisciplineLimit,
        isUnlimited: res.locals.unlimitedUserUsage === true
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ analysisId, data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/extractions/:analysisId/confirm", async (req, res, next) => {
    try {
      const analysisId = req.params.analysisId?.trim();
      if (!analysisId) throw new HttpError(400, "INVALID_ANALYSIS_ID", "Identificador de análise inválido.");
      const parsed = confirmAnalysisRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(
          400,
          "INVALID_CONFIRMATION_PAYLOAD",
          "Informe selectedDisciplineIds com os identificadores válidos das disciplinas selecionadas."
        );
      }
      const result = await planStore.confirmAnalysis({
        analysisId,
        uid: res.locals.uid,
        selectedDisciplineIds: parsed.data.selectedDisciplineIds,
        ambiguityResolutions: parsed.data.ambiguityResolutions,
        limit: basePlanDisciplineLimit,
        isUnlimited: res.locals.unlimitedUserUsage === true
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
