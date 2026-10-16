import { db } from './db.js';
import { diffMinutes } from './time.js';

export const TEACHING_KINDS = ['class', 'exam'];
export const ATTESTATION_MODES = ['hours', 'session', 'monthly'];

export function teachingHours(e) {
  if (e.all_day || e.status === 'cancelled' || !TEACHING_KINDS.includes(e.kind)) return 0;
  return Math.max(0, diffMinutes(e.start, e.end)) / 60;
}

function isResetPoint(e) {
  return (
    e.attestation_required &&
    (e.attestation_source === 'manual' || e.attestation_status === 'received' || e.attestation_status === 'waived')
  );
}

const autoPending = (e) => e.attestation_required && e.attestation_source === 'auto' && e.attestation_status === 'pending';

/** The rule an institution follows, or null when it has none. */
export function ruleOf(cat) {
  if (!cat || !cat.attestation_mode) return null;
  if (cat.attestation_mode === 'hours' && !(cat.attestation_every_hours > 0)) return null;
  return cat.attestation_mode;
}

/**
 * Applies an institution's attestation rule to its sessions:
 *  - hours:   counts teaching hours since the last attestation (starting from the hours she
 *             already had) and flags the session on which the count reaches N;
 *  - session: every teaching session needs one;
 *  - monthly: the last teaching session of each month needs one.
 * Only automatic flags that are still pending are ever added or removed, so anything she
 * has already handled (received, not needed, or flagged by hand) is never touched.
 */
export async function recomputeCategory(categoryId) {
  if (!categoryId) return;
  const cat = await db.get('SELECT * FROM categories WHERE id = ?', categoryId);
  const events = await db.all('SELECT * FROM events WHERE category_id = ? ORDER BY start, id', categoryId);
  const shouldFlag = new Set();
  const rule = ruleOf(cat);
  // A rule applies from the moment it was set; older sessions keep whatever state they have.
  const since = rule ? cat.attestation_since : null;
  const inScope = (e) => !since || e.start >= since;
  const scoped = events.filter(inScope);

  if (rule === 'hours') {
    let acc = cat.attestation_offset_hours || 0;
    for (const e of scoped) {
      const hours = teachingHours(e);
      if (!hours) continue;
      acc += hours;
      if (isResetPoint(e)) {
        acc = 0;
        continue;
      }
      if (acc >= cat.attestation_every_hours - 1e-6) {
        shouldFlag.add(e.id);
        acc = 0;
      }
    }
  } else if (rule === 'session') {
    for (const e of scoped) if (teachingHours(e) && !isResetPoint(e)) shouldFlag.add(e.id);
  } else if (rule === 'monthly') {
    const byMonth = new Map();
    for (const e of scoped) {
      if (!teachingHours(e)) continue;
      const m = e.start.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(e);
    }
    for (const list of byMonth.values()) {
      // A month already covered by an attestation she handled needs no automatic one.
      if (list.some(isResetPoint)) continue;
      shouldFlag.add(list[list.length - 1].id);
    }
  }

  const toSet = [];
  const toRemove = [];
  for (const e of rule ? scoped : events) {
    if (shouldFlag.has(e.id)) {
      if (!e.attestation_required) toSet.push(e.id);
    } else if (autoPending(e)) {
      toRemove.push(e.id);
    }
  }
  // One statement per change type keeps this fast on a remote database.
  for (let i = 0; i < toSet.length; i += 400) {
    const ids = toSet.slice(i, i + 400);
    await db.run(
      `UPDATE events SET attestation_required = 1, attestation_source = 'auto', attestation_status = 'pending',
       updated_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`,
      ...ids
    );
  }
  for (let i = 0; i < toRemove.length; i += 400) {
    const ids = toRemove.slice(i, i + 400);
    await db.run(
      `UPDATE events SET attestation_required = 0, attestation_source = NULL, attestation_status = NULL,
       attestation_snoozed_until = NULL, attestation_last_nag_at = NULL, updated_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`,
      ...ids
    );
  }
}

/** Progress of each institution toward its next attestation, as of `now`. */
export async function categoryProgress(now) {
  const cats = await db.all('SELECT * FROM categories WHERE archived = 0 ORDER BY name');
  const all = await db.all('SELECT * FROM events WHERE category_id IS NOT NULL ORDER BY start, id');
  return cats.map((cat) => {
    const rule = ruleOf(cat);
    const events = all.filter((e) => e.category_id === cat.id);
    let sinceLast = rule === 'hours' ? cat.attestation_offset_hours || 0 : 0;
    let total = 0;
    let lastAttestation = null;
    let next = null;
    let plannedUntilNext = 0;
    const since = rule ? cat.attestation_since : null;
    for (const e of events) {
      const hours = teachingHours(e);
      if (since && e.start < since) {
        if (e.end <= now) total += hours;
        continue;
      }
      if (e.end <= now) {
        total += hours;
        sinceLast += hours;
        if (e.attestation_required && (isResetPoint(e) || e.attestation_source === 'auto')) {
          sinceLast = 0;
          lastAttestation = { eventId: e.id, start: e.start, status: e.attestation_status };
        }
      } else if (!next) {
        plannedUntilNext += hours;
        if (e.attestation_required && e.attestation_status === 'pending') next = { eventId: e.id, start: e.start, title: e.title };
      }
    }
    return {
      id: cat.id,
      name: cat.name,
      color: cat.color,
      mode: rule,
      everyHours: rule === 'hours' ? cat.attestation_every_hours : null,
      signer: cat.attestation_signer,
      totalHours: round(total),
      hoursSinceLast: round(sinceLast),
      lastAttestation,
      nextAttestation: next,
      plannedHoursUntilNext: next ? round(plannedUntilNext) : null,
    };
  });
}

const round = (n) => Math.round(n * 100) / 100;
