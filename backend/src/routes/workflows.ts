import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { pool } from "../lib/db";

export const workflowsRouter = Router();

type WorkflowRecord = {
    id: string;
    user_id: string | null;
    is_system: boolean;
    [key: string]: unknown;
};

function withWorkflowAccess<T extends Record<string, unknown>>(
    workflow: T,
    access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
    return {
        ...workflow,
        allow_edit: access.allowEdit,
        is_owner: access.isOwner,
        shared_by_name: access.sharedByName ?? null,
    };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { type } = req.query as { type?: string };

    const params: unknown[] = [userId];
    let sql = `SELECT * FROM workflows WHERE user_id = $1 AND is_system = false`;
    if (type) {
        params.push(type);
        sql += ` AND type = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC`;

    const workflowsResult = await pool.query(sql, params).catch((e) => {
        res.status(500).json({ detail: e.message });
        return null;
    });
    if (!workflowsResult) return;
    const workflows = workflowsResult.rows as WorkflowRecord[];

    const hiddenResult = await pool.query(
        `SELECT workflow_id FROM hidden_workflows WHERE user_id = $1`,
        [userId],
    ).catch(() => ({ rows: [] as { workflow_id: string }[] }));
    const hiddenIds = new Set(
        (hiddenResult.rows as { workflow_id: string }[]).map((r) => r.workflow_id),
    );

    const visible = workflows.filter((wf) => !hiddenIds.has(wf.id));
    res.json(visible.map((wf) => withWorkflowAccess(wf, { allowEdit: true, isOwner: true })));
});

// POST /workflows
workflowsRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { title, type, prompt_md, promptMd, columns_config, practice } = req.body as {
        title: string;
        type: string;
        prompt_md?: string;
        promptMd?: string;
        columns_config?: unknown;
        practice?: string | null;
    };
    if (!title?.trim())
        return void res.status(400).json({ detail: "title is required" });
    if (!type?.trim())
        return void res.status(400).json({ detail: "type is required" });

    const resolvedPromptMd = prompt_md ?? promptMd ?? null;

    const r = await pool.query(
        `INSERT INTO workflows (user_id, title, type, prompt_md, columns_config, practice, is_system)
         VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *`,
        [userId, title.trim(), type, resolvedPromptMd, columns_config ? JSON.stringify(columns_config) : null, practice ?? null],
    ).catch((e) => { res.status(500).json({ detail: e.message }); return null; });
    if (!r) return;
    res.status(201).json(r.rows[0]);
});

async function handleWorkflowUpdate(req: import("express").Request, res: import("express").Response) {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;

    const wr = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [workflowId]).catch((e) => {
        res.status(500).json({ detail: e.message });
        return null;
    });
    if (!wr) return;
    const workflow = wr.rows[0] as WorkflowRecord | undefined;

    if (!workflow) return void res.status(404).json({ detail: "Workflow not found" });
    if (workflow.is_system || workflow.user_id !== userId)
        return void res.status(403).json({ detail: "Forbidden" });

    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, val: unknown) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (req.body.title != null) push("title", req.body.title);
    if (req.body.prompt_md != null) push("prompt_md", req.body.prompt_md);
    if (req.body.columns_config != null) push("columns_config", JSON.stringify(req.body.columns_config));
    if ("practice" in req.body) push("practice", req.body.practice ?? null);

    if (sets.length === 0) return void res.json(withWorkflowAccess(workflow, { allowEdit: true, isOwner: true }));

    vals.push(workflowId);
    const r = await pool.query(
        `UPDATE workflows SET ${sets.join(", ")} WHERE id = $${vals.length} AND is_system = false RETURNING *`,
        vals,
    ).catch((e) => { res.status(500).json({ detail: e.message }); return null; });
    if (!r) return;
    const data = r.rows[0];
    if (!data) return void res.status(404).json({ detail: "Workflow not found or not editable" });
    res.json(withWorkflowAccess(data, { allowEdit: true, isOwner: true }));
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, handleWorkflowUpdate);

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, handleWorkflowUpdate);

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;

    const wr = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [workflowId]).catch((e) => {
        res.status(500).json({ detail: e.message });
        return null;
    });
    if (!wr) return;
    const workflow = wr.rows[0] as WorkflowRecord | undefined;

    if (!workflow) return void res.status(404).json({ detail: "Workflow not found" });
    if (workflow.is_system || workflow.user_id !== userId)
        return void res.status(403).json({ detail: "Forbidden" });

    await pool.query(
        `DELETE FROM workflows WHERE id = $1`,
        [workflowId],
    ).catch((e) => { res.status(500).json({ detail: e.message }); });
    res.status(204).send();
});

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const r = await pool.query(
        `SELECT workflow_id FROM hidden_workflows WHERE user_id = $1`,
        [userId],
    ).catch((e) => { res.status(500).json({ detail: e.message }); return null; });
    if (!r) return;
    res.json(r.rows.map((row: { workflow_id: string }) => row.workflow_id));
});

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflow_id } = req.body as { workflow_id: string };
    if (!workflow_id?.trim())
        return void res.status(400).json({ detail: "workflow_id is required" });
    await pool.query(
        `INSERT INTO hidden_workflows (user_id, workflow_id) VALUES ($1, $2)
         ON CONFLICT (user_id, workflow_id) DO NOTHING`,
        [userId, workflow_id],
    ).catch((e) => res.status(500).json({ detail: e.message }));
    res.status(204).send();
});

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    await pool.query(
        `DELETE FROM hidden_workflows WHERE user_id = $1 AND workflow_id = $2`,
        [userId, workflowId],
    ).catch((e) => res.status(500).json({ detail: e.message }));
    res.status(204).send();
});

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;

    const wr = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [workflowId]);
    const workflow = wr.rows[0] as WorkflowRecord | undefined;
    if (!workflow) return void res.status(404).json({ detail: "Workflow not found" });

    if (workflow.user_id === userId) {
        return void res.json(withWorkflowAccess(workflow, { allowEdit: true, isOwner: true }));
    }

    const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
    if (!normalizedUserEmail) return void res.status(403).json({ detail: "Forbidden" });

    const sr = await pool.query(
        `SELECT allow_edit FROM workflow_shares WHERE workflow_id = $1 AND shared_with_email = $2`,
        [workflowId, normalizedUserEmail],
    );
    const share = sr.rows[0] as { allow_edit: boolean } | undefined;
    if (!share) return void res.status(403).json({ detail: "Forbidden" });

    res.json(withWorkflowAccess(workflow, { allowEdit: !!share.allow_edit, isOwner: false }));
});

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;

    const wr = await pool.query(
        `SELECT id FROM workflows WHERE id = $1 AND user_id = $2 AND is_system = false`,
        [workflowId, userId],
    );
    if (!wr.rows[0])
        return void res.status(404).json({ detail: "Workflow not found or not editable" });

    const r = await pool.query(
        `SELECT id, shared_with_email, allow_edit, created_at FROM workflow_shares
         WHERE workflow_id = $1 ORDER BY created_at ASC`,
        [workflowId],
    ).catch((e) => { res.status(500).json({ detail: e.message }); return null; });
    if (!r) return;

    const shares = r.rows as { shared_with_email: string; allow_edit: boolean }[];
    if (shares.length === 0) return void res.json([]);

    // Resolve display names from users table
    const emails = shares.map((s) => s.shared_with_email);
    await pool.query(
        `SELECT id, email FROM users WHERE email = ANY($1)`,
        [emails],
    ).catch(() => ({ rows: [] }));

    res.json(shares);
});

// POST /workflows/:workflowId/shares (singular email, camelCase)
workflowsRouter.post("/:workflowId/shares", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    const { email, allowEdit } = req.body as { email?: string; allowEdit?: boolean };

    if (!email?.trim())
        return void res.status(400).json({ detail: "email is required" });

    const wr = await pool.query(
        `SELECT id FROM workflows WHERE id = $1`,
        [workflowId],
    ).catch((e) => { res.status(500).json({ detail: e.message }); return null; });
    if (!wr) return;
    const workflow = wr.rows[0] as { id: string; user_id: string } | undefined;
    if (!workflow) return void res.status(404).json({ detail: "Workflow not found" });
    if (workflow.user_id !== userId) return void res.status(403).json({ detail: "Forbidden" });

    const r = await pool.query(
        `INSERT INTO workflow_shares (workflow_id, shared_by_user_id, shared_with_email, allow_edit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workflow_id, shared_with_email) DO UPDATE SET allow_edit = EXCLUDED.allow_edit
         RETURNING *`,
        [workflowId, userId, email.trim().toLowerCase(), allowEdit ?? false],
    ).catch((e) => { res.status(500).json({ detail: e.message }); return null; });
    if (!r) return;
    res.status(201).json(r.rows[0]);
});

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId, shareId } = req.params;

    const wr = await pool.query(
        `SELECT id FROM workflows WHERE id = $1 AND user_id = $2`,
        [workflowId, userId],
    );
    if (!wr.rows[0])
        return void res.status(404).json({ detail: "Workflow not found" });

    await pool.query(
        `DELETE FROM workflow_shares WHERE id = $1 AND workflow_id = $2`,
        [shareId, workflowId],
    );
    res.status(204).send();
});

// POST /workflows/:workflowId/hide
workflowsRouter.post("/:workflowId/hide", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    await pool.query(
        `INSERT INTO hidden_workflows (user_id, workflow_id) VALUES ($1, $2)
         ON CONFLICT (user_id, workflow_id) DO NOTHING`,
        [userId, workflowId],
    ).catch((e) => { res.status(500).json({ detail: e.message }); });
    res.status(200).json({ ok: true });
});

// DELETE /workflows/:workflowId/hide
workflowsRouter.delete("/:workflowId/hide", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    await pool.query(
        `DELETE FROM hidden_workflows WHERE user_id = $1 AND workflow_id = $2`,
        [userId, workflowId],
    ).catch((e) => { res.status(500).json({ detail: e.message }); });
    res.status(200).json({ ok: true });
});

// POST /workflows/:workflowId/share (legacy: plural emails, snake_case)
workflowsRouter.post("/:workflowId/share", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

    if (!emails?.length)
        return void res.status(400).json({ detail: "emails is required" });

    const wr = await pool.query(
        `SELECT id FROM workflows WHERE id = $1 AND user_id = $2 AND is_system = false`,
        [workflowId, userId],
    );
    if (!wr.rows[0])
        return void res.status(404).json({ detail: "Workflow not found or not editable" });

    for (const email of emails) {
        await pool.query(
            `INSERT INTO workflow_shares (workflow_id, shared_by_user_id, shared_with_email, allow_edit)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workflow_id, shared_with_email) DO UPDATE SET allow_edit = EXCLUDED.allow_edit`,
            [workflowId, userId, email.trim().toLowerCase(), allow_edit ?? false],
        ).catch((e) => { res.status(500).json({ detail: e.message }); });
    }
    res.status(204).send();
});
