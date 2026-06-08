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

export default app;
