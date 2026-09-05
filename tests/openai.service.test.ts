import { describe, expect, it } from "vitest";
import { shouldRetryOpenAIError, toOpenAIContent } from "../src/services/openai.service.js";

describe("OpenAI file input", () => {
  it("envia PDF como data URL Base64 aceita pela Responses API", () => {
    const content = toOpenAIContent({
      buffer: Buffer.from("%PDF-1.7 teste"),
      fileName: "plano.pdf",
      mimeType: "application/pdf"
    });

    expect(content).toEqual(expect.objectContaining({
      type: "input_file",
      filename: "plano.pdf",
      file_data: expect.stringMatching(/^data:application\/pdf;base64,[A-Za-z0-9+/]+=*$/)
    }));
  });

  it("mantém imagens como data URL no campo image_url", () => {
    const content = toOpenAIContent({
      buffer: Buffer.from("imagem"),
      fileName: "pagina.png",
      mimeType: "image/png"
    });

    expect(content).toEqual(expect.objectContaining({
      type: "input_image",
      image_url: expect.stringMatching(/^data:image\/png;base64,/)
    }));
  });

  it("não repete erros que exigem adicionar saldo ou alterar limites financeiros", () => {
    expect(shouldRetryOpenAIError({ status: 429, code: "credit_balance_exhausted" })).toBe(false);
    expect(shouldRetryOpenAIError({ status: 429, code: "project_spend_limit_exceeded" })).toBe(false);
    expect(shouldRetryOpenAIError({ status: 429, code: "rate_limit_exceeded" })).toBe(true);
  });
});
