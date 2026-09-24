# Edit Workbench

A small local app for collecting genuine scientific-text revisions and labeling their edits. Python, Flask, SQLite, plain HTML/CSS, and vanilla JavaScript. No frontend build step or hosted account.

## Run

Requires Python 3.10 or newer.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Edit .env to set OPENAI_API_KEY and OPENAI_MODEL before starting.
python app.py
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). Choose a model available to your API account that supports the Responses API. No model is silently selected. You can save passages and review existing runs without credentials; generation requires both variables. `python app.py` automatically loads the project's `.env`; existing shell environment variables take precedence. Restart after changing configuration. `.env` is excluded from Git.

Only one app process should use a database at a time. Start with `python app.py`; do not enable Flask's reloader or multiple workers. At startup, previously pending generations become interrupted runs so they can be explicitly retried.

## Workflow

1. Paste a paragraph or several related paragraphs. Clean up PDF artifacts before generation. Record the paper URL and optional paper title.
2. Write one editing instruction, including any limits such as “preserve numbers.” Inputs autosave as drafts, even when incomplete. The paper URL, passage, and instruction must be present before generation. There is no separate rule or constraint field.
3. Generate one revision. Its passage, source metadata, instructions, exact API request, response, and timestamps are frozen. The model sees the passage as source data, separately from the instructions. No errors or labels are deliberately generated.
4. Review one changed sentence pair at a time, with token changes highlighted and one neighboring sentence before and after on each side. Splits/merges of up to three sentences are aligned together; unchanged pairs are skipped. The full passage is available in an expandable view. Click an item in the edit list. Choose acceptability (acceptable, unacceptable, uncertain) independently from change type (wording only, fidelity relevant, uncertain). All combinations are allowed. Choose optional fidelity dimensions when relevant. Both labels complete an annotation; no reason is required. Partial judgments are saved as drafts.
5. Open **Adjust grouping** if a sentence contains changes requiring different judgments. If necessary, merge an edit with the next one or choose token boundaries in both texts to split it. Both resulting groups must contain a change. Affected labels are cleared; other labels are preserved. Moved text is represented as insertion/deletion, not automatically recognized as a move.
6. Mark the run reviewed after every edit is complete. Zero-edit runs are retained and require an explicit review confirmation. Accept/reject labels never alter the model's text. Changing labels or grouping reopens the review.
7. Export all cases or reviewed runs to JSON. Reviewed export contains only reviewed runs from qualifying cases. Each run includes its frozen input snapshot; case-level fields represent the current editable draft.

Use the run selector to revisit old generations. Change the draft instruction and generate again to reuse the passage. Retries create new runs and retain failures. Generation does not retry automatically. Failed, interrupted, refused/empty, or incomplete results are not available for annotation.

The default API base URL is `https://api.openai.com/v1`. To use a custom gateway, replace the placeholder below with its base URL before starting the app:

```sh
export OPENAI_BASE_URL='https://gateway.example.com/openai'
```

Unset `OPENAI_BASE_URL` to return to the standard OpenAI endpoint. Restart the app after changing it. The SDK appends `/responses` to the configured base; use the exact base URL supplied by your gateway provider. The override does not supply API credentials or a model.

## Data and privacy

- Default database: `instance/workbench.sqlite3`. Override with `WORKBENCH_DB=/absolute/path/to/workbench.sqlite3`.
- Data stays in SQLite locally, but generating sends the passage and instruction to OpenAI, through a gateway only if configured. The API request sets `store=False`; this is not a claim of zero provider or gateway retention.
- Credentials are read from your local `.env` or shell environment, never saved to the database or sent to the browser. Local API errors store the exception type and HTTP status rather than potentially sensitive provider error text.
- Exports use `schema_version: 1` and include stable source/case/run/edit IDs, annotations, timestamps, exact request parameters, and raw responses. They exclude credentials. Offsets are half-open **Unicode code-point** offsets into `run.snapshot.original` and `run.revised`, not JavaScript UTF-16 indices.
- To back up the database, stop the app and copy `instance/` (including SQLite sidecar files if present). JSON is a portable dataset export; this version has no import/restore UI.
- Autosave has a short delay. Wait for the saved indicator before closing. The browser warns when work or a generation is still pending. On a save error, keep the page open and edit again to retry.
- Bind only to localhost. There is no login or support for hosting this app publicly. Writes require JSON and same-origin requests.

## Test

```sh
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

The small integrity suite uses temporary databases and mocked responses, with no API calls. It checks sentence spans and Unicode, annotation persistence and export provenance, split/merge label invalidation, and zero-edit review.

## Layout

- `workbench/app.py`: routes and request validation.
- `workbench/db.py`: SQLite schema and records.
- `workbench/diffing.py`: lossless token alignment, spans, and display segments.
- `workbench/generation.py`: prompt and OpenAI SDK call.
- `templates/` and `static/`: browser interface.

Deferred: PDF/arXiv import, batch generation, automated auditing or labels, semantic move detection, multiple annotators, rule inference, and study management.

Sentence grouping uses a lightweight English sentence splitter and monotonic alignment. Unlabeled, unreviewed legacy runs are regrouped automatically; existing annotations and reviewed runs retain their original groups. Manual split/merge remains available for alignment mistakes.
