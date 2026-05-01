import OpenAI from "openai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
} from "./types";

// Azure AI Foundry exposes an OpenAI-compatible chat completions API for all
// hosted models (OpenAI, Anthropic, Mistral, Meta, Microsoft, etc.).
// Users supply their Azure resource endpoint and API key; the model identifier
// is the Azure-side deployment/model name (e.g. "gpt-4o", "claude-sonnet-4-6").

function client(apiKey: string, endpoint: string): OpenAI {
    const base = endpoint.trim().replace(/\/$/, "");
    return new OpenAI({
        // The SDK requires a non-empty apiKey; Azure auth flows via the
        // "api-key" header instead of the standard Bearer token.
        apiKey: "azure",
        baseURL: base,
        defaultHeaders: { "api-key": apiKey.trim() },
    });
}

// Strip the "azure/" namespace prefix to get the bare model name Azure expects.
function nativeModel(model: string): string {
    return model.startsWith("azure/") ? model.slice("azure/".length) : model;
}

function toOpenAITools(
    tools: OpenAIToolSchema[],
): OpenAI.Chat.ChatCompletionTool[] {
    return tools as OpenAI.Chat.ChatCompletionTool[];
}

type AccumulatedToolCall = {
    id: string;
    name: string;
    argumentsJson: string;
};

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
    } = params;

    const azureKey = apiKeys?.azure?.trim();
    const azureEndpoint = apiKeys?.azureEndpoint?.trim();
    if (!azureKey || !azureEndpoint) {
        throw new Error(
            "Azure AI Foundry requires both an API key and an endpoint URL.",
        );
    }

    const maxIter = params.maxIterations ?? 10;
    const ai = client(azureKey, azureEndpoint);
    const oaiTools = toOpenAITools(tools);
    const modelName = nativeModel(model);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...params.messages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
    ];

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = await ai.chat.completions.create({
            model: modelName,
            messages,
            tools: oaiTools.length ? oaiTools : undefined,
            stream: true,
        });

        let iterText = "";
        const pendingCalls = new Map<number, AccumulatedToolCall>();

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
                iterText += delta.content;
                callbacks.onContentDelta?.(delta.content);
            }

            for (const tc of delta.tool_calls ?? []) {
                const idx = tc.index;
                if (!pendingCalls.has(idx)) {
                    pendingCalls.set(idx, {
                        id: tc.id ?? `call-${idx}`,
                        name: tc.function?.name ?? "",
                        argumentsJson: "",
                    });
                }
                const acc = pendingCalls.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.argumentsJson += tc.function.arguments;
            }
        }

        fullText += iterText;

        const toolCalls: NormalizedToolCall[] = [];
        const oaiToolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

        for (const acc of pendingCalls.values()) {
            let input: Record<string, unknown> = {};
            try {
                input = JSON.parse(acc.argumentsJson || "{}");
            } catch {
                input = {};
            }
            const normalized: NormalizedToolCall = {
                id: acc.id,
                name: acc.name,
                input,
            };
            callbacks.onToolCallStart?.(normalized);
            toolCalls.push(normalized);
            oaiToolCalls.push({
                id: acc.id,
                type: "function",
                function: { name: acc.name, arguments: acc.argumentsJson },
            });
        }

        if (!toolCalls.length || !runTools) break;

        const results = await runTools(toolCalls);

        messages.push({
            role: "assistant",
            content: iterText || null,
            tool_calls: oaiToolCalls,
        });
        for (const r of results) {
            messages.push({
                role: "tool",
                tool_call_id: r.tool_use_id,
                content: r.content,
            });
        }
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

    const ai = client(azureKey, azureEndpoint);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.user });

    const resp = await ai.chat.completions.create({
        model: nativeModel(params.model),
        messages,
        max_tokens: params.maxTokens ?? 512,
    });

    return resp.choices[0]?.message?.content ?? "";
}

export type { NormalizedToolResult };
