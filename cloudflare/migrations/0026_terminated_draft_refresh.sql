DROP TRIGGER draft_refresh_after_subscription_update;

CREATE TRIGGER draft_refresh_after_subscription_update
AFTER UPDATE OF name, plan_id, status, terminated_at ON subscriptions
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE subscription_id = NEW.id AND status = 'draft';
END;
