-- Phase 3: skipAmd toggle for power-dial campaigns. Default true — AMD-on is
-- the opt-in path now (compliance-sensitive lists), AMD-off is the default
-- (production collections speed). Existing campaigns get default=true so they
-- pick up the faster behaviour automatically; flip the new toggle off in the
-- UI to restore the AMD path.

ALTER TABLE "Campaign"
    ADD COLUMN "skipAmd" BOOLEAN NOT NULL DEFAULT true;
