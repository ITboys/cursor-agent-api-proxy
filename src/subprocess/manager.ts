/**
 * Cursor CLI (agent) Subprocess Manager.
 *
 * Spawns `agent -p --output-format stream-json --stream-partial-output --yolo`
 * and emits normalized events: content_delta, result, error, close.
 *
 * Supports two-phase initialization for process pooling:
 *   1. preSpawn() — spawn the process, set up I/O, but don't write to stdin
 *   2. start()   — write prompt to an already-warm process (or do full spawn+write)
 *
 * The prompt is piped via stdin to avoid shell argument length limits.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import type { CursorCliMessage } from "../types/cursor-cli.js";
import {
  isSystemInit,
  isAssistantMessage,
  isToolCallMessage,
  isResultMessage,
} from "../types/cursor-cli.js";

const IS_WIN = process.platform === "win32";
const DEFAULT_TIMEOUT = 300_000; // 5 minutes
/** Brief settle after spawn — agent init happens on first prompt, not at spawn. */
const PREWARM_SETTLE_MS = Math.max(
  0,
  parseInt(process.env.CURSOR_PREWARM_SETTLE_MS ?? "500", 10) || 500
);
const DEBUG = !!process.env.CURSOR_DEBUG;

export interface SubprocessOptions {
  model: string;
  apiKey?: string;
  cwd?: string;
  timeout?: number;
  /** Skip post-spawn settle (used for on-demand cold acquire). */
  skipSettle?: boolean;
}

export interface ContentDeltaEvent {
  text: string;
}

export interface ResultEvent {
  text: string;
  model: string;
}

/**
 * Maximum number of prompts a single CursorSubprocess can handle before
 * being recycled. The agent CLI accumulates conversation context with
 * each turn, so we eventually refresh to keep it lightweight.
 */
const MAX_TURNS = 5;

export class CursorSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled = false;
  private detectedModel = "cursor-auto";
  private turnBuffer = "";
  private isWarm = false;

  /** Number of successful prompts this process has handled. */
  private turnCount = 0;

  /** Buffer that holds stdout data between writes (for keep-alive mode). */
  private stdoutBuffer = "";

  /** Resolver for the current prompt's start() promise (keep-alive mode). */
  private pendingResolve: (() => void) | null = null;

  /** Rejecter for the current prompt's start() promise (keep-alive mode). */
  private pendingReject: ((err: Error) => void) | null = null;

  /**
   * Phase 1: spawn the agent process with the right API key and model args,
   * but DON'T write to stdin yet. The process sits idle waiting for input.
   * After this, call `start(prompt)` to send the actual prompt.
   */
  async preSpawn(options: SubprocessOptions): Promise<void> {
    if (this.process) return; // already spawned

    return new Promise<void>((resolve, reject) => {
      try {
        const env = { ...process.env };
        if (options.apiKey) {
          env.CURSOR_API_KEY = options.apiKey;
        }

        const args = this.buildArgs(options);
        this.process = spawn("agent", args, {
          cwd: options.cwd ?? process.cwd(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: IS_WIN,
        });

        // No request timeout while warm — idle pre-spawned processes must not
        // be killed after 5 min (was causing cold starts and pool stat drift).

        this.process.on("error", (err) => {
          this.clearTimer();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                IS_WIN
                  ? "Cursor CLI (agent) not found. Install: irm 'https://cursor.com/install?win32=true' | iex"
                  : "Cursor CLI (agent) not found. Install: curl https://cursor.com/install -fsS | bash"
              )
            );
          } else {
            reject(err);
          }
        });

        // Set up stdout handler for streaming response parsing
        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.stdoutBuffer += chunk.toString();
          this.buffer += chunk.toString();
          this.processBuffer();
        });

        this.process.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) {
            console.error("[CursorSubprocess stderr]", text.slice(0, 500));
          }
        });

        this.process.on("close", (code) => {
          this.clearTimer();
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
          // If there's a pending request, reject it
          if (this.pendingReject) {
            this.pendingReject(new Error(`Process exited with code ${code}`));
            this.pendingReject = null;
            this.pendingResolve = null;
          }
        });

        this.isWarm = true;

        // Brief settle so the OS finishes fork/exec; agent CLI init runs on first prompt.
        const settleMs = options.skipSettle ? 0 : PREWARM_SETTLE_MS;
        if (settleMs > 0) {
          setTimeout(() => {
            if (this.isKilled || !this.process || this.process.exitCode !== null) {
              reject(new Error("Agent process exited during warm-up"));
              return;
            }
            resolve();
          }, settleMs).unref();
        } else {
          resolve();
        }
      } catch (err) {
        this.clearTimer();
        reject(err);
      }
    });
  }

  /**
   * Phase 2: send the prompt to the process and await response events.
   *
   * If preSpawn() was called first, this reuses the already-spawned process
   * and just writes the prompt to stdin — skipping the ~10-15s CLI startup.
   *
   * If preSpawn() was NOT called, falls back to the original full spawn+write.
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    if (this.isKilled || !this.process) {
      // Dead process — do full spawn
      this.cleanup();
      this.isWarm = false;
      this.turnCount = 0;
      await this.preSpawn(options);
    }

    if (this.turnCount >= MAX_TURNS) {
      // Recycled too many times — kill and spawn fresh
      console.error(`[CursorSubprocess] Recycling after ${MAX_TURNS} turns`);
      this.kill();
      this.cleanup();
      this.isWarm = false;
      this.turnCount = 0;
      await this.preSpawn(options);
    }

    if (this.isWarm && this.process) {
      // Warm path: already spawned, just write prompt and signal end
      // We write the prompt then close stdin. The agent processes it and
      // exits. For keep-alive, we rely on the pool to re-spawn.
      this.resetTimer(options.timeout);
      this.buffer = "";
      this.turnBuffer = "";
      this.detectedModel = "cursor-auto";
      this.stdoutBuffer = "";
      this.isWarm = false;
      this.turnCount++;

      this.process.stdin?.write(prompt);
      this.process.stdin?.end();
      return;
    }

    // Cold path: original full spawn + write
    this.turnCount = 1;
    await this.preSpawn(options);
    this.process!.stdin?.write(prompt);
    this.process!.stdin?.end();
    this.isWarm = false;
  }

  /** Reset the timeout timer (used when switching from warm to active). */
  private resetTimer(timeout?: number): void {
    this.clearTimer();
    const ttl = timeout ?? DEFAULT_TIMEOUT;
    this.timeoutId = setTimeout(() => {
      if (!this.isKilled) {
        this.isKilled = true;
        this.process?.kill(IS_WIN ? undefined : "SIGTERM");
        this.emit("error", new Error(`Request timed out after ${ttl}ms`));
      }
    }, ttl);
  }

  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--yolo",
    ];

    if (options.model && options.model !== "auto") {
      args.push("--model", options.model);
    }

    return args;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg: CursorCliMessage = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch {
        this.emit("raw", trimmed);
      }
    }
  }

  private handleMessage(msg: CursorCliMessage): void {
    if (DEBUG) {
      console.error("[debug]", JSON.stringify(msg).slice(0, 300));
    }

    if (isSystemInit(msg)) {
      if (msg.model) this.detectedModel = msg.model;
      return;
    }

    if (isAssistantMessage(msg)) {
      const text = msg.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

      if (!text) return;

      if (text === this.turnBuffer) return;

      if (text.startsWith(this.turnBuffer)) {
        const diff = text.slice(this.turnBuffer.length);
        if (diff) this.emit("content_delta", { text: diff } as ContentDeltaEvent);
        this.turnBuffer = text;
        return;
      }

      this.emit("content_delta", { text } as ContentDeltaEvent);
      this.turnBuffer += text;
      return;
    }

    if (isToolCallMessage(msg)) {
      this.turnBuffer = "";
      return;
    }

    if (isResultMessage(msg)) {
      const result: ResultEvent = {
        text: msg.result ?? "",
        model: this.detectedModel,
      };
      this.emit("result", result);
      return;
    }
  }

  private clearTimer(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  kill(): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimer();
      // Resolve pending so acquirer doesn't hang
      if (this.pendingResolve) {
        this.pendingResolve();
        this.pendingResolve = null;
        this.pendingReject = null;
      }
      if (IS_WIN) {
        this.process.kill();
      } else {
        this.process.kill("SIGTERM");
      }
    }
  }

  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }

  /** True if this subprocess was pre-spawned and is waiting for a prompt. */
  isWarmProcess(): boolean {
    return this.isWarm && this.process !== null && !this.isKilled;
  }

  /** Max turns this process can handle before recycle. */
  getMaxTurns(): number {
    return MAX_TURNS;
  }

  private cleanup(): void {
    if (this.process) {
      this.process.removeAllListeners();
      this.process = null;
    }
    this.buffer = "";
    this.turnBuffer = "";
    this.stdoutBuffer = "";
    this.detectedModel = "cursor-auto";
    this.isWarm = false;
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}

export async function verifyCursorCli(): Promise<{
  ok: boolean;
  error?: string;
  version?: string;
}> {
  return new Promise((resolve) => {
    const proc = spawn("agent", ["--version"], { stdio: "pipe", shell: IS_WIN });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          IS_WIN
          ? "Cursor CLI (agent) not found. Install: irm 'https://cursor.com/install?win32=true' | iex"
          : "Cursor CLI (agent) not found. Install: curl https://cursor.com/install -fsS | bash",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Cursor CLI (agent) returned non-zero exit code",
        });
      }
    });
  });
}
