"""Extract selectable text from ACM BITS/JATS without loading external resources."""
import hashlib
import re
from xml.etree.ElementTree import TreeBuilder
from xml.parsers import expat

MAX_XML_BYTES = 10 * 1024 * 1024


def parse(xml):
    if not isinstance(xml, str) or not xml.strip():
        raise ValueError('Choose a full-text ACM XML file.')
    if len(xml.encode('utf-8')) > MAX_XML_BYTES:
        raise ValueError('XML files must be 10 MB or smaller.')
    # Namespace processing is deliberately disabled: ACM exports can contain an
    # undeclared ali:license_ref prefix. No recovery of malformed XML is allowed.
    builder = TreeBuilder()
    parser = expat.ParserCreate()
    depth = 0

    def start(name, attrs):
        nonlocal depth
        depth += 1
        if depth > 100:
            raise ValueError('XML nesting is too deep.')
        builder.start(name.split(':')[-1], attrs)

    def end(name):
        nonlocal depth
        builder.end(name.split(':')[-1])
        depth -= 1

    def reject(*_):
        raise ValueError('XML entities and embedded DTD declarations are not supported.')

    def doctype(_name, _system, _public, internal):
        if internal:
            reject()

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = builder.data
    parser.StartDoctypeDeclHandler = doctype
    parser.EntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    try:
        parser.Parse(xml, True)
        root = builder.close()
    except expat.ExpatError as error:
        raise ValueError('Invalid XML. Download full-text XML from ACM DL, not an HTML verification page.') from error
    if root.tag == 'book-part-wrapper':
        part = root.find('book-part')
        meta = part.find('book-part-meta') if part is not None else None
        title_path, id_tag, id_type = 'title-group/title', 'book-part-id', 'book-part-id-type'
    elif root.tag == 'article':
        part, meta = root, root.find('front/article-meta')
        title_path, id_tag, id_type = 'title-group/article-title', 'article-id', 'pub-id-type'
    else:
        raise ValueError('Expected ACM full-text BITS or JATS XML.')
    if meta is None or part.find('body') is None:
        raise ValueError('This XML contains no article body. Download full-text XML, not citation metadata.')
    title = text(meta.find(title_path))
    doi = next((text(e) for e in meta.findall(id_tag) if e.get(id_type) == 'doi'), '')
    if not title or not re.fullmatch(r'10\.1145/[A-Za-z0-9._;()/:+-]+', doi):
        raise ValueError('The XML must identify an ACM paper with a title and a 10.1145 DOI.')
    sections, paragraphs = [], []
    skipped = {'fig', 'table-wrap', 'ref-list', 'fn-group', 'fn', 'supplementary-material'}

    def walk(element, section, path):
        if element.tag in skipped:
            return
        if element.tag in ('sec', 'abstract'):
            label = text(element.find('label'))
            heading = text(element.find('title')) or ('Abstract' if element.tag == 'abstract' else 'Untitled section')
            section = {'id': path, 'xml_id': element.get('id'), 'title': ' '.join(filter(None, (label, heading))),
                       'parent_id': section['id'] if section else None, 'paragraph_ids': []}
            sections.append(section)
        if element.tag in ('p', 'disp-formula', 'list'):
            value = text(element)
            if value:
                if section is None:
                    section = next((s for s in sections if s['id'] == 'body'), None)
                    if section is None:
                        section = {'id': 'body', 'xml_id': None, 'title': 'Body', 'parent_id': None, 'paragraph_ids': []}
                        sections.append(section)
                paragraphs.append({'id': path, 'xml_id': element.get('id'), 'section_id': section['id'], 'text': value})
                section['paragraph_ids'].append(path)
            return
        for i, child in enumerate(element):
            if child.tag not in ('title', 'label'):
                walk(child, section, f'{path}/{child.tag}[{i + 1}]')

    for i, abstract in enumerate(meta.findall('abstract')):
        walk(abstract, None, f'abstract[{i + 1}]')
    walk(part.find('body'), None, 'body')
    if not paragraphs:
        raise ValueError('No selectable article paragraphs were found in this XML.')
    # Parent sections include their descendants in document order.
    by_id = {s['id']: s for s in sections}
    for paragraph in paragraphs:
        parent = by_id[paragraph['section_id']]['parent_id']
        while parent:
            by_id[parent]['paragraph_ids'].append(paragraph['id'])
            parent = by_id[parent]['parent_id']
    order = {p['id']: i for i, p in enumerate(paragraphs)}
    for section in sections:
        section['paragraph_ids'].sort(key=order.get)
    return {'title': title, 'doi': doi, 'url': f'https://dl.acm.org/doi/{doi}',
            'format': 'BITS' if root.tag == 'book-part-wrapper' else 'JATS',
            'sha256': hashlib.sha256(xml.encode('utf-8')).hexdigest(),
            'sections': sections, 'paragraphs': paragraphs,
            'extraction_version': 1}


def text(element):
    if element is None:
        return ''

    def render(node):
        if node.tag in ('fig', 'table-wrap', 'fn', 'supplementary-material'):
            return ''
        if node.tag in ('inline-formula', 'disp-formula', 'alternatives'):
            for tag in ('tex-math', 'alt-text'):
                alternative = node.find('.//' + tag)
                if alternative is not None:
                    return ''.join(alternative.itertext())
            if node.get('alttext'):
                return node.get('alttext')
            math = node.find('.//math')
            if math is not None:
                return math.get('alttext') or ''.join(math.itertext())
            return '[formula]' if not ''.join(node.itertext()).strip() else ''.join(node.itertext())
        if node.tag == 'list':
            items = node.findall('list-item')
            numbered = node.get('list-type') in ('order', 'ordered', 'decimal')
            return '\n' + '\n'.join((text(item.find('label')) or (f'{i + 1}.' if numbered else '•')) + ' ' + render(item).strip()
                                    for i, item in enumerate(items)) + '\n'
        if node.tag == 'list-item':
            return ' '.join(render(c).strip() for c in node if c.tag != 'label')
        if node.tag == 'break':
            return '\n'
        return (node.text or '') + ''.join(render(c) + (c.tail or '') for c in node)

    return '\n'.join(re.sub(r'\s+', ' ', line).strip() for line in render(element).split('\n')).strip()


def selection(paper, data):
    section = next((s for s in paper['sections'] if s['id'] == data.get('section_id')), None)
    ids = data.get('paragraph_ids')
    if section is None or not isinstance(ids, list) or not ids or any(not isinstance(i, str) for i in ids):
        raise ValueError('Choose a section and at least one paragraph.')
    if len(set(ids)) != len(ids) or not set(ids).issubset(section['paragraph_ids']):
        raise ValueError('Choose paragraphs from the selected section.')
    selected = [p for p in paper['paragraphs'] if p['id'] in set(ids)]
    return '\n\n'.join(p['text'] for p in selected), {
        'paper_id': paper['id'], 'doi': paper['doi'], 'xml_sha256': paper['sha256'],
        'section_id': section['id'], 'section_xml_id': section['xml_id'], 'section_title': section['title'],
        'paragraph_ids': [p['id'] for p in selected], 'paragraph_xml_ids': [p['xml_id'] for p in selected],
        'extraction_version': paper['extraction_version']}
