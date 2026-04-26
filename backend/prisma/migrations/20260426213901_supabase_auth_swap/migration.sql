-- Drop the columns that the home-grown auth path used.
-- (No production users exist; any dev-fixture rows lose their hash/username.)
ALTER TABLE "Profile"
    DROP COLUMN "passwordHash",
    DROP COLUMN "username";

-- Drop the index for the column we just removed.
DROP INDEX IF EXISTS "Profile_username_key";

-- Convert the Profile.id column from TEXT to UUID. Existing values are already
-- valid UUID strings (Prisma's @default(uuid()) used uuid v4), so the cast is
-- safe and non-destructive. Foreign keys from Call/CallSession/Voicemail/Campaign
-- need their referencing columns coerced too — Postgres requires both sides
-- of an FK to share a type — so update those columns first, drop the FKs, do
-- the type changes, then recreate the FKs.

ALTER TABLE "Call"        DROP CONSTRAINT "Call_agentId_fkey";
ALTER TABLE "CallSession" DROP CONSTRAINT "CallSession_agentId_fkey";
ALTER TABLE "Voicemail"   DROP CONSTRAINT "Voicemail_assignedToId_fkey";
ALTER TABLE "Campaign"    DROP CONSTRAINT "Campaign_createdById_fkey";

ALTER TABLE "Profile"     ALTER COLUMN "id"           TYPE UUID USING "id"::uuid;
ALTER TABLE "Call"        ALTER COLUMN "agentId"      TYPE UUID USING "agentId"::uuid;
ALTER TABLE "CallSession" ALTER COLUMN "agentId"      TYPE UUID USING "agentId"::uuid;
ALTER TABLE "Voicemail"   ALTER COLUMN "assignedToId" TYPE UUID USING "assignedToId"::uuid;
ALTER TABLE "Campaign"    ALTER COLUMN "createdById"  TYPE UUID USING "createdById"::uuid;

ALTER TABLE "Call"
    ADD CONSTRAINT "Call_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CallSession"
    ADD CONSTRAINT "CallSession_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Voicemail"
    ADD CONSTRAINT "Voicemail_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Campaign"
    ADD CONSTRAINT "Campaign_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Wipe any pre-existing Profile rows now that the home-grown auth path is
-- gone. They have no auth.users counterpart, so they would fail the FK below.
-- Spec confirmed: no production users exist.
DELETE FROM "Profile";

-- Foreign key from Profile.id to auth.users(id). Cascades on user delete.
ALTER TABLE "Profile"
    ADD CONSTRAINT "Profile_id_fkey"
    FOREIGN KEY ("id") REFERENCES auth.users(id) ON DELETE CASCADE;

-- Trigger: when a Supabase user is created, auto-create the matching Profile.
CREATE OR REPLACE FUNCTION public.handle_new_supabase_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public."Profile" (id, email, "firstName", "lastName", role, status, "createdAt", "updatedAt")
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'firstName', ''),
        COALESCE(NEW.raw_user_meta_data->>'lastName', ''),
        COALESCE(NEW.raw_user_meta_data->>'role', 'agent'),
        'offline',
        NOW(),
        NOW()
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_supabase_user();
