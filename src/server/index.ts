/**
 * Express HTTP server setup.
 */

import express from "express";
import type { Server } from "http";
import {
  handleChatCompletions,
  handleModels,
  handleHealth,
  handleRoot,
  handlePostRoot,
  handleListAccounts,
  handleUpsertAccount,
  handleDeleteAccount,
} from "./routes.js";
import { getAccountsManager } from "../account/manager.js";
import { getPool } from "../subprocess/pool.js";

let server: Server | null = null;

export interface ServerConfig {
  port?: number;
}

export async function startServer(
  config: ServerConfig = {}
): Promise<Server> {
  const port = config.port ?? 4646;
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS, DELETE"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Cursor-Account"
    );
    next();
  });

  app.options("*", (_req, res) => {
    res.sendStatus(204);
  });

  // OpenAI-compatible endpoints
  app.get("/", handleRoot);
  app.post("/", handlePostRoot);
  app.get("/health", handleHealth);
  app.post("/health", handleHealth);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  // Account management endpoints
  app.get("/v1/accounts", handleListAccounts);
  app.post("/v1/accounts", handleUpsertAccount);
  app.delete("/v1/accounts/:id", handleDeleteAccount);

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  return new Promise((resolve, reject) => {
    server = app.listen(port, async () => {
      const mgr = getAccountsManager(); // lazy init
      console.error(`Server listening on http://localhost:${port}`);
      console.error(
        `  Accounts: ${mgr.list().length} configured (default: ${mgr.getDefaultId() ?? "agent-login"})`
      );

      // Block until warm pool is ready — avoids cold starts on first requests after restart.
      try {
        await getPool().prewarmAll();
        const poolStats = getPool().stats();
        const warmCount = Object.values(poolStats).reduce((s, e) => s + e.alive, 0);
        if (warmCount > 0) {
          console.error(`  Pool: ${warmCount} warm process(es) ready`);
        } else {
          console.error(`  Pool: no accounts with API keys — skipping`);
        }
      } catch (err) {
        console.error(`  Pool pre-warm failed:`, err);
      }

      resolve(server!);
    });
    server.on("error", reject);
  });
}

export async function stopServer(): Promise<void> {
  // Shut down process pool first (kills warm agent processes)
  getPool().shutdown();

  if (server) {
    return new Promise((resolve) => {
      server!.close(() => {
        server = null;
        resolve();
      });
    });
  }
}

export function getServer(): Server | null {
  return server;
}
