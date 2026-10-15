import type { HarnessService } from "../../shared/contracts";
import type { SessionSnapshot } from "../../shared/schemas";
import { isActiveSession } from "./pickers";

/** Observe persisted state only: never starts, attaches to, or cancels a run. */
export function watchResumedSession(
  initial: SessionSnapshot,
  service: Pick<HarnessService, "getSession">,
  signal: AbortSignal,
  update: (snapshot: SessionSnapshot) => void,
  failed: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  };
  const schedule = () => {
    if (stopped || signal.aborted) return;
    timer = setTimeout(() => {
      void service.getSession(initial.id).then(snapshot => {
        if (stopped || signal.aborted) return;
        update(snapshot);
        if (isActiveSession(snapshot.status)) schedule();
        else stop();
      }).catch(() => {
        if (stopped || signal.aborted) return;
        stop();
        failed();
      });
    }, 1000);
    timer.unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted || !isActiveSession(initial.status)) stop();
  else schedule();
  return stop;
}
