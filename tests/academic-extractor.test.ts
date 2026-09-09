import { describe, expect, it, vi } from "vitest";
import { CachedAcademicExtractor, FallbackAcademicExtractor, getApiErrorCode, getApiRequestId, type AcademicExtractor, type AcademicFile } from "../src/services/academic-extractor.js";

const files: AcademicFile[] = [{ buffer: Buffer.from("arquivo"), fileName: "plano.pdf", mimeType: "application/pdf" }];
const result = { disciplines: [{ documentTitle: "Plano", disciplineName: "Cálculo", disciplineCode: "", professor: "", term: "", classroom: "", schedule: "", recommendedColorHex: "#2563EB", events: [] }] };

describe("CachedAcademicExtractor", () => {
  it("reutiliza o resultado para arquivos idênticos", async () => {
    const extractDocuments = vi.fn().mockResolvedValue(result);
    const cached = new CachedAcademicExtractor({ extractDocuments }, 60_000, 10);
    await cached.extractDocuments(files);
    await cached.extractDocuments([{ ...files[0]!, fileName: "mesmo-conteudo-renomeado.pdf" }]);
    expect(extractDocuments).toHaveBeenCalledTimes(1);
  });

  it("compartilha uma análise que já está em andamento", async () => {
    let resolve!: (value: typeof result) => void;
    const pending = new Promise<typeof result>(done => { resolve = done; });
    const extractDocuments = vi.fn().mockReturnValue(pending);
    const cached = new CachedAcademicExtractor({ extractDocuments }, 60_000, 10);
    const first = cached.extractDocuments(files);
    const second = cached.extractDocuments(files);
    resolve(result);
    await Promise.all([first, second]);
    expect(extractDocuments).toHaveBeenCalledTimes(1);
  });
});

describe("FallbackAcademicExtractor", () => {
  it("usa o alternativo somente em falhas temporárias", async () => {
    const primary: AcademicExtractor = { extractDocuments: vi.fn().mockRejectedValue({ status: 503 }) };
    const fallback: AcademicExtractor = { extractDocuments: vi.fn().mockResolvedValue(result) };
    expect(await new FallbackAcademicExtractor(primary, fallback).extractDocuments(files)).toEqual(result);
    expect(fallback.extractDocuments).toHaveBeenCalledOnce();
  });

  it("não mascara erros permanentes", async () => {
    const primary: AcademicExtractor = { extractDocuments: vi.fn().mockRejectedValue({ status: 400 }) };
    const fallback: AcademicExtractor = { extractDocuments: vi.fn() };
    await expect(new FallbackAcademicExtractor(primary, fallback).extractDocuments(files)).rejects.toEqual({ status: 400 });
    expect(fallback.extractDocuments).not.toHaveBeenCalled();
  });
});

describe("diagnóstico seguro da API", () => {
  it("extrai código e request ID sem depender da classe do SDK", () => {
    const error = { status: 429, code: "insufficient_quota", requestID: "req_123", secret: "não deve ser registrado" };
    expect(getApiErrorCode(error)).toBe("insufficient_quota");
    expect(getApiRequestId(error)).toBe("req_123");
  });
});
