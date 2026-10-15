export interface DockLayout {
  readonly total: number;
  readonly editor: number;
  readonly menu: number;
  readonly extras: number;
  readonly tail: number;
  readonly picker: number;
}
/** One geometry policy; terminal height is the constraint, not an arbitrary 20-row cap. */
export function dockLayout(rows: number, editorHeight: number, extraCount: number, menu: boolean, picker: boolean, tail: boolean): DockLayout {
  const total = Math.max(0, Math.floor(rows) - 1);
  if (picker) {
    const tailRows = tail && total >= 8 ? Math.min(3, Math.floor(total / 4)) : 0;
    return { total, editor: 0, menu: 0, extras: 0, tail: tailRows, picker: total - tailRows };
  }
  const editor = Math.min(editorHeight, total);
  let remaining = total - editor;
  const reservedTail = tail && remaining >= 2 ? Math.max(1, Math.floor(remaining / 3)) : 0;
  const menuRows = menu ? Math.min(9, Math.max(0, remaining - reservedTail - Number(extraCount > 0))) : 0;
  remaining -= menuRows;
  const extras = Math.min(extraCount, Math.max(0, remaining - reservedTail));
  return { total, editor, menu: menuRows, extras, tail: remaining - extras, picker: 0 };
}
