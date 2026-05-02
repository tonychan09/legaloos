import type { Pool } from "pg";

interface DocRow {
    id: string;
    latest_version_number?: number | null;
    [k: string]: unknown;
}

interface VersionPathRow extends DocRow {
    storage_path?: string | null;
    pdf_storage_path?: string | null;
    current_version_id?: string | null;
    active_version_number?: number | null;
}

export interface ActiveVersion {
    id: string;
    storage_path: string;
    pdf_storage_path: string | null;
    version_number: number | null;
    display_name: string | null;
    source: string | null;
}

export async function loadActiveVersion(
    documentId: string,
    pool: Pool,
    versionId?: string | null,
): Promise<ActiveVersion | null> {
    const docResult = await pool.query(
        `SELECT current_version_id FROM documents WHERE id = $1`,
        [documentId],
    );
    const doc = docResult.rows[0] as { current_version_id: string | null } | undefined;
    const targetVersionId =
        (typeof versionId === "string" && versionId) ||
        doc?.current_version_id ||
        null;
    if (!targetVersionId) return null;

    const vResult = await pool.query(
        `SELECT id, document_id, storage_path, pdf_storage_path,
                version_number, display_name, source
         FROM document_versions WHERE id = $1`,
        [targetVersionId],
    );
    const v = vResult.rows[0] as {
        id: string;
        document_id: string;
        storage_path: string | null;
        pdf_storage_path: string | null;
        version_number: number | null;
        display_name: string | null;
        source: string | null;
    } | undefined;
    if (!v || v.document_id !== documentId || !v.storage_path) return null;
    return {
        id: v.id,
        storage_path: v.storage_path,
        pdf_storage_path: v.pdf_storage_path ?? null,
        version_number: v.version_number ?? null,
        display_name: v.display_name ?? null,
        source: v.source ?? null,
    };
}

export async function attachActiveVersionPaths<T extends VersionPathRow>(
    pool: Pool,
    docs: T[],
): Promise<T[]> {
    if (docs.length === 0) return docs;
    const versionIds = docs
        .map((d) => d.current_version_id)
        .filter((id): id is string => typeof id === "string");
    if (versionIds.length === 0) {
        for (const d of docs) {
            d.storage_path = null;
            d.pdf_storage_path = null;
        }
        return docs;
    }
    const result = await pool.query(
        `SELECT id, storage_path, pdf_storage_path, version_number
         FROM document_versions WHERE id = ANY($1)`,
        [versionIds],
    );
    const byId = new Map<
        string,
        { storage_path: string | null; pdf_storage_path: string | null; version_number: number | null }
    >();
    for (const r of result.rows as {
        id: string;
        storage_path: string | null;
        pdf_storage_path: string | null;
        version_number: number | null;
    }[]) {
        byId.set(r.id, {
            storage_path: r.storage_path ?? null,
            pdf_storage_path: r.pdf_storage_path ?? null,
            version_number: r.version_number ?? null,
        });
    }
    for (const d of docs) {
        const v = d.current_version_id ? byId.get(d.current_version_id) : null;
        d.storage_path = v?.storage_path ?? null;
        d.pdf_storage_path = v?.pdf_storage_path ?? null;
        d.active_version_number = v?.version_number ?? null;
    }
    return docs;
}

export async function attachLatestVersionNumbers<T extends DocRow>(
    pool: Pool,
    docs: T[],
): Promise<T[]> {
    if (docs.length === 0) return docs;
    const ids = docs.map((d) => d.id);
    const result = await pool.query(
        `SELECT document_id, version_number FROM document_versions
         WHERE document_id = ANY($1) AND source = 'assistant_edit'
           AND version_number IS NOT NULL`,
        [ids],
    );
    const latestByDoc = new Map<string, number>();
    for (const r of result.rows as { document_id: string; version_number: number }[]) {
        const prev = latestByDoc.get(r.document_id) ?? 0;
        if (r.version_number > prev) latestByDoc.set(r.document_id, r.version_number);
    }
    for (const d of docs) {
        d.latest_version_number = latestByDoc.get(d.id) ?? null;
    }
    return docs;
}
