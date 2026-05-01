import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { toClaudeTools } from "./tools";

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [key: string]: unknown };

type NativeMessage = {
    role: "user" | "assistant";
    content: string | ContentBlock[];
};

const MAX_TOKENS = 16384;

// Azure AI Foundry uses the Anthropic Messages API format.
// The caller supplies the Azure endpoint URL (e.g.
// https://<resource>.services.ai.azure.com/models) and an Azure API key.
// The Anthropic SDK routes correctly when baseURL and apiKey are overridden.
function client(apiKey: string, endpoint: string): Anthropic {
    return new Anthropic({
        apiKey: apiKey.trim(),
        baseURL: endpoint.trim().replace(/\/$/, "") + "/",
        defaultHeaders: { "api-key": apiKey.trim() },
    });
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
): NativeMessage[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
}

// Strip the "azure-" prefix to derive the canonical Anthropic model name.
function resolveAzureModelName(model: string): string {
    return model.startsWith("azure-") ? model.slice("azure-".length) : model;
}

export async function streamAzure(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;

    const azureKey = apiKeys?.azure?.trim();
    const azureEndpoint = apiKeys?.azureEndpoint?.trim();
    if (!azureKey || !azureEndpoint) {
        throw new Error(
            "Azure AI Foundry requires both an API key and an endpoint URL.",
        );
    }

    const maxIter = params.maxIterations ?? 10;
    const anthropic = client(azureKey, azureEndpoint);
    const claudeTools = toClaudeTools(tools);
    const nativeModel = resolveAzureModelName(model);

    const messages: NativeMessage[] = toNativeMessages(params.messages);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = anthropic.messages.stream({
            model: nativeModel,
            system: systemPrompt,
            messages: messages as Anthropic.MessageParam[],
            tools: claudeTools.length
                ? (claudeTools as unknown as Tool[])
                : undefined,
            max_tokens: MAX_TOKENS,
            ...(enableThinking
                ? ({
                      thinking: { type: "adaptive" },
                      output_config: { effort: "high" },
                  } as unknown as Record<string, unknown>)
                : {}),
        });

        let sawThinking = false;

        stream.on("text", (delta) => {
            callbacks.onContentDelta?.(delta);
        });
        if (enableThinking) {
            stream.on("thinking", (delta) => {
                sawThinking = true;
                callbacks.onReasoningDelta?.(delta);
            });
        }

        const final = await stream.finalMessage();
        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        const stopReason = final.stop_reason;
        const assistantBlocks = final.content as ContentBlock[];

        const toolCalls: NormalizedToolCall[] = [];
        for (const block of assistantBlocks) {
            if (block.type === "text") {
                const txt = (block as { text: string }).text;
                if (typeof txt === "string") fullText += txt;
            } else if (block.type === "tool_use") {
                const tu = block as { id: string; name: string; input: unknown };
                const call: NormalizedToolCall = {
                    id: tu.id,
                    name: tu.name,
                    input: (tu.input as Record<string, unknown>) ?? {},
                };
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
            }
        }

        if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        messages.push({ role: "assistant", content: assistantBlocks });
        messages.push({
            role: "user",
            content: results.map((r) => ({
                type: "tool_result",
                tool_use_id: r.tool_use_id,
                content: r.content,
            })),
        });
    }

    return { fullText };
}

export async function completeAzureText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { azure?: string | null; azureEndpoint?: string | null };
}): Promise<string> {
    const azureKey = params.apiKeys?.azure?.trim();
    const azureEndpoint = params.apiKeys?.azureEndpoint?.trim();
    if (!azureKey || !azureEndpoint) {
        throw new Error(
            "Azure AI Foundry requires both an API key and an endpoint URL.",
        );
    }

    const anthropic = client(azureKey, azureEndpoint);
    const nativeModel = resolveAzureModelName(params.model);

    const resp = await anthropic.messages.create({
        model: nativeModel,
        max_tokens: params.maxTokens ?? 512,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.user }],
    });
    const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    return text;
}

export type { NormalizedToolResult };
