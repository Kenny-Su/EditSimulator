"""Instruction clause creation and manual mapping validation."""

OUTCOMES = {
    'request': ['fulfilled', 'not_fulfilled'],
    'prohibition': ['respected', 'violated', 'uncertain'],
}


def instruction_lines(instruction):
    return [line.strip() for line in instruction.splitlines() if line.strip()]


def initial_requirements(snapshot):
    return [dict(text=text, kind='request',
                 outcome='not_fulfilled', edit_ids=[])
            for text in instruction_lines(snapshot['instruction'])]


def validate_requirements(rows, run, draft=False):
    if not isinstance(rows, list) or (not rows and not draft):
        raise ValueError('Add at least one instruction requirement.')
    ids = {e['id'] for e in run['edits']}
    for row in rows:
        if not isinstance(row, dict) or row.get('kind') not in OUTCOMES:
            raise ValueError('Invalid requirement kind.')
        if not isinstance(row.get('text'), str) or (not draft and (not row['text'].strip() or row['text'] not in run['snapshot']['instruction'])):
            raise ValueError('Requirement text must quote the saved instruction exactly.')
        if not isinstance(row.get('edit_ids'), list) or any(not isinstance(i, str) or i not in ids for i in row['edit_ids']):
            raise ValueError('Linked edit no longer exists. Check the grouping.')
        if row['kind'] == 'request':
            row['edit_ids'] = list(dict.fromkeys(row['edit_ids']))
            row['outcome'] = 'fulfilled' if row['edit_ids'] else 'not_fulfilled'
        if row.get('outcome') not in OUTCOMES[row['kind']] and not (draft and row.get('outcome') == ''):
            raise ValueError('Choose an outcome for each prohibition.')
        row.pop('explanation', None)
    if [row['text'] for row in rows] != instruction_lines(run['snapshot']['instruction']):
        raise ValueError('Keep one clause per instruction line, in order.')
    return rows
