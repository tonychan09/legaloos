-- Migration: Replace Supabase Auth with Azure Entra External ID
-- Creates a users table to store Entra user records (previously in Supabase auth.users)
-- Adds foreign key on user_profiles from user_id -> users.id

-- Users table (replaces Supabase auth.users)
CREATE TABLE IF NOT EXISTS users (
    id          text PRIMARY KEY,  -- Entra oid claim
    email       text,
    created_at  timestamptz DEFAULT now()
);

-- Make user_profiles.user_id reference users.id instead of auth.users.id
-- (existing FK to auth.users must be dropped first in a real migration)
ALTER TABLE user_profiles
    ALTER COLUMN user_id TYPE text;

-- Add FK constraint to users table
ALTER TABLE user_profiles
    ADD CONSTRAINT fk_user_profiles_users
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Update projects, chats, etc. to use text user_id (Entra oid is already text)
-- These columns are already text in the existing schema so no type change needed.
