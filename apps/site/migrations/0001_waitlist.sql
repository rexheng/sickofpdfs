-- The site's database (spec R111). It holds the cloud sync waitlist and the numbers the home page shows. Nothing else.

-- One row per email address: lowercased and trimmed, and the day it joined (UTC midnight, in milliseconds since 1970).
-- No name, no IP address, no time of day.
CREATE TABLE waitlist (
  email TEXT PRIMARY KEY,
  created_at INTEGER
);

-- The numbers the page shows, so a visit reads one row instead of counting the whole waitlist.
--   'waitlist'  kept exact by the two triggers below.
--   'cws_users' the public user count on the Chrome Web Store listing, read by the daily job once CWS_ITEM_ID is set.
CREATE TABLE counts (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO counts (name, value, updated_at) VALUES ('waitlist', 0, 0);

-- A duplicate email is not inserted (ON CONFLICT DO NOTHING), so it does not fire the trigger and counts once.
CREATE TRIGGER waitlist_added AFTER INSERT ON waitlist
BEGIN
  UPDATE counts SET value = value + 1, updated_at = NEW.created_at WHERE name = 'waitlist';
END;

CREATE TRIGGER waitlist_removed AFTER DELETE ON waitlist
BEGIN
  UPDATE counts SET value = value - 1 WHERE name = 'waitlist';
END;
