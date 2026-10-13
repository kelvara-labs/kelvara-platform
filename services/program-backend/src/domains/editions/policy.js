const LITE = Object.freeze({
  walletDiscovery: true,
  positionSummary: true,
  currentMonitorStatus: true,
  retrospectiveRuleHistory: true,
  historicalNearThresholds: true,
  evidenceLinks: true,
  assistedExit: true,
  rawAccountMatrix: false,
  instructionAnalytics: false,
  customRules: false,
  apiExport: false,
});

const PRO = Object.freeze({
  ...LITE,
  rawAccountMatrix: true,
  instructionAnalytics: true,
  customRules: true,
  apiExport: true,
});

export function getEditionCapabilities(edition) {
  if (edition === "lite") return { ...LITE };
  if (edition === "pro") return { ...PRO };
  throw new Error(`unknown edition: ${edition}`);
}
