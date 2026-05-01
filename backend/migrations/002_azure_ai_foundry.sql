-- Add Azure AI Foundry credentials to user_profiles.
-- azure_endpoint: the user's Azure resource URL
--   e.g. https://<account>.services.ai.azure.com/models
-- azure_api_key: the Azure resource API key

alter table public.user_profiles
  add column if not exists azure_api_key text,
  add column if not exists azure_endpoint text;
