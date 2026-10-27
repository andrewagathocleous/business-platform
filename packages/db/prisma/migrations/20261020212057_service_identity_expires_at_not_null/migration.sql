/*
  Warnings:

  - Made the column `expires_at` on table `service_identity` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "service_identity" ALTER COLUMN "expires_at" SET NOT NULL;
