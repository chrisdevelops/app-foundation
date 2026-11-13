// Gate tests for the paint probe verdict and its failure text (#46 test author
// attempt 5; TST-018). Test code only (ADR 0008).
// Contract of listPaintProbeProblems (tools/test-support/background-page-probes.ts):
// - the page passes with at least `minimumAnimationFramesPerSecond` (10)
//   frames in the second, and fails with fewer; the diagnostics never change this;
// - a failure names the frame count and every diagnostic field the probe
//   read (#46 reviewer attempt 2, finding 1: tell a page Chromium treats as
//   hidden from a stalled renderer): `visibilityState` and `hidden` at start
//   and end, how late the 1 s timer fired, when the first frame came, the
//   `visibilitychange` events, the page age and the navigation type;
// - a missing or malformed result fails, it never passes.
import { describe, expect, it } from 'vitest';
import {
  listPaintProbeProblems,
  minimumAnimationFramesPerSecond,
  type PaintProbePageState,
  type PaintProbeResult,
} from './background-page-probes';

const hiddenState: PaintProbePageState = {
  visibilityState: 'hidden',
  hidden: true,
  hasFocus: false,
  pageAgeMs: 23_456,
  navigationType: 'reload',
  href: 'http://localhost:5173/',
  innerSize: '1024 x 768',
  outerSize: '1024 x 768',
  screenPosition: '0, 0',
};

function paintResult(frames: number): PaintProbeResult {
  return {
    frames,
    timerElapsedMs: 3_412,
    firstFrameAfterMs: frames === 0 ? null : 16,
    visibilityChanges: ['812 ms: hidden'],
    atStart: { ...hiddenState, visibilityState: 'visible', hidden: false },
    atEnd: hiddenState,
  };
}

describe('paint probe verdict', () => {
  // TST-018: the threshold stays 10 frames per second
  it('TST-018: the paint probe passes at 10 animation frames per second and fails at 9', () => {
    expect(minimumAnimationFramesPerSecond).toBe(10);
    expect(listPaintProbeProblems(paintResult(10))).toEqual([]);
    expect(listPaintProbeProblems(paintResult(60))).toEqual([]);
    expect(listPaintProbeProblems(paintResult(9))).toHaveLength(1);
  });

  // TST-018; #46 reviewer attempt 2, finding 1
  it('TST-018: a failed paint probe names the frame count, page visibility at start and end, timer lateness, first frame, visibility changes and page age', () => {
    const [problem] = listPaintProbeProblems(paintResult(0));
    expect(problem).toContain('painted 0 animation frames in one second (at least 10 expected)');
    for (const fragment of [
      '"visibilityState":"visible"',
      '"hidden":false',
      '"visibilityState":"hidden"',
      '"hidden":true',
      'timer fired after 3412 ms',
      'first frame after none',
      '812 ms: hidden',
      '"pageAgeMs":23456',
      '"navigationType":"reload"',
    ]) {
      expect(problem, `the failure text must contain ${fragment}`).toContain(fragment);
    }
  });

  // TST-018: a probe that returns nothing usable fails
  it('TST-018: a missing or malformed paint probe result fails the probe', () => {
    expect(listPaintProbeProblems(undefined)).toHaveLength(1);
    expect(listPaintProbeProblems(null)).toHaveLength(1);
    expect(listPaintProbeProblems({ frames: 'many' } as unknown as PaintProbeResult)).toHaveLength(1);
  });
});
