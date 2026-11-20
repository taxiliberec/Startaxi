CREATE TABLE dispatch (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);
INSERT INTO dispatch (id, revision, data) VALUES (1, 0, '{"jobs":[],"positions":{},"shifts":[],"seq":1000}');
