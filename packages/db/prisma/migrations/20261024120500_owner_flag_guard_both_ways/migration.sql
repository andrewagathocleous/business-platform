-- R0-A review fix: the application role may not change is_platform_owner in either
-- direction. Demoting an owner through bp_app would skip the CLI's last-owner check,
-- session revocation and audit. Hand-written; no schema change.
CREATE OR REPLACE FUNCTION user_account_owner_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'bp_app' THEN
    IF TG_OP = 'INSERT' AND NEW.is_platform_owner THEN
      RAISE EXCEPTION 'is_platform_owner can be set only by the owner CLI'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.is_platform_owner IS DISTINCT FROM NEW.is_platform_owner THEN
      RAISE EXCEPTION 'is_platform_owner can be changed only by the owner CLI'
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
