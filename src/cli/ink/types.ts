import type { ComposerContext, RichLine, RunStatus, UIOptions } from "../ui-contract";
import type { TaskPlan } from "../../shared/schemas";

/** Output state only. Input focus is an independent React external store. */
export interface InkViewState {
  readonly columns: number;
  readonly rows: number;
  readonly history: readonly { id: number; line: RichLine }[];
  readonly tail: readonly RichLine[];
  readonly status: RunStatus | null;
  readonly context: ComposerContext | null;
  readonly plan: TaskPlan | null;
  readonly mode: "build" | "plan";
  readonly theme: UIOptions["theme"];
  readonly noColor: boolean;
  readonly pendingInput: readonly string[];
  readonly inputHint: string | null;
  readonly now: number;
}
