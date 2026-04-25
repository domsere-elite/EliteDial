-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "precheckBlockedReasons" TEXT,
ADD COLUMN     "retellAgentPromptVersion" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "retellAgentId" TEXT,
ADD COLUMN     "retellAgentPromptVersion" TEXT,
ADD COLUMN     "retellSipAddress" TEXT;
