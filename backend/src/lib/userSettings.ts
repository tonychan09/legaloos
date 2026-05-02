import { pool } from "./db";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    if (apiKeys.azure?.trim()) return "azure/gpt-4o-mini";
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(userId: string): Promise<UserModelSettings> {
    const result = await pool.query(
        `SELECT tabular_model, claude_api_key, gemini_api_key, azure_api_key, azure_endpoint
         FROM user_profiles WHERE user_id = $1`,
        [userId],
    );
    const data = result.rows[0] as {
        tabular_model: string | null;
        claude_api_key: string | null;
        gemini_api_key: string | null;
        azure_api_key: string | null;
        azure_endpoint: string | null;
    } | undefined;

    const api_keys: UserApiKeys = {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
        azure: data?.azure_api_key ?? null,
        azureEndpoint: data?.azure_endpoint ?? null,
    };

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(userId: string): Promise<UserApiKeys> {
    const result = await pool.query(
        `SELECT claude_api_key, gemini_api_key, azure_api_key, azure_endpoint
         FROM user_profiles WHERE user_id = $1`,
        [userId],
    );
    const data = result.rows[0] as {
        claude_api_key: string | null;
        gemini_api_key: string | null;
        azure_api_key: string | null;
        azure_endpoint: string | null;
    } | undefined;
    return {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
        azure: data?.azure_api_key ?? null,
        azureEndpoint: data?.azure_endpoint ?? null,
    };
}
