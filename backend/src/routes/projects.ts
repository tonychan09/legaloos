import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { pool } from "../lib/db";
import type { Pool } from "pg";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey } from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";

export const projectsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;

  let ownProjects: unknown[];
  let sharedProjects: unknown[];
  try {
    const ownResult = await pool.query(
      "SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    ownProjects = ownResult.rows;
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }

  try {
    if (userEmail) {
      const sharedResult = await pool.query(
        "SELECT * FROM projects WHERE shared_with @> $1::jsonb AND user_id != $2 ORDER BY created_at DESC",
        [JSON.stringify([userEmail]), userId],
      );
      sharedProjects = sharedResult.rows;
    } else {
      sharedProjects = [];
    }
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }

  const projects = [...ownProjects, ...sharedProjects].sort(
    (a: any, b: any) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const result = await Promise.all(
    projects.map(async (p: any) => {
      const [docs, chats, reviews] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM documents WHERE project_id = $1", [p.id]),
        pool.query("SELECT COUNT(*) FROM chats WHERE project_id = $1", [p.id]),
        pool.query("SELECT COUNT(*) FROM tabular_reviews WHERE project_id = $1", [p.id]),
      ]);
      return {
        ...p,
        is_owner: p.user_id === userId,
        document_count: parseInt(docs.rows[0].count, 10),
        chat_count: parseInt(chats.rows[0].count, 10),
        review_count: parseInt(reviews.rows[0].count, 10),
      };
    }),
  );
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { name, cm_number, shared_with } = req.body as {
    name: string;
    cm_number?: string;
    shared_with?: string[];
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  try {
    const result = await pool.query(
      "INSERT INTO projects (user_id, name, cm_number, shared_with) VALUES ($1, $2, $3, $4) RETURNING *",
      [userId, name.trim(), cm_number ?? null, JSON.stringify(shared_with ?? [])],
    );
    const data = result.rows[0];
    return void res.status(201).json({ ...data, documents: [] });
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;

  const projectResult = await pool.query(
    "SELECT * FROM projects WHERE id = $1",
    [projectId],
  );
  const project = projectResult.rows[0];
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    (userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.includes(userEmail));
  if (!canAccess)
    return void res.status(403).json({ detail: "Forbidden" });

  const [docsResult, folderResult] = await Promise.all([
    pool.query("SELECT * FROM documents WHERE project_id = $1 ORDER BY created_at ASC", [projectId]),
    pool.query("SELECT * FROM project_subfolders WHERE project_id = $1 ORDER BY created_at ASC", [projectId]),
  ]);
  const docsTyped = docsResult.rows as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(pool, docsTyped);
  await attachActiveVersionPaths(pool, docsTyped);
  res.json({
    ...project,
    is_owner: project.user_id === userId,
    documents: docsTyped,
    folders: folderResult.rows,
  });
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const projectResult = await pool.query(
    "SELECT id, user_id, shared_with FROM projects WHERE id = $1",
    [projectId],
  );
  const project = projectResult.rows[0];
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  // Pull all users from the users table (id = Entra oid, email = user email).
  const usersResult = await pool.query("SELECT id, email FROM users");
  const allUsers = usersResult.rows as { id: string; email: string }[];
  const userByEmail = new Map<string, { id: string; email: string }>();
  const userById = new Map<string, { id: string; email: string }>();
  for (const u of allUsers) {
    if (!u.email) continue;
    const lower = u.email.toLowerCase();
    userByEmail.set(lower, { id: u.id, email: u.email });
    userById.set(u.id, { id: u.id, email: u.email });
  }

  const memberUserIds: string[] = [];
  for (const email of sharedWith) {
    const u = userByEmail.get(email);
    if (u) memberUserIds.push(u.id);
  }

  const profileIds = [
    project.user_id as string,
    ...memberUserIds,
  ].filter((x, i, arr) => arr.indexOf(x) === i);

  const profileByUserId = new Map<
    string,
    { display_name: string | null; organisation: string | null }
  >();
  if (profileIds.length > 0) {
    const profilesResult = await pool.query(
      "SELECT up.user_id, up.display_name, up.organisation FROM user_profiles up WHERE up.user_id = ANY($1)",
      [profileIds],
    );
    for (const p of profilesResult.rows as { user_id: string; display_name: string | null; organisation: string | null }[]) {
      profileByUserId.set(p.user_id, {
        display_name: p.display_name ?? null,
        organisation: p.organisation ?? null,
      });
    }
  }

  const ownerInfo = userById.get(project.user_id as string);
  const owner = {
    user_id: project.user_id,
    email: ownerInfo?.email ?? null,
    display_name:
      profileByUserId.get(project.user_id as string)?.display_name ?? null,
  };
  const members = sharedWith.map((email) => {
    const u = userByEmail.get(email);
    const display_name = u
      ? profileByUserId.get(u.id)?.display_name ?? null
      : null;
    return { email, display_name };
  });

  res.json({ owner, members });
});

// GET /projects/:projectId/members
projectsRouter.get("/:projectId/members", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const projectResult = await pool.query(
    "SELECT id, user_id, shared_with FROM projects WHERE id = $1",
    [projectId],
  );
  const project = projectResult.rows[0];
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    (!!userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.includes(userEmail));
  if (!canAccess)
    return void res.status(403).json({ detail: "Forbidden" });

  const sharedWith: string[] = Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : [];

  if (sharedWith.length === 0) {
    return void res.json([]);
  }

  const usersResult = await pool.query(
    "SELECT id, email FROM users WHERE email = ANY($1)",
    [sharedWith],
  );
  const members = (usersResult.rows as { id: string; email: string }[]).map(
    (u) => ({ id: u.id, email: u.email }),
  );
  res.json(members);
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;

  const checkR = await pool.query(`SELECT id, user_id FROM projects WHERE id = $1`, [projectId]);
  const existingProject = checkR.rows[0] as { id: string; user_id: string } | undefined;
  if (!existingProject) return void res.status(404).json({ detail: "Project not found" });
  if (existingProject.user_id !== userId) return void res.status(403).json({ detail: "Forbidden" });

  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cm_number = req.body.cm_number;
  if (Array.isArray(req.body.shared_with)) {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of req.body.shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      cleaned.push(e);
    }
    updates.shared_with = cleaned;
  }

  updates.updated_at = new Date().toISOString();
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;
  for (const [col, val] of Object.entries(updates)) {
    if (col === "shared_with") {
      setClauses.push(`${col} = $${paramIdx}::jsonb`);
      params.push(JSON.stringify(val));
    } else {
      setClauses.push(`${col} = $${paramIdx}`);
      params.push(val);
    }
    paramIdx++;
  }
  params.push(projectId);

  try {
    const result = await pool.query(
      `UPDATE projects SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );
    res.json(result.rows[0]);
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;

  const checkR = await pool.query(`SELECT id, user_id FROM projects WHERE id = $1`, [projectId]);
  const project = checkR.rows[0] as { id: string; user_id: string } | undefined;
  if (!project) return void res.status(404).json({ detail: "Project not found" });
  if (project.user_id !== userId) return void res.status(403).json({ detail: "Forbidden" });

  try {
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    res.status(204).send();
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail, pool);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const docsResult = await pool.query(
    "SELECT * FROM documents WHERE project_id = $1 ORDER BY created_at ASC",
    [projectId],
  );
  const docsTyped = docsResult.rows as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(pool, docsTyped);
  res.json(docsTyped);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;

    const access = await checkProjectAccess(projectId, userId, userEmail, pool);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const docResult = await pool.query(
      "SELECT * FROM documents WHERE id = $1 AND user_id = $2",
      [documentId, userId],
    );
    const doc = docResult.rows[0];
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id
      try {
        const updResult = await pool.query(
          "UPDATE documents SET project_id = $1, updated_at = $2 WHERE id = $3 RETURNING *",
          [projectId, new Date().toISOString(), documentId],
        );
        const updated = updResult.rows[0];
        if (!updated)
          return void res.status(500).json({ detail: "Failed to update document" });
        return void res.json(updated);
      } catch (e: unknown) {
        return void res.status(500).json({ detail: (e as Error).message });
      }
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      let copy: Record<string, unknown>;
      try {
        const copyResult = await pool.query(
          `INSERT INTO documents (project_id, user_id, filename, file_type, size_bytes, page_count, structure_tree, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            projectId,
            userId,
            doc.filename,
            doc.file_type,
            doc.size_bytes,
            doc.page_count,
            doc.structure_tree ? JSON.stringify(doc.structure_tree) : null,
            doc.status,
          ],
        );
        copy = copyResult.rows[0];
        if (!copy)
          return void res.status(500).json({ detail: "Failed to copy document" });
      } catch (e: unknown) {
        return void res.status(500).json({ detail: (e as Error).message });
      }

      let copyVersionRowId: string | null = null;
      if (doc.current_version_id) {
        const srcVResult = await pool.query(
          "SELECT storage_path, pdf_storage_path, version_number, display_name, source FROM document_versions WHERE id = $1",
          [doc.current_version_id],
        );
        const srcV = srcVResult.rows[0] as {
          storage_path: string | null;
          pdf_storage_path: string | null;
          version_number: number | null;
          display_name: string | null;
          source: string | null;
        } | undefined;
        if (srcV?.storage_path) {
          const srcBytes = await downloadFile(srcV.storage_path);
          if (!srcBytes) {
            return void res
              .status(500)
              .json({ detail: "Failed to read source document bytes" });
          }
          const newKey = storageKey(userId, copy.id as string, doc.filename);
          const contentType =
            doc.file_type === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          await uploadFile(newKey, srcBytes, contentType);

          // PDFs share one object for source + display rendition. DOCX
          // store the converted PDF at a separate `converted-pdfs/` key —
          // copy that too if it exists so the copy renders without going
          // back through libreoffice.
          let newPdfPath: string | null = null;
          if (srcV.pdf_storage_path) {
            if (srcV.pdf_storage_path === srcV.storage_path) {
              newPdfPath = newKey;
            } else {
              const pdfBytes = await downloadFile(srcV.pdf_storage_path);
              if (pdfBytes) {
                const newPdfKey = convertedPdfKey(userId, copy.id as string);
                await uploadFile(newPdfKey, pdfBytes, "application/pdf");
                newPdfPath = newPdfKey;
              }
            }
          }

          const newVResult = await pool.query(
            `INSERT INTO document_versions (document_id, storage_path, pdf_storage_path, source, version_number, display_name)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              copy.id,
              newKey,
              newPdfPath,
              (srcV.source as string | null) ?? "upload",
              srcV.version_number ?? 1,
              srcV.display_name ?? doc.filename,
            ],
          );
          copyVersionRowId = (newVResult.rows[0]?.id as string | null) ?? null;
          if (copyVersionRowId) {
            await pool.query(
              "UPDATE documents SET current_version_id = $1 WHERE id = $2",
              [copyVersionRowId, copy.id],
            );
          }
        }
      }
      return void res.status(201).json(copy);
    }
  },
);

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;

    const access = await checkProjectAccess(projectId, userId, userEmail, pool);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId, pool);
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail, pool);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  try {
    const result = await pool.query(
      "SELECT * FROM chats WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId],
    );
    res.json(result.rows);
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// ── Subfolder routes (simplified ownership check, used by tests) ──────────────

// POST /projects/:projectId/subfolders
projectsRouter.post("/:projectId/subfolders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const { name } = req.body as { name?: string };

  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const checkR = await pool.query(`SELECT id, user_id FROM projects WHERE id = $1`, [projectId]);
  const project = checkR.rows[0] as { id: string; user_id: string } | undefined;
  if (!project) return void res.status(404).json({ detail: "Project not found" });
  if (project.user_id !== userId) return void res.status(403).json({ detail: "Forbidden" });

  try {
    const result = await pool.query(
      `INSERT INTO project_subfolders (project_id, user_id, name, parent_folder_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [projectId, userId, name.trim(), null],
    );
    res.status(201).json(result.rows[0]);
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// DELETE /projects/:projectId/subfolders/:folderId
projectsRouter.delete("/:projectId/subfolders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId, folderId } = req.params;

  const checkR = await pool.query(`SELECT id, user_id FROM projects WHERE id = $1`, [projectId]);
  const project = checkR.rows[0] as { id: string; user_id: string } | undefined;
  if (!project) return void res.status(404).json({ detail: "Project not found" });
  if (project.user_id !== userId) return void res.status(403).json({ detail: "Forbidden" });

  try {
    await pool.query(`DELETE FROM project_subfolders WHERE id = $1 AND project_id = $2`, [folderId, projectId]);
    res.status(204).send();
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const access = await checkProjectAccess(projectId, userId, userEmail, pool);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const parentResult = await pool.query(
      "SELECT id FROM project_subfolders WHERE id = $1 AND project_id = $2",
      [parent_folder_id, projectId],
    );
    if (!parentResult.rows[0]) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO project_subfolders (project_id, user_id, name, parent_folder_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [projectId, userId, name.trim(), parent_folder_id ?? null],
    );
    res.status(201).json(result.rows[0]);
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const access = await checkProjectAccess(projectId, userId, userEmail, pool);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        const pResult = await pool.query(
          "SELECT parent_folder_id FROM project_subfolders WHERE id = $1",
          [cur],
        );
        const p = pResult.rows[0] as { parent_folder_id: string | null } | undefined;
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  // Build SET clause dynamically
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;
  for (const [col, val] of Object.entries(updates)) {
    setClauses.push(`${col} = $${paramIdx}`);
    params.push(val);
    paramIdx++;
  }
  params.push(folderId);
  params.push(projectId);

  try {
    const result = await pool.query(
      `UPDATE project_subfolders SET ${setClauses.join(", ")} WHERE id = $${paramIdx} AND project_id = $${paramIdx + 1} RETURNING *`,
      params,
    );
    const data = result.rows[0];
    if (!data) return void res.status(404).json({ detail: "Folder not found" });
    res.json(data);
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail, pool);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Move direct documents to root before cascade-deleting subfolders
  await pool.query("UPDATE documents SET folder_id = NULL WHERE folder_id = $1", [folderId]);

  try {
    await pool.query(
      "DELETE FROM project_subfolders WHERE id = $1 AND project_id = $2",
      [folderId, projectId],
    );
    res.status(204).send();
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const access = await checkProjectAccess(projectId, userId, userEmail, pool);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  try {
    const result = await pool.query(
      "UPDATE documents SET folder_id = $1, updated_at = $2 WHERE id = $3 AND project_id = $4 RETURNING *",
      [folder_id ?? null, new Date().toISOString(), documentId, projectId],
    );
    const data = result.rows[0];
    if (!data) return void res.status(404).json({ detail: "Document not found" });
    res.json(data);
  } catch (e: unknown) {
    return void res.status(500).json({ detail: (e as Error).message });
  }
});

export async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: Pool,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_TYPES.has(suffix))
    return void res
      .status(400)
      .json({
        detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
      });

  const content = file.buffer;
  let doc: Record<string, unknown>;
  try {
    const insertResult = await db.query(
      `INSERT INTO documents (project_id, user_id, filename, file_type, size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [projectId, userId, filename, suffix, content.byteLength, "processing"],
    );
    doc = insertResult.rows[0];
    if (!doc) {
      return void res.status(500).json({ detail: "Failed to create document record" });
    }
  } catch {
    return void res.status(500).json({ detail: "Failed to create document record" });
  }

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const tree = await extractStructureTree(rawBuf, suffix, filename);
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

    // Convert DOCX/DOC → PDF for display. PDFs are their own rendition.
    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(content);
        const pdfKey = convertedPdfKey(userId, docId);
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[upload] DOCX→PDF conversion failed for ${filename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Storage paths live on document_versions — create the V1 row and
    // point documents.current_version_id at it.
    const versionResult = await db.query(
      `INSERT INTO document_versions (document_id, storage_path, pdf_storage_path, source, version_number, display_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [docId, key, pdfStoragePath, "upload", 1, filename],
    );
    const versionRow = versionResult.rows[0];
    if (!versionRow) {
      throw new Error("Failed to record upload version: unknown");
    }

    await db.query(
      `UPDATE documents SET current_version_id = $1, size_bytes = $2, page_count = $3,
       structure_tree = $4, status = $5, updated_at = $6 WHERE id = $7`,
      [
        versionRow.id,
        content.byteLength,
        pageCount,
        tree ? JSON.stringify(tree) : null,
        "ready",
        new Date().toISOString(),
        docId,
      ],
    );

    const updatedResult = await db.query(
      "SELECT * FROM documents WHERE id = $1",
      [docId],
    );
    const updated = updatedResult.rows[0];
    const responseDoc = updated
      ? {
            ...updated,
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
        }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.query("UPDATE documents SET status = $1 WHERE id = $2", ["error", doc.id]);
    return void res
      .status(500)
      .json({ detail: `Document processing failed: ${String(e)}` });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  filename: string,
): Promise<unknown[] | null> {
  try {
    if (fileType === "pdf") {
      const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
      );
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length) {
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      }
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines
        .slice(0, 30)
        .map((line, i) => ({
          id: `h1-${i}`,
          title: line.slice(0, 100),
          level: 1,
          page_number: null,
          children: [],
        }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
