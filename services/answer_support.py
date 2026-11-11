"""Extract attributed facts from evidence; never manufacture a product answer."""
import re

ABSTENTION = "I couldn't find a clear answer in the available information. Please clarify the product or ask for human assistance."
STOP = set('what whats where which how this that with from the for and are you can does please tell about is to a an of do i me my it its avail get available minimum maximum want need know could would should much apa itu berapa yang dan untuk saya apakah po ang ano mga sa ba'.split())
ALIASES = {'salary': 'income', 'salaries': 'income', 'gaji': 'income', 'penghasilan': 'income',
           'usia': 'age', 'umur': 'age', 'years': 'year', 'documents': 'document', 'dokumen': 'document',
           'paperwork': 'document', 'required': 'require', 'requirements': 'require', 'fees': 'fee',
           'tenure': 'tenor', 'loans': 'loan', 'policies': 'policy', 'rates': 'rate'}

# These words give context to a field question but do not narrow the field
# itself. Treating "requirement" as a strict qualifier meant that a natural
# question such as "What is the minimum age requirement for a loan?" abstained
# unless the evidence line happened to contain that exact word.
GENERIC_FACET_CONTEXT = {
    'require', 'requirement', 'eligibility', 'eligible', 'qualification', 'qualify',
    'criteria', 'criterion', 'rule', 'rules',
}


def terms(text):
    return {ALIASES.get(t, t) for t in re.findall(r'[a-z0-9]+', text.lower()) if t not in STOP and len(t) > 1}


def evidence_units(chunk):
    """Keep headings and FAQ questions attached to their answers."""
    major, section, question = '', '', ''
    for raw in chunk.get('content', '').splitlines():
        line = raw.strip().lstrip('-*#• ').strip()
        if not line:
            continue
        if re.match(r'^(?:agent|customer|agen|nasabah|example|contoh|escalation triggers)\s*:', line, re.I) or line.startswith('"'):
            continue
        if re.match(r'^Q\s*:', line, re.I):
            question = re.sub(r'^Q\s*:\s*', '', line, flags=re.I)
            continue
        if re.match(r'^A\s*:', line, re.I):
            text = re.sub(r'^A\s*:\s*', '', line, flags=re.I)
            yield {'text': text, 'context': question, 'match': question + ' ' + text, 'chunk': chunk}
            question = ''
            continue
        heading = len(line) < 100 and not re.search(r'\d[%.,\d]*', line) and (line.endswith(':') or line.isupper())
        if heading:
            label = line.rstrip(':')
            if any(t in terms(label) for t in ('loan', 'insurance', 'pembiayaan')) and not any(t in label.lower() for t in ('eligib', 'document', 'require', 'guide')):
                major, section = label, ''
            else:
                section = label
            continue
        context = ' / '.join(x for x in (major, section) if x)
        yield {'text': line, 'context': context, 'match': context + ' ' + line, 'chunk': chunk}


def extract_supported_answer(query, chunks):
    """Select a single source's supporting lines, retaining product qualifiers."""
    q = terms(query)
    if not q or re.search(r'\b(stock price|weather|cricket|movie|recipe)\b', query, re.I):
        return ABSTENTION, []
    facets = []
    for facet in ({'age'}, {'income'}, {'grace', 'period'}, {'interest', 'rate'}, {'fee'}, {'tenor'}, {'ltv'}, {'cibil'}):
        if facet <= q:
            facets.append(facet)
    documents = bool(q & {'document', 'kyc'}) and not facets
    options = 'loan' in q and bool(q & {'option', 'options', 'type', 'types'})
    # Named institutions and loan types must not silently select another source.
    institutions = [name for name in ('tata', 'bajaj', 'hdfc', 'sbi', 'home credit', 'adira') if name in query.lower()]
    product = next((name for name in ('personal loan', 'home loan', 'business loan', 'loan against property') if name in query.lower()), None)
    grouped = {}
    for chunk in chunks:
        source = chunk.get('document_id') or chunk.get('source', 'Knowledge document')
        if institutions and not all(name in (chunk.get('source', '') + ' ' + chunk.get('title', '')).lower().replace('_', ' ') for name in institutions):
            continue
        grouped.setdefault(source, []).extend(evidence_units(chunk))
    choices = []
    option_choices = []
    for source, units in grouped.items():
        if options:
            headings = []
            supporting = []
            for unit in units:
                heading = unit['context'].split(' / ')[0]
                if re.fullmatch(r'(?:PERSONAL|HOME|BUSINESS|GOLD|EDUCATION|AUTO|CAR|VEHICLE) LOANS?|LOAN AGAINST PROPERTY', heading):
                    if heading not in headings:
                        headings.append(heading)
                        supporting.append(unit['chunk'])
            if headings:
                option_choices.append((headings, supporting))
            continue
        selected = []
        seen = set()
        ranked = []
        for unit in units:
            key = (unit['context'].lower(), unit['text'].lower())
            if key in seen:
                continue
            seen.add(key)
            if product:
                named_types = [name for name in ('personal loan', 'home loan', 'business loan', 'loan against property') if name in unit['match'].lower()]
                if named_types and product not in named_types:
                    continue
            matched = terms(unit['match'])
            direct = terms(unit['text'])
            hits = len(q & matched)
            if facets:
                facet_terms = set().union(*facets)
                qualifiers = q - facet_terms - {
                    'loan', 'insurance', 'personal', 'home', 'business', 'auto', 'car',
                    'vehicle', 'policy', 'finance', *GENERIC_FACET_CONTEXT,
                }
                if not qualifiers <= matched:
                    continue
            if documents:
                if not (terms(unit['context']) & {'document', 'kyc'}):
                    continue
            elif options:
                if 'loan' not in terms(unit['context']) or not re.search(r'\b(?:offers?|loan|collateral|borrow)\b', unit['text'], re.I):
                    continue
            elif facets:
                if not any(facet <= matched for facet in facets):
                    continue
            elif len(q & matched) < min(2, len(q)):
                continue
            # Exact field/definition matches beat incidental mentions in scripts.
            score = hits + 2 * len(q & direct)
            field = unit['text'].split(':')[0] if ':' in unit['text'] else ''
            heading = unit['context'].split(' / ')[-1]
            if '?' in heading or len(heading.split()) > 8:
                heading = ''
            if facets and any(facet <= terms(heading) or facet <= terms(field) for facet in facets):
                score += 8
            if re.match(r'^(?:what is|apa itu|define)\b', query, re.I) and len(q) == 1:
                if '=' in unit['text'] and q <= terms(unit['text'].split('=')[0]):
                    score += 20
            if re.search(r'\b(example|scenario|contoh)\b', unit['match'], re.I):
                score -= 8
            ranked.append((score, unit))
        ranked.sort(key=lambda item: item[0], reverse=True)
        if facets and not documents:
            for facet in facets:
                match = next((unit for _, unit in ranked if facet <= terms(unit['match'])), None)
                if match is None:
                    selected = []
                    break
                if match not in selected:
                    selected.append(match)
        else:
            selected = [unit for _, unit in ranked[:6 if documents else 3 if options else 2]]
        if selected:
            choices.append((sum(score for score, unit in ranked if unit in selected), selected))
    if option_choices:
        headings, supporting = max(option_choices, key=lambda item: len(item[0]))
        title = supporting[0].get('title') or supporting[0].get('source')
        return f"According to {title}, the listed loan options are " + ', '.join(headings).lower() + '.', list({c.get('chunk_id', c.get('content')): c for c in supporting}.values())
    if not choices:
        return ABSTENTION, []
    _, selected = max(choices, key=lambda choice: choice[0])
    evidence = []
    parts = []
    for unit in selected:
        chunk = unit['chunk']
        if chunk not in evidence:
            evidence.append(chunk)
        prefix = unit['context'].strip()
        if not (terms(prefix) & q) and ':' in unit['text']:
            prefix = ''
        # Keep the qualification next to the fact (e.g. salaried vs self-employed).
        text = f"{prefix}: {unit['text']}" if prefix else unit['text']
        parts.append(text.rstrip('. '))
    title = selected[0]['chunk'].get('title') or selected[0]['chunk'].get('source')
    # Bundled sources have differing policies; attribute instead of implying a universal rule.
    attribution = f"According to {title}: " if title else ''
    return attribution + '. '.join(parts) + '.', evidence
