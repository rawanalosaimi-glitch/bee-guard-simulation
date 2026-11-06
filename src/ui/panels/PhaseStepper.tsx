import { BEE_IDS, MISSION_PHASES, PHASE_LABEL } from '../../sim';
import type { MissionPhase, SimState } from '../../sim';

const SHORT: Record<MissionPhase, string> = {
  READY: 'Ready',
  TAKEOFF: 'Takeoff',
  TRANSIT: 'Transit',
  DEPLOYMENT: 'Deploy',
  SURVEY_ASSESSMENT: 'Survey',
  RECOVERY: 'Recovery',
  RETURN: 'Return',
  LANDING: 'Landing',
  COMPLETE: 'Complete',
  INCOMPLETE: 'Incomplete',
  TIMEOUT: 'Timeout',
};

const STAGE_LABEL: Record<string, string> = {
  IDLE: '—',
  GATHERING: 'bees moving to staging points',
  HATCH_OPENING: 'opening hatch',
  DOCKING: 'sequential docking',
  HATCH_CLOSING: 'closing hatch',
  DONE: 'recovery finished',
};

/** Index of the furthest lifecycle phase reached (terminal failure states map onto where the run stopped). */
function reachedIndex(s: SimState): number {
  const ph = s.mission.phase;
  const i = MISSION_PHASES.indexOf(ph);
  if (i >= 0) return i;
  // INCOMPLETE / TIMEOUT: last phase that has a start time
  let last = 0;
  MISSION_PHASES.forEach((p, k) => {
    if (s.mission.phaseTimes[p] !== undefined) last = k;
  });
  return last;
}

/** Compact phase chip for the top bar. */
export function PhaseChip({ s }: { s: SimState }) {
  if (!s.mission.lifecycle) return null;
  const ph = s.mission.phase;
  const tone = ph === 'COMPLETE' ? 'ok' : ph === 'INCOMPLETE' || ph === 'TIMEOUT' ? 'crit' : ph === 'READY' ? '' : 'live';
  return (
    <span className={`phase-chip ${tone}`} title={`Mission phase: ${PHASE_LABEL[ph]}`}>
      <i aria-hidden />
      {PHASE_LABEL[ph]}
    </span>
  );
}

/**
 * READY → TAKEOFF → … → COMPLETE, driven by s.mission (engine state — not by an animation clock).
 * A failed recovery / off-pad landing / time cap shows the terminal state in red instead of COMPLETE.
 */
export function PhaseStepper({ s }: { s: SimState }) {
  const m = s.mission;
  if (!m.lifecycle) return null;
  const cur = reachedIndex(s);
  const failed = m.phase === 'INCOMPLETE' || m.phase === 'TIMEOUT';
  const rec = m.recovery;
  const t0 = (p: MissionPhase) => m.phaseTimes[p];
  return (
    <div className="phase-stepper" aria-label="Mission phase">
      <ol>
        {MISSION_PHASES.map((p, k) => {
          const isCur = k === cur && !(p === 'COMPLETE' && m.phase === 'COMPLETE') && !failed;
          const done = k < cur || (p === 'COMPLETE' && m.phase === 'COMPLETE');
          const cls = failed && k === cur ? 'fail' : isCur ? 'cur' : done ? 'done' : '';
          const t = t0(p);
          return (
            <li key={p} className={cls} title={`${PHASE_LABEL[p]}${t !== undefined ? ` · t = ${t.toFixed(1)} s` : ''}`}>
              <i aria-hidden>{done ? '✓' : cls === 'fail' ? '!' : k + 1}</i>
              <span>{SHORT[p]}</span>
            </li>
          );
        })}
      </ol>
      <div className={`phase-now ${failed ? 'fail' : m.phase === 'COMPLETE' ? 'ok' : ''}`}>
        <b>{PHASE_LABEL[m.phase]}</b>
        {t0(m.phase) !== undefined && <em>since t = {t0(m.phase)!.toFixed(1)} s</em>}
      </div>
      {(m.phase === 'RECOVERY' || rec.stage !== 'IDLE') && (
        <div className="recovery-row">
          {BEE_IDS.map((id) => {
            const docked = rec.docked.includes(id);
            const fail = rec.failed.find((f) => f.bee === id);
            const active = rec.current === id && !docked && !fail;
            const staged = rec.staged.includes(id);
            const attempts = rec.attempts.filter((a) => a.bee === id).length;
            return (
              <span key={id} className={`rb ${docked ? 'ok' : fail ? 'crit' : active ? 'live' : ''}`} title={fail ? fail.reason : undefined}>
                <b>{id}</b>
                {docked ? 'docked' : fail ? 'NOT recovered' : active ? `docking · try ${Math.max(1, attempts)}` : staged ? 'staged' : 'returning'}
              </span>
            );
          })}
          <small>Hatch / recovery: {STAGE_LABEL[rec.stage] ?? rec.stage}</small>
        </div>
      )}
      {m.landing.touchdown !== null && (
        <div className="recovery-row">
          <small>
            Touchdown t = {m.landing.touchdown.toFixed(1)} s · {m.landing.horizontalError_m?.toFixed(2)} m from pad centre ·{' '}
            {m.landing.onPad ? 'on pad' : 'OFF PAD'}
          </small>
        </div>
      )}
    </div>
  );
}
