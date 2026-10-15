import { useLayoutEffect, useRef } from "react";
import { useStdout } from "ink";

export interface CommittedOutput { readonly id: number; readonly chunks: readonly string[] }
/** Ink clears/restores its live region; it need not retain all historical Static bytes. */
export function Committed({ output }: { output?: CommittedOutput | undefined }) {
  const { write } = useStdout();
  const delivered = useRef(-1);
  useLayoutEffect(() => {
    if (!output || delivered.current === output.id) return;
    delivered.current = output.id;
    for (const chunk of output.chunks) write(chunk);
  }, [output, write]);
  return null;
}
