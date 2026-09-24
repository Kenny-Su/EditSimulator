import json

import pytest

from workbench.app import create_app
from workbench import diffing


def fake_result(text, status="completed"):
    return {"text": text, "id": "response-test", "model": "test-model-snapshot", "status": status,
            "raw": {"id": "response-test", "status": status,
                    "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]}}


@pytest.fixture
def app(tmp_path):
    return create_app({"TESTING": True, "DATABASE": str(tmp_path / "workbench.sqlite3"),
                       "OPENAI_API_KEY": "secret-test-key", "OPENAI_MODEL": "test-model",
                       "GENERATOR": lambda request, key: fake_result("We demonstrate a 12% gain.")})


@pytest.fixture
def client(app):
    return app.test_client()


def new_case(client, original="We observe a 10% gain."):
    response = client.post("/api/cases", json={"original": original, "identifier": "https://arxiv.org/abs/2401.12345",
        "title": "An example paper",
        "instruction": "Make this concise. Preserve numbers and certainty."})
    assert response.status_code == 201, response.json
    return response.json


def generate(client, case):
    response = client.post(f"/api/cases/{case['id']}/generate", json={})
    assert response.status_code == 201, response.json
    return response.json


def label(client, edit_id, **changes):
    value = {"acceptability": "acceptable", "change_type": "wording_only", "dimensions": []}
    value.update(changes)
    response = client.put(f"/api/edits/{edit_id}/annotation", json=value)
    assert response.status_code == 200, response.json
    return response.json


@pytest.mark.parametrize("original,revised", [
    ("The result.", "The new result."), ("The new result.", "The result."),
    ("We may improve.", "We improve."), ("A, B.", "A; B!"),
    ("alpha alpha beta alpha", "alpha beta alpha alpha"),
    ("🧪 A café has α=0.1.\nTwo lines.", "🧪 A café has α=0.2.\n\nTwo lines."),
    ("same\ntext", "same\ntext"), ("", "New text"), ("Old text", ""),
])
def test_diff_spans_reconstruct_revision_without_losing_text(original, revised):
    groups = diffing.sentence_edits(original, revised)
    cursor, result = 0, []
    for i, group in enumerate(groups):
        assert cursor <= group["original_start"] <= group["original_end"] <= len(original)
        result.extend([original[cursor:group["original_start"]], revised[group["revised_start"]:group["revised_end"]]])
        cursor = group["original_end"]
        group["id"] = str(i)
    result.append(original[cursor:])
    assert "".join(result) == revised
    for side, text in (("original", original), ("revised", revised)):
        assert "".join(s["text"] for s in diffing.segments(text, groups, side)) == text
    if original == revised:
        assert groups == []


def test_end_to_end_persistence_snapshot_review_and_export(app, client):
    case = new_case(client)
    run = generate(client, case)
    assert run["status"] == "completed" and len(run["edits"]) == 1
    assert run["request"]["model"] == "test-model"
    assert run["response_id"] == "response-test"
    for edit in run["edits"]:
        run = label(client, edit["id"], acceptability="unacceptable", change_type="fidelity_relevant",
                    dimensions=["certainty"])
    assert client.post(f"/api/runs/{run['id']}/review", json={}).status_code == 200
    client.patch(f"/api/cases/{case['id']}", json={"original": "A different draft.", "identifier": "changed-source"})
    restarted = create_app(dict(app.config)).test_client()
    restored = restarted.get(f"/api/runs/{run['id']}").json
    assert restored["reviewed_at"]
    assert restored["snapshot"]["original"] == "We observe a 10% gain."
    assert restored["snapshot"]["source"]["identifier"] == "https://arxiv.org/abs/2401.12345"
    assert restored["labeled_count"] == 1
    export = restarted.get("/api/export?scope=reviewed").json
    assert export["schema_version"] == 1
    exported_run = export["cases"][0]["runs"][0]
    assert exported_run["snapshot"] == restored["snapshot"]
    assert exported_run["edits"][0]["id"] == restored["edits"][0]["id"]
    assert "secret-test-key" not in json.dumps(export)
    assert "secret-test-key" not in json.dumps(client.get("/api/config").json)
    label(restarted, restored["edits"][0]["id"])
    assert restarted.get("/api/export?scope=reviewed").json["cases"] == []








def test_merge_split_invalidate_only_affected_labels(app, client):
    app.config["GENERATOR"] = lambda request, key: fake_result("We prove. A 12% gain. Results hold!")
    run = generate(client, new_case(client, "We observe. A 10% gain. Results hold."))
    assert len(run["edits"]) == 3
    for edit in run["edits"]:
        label(client, edit["id"])
    client.post(f"/api/runs/{run['id']}/review", json={})
    first, second, unaffected = run["edits"]
    response = client.post(f"/api/runs/{run['id']}/regroup", json={"action": "merge", "edit_id": first["id"]})
    assert response.status_code == 200, response.json
    merged = response.json["run"]
    assert len(merged["edits"]) == 2 and not merged["reviewed_at"]
    assert merged["edits"][0]["annotation"] is None
    assert merged["edits"][1]["id"] == unaffected["id"] and merged["edits"][1]["complete"]
    assert client.put(f"/api/edits/{first['id']}/annotation", json={}).status_code == 404
    response = client.post(f"/api/runs/{run['id']}/regroup", json={
        "action": "split", "edit_id": merged["edits"][0]["id"],
        "original_cut": second["original_start"], "revised_cut": second["revised_start"]})
    assert response.status_code == 200, response.json
    split = response.json["run"]
    assert len(split["edits"]) == 3
    assert all(e["annotation"] is None for e in split["edits"][:2])
    assert split["edits"][2]["complete"]
    invalid = client.post(f"/api/runs/{run['id']}/regroup", json={
        "action": "split", "edit_id": split["edits"][0]["id"], "original_cut": 4, "revised_cut": 4})
    assert invalid.status_code == 400
    assert len(client.get(f"/api/runs/{run['id']}").json["edits"]) == 3


def test_zero_edit_confirmation(app, client):
    app.config["GENERATOR"] = lambda request, key: fake_result("Unchanged.")
    run = generate(client, new_case(client, "Unchanged."))
    assert run["edits"] == []
    assert client.post(f"/api/runs/{run['id']}/review", json={}).status_code == 400
    assert client.post(f"/api/runs/{run['id']}/review", json={"confirm_zero_edits": True}).status_code == 200
