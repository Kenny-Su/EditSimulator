import json
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return str(uuid4())


def connect(path):
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def initialize(path):
    with connect(path) as db:
        db.executescript("""
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY, identifier TEXT NOT NULL, title TEXT NOT NULL,
          version TEXT NOT NULL, section TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cases (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
          original TEXT NOT NULL, instruction TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
          status TEXT NOT NULL, snapshot_json TEXT NOT NULL, request_json TEXT NOT NULL,
          model TEXT NOT NULL, response_json TEXT, response_id TEXT, revised TEXT,
          error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          reviewed_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_pending_run ON runs(status) WHERE status = 'pending';
        CREATE TABLE IF NOT EXISTS edit_groups (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), position INTEGER NOT NULL,
          original_start INTEGER NOT NULL, original_end INTEGER NOT NULL,
          revised_start INTEGER NOT NULL, revised_end INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS annotations (
          edit_id TEXT PRIMARY KEY REFERENCES edit_groups(id) ON DELETE CASCADE,
          acceptability TEXT, change_type TEXT, dimensions_json TEXT NOT NULL DEFAULT '[]',
          reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        """)
        if "constraints" in {row["name"] for row in db.execute("PRAGMA table_info(cases)")}:
            db.execute("""UPDATE cases SET instruction = CASE WHEN trim(instruction) = ''
                THEN constraints ELSE instruction || char(10) || char(10) || constraints END
                WHERE trim(constraints) != ''""")
            db.execute("ALTER TABLE cases DROP COLUMN constraints")
        db.execute("PRAGMA user_version = 2")
        if "grouping_version" not in {row["name"] for row in db.execute("PRAGMA table_info(runs)")}:
            db.execute("ALTER TABLE runs ADD COLUMN grouping_version INTEGER NOT NULL DEFAULT 0")
        # Only untouched runs can be migrated without invalidating a person's work.
        from .diffing import sentence_edits
        for run in db.execute("""SELECT * FROM runs WHERE status='completed' AND grouping_version=0
                AND reviewed_at IS NULL AND NOT EXISTS (
                  SELECT 1 FROM annotations a JOIN edit_groups e ON a.edit_id=e.id WHERE e.run_id=runs.id
                )""").fetchall():
            original = json.loads(run["snapshot_json"])["original"]
            db.execute("DELETE FROM edit_groups WHERE run_id=?", (run["id"],))
            for position, span in enumerate(sentence_edits(original, run["revised"])):
                add_group(db, run["id"], position, span)
            db.execute("UPDATE runs SET grouping_version=1 WHERE id=?", (run["id"],))
        db.execute("UPDATE runs SET status='interrupted', error=?, updated_at=? WHERE status='pending'",
                   ("The app stopped before generation finished. Retry to create a new run.", now()))
    db.close()


def annotation_complete(a):
    return bool(a and a.get("acceptability") and a.get("change_type"))


def case_record(db, case_id):
    row = db.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
    if not row:
        return None
    case = dict(row)
    case["source"] = dict(db.execute("SELECT * FROM sources WHERE id=?", (case["source_id"],)).fetchone())
    return case


def run_record(db, run_id):
    row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if not row:
        return None
    run = dict(row)
    for field in ("snapshot", "request", "response"):
        value = run.pop(field + "_json")
        run[field] = json.loads(value) if value else None
    run["edits"] = []
    for row in db.execute("SELECT * FROM edit_groups WHERE run_id=? ORDER BY position", (run_id,)):
        group = dict(row)
        a = db.execute("SELECT * FROM annotations WHERE edit_id=?", (group["id"],)).fetchone()
        group["annotation"] = dict(a) if a else None
        if a:
            group["annotation"]["dimensions"] = json.loads(group["annotation"].pop("dimensions_json"))
        group["complete"] = annotation_complete(group["annotation"])
        run["edits"].append(group)
    run["labeled_count"] = sum(e["complete"] for e in run["edits"])
    return run


def add_group(db, run_id, position, span):
    stamp, group_id = now(), uid()
    db.execute("INSERT INTO edit_groups VALUES (?,?,?,?,?,?,?,?,?)", (
        group_id, run_id, position, span["original_start"], span["original_end"],
        span["revised_start"], span["revised_end"], stamp, stamp))
    return group_id
