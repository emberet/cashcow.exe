import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PROJECT_ROOT } from "../config/load.ts";
import { log } from "../util/log.ts";

/**
 * Two independent halt sources: a filesystem flag (survives restarts, and can be
 * tripped by an operator from another shell) and an in-process flag set by
 * SIGINT/SIGTERM.
 *
 * The asymmetry is deliberate and load-bearing: halting stops *new* launches
 * immediately, but never blocks an exit. Stranding an open dev position because
 * someone hit the brakes would turn a safety feature into the thing that loses
 * the money. `allowsPositionExits()` is therefore a constant, and exists as a
 * named function purely so that intent is legible at the call site.
 */

let inProcessHalt: string | undefined;
let handlersInstalled = false;

function resolveHaltPath(haltFile: string): string {
  return isAbsolute(haltFile) ? haltFile : resolve(PROJECT_ROOT, haltFile);
}

export class KillSwitch {
  readonly #path: string;

  constructor(haltFile: string) {
    this.#path = resolveHaltPath(haltFile);
  }

  get path(): string {
    return this.#path;
  }

  isHalted(): boolean {
    return inProcessHalt !== undefined || existsSync(this.#path);
  }

  haltReason(): string | undefined {
    if (inProcessHalt) return inProcessHalt;
    if (!existsSync(this.#path)) return undefined;
    try {
      return readFileSync(this.#path, "utf8").trim() || "halt file present";
    } catch {
      return "halt file present";
    }
  }

  /** Trip the brake. Persists across restarts. */
  halt(reason: string): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${new Date().toISOString()} ${reason}\n`, "utf8");
    log.warn("HALTED: new launches stopped; open positions will still exit", { reason });
  }

  resume(): void {
    inProcessHalt = undefined;
    if (existsSync(this.#path)) rmSync(this.#path);
    log.info("resumed: new launches re-enabled");
  }

  /** Gate for anything that opens new exposure. */
  allowsNewLaunches(): boolean {
    return !this.isHalted();
  }

  /**
   * Gate for anything that closes existing exposure. Always true, by design --
   * see the note at the top of this file.
   */
  allowsPositionExits(): boolean {
    return true;
  }

  /**
   * SIGINT/SIGTERM stop new launches but let the current tick drain so open
   * positions get a chance to exit cleanly. A second signal exits immediately.
   */
  installSignalHandlers(onDrain?: () => void): void {
    if (handlersInstalled) return;
    handlersInstalled = true;

    let signalled = false;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        if (signalled) {
          log.error(`${sig} again: exiting immediately, open positions may be left unmanaged`);
          process.exit(130);
        }
        signalled = true;
        inProcessHalt = `${sig} received`;
        log.warn(`${sig}: no new launches; draining open positions. Signal again to force quit.`);
        onDrain?.();
      });
    }
  }
}

/** Test helper. */
export function __resetInProcessHalt(): void {
  inProcessHalt = undefined;
}
