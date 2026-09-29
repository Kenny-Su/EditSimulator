# Edit Workbench

Local annotation tool for LLM revisions of scientific passages. Flask, SQLite, and vanilla JavaScript.

## Run

Python 3.10+:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set OPENAI_API_KEY and OPENAI_MODEL in .env.
python app.py
```

Open http://127.0.0.1:5000. Run one process, without a reloader. Restart after configuration changes. Generation requires API credentials; annotation does not.

## Instructions

1. Import ACM full-text XML and select a passage.
2. Write one request or prohibition per line; generate a revision.
3. Review the unified diff. Label each edit's acceptability and change type. Give a reason for unacceptable edits, including unauthorized changes. Confirm each edit.
4. Select fulfilling edits for each request; an empty list means omitted. For prohibitions, judge compliance and select violations. Confirm the clauses.
5. Mark reviewed and export JSON.

Split or merge groups when changes need separate judgments. Drafts autosave; wait for the saved status before leaving.

## Definition of done

Every edit and clause is confirmed, every unacceptable edit has a reason, and the run is marked reviewed. Label or grouping changes reopen review.

## Data

- Database: `instance/workbench.sqlite3`; override with `WORKBENCH_DB`. Stop the app before backing up `instance/`.
- Generation sends the passage and instruction to the configured provider. Optional gateway: `OPENAI_BASE_URL`.
- Exports retain frozen inputs, provenance, and labels. Offsets are half-open Unicode code points.
- Schema v3 resets older workbench databases on startup. Current data persists across restarts. Deletions are permanent.
