import type { GenerateContentResponse } from "@google/genai";
import { extractedDocumentSchema } from "../schemas/academic.schema.js";
import { HttpError } from "../usage/types.js";
export class InvalidGeminiResponse extends HttpError {
  constructor(code: string, readonly recoverable = true) {
    super(503, code, "A inteligência artificial não conseguiu concluir a leitura. Tente novamente em instantes.");
  }
}
export function parseGeminiResponse(response: GenerateContentResponse) {
  const reason = response.candidates?.[0]?.finishReason;
  if (reason === "MAX_TOKENS") throw new InvalidGeminiResponse("AI_OUTPUT_TRUNCATED");
  if (response.promptFeedback?.blockReason || (reason && reason !== "STOP"))
    throw new InvalidGeminiResponse("AI_OUTPUT_BLOCKED", false);
  if (!response.text?.trim()) throw new InvalidGeminiResponse("AI_EMPTY_RESPONSE");
  let json: unknown;
  try { json = JSON.parse(response.text); }
  catch { throw new InvalidGeminiResponse("AI_INVALID_JSON"); }
  const parsed = extractedDocumentSchema.safeParse(json);
  if (!parsed.success) throw new InvalidGeminiResponse("AI_INVALID_SCHEMA");
  return parsed.data;
}
