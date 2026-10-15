import { db } from './db.js';
import { diffMinutes } from './time.js';

export const TEACHING_KINDS = ['class', 'exam'];

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

const unflag = () =>
  db.prepare(
    `UPDATE events SET attestation_required = 0, attestation_source = NULL, attestation_status = NULL,
     attestation_snoozed_until = NULL, attestation_last_nag_at = NULL, updated_at = datetime('now') WHERE id = ?`
  );

/**
 * Applies a category's "one attestation every N teaching hours" rule.
 * Walks the category's sessions in order, counting hours since the last attestation
 * (a session where one was manually required, received or waived) and flags the session
 * on which the counter reaches N. Auto flags that are no longer on a threshold are removed,
 * but only while still pending, so nothing she has already handled is ever touched.
 */
export function recomputeCategory(categoryId) {
  if (!categoryId) return;
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
  const events = db
    .prepare('SELECT * FROM events WHERE category_id = ? ORDER BY start, id')
    .all(categoryId);
  const removeFlag = unflag();
  const autoPending = (e) => e.attestation_required && e.attestation_source === 'auto' && e.attestation_status === 'pending';

  if (!cat || !cat.attestation_every_hours || cat.attestation_every_hours <= 0) {
    for (const e of events) if (autoPending(e)) removeFlag.run(e.id);
    return;
  }

  const threshold = cat.attestation_every_hours;
  const setFlag = db.prepare(
    `UPDATE events SET attestation_required = 1, attestation_source = 'auto', attestation_status = 'pending',
     updated_at = datetime('now') WHERE id = ?`
  );
  let acc = 0;
  for (const e of events) {
    const hours = teachingHours(e);
    if (hours === 0) {
      if (autoPending(e)) removeFlag.run(e.id);
      continue;
    }
    acc += hours;
    if (isResetPoint(e)) {
      acc = 0;
      continue;
    }
    if (acc >= threshold - 1e-6) {
      if (!e.attestation_required) setFlag.run(e.id);
      acc = 0;
    } else if (autoPending(e)) {
      removeFlag.run(e.id);
    }
  }
}

/** Hours progress for each category that has an attestation rule, as of `now`. */
export function categoryProgress(now) {
  const cats = db.prepare('SELECT * FROM categories WHERE archived = 0 ORDER BY name').all();
  return cats.map((cat) => {
    const events = db.prepare('SELECT * FROM events WHERE category_id = ? ORDER BY start, id').all(cat.id);
    let sinceLast = 0;
    let total = 0;
    let lastAttestation = null;
    let next = null;
    let plannedUntilNext = 0;
    for (const e of events) {
      const hours = teachingHours(e);
      const done = e.end <= now;
      if (done) {
        total += hours;
        sinceLast += hours;
        if (isResetPoint(e) || (e.attestation_required && e.attestation_source === 'auto')) {
          sinceLast = 0;
          lastAttestation = { eventId: e.id, start: e.start, status: e.attestation_status };
        }
      } else if (!next) {
        plannedUntilNext += hours;
        if (e.attestation_required && e.attestation_status === 'pending') {
          next = { eventId: e.id, start: e.start, title: e.title };
        }
      }
    }
    return {
      id: cat.id,
      name: cat.name,
      color: cat.color,
      everyHours: cat.attestation_every_hours,
      totalHours: round(total),
      hoursSinceLast: round(sinceLast),
      lastAttestation,
      nextAttestation: next,
      plannedHoursUntilNext: next ? round(plannedUntilNext) : null,
    };
  });
}

const round = (n) => Math.round(n * 100) / 100;
