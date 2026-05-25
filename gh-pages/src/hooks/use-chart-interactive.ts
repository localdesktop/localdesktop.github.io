import { useSyncExternalStore } from "react";

let interactive = false;
const listeners = new Set<() => void>();

function emitChange(): void {
  listeners.forEach((listener) => listener());
}

export function getChartInteractive(): boolean {
  return interactive;
}

export function setChartInteractive(value: boolean): void {
  if (interactive === value) {
    return;
  }
  interactive = value;
  emitChange();
}

export function toggleChartInteractive(): void {
  setChartInteractive(!interactive);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChartInteractive(): boolean {
  return useSyncExternalStore(subscribe, getChartInteractive, () => false);
}
