/* Small browser client. All text is rendered with textContent, never as HTML. */
const $ = id => document.getElementById(id);
const fields = ['identifier', 'title', 'original', 'instruction'];
let caseId = null, currentCase = null, run = null, selectedId = null;
let formDirty = false, annotationDirty = false, formSave = null, annotationSave = null;
let formTimer, annotationTimer, generating = false, suggesting = false, config = {};

async function api(url, options = {}) {
  const response = await fetch(url, {headers: {'Content-Type': 'application/json'}, ...options});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function message(error) { $('message').textContent = error.message || error; $('message').hidden = false; }
function clearMessage() { $('message').hidden = true; }
function perform(fn) { return async event => { try { await fn(event); } catch (error) { message(error); } }; }
function formValues() { return Object.fromEntries(fields.map(name => [name, $('case-form').elements[name].value])); }
function saveStatus(text, error = false) { $('save-status').textContent = text; $('save-status').classList.toggle('error-text', error); }
function dateText(value) { return new Date(value).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}); }
function runLabel(r) { return `${dateText(r.created_at)} · ${r.reviewed_at ? 'reviewed' : r.status}`; }

async function refreshCases() {
  const data = await api('/api/cases');
  $('case-count').textContent = data.cases.length;
  $('case-list').replaceChildren();
  for (const item of data.cases) {
    const button = document.createElement('button');
    button.className = 'case-item' + (item.id === caseId ? ' selected' : '');
    const title = document.createElement('strong');
    title.textContent = item.source.title || item.original.slice(0, 42) || 'Untitled passage';
    const source = document.createElement('small'); source.className = 'case-source';
    source.textContent = item.source.identifier || 'Source not added';
    const status = document.createElement('small');
    const latest = item.latest_run;
    status.textContent = !latest ? 'Draft' : latest.reviewed_at ? '✓ Reviewed' : latest.status === 'completed'
      ? `${latest.labeled_count} / ${latest.edit_count} edits confirmed` : latest.status;
    button.append(title, source, status);
    button.onclick = perform(async () => { await flushAll(); await openCase(item.id); });
    $('case-list').append(button);
  }
}

async function flushForm() {
  clearTimeout(formTimer);
  if (formSave) { await formSave; if (formDirty) return flushForm(); return; }
  if (!formDirty) return;
  formSave = (async () => {
    while (formDirty) {
      formDirty = false; saveStatus('Saving…');
      const values = formValues();
      try {
        currentCase = await api(caseId ? `/api/cases/${caseId}` : '/api/cases', {
          method: caseId ? 'PATCH' : 'POST', body: JSON.stringify(values)
        });
        caseId = currentCase.id;
        $('delete-case').hidden = false;
        history.replaceState(null, '', `/#${caseId}`);
        $('case-heading').textContent = 'Passage';
        saveStatus('Saved locally');
      } catch (error) {
        formDirty = true; saveStatus('Not saved · retry by editing', true); throw error;
      }
    }
  })();
  try { await formSave; } finally { formSave = null; }
  await refreshCases();
}

function annotationValues() {
  return {acceptability: $('acceptability').value || null, change_type: $('change-type').value || null,
    dimensions: [...$('dimensions').querySelectorAll('input:checked')].map(input => input.value),
    confirmed: false, suggestion_job_id: run.edits.find(e => e.id === selectedId)?.suggestion?.job_id || null};
}

async function flushAnnotation() {
  clearTimeout(annotationTimer);
  if (annotationSave) { await annotationSave; if (annotationDirty) return flushAnnotation(); return; }
  if (!annotationDirty || !selectedId) return;
  annotationSave = (async () => {
    while (annotationDirty) {
      annotationDirty = false;
      $('annotation-status').textContent = 'Saving…';
      $('annotation-status').classList.remove('error-text');
      try {
        run = await api(`/api/edits/${selectedId}/annotation`, {method: 'PUT', body: JSON.stringify(annotationValues())});
        renderProgress(); renderEditList(); updateAnnotationStatus();
      } catch (error) {
        annotationDirty = true;
        $('annotation-status').textContent = 'Not saved. Edit again to retry; keep this page open.';
        $('annotation-status').classList.add('error-text'); throw error;
      }
    }
  })();
  try { await annotationSave; } finally { annotationSave = null; }
  await refreshCases();
}
async function flushAll() { await flushForm(); await flushAnnotation(); }

async function openCase(id, preferredRunId = null) {
  clearMessage();
  currentCase = await api(`/api/cases/${id}`); caseId = id;
  history.replaceState(null, '', `/#${caseId}`);
  for (const field of fields) $('case-form').elements[field].value = currentCase[field] ?? currentCase.source[field] ?? '';
  formDirty = false; saveStatus('Saved locally'); $('case-heading').textContent = 'Passage';
  setRunOptions(currentCase.runs);
  const target = preferredRunId || currentCase.runs[0]?.id;
  if (target) { run = await api(`/api/runs/${target}`); $('run-select').value = target; }
  else run = null;
  selectedId = null; annotationDirty = false; renderRun(); await refreshCases();
}
function setRunOptions(runs) {
  $('run-select').replaceChildren();
  if (!runs.length) $('run-select').append(new Option('No runs yet', ''));
  for (const r of runs) $('run-select').append(new Option(runLabel(r), r.id));
  $('run-select').disabled = !runs.length;
}

function renderRun() {
  $('delete-case').hidden = !caseId;
  $('delete-run').disabled = !run || run.status === 'pending' || run.suggestion_jobs.some(j => j.status === 'pending');
  $('review-empty').hidden = !!run; $('review-content').hidden = !run;
  if (!run) return;
  $('run-instruction').textContent = [run.snapshot.instruction, run.snapshot.constraints].filter(Boolean).join('\n\n');
  $('run-info').textContent = `${run.model} · ${dateText(run.created_at)} · Source: ${run.snapshot.source.identifier}`;
  $('completed-review').hidden = run.status !== 'completed';
  $('run-error').hidden = run.status === 'completed';
  $('run-error').textContent = run.error || 'Generation in progress. Use this run selector to refresh its status.';
  if (run.status !== 'completed') return;
  if (!run.edits.some(e => e.id === selectedId)) selectedId = run.edits[0]?.id || null;
  for (const side of ['original', 'revised']) {
    const view = $(`${side}-view`); view.replaceChildren(); view.className = `passage ${side}`;
    for (const segment of run.segments[side]) {
      if (!segment.edit_id) { view.append(document.createTextNode(segment.text)); continue; }
      const button = document.createElement('button');
      button.className = 'diff' + (!segment.text ? ' empty-span' : '');
      button.dataset.editId = segment.edit_id;
      button.textContent = segment.text || '∅';
      button.title = 'Select edit';
      button.onclick = perform(async () => { await flushAnnotation(); selectEdit(segment.edit_id); });
      view.append(button);
    }
  }
  const job = run.suggestion_jobs.at(-1);
  const pending = job?.status === 'pending';
  $('suggest-labels').disabled = suggesting || pending || !config.generation_ready || !run.edits.some(e => !e.suggestion);
  $('suggest-labels').textContent = pending ? 'Suggesting…' : 'Suggest labels';
  $('suggestion-status').textContent = job?.error || (pending ? 'Generating suggestions. Reopen this run to refresh.' :
    run.edits.some(e => e.suggestion) ? 'Suggestions ready. Confirm or correct each edit below.' : '');
  renderProgress(); renderEditList(); selectEdit(selectedId);
}
function renderProgress() {
  $('progress').textContent = run.reviewed_at ? `✓ Reviewed · ${run.edits.length} edits` : `${run.labeled_count} of ${run.edits.length} edits confirmed`;
  $('mark-reviewed').disabled = annotationDirty || !!run.reviewed_at || run.labeled_count !== run.edits.length;
  $('mark-reviewed').textContent = run.reviewed_at ? 'Reviewed ✓' : 'Mark reviewed ✓';
  const option = [...$('run-select').options].find(option => option.value === run.id);
  if (option) option.textContent = runLabel(run);
}
function renderEditList() {
  $('edit-list').replaceChildren();
  for (const [index, edit] of run.edits.entries()) {
    const button = document.createElement('button'); button.className = 'edit-item' + (edit.id === selectedId ? ' selected' : '');
    button.textContent = `${edit.complete ? '✓' : '○'} Edit ${index + 1}`;
    const preview = document.createElement('span'); preview.className = 'edit-preview';
    preview.textContent = `${edit.original_text || '∅'} → ${edit.revised_text || '∅'}`;
    button.append(preview);
    button.onclick = perform(async () => { await flushAnnotation(); selectEdit(edit.id); });
    $('edit-list').append(button);
  }
}
function selectEdit(id) {
  selectedId = id;
  const edit = run?.edits.find(e => e.id === id);
  $('edit-controls').hidden = !edit; $('no-edit').hidden = !!edit;
  if (!edit) return;
  const index = run.edits.indexOf(edit);
  $('edit-title').textContent = `Edit ${index + 1} of ${run.edits.length}`;
  renderSentenceContext($('edit-before'), edit, 'original');
  renderSentenceContext($('edit-after'), edit, 'revised');
  const labels = edit.annotation || edit.suggestion;
  $('acceptability').value = labels?.acceptability || '';
  $('change-type').value = labels?.change_type || '';
  for (const checkbox of $('dimensions').querySelectorAll('input')) checkbox.checked = labels?.dimensions.includes(checkbox.value) || false;
  $('suggestion').hidden = !edit.suggestion;
  if (edit.suggestion) {
    const s = edit.suggestion;
    $('suggestion-labels').textContent = [s.acceptability, s.change_type.replaceAll('_', ' '), ...s.dimensions].join(' · ');
    $('suggestion-explanation').textContent = s.explanation;
    $('suggestion-split').hidden = !s.needs_split;
  }
  $('previous-edit').disabled = index === 0; $('next-edit').disabled = index === run.edits.length - 1;
  $('merge-next').disabled = index === run.edits.length - 1;
  for (const side of ['original', 'revised']) {
    const select = $(`${side}-cut`); select.replaceChildren();
    for (const boundary of edit[`${side}_boundaries`]) select.append(new Option(boundary.label, boundary.offset));
    select.selectedIndex = Math.floor((select.options.length - 1) / 2);
  }
  $('grouping').open = false;
  document.querySelectorAll('.diff').forEach(button => button.classList.toggle('selected', button.dataset.editId === id));
  renderEditList(); updateLabelVisibility(); updateAnnotationStatus();
}
function renderSentenceContext(container, edit, side) {
  container.replaceChildren();
  const context = edit[`${side}_context`];
  const before = document.createElement('div'); before.className = 'neighbor'; before.textContent = context.before;
  const target = document.createElement('div'); target.className = 'target-sentence';
  for (const segment of edit[`${side}_segments`]) {
    const span = document.createElement('span');
    if (segment.edit_id) span.className = 'diff';
    span.textContent = segment.text || (segment.edit_id ? '∅' : '');
    target.append(span);
  }
  if (!edit[`${side}_text`]) target.textContent = side === 'original' ? '(Inserted sentence)' : '(Deleted sentence)';
  const after = document.createElement('div'); after.className = 'neighbor'; after.textContent = context.after;
  container.append(before, target, after);
}

function updateLabelVisibility() {
  $('dimensions').hidden = $('change-type').value !== 'fidelity_relevant';
}
function updateAnnotationStatus() {
  const edit = run.edits.find(e => e.id === selectedId);
  $('delete-annotation').hidden = !edit?.annotation && !annotationDirty;
  $('annotation-status').textContent = edit?.complete ? 'Confirmed · saved locally' : edit?.annotation ?
    'Draft saved · confirm when ready' : edit?.suggestion ? 'Suggested labels · awaiting your confirmation' : 'Choose labels, then confirm.';
  $('confirm-annotation').disabled = !$('acceptability').value || !$('change-type').value;
  $('confirm-annotation').textContent = run.edits.at(-1)?.id === selectedId ? 'Confirm' : 'Confirm & next';
}
function scheduleAnnotation() {
  annotationDirty = true; updateLabelVisibility(); updateAnnotationStatus();
  $('mark-reviewed').disabled = true;
  $('annotation-status').textContent = 'Unsaved changes…';
  clearTimeout(annotationTimer); annotationTimer = setTimeout(() => flushAnnotation().catch(message), 450);
}

$('case-form').addEventListener('input', () => {
  formDirty = true; saveStatus('Unsaved changes…');
  clearTimeout(formTimer); formTimer = setTimeout(() => flushForm().catch(message), 600);
});
$('case-form').addEventListener('submit', perform(async event => {
  event.preventDefault(); if (generating) return;
  generating = true; $('generate').disabled = true; $('generate').textContent = 'Generating…'; clearMessage();
  const lockedRegions = [$('case-form'), $('review-section'), document.querySelector('.sidebar'), document.querySelector('.export-tools')];
  lockedRegions.forEach(region => { region.inert = true; });
  $('case-form').setAttribute('aria-busy', 'true');
  try {
    formDirty = true; await flushAll();
    const targetCase = caseId;
    const pending = api(`/api/cases/${targetCase}/generate`, {method: 'POST', body: '{}'});
    const result = await pending;
    if (caseId === targetCase) {
      // Do not reload the input form: it may contain edits made while generation was running.
      run = result; selectedId = null;
      currentCase = await api(`/api/cases/${targetCase}`); setRunOptions(currentCase.runs); $('run-select').value = result.id;
      renderRun(); $('review-section').scrollIntoView({behavior: 'smooth', block: 'start'});
    }
    await refreshCases();
  } finally {
    lockedRegions.forEach(region => { region.inert = false; });
    $('case-form').removeAttribute('aria-busy');
    generating = false; $('generate').disabled = false; $('generate').textContent = 'Generate revision';
  }
}));
$('suggest-labels').onclick = perform(async () => {
  if (suggesting) return;
  await flushAll(); clearMessage(); suggesting = true;
  $('suggest-labels').textContent = 'Suggesting…';
  const regions = [document.querySelector('main'), document.querySelector('.sidebar')];
  regions.forEach(region => { region.inert = true; });
  try {
    run = await api(`/api/runs/${run.id}/suggest`, {method: 'POST', body: '{}'});
    await refreshCases();
  } finally {
    suggesting = false; regions.forEach(region => { region.inert = false; }); renderRun();
  }
});
$('confirm-annotation').onclick = perform(async () => {
  $('confirm-annotation').disabled = true;
  try {
    await flushAnnotation();
    const values = {...annotationValues(), confirmed: true};
    run = await api(`/api/edits/${selectedId}/annotation`, {method: 'PUT', body: JSON.stringify(values)});
    const index = run.edits.findIndex(e => e.id === selectedId);
    selectedId = run.edits[index + 1]?.id || selectedId;
    renderRun(); await refreshCases();
  } finally { updateAnnotationStatus(); }
});
$('new-case').onclick = perform(async () => {
  await flushAll(); clearMessage(); caseId = null; currentCase = null; run = null; selectedId = null;
  $('case-form').reset(); history.replaceState(null, '', '/'); $('case-heading').textContent = 'Passage';
  saveStatus('Not saved yet'); setRunOptions([]); renderRun(); await refreshCases();
  $('case-form').elements.identifier.focus();
});
$('delete-annotation').onclick = perform(async () => {
  await flushAnnotation();
  run = await api(`/api/edits/${selectedId}/annotation`, {method: 'DELETE', body: '{}'});
  annotationDirty = false; renderRun(); await refreshCases();
});
$('delete-run').onclick = perform(async () => {
  if (!confirm('Permanently delete this run, including its revision, suggestions, and annotations? Other runs will remain.')) return;
  await flushAll();
  await api(`/api/runs/${run.id}`, {method: 'DELETE', body: '{}'});
  await openCase(caseId);
});
$('delete-case').onclick = perform(async () => {
  if (!confirm('Permanently delete this passage and all its runs, suggestions, and annotations? This cannot be undone.')) return;
  await flushAll();
  await api(`/api/cases/${caseId}`, {method: 'DELETE', body: '{}'});
  caseId = null; currentCase = null; run = null; selectedId = null;
  $('case-form').reset(); history.replaceState(null, '', '/');
  saveStatus('Not saved yet'); setRunOptions([]); renderRun(); await refreshCases();
});
$('run-select').onchange = perform(async () => {
  const id = $('run-select').value;
  try { await flushAnnotation(); run = await api(`/api/runs/${id}`); selectedId = null; renderRun(); }
  catch (error) { $('run-select').value = run?.id || ''; throw error; }
});
for (const id of ['acceptability', 'change-type']) $(id).onchange = scheduleAnnotation;
$('dimensions').onchange = scheduleAnnotation;
for (const [id, step] of [['previous-edit', -1], ['next-edit', 1]]) $(id).onclick = perform(async () => {
  await flushAnnotation(); const index = run.edits.findIndex(e => e.id === selectedId); selectEdit(run.edits[index + step]?.id || selectedId);
});
async function regroup(action) {
  await flushAnnotation();
  const edit = run.edits.find(e => e.id === selectedId);
  const index = run.edits.indexOf(edit);
  const affected = action === 'merge' ? run.edits.slice(index, index + 2) : [edit];
  if (affected.some(e => e.annotation || e.suggestion) && !confirm('This will clear suggestions and labels on the affected edits. Continue?')) return;
  const data = {action, edit_id: selectedId};
  if (action === 'split') { data.original_cut = Number($('original-cut').value); data.revised_cut = Number($('revised-cut').value); }
  const result = await api(`/api/runs/${run.id}/regroup`, {method: 'POST', body: JSON.stringify(data)});
  run = result.run; selectedId = result.selected_edit_id; renderRun(); await refreshCases();
}
$('merge-next').onclick = perform(() => regroup('merge'));
$('split-edit').onclick = perform(() => regroup('split'));
$('mark-reviewed').onclick = perform(async () => {
  await flushAll();
  if (!run.edits.length && !confirm('Confirm you reviewed this revision and it contains no changes.')) return;
  run = await api(`/api/runs/${run.id}/review`, {method: 'POST', body: JSON.stringify({confirm_zero_edits: !run.edits.length})});
  renderProgress(); await refreshCases();
});
$('export').onclick = perform(async () => {
  await flushAll();
  window.location.assign(`/api/export?scope=${$('export-scope').value}`);
});
window.addEventListener('beforeunload', event => {
  if (formDirty || annotationDirty || formSave || annotationSave || generating || suggesting) { event.preventDefault(); event.returnValue = ''; }
});
(async () => {
  try {
    config = await api('/api/config'); $('model').textContent = config.model || 'Model not configured';
    if (!config.generation_ready) $('configuration-note').textContent = 'Set OPENAI_API_KEY and OPENAI_MODEL, then restart to generate. You can save passages now.';
    await refreshCases();
    const id = location.hash.slice(1);
    if (id) await openCase(id);
  } catch (error) { message(error); }
})();
