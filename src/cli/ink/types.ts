import type { SlashMenuState } from "../slash-menu";
import type { ComposerContext, PickerItem, PickerSpec, RichLine, RunStatus, UIOptions } from "../ui-contract";
import type { TaskPlan } from "../../shared/schemas";

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
  readonly prompt: string;
  readonly text: string;
  readonly cursor: number;
  readonly fresh: boolean;
  readonly pendingInput: readonly string[];
  readonly inputHint: string | null;
  readonly menu: SlashMenuState;
  readonly picker: { spec: PickerSpec; items: readonly PickerItem[]; index: number } | null;
  readonly now: number;
}
