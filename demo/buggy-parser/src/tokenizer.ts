export type Token = { type: "literal"; value: string } | { type: "wildcard"; value: "*" };

export function tokenizePattern(pattern: string): Token[] {
  const tokens: Token[] = [];

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      tokens.push({ type: "wildcard", value: "*" });
      continue;
    }

    if (char === "\\") {
      const escaped = pattern[index + 1];

      // A backslash at the end of the pattern has nothing to escape:
      // treat it as a literal backslash instead of crashing.
      if (escaped === undefined) {
        tokens.push({ type: "literal", value: "\\" });
        continue;
      }

      tokens.push({ type: "literal", value: escaped.toLowerCase() });
      index += 1;
      continue;
    }

    tokens.push({ type: "literal", value: char });
  }

  return tokens;
}

export function countWildcards(pattern: string): number {
  return tokenizePattern(pattern).filter((token) => token.type === "wildcard").length;
}
