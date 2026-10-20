/*
  Warnings:

  - A unique constraint covering the columns `[company_id,id]` on the table `job` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "print_job" DROP CONSTRAINT "print_job_queue_job_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "job_company_id_id_key" ON "job"("company_id", "id");

-- AddForeignKey
ALTER TABLE "print_job" ADD CONSTRAINT "print_job_company_id_queue_job_id_fkey" FOREIGN KEY ("company_id", "queue_job_id") REFERENCES "job"("company_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
