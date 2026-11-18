import { Router } from "express";
import multer from "multer";
import { CachedAcademicExtractor, type AcademicExtractor, type ExtractionRunner } from "../services/academic-extractor.js";
import type { UsageService } from "../usage/meter.js";
import { boundedMemoryStorage } from "./upload-storage.js";
import { PersistentAcademicExtractor } from "../services/document-cache.js";

const supportedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

function hasValidSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "application/pdf") return buffer.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  return false;
}

export function documentsRouter(extractor: AcademicExtractor, maxMb: number, usage: UsageService, maxTotalMb: number): Router {
  const router = Router();
  const upload = multer({ storage: boundedMemoryStorage(Math.floor(maxTotalMb * 1024 * 1024)), limits: { fileSize: Math.floor(maxMb * 1024 * 1024), files: 10, fields: 0, parts: 11 } });

  router.post("/extract", upload.fields([{ name: "file", maxCount: 1 }, { name: "files", maxCount: 10 }]), async (req, res, next) => {
    try {
      const grouped = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const files = [...(grouped.file ?? []), ...(grouped.files ?? [])];
      if (files.length === 0) {
        res.status(400).json({ error: "Envie um PDF ou imagem no campo 'file'." });
        return;
      }
      if (files.some(file => !supportedMimeTypes.has(file.mimetype) || !hasValidSignature(file.buffer, file.mimetype))) {
        res.status(415).json({ error: "O arquivo deve ser um PDF, JPEG, PNG ou WebP válido." });
        return;
      }
      if (files.length > 1 && files.some(file => !file.mimetype.startsWith("image/"))) {
        res.status(415).json({ error: "O envio múltiplo aceita somente imagens." });
        return;
      }
      res.locals.processingExtraction = true;
      const academicFiles = files.map(file => ({ buffer: file.buffer, fileName: file.originalname, mimeType: file.mimetype }));
      let operationId = "";
      let cache = "miss";
      const run: ExtractionRunner = async (cacheState, action) => {
        const result = await usage.run(res.locals.uid, files.length, files.reduce((sum, file) => sum + file.size, 0), action, cacheState, res.locals.unlimitedUserUsage === true);
        operationId = result.operationId;
        cache = result.cache;
        return result.data;
      };
      const data = extractor instanceof CachedAcademicExtractor || extractor instanceof PersistentAcademicExtractor
        ? await extractor.extractDocuments(academicFiles, run)
        : await run("miss", () => extractor.extractDocuments(academicFiles));
      const eventsCount = data.disciplines.reduce((sum, discipline) => sum + discipline.events.length, 0);
      res.json({ data, meta: { operationId, cache, fileName: files.map(file => file.originalname).join(", "), fileSize: files.reduce((sum, file) => sum + file.size, 0), filesCount: files.length, disciplinesCount: data.disciplines.length, eventsCount, mimeType: files.length === 1 ? files[0]!.mimetype : "multipart/images" } });
    } catch (error) {
      next(error);
    } finally {
      res.locals.releaseExtraction?.();
    }
  });

  return router;
}
