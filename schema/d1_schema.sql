-- D1 "codingpilot": gelernte Zuordnungen (früher Data/codingpilot_rules.csv).
-- Ein RuleType definiert, welche Schlüsselspalten gelten; nicht benötigte bleiben ''.
CREATE TABLE IF NOT EXISTS codingpilot_rules (
  RuleType     TEXT NOT NULL,
  Broker       TEXT NOT NULL DEFAULT '',
  AccountOwner TEXT NOT NULL DEFAULT '',
  Currency     TEXT NOT NULL DEFAULT '',
  SecurityID   TEXT NOT NULL DEFAULT '',
  CustodyID    TEXT NOT NULL DEFAULT '',
  Value        TEXT NOT NULL,
  updated_by   TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (RuleType, Broker, AccountOwner, Currency, SecurityID, CustodyID)
);
