-- Phase 2 of power-dial: dispatch-time tracking tables.
--
-- A PowerDialBatch represents one dispatch tick targeted at one available agent.
-- It contains floor(dialRatio) legs (PowerDialLeg rows). On customer answer for
-- a leg, an SWML callback to /swml/power-dial/claim runs an atomic UPDATE on
-- PowerDialLeg to award the bridge slot to whichever leg first reaches an
-- AMD-confirmed-human. Race losers route to AI overflow or hang up.
--
-- Behaviour stays unchanged until the worker (Phase 2 step 5) is enabled via
-- POWER_DIAL_WORKER_ENABLED=true.

CREATE TABLE "PowerDialBatch" (
    "id"          TEXT             NOT NULL,
    "campaignId"  TEXT             NOT NULL,
    "agentId"     UUID             NOT NULL,
    "targetRef"   TEXT             NOT NULL,
    "legCount"    INTEGER          NOT NULL,
    "status"      TEXT             NOT NULL DEFAULT 'dispatching',
    "claimedAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "PowerDialBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PowerDialBatch_campaignId_status_idx" ON "PowerDialBatch"("campaignId", "status");
CREATE INDEX "PowerDialBatch_agentId_status_idx"   ON "PowerDialBatch"("agentId", "status");
CREATE INDEX "PowerDialBatch_expiresAt_idx"        ON "PowerDialBatch"("expiresAt");

ALTER TABLE "PowerDialBatch"
    ADD CONSTRAINT "PowerDialBatch_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PowerDialBatch"
    ADD CONSTRAINT "PowerDialBatch_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PowerDialLeg" (
    "id"             TEXT          NOT NULL,
    "batchId"        TEXT          NOT NULL,
    "contactId"      TEXT          NOT NULL,
    "legIndex"       INTEGER       NOT NULL,
    "providerCallId" TEXT,
    "status"         TEXT          NOT NULL DEFAULT 'dialing',
    "detectResult"   TEXT,
    "claimedAgent"   BOOLEAN       NOT NULL DEFAULT false,
    "overflowTarget" TEXT,
    "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"    TIMESTAMP(3),

    CONSTRAINT "PowerDialLeg_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PowerDialLeg_batchId_legIndex_key" ON "PowerDialLeg"("batchId", "legIndex");
CREATE INDEX "PowerDialLeg_providerCallId_idx" ON "PowerDialLeg"("providerCallId");
CREATE INDEX "PowerDialLeg_status_idx"         ON "PowerDialLeg"("status");

ALTER TABLE "PowerDialLeg"
    ADD CONSTRAINT "PowerDialLeg_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "PowerDialBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PowerDialLeg"
    ADD CONSTRAINT "PowerDialLeg_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "CampaignContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
