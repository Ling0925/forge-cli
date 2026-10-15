import { useSyncExternalStore } from "react";
import type { InputStore } from "./input-store";
import type { InkViewState } from "./types";
import { InkView } from "./view";

/** Input has one synchronous owner; React observes it without a second stdin listener. */
export function InkApp({ state, input }: { state: InkViewState; input: InputStore }) {
  const snapshot = useSyncExternalStore(input.subscribe, input.getSnapshot, input.getSnapshot);
  return <InkView state={state} input={snapshot} />;
}
