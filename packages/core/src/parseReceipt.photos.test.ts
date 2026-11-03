import { describe, expect, it } from 'vitest';
import { parseReceipt } from './parseReceipt';
import { reconcile } from './reconcile';
import { setItemLineTotal } from './receiptEdit';
import type { OcrLine } from './receipt';

/**
 * Photo-realistic fixtures. A row is a list of [text, x, width, confidence?] fragments, the way Apple Vision returns
 * one observation per run of text. `tilt` shears the whole page: the right edge sits lower than the left, so the
 * price column drifts away from the names, which is what a crooked phone photo does.
 */
type Frag = [text: string, x: number, w: number, conf?: number];
type PhotoRow = { frags: Frag[]; h?: number };

function photo(rows: PhotoRow[], tilt = 0, pitch = 0.034): OcrLine[] {
  const out: OcrLine[] = [];
  let y = 0.06;
  for (const row of rows) {
    const h = row.h ?? 0.018;
    for (const [text, x, w, conf] of row.frags) {
      out.push({ text, x, y: y + tilt * (x + w / 2), w, h, confidence: conf ?? 0.95 });
    }
    y += pitch;
  }
  return out;
}

const r = (...frags: Frag[]): PhotoRow => ({ frags });

// ---------------------------------------------------------------------------------------------------------------
// Table 9: bilingual restaurant receipt. Printed: 11 lines, 2 of them free, subtotal 1,735.00 + 12% service 208.20 +
// 14% VAT 272.05 = 2,215.25. The tea is printed 60.00.
// ---------------------------------------------------------------------------------------------------------------
function table9(opts: { tilt?: number; teaPrice?: string; teaConf?: number } = {}): OcrLine[] {
  const tea = opts.teaPrice ?? '60.00';
  return photo(
    [
      { frags: [['TABLE 9', 0.3, 0.3]], h: 0.03 },
      r(['INV#- 215156', 0.2, 0.25], ['رقم الفاتورة', 0.55, 0.2]),
      r(['TAX INVOICE -', 0.1, 0.3], ['فاتورة ضريبية', 0.42, 0.2], ['DINE: IN', 0.65, 0.2]),
      r(['Number of Covers: 4', 0.1, 0.35], ['Staff: Khaled', 0.55, 0.3]),
      r(['21-Sep-2024', 0.1, 0.25], ['Ibrahim Abdel Aal', 0.55, 0.3]),
      r(['03:09 PM', 0.6, 0.2]),
      r(['Qty', 0.07, 0.07], ['Item', 0.42, 0.1], ['Price', 0.72, 0.1]),
      r(['2', 0.07, 0.03], ['Fresh Mango Juice', 0.17, 0.3], ['منجا', 0.5, 0.08], ['230.00', 0.72, 0.12]),
      r(['1', 0.07, 0.03], ['Minted Lemonade', 0.17, 0.3], ['95.00', 0.72, 0.12]),
      r(['ليمون بالنعناع', 0.3, 0.22]),
      r(['1', 0.07, 0.03], ['Mixed Fresh Juice', 0.17, 0.3], ['خلاطة', 0.5, 0.1], ['115.00', 0.72, 0.12]),
      r(['عصير على ذوقك', 0.3, 0.25]),
      r(['1', 0.07, 0.03], ['Entres Cup', 0.17, 0.3], ['0.00', 0.76, 0.1]),
      r(['1', 0.07, 0.03], ['Extra Hot Bread', 0.17, 0.3], ['0.00', 0.76, 0.1]),
      r(['1', 0.07, 0.03], ['Fattoush', 0.17, 0.2], ['فتوش', 0.5, 0.08], ['150.00', 0.72, 0.12]),
      r(['2', 0.07, 0.03], ['Lahm Bi Ajin', 0.17, 0.25], ['لحم بعجين', 0.5, 0.12], ['370.00', 0.72, 0.12]),
      r(['1', 0.07, 0.03], ['Grilled Chicken Wings', 0.17, 0.35], ['285.00', 0.72, 0.12]),
      r(['جوانح دجاج مشوية', 0.3, 0.3]),
      r(['1', 0.07, 0.03], ['Chicken Tawouk', 0.17, 0.3], ['طاووق', 0.5, 0.1], ['385.00', 0.72, 0.12]),
      r(['1', 0.07, 0.03], ['Flavoured Tea', 0.17, 0.28], ['شاي', 0.5, 0.06], [tea, 0.72, 0.12, opts.teaConf]),
      r(['1', 0.07, 0.03], ['Small Water', 0.17, 0.25], ['مياه صغيرة', 0.5, 0.15], ['45.00', 0.72, 0.12]),
      r(['Sub Total', 0.2, 0.2], ['1,735.00', 0.7, 0.14]),
      r(['Service Charge', 0.12, 0.3], ['(12%):', 0.18, 0.12]),
      r(['208.20', 0.72, 0.12]),
      r(['VAT (14%):', 0.15, 0.2], ['272.05', 0.72, 0.12]),
      r(['Total', 0.22, 0.12], ['EGP', 0.74, 0.1]),
      r(['2,215.25', 0.72, 0.14]),
      r(['Thank you for visiting!', 0.1, 0.5]),
      r(['Website:', 0.3, 0.2]),
    ],
    opts.tilt ?? 0,
  );
}

const lines = (rcpt: ReturnType<typeof parseReceipt>) => rcpt.items.map((i) => [i.description, i.quantity, i.lineTotal]);

describe('Table 9 (bilingual, with the page tilted like a real photo)', () => {
  for (const tilt of [0, 0.02, -0.02, 0.04]) {
    it(`reads quantities, names and prices with tilt ${tilt}`, () => {
      const rc = parseReceipt(table9({ tilt }));
      const got = lines(rc);
      expect(got.map((g) => [g[0]!.toString().split(' ').slice(0, 3).join(' '), g[1], g[2]])).toEqual([
        ['Fresh Mango Juice', 2, 23000],
        ['Minted Lemonade ليمون', 1, 9500],
        ['Mixed Fresh Juice', 1, 11500],
        ['Fattoush فتوش', 1, 15000],
        ['Lahm Bi Ajin', 2, 37000],
        ['Grilled Chicken Wings', 1, 28500],
        ['Chicken Tawouk طاووق', 1, 38500],
        ['Flavoured Tea شاي', 1, 6000],
        ['Small Water مياه', 1, 4500],
      ]);
    });
  }

  it('reads the charges, the total and the date, and everything adds up', () => {
    const rc = parseReceipt(table9({ tilt: 0.02 }));
    expect([rc.subtotal, rc.service, rc.tax, rc.total]).toEqual([173500, 20820, 27205, 221525]);
    expect(rc.date).toBe('2024-09-21');
    expect(rc.currency).toBe('EGP');
    expect(reconcile(rc).status).toBe('ok');
  });

  it('does not turn staff names, covers, the title or the footer into items or junk', () => {
    const rc = parseReceipt(table9({ tilt: 0.02 }));
    const text = JSON.stringify([rc.items.map((i) => i.description), rc.unparsed]);
    expect(text).not.toMatch(/Staff|Covers|Ibrahim|INVOICE|visiting|Website|DINE|03:09/);
  });

  it('says which lines are free instead of listing them as items', () => {
    const rc = parseReceipt(table9({ tilt: 0.02 }));
    expect(rc.items.some((i) => i.lineTotal === 0)).toBe(false);
    expect(rc.notes.join(' ')).toMatch(/Included at no charge.*Entres Cup.*Extra Hot Bread/);
  });

  it('keeps bilingual rows from looking doubtful just because the Arabic caption is faint', () => {
    const faint = table9({ tilt: 0.02 }).map((l) => (/[؀-ۿ]/.test(l.text) ? { ...l, confidence: 0.4 } : l));
    const rc = parseReceipt(faint);
    expect(rc.items.every((i) => !i.flags.includes('low-ocr-confidence'))).toBe(true);
  });

  it('suggests (never silently applies) a fix when one price was misread and the scanner was unsure of it', () => {
    // The tea is printed 60.00; OCR read 80.00 and was less sure of that line than of the others.
    const rc = parseReceipt(table9({ tilt: 0.02, teaPrice: '80.00', teaConf: 0.55 }));
    const tea = rc.items.find((i) => i.description.startsWith('Flavoured Tea'))!;
    expect(tea.lineTotal).toBe(8000); // as read
    expect(tea.suggestedLineTotal).toBe(6000); // what the subtotal says
    expect(tea.flags).toContain('maybe-misread');
    expect(reconcile(rc).status).toBe('mismatch');
    const fixed = setItemLineTotal(rc, tea.id, tea.suggestedLineTotal!);
    expect(reconcile(fixed).status).toBe('ok');
  });

  it('refuses to guess when several prices could be the misread one and nothing tells them apart', () => {
    const rc = parseReceipt(table9({ tilt: 0.02, teaPrice: '80.00' }));
    expect(rc.items.some((i) => i.suggestedLineTotal !== undefined)).toBe(false);
    expect(rc.notes.join(' ')).toMatch(/more than one price/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Other layouts that must also work
// ---------------------------------------------------------------------------------------------------------------
describe('prices printed per unit (no line total)', () => {
  it('multiplies by quantity when that is what makes the subtotal add up', () => {
    const rc = parseReceipt(
      photo([
        r(['KIOSK', 0.3, 0.3]),
        r(['Qty', 0.07, 0.07], ['Item', 0.4, 0.1], ['Price', 0.72, 0.1]),
        r(['3', 0.07, 0.03], ['Pepsi', 0.17, 0.2], ['15.00', 0.72, 0.12]),
        r(['1', 0.07, 0.03], ['Chips', 0.17, 0.2], ['20.00', 0.72, 0.12]),
        r(['Sub Total', 0.2, 0.2], ['65.00', 0.72, 0.12]),
        r(['Total', 0.2, 0.2], ['65.00', 0.72, 0.12]),
      ]),
    );
    expect(lines(rc)).toEqual([
      ['Pepsi', 3, 4500],
      ['Chips', 1, 2000],
    ]);
    expect(rc.notes.join(' ')).toMatch(/per unit/);
    expect(reconcile(rc).status).toBe('ok');
  });
});

describe('receipts with no table header and a tilted photo', () => {
  it('still pairs prices with names', () => {
    const rc = parseReceipt(
      photo(
        [
          r(['GRILL HOUSE', 0.3, 0.4]),
          r(['Burger', 0.1, 0.2], ['150.00', 0.72, 0.12]),
          r(['Fries', 0.1, 0.2], ['50.00', 0.72, 0.12]),
          r(['Cola', 0.1, 0.2], ['30.00', 0.72, 0.12]),
          r(['Total', 0.1, 0.2], ['230.00', 0.72, 0.12]),
        ],
        0.03,
      ),
    );
    expect(lines(rc)).toEqual([
      ['Burger', 1, 15000],
      ['Fries', 1, 5000],
      ['Cola', 1, 3000],
    ]);
    expect(rc.total).toBe(23000);
    expect(rc.merchant).toBe('GRILL HOUSE');
  });
});

describe('whole-number prices (no decimals) on a tilted photo', () => {
  it('works for Egyptian receipts that print 75 instead of 75.00', () => {
    const rc = parseReceipt(
      photo(
        [
          r(['كشري التحرير', 0.3, 0.4]),
          r(['1', 0.07, 0.03], ['كشري كبير', 0.17, 0.3], ['75', 0.75, 0.05]),
          r(['2', 0.07, 0.03], ['عصير مانجو', 0.17, 0.3], ['120', 0.75, 0.06]),
          r(['الاجمالي', 0.17, 0.2], ['195', 0.75, 0.06]),
        ],
        0.02,
      ),
    );
    expect(lines(rc)).toEqual([
      ['كشري كبير', 1, 7500],
      ['عصير مانجو', 2, 12000],
    ]);
    expect(rc.total).toBe(19500);
  });
});
