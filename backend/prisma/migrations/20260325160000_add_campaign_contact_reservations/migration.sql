-- Add reservation fields for campaign contact claiming and preview/progressive concurrency control.
ALTER TABLE "CampaignContact"
ADD COLUMN "reservedByUserId" TEXT,
ADD COLUMN "reservationType" TEXT,
ADD COLUMN "reservationToken" TEXT,
ADD COLUMN "reservationExpiresAt" TIMESTAMP(3);

CREATE INDEX "CampaignContact_campaignId_reservationExpiresAt_idx"
ON "CampaignContact"("campaignId", "reservationExpiresAt");
