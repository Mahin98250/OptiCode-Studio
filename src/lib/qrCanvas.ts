import QRCode from 'qrcode';
import type { QrMatrix } from './qrEncodePool';

type QRModule = { size:number; data:Uint8Array | boolean[] };
type QRCodeMatrix = { modules: QRModule };

function drawMatrixToCanvas(
  ctx: CanvasRenderingContext2D,
  matrix: QrMatrix,
  x: number,
  y: number,
  size: number,
  margin = 16,
) {
  // Preserve the QR quiet zone at four modules. A fixed pixel margin
  // becomes too narrow for the larger QR versions used by transfer frames.
  const fourModuleMargin = Math.ceil((4 * size) / (matrix.size + 8));
  const safeMargin = Math.min(
    Math.max(margin, fourModuleMargin),
    Math.max(1, Math.floor(size / 2) - 1),
  );
  const cell = (size - safeMargin * 2) / matrix.size;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#000000';

  // Draw contiguous black runs instead of one fillRect per module.
  // QR rows commonly contain many adjacent dark modules, so run-length
  // rasterization cuts the number of canvas calls dramatically.
  for (let row = 0; row < matrix.size; row += 1) {
    let runStart = -1;
    for (let col = 0; col <= matrix.size; col += 1) {
      const dark = col < matrix.size && Boolean(matrix.data[row * matrix.size + col]);
      if (dark && runStart < 0) {
        runStart = col;
      } else if (!dark && runStart >= 0) {
        const left = x + safeMargin + Math.floor(runStart * cell);
        const top = y + safeMargin + Math.floor(row * cell);
        const right = x + safeMargin + Math.floor(col * cell);
        const bottom = y + safeMargin + Math.floor((row + 1) * cell);
        ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
        runStart = -1;
      }
    }
  }
}

function toMatrix(value: string): QrMatrix {
  const code = QRCode.create(value, { errorCorrectionLevel: 'M' }) as unknown as QRCodeMatrix;
  const raw = code.modules.data;
  return {
    size: code.modules.size,
    data: raw instanceof Uint8Array
      ? raw
      : new Uint8Array(Array.from(raw, entry => (entry ? 1 : 0))),
  };
}

export function createQrMatrices(values: string[]) {
  return values.map((value) => toMatrix(value));
}

export function drawQrMatricesToCanvas(
  canvas: HTMLCanvasElement,
  matrices: QrMatrix[],
  size = 900,
  gap = 14,
) {
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) throw new Error('Canvas unavailable.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const active = matrices.slice(0, 4);
  if (active.length === 1) {
    // A single optical lane should use the full display. Rendering it as one
    // quadrant makes phone-to-phone transfer unnecessarily difficult.
    drawMatrixToCanvas(ctx, active[0], gap, gap, size - gap * 2, 16);
    return;
  }

  if (active.length === 2) {
    const cell = Math.floor((size - gap * 3) / 2);
    drawMatrixToCanvas(ctx, active[0], gap, gap, cell, 16);
    drawMatrixToCanvas(ctx, active[1], gap * 2 + cell, gap, cell, 10);
    return;
  }

  const cell = Math.floor((size - gap * 3) / 2);
  const positions = [
    [gap, gap],
    [gap * 2 + cell, gap],
    [gap, gap * 2 + cell],
    [gap * 2 + cell, gap * 2 + cell],
  ] as const;

  active.forEach((matrix, i) => {
    drawMatrixToCanvas(ctx, matrix, positions[i][0], positions[i][1], cell, 10);
  });
}

export function drawQrToCanvas(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  margin = 10,
) {
  drawMatrixToCanvas(ctx, toMatrix(value), x, y, size, margin);
}

export function drawQrGrid(
  values: string[],
  size = 900,
  gap = 14,
) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const cell = Math.floor((size - gap * 3) / 2);
  const positions = [
    [gap, gap],
    [gap * 2 + cell, gap],
    [gap, gap * 2 + cell],
    [gap * 2 + cell, gap * 2 + cell],
  ] as const;

  values.slice(0, 4).forEach((value, i) => {
    drawQrToCanvas(ctx, value, positions[i][0], positions[i][1], cell, 10);
  });
  return canvas.toDataURL('image/png');
}

export function drawQrMatricesGrid(
  matrices: QrMatrix[],
  size = 900,
  gap = 14,
) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const cell = Math.floor((size - gap * 3) / 2);
  const positions = [
    [gap, gap],
    [gap * 2 + cell, gap],
    [gap, gap * 2 + cell],
    [gap * 2 + cell, gap * 2 + cell],
  ] as const;

  matrices.slice(0, 4).forEach((matrix, i) => {
    drawMatrixToCanvas(ctx, matrix, positions[i][0], positions[i][1], cell, 10);
  });

  return canvas.toDataURL('image/png');
}
