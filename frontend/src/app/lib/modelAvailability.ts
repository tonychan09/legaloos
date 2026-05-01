import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini" | "azure";

export function getModelProvider(modelId: string): ModelProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    if (model.group === "Anthropic") return "claude";
    if (model.group === "Azure") return "azure";
    return "gemini";
}

type ApiKeys = {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    azureApiKey: string | null;
};

export function isModelAvailable(modelId: string, apiKeys: ApiKeys): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    if (provider === "claude") return !!apiKeys.claudeApiKey?.trim();
    if (provider === "azure") return !!apiKeys.azureApiKey?.trim();
    return !!apiKeys.geminiApiKey?.trim();
}

export function isProviderAvailable(provider: ModelProvider, apiKeys: ApiKeys): boolean {
    if (provider === "claude") return !!apiKeys.claudeApiKey?.trim();
    if (provider === "azure") return !!apiKeys.azureApiKey?.trim();
    return !!apiKeys.geminiApiKey?.trim();
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "azure") return "Azure AI Foundry";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "Azure") return "azure";
    return "gemini";
}
