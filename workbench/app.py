import json
import os
import sqlite3
from functools import partial
from pathlib import Path

from flask import Flask, abort, g, jsonify, render_template, request

from . import db as storage, diffing, generation, requirements, acm_xml


def create_app(config=None):
    root = Path(__file__).resolve().parent.parent
    app = Flask(__name__, template_folder=str(root / "templates"), static_folder=str(root / "static"))
    app.config.update(
        DATABASE=os.getenv("WORKBENCH_DB", str(root / "instance" / "workbench.sqlite3")),
        OPENAI_API_KEY=os.getenv("OPENAI_API_KEY", ""), OPENAI_MODEL=os.getenv("OPENAI_MODEL", ""),
        OPENAI_BASE_URL=os.getenv("OPENAI_BASE_URL", generation.DEFAULT_BASE_URL),
        GENERATOR=None, MAX_CONTENT_LENGTH=12 * 1024 * 1024,
    )
    app.config.update(config or {})
    if app.config["GENERATOR"] is None:
        app.config["GENERATOR"] = partial(generation.generate, base_url=app.config["OPENAI_BASE_URL"])
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    storage.initialize(app.config["DATABASE"])

    def db():
        if "db" not in g:
            g.db = storage.connect(app.config["DATABASE"])
        return g.db

    @app.teardown_appcontext
    def close_db(_error):
        connection = g.pop("db", None)
        if connection:
            connection.close()

    @app.before_request
    def local_only():
        if request.host.split(":")[0] not in ("localhost", "127.0.0.1"):
            abort(403, description="This workbench only accepts localhost requests.")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("Origin") and request.headers["Origin"] != request.host_url.rstrip("/"):
                abort(403, description="Cross-origin writes are not allowed.")
            if not request.is_json:
                abort(415, description="Send application/json.")

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(409)
    @app.errorhandler(413)
    @app.errorhandler(415)
    def api_error(error):
        return jsonify(error=error.description), error.code

    def payload():
        value = request.get_json()
        if not isinstance(value, dict):
            abort(400, description="Expected a JSON object.")
        return value

    def text_field(data, name):
        value = data.get(name, "")
        if not isinstance(value, str):
            abort(400, description=f"{name} must be text.")
        return value

    def get_case(case_id):
        value = storage.case_record(db(), case_id)
        if not value:
            abort(404, description="Case not found.")
        return value

    def get_run(run_id, completed=False):
        value = storage.run_record(db(), run_id)
        if not value:
            abort(404, description="Run not found.")
        if completed and value["status"] != "completed":
            abort(409, description="Only completed generations can be annotated.")
        return value

    def get_paper(paper_id, include_xml=False):
        if not isinstance(paper_id, str):
            abort(400, description="Choose an imported ACM paper.")
        paper = storage.paper_record(db(), paper_id, include_xml)
        if not paper:
            abort(404, description="Imported paper not found.")
        return paper

    def display_run(run):
        if run["status"] == "completed":
            original, revised = run["snapshot"]["original"], run["revised"]
            run["unified_segments"] = diffing.unified_segments(original, revised, run["edits"])
            for edit in run["edits"]:
                for side, text in (("original", original), ("revised", revised)):
                    start, end = edit[f"{side}_start"], edit[f"{side}_end"]
                    edit[f"{side}_text"] = text[start:end]
                    # Send boundary labels as well as offsets, avoiding JS slicing of code points.
                    edit[f"{side}_boundaries"] = [
                        {"offset": start + cut, "label": (text[start:start + cut][-28:] + " | "
                         + text[start + cut:end][:28]).replace("\n", "↵").replace("\t", "⇥").replace(" ", "·")}
                        for cut in diffing.boundaries(text[start:end])
                    ]
        return run

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/config")
    def configuration():
        return jsonify(model=app.config["OPENAI_MODEL"],
                       generation_ready=bool(app.config["OPENAI_API_KEY"] and app.config["OPENAI_MODEL"]))

    @app.get("/api/cases")
    def list_cases():
        result = []
        for row in db().execute("SELECT id FROM cases ORDER BY updated_at DESC, id"):
            case = get_case(row["id"])
            latest = db().execute("SELECT id FROM runs WHERE case_id=? ORDER BY created_at DESC LIMIT 1",
                                  (case["id"],)).fetchone()
            run = get_run(latest["id"]) if latest else None
            case["latest_run"] = {key: run[key] for key in
                                  ("id", "status", "reviewed_at", "labeled_count")} if run else None
            if run:
                case["latest_run"]["edit_count"] = len(run["edits"])
            result.append(case)
        return jsonify(cases=result)

    @app.get("/api/papers")
    def list_papers():
        papers = [get_paper(r["id"]) for r in db().execute("SELECT id FROM papers ORDER BY created_at DESC")]
        return jsonify(papers=[{k: p[k] for k in ("id", "title", "doi", "filename")} for p in papers])

    @app.get("/api/papers/<paper_id>")
    def read_paper(paper_id):
        return jsonify(get_paper(paper_id))

    @app.post("/api/papers")
    def import_paper():
        data = payload()
        xml = text_field(data, "xml")
        try:
            document = acm_xml.parse(xml)
        except ValueError as error:
            abort(400, description=str(error))
        with db():
            db().execute("BEGIN IMMEDIATE")
            existing = db().execute("SELECT id FROM papers WHERE sha256=?", (document["sha256"],)).fetchone()
            paper_id = existing["id"] if existing else storage.uid()
            if not existing:
                db().execute("INSERT INTO papers VALUES (?,?,?,?,?,?)", (
                    paper_id, document["sha256"], xml, json.dumps(document),
                    Path(text_field(data, "filename")).name or "article.xml", storage.now()))
        return jsonify(get_paper(paper_id)), 200 if existing else 201

    @app.post("/api/cases")
    def create_case():
        data = payload()
        if set(data) - {"paper_id", "section_id", "paragraph_ids", "instruction"}:
            abort(400, description="Source text and metadata must come from imported ACM XML.")
        paper = get_paper(data.get("paper_id"))
        try:
            original, provenance = acm_xml.selection(paper, data)
        except ValueError as error:
            abort(400, description=str(error))
        instruction = text_field(data, "instruction")
        stamp, source_id, case_id = storage.now(), storage.uid(), storage.uid()
        with db():
            db().execute("INSERT INTO sources VALUES (?,?,?,?,?,?,?)", (
                source_id, paper["url"], paper["title"], paper["sha256"], provenance["section_title"], stamp, stamp))
            db().execute("INSERT INTO cases (id,source_id,original,instruction,created_at,updated_at,provenance_json) VALUES (?,?,?,?,?,?,?)", (
                case_id, source_id, original, instruction, stamp, stamp, json.dumps(provenance)))
        return jsonify(get_case(case_id)), 201

    @app.patch("/api/cases/<case_id>")
    def update_case(case_id):
        case, data = get_case(case_id), payload()
        if set(data) - {"instruction"}:
            abort(400, description="Imported text and source metadata are read-only. Create a new passage to change the selection.")
        with db():
            if "instruction" in data:
                db().execute("UPDATE cases SET instruction=?,updated_at=? WHERE id=?",
                             (text_field(data, "instruction"), storage.now(), case_id))
        return jsonify(get_case(case_id))

    @app.get("/api/cases/<case_id>")
    def read_case(case_id):
        case = get_case(case_id)
        case["runs"] = [dict(row) for row in db().execute(
            "SELECT id, status, model, created_at, reviewed_at FROM runs WHERE case_id=? ORDER BY created_at DESC",
            (case_id,))]
        return jsonify(case)

    @app.post("/api/cases/<case_id>/generate")
    def generate(case_id):
        payload()
        case = get_case(case_id)
        if not all(value.strip() for value in (case["original"], case["instruction"], case["source"]["identifier"])):
            abort(400, description="Select an ACM passage and add an editing instruction before generating.")
        if not app.config["OPENAI_API_KEY"] or not app.config["OPENAI_MODEL"]:
            abort(400, description="Set OPENAI_API_KEY and OPENAI_MODEL in .env or your shell, then restart the app.")
        snapshot = {key: case[key] for key in ("original", "instruction", "source", "provenance")}
        api_request = generation.build_request(snapshot, app.config["OPENAI_MODEL"])
        stamp, run_id = storage.now(), storage.uid()
        try:
            with db():
                db().execute("BEGIN IMMEDIATE")
                db().execute("""INSERT INTO runs
                    (id, case_id, status, snapshot_json, request_json, model, created_at, updated_at)
                    VALUES (?,?,'pending',?,?,?,?,?)""",
                    (run_id, case_id, json.dumps(snapshot), json.dumps(api_request),
                     app.config["OPENAI_MODEL"], stamp, stamp))
        except sqlite3.IntegrityError:
            abort(409, description="A generation is already running. Wait for it to finish.")
        try:
            result = app.config["GENERATOR"](api_request, app.config["OPENAI_API_KEY"])
            text = result.get("text") or ""
            complete = result.get("status") == "completed" and bool(text.strip())
            status = "completed" if complete else "incomplete"
            error = None if complete else "The model did not return a complete, nonempty revision. Retry as a new run."
            with db():
                db().execute("""UPDATE runs SET status=?, revised=?, response_json=?, response_id=?,
                    model=?, error=?, updated_at=? WHERE id=?""",
                    (status, text, json.dumps(result["raw"]), result.get("id"),
                     result.get("model") or app.config["OPENAI_MODEL"], error, storage.now(), run_id))
                if complete:
                    for position, span in enumerate(diffing.sentence_edits(snapshot["original"], text)):
                        storage.add_group(db(), run_id, position, span)
                    db().execute("INSERT INTO requirement_audits (run_id,annotation_json,updated_at) VALUES (?,?,?)",
                                 (run_id, json.dumps(requirements.initial_requirements(snapshot)), storage.now()))
        except Exception as error:
            # Provider exception strings may echo request content or credentials. Store only safe diagnostics.
            code = getattr(error, "status_code", None)
            message = f"Generation failed ({type(error).__name__}" + (f", HTTP {code}" if code else "") + "). Retry as a new run."
            with db():
                db().execute("UPDATE runs SET status='failed', error=?, updated_at=? WHERE id=?",
                             (message, storage.now(), run_id))
        return jsonify(display_run(get_run(run_id))), 201

    @app.get("/api/runs/<run_id>")
    def read_run(run_id):
        return jsonify(display_run(get_run(run_id)))

    @app.route("/api/runs/<run_id>/requirements", methods=["PUT", "DELETE"])
    def requirements_audit(run_id):
        data = payload()
        with db():
            db().execute("BEGIN IMMEDIATE")
            run = get_run(run_id, completed=True)
            stamp = storage.now()
            confirmed = request.method == "PUT" and data.get("confirmed") is True
            rows = requirements.initial_requirements(run['snapshot']) if request.method == "DELETE" else data.get("requirements")
            try:
                requirements.validate_requirements(rows, run, draft=not confirmed)
            except ValueError as error:
                abort(400, description=str(error))
            db().execute("""INSERT INTO requirement_audits (run_id,annotation_json,confirmed_at,updated_at)
                VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET annotation_json=excluded.annotation_json,
                confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at""",
                (run_id, json.dumps(rows), stamp if confirmed else None, stamp))
            db().execute("UPDATE runs SET reviewed_at=NULL,updated_at=? WHERE id=?", (stamp, run_id))
        return jsonify(display_run(get_run(run_id)))

    @app.put("/api/edits/<edit_id>/annotation")
    def annotate(edit_id):
        data = payload()
        group = db().execute("SELECT * FROM edit_groups WHERE id=?", (edit_id,)).fetchone()
        if not group:
            abort(404, description="Edit not found. It may have been regrouped.")
        get_run(group["run_id"], completed=True)
        acceptability, change_type = data.get("acceptability"), data.get("change_type")
        reason = text_field(data, "reason")
        dimensions = data.get("dimensions", [])
        if acceptability not in (None, "acceptable", "unacceptable", "uncertain"):
            abort(400, description="Invalid acceptability label.")
        if change_type not in (None, "wording_only", "fidelity_relevant", "uncertain"):
            abort(400, description="Invalid change type.")
        if not isinstance(dimensions, list) or any(not isinstance(x, str) or x not in
                ("certainty", "precision", "scope", "emphasis", "other") for x in dimensions):
            abort(400, description="Invalid fidelity dimensions.")
        if change_type != "fidelity_relevant":
            dimensions = []
        confirmed = data.get("confirmed") is True
        if confirmed and not (acceptability and change_type):
            abort(400, description="Choose both labels before confirming.")
        if confirmed and acceptability == "unacceptable" and not reason.strip():
            abort(400, description="Add a short reason before confirming an unacceptable edit.")
        stamp = storage.now()
        with db():
            db().execute("""INSERT INTO annotations
                (edit_id, acceptability, change_type, dimensions_json, reason, created_at, updated_at, confirmed_at)
                VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(edit_id) DO UPDATE SET
                acceptability=excluded.acceptability, change_type=excluded.change_type,
                reason=excluded.reason,
                dimensions_json=excluded.dimensions_json, updated_at=excluded.updated_at,
                confirmed_at=excluded.confirmed_at""",
                (edit_id, acceptability, change_type, json.dumps(list(dict.fromkeys(dimensions))), reason, stamp, stamp, stamp if confirmed else None))
            db().execute("UPDATE runs SET reviewed_at=NULL, updated_at=? WHERE id=?", (stamp, group["run_id"]))
        return jsonify(display_run(get_run(group["run_id"])))

    @app.delete("/api/edits/<edit_id>/annotation")
    def delete_annotation(edit_id):
        payload()
        with db():
            db().execute("BEGIN IMMEDIATE")
            group = db().execute("SELECT run_id FROM edit_groups WHERE id=?", (edit_id,)).fetchone()
            if not group:
                abort(404, description="Edit not found.")
            get_run(group["run_id"], completed=True)
            db().execute("DELETE FROM annotations WHERE edit_id=?", (edit_id,))
            db().execute("UPDATE runs SET reviewed_at=NULL, updated_at=? WHERE id=?",
                         (storage.now(), group["run_id"]))
        return jsonify(display_run(get_run(group["run_id"])))

    def remove_run(run_id):
        run = get_run(run_id)
        if run["status"] == "pending":
            abort(409, description="Wait for the model request to finish before deleting.")
        # Edit deletion cascades to annotations.
        db().execute("DELETE FROM requirement_audits WHERE run_id=?", (run_id,))
        db().execute("DELETE FROM edit_groups WHERE run_id=?", (run_id,))
        db().execute("DELETE FROM runs WHERE id=?", (run_id,))

    @app.delete("/api/runs/<run_id>")
    def delete_run(run_id):
        payload()
        with db():
            db().execute("BEGIN IMMEDIATE")
            remove_run(run_id)
        return jsonify(deleted=run_id)

    @app.delete("/api/cases/<case_id>")
    def delete_case(case_id):
        payload()
        with db():
            db().execute("BEGIN IMMEDIATE")
            case = get_case(case_id)
            for row in db().execute("SELECT id FROM runs WHERE case_id=?", (case_id,)).fetchall():
                remove_run(row["id"])
            db().execute("DELETE FROM cases WHERE id=?", (case_id,))
            db().execute("DELETE FROM sources WHERE id=? AND NOT EXISTS (SELECT 1 FROM cases WHERE source_id=?)",
                         (case["source_id"], case["source_id"]))
        return jsonify(deleted=case_id)

    @app.post("/api/runs/<run_id>/regroup")
    def regroup(run_id):
        data = payload()
        with db():
            db().execute("BEGIN IMMEDIATE")
            run = get_run(run_id, completed=True)
            groups = run["edits"]
            index = next((i for i, e in enumerate(groups) if e["id"] == data.get("edit_id")), None)
            if index is None:
                abort(404, description="Edit not found.")
            group = groups[index]
            if data.get("action") == "merge":
                if index + 1 >= len(groups):
                    abort(400, description="There is no next edit to merge.")
                following = groups[index + 1]
                replacement = [{"original_start": group["original_start"], "original_end": following["original_end"],
                                "revised_start": group["revised_start"], "revised_end": following["revised_end"]}]
                removed = groups[index:index + 2]
            elif data.get("action") == "split":
                try:
                    replacement = diffing.split_spans(run["snapshot"]["original"], run["revised"], group,
                                                       data.get("original_cut"), data.get("revised_cut"))
                except ValueError as error:
                    abort(400, description=str(error))
                removed = [group]
            else:
                abort(400, description="Choose merge or split.")
            # Regrouping changes evidence IDs: keep human judgments as drafts, clear their links.
            audit = run["requirement_audit"]
            if audit:
                rows = audit["annotation"]
                removed_ids = {e["id"] for e in removed}
                for row in rows or []:
                    row["edit_ids"] = [i for i in row.get("edit_ids", []) if i not in removed_ids]
                    if row["kind"] == "request":
                        row["outcome"] = "fulfilled" if row["edit_ids"] else "not_fulfilled"
                db().execute("UPDATE requirement_audits SET annotation_json=?,confirmed_at=NULL,updated_at=? WHERE run_id=?",
                             (json.dumps(rows or []), storage.now(), run_id))
            for old in removed:
                db().execute("DELETE FROM edit_groups WHERE id=?", (old["id"],))
            new_ids = [storage.add_group(db(), run_id, index + i, span) for i, span in enumerate(replacement)]
            order = [e["id"] for e in groups[:index]] + new_ids + [e["id"] for e in groups[index + len(removed):]]
            for position, edit_id in enumerate(order):
                db().execute("UPDATE edit_groups SET position=? WHERE id=?", (position, edit_id))
            db().execute("UPDATE runs SET reviewed_at=NULL, updated_at=? WHERE id=?", (storage.now(), run_id))
        return jsonify(run=display_run(get_run(run_id)), selected_edit_id=new_ids[0])

    @app.post("/api/runs/<run_id>/review")
    def review(run_id):
        data = payload()
        with db():
            db().execute("BEGIN IMMEDIATE")
            run = get_run(run_id, completed=True)
            if not run["requirement_audit"] or not run["requirement_audit"]["confirmed_at"]:
                abort(400, description="Confirm instruction requirements before marking reviewed.")
            if any(not e["complete"] for e in run["edits"]):
                abort(400, description="Confirm labels for every edit before marking reviewed.")
            if not run["edits"] and data.get("confirm_zero_edits") is not True:
                abort(400, description="Confirm that you reviewed this unchanged revision.")
            stamp = storage.now()
            db().execute("UPDATE runs SET reviewed_at=?, updated_at=? WHERE id=?", (stamp, stamp, run_id))
        return jsonify(display_run(get_run(run_id)))

    @app.get("/api/export")
    def export():
        reviewed_only = request.args.get("scope", "all") == "reviewed"
        cases = []
        with db():
            db().execute("BEGIN")
            for row in db().execute("SELECT id FROM cases ORDER BY created_at"):
                case = get_case(row["id"])
                runs = [get_run(r["id"]) for r in db().execute(
                    "SELECT id FROM runs WHERE case_id=? ORDER BY created_at", (case["id"],))]
                case["runs"] = [r for r in runs if r["reviewed_at"] and r["requirement_audit"] and r["requirement_audit"]["confirmed_at"] and all(e["complete"] for e in r["edits"])] if reviewed_only else runs
                if not reviewed_only or case["runs"]:
                    cases.append(case)
            paper_ids = {c["provenance"]["paper_id"] for c in cases if c["provenance"]}
            paper_ids.update(r["snapshot"]["provenance"]["paper_id"] for c in cases for r in c["runs"] if r["snapshot"].get("provenance"))
            papers = [get_paper(pid, True) for pid in sorted(paper_ids)]
        result = {"schema_version": 5, "exported_at": storage.now(),
                  "span_convention": "half-open Unicode code-point offsets into immutable run snapshot.original and run.revised",
                  "scope": "reviewed" if reviewed_only else "all", "cases": cases, "papers": papers}
        response = jsonify(result)
        response.headers["Content-Disposition"] = 'attachment; filename="edit-workbench-' + result["scope"] + '.json"'
        return response

    return app
