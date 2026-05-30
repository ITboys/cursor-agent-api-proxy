/**
 * Daemon process management: start / stop / restart / status.
 *
 * Spawns the server as a detached background process, writes PID to
 * ~/.cursor-agent-api/pid and logs to ~/.cursor-agent-api/server.log.
 */

import { spawn } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  openSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const STATE_DIR = join(homedir(), ".cursor-agent-api");
const LOG_FILE = join(STATE_DIR, "server.log");

/** Per-instance PID when CURSOR_INSTANCE_ACCOUNT is set; else global singleton pid. */
function getPidFile(): string {
  const account = process.env.CURSOR_INSTANCE_ACCOUNT;
  if (account) {
    return join(STATE_DIR, `pid-${account}.pid`);
  }
  return join(STATE_DIR, "pid");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getStandalonePath(): string {
  return join(__dirname, "..", "server", "standalone.js");
}

function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

function readPid(): number | null {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePidFile(): void {
  try {
    unlinkSync(getPidFile());
  } catch {}
}

/** Foreground server (e.g. systemd / run) — enables status/stop to find this process. */
export function registerForegroundPid(): void {
  ensureStateDir();
  writeFileSync(getPidFile(), String(process.pid));
}

export function daemonStatus(): void {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`cursor-agent-api is running (pid: ${pid}).`);
    console.log(`  Logs: ${LOG_FILE}`);
  } else {
    if (pid) removePidFile();
    console.log("cursor-agent-api is not running.");
    console.log("  Run `cursor-agent-api` to start.");
  }
}

export function daemonStop(): boolean {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("cursor-agent-api is not running.");
    removePidFile();
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid);
    } catch {}
  }

  let tries = 0;
  while (tries < 20 && isRunning(pid)) {
    const waitMs = 100;
    const start = Date.now();
    while (Date.now() - start < waitMs) {}
    tries++;
  }

  if (isRunning(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  removePidFile();
  console.log(`cursor-agent-api stopped (was pid: ${pid}).`);
  return true;
}

export { removePidFile as clearPidFile };

export function daemonStart(port?: number): void {
  const listenPort = port || parseInt(process.env.PORT || "", 10) || 4646;

  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`cursor-agent-api is already running (pid: ${existingPid}).`);
    console.log("Run `cursor-agent-api restart` to restart.");
    return;
  }

  removePidFile();
  ensureStateDir();

  const scriptPath = getStandalonePath();
  const args = ["--daemon-child", String(listenPort)];

  const logFd = openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  if (!child.pid) {
    console.error("Failed to start background process.");
    process.exit(1);
  }

  writeFileSync(getPidFile(), String(child.pid));
  child.unref();

  const base = `http://localhost:${listenPort}`;
  console.log(`
  ╭─ cursor-agent-api ───────────────────────╮
  │                                           │
  │  Status   : running (pid: ${String(child.pid).padEnd(14)}│
  │  Base URL : ${(base + "/v1").padEnd(29)}│
  │  Health   : ${(base + "/health").padEnd(29)}│
  │  Logs     : ~/.cursor-agent-api/server.log│
  │                                           │
  │  Stop     : cursor-agent-api stop         │
  │  Restart  : cursor-agent-api restart      │
  ╰───────────────────────────────────────────╯
`);
}

export function daemonRestart(port?: number): void {
  daemonStop();
  daemonStart(port);
}
