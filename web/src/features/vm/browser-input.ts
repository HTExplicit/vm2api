/** Translate the scaled login image coordinates to the remote browser viewport. */
export function browserInputPoint(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number }
) {
  return {
    x: Math.round(((clientX - bounds.left) / bounds.width) * frame.width),
    y: Math.round(((clientY - bounds.top) / bounds.height) * frame.height),
  }
}
