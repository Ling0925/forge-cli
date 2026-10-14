export type EditOp = "equal" | "delete" | "insert";

export interface EditStep {
  readonly op: EditOp;
  readonly text: string;
}

/** Myers shortest edit script. Huge rewrites return null for a fallback hunk. */
export const editScript = (
  before: readonly string[],
  after: readonly string[],
): readonly EditStep[] | null => {
  const cells = before.length * after.length;
  if (cells > 32_000 || before.length + after.length > 4_000) return null;
  const max = before.length + after.length;
  const offset = max;
  const trace: Int32Array[] = [];
  const vector = new Int32Array(2 * max + 1);
  let done = -1;
  for (let depth = 0; depth <= max && done < 0; depth += 1) {
    trace.push(new Int32Array(vector));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down =
        diagonal === -depth ||
        (diagonal !== depth &&
          (vector[offset + diagonal - 1] ?? 0) <
            (vector[offset + diagonal + 1] ?? 0));
      let x = down
        ? (vector[offset + diagonal + 1] ?? 0)
        : (vector[offset + diagonal - 1] ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      vector[offset + diagonal] = x;
      if (x >= before.length && y >= after.length) {
        done = depth;
        break;
      }
    }
  }
  if (done < 0) return null;
  const steps: EditStep[] = [];
  let x = before.length;
  let y = after.length;
  for (let depth = done; depth > 0; depth -= 1) {
    const snapshot = trace[depth];
    if (!snapshot) return null;
    const diagonal = x - y;
    const down =
      diagonal === -depth ||
      (diagonal !== depth &&
        (snapshot[offset + diagonal - 1] ?? 0) <
          (snapshot[offset + diagonal + 1] ?? 0));
    const previous = down ? diagonal + 1 : diagonal - 1;
    const previousX = snapshot[offset + previous] ?? 0;
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      steps.push({ op: "equal", text: before[x] ?? "" });
    }
    if (down) {
      y -= 1;
      steps.push({ op: "insert", text: after[y] ?? "" });
    } else {
      x -= 1;
      steps.push({ op: "delete", text: before[x] ?? "" });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    steps.push({ op: "equal", text: before[x] ?? "" });
  }
  return steps.reverse();
};
