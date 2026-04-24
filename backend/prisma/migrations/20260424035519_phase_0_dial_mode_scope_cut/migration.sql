/*
  Warnings:

  - You are about to drop the column `abandonRateLimit` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `aiOverflowNumber` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `aiTarget` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `aiTargetEnabled` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `dialRatio` on the `Campaign` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "abandonRateLimit",
DROP COLUMN "aiOverflowNumber",
DROP COLUMN "aiTarget",
DROP COLUMN "aiTargetEnabled",
DROP COLUMN "dialRatio",
ALTER COLUMN "dialMode" SET DEFAULT 'manual';
