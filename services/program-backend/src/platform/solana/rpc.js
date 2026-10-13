let nextId = 1;

export function createSolanaRpc(url, { name = "rpc", fetchImpl = fetch } = {}) {
  async function call(method, params) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`${name}: ${payload.error.message || "RPC error"}`);
    return payload.result;
  }

  return {
    name,
    async getAccount(address) {
      const result = await call("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
      if (!result?.value) throw new Error(`${name}: account_not_found`);
      const [encoded, encoding] = result.value.data || [];
      if (encoding !== "base64" || typeof encoded !== "string") throw new Error(`${name}: unsupported_account_encoding`);
      return {
        slot: result.context?.slot ?? null,
        owner: result.value.owner,
        executable: Boolean(result.value.executable),
        lamports: result.value.lamports,
        data: Buffer.from(encoded, "base64"),
      };
    },
    async getTokenAccounts(wallet, programId) {
      const result = await call("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      return result.value.map(row => {
        const info = row.account?.data?.parsed?.info;
        if (!info?.tokenAmount) throw new Error(`${name}: malformed token account response`);
        return {
          pubkey: row.pubkey,
          program: row.account.owner,
          slot: result.context?.slot ?? null,
          parsed: {
            mint: info.mint,
            owner: info.owner,
            amount: String(info.tokenAmount.amount),
            decimals: Number(info.tokenAmount.decimals),
          },
        };
      });
    },
    async getTokenAccount(address) {
      const result = await call("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
      const value = result?.value;
      const info = value?.data?.parsed?.info;
      if (!info?.tokenAmount || !info.mint || !info.owner) return null;
      return {
        pubkey: address,
        program: value.owner,
        slot: result.context?.slot ?? null,
        parsed: {
          mint: info.mint,
          owner: info.owner,
          amount: String(info.tokenAmount.amount),
          decimals: Number(info.tokenAmount.decimals),
        },
      };
    },
  };
}
