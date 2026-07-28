CREATE TABLE IF NOT EXISTS downloads (
  version TEXT NOT NULL,
  day     TEXT NOT NULL,
  channel TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version, day, channel)
);

CREATE INDEX IF NOT EXISTS downloads_by_day ON downloads (day);
