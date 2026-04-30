-- Phase 3b: Wrap-up window support for agents. Profile.wrapUpUntil tracks the
-- deadline for the current wrap-up state. Campaign.wrapUpSeconds sets the default
-- duration (seconds) agents hold wrap-up after a call completes. Agents can
-- submit disposition and click Ready Now to skip early; otherwise auto-resume
-- to 'available' when the window expires.

ALTER TABLE "Profile" ADD COLUMN "wrapUpUntil" TIMESTAMP(3);

ALTER TABLE "Campaign" ADD COLUMN "wrapUpSeconds" INTEGER NOT NULL DEFAULT 30;
