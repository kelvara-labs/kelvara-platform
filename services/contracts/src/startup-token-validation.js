const MIN_TOKEN_LENGTH = 32;

export function validateStartupTokens({ service, tokens }) {
  const seen = new Map();
  for (const { option, peer, value } of tokens) {
    if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH) {
      throw new Error(`${service} startup configuration invalid: ${option} must be at least ${MIN_TOKEN_LENGTH} characters for ${peer}`);
    }
    const previous = seen.get(value);
    if (previous) throw new Error(`${service} startup configuration invalid: ${previous.option} and ${option} must be distinct`);
    seen.set(value, { option });
  }
  return true;
}
