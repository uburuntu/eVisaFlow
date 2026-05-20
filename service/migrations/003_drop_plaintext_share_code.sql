-- Remove legacy plaintext share-code storage. The bot writes encrypted_share_code only.
ALTER TABLE runs
  DROP COLUMN IF EXISTS share_code;
