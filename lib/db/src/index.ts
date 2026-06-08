import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Decide how to connect to Postgres. We prefer a single DATABASE_URL (used in
// Replit dev and anywhere a full connection string is available). When that is
// missing, we fall back to the discrete variables that Azure App Service
// injects for a linked PostgreSQL resource (AZURE_POSTGRESQL_*).
function buildPoolConfig(): pg.PoolConfig {
  const url = process.env.DATABASE_URL;
  if (url && url.trim() !== "") {
    return { connectionString: url };
  }

  const host = process.env.AZURE_POSTGRESQL_HOST;
  const user = process.env.AZURE_POSTGRESQL_USER;
  const password = process.env.AZURE_POSTGRESQL_PASSWORD;
  const database = process.env.AZURE_POSTGRESQL_DATABASE;

  if (host && user && password && database) {
    let port = 5432;
    if (process.env.AZURE_POSTGRESQL_PORT) {
      port = Number(process.env.AZURE_POSTGRESQL_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
          `AZURE_POSTGRESQL_PORT must be an integer between 1 and 65535, got "${process.env.AZURE_POSTGRESQL_PORT}".`,
        );
      }
    }
    // Azure Postgres requires TLS. Allow it to be turned off explicitly, but
    // default to SSL with a relaxed chain check (Azure uses its own CA).
    const sslSetting = (process.env.AZURE_POSTGRESQL_SSL ?? "").toLowerCase();
    const sslDisabled = sslSetting === "false" || sslSetting === "disable";
    return {
      host,
      port,
      user,
      password,
      database,
      ssl: sslDisabled ? undefined : { rejectUnauthorized: false },
    };
  }

  throw new Error(
    "No database configuration found. Set DATABASE_URL, or provide the Azure " +
      "settings AZURE_POSTGRESQL_HOST, AZURE_POSTGRESQL_USER, " +
      "AZURE_POSTGRESQL_PASSWORD and AZURE_POSTGRESQL_DATABASE.",
  );
}

export const pool = new Pool(buildPoolConfig());
export const db = drizzle(pool, { schema });

export * from "./schema";
