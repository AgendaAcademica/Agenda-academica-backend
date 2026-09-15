import { Router } from "express";
import { HttpError, type UsageStore } from "../usage/types.js";
import { reportCsv, summarize } from "../usage/report.js";

export function usageRouter(store: UsageStore): Router {
  const router = Router();
  router.get("/", async (req, res, next) => {
    try {
      const from = req.query.from, to = req.query.to;
      const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!validDate(from) || !validDate(to) || from > to || Date.parse(to) - Date.parse(from) >= 31 * 86_400_000)
        throw new HttpError(400, "INVALID_PERIOD", "Informe from e to como YYYY-MM-DD, em um intervalo de até 31 dias (UTC).");
      if (req.query.format !== undefined && req.query.format !== "json" && req.query.format !== "csv")
        throw new HttpError(400, "INVALID_FORMAT", "Use format=json ou format=csv.");
      const end = new Date(Date.parse(to) + 86_400_000).toISOString();
      const report = await store.report(`${from}T00:00:00.000Z`, end);
      res.setHeader("Cache-Control", "no-store");
      if (req.query.format === "csv") {
        res.type("text/csv").attachment(`consumo-${from}-${to}.csv`).send(reportCsv(report)); return;
      }
      res.json({ from, to, timezone: "UTC", currency: "USD", costType: "estimate", users: summarize(report), ...report });
    } catch (error) { next(error); }
  });
  return router;
}
