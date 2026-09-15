import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request } from "express";
import type { StorageEngine } from "multer";
import { HttpError } from "../usage/types.js";

export function boundedMemoryStorage(maxTotalBytes: number): StorageEngine {
  const totals = new WeakMap<Request, number>();
  return {
    _handleFile(req, file, callback) {
      const chunks: Buffer[] = []; let size = 0;
      const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
        const total = (totals.get(req) ?? 0) + chunk.length;
        totals.set(req, total);
        if (total > maxTotalBytes) { done(new HttpError(413, "UPLOAD_TOO_LARGE", "O tamanho total dos arquivos excede o limite permitido.")); return; }
        chunks.push(chunk); size += chunk.length; done();
      } });
      pipeline(file.stream, sink).then(() => callback(null, { buffer: Buffer.concat(chunks, size), size }), error => callback(error));
    },
    _removeFile(_req, file, callback) { delete (file as Partial<Express.Multer.File>).buffer; callback(null); }
  };
}
