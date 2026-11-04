import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { formatAmount } from '@tably/core';
import { fetchSummaries, type BillSummary } from './billsApi';
import { getAdminToken, listBills, type MyBill } from './myBills';
import type { Tone } from '../components/Bits';

export interface BillRow extends MyBill {
  live?: BillSummary;
}

/**
 * Every bill this phone created. The saved basics show at once; live status (who has paid) arrives from the server
 * a moment later, and if the server cannot be reached the saved basics stay on screen.
 */
export function useBills() {
  const [rows, setRows] = useState<BillRow[] | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async (alive: () => boolean = () => true) => {
    const mine = await listBills();
    if (alive()) setRows(mine);
    try {
      const refs = (await Promise.all(mine.map(async (b) => ({ id: b.id, admin_token: (await getAdminToken(b.id)) ?? '' })))).filter((r) => r.admin_token);
      const live = await fetchSummaries(refs);
      if (!alive()) return;
      const byId = new Map(live.map((s) => [s.id, s]));
      setRows(mine.map((b) => ({ ...b, live: byId.get(b.id) })));
      setOffline(false);
    } catch {
      if (alive()) setOffline(true);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    let on = true;
    void load(() => on);
    return () => { on = false; };
  }, [load]));

  return { rows, setRows, offline, reload: () => load() };
}

/** The one-glance state of a bill: a label and a colour. */
export function billStatus(r: BillRow): { label: string; tone: Tone } {
  const s = r.live;
  if (s?.missing) return { label: 'Not found on server', tone: 'danger' };
  if (!s) return { label: 'Saved on this phone', tone: 'neutral' };
  if (s.status === 'closed') return { label: 'Closed', tone: 'neutral' };
  if (s.waiting) return { label: `${s.waiting} to confirm`, tone: 'warning' };
  if ((s.outstanding ?? 0) === 0 && (s.total ?? 0) > 0 && (s.people ?? 0) > 0) return { label: 'All paid', tone: 'success' };
  if (!s.people) return { label: 'Waiting for friends', tone: 'accent' };
  return { label: `${formatAmount(s.outstanding ?? 0, s.currency ?? r.currency)} to collect`, tone: 'accent' };
}
