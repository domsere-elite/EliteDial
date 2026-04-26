-- Rename User table → Profile (non-destructive). Indexes, primary key,
-- and foreign-key constraints are renamed to match the new model name so
-- subsequent Prisma diffs stay clean.

-- Rename the table
ALTER TABLE "User" RENAME TO "Profile";

-- Rename the primary key constraint
ALTER TABLE "Profile" RENAME CONSTRAINT "User_pkey" TO "Profile_pkey";

-- Rename unique indexes
ALTER INDEX "User_username_key" RENAME TO "Profile_username_key";
ALTER INDEX "User_email_key" RENAME TO "Profile_email_key";

-- The foreign keys from Call, CallSession, Voicemail, Campaign already
-- reference the renamed table by OID — Postgres updates them automatically
-- when the table is renamed. No FK rename or recreate is required.
