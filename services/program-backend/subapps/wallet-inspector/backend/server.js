import { createWalletInspectorApp } from "./app.js";
import { createWalletInspectorRuntime } from "./runtime.js";

const port = Number(process.env.WALLET_INSPECTOR_PORT || 7620);
const runtime = createWalletInspectorRuntime();
const app = createWalletInspectorApp({
  discoverAddress: runtime.discover,
  getAssurance: runtime.assure,
  inspectAddress: runtime.inspect,
  serviceUrls: {
    fixtureLab: process.env.FIXTURE_LAB_URL || "http://127.0.0.1:7630",
    alertConsole: process.env.ALERT_CONSOLE_URL || "http://127.0.0.1:7623",
  },
});

app.listen(port, "127.0.0.1", () => {
  console.log(`kelvara wallet inspector: http://127.0.0.1:${port}; mainnet=${runtime.clusters.mainnet.length}; devnet=${runtime.clusters.devnet.length}`);
});
