/** A sampled, under-damped spring, played by WAAPI on the compositor.
 * Unit mass, stiffness 100, damping 10; two simulation seconds per screen second.
 * The same material response is shared by attacks, loose card layers and landings.
 */
export type CardPose = { x?: number; y?: number; angle?: number; sx?: number; sy?: number };
export const CARD_SETTLE_MS = 600;

export function cardTransform({ x = 0, y = 0, angle = 0, sx = 1, sy = sx }: CardPose = {}) {
  return `translate3d(${x}px,${y}px,0) rotate(${angle}deg) scale(${sx},${sy})`;
}

export function cardSpringFrames(pose: CardPose, duration = CARD_SETTLE_MS): Keyframe[] {
  const { x = 0, y = 0, angle = 0, sx = 1, sy = sx } = pose;
  const damping = 5;
  const frequency = Math.sqrt(100 - damping * damping);
  return Array.from({ length: 49 }, (_, i) => {
    const offset = i / 48;
    const time = offset * duration / 1000 * 2;
    const residual = i === 48 ? 0 : Math.exp(-damping * time) *
      (Math.cos(frequency * time) + damping / frequency * Math.sin(frequency * time));
    return { offset, transform: cardTransform({ x: x * residual, y: y * residual,
      angle: angle * residual, sx: 1 + (sx - 1) * residual, sy: 1 + (sy - 1) * residual }) };
  });
}
