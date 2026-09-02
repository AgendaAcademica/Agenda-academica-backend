import { Router } from "express";
import multer from "multer";
import type { AcademicExtractor } from "../services/gemini.service.js";

const supportedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

function hasValidSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "application/pdf") return buffer.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  return false;
}

export function documentsRouter(extractor: AcademicExtractor, maxMb: number): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.floor(maxMb * 1024 * 1024), files: 1 } });

  router.post("/extract", upload.single("file"), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Envie um PDF ou imagem no campo 'file'." });
        return;
      }
      if (!supportedMimeTypes.has(req.file.mimetype) || !hasValidSignature(req.file.buffer, req.file.mimetype)) {
        res.status(415).json({ error: "O arquivo deve ser um PDF, JPEG, PNG ou WebP válido." });
        return;
      }
      const data = await extractor.extractDocument(req.file.buffer, req.file.originalname, req.file.mimetype);
      res.json({ data, meta: { fileName: req.file.originalname, fileSize: req.file.size, eventsCount: data.events.length, mimeType: req.file.mimetype } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
