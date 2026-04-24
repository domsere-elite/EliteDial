-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "aiOverflowNumber" TEXT,
ADD COLUMN     "aiTarget" TEXT,
ADD COLUMN     "aiTargetEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoRotateEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "avoidRepeatDID" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "defaultDIDId" TEXT,
ADD COLUMN     "maxCallsPerDIDPerDay" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "proximityMatchEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PhoneNumber" ADD COLUMN     "areaCode" TEXT,
ADD COLUMN     "cooldownUntil" TIMESTAMP(3),
ADD COLUMN     "healthScore" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "rateCenterLata" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "totalCallsToday" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCallsWeek" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "DIDGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DIDGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DIDGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "phoneId" TEXT NOT NULL,

    CONSTRAINT "DIDGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDIDGroup" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "CampaignDIDGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaCodeMap" (
    "areaCode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "overlays" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AreaCodeMap_pkey" PRIMARY KEY ("areaCode")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "DIDGroup_name_key" ON "DIDGroup"("name");

-- CreateIndex
CREATE INDEX "DIDGroupMember_groupId_idx" ON "DIDGroupMember"("groupId");

-- CreateIndex
CREATE INDEX "DIDGroupMember_phoneId_idx" ON "DIDGroupMember"("phoneId");

-- CreateIndex
CREATE UNIQUE INDEX "DIDGroupMember_groupId_phoneId_key" ON "DIDGroupMember"("groupId", "phoneId");

-- CreateIndex
CREATE INDEX "CampaignDIDGroup_campaignId_idx" ON "CampaignDIDGroup"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDIDGroup_campaignId_groupId_key" ON "CampaignDIDGroup"("campaignId", "groupId");

-- CreateIndex
CREATE INDEX "AreaCodeMap_state_idx" ON "AreaCodeMap"("state");

-- CreateIndex
CREATE INDEX "AreaCodeMap_region_idx" ON "AreaCodeMap"("region");

-- CreateIndex
CREATE INDEX "Call_agentId_createdAt_idx" ON "Call"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "Call_direction_createdAt_idx" ON "Call"("direction", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignAttempt_campaignId_status_completedAt_idx" ON "CampaignAttempt"("campaignId", "status", "completedAt");

-- CreateIndex
CREATE INDEX "CampaignAttempt_campaignId_completedAt_idx" ON "CampaignAttempt"("campaignId", "completedAt");

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_priority_nextAttemptAt_idx" ON "CampaignContact"("campaignId", "priority", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CampaignContact_status_nextAttemptAt_idx" ON "CampaignContact"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PhoneNumber_areaCode_idx" ON "PhoneNumber"("areaCode");

-- CreateIndex
CREATE INDEX "PhoneNumber_state_idx" ON "PhoneNumber"("state");

-- CreateIndex
CREATE INDEX "PhoneNumber_region_idx" ON "PhoneNumber"("region");

-- CreateIndex
CREATE INDEX "PhoneNumber_isActive_healthScore_idx" ON "PhoneNumber"("isActive", "healthScore");

-- CreateIndex
CREATE INDEX "PhoneNumber_cooldownUntil_idx" ON "PhoneNumber"("cooldownUntil");

-- CreateIndex
CREATE INDEX "Voicemail_assignedToId_isRead_idx" ON "Voicemail"("assignedToId", "isRead");

-- CreateIndex
CREATE INDEX "Voicemail_createdAt_idx" ON "Voicemail"("createdAt");

-- AddForeignKey
ALTER TABLE "DIDGroupMember" ADD CONSTRAINT "DIDGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DIDGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DIDGroupMember" ADD CONSTRAINT "DIDGroupMember_phoneId_fkey" FOREIGN KEY ("phoneId") REFERENCES "PhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDIDGroup" ADD CONSTRAINT "CampaignDIDGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDIDGroup" ADD CONSTRAINT "CampaignDIDGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DIDGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
