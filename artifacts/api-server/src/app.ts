import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  registerVoiceLiveHealthRoute,
  registerVoiceLiveSmokeRoute,
  registerVoiceLiveTelemetryRoute,
  registerVoiceLiveTokenRoute,
} from "./voice-live";
import { registerSessionRoute } from "./sessions";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// 256kb comfortably exceeds the /api/sessions route ceiling (200kb) so the
// route-level size check — not this middleware — owns the rejection path.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));

registerVoiceLiveTokenRoute(app);
registerVoiceLiveTelemetryRoute(app);
registerVoiceLiveHealthRoute(app);
registerVoiceLiveSmokeRoute(app);
registerSessionRoute(app);
app.use("/api", router);

// Serve the built frontend (single-origin deployment, e.g. Azure App Service).
// Only active when a `public` dir with an index.html sits next to the built
// server bundle — so this is a no-op in Replit dev/prod, where the frontend is
// served separately by the platform router.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = process.env["PUBLIC_DIR"] ?? path.resolve(moduleDir, "../public");
if (fs.existsSync(path.join(publicDir, "index.html"))) {
  logger.info({ publicDir }, "Serving frontend static assets");
  app.use(express.static(publicDir));
  // SPA fallback: any non-API GET/HEAD that didn't match a static file returns
  // index.html so client-side routing works on refresh/deep-links.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
