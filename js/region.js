// Feeding the model a sub-rectangle of the frame instead of the whole thing.
//
// A subject off to one side, or badly lit, occupies a small and murky part of
// the image; the detector sees it as a handful of pixels and gives up. Cropping
// to that subject before inference makes it fill the frame, which is a large
// accuracy win for exactly the awkward cases. Landmarks come back relative to
// the crop, so they have to be mapped home again.

/** Minimum width to render a region at, so a small crop still has pixels. */
const MIN_SAMPLE_WIDTH = 512;
const MAX_SAMPLE_WIDTH = 1280;

/** @typedef {{x:number, y:number, w:number, h:number}} Rect normalised 0..1 */

export const FULL_FRAME = { x: 0, y: 0, w: 1, h: 1 };

export function isFullFrame(rect) {
  return !rect || (rect.x <= 0.0001 && rect.y <= 0.0001 && rect.w >= 0.9999 && rect.h >= 0.9999);
}

export function clampRect(rect) {
  const w = Math.min(1, Math.max(0.02, rect.w));
  const h = Math.min(1, Math.max(0.02, rect.h));
  return {
    x: Math.min(1 - w, Math.max(0, rect.x)),
    y: Math.min(1 - h, Math.max(0, rect.y)),
    w,
    h,
  };
}

/**
 * A reusable canvas that crops (and optionally brightens) one region of a
 * source, plus the mapping back to full-frame coordinates.
 *
 * @param {number} sourceW natural pixel width of the source
 * @param {number} sourceH natural pixel height
 * @param {Rect|null} region null means the whole frame
 * @param {number} boost 1 = untouched; >1 lifts exposure before inference
 */
export function createSampler(sourceW, sourceH, region, boost = 1) {
  const rect = region ? clampRect(region) : FULL_FRAME;
  const plain = isFullFrame(rect) && boost === 1;
  if (plain || !sourceW || !sourceH) return null;

  const srcW = rect.w * sourceW;
  const srcH = rect.h * sourceH;
  const scale = Math.min(
    MAX_SAMPLE_WIDTH / srcW,
    Math.max(1, MIN_SAMPLE_WIDTH / srcW),
  );

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(16, Math.round(srcW * scale));
  canvas.height = Math.max(16, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  return {
    rect,
    canvas,

    /** Draw the region of `media` into the sampler canvas and return it. */
    grab(media) {
      ctx.filter = boost === 1 ? 'none' : `brightness(${boost}) contrast(${1 + (boost - 1) * 0.5})`;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      try {
        ctx.drawImage(
          media,
          rect.x * sourceW, rect.y * sourceH, srcW, srcH,
          0, 0, canvas.width, canvas.height,
        );
      } catch {
        /* media not ready this frame */
      }
      ctx.filter = 'none';
      return canvas;
    },

    /**
     * Landmarks are normalised to the crop; put them back in full-frame space.
     * z is a length in the same units as x, so it scales with the crop width.
     */
    map(points) {
      if (!points) return null;
      return points.map((p) => ({
        x: rect.x + p.x * rect.w,
        y: rect.y + p.y * rect.h,
        z: p.z * rect.w,
        visibility: p.visibility,
      }));
    },
  };
}

/** Map a whole MediaPipe result's landmark arrays back to full-frame space. */
export function mapResult(sampler, result) {
  if (!sampler || !result) return result;
  const out = { ...result };
  if (result.landmarks) out.landmarks = result.landmarks.map((l) => sampler.map(l));
  // worldLandmarks are metric and camera-relative, not image-relative, so they
  // are already in the right space and must not be remapped.
  return out;
}
