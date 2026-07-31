CREATE TABLE downloads_with_platform (
  version  TEXT NOT NULL,
  day      TEXT NOT NULL,
  channel  TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (version, day, channel, platform)
);

INSERT INTO downloads_with_platform (version, day, channel, count)
SELECT version, day, channel, count FROM downloads;

DROP TABLE downloads;

ALTER TABLE downloads_with_platform RENAME TO downloads;

CREATE INDEX IF NOT EXISTS downloads_by_day ON downloads (day);
