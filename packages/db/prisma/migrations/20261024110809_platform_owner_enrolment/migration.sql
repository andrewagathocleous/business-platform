-- Platform owner enrolment (R0-A). prisma migrate dev --create-only emitted the
-- ADD COLUMN, CREATE TABLE, indexes and foreign key below, and no DROP. The
-- partial unique indexes, RLS policies, grants and triggers of earlier migrations stay.
-- AlterTable
ALTER TABLE "auth_flow" ADD COLUMN     "enrolment_token_hash" TEXT;

-- CreateTable
CREATE TABLE "platform_owner_enrolment" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_owner_enrolment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_owner_enrolment_token_hash_key" ON "platform_owner_enrolment"("token_hash");

-- CreateIndex
CREATE INDEX "platform_owner_enrolment_user_id_idx" ON "platform_owner_enrolment"("user_id");

-- AddForeignKey
ALTER TABLE "platform_owner_enrolment" ADD CONSTRAINT "platform_owner_enrolment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only the owner CLI (bp_owner) creates, revokes or deletes enrolments.
-- Default privileges give bp_app full DML on new tables, so take it back here:
-- bp_app may read an enrolment and set consumed_at, nothing else.
REVOKE ALL ON TABLE "platform_owner_enrolment" FROM bp_app;
GRANT SELECT ON TABLE "platform_owner_enrolment" TO bp_app;
GRANT UPDATE ("consumed_at") ON TABLE "platform_owner_enrolment" TO bp_app;
