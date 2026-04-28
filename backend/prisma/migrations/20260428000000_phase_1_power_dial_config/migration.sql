-- Phase 1 of power-dial: campaign-level configuration only. Runtime behaviour is
-- still 1:1 in progressive mode; Phase 2 adds the multi-leg dispatch + AMD SWML
-- that consumes these fields.

ALTER TABLE "Campaign"
    ADD COLUMN "dialRatio" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    ADD COLUMN "voicemailBehavior" TEXT NOT NULL DEFAULT 'hangup',
    ADD COLUMN "voicemailMessage" TEXT;
