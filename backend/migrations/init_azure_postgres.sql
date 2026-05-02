-- ============================================================
-- Legaloos – Azure PostgreSQL init script
-- Run this once against a fresh database:
--   psql "$DATABASE_URL" -f init_azure_postgres.sql
-- ============================================================

-- gen_random_uuid() is built-in from PostgreSQL 13+.
-- If on PG 12 or lower, uncomment the line below:
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Users  (replaces Supabase auth.users – populated by Entra token sync)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id         text        PRIMARY KEY,   -- Entra OID claim
    email      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_profiles (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               text        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    display_name          text,
    organisation          text,
    tier                  text        NOT NULL DEFAULT 'Free',
    message_credits_used  integer     NOT NULL DEFAULT 0,
    credits_reset_date    timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    tabular_model         text        NOT NULL DEFAULT 'gemini-3-flash-preview',
    claude_api_key        text,
    gemini_api_key        text,
    azure_api_key         text,
    azure_endpoint        text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      text        NOT NULL,
    name         text        NOT NULL,
    cm_number    text,
    visibility   text        NOT NULL DEFAULT 'private',
    shared_with  jsonb       NOT NULL DEFAULT '[]',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_user        ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_shared_with ON projects USING gin(shared_with);

-- ---------------------------------------------------------------------------
-- Project sub-folders
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_subfolders (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id          text        NOT NULL,
    name             text        NOT NULL,
    parent_folder_id uuid        REFERENCES project_subfolders(id) ON DELETE CASCADE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_subfolders_project ON project_subfolders(project_id);

-- ---------------------------------------------------------------------------
-- Documents  (current_version_id added after document_versions)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         uuid        REFERENCES projects(id) ON DELETE CASCADE,
    user_id            text        NOT NULL,
    filename           text        NOT NULL,
    file_type          text,
    size_bytes         integer     NOT NULL DEFAULT 0,
    page_count         integer,
    structure_tree     jsonb,
    status             text        NOT NULL DEFAULT 'pending',
    folder_id          uuid        REFERENCES project_subfolders(id) ON DELETE SET NULL,
    current_version_id uuid,       -- FK added below after document_versions exists
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_user_project    ON documents(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_documents_project_folder  ON documents(project_id, folder_id);

-- ---------------------------------------------------------------------------
-- Document versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_versions (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id      uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    storage_path     text        NOT NULL,
    pdf_storage_path text,
    source           text        NOT NULL DEFAULT 'upload'
                                 CHECK (source = ANY (ARRAY[
                                     'upload', 'user_upload', 'assistant_edit',
                                     'user_accept', 'user_reject', 'generated'
                                 ])),
    version_number   integer,
    display_name     text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc      ON document_versions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_versions_doc_vnum ON document_versions(document_id, version_number);

-- Back-fill FK now that document_versions exists
ALTER TABLE documents
    ADD CONSTRAINT IF NOT EXISTS fk_documents_current_version
    FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Document edits
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_edits (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id      uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chat_message_id  uuid,       -- FK added below after chat_messages exists
    version_id       uuid        NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    change_id        text        NOT NULL,
    del_w_id         text,
    ins_w_id         text,
    deleted_text     text        NOT NULL DEFAULT '',
    inserted_text    text        NOT NULL DEFAULT '',
    context_before   text,
    context_after    text,
    status           text        NOT NULL DEFAULT 'pending'
                                 CHECK (status = ANY (ARRAY['pending', 'accepted', 'rejected'])),
    created_at       timestamptz NOT NULL DEFAULT now(),
    resolved_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_document_edits_document   ON document_edits(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_edits_version    ON document_edits(version_id);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflows (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        text,
    title          text        NOT NULL,
    type           text        NOT NULL,
    prompt_md      text,
    columns_config jsonb,
    practice       text,
    is_system      boolean     NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflows_user ON workflows(user_id);

CREATE TABLE IF NOT EXISTS hidden_workflows (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     text        NOT NULL,
    workflow_id text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, workflow_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_workflows_user ON hidden_workflows(user_id);

CREATE TABLE IF NOT EXISTS workflow_shares (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id         uuid        NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    shared_by_user_id   text        NOT NULL,
    shared_with_email   text        NOT NULL,
    allow_edit          boolean     NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, shared_with_email)
);

CREATE INDEX IF NOT EXISTS idx_workflow_shares_workflow ON workflow_shares(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_shares_email    ON workflow_shares(shared_with_email);

-- ---------------------------------------------------------------------------
-- Chats
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chats (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid        REFERENCES projects(id) ON DELETE CASCADE,
    user_id    text        NOT NULL,
    title      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chats_user    ON chats(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id     uuid        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role        text        NOT NULL,
    content     jsonb,
    files       jsonb,
    workflow    jsonb,
    annotations jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, created_at);

-- Back-fill FK on document_edits now that chat_messages exists
ALTER TABLE document_edits
    ADD CONSTRAINT IF NOT EXISTS fk_document_edits_chat_message
    FOREIGN KEY (chat_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tabular_reviews (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     uuid        REFERENCES projects(id) ON DELETE CASCADE,
    user_id        text        NOT NULL,
    title          text,
    columns_config jsonb,
    workflow_id    uuid        REFERENCES workflows(id) ON DELETE SET NULL,
    practice       text,
    shared_with    jsonb       NOT NULL DEFAULT '[]',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tabular_reviews_user        ON tabular_reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_tabular_reviews_project     ON tabular_reviews(project_id);
CREATE INDEX IF NOT EXISTS idx_tabular_reviews_shared_with ON tabular_reviews USING gin(shared_with);

CREATE TABLE IF NOT EXISTS tabular_cells (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id    uuid        NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
    document_id  uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    column_index integer     NOT NULL,
    content      text,
    citations    jsonb,
    status       text        NOT NULL DEFAULT 'pending',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tabular_cells_review ON tabular_cells(review_id, document_id, column_index);

CREATE TABLE IF NOT EXISTS tabular_review_chats (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id  uuid        NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
    user_id    text        NOT NULL,
    title      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tabular_review_chats_review ON tabular_review_chats(review_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tabular_review_chats_user   ON tabular_review_chats(user_id);

CREATE TABLE IF NOT EXISTS tabular_review_chat_messages (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id     uuid        NOT NULL REFERENCES tabular_review_chats(id) ON DELETE CASCADE,
    role        text        NOT NULL,
    content     jsonb,
    annotations jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tabular_review_chat_messages ON tabular_review_chat_messages(chat_id, created_at);
