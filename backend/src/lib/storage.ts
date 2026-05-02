/**
 * Azure Blob Storage utilities for document management.
 *
 * Required env vars:
 *   AZURE_STORAGE_ACCOUNT_NAME  — storage account name
 *   AZURE_STORAGE_ACCOUNT_KEY   — storage account access key
 *   AZURE_STORAGE_CONTAINER     — container name (default: "legaloos")
 */

import {
    BlobServiceClient,
    StorageSharedKeyCredential,
    BlobSASPermissions,
    generateBlobSASQueryParameters,
    SASProtocol,
} from "@azure/storage-blob";

const ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME ?? "";
const ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY ?? "";
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? "legaloos";

export const storageEnabled = Boolean(ACCOUNT_NAME && ACCOUNT_KEY);

function getCredential(): StorageSharedKeyCredential {
    return new StorageSharedKeyCredential(ACCOUNT_NAME, ACCOUNT_KEY);
}

function getClient(): BlobServiceClient {
    return new BlobServiceClient(
        `https://${ACCOUNT_NAME}.blob.core.windows.net`,
        getCredential(),
    );
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
    key: string,
    content: ArrayBuffer,
    contentType: string,
): Promise<void> {
    const blobClient = getClient()
        .getContainerClient(CONTAINER)
        .getBlockBlobClient(key);
    await blobClient.uploadData(Buffer.from(content), {
        blobHTTPHeaders: { blobContentType: contentType },
    });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
    if (!storageEnabled) return null;
    try {
        const blobClient = getClient()
            .getContainerClient(CONTAINER)
            .getBlockBlobClient(key);
        const buf = await blobClient.downloadToBuffer();
        return buf.buffer as ArrayBuffer;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
    if (!storageEnabled) return;
    const blobClient = getClient()
        .getContainerClient(CONTAINER)
        .getBlockBlobClient(key);
    await blobClient.deleteIfExists();
}

// ---------------------------------------------------------------------------
// SAS URL (time-limited direct access, equivalent to S3 pre-signed URL)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
    key: string,
    expiresIn = 3600,
    downloadFilename?: string,
): Promise<string | null> {
    if (!storageEnabled) return null;
    try {
        const credential = getCredential();
        const startsOn = new Date();
        const expiresOn = new Date(startsOn.getTime() + expiresIn * 1000);
        const sasParams = generateBlobSASQueryParameters(
            {
                containerName: CONTAINER,
                blobName: key,
                permissions: BlobSASPermissions.parse("r"),
                startsOn,
                expiresOn,
                protocol: SASProtocol.Https,
                ...(downloadFilename
                    ? { contentDisposition: buildContentDisposition("attachment", downloadFilename) }
                    : {}),
            },
            credential,
        );
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");
        return `https://${ACCOUNT_NAME}.blob.core.windows.net/${CONTAINER}/${encodedKey}?${sasParams.toString()}`;
    } catch {
        return null;
    }
}

export function normalizeDownloadFilename(name: string): string {
    const trimmed = name.trim();
    const base = trimmed || "download";
    return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
    return normalizeDownloadFilename(name).replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
    return encodeURIComponent(str).replace(
        /['()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
}

export function buildContentDisposition(
    kind: "inline" | "attachment",
    filename: string,
): string {
    const normalized = normalizeDownloadFilename(filename);
    return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
    userId: string,
    docId: string,
    filename: string,
): string {
    return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
    userId: string,
    docId: string,
    stem: string,
): string {
    return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
    userId: string,
    docId: string,
    filename: string,
): string {
    return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
    userId: string,
    docId: string,
    versionSlug: string,
    filename: string,
): string {
    return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
    const lastDot = filename.lastIndexOf(".");
    if (lastDot < 0) return fallback;
    const ext = filename.slice(lastDot).toLowerCase();
    return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
