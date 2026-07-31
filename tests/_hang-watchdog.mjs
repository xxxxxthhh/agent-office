// The aggregate suite has intermittently hung with the runner idle on an open
// handle. This watchdog converts that silent hang into a diagnosed failure:
// the timer is unref'd, so it can only ever fire when some OTHER ref'd handle
// is keeping the event loop alive long after any test in this repo should have
// finished — exactly the hang condition. It then names the culprit handles.
const HANG_LIMIT_MS = 120_000;

const watchdog = setTimeout(() => {
  console.error(`\n[hang-watchdog] test file still alive after ${HANG_LIMIT_MS} ms`);
  try {
    console.error(`[hang-watchdog] active resources: ${process.getActiveResourcesInfo().join(", ")}`);
  } catch { /* older node */ }
  try {
    for (const handle of process._getActiveHandles()) {
      const name = handle?.constructor?.name ?? String(handle);
      const detail = name === "ChildProcess" && handle.pid ? ` pid=${handle.pid}` : "";
      console.error(`[hang-watchdog] handle: ${name}${detail}`);
    }
  } catch { /* private API may vanish */ }
  process.exit(3);
}, HANG_LIMIT_MS);
watchdog.unref();
