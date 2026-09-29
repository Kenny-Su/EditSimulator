/* Small browser client. All text is rendered with textContent, never as HTML. */
const $ = id => document.getElementById(id);
let paper = null, importing = false;
let caseId = null, currentCase = null, run = null, selectedId = null;
let formDirty = false, annotationDirty = false, formSave = null, annotationSave = null;
let requirementDirty = false, requirementSave = null, requirementTimer;
let formTimer, annotationTimer, generating = false, config = {};

async function api(url, options = {}) {
  const response = await fetch(url, {headers: {'Content-Type': 'application/json'}, ...options});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function message(error) { $('message').textContent = error.message || error; $('message').hidden = false; }
function clearMessage() { $('message').hidden = true; }
function perform(fn) { return async event => { try { await fn(event); } catch (error) { message(error); } }; }
function formValues() { return {instruction: $('case-form').elements.instruction.value}; }
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
  if (!formDirty || !caseId || !currentCase?.provenance) return;
  formSave = (async () => {
    while (formDirty) {
      formDirty = false; saveStatus('Saving…');
      const values = formValues();
      try {
        currentCase = await api(`/api/cases/${caseId}`, {
          method: 'PATCH', body: JSON.stringify(values)
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
    reason: $('annotation-reason').value,
    dimensions: [...$('dimensions').querySelectorAll('input:checked')].map(input => input.value),
    confirmed: false};
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
async function flushAll() { await flushForm(); await flushAnnotation(); await flushRequirements(); }

async function openCase(id, preferredRunId = null) {
  clearMessage();
  currentCase = await api(`/api/cases/${id}`); caseId = id;
  history.replaceState(null, '', `/#${caseId}`);
  $('case-form').elements.instruction.value = currentCase.instruction;
  renderSource();
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
  $('legacy-run-note').hidden = true;
  $('export-changes').disabled = !run || run.status !== 'completed';
  if (!run) return;
  $('run-instruction').textContent = [run.snapshot.instruction, run.snapshot.constraints].filter(Boolean).join('\n\n');
  $('run-info').textContent = `${run.model} · ${dateText(run.created_at)} · Source: ${run.snapshot.source.identifier}`;
  $('completed-review').hidden = run.status !== 'completed';
  $('run-error').hidden = run.status === 'completed';
  $('run-error').textContent = run.error || 'Generation in progress. Use this run selector to refresh its status.';
  if (run.status !== 'completed') return;
  $('legacy-run-note').hidden = !!run.snapshot.provenance;
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
  renderRequirements(); renderProgress(); renderEditList(); selectEdit(selectedId);
  lockLegacyReview();
}
function renderProgress() {
  $('progress').textContent = run.reviewed_at && run.requirement_audit?.confirmed_at ? `✓ Reviewed · ${run.edits.length} edits` : `${run.labeled_count} of ${run.edits.length} edits confirmed`;
  const checked = !!run.requirement_audit?.confirmed_at;
  $('mark-reviewed').disabled = !run.snapshot.provenance || annotationDirty || requirementDirty || !checked || !!run.reviewed_at || run.labeled_count !== run.edits.length;
  $('mark-reviewed').textContent = run.reviewed_at && checked ? 'Reviewed ✓' : 'Mark reviewed ✓';
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
  const labels = edit.annotation;
  $('acceptability').value = labels?.acceptability || '';
  $('change-type').value = labels?.change_type || '';
  $('annotation-reason').value = labels?.reason || '';
  for (const checkbox of $('dimensions').querySelectorAll('input')) checkbox.checked = labels?.dimensions.includes(checkbox.value) || false;
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
  lockLegacyReview();
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
  const needsReason = $('acceptability').value === 'unacceptable';
  $('reason-field').hidden = !needsReason;
  $('annotation-reason').required = needsReason;
}
function updateAnnotationStatus() {
  const edit = run.edits.find(e => e.id === selectedId);
  $('delete-annotation').hidden = !edit?.annotation && !annotationDirty;
  $('annotation-status').textContent = edit?.complete ? 'Confirmed · saved locally' : edit?.annotation ?
    'Draft saved · confirm when ready' : 'Choose labels, then confirm.';
  const missingReason = $('acceptability').value === 'unacceptable' && !$('annotation-reason').value.trim();
  $('confirm-annotation').disabled = !$('acceptability').value || !$('change-type').value || missingReason;
  if (missingReason) $('annotation-status').textContent = 'Add a short reason before confirming this unacceptable edit.';
  $('confirm-annotation').textContent = run.edits.at(-1)?.id === selectedId ? 'Confirm' : 'Confirm & next';
}
function scheduleAnnotation() {
  annotationDirty = true; updateLabelVisibility(); updateAnnotationStatus();
  $('mark-reviewed').disabled = true;
  $('annotation-status').textContent = 'Unsaved changes…';
  clearTimeout(annotationTimer); annotationTimer = setTimeout(() => flushAnnotation().catch(message), 450);
}

const outcomes = {
  request: {fulfilled: 'Fulfilled', partially_fulfilled: 'Partially fulfilled', not_fulfilled: 'Not fulfilled', uncertain: 'Uncertain'},
  prohibition: {respected: 'Respected', violated: 'Violated', uncertain: 'Uncertain'}
};
function requirementValues() {
  return [...$('requirement-list').children].map(row => {
    const kind = row.querySelector('.requirement-kind').value;
    const edit_ids = [...row.querySelectorAll('input:checked')].map(input => input.value);
    return {
      text: row.querySelector('.requirement-text').value,
      kind,
      outcome: kind === 'request' ? (edit_ids.length ? 'fulfilled' : 'not_fulfilled') : row.querySelector('.requirement-outcome').value,
      explanation: row.querySelector('.requirement-explanation').value,
      edit_ids,
      ...(kind === 'request' ? {mapping_mode: 'edit_list'} : {})
    };
  });
}
function requirementRow(value = {}) {
  const row = document.createElement('div'); row.className = 'requirement-row';
  function field(title, element) {
    const label = document.createElement('label'); label.append(document.createTextNode(title), element); row.append(label); return element;
  }
  const text = field('Instruction clause (exact quote)', document.createElement('textarea'));
  text.className = 'requirement-text'; text.rows = 2; text.value = value.text || '';
  text.readOnly = run.snapshot.instruction_format === 'one_request_per_line';
  const kind = field('Clause type', document.createElement('select')); kind.className = 'requirement-kind';
  kind.append(new Option('Request', 'request'), new Option('Prohibition (do not…)', 'prohibition')); kind.value = value.kind || 'request';
  const outcome = field('Was the prohibition respected?', document.createElement('select')); outcome.className = 'requirement-outcome';
  outcome.append(new Option('Choose…', ''));
  for (const [key, label] of Object.entries(outcomes.prohibition)) outcome.append(new Option(label, key));
  outcome.value = value.kind === 'prohibition' ? value.outcome || '' : '';
  const links = document.createElement('fieldset'); links.className = 'requirement-edits';
  const legend = document.createElement('legend'); links.append(legend);
  const hint = document.createElement('p'); hint.className = 'muted'; links.append(hint);
  const status = document.createElement('p'); status.className = 'requirement-mapping-status'; status.setAttribute('aria-live', 'polite');
  function updateMapping() {
    const prohibition = kind.value === 'prohibition';
    outcome.parentElement.hidden = !prohibition;
    legend.textContent = prohibition ? 'Edits that violate this prohibition' : 'Edits that fulfill this request';
    hint.textContent = prohibition ? 'Select offending edits, if any. Judge whether the prohibition was respected above.' : 'Select every edit that fulfills this clause. Leave the list empty if the request was omitted. An edit can fulfill more than one request.';
    const selected = [...links.querySelectorAll('input:checked')].map(input => `Edit ${input.dataset.number}`);
    status.textContent = selected.length ? selected.join(', ') : prohibition ? 'No violating edits selected.' : 'Omitted — no fulfilling edits selected.';
  }
  for (const [index, edit] of run.edits.entries()) {
    const label = document.createElement('label'); label.className = 'requirement-edit-option';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = edit.id; checkbox.dataset.number = index + 1;
    checkbox.checked = (value.edit_ids || []).includes(edit.id);
    const content = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = `Edit ${index + 1}`;
    const before = document.createElement('span'); before.className = 'requirement-edit-text'; before.textContent = `Before: ${edit.original_text || '∅'}`;
    const after = document.createElement('span'); after.className = 'requirement-edit-text'; after.textContent = `After: ${edit.revised_text || '∅'}`;
    content.append(title, before, after); label.append(checkbox, content); links.append(label);
  }
  if (!run.edits.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'This revision has no edits to select.'; links.append(empty);
  }
  links.append(status); row.append(links);
  kind.onchange = () => {
    // Evidence for fulfillment must not become evidence of a violation (or vice versa).
    for (const checkbox of links.querySelectorAll('input')) checkbox.checked = false;
    outcome.value = ''; updateMapping();
  };
  const explanation = field('Note (optional)', document.createElement('textarea'));
  explanation.className = 'requirement-explanation'; explanation.rows = 2; explanation.value = value.explanation || '';
  const remove = document.createElement('button'); remove.textContent = 'Remove clause';
  remove.onclick = () => { row.remove(); scheduleRequirements(); };
  if (run.snapshot.instruction_format !== 'one_request_per_line') row.append(remove);
  row.addEventListener('input', () => { updateMapping(); scheduleRequirements(); });
  row.addEventListener('change', () => { updateMapping(); scheduleRequirements(); });
  updateMapping(); $('requirement-list').append(row);
}
function renderRequirements() {
  const audit = run.requirement_audit;
  const lineBased = run.snapshot.instruction_format === 'one_request_per_line';
  $('add-requirement').hidden = lineBased;
  $('clear-requirements').textContent = lineBased ? 'Reset clause mappings' : 'Clear clauses';
  $('clause-help').textContent = lineBased
    ? 'Each nonempty instruction line is one clause. Select the edits that fulfill each request; an empty list means omitted. For a prohibition, change the clause type and record violations separately.'
    : 'Add each request as an exact quote from the instruction, then select the edits that fulfill it. An empty list means omitted. For prohibitions, change the clause type and record violations separately.';
  $('requirement-list').replaceChildren();
  for (const value of audit?.annotation ?? []) requirementRow(value);
  $('clear-requirements').disabled = !audit;
  $('requirements-status').textContent = audit?.confirmed_at ? 'All clauses and edit lists confirmed.' :
    audit?.annotation ? 'Draft saved. Check each clause and its selected edits, then confirm.' :
    'Add each instruction clause, then select the edits that fulfill it.';
}
function scheduleRequirements() {
  requirementDirty = true; $('mark-reviewed').disabled = true;
  $('requirements-status').textContent = 'Saving draft…'; clearTimeout(requirementTimer);
  requirementTimer = setTimeout(() => flushRequirements().catch(message), 500);
}
async function flushRequirements() {
  clearTimeout(requirementTimer);
  if (requirementSave) { await requirementSave; if (requirementDirty) return flushRequirements(); return; }
  if (!requirementDirty) return;
  requirementSave = (async () => {
    while (requirementDirty) {
      requirementDirty = false;
      try {
        const result = await api(`/api/runs/${run.id}/requirements`, {method: 'PUT', body: JSON.stringify({requirements: requirementValues(), confirmed: false})});
        run.requirement_audit = result.requirement_audit; run.reviewed_at = result.reviewed_at;
        $('requirements-status').textContent = 'Draft saved · awaiting confirmation'; renderProgress();
      } catch (error) { requirementDirty = true; $('requirements-status').textContent = 'Not saved. Edit to retry.'; throw error; }
    }
  })();
  try { await requirementSave; } finally { requirementSave = null; }
}
$('add-requirement').onclick = () => { requirementRow(); scheduleRequirements(); };
$('confirm-requirements').onclick = perform(async () => {
  await flushAll();
  run = await api(`/api/runs/${run.id}/requirements`, {method: 'PUT', body: JSON.stringify({requirements: requirementValues(), confirmed: true})});
  renderRun(); await refreshCases();
});
$('clear-requirements').onclick = perform(async () => {
  const prompt = run.snapshot.instruction_format === 'one_request_per_line'
    ? 'Reset all clause mappings, types, notes, and confirmation? The instruction lines and edit annotations remain.'
    : 'Clear the instruction requirements and their confirmation? Edit annotations remain.';
  if (!confirm(prompt)) return;
  await flushAll(); run = await api(`/api/runs/${run.id}/requirements`, {method: 'DELETE', body: '{}'});
  renderRun(); await refreshCases();
});

function lockLegacyReview() {
  const legacy = !run?.snapshot.provenance;
  $('annotation-reason').disabled = legacy;
  // Keep navigation and full text available while preventing historical edits.
  for (const element of document.querySelectorAll('#requirements-panel input, #requirements-panel textarea, #requirements-panel select, #requirements-panel button, #edit-controls .label-grid select, #dimensions input')) element.disabled = legacy;
  if (legacy) {
    for (const id of ['confirm-annotation', 'delete-annotation', 'merge-next', 'split-edit', 'mark-reviewed']) $(id).disabled = true;
  } else {
    $('delete-annotation').disabled = false; $('split-edit').disabled = false;
    $('clear-requirements').disabled = !run.requirement_audit;
  }
}
function renderSource() {
  $('import-panel').hidden = !!caseId;
  $('source-summary').hidden = !caseId;
  $('case-form').hidden = !caseId;
  $('generate').disabled = !currentCase?.provenance || !config.generation_ready;
  $('case-form').elements.instruction.disabled = !currentCase?.provenance;
  if (!currentCase) return;
  $('source-title').textContent = currentCase.source.title;
  $('source-url').textContent = currentCase.source.identifier;
  $('source-section').textContent = currentCase.source.section;
  $('source-passage').textContent = currentCase.original;
  $('legacy-note').hidden = !!currentCase.provenance;
}
async function refreshPapers() {
  const result = await api('/api/papers');
  $('paper-select').replaceChildren(new Option('Choose a paper…', ''));
  for (const item of result.papers) $('paper-select').append(new Option(`${item.title} · ${item.doi}`, item.id));
  $('paper-select').value = paper?.id || '';
}
function renderPaper() {
  $('paper-selection').hidden = !paper;
  if (!paper) return;
  $('paper-title').textContent = paper.title;
  $('paper-link').href = paper.url;
  $('section-select').replaceChildren();
  for (const section of paper.sections.filter(s => s.paragraph_ids.length)) {
    $('section-select').append(new Option(`${section.parent_id ? '↳ ' : ''}${section.title}`, section.id));
  }
  const introduction = paper.sections.find(s => /introduction/i.test(s.title));
  if (introduction) $('section-select').value = introduction.id;
  renderParagraphs();
}
function renderParagraphs() {
  const section = paper.sections.find(s => s.id === $('section-select').value);
  $('paragraph-list').replaceChildren();
  for (const paragraph of paper.paragraphs.filter(p => section?.paragraph_ids.includes(p.id))) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = paragraph.id; checkbox.checked = true;
    const content = document.createElement('span'); content.textContent = paragraph.text;
    label.append(checkbox, content); $('paragraph-list').append(label);
  }
  updateSelection();
}
function selectedParagraphIds() { return [...$('paragraph-list').querySelectorAll('input:checked')].map(e => e.value); }
function updateSelection() {
  const ids = new Set(selectedParagraphIds());
  $('selection-preview').textContent = paper.paragraphs.filter(p => ids.has(p.id)).map(p => p.text).join('\n\n');
  $('selection-count').textContent = `${ids.size} paragraphs selected`;
  $('use-selection').disabled = !ids.size;
}
$('xml-file').onchange = perform(async () => {
  const file = $('xml-file').files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw new Error('XML files must be 10 MB or smaller.');
  await flushAll(); clearMessage(); importing = true;
  const regions = [document.querySelector('.sidebar'), $('import-panel')];
  regions.forEach(e => { e.inert = true; });
  $('import-status').textContent = 'Importing ACM XML…';
  try {
    paper = await api('/api/papers', {method: 'POST', body: JSON.stringify({xml: await file.text(), filename: file.name})});
    await refreshPapers(); renderPaper();
    $('import-status').textContent = 'Imported and saved locally. Choose your passage below.';
  } catch (error) {
    $('import-status').textContent = 'Import failed. Choose a full-text ACM XML file to retry.';
    throw error;
  } finally {
    importing = false; regions.forEach(e => { e.inert = false; }); $('xml-file').value = '';
  }
});
$('paper-select').onchange = perform(async () => {
  const id = $('paper-select').value;
  $('import-panel').inert = true;
  try { paper = id ? await api(`/api/papers/${id}`) : null; renderPaper(); }
  finally { $('import-panel').inert = false; }
});
$('section-select').onchange = renderParagraphs;
$('paragraph-list').onchange = updateSelection;
for (const [id, checked] of [['select-all', true], ['select-none', false]]) $(id).onclick = () => {
  for (const checkbox of $('paragraph-list').querySelectorAll('input')) checkbox.checked = checked;
  updateSelection();
};
$('use-selection').onclick = perform(async () => {
  $('use-selection').disabled = true;
  const regions = [document.querySelector('.sidebar'), $('import-panel')];
  regions.forEach(e => { e.inert = true; });
  try {
    await flushAll();
    const result = await api('/api/cases', {method: 'POST', body: JSON.stringify({
      paper_id: paper.id, section_id: $('section-select').value, paragraph_ids: selectedParagraphIds(), instruction: ''
    })});
    await openCase(result.id); $('case-form').elements.instruction.focus();
  } finally { regions.forEach(e => { e.inert = false; }); updateSelection(); }
});

$('case-form').addEventListener('input', () => {
  if (!currentCase?.provenance) return;
  formDirty = true; saveStatus('Unsaved changes…');
  clearTimeout(formTimer); formTimer = setTimeout(() => flushForm().catch(message), 600);
});
$('case-form').addEventListener('submit', perform(async event => {
  event.preventDefault(); if (generating || !currentCase?.provenance) return;
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
    generating = false; $('generate').disabled = !currentCase?.provenance || !config.generation_ready; $('generate').textContent = 'Generate revision';
  }
}));
$('confirm-annotation').onclick = perform(async () => {
  $('confirm-annotation').disabled = true;
  try {
    await flushAll();
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
  saveStatus('Not saved yet'); setRunOptions([]); renderRun(); renderSource(); await refreshCases();
  renderSource(); await refreshPapers(); $('xml-file').focus();
});
$('delete-annotation').onclick = perform(async () => {
  await flushAll();
  run = await api(`/api/edits/${selectedId}/annotation`, {method: 'DELETE', body: '{}'});
  annotationDirty = false; renderRun(); await refreshCases();
});
$('delete-run').onclick = perform(async () => {
  if (!confirm('Permanently delete this run, including its revision and annotations? Other runs will remain.')) return;
  await flushAll();
  await api(`/api/runs/${run.id}`, {method: 'DELETE', body: '{}'});
  await openCase(caseId);
});
$('delete-case').onclick = perform(async () => {
  if (!confirm('Permanently delete this passage and all its runs and annotations? This cannot be undone.')) return;
  await flushAll();
  await api(`/api/cases/${caseId}`, {method: 'DELETE', body: '{}'});
  caseId = null; currentCase = null; run = null; selectedId = null;
  $('case-form').reset(); history.replaceState(null, '', '/');
  saveStatus('Not saved yet'); setRunOptions([]); renderRun(); renderSource(); await refreshCases();
});
$('run-select').onchange = perform(async () => {
  const id = $('run-select').value;
  try { await flushAll(); run = await api(`/api/runs/${id}`); selectedId = null; renderRun(); }
  catch (error) { $('run-select').value = run?.id || ''; throw error; }
});
for (const id of ['acceptability', 'change-type']) $(id).onchange = scheduleAnnotation;
$('annotation-reason').oninput = scheduleAnnotation;
$('dimensions').onchange = scheduleAnnotation;
for (const [id, step] of [['previous-edit', -1], ['next-edit', 1]]) $(id).onclick = perform(async () => {
  await flushAnnotation(); const index = run.edits.findIndex(e => e.id === selectedId); selectEdit(run.edits[index + step]?.id || selectedId);
});
async function regroup(action) {
  await flushAll();
  const edit = run.edits.find(e => e.id === selectedId);
  const index = run.edits.indexOf(edit);
  const affected = action === 'merge' ? run.edits.slice(index, index + 2) : [edit];
  if (affected.some(e => e.annotation) && !confirm('This will clear labels on the affected edits. Continue?')) return;
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
$('export-changes').onclick = perform(async () => {
  await flushAll();
  window.location.assign(`/api/runs/${run.id}/export`);
});
window.addEventListener('beforeunload', event => {
  if (formDirty || annotationDirty || requirementDirty || requirementSave || formSave || annotationSave || generating || importing) { event.preventDefault(); event.returnValue = ''; }
});
(async () => {
  try {
    config = await api('/api/config'); $('model').textContent = config.model || 'Model not configured';
    if (!config.generation_ready) $('configuration-note').textContent = 'Set OPENAI_API_KEY and OPENAI_MODEL, then restart to generate. You can save passages now.';
    await refreshCases(); await refreshPapers(); renderSource();
    const id = location.hash.slice(1);
    if (id) await openCase(id);
  } catch (error) { message(error); }
})();
