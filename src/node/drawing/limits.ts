export const MAX_DXF_BYTES = 50 * 1024 * 1024

export function isDrawingOversize(
  sizeBytes: number,
  limitBytes: number = MAX_DXF_BYTES
): boolean {
  return sizeBytes > limitBytes
}
