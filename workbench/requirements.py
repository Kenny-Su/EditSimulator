"""Validation for manually entered instruction requirements."""

OUTCOMES = {
    'request': ['fulfilled', 'partially_fulfilled', 'not_fulfilled', 'uncertain'],
    'prohibition': ['respected', 'violated', 'uncertain'],
}


def validate_requirements(rows, run, draft=False):
    if not isinstance(rows, list) or (not rows and not draft):
        raise ValueError('Add at least one instruction requirement.')
    ids = {e['id'] for e in run['edits']}
    for row in rows:
        if not isinstance(row, dict) or row.get('kind') not in OUTCOMES:
            raise ValueError('Invalid requirement kind.')
        if not isinstance(row.get('text'), str) or (not draft and (not row['text'].strip() or row['text'] not in run['snapshot']['instruction'])):
            raise ValueError('Requirement text must quote the saved instruction exactly.')
        if row.get('outcome') not in OUTCOMES[row['kind']] and not (draft and row.get('outcome') == ''):
            raise ValueError('Choose an outcome for each requirement.')
        if not isinstance(row.get('edit_ids'), list) or any(not isinstance(i, str) or i not in ids for i in row['edit_ids']):
            raise ValueError('Linked edit no longer exists. Check the grouping.')
        if not isinstance(row.get('explanation', ''), str):
            raise ValueError('Explanation must be text.')
    return rows
