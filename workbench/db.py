import json
import sqlite3
from contextlib import closing
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
    with closing(connect(path)) as db, db:
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version > 3:
            raise ValueError("Database was created by a newer workbench.")
        db.execute("PRAGMA journal_mode = WAL")
        # Pre-v3 datasets are disposable; reset rather than migrate them.
        reset = "" if version == 3 else "".join(
            f"DROP TABLE IF EXISTS {table};" for table in (
                "annotations", "suggestions", "requirement_audits", "edit_groups",
                "suggestion_jobs", "runs", "cases", "sources", "papers"))
        db.executescript("BEGIN IMMEDIATE;" + reset + """
        CREATE TABLE IF NOT EXISTS papers (
          id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, xml TEXT NOT NULL,
          document_json TEXT NOT NULL, filename TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY, identifier TEXT NOT NULL, title TEXT NOT NULL,
          version TEXT NOT NULL, section TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cases (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
          original TEXT NOT NULL, instruction TEXT NOT NULL, provenance_json TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
          status TEXT NOT NULL, snapshot_json TEXT NOT NULL, request_json TEXT NOT NULL,
          model TEXT NOT NULL, response_json TEXT, response_id TEXT, revised TEXT,
          error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_at TEXT
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
          reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          confirmed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS requirement_audits (
          run_id TEXT PRIMARY KEY REFERENCES runs(id), annotation_json TEXT NOT NULL,
          confirmed_at TEXT, updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 3;
        COMMIT;
        """)
        db.execute("UPDATE runs SET status='interrupted', error=?, updated_at=? WHERE status='pending'",
                   ("Generation interrupted. Retry as a new run.", now()))


def annotation_complete(a):
    return bool(a and a.get("acceptability") and a.get("change_type") and a.get("confirmed_at")
                and (a["acceptability"] != "unacceptable" or a.get("reason", "").strip()))


def case_record(db, case_id):
    row = db.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
    if not row:
        return None
    case = dict(row)
    case["provenance"] = json.loads(case.pop("provenance_json"))
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
    audit = db.execute("SELECT * FROM requirement_audits WHERE run_id=?", (run_id,)).fetchone()
    run["requirement_audit"] = dict(audit) if audit else None
    if audit:
        run["requirement_audit"]["annotation"] = json.loads(run["requirement_audit"].pop("annotation_json"))
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


def paper_record(db, paper_id, include_xml=False):
    row = db.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    if not row:
        return None
    paper = json.loads(row["document_json"])
    paper.update(id=row["id"], filename=row["filename"], imported_at=row["created_at"])
    if include_xml:
        paper["xml"] = row["xml"]
    return paper
