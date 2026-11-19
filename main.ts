// The entrypoint: how this process lives alongside the trial env.
//
// The env is the harness's coordinator. It starts this program with MAKEFUN_ENV_URL
// pointing at itself, and the program's whole job around the actual forge server is:
//   1. bind a port the kernel chooses (listen on 0) — never a fixed one;
//   2. announce that port with POST /register and the JSON body {"port": N};
//   3. ask GET /done, again and again, until it answers {"done": true};
//   4. close the server and exit 0.
// Registration is first-come: a 409 from /register means an earlier registration
// stands, which is success as far as this process is concerned. A 400 or 405 is a
// contract breach and fatal. Anything else — a refused connection while the env is
// still starting, a timeout, a 5xx — is retried with a growing pause, because
// leaving early would score worse than waiting.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL missing: no env to register with\n');
  process.exit(1);
}

const REQUEST_BUDGET_MS = 30_000;
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pause after `failures` consecutive failures: doubling, capped. */
function backoff(failures: number): number {
  return Math.min(LONGEST_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(failures, 8));
}

/**
 * Run `step` until it reports completion. `step` returns true when it is finished,
 * false when the env was not ready and the attempt should be repeated after a pause.
 * Errors thrown by `step` are treated as "not ready" unless `step` marks them fatal
 * by rethrowing a FatalStep (register uses that for its contract errors).
 */
class FatalStep extends Error {}

async function untilDone(step: () => Promise<boolean>): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let finished = false;
    try {
      finished = await step();
    } catch (err) {
      if (err instanceof FatalStep) throw err;
      finished = false;
    }
    if (finished) return;
    await pause(backoff(failures));
  }
}

async function announce(port: number): Promise<void> {
  await untilDone(async () => {
    const res = await fetch(`${envBase}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new FatalStep(`register answered HTTP ${res.status}: ${await res.text()}`);
    }
    return false;
  });
}

async function awaitEnd(): Promise<void> {
  await untilDone(async () => {
    const res = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  });
}

async function run(): Promise<void> {
  const server = createApp();
  const bound = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  const port = await bound;
  process.stdout.write(`[entry] listening on port ${port}\n`);
  await announce(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await awaitEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
