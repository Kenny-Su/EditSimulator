"""Lossless token diffs. All offsets are Python Unicode code-point offsets."""
import re
from difflib import SequenceMatcher


def tokens(text):
    return re.findall(r"\w+|[^\w\s]|\s+", text, flags=re.UNICODE)


def boundaries(text):
    result = [0]
    for token in tokens(text):
        result.append(result[-1] + len(token))
    return result


def edits(original, revised):
    a, b = tokens(original), tokens(revised)
    aa, bb = boundaries(original), boundaries(revised)
    return [
        {"original_start": aa[i], "original_end": aa[j],
         "revised_start": bb[k], "revised_end": bb[l]}
        for tag, i, j, k, l in SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
        if tag != "equal"
    ]


def segments(text, groups, side):
    result, cursor = [], 0
    for group in groups:
        start, end = group[f"{side}_start"], group[f"{side}_end"]
        if start > cursor:
            result.append({"text": text[cursor:start], "edit_id": None})
        result.append({"text": text[start:end], "edit_id": group["id"]})
        cursor = end
    if cursor < len(text):
        result.append({"text": text[cursor:], "edit_id": None})
    return result


def unified_segments(original, revised, groups):
    """Full passage with unchanged text once and token-level removals/additions."""
    result, cursor = [], 0
    for group in groups:
        start, end = group['original_start'], group['original_end']
        if start > cursor:
            result.append(dict(text=original[cursor:start], kind='equal', edit_id=None))
        before = tokens(original[start:end])
        after = tokens(revised[group['revised_start']:group['revised_end']])
        for tag, i, j, k, l in SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
            if tag == 'equal':
                result.append(dict(text=''.join(before[i:j]), kind='equal', edit_id=group['id']))
            else:
                if i < j:
                    result.append(dict(text=''.join(before[i:j]), kind='delete', edit_id=group['id']))
                if k < l:
                    result.append(dict(text=''.join(after[k:l]), kind='insert', edit_id=group['id']))
        cursor = end
    if cursor < len(original):
        result.append(dict(text=original[cursor:], kind='equal', edit_id=None))
    return result


def split_spans(original, revised, group, original_cut, revised_cut):
    cuts = {"original": original_cut, "revised": revised_cut}
    texts = {"original": original, "revised": revised}
    left, right = {}, {}
    for side in ("original", "revised"):
        start, end, cut = group[f"{side}_start"], group[f"{side}_end"], cuts[side]
        if type(cut) is not int or not start <= cut <= end:
            raise ValueError("Choose a split boundary on both sides.")
        if cut - start not in boundaries(texts[side][start:end]):
            raise ValueError("Splits must follow token boundaries.")
        left.update({f"{side}_start": start, f"{side}_end": cut})
        right.update({f"{side}_start": cut, f"{side}_end": end})
    for part in (left, right):
        a = original[part["original_start"]:part["original_end"]]
        b = revised[part["revised_start"]:part["revised_end"]]
        if a == b:
            raise ValueError("Both resulting groups must contain a change; move the split boundary.")
    return [left, right]


def sentences(text):
    """Sentence spans retaining every character, including inter-sentence whitespace."""
    spans, start = [], 0
    for match in re.finditer(r'''[.!?]["'”’\)\]]*(?:\s+|$)|\n\s*\n''', text):
        prefix = text[start:match.start() + 1]
        # Common scientific abbreviations and author initials are not sentence ends.
        if match.group().startswith('.') and re.search(
                r'\b(?:et al|e\.g|i\.e|Fig|Eq|Sec|Dr|Prof|Mr|Ms|vs|[A-Z])\.$', prefix):
            continue
        end = match.end()
        if text[start:end].strip():
            spans.append((start, end))
            start = end
    if start < len(text):
        if text[start:].strip() or not spans:
            spans.append((start, len(text)))
        else:
            spans[-1] = (spans[-1][0], len(text))
    return spans


def sentence_edits(original, revised):
    """Monotonic sentence alignment with insertion, deletion, split and merge steps."""
    a, b = sentences(original), sentences(revised)
    n, m = len(a), len(b)
    costs = [[float('inf')] * (m + 1) for _ in range(n + 1)]
    previous = {}
    costs[0][0] = 0
    steps = [(1, 1), (1, 2), (2, 1), (1, 3), (3, 1), (1, 0), (0, 1)]

    def bounds(spans, index, count, text):
        start = spans[index][0] if index < len(spans) else len(text)
        return start, spans[index + count - 1][1] if count else start

    for i in range(n + 1):
        for j in range(m + 1):
            for x, y in steps:
                if i + x > n or j + y > m:
                    continue
                aa, ab = bounds(a, i, x, original)
                ba, bb = bounds(b, j, y, revised)
                if x and y:
                    left = tokens(original[aa:ab].strip())
                    right = tokens(revised[ba:bb].strip())
                    ratio = SequenceMatcher(None, left, right, autojunk=False).ratio()
                    cost = (1 - ratio) * (x + y) / 2 + .18 * (x + y - 2)
                else:
                    cost = .75
                total = costs[i][j] + cost
                if total < costs[i + x][j + y]:
                    costs[i + x][j + y] = total
                    previous[i + x, j + y] = (i, j, aa, ab, ba, bb)
    groups, i, j = [], n, m
    while i or j:
        i, j, aa, ab, ba, bb = previous[i, j]
        if original[aa:ab] != revised[ba:bb]:
            groups.append(dict(original_start=aa, original_end=ab, revised_start=ba, revised_end=bb))
    return groups[::-1]


def context(text, start, end):
    spans = sentences(text)
    overlapping = [i for i, (a, b) in enumerate(spans) if a < end and b > start]
    if overlapping:
        first, last = overlapping[0], overlapping[-1]
        before = spans[max(0, first - 1)][0]
        after = spans[min(len(spans) - 1, last + 1)][1]
    else:
        before = next((a for a, b in reversed(spans) if b <= start), start)
        after = next((b for a, b in spans if a >= end), end)
    return {"before": text[before:start], "after": text[end:after]}
