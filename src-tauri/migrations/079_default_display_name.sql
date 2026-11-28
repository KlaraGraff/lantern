-- Migration 079 — drop a display name that is only the old English default.
--
-- The settings field used to show "Reader" when no name was set and saved it
-- on blur as if the reader had typed it. The default is now localized
-- ("Reader" / 「读者」) and never saved, but names saved the old way stay
-- "Reader" in the Chinese interface. Removing exactly that value lets the
-- localized default show again; any other name the reader chose is untouched.
-- `user_name` is a local setting (not synced), so this needs no sync event.
DELETE FROM settings WHERE key = 'user_name' AND value = 'Reader';
