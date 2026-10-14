/** Decimal k/m units shared by live status and context capacity. */
export const compactTokens = (tokens: number): string => {
  const unit = tokens >= 1_000_000 ? "m" : "k";
  const value = tokens / (unit === "m" ? 1_000_000 : 1_000);
  return `${Number(value.toFixed(unit === "m" ? 2 : 1))}${unit}`;
};

