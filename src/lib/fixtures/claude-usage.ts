// Synthetic ccusage 20.0.33 --by-agent shape. No user history or host identifiers.
type Model = { modelName: string; inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number; cost: number; missingPricing?: boolean };
export function claudeUsageDocument(period = "2026-05-03") {
  const claudeModels: Model[] = [
    { modelName: "anthropic/claude-example", inputTokens: 100, cacheReadTokens: 20, cacheCreationTokens: 5, outputTokens: 10, cost: 1.25 },
    { modelName: "other-vendor/example", inputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 2, cost: 0.5 },
    { modelName: "unpriced-example", inputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1, cost: 0, missingPricing: true },
    { modelName: "priced-zero-example", inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, cost: 0 },
  ];
  const opencodeModels: Model[] = [{ modelName: "anthropic/claude-example", inputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 2, cost: 9 }];
  return {
    daily: [{ period, agent: "all", metadata: { agents: ["claude", "opencode"] },
      agents: [
        { agent: "claude", inputTokens: 112, cacheReadTokens: 20, cacheCreationTokens: 5, outputTokens: 13, totalTokens: 150, totalCost: 1.75, modelsUsed: claudeModels.map((model) => model.modelName), modelBreakdowns: claudeModels },
        { agent: "opencode", inputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 2, totalTokens: 5, totalCost: 9, modelsUsed: ["anthropic/claude-example"], modelBreakdowns: opencodeModels },
      ],
      inputTokens: 115, cacheReadTokens: 20, cacheCreationTokens: 5, outputTokens: 15, totalTokens: 155, totalCost: 10.75,
      modelsUsed: [...claudeModels, ...opencodeModels].map((model) => model.modelName), modelBreakdowns: [...claudeModels, ...opencodeModels],
    }],
    totals: { inputTokens: 115, cacheReadTokens: 20, cacheCreationTokens: 5, outputTokens: 15, totalTokens: 155, totalCost: 10.75, unpricedModels: ["unpriced-example"] },
  };
}
