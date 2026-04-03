-- AlterTable
ALTER TABLE "Call"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'signalwire',
ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'human',
ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "providerCallId" TEXT,
ADD COLUMN "providerMetadata" JSONB;

UPDATE "Call"
SET "mode" = CASE WHEN "direction" = 'inbound' THEN 'inbound' ELSE 'manual' END,
    "providerCallId" = COALESCE("providerCallId", "signalwireCallSid");

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "callId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'signalwire',
    "providerCallId" TEXT,
    "providerParentCallId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'human',
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "direction" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "accountId" TEXT,
    "accountName" TEXT,
    "leadExternalId" TEXT,
    "agentId" TEXT,
    "campaignId" TEXT,
    "contactId" TEXT,
    "crmContext" JSONB,
    "providerMetadata" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "callId" TEXT,
    "provider" TEXT,
    "providerCallId" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT,
    "idempotencyKey" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallRecording" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "callId" TEXT,
    "provider" TEXT NOT NULL,
    "providerRecordingId" TEXT,
    "url" TEXT NOT NULL,
    "archiveUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'available',
    "duration" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallTranscript" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "callId" TEXT,
    "provider" TEXT NOT NULL,
    "providerTranscriptId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'recording',
    "status" TEXT NOT NULL DEFAULT 'available',
    "text" TEXT NOT NULL,
    "summary" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Call_provider_providerCallId_idx" ON "Call"("provider", "providerCallId");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_callId_key" ON "CallSession"("callId");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_provider_providerCallId_key" ON "CallSession"("provider", "providerCallId");

-- CreateIndex
CREATE INDEX "CallSession_agentId_idx" ON "CallSession"("agentId");

-- CreateIndex
CREATE INDEX "CallSession_accountId_idx" ON "CallSession"("accountId");

-- CreateIndex
CREATE INDEX "CallSession_campaignId_idx" ON "CallSession"("campaignId");

-- CreateIndex
CREATE INDEX "CallSession_contactId_idx" ON "CallSession"("contactId");

-- CreateIndex
CREATE INDEX "CallSession_status_idx" ON "CallSession"("status");

-- CreateIndex
CREATE INDEX "CallSession_createdAt_idx" ON "CallSession"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallEvent_idempotencyKey_key" ON "CallEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CallEvent_sessionId_createdAt_idx" ON "CallEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "CallEvent_callId_createdAt_idx" ON "CallEvent"("callId", "createdAt");

-- CreateIndex
CREATE INDEX "CallEvent_provider_providerCallId_idx" ON "CallEvent"("provider", "providerCallId");

-- CreateIndex
CREATE INDEX "CallEvent_type_createdAt_idx" ON "CallEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "CallRecording_sessionId_createdAt_idx" ON "CallRecording"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "CallRecording_callId_createdAt_idx" ON "CallRecording"("callId", "createdAt");

-- CreateIndex
CREATE INDEX "CallRecording_provider_providerRecordingId_idx" ON "CallRecording"("provider", "providerRecordingId");

-- CreateIndex
CREATE INDEX "CallTranscript_sessionId_createdAt_idx" ON "CallTranscript"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "CallTranscript_callId_createdAt_idx" ON "CallTranscript"("callId", "createdAt");

-- CreateIndex
CREATE INDEX "CallTranscript_provider_providerTranscriptId_idx" ON "CallTranscript"("provider", "providerTranscriptId");

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CampaignContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallEvent" ADD CONSTRAINT "CallEvent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallRecording" ADD CONSTRAINT "CallRecording_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallRecording" ADD CONSTRAINT "CallRecording_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTranscript" ADD CONSTRAINT "CallTranscript_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CallSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallTranscript" ADD CONSTRAINT "CallTranscript_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing calls into normalized sessions
INSERT INTO "CallSession" (
    "id",
    "callId",
    "provider",
    "providerCallId",
    "channel",
    "mode",
    "direction",
    "fromNumber",
    "toNumber",
    "status",
    "accountId",
    "accountName",
    "agentId",
    "providerMetadata",
    "startedAt",
    "completedAt",
    "lastEventAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'sess_' || "id",
    "id",
    "provider",
    COALESCE("providerCallId", "signalwireCallSid"),
    "channel",
    "mode",
    "direction",
    "fromNumber",
    "toNumber",
    "status",
    "accountId",
    "accountName",
    "agentId",
    CASE
        WHEN "signalwireCallSid" IS NULL THEN "providerMetadata"
        ELSE jsonb_build_object('legacySignalWireSid', "signalwireCallSid")
    END,
    "createdAt",
    "completedAt",
    COALESCE("completedAt", "createdAt"),
    "createdAt",
    COALESCE("completedAt", "createdAt")
FROM "Call"
ON CONFLICT ("callId") DO NOTHING;

-- Backfill existing recording URLs into normalized recording records
INSERT INTO "CallRecording" (
    "id",
    "sessionId",
    "callId",
    "provider",
    "url",
    "status",
    "duration",
    "createdAt",
    "updatedAt"
)
SELECT
    'rec_' || "id",
    'sess_' || "id",
    "id",
    "provider",
    "recordingUrl",
    'available',
    NULLIF("duration", 0),
    "createdAt",
    COALESCE("completedAt", "createdAt")
FROM "Call"
WHERE "recordingUrl" IS NOT NULL
ON CONFLICT DO NOTHING;
