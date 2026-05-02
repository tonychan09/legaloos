import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { pool } from "../lib/db";
import { resolveModel, DEFAULT_TABULAR_MODEL } from "../lib/llm/models";

export const userRouter = Router();

const VALID_PROVIDERS = new Set(["claude", "gemini", "azure"]);

// POST /user/profile — upsert on first login
userRouter.post("/profile", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string;
    try {
        await pool.query(
            `INSERT INTO users (id, email) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
            [userId, userEmail],
        );
        await pool.query(
            `INSERT INTO user_profiles (user_id) VALUES ($1)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId],
        );
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    try {
        const result = await pool.query(
            `SELECT display_name, organisation, tier, message_credits_used,
                    credits_reset_date, tabular_model, claude_api_key,
                    gemini_api_key, azure_api_key, azure_endpoint
             FROM user_profiles WHERE user_id = $1`,
            [userId],
        );
        const row = result.rows[0];
        if (!row) {
            return void res.json({
                displayName: null,
                organisation: null,
                tier: "Free",
                messageCreditsUsed: 0,
                creditsResetDate: null,
                creditsRemaining: 999999,
                tabularModel: DEFAULT_TABULAR_MODEL,
                claudeApiKey: null,
                geminiApiKey: null,
                azureApiKey: null,
                azureEndpoint: null,
            });
        }
        res.json({
            displayName: row.display_name,
            organisation: row.organisation,
            tier: row.tier || "Free",
            messageCreditsUsed: row.message_credits_used,
            creditsResetDate: row.credits_reset_date,
            creditsRemaining: 999999 - (row.message_credits_used ?? 0),
            tabularModel: row.tabular_model || DEFAULT_TABULAR_MODEL,
            claudeApiKey: row.claude_api_key,
            geminiApiKey: row.gemini_api_key,
            azureApiKey: row.azure_api_key,
            azureEndpoint: row.azure_endpoint,
        });
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});

// PATCH /user/profile/display-name
userRouter.patch("/profile/display-name", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { displayName } = req.body;
    if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
        return void res.status(400).json({ detail: "displayName is required" });
    }
    try {
        await pool.query(
            `UPDATE user_profiles SET display_name = $1, updated_at = now()
             WHERE user_id = $2`,
            [displayName.trim(), userId],
        );
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});

// PATCH /user/profile/organisation
userRouter.patch("/profile/organisation", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    if (!("organisation" in req.body)) {
        return void res.status(400).json({ detail: "organisation field is required" });
    }
    const { organisation } = req.body;
    const value = organisation === null ? null : (organisation ?? "").trim() || null;
    try {
        await pool.query(
            `UPDATE user_profiles SET organisation = $1, updated_at = now()
             WHERE user_id = $2`,
            [value, userId],
        );
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});

// PATCH /user/profile/model
userRouter.patch("/profile/model", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { model } = req.body;
    if (!model) {
        return void res.status(400).json({ detail: "model is required" });
    }
    const resolved = resolveModel(model, "");
    if (!resolved) {
        return void res.status(400).json({ detail: "Unrecognised model ID" });
    }
    try {
        await pool.query(
            `UPDATE user_profiles SET tabular_model = $1, updated_at = now()
             WHERE user_id = $2`,
            [resolved, userId],
        );
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});

// PATCH /user/profile/api-key
userRouter.patch("/profile/api-key", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { provider, apiKey } = req.body;
    if (!provider) {
        return void res.status(400).json({ detail: "provider is required" });
    }
    if (!VALID_PROVIDERS.has(provider)) {
        return void res.status(400).json({ detail: "Unrecognised provider" });
    }
    const colMap: Record<string, string> = {
        claude: "claude_api_key",
        gemini: "gemini_api_key",
        azure: "azure_api_key",
    };
    const col = colMap[provider];
    const value = apiKey?.trim() || null;
    try {
        await pool.query(
            `UPDATE user_profiles SET ${col} = $1, updated_at = now()
             WHERE user_id = $2`,
            [value, userId],
        );
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});

// PATCH /user/profile/azure-endpoint
userRouter.patch("/profile/azure-endpoint", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    if (!("endpoint" in req.body)) {
        return void res.status(400).json({ detail: "endpoint field is required" });
    }
    const { endpoint } = req.body;
    const value = endpoint?.trim() || null;
    try {
        await pool.query(
            `UPDATE user_profiles SET azure_endpoint = $1, updated_at = now()
             WHERE user_id = $2`,
            [value, userId],
        );
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    try {
        await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
        res.status(204).send();
    } catch (err: any) {
        res.status(500).json({ detail: err.message });
    }
});
