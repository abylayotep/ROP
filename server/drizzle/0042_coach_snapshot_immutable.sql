CREATE FUNCTION coach_message_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_snapshot IS DISTINCT FROM NEW.source_snapshot THEN
    RAISE EXCEPTION 'Coach message source snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER coach_message_snapshot_immutable_trigger BEFORE UPDATE ON coach_messages
FOR EACH ROW EXECUTE FUNCTION coach_message_snapshot_immutable();
