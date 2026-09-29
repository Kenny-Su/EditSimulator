/* Small browser client. All text is rendered with textContent, never as HTML. */
const $ = id => document.getElementById(id);
let paper = null, importing = false;
let caseId = null, currentCase = null, run = null, selectedId = null;
let formDirty = false, formSave = null, annotationSave = null;
const annotationDrafts = new Map();
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
    button.onclick = perform(() => withReviewLocked(async () => { await flushAll(); await openCase(item.id); }));
    $('case-list').append(button);
  }
}

async function flushForm() {
  clearTimeout(formTimer);
  if (formSave) { await formSave; if (formDirty) return flushForm(); return; }
  if (!formDirty || !caseId || !currentCase) return;
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

const editCard = id => document.getElementById(`edit-card-${id}`);
const cardField = (id, name) => editCard(id).querySelector(`[data-field="${name}"]`);
function annotationValues(id) {
  return {acceptability: cardField(id, 'acceptability').value || null,
    change_type: cardField(id, 'change-type').value || null,
    reason: cardField(id, 'annotation-reason').value,
    dimensions: [...cardField(id, 'dimensions').querySelectorAll('input:checked')].map(input => input.value),
    confirmed: false};
}
function applyAnnotationResult(result, id) {
  // Only replace this edit: another card or the clause checklist may have newer drafts.
  const index = run.edits.findIndex(edit => edit.id === id);
  run.edits[index] = result.edits.find(edit => edit.id === id);
  run.reviewed_at = result.reviewed_at;
  run.labeled_count = run.edits.filter(edit => edit.complete && !annotationDrafts.has(edit.id)).length;
}
async function flushAnnotation() {
  clearTimeout(annotationTimer);
  if (annotationSave) { await annotationSave; if (annotationDrafts.size) return flushAnnotation(); return; }
  if (!annotationDrafts.size) return;
  annotationSave = (async () => {
    while (annotationDrafts.size) {
      const [id, values] = annotationDrafts.entries().next().value;
      const status = cardField(id, 'annotation-status');
      status.textContent = 'Saving…'; status.classList.remove('error-text');
      try {
        const result = await api(`/api/edits/${id}/annotation`, {method: 'PUT', body: JSON.stringify(values)});
        // Keep any newer input typed while this request was in flight.
        if (annotationDrafts.get(id) === values) annotationDrafts.delete(id);
        applyAnnotationResult(result, id);
        renderProgress(); renderEditList(); updateAnnotationStatus(id);
      } catch (error) {
        status.textContent = 'Not saved. Edit again to retry; keep this page open.';
        status.classList.add('error-text'); throw error;
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
  selectedId = null; renderRun(); await refreshCases();
}
function setRunOptions(runs) {
  $('run-select').replaceChildren();
  if (!runs.length) $('run-select').append(new Option('No runs yet', ''));
  for (const r of runs) $('run-select').append(new Option(runLabel(r), r.id));
  $('run-select').disabled = !runs.length;
}

function renderRun() {
  $('delete-case').hidden = !caseId;
  $('delete-run').disabled = !run || run.status === 'pending';
  $('review-empty').hidden = !!run; $('review-content').hidden = !run;
  $('export-changes').disabled = !run || run.status !== 'completed';
  if (!run) return;
  $('run-instruction').textContent = run.snapshot.instruction;
  $('run-info').textContent = `${run.model} · ${dateText(run.created_at)} · Source: ${run.snapshot.source.identifier}`;
  $('completed-review').hidden = run.status !== 'completed';
  $('run-error').hidden = run.status === 'completed';
  $('run-error').textContent = run.error || 'Generation in progress. Use this run selector to refresh its status.';
  if (run.status !== 'completed') return;
  if (!run.edits.some(e => e.id === selectedId)) selectedId = run.edits[0]?.id || null;
  renderUnifiedPassage();
  renderRequirements(); renderProgress(); renderEditList(); renderEditCards();
}
function renderProgress() {
  $('progress').textContent = run.reviewed_at && run.requirement_audit?.confirmed_at ? `✓ Reviewed · ${run.edits.length} edits` : `${run.labeled_count} of ${run.edits.length} edits confirmed`;
  const checked = !!run.requirement_audit?.confirmed_at;
  $('mark-reviewed').disabled = annotationDrafts.size || requirementDirty || !checked || !!run.reviewed_at || run.labeled_count !== run.edits.length;
  $('mark-reviewed').textContent = run.reviewed_at && checked ? 'Reviewed ✓' : 'Mark reviewed ✓';
  const option = [...$('run-select').options].find(option => option.value === run.id);
  if (option) option.textContent = runLabel(run);
}
function renderEditList() {
  $('edit-list').replaceChildren();
  for (const [index, edit] of run.edits.entries()) {
    const button = document.createElement('button'); button.className = 'edit-item' + (edit.id === selectedId ? ' selected' : '');
    button.textContent = `${edit.complete && !annotationDrafts.has(edit.id) ? '✓' : '○'} Edit ${index + 1}`;
    button.onclick = () => selectEdit(edit.id);
    $('edit-list').append(button);
  }
}
function renderUnifiedPassage() {
  const view = $('unified-view'); view.replaceChildren();
  let currentId = null, target = view;
  for (const segment of run.unified_segments) {
    if (!segment.edit_id) {
      view.append(document.createTextNode(segment.text)); currentId = null; target = view;
      continue;
    }
    if (segment.edit_id !== currentId) {
      currentId = segment.edit_id;
      const index = run.edits.findIndex(edit => edit.id === currentId);
      const id = currentId;
      const button = document.createElement('button');
      button.className = 'unified-edit'; button.dataset.editId = id;
      button.classList.toggle('selected', id === selectedId);
      button.title = `Annotate edit ${index + 1}`;
      button.setAttribute('aria-label', `Edit ${index + 1}: ${run.edits[index].original_text || 'insertion'} → ${run.edits[index].revised_text || 'deletion'}`);
      const badge = document.createElement('sup'); badge.className = 'edit-number'; badge.textContent = index + 1; badge.setAttribute('aria-hidden', 'true');
      button.append(badge); button.onclick = () => selectEdit(id);
      view.append(button); target = button;
    }
    const span = document.createElement(segment.kind === 'delete' ? 'del' : segment.kind === 'insert' ? 'ins' : 'span');
    span.textContent = segment.text; target.append(span);
  }
}
function selectEdit(id, showPassage = false) {
  selectedId = id;
  for (const card of document.querySelectorAll('.edit-card')) card.classList.toggle('selected', card.dataset.editId === id);
  for (const button of document.querySelectorAll('.unified-edit')) button.classList.toggle('selected', button.dataset.editId === id);
  renderEditList();
  const target = showPassage ? [...$('unified-view').querySelectorAll('.unified-edit')].find(button => button.dataset.editId === id) : editCard(id);
  target?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  target?.focus({preventScroll: true});
}
function renderEditCards() {
  $('edit-cards').replaceChildren();
  $('no-edit').hidden = run.edits.length > 0;
  for (const [index, edit] of run.edits.entries()) {
    const card = $('edit-card-template').content.firstElementChild.cloneNode(true);
    card.id = `edit-card-${edit.id}`; card.dataset.editId = edit.id;
    card.classList.toggle('selected', edit.id === selectedId);
    $('edit-cards').append(card);
    const field = name => cardField(edit.id, name);
    field('edit-title').textContent = `Edit ${index + 1} of ${run.edits.length}`;
    field('edit-title').id = `edit-title-${edit.id}`; card.setAttribute('aria-labelledby', field('edit-title').id);
    field('reason-help').id = `reason-help-${edit.id}`;
    field('annotation-reason').setAttribute('aria-describedby', field('reason-help').id);
    field('show-in-passage').onclick = () => selectEdit(edit.id, true);
    const labels = annotationDrafts.get(edit.id) || edit.annotation;
    field('acceptability').value = labels?.acceptability || '';
    field('change-type').value = labels?.change_type || '';
    field('annotation-reason').value = labels?.reason || '';
    for (const checkbox of field('dimensions').querySelectorAll('input')) checkbox.checked = labels?.dimensions?.includes(checkbox.value) || false;
    field('merge-next').disabled = index === run.edits.length - 1;
    for (const side of ['original', 'revised']) {
      const select = field(`${side}-cut`);
      for (const boundary of edit[`${side}_boundaries`]) select.append(new Option(boundary.label, boundary.offset));
      select.selectedIndex = Math.floor((select.options.length - 1) / 2);
    }
    for (const name of ['acceptability', 'change-type', 'dimensions']) field(name).onchange = () => scheduleAnnotation(edit.id);
    field('annotation-reason').oninput = () => scheduleAnnotation(edit.id);
    field('confirm-annotation').onclick = perform(() => confirmAnnotation(edit.id));
    field('delete-annotation').onclick = perform(() => clearAnnotation(edit.id));
    field('merge-next').onclick = perform(() => regroup('merge', edit.id));
    field('split-edit').onclick = perform(() => regroup('split', edit.id));
    updateLabelVisibility(edit.id); updateAnnotationStatus(edit.id);
  }
}
function updateLabelVisibility(id) {
  cardField(id, 'dimensions').hidden = cardField(id, 'change-type').value !== 'fidelity_relevant';
  const needsReason = cardField(id, 'acceptability').value === 'unacceptable';
  cardField(id, 'reason-field').hidden = !needsReason;
  cardField(id, 'annotation-reason').required = needsReason;
}
function updateAnnotationStatus(id) {
  const edit = run.edits.find(e => e.id === id);
  const dirty = annotationDrafts.has(id);
  cardField(id, 'delete-annotation').hidden = !edit?.annotation && !dirty;
  const status = cardField(id, 'annotation-status');
  status.textContent = dirty ? 'Unsaved changes…' : edit?.complete ? 'Confirmed · saved locally' : edit?.annotation ?
    'Draft saved · confirm when ready' : 'Choose labels, then confirm.';
  const missingReason = cardField(id, 'acceptability').value === 'unacceptable' && !cardField(id, 'annotation-reason').value.trim();
  cardField(id, 'confirm-annotation').disabled = !cardField(id, 'acceptability').value || !cardField(id, 'change-type').value || missingReason;
  if (missingReason) status.textContent = 'Add a short reason before confirming this unacceptable edit.';
}
function scheduleAnnotation(id) {
  annotationDrafts.set(id, annotationValues(id));
  updateLabelVisibility(id); updateAnnotationStatus(id); renderEditList();
  $('mark-reviewed').disabled = true;
  clearTimeout(annotationTimer); annotationTimer = setTimeout(() => flushAnnotation().catch(message), 450);
}
async function withReviewLocked(action) {
  const regions = [$('review-section'), document.querySelector('.sidebar'), $('case-form'), document.querySelector('.export-tools')];
  regions.forEach(region => { region.inert = true; });
  try { await action(); } finally { regions.forEach(region => { region.inert = false; }); }
}
async function confirmAnnotation(id) {
  await withReviewLocked(async () => {
    await flushAll();
    const result = await api(`/api/edits/${id}/annotation`, {method: 'PUT', body: JSON.stringify({...annotationValues(id), confirmed: true})});
    applyAnnotationResult(result, id);
    updateAnnotationStatus(id); renderProgress(); renderEditList(); await refreshCases();
  });
}
async function clearAnnotation(id) {
  await withReviewLocked(async () => {
    await flushAll();
    const result = await api(`/api/edits/${id}/annotation`, {method: 'DELETE', body: '{}'});
    applyAnnotationResult(result, id);
    renderEditCards(); renderProgress(); renderEditList(); await refreshCases();
  });
}

const prohibitionOutcomes = {respected: 'Respected', violated: 'Violated', uncertain: 'Uncertain'};
function requirementValues() {
  return [...$('requirement-list').children].map(row => {
    const kind = row.querySelector('.requirement-kind').value;
    const edit_ids = [...row.querySelectorAll('input:checked')].map(input => input.value);
    return {
      text: row.querySelector('.requirement-text').value,
      kind,
      outcome: kind === 'request' ? (edit_ids.length ? 'fulfilled' : 'not_fulfilled') : row.querySelector('.requirement-outcome').value,
      explanation: row.querySelector('.requirement-explanation').value,
      edit_ids
    };
  });
}
function requirementRow(value = {}) {
  const row = document.createElement('div'); row.className = 'requirement-row';
  function field(title, element) {
    const label = document.createElement('label'); label.append(document.createTextNode(title), element); row.append(label); return element;
  }
  const text = field('Clause', document.createElement('textarea'));
  text.className = 'requirement-text'; text.rows = 2; text.value = value.text || '';
  text.readOnly = true;
  const kind = field('Clause type', document.createElement('select')); kind.className = 'requirement-kind';
  kind.append(new Option('Request', 'request'), new Option('Prohibition (do not…)', 'prohibition')); kind.value = value.kind || 'request';
  const outcome = field('Was the prohibition respected?', document.createElement('select')); outcome.className = 'requirement-outcome';
  outcome.append(new Option('Choose…', ''));
  for (const [key, label] of Object.entries(prohibitionOutcomes)) outcome.append(new Option(label, key));
  outcome.value = value.kind === 'prohibition' ? value.outcome || '' : '';
  const links = document.createElement('fieldset'); links.className = 'requirement-edits';
  const legend = document.createElement('legend'); links.append(legend);
  const status = document.createElement('p'); status.className = 'requirement-mapping-status'; status.setAttribute('aria-live', 'polite');
  function updateMapping() {
    const prohibition = kind.value === 'prohibition';
    outcome.parentElement.hidden = !prohibition;
    legend.textContent = prohibition ? 'Violating edits' : 'Fulfilling edits';
    const selected = [...links.querySelectorAll('input:checked')].map(input => `Edit ${input.dataset.number}`);
    status.textContent = selected.length ? selected.join(', ') : prohibition ? 'None selected.' : 'Omitted — no edits selected.';
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
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No edits.'; links.append(empty);
  }
  links.append(status); row.append(links);
  kind.onchange = () => {
    // Evidence for fulfillment must not become evidence of a violation (or vice versa).
    for (const checkbox of links.querySelectorAll('input')) checkbox.checked = false;
    outcome.value = ''; updateMapping();
  };
  const explanation = field('Note (optional)', document.createElement('textarea'));
  explanation.className = 'requirement-explanation'; explanation.rows = 2; explanation.value = value.explanation || '';
  row.addEventListener('input', () => { updateMapping(); scheduleRequirements(); });
  row.addEventListener('change', () => { updateMapping(); scheduleRequirements(); });
  updateMapping(); $('requirement-list').append(row);
}
function renderRequirements() {
  const audit = run.requirement_audit;
  $('requirement-list').replaceChildren();
  for (const value of audit?.annotation ?? []) requirementRow(value);
  $('clear-requirements').disabled = !audit;
  $('requirements-status').textContent = audit?.confirmed_at ? 'Confirmed.' :
    audit?.annotation ? 'Draft saved · confirm when ready.' :
    'Select edits for each clause.';
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
$('confirm-requirements').onclick = perform(() => withReviewLocked(async () => {
  await flushAll();
  run = await api(`/api/runs/${run.id}/requirements`, {method: 'PUT', body: JSON.stringify({requirements: requirementValues(), confirmed: true})});
  renderRun(); await refreshCases();
}));
$('clear-requirements').onclick = perform(() => withReviewLocked(async () => {
  if (!confirm('Reset clause mappings, notes, and confirmation?')) return;
  await flushAll(); run = await api(`/api/runs/${run.id}/requirements`, {method: 'DELETE', body: '{}'});
  renderRun(); await refreshCases();
}));

function renderSource() {
  $('import-panel').hidden = !!caseId;
  $('source-summary').hidden = !caseId;
  $('case-form').hidden = !caseId;
  $('generate').disabled = !currentCase || !config.generation_ready;
  if (!currentCase) return;
  $('source-title').textContent = currentCase.source.title;
  $('source-url').textContent = currentCase.source.identifier;
  $('source-section').textContent = currentCase.source.section;
  $('source-passage').textContent = currentCase.original;
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
  if (!currentCase) return;
  formDirty = true; saveStatus('Unsaved changes…');
  clearTimeout(formTimer); formTimer = setTimeout(() => flushForm().catch(message), 600);
});
$('case-form').addEventListener('submit', perform(async event => {
  event.preventDefault(); if (generating || !currentCase) return;
  generating = true; $('generate').disabled = true; $('generate').textContent = 'Generating…'; clearMessage();
  const lockedRegions = [$('case-form'), $('review-section'), document.querySelector('.sidebar'), document.querySelector('.export-tools')];
  lockedRegions.forEach(region => { region.inert = true; });
  $('case-form').setAttribute('aria-busy', 'true');
  try {
    formDirty = true; await flushAll();
    const targetCase = caseId;
    const result = await api(`/api/cases/${targetCase}/generate`, {method: 'POST', body: '{}'});
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
    generating = false; $('generate').disabled = !currentCase || !config.generation_ready; $('generate').textContent = 'Generate revision';
  }
}));
$('new-case').onclick = perform(async () => {
  await flushAll(); clearMessage(); caseId = null; currentCase = null; run = null; selectedId = null;
  $('case-form').reset(); history.replaceState(null, '', '/'); $('case-heading').textContent = 'Passage';
  saveStatus('Not saved yet'); setRunOptions([]); renderRun(); renderSource(); await refreshCases();
  await refreshPapers(); $('xml-file').focus();
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
$('run-select').onchange = perform(() => withReviewLocked(async () => {
  const id = $('run-select').value;
  try { await flushAll(); run = await api(`/api/runs/${id}`); selectedId = null; renderRun(); }
  catch (error) { $('run-select').value = run?.id || ''; throw error; }
}));
async function regroup(action, id) {
  await withReviewLocked(async () => {
    await flushAll();
    const edit = run.edits.find(e => e.id === id);
    const index = run.edits.indexOf(edit);
    const affected = action === 'merge' ? run.edits.slice(index, index + 2) : [edit];
    if (affected.some(e => e.annotation) && !confirm('This will clear labels on the affected edits. Continue?')) return;
    const data = {action, edit_id: id};
    if (action === 'split') { data.original_cut = Number(cardField(id, 'original-cut').value); data.revised_cut = Number(cardField(id, 'revised-cut').value); }
    const result = await api(`/api/runs/${run.id}/regroup`, {method: 'POST', body: JSON.stringify(data)});
    run = result.run; selectedId = result.selected_edit_id; renderRun(); selectEdit(selectedId); await refreshCases();
  });
}
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
  if (formDirty || annotationDrafts.size || requirementDirty || requirementSave || formSave || annotationSave || generating || importing) { event.preventDefault(); event.returnValue = ''; }
});
(async () => {
  try {
    config = await api('/api/config'); $('model').textContent = config.model || 'Model not configured';
    if (!config.generation_ready) $('configuration-note').textContent = 'Set OPENAI_API_KEY and OPENAI_MODEL to generate.';
    await refreshCases(); await refreshPapers(); renderSource();
    const id = location.hash.slice(1);
    if (id) await openCase(id);
  } catch (error) { message(error); }
})();
