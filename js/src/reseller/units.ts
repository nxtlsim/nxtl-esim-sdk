/** SI data units. 1 MB = 1000² bytes, 1 GB = 1000³ bytes. */

const SI = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  TB: 1_000_000_000_000,
} as const;

export type DataUnit = "B" | "KB" | "MB" | "GB" | "TB";

export interface NormalizedVolume {
  bytes: number;
  kb: number;
  mb: number;
  gb: number;
}

export function toBytes(value: number, unit: DataUnit): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("data amount must be a finite number >= 0");
  }
  const factor = SI[unit];
  return value * factor;
}

export function fromBytes(bytes: number): NormalizedVolume {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError("bytes must be a finite number >= 0");
  }
  return {
    bytes,
    kb: bytes / SI.KB,
    mb: bytes / SI.MB,
    gb: bytes / SI.GB,
  };
}

export function formatData(bytes: number, unit: DataUnit = "GB"): string {
  const volume = fromBytes(bytes);
  const value = unit === "B" ? volume.bytes : unit === "KB" ? volume.kb : unit === "MB" ? volume.mb : unit === "TB" ? bytes / SI.TB : volume.gb;
  const digits = unit === "B" ? 0 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}
