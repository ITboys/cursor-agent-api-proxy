#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Usage:
 *   cursor-agent-api                 Start in background (default)
 *   cursor-agent-api start [port]    Start in background
 *   cursor-agent-api stop            Stop background server
 *   cursor-agent-api restart [port]  Restart background server
 *   cursor-agent-api status          Check if running
 *   cursor-agent-api run [port]      Run in foreground (for debugging)
 *   cursor-agent-api install         Register as auto-start service
 *   cursor-agent-api uninstall       Remove auto-start service
 */

import { startServer, stopServer } from "./index.js";
import { setCachedCliVersion } from "./routes.js";
import { verifyCursorCli } from "../subprocess/manager.js";
import { installService, uninstallService } from "../service/install.js";
import {
  daemonStart,
  daemonStop,
  daemonRestart,
  daemonStatus,
  registerForegroundPid,
  clearPidFile,
} from "../service/daemon.js";
import { getAccountsManager } from "../account/manager.js";

const DEFAULT_PORT = 4646;

function parsePort(str: string | undefined): number {
  const portStr = str || process.env.PORT || String(DEFAULT_PORT);
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${portStr}`);
    process.exit(1);
  }
  return port;
}

function showHelp(): void {
  console.log(`Usage: cursor-agent-api [command] [port]

Commands:
  start [port]    Start in background (default if no command given)
  stop            Stop the background server
  restart [port]  Restart the background server
  status          Check if the server is running
  run [port]      Run in foreground (for debugging)
  install         Register as auto-start service (LaunchAgent / schtasks / systemd)
  uninstall       Remove auto-start service

Accounts:
  Configured in ~/.cursor-agent-api/accounts.json
  Or use REST API: POST /v1/accounts, GET /v1/accounts, DELETE /v1/accounts/:id
  Request header: X-Cursor-Account: <account-id>

Options:
  [port]          Listen port (default: 4646, or $PORT)
  -h, --help      Show this help`);
}

async function runForeground(port: number): Promise<void> {
  console.log("Checking Cursor CLI (agent)...");
  const check = await verifyCursorCli();
  if (check.ok) {
    console.log(`  Cursor CLI: ${check.version || "OK"}`);
    if (check.version) setCachedCliVersion(check.version);
  } else {
    console.error(`  ${check.error}`);
    console.error("\nPlease install and authenticate the Cursor CLI first:");
    if (process.platform === "win32") {
      console.error("  irm 'https://cursor.com/install?win32=true' | iex");
      console.error("  agent login");
    } else {
      console.error("  curl https://cursor.com/install -fsS | bash");
      console.error("  agent login");
    }
    process.exit(1);
  }

  // Show multi-account info
  const mgr = getAccountsManager();
  if (mgr.hasAccounts()) {
    console.log(`  Accounts: ${mgr.list().length} configured`);
    for (const a of mgr.list()) {
      console.log(`    ${a.default ? "* " : "  "}${a.id} (${a.name})`);
    }
  } else {
    console.log("  Accounts: none configured (using agent login or CURSOR_API_KEY)");
  }

  try {
    await startServer({ port });
    // Multi-instance mode: skip global PID file (each instance has its own pid file).
    if (!process.env.CURSOR_INSTANCE_ACCOUNT) {
      registerForegroundPid();
    }
    const base = `http://localhost:${port}`;
    console.log(`\n  Base URL : ${base}/v1`);
    console.log(`  Health   : ${base}/health`);
    console.log(`  Accounts : ${base}/v1/accounts`);
    console.log("\n  Headers for multi-account: X-Cursor-Account: <account-id>");
    console.log("  Press Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log("\nShutting down...");
    await stopServer();
    clearPidFile();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const arg2 = process.argv[3];

  // Internal flag: spawned by daemonStart(), run foreground directly
  if (cmd === "--daemon-child") {
    const port = parsePort(arg2);
    await runForeground(port);
    return;
  }

  switch (cmd) {
    case "stop":
      daemonStop();
      return;

    case "restart":
      daemonRestart(parsePort(arg2));
      return;

    case "status":
      daemonStatus();
      return;

    case "install":
      installService();
      return;

    case "uninstall":
      uninstallService();
      return;

    case "-h":
    case "--help":
      showHelp();
      return;

    case "run":
      await runForeground(parsePort(arg2));
      return;

    case "start":
      daemonStart(parsePort(arg2));
      return;

    default: {
      // No command or a port number → background start
      if (!cmd || /^\d+$/.test(cmd)) {
        daemonStart(parsePort(cmd));
      } else {
        console.error(`Unknown command: ${cmd}\n`);
        showHelp();
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
