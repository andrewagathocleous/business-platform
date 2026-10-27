-- R0-A review fixes. prisma migrate dev --create-only emitted only the ADD COLUMN below,
-- and no DROP. The trigger is hand-written.
-- AlterTable
ALTER TABLE "platform_owner_enrolment" ADD COLUMN     "expected_entra_oid" TEXT;

-- Only the owner CLI (bp_owner) may make someone a platform owner, or change a platform
-- owner's status. The application role bp_app keeps its other user_account writes.
CREATE OR REPLACE FUNCTION user_account_owner_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'bp_app' THEN
    IF NEW.is_platform_owner
       AND (TG_OP = 'INSERT' OR OLD.is_platform_owner IS DISTINCT FROM NEW.is_platform_owner) THEN
      RAISE EXCEPTION 'is_platform_owner can be set only by the owner CLI'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.is_platform_owner AND OLD.status IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION 'a platform owner''s status can be changed only by the owner CLI'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_account_owner_guard
  BEFORE INSERT OR UPDATE OF is_platform_owner, status ON user_account
  FOR EACH ROW
  EXECUTE FUNCTION user_account_owner_guard();
