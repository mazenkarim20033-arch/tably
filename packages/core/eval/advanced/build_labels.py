"""
Turn the CORU / ReceiptSense QA files (one JSON of question/answer pairs per receipt, MIT licence) into field labels:
shop, date, total, subtotal, VAT, discount. Answers are free text ("LE 1,228.00", "15 L.E"), so each is parsed
conservatively: anything that does not parse cleanly is left out rather than guessed.

Usage: python build_labels.py <folder with the QA json files> <output.json>
Amounts are written in piastres (integers). Also prints how much of the set is usable and how consistent the labels are
(subtotal + VAT - discount = total), which is a free check on the label quality.
"""
import json, os, re, sys, collections

CURRENCY = re.compile(r'(egp|l\.?e\.?|ج\.?م\.?|جنيه|pound)', re.I)


def amount(text):
    """'LE 1,228.00' -> 122800; '15 L.E' -> 1500; None when unclear."""
    if text is None:
        return None
    t = CURRENCY.sub(' ', str(text)).replace('٫', '.').replace('٬', ',')
    t = t.translate(str.maketrans('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'))
    m = re.findall(r'-?\d[\d,]*\.?\d*', t)
    if len(m) != 1:
        return None
    s = m[0]
    neg = s.startswith('-')
    s = s.lstrip('-')
    if ',' in s:
        if re.fullmatch(r'\d{1,3}(,\d{3})+(\.\d{1,2})?', s):
            s = s.replace(',', '')
        elif re.fullmatch(r'\d+,\d{1,2}', s):
            s = s.replace(',', '.')
        else:
            return None
    if not re.fullmatch(r'\d+(\.\d{1,2})?', s):
        return None
    v = round(float(s) * 100)
    return -v if neg else v


def date(text):
    t = str(text).strip()
    for pat, order in ((r'(\d{4})-(\d{2})-(\d{2})', 'ymd'), (r'(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})', 'dmy'), (r'(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})\b', 'dmy2')):
        m = re.fullmatch(pat, t.split()[0]) if t else None
        if m:
            a, b, c = m.groups()
            if order == 'ymd':
                y, mo, d = a, b, c
            elif order == 'dmy':
                d, mo, y = a, b, c
            else:
                d, mo, y = a, b, '20' + c
            if 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
                return f'{int(y):04d}-{int(mo):02d}-{int(d):02d}'
    return None


def pick(qa, include, exclude=()):
    for q, a in qa:
        ql = q.lower()
        if re.search(include, ql) and not any(re.search(x, ql) for x in exclude):
            return a
    return None


def every(qa, include, exclude=()):
    """All parseable amounts for the questions that match: several answers to 'the total' should all agree."""
    out = []
    for q, a in qa:
        ql = q.lower()
        if re.search(include, ql) and not any(re.search(x, ql) for x in exclude):
            v = amount(a)
            if v is not None:
                out.append(v)
    return out


ITEM_WORDS = r'item|price of|quantity|first|second|third|fourth|fifth|food|bev|per |each'


def label(qa):
    shop = pick(qa, r'(name of the store|store name|name of the shop)')
    text = ' '.join(str(a) for _, a in qa)
    currency = 'EGP' if re.search(r'(egp|l\.?e\b|ج\.?م|جنيه)', text, re.I) else 'USD' if '$' in text else None
    totals = every(qa, r'\btotal\b|\bgrand total\b|amount due|amount owed', (ITEM_WORDS, r'without|vat|tax|discount|sub-?total|paid|tender|change|delivery|cash|card|weight|number|count'))
    subs = every(qa, r'sub-?total', (ITEM_WORDS,))
    return {
        'shop': (shop or '').strip(),
        'currency': currency,
        'date': date(pick(qa, r'\bdate\b', ('due', 'delivery', 'expir', 'time')) or ''),
        # a field is labeled only when every answer to it agrees; disagreement means the labels cannot be trusted
        'total': totals[0] if totals and len(set(totals)) == 1 else None,
        'totalAgree': len(set(totals)) <= 1,
        'subtotal': subs[0] if subs and len(set(subs)) == 1 else None,
        'vat': amount(pick(qa, r'\b(vat|tax)\b.*\b(amount|value)\b|\bsales vat\b|\bvat amount\b|^what (is|was) the (vat|tax)\??$', ('number', 'registration', 'rate', 'service', 'food', 'bev', 'tax 1', 'any other'))),
        'discount': amount(pick(qa, r'\bdiscount\b', ('code', 'percent', 'rate', 'item', 'first', 'second', 'third'))),
    }


def main(folder, out):
    rows = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith('.json'):
            continue
        try:
            data = json.load(open(os.path.join(folder, name), encoding='utf8'))
            qa = [(d['question'], d['answer']) for d in data if isinstance(d, dict) and 'question' in d]
        except Exception:
            continue
        rows.append({'id': name[:-5], **label(qa)})
    json.dump(rows, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    n = len(rows)
    have = {k: sum(1 for r in rows if r[k] not in (None, '')) for k in ('shop', 'currency', 'date', 'total', 'subtotal', 'vat', 'discount')}
    print('currency EGP:', sum(1 for r in rows if r['currency'] == 'EGP'), '| USD:', sum(1 for r in rows if r['currency'] == 'USD'), '| total answers disagree:', sum(1 for r in rows if not r['totalAgree']))
    print(n, 'receipts;', have)
    both = [r for r in rows if r['total'] is not None and r['subtotal'] is not None]
    consistent = [r for r in both if abs((r['subtotal'] + (r['vat'] or 0) - abs(r['discount'] or 0)) - r['total']) <= 5]
    print(f'{len(consistent)} of {len(both)} receipts with a total and subtotal add up (subtotal + VAT - discount = total, within 0.05)')
    shops = collections.Counter(r['shop'].lower() for r in rows if r['shop'])
    print('distinct shops:', len(shops), '| most common:', shops.most_common(8))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
